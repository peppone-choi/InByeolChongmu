import ExcelJS from 'exceljs';
import { inflateRawSync } from 'node:zlib';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import {
  productSchema,
  policySchema,
  type Product,
  type Policy,
} from '../domain/schema.js';
import { validatePolicies, validateProducts, type Store } from './store.js';

const productColumns = [
  'product_id',
  'name',
  'aliases',
  'material',
  'closes_at',
  'measurements_cm',
  'sku',
  'color',
  'size',
  'unit_price_krw',
  'stock_available',
];
const policyColumns = [
  'policy_id',
  'title',
  'rule',
  'shipping_fee_krw',
  'product_id',
  'minimum_quantity',
  'discount_krw',
  'next_dispatch_date',
];
const aliases: Record<string, string> = {
  상품ID: 'product_id',
  상품명: 'name',
  별칭: 'aliases',
  소재: 'material',
  판매마감: 'closes_at',
  실측: 'measurements_cm',
  옵션ID: 'sku',
  색상: 'color',
  사이즈: 'size',
  가격: 'unit_price_krw',
  재고: 'stock_available',
  정책ID: 'policy_id',
  제목: 'title',
  정책: 'rule',
  배송비: 'shipping_fee_krw',
  최소수량: 'minimum_quantity',
  할인액: 'discount_krw',
  출고일: 'next_dispatch_date',
};
import { type ImportPreview } from '../domain/data-contract.js';

// Inspect the ZIP directory before ExcelJS expands XML. Compressed size alone is insufficient.
export function checkWorkbookZip(buffer: Buffer) {
  if (buffer.length > 2 * 1024 * 1024)
    throw new AppError('WORKBOOK_TOO_LARGE', '엑셀은 최대 2 MiB입니다.', 413);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0)
    throw new AppError('INVALID_WORKBOOK', '일반 .xlsx 파일이 필요합니다.');
  const count = buffer.readUInt16LE(eocd + 10),
    offset = buffer.readUInt32LE(eocd + 16);
  if (buffer.readUInt16LE(eocd + 4) !== 0 || count > 500 || count === 65535)
    throw new AppError(
      'INVALID_WORKBOOK',
      '분할·대형 압축 파일은 지원하지 않습니다.',
    );
  let pos = offset,
    total = 0;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > eocd || buffer.readUInt32LE(pos) !== 0x02014b50)
      throw new AppError('INVALID_WORKBOOK', '압축 파일 구조를 확인하세요.');
    const flags = buffer.readUInt16LE(pos + 8),
      size = buffer.readUInt32LE(pos + 24);
    if (flags & 1 || size === 0xffffffff)
      throw new AppError(
        'INVALID_WORKBOOK',
        '암호화·ZIP64 파일은 지원하지 않습니다.',
      );
    total += size;
    if (total > 20 * 1024 * 1024)
      throw new AppError(
        'WORKBOOK_TOO_LARGE',
        '압축 해제 크기는 최대 20 MiB입니다.',
        413,
      );
    const compressed = buffer.readUInt32LE(pos + 20),
      local = buffer.readUInt32LE(pos + 42),
      method = buffer.readUInt16LE(pos + 10);
    if (local + 30 > offset || buffer.readUInt32LE(local) !== 0x04034b50)
      throw new AppError('INVALID_WORKBOOK', '압축 항목 구조가 잘못됐습니다.');
    const start =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    if (start + compressed > offset || ![0, 8].includes(method))
      throw new AppError('INVALID_WORKBOOK', '지원하지 않는 압축 방식입니다.');
    try {
      const expanded =
        method === 8
          ? inflateRawSync(buffer.subarray(start, start + compressed), {
              maxOutputLength: Math.max(1, size),
            })
          : buffer.subarray(start, start + compressed);
      if (expanded.length !== size) throw new Error('size');
    } catch {
      throw new AppError(
        'INVALID_WORKBOOK',
        '실제 압축 크기가 선언과 다르거나 파일이 손상됐습니다.',
      );
    }
    pos +=
      46 +
      buffer.readUInt16LE(pos + 28) +
      buffer.readUInt16LE(pos + 30) +
      buffer.readUInt16LE(pos + 32);
  }
  if (total > 20 * 1024 * 1024 || pos !== eocd)
    throw new AppError(
      'WORKBOOK_TOO_LARGE',
      '압축 해제 크기는 최대 20 MiB입니다.',
      413,
    );
}
function primitive(value: ExcelJS.CellValue): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value instanceof Date) return value.toISOString();
  throw new AppError(
    'UNSUPPORTED_CELL',
    '수식·링크·객체 셀은 지원하지 않습니다. 값으로 붙여넣으세요.',
  );
}
export class WorkbookImports {
  private pending = new Map<
    string,
    {
      seller: string;
      expires: number;
      products: Product[];
      policies: Policy[];
      snapshots: { products: string; policies: string };
      valid: boolean;
    }
  >();
  constructor(private store: Store) {}
  clear() {
    this.pending.clear();
  }
  async preview(seller: string, buffer: Buffer): Promise<ImportPreview> {
    checkWorkbookZip(buffer);
    const book = new ExcelJS.Workbook();
    try {
      await book.xlsx.load(buffer as never);
    } catch {
      throw new AppError('INVALID_WORKBOOK', '엑셀 파일을 읽을 수 없습니다.');
    }
    const products = this.store.products(seller),
      policies = this.store.policies(seller),
      importedProducts = new Map<string, Product>(),
      importedPolicies = new Map<string, Policy>();
    const errors: ImportPreview['errors'] = [],
      sheets: ImportPreview['sheets'] = [],
      samples: ImportPreview['samples'] = [];
    const known = new Set([...productColumns, ...policyColumns]);
    for (const sheet of book.worksheets) {
      if (!['products', '상품', 'policies', '정책'].includes(sheet.name))
        continue;
      const isProduct = ['products', '상품'].includes(sheet.name);
      if (sheet.rowCount > 10001 || sheet.columnCount > 30)
        throw new AppError(
          'INVALID_WORKBOOK',
          '시트당 최대 10,000행·30열입니다.',
        );
      const headers: string[] = [];
      try {
        for (let i = 1; i <= sheet.columnCount; i++) {
          const raw = String(
            primitive(sheet.getRow(1).getCell(i).value) ?? '',
          ).trim();
          headers.push(aliases[raw] ?? raw);
        }
      } catch (e) {
        throw new AppError(
          'INVALID_HEADERS',
          e instanceof Error ? e.message : '열 이름을 확인하세요.',
        );
      }
      if (
        new Set(headers).size !== headers.length ||
        headers.some((h) => !known.has(h))
      )
        errors.push({
          sheet: sheet.name,
          row: 1,
          message: '중복·알 수 없는 열입니다. 내보낸 양식의 열을 확인하세요.',
        });
      sheets.push({
        name: sheet.name,
        rows: Math.max(0, sheet.rowCount - 1),
        columns: headers,
      });
      const seenSkus = new Set<string>();
      for (let n = 2; n <= sheet.rowCount; n++) {
        const row = sheet.getRow(n);
        if (!row.hasValues) continue;
        try {
          const values: Record<string, unknown> = {};
          headers.forEach((h, i) => {
            const value = primitive(row.getCell(i + 1).value);
            if (value !== null && value !== '') values[h] = value;
          });
          if (isProduct) {
            const matching = products.filter((p) => p.name === values.name);
            if (!values.product_id && matching.length > 1)
              throw new Error(
                '같은 이름의 상품이 여러 개입니다. 상품 ID를 지정하세요.',
              );
            if (!values.product_id)
              values.product_id =
                matching[0]?.product_id ??
                'P-' +
                  createHash('sha256')
                    .update(String(values.name))
                    .digest('hex')
                    .slice(0, 16);
            if (!values.sku)
              values.sku =
                matching
                  .find((p) => p.product_id === values.product_id)
                  ?.variants.find(
                    (v) => v.color === values.color && v.size === values.size,
                  )?.sku ??
                'SKU-' +
                  createHash('sha256')
                    .update(
                      JSON.stringify([
                        values.product_id,
                        values.color,
                        values.size,
                      ]),
                    )
                    .digest('hex')
                    .slice(0, 16);
            const p = productSchema.parse({
              product_id: values.product_id,
              name: values.name,
              aliases: values.aliases ? String(values.aliases).split('|') : [],
              material: values.material ?? null,
              closes_at: values.closes_at,
              measurements_cm: values.measurements_cm
                ? JSON.parse(String(values.measurements_cm))
                : null,
              variants: [
                {
                  sku: values.sku,
                  color: values.color,
                  size: values.size,
                  unit_price_krw: values.unit_price_krw,
                  stock_available: values.stock_available,
                },
              ],
            });
            const prior = importedProducts.get(p.product_id);
            if (seenSkus.has(p.variants[0]!.sku))
              throw new Error('중복 옵션 ID입니다.');
            seenSkus.add(p.variants[0]!.sku);
            if (prior) {
              if (
                JSON.stringify({ ...prior, variants: [] }) !==
                JSON.stringify({ ...p, variants: [] })
              )
                throw new Error('같은 상품의 공통 정보가 서로 다릅니다.');
              prior.variants.push(...p.variants);
            } else importedProducts.set(p.product_id, p);
            if (samples.length < 12)
              samples.push({
                sheet: sheet.name,
                row: n,
                summary: `${p.name} · ${p.variants[0]!.color}/${p.variants[0]!.size} · ${p.variants[0]!.unit_price_krw}원 · 재고 ${p.variants[0]!.stock_available}`,
              });
          } else {
            const p = policySchema.parse(values);
            if (importedPolicies.has(p.policy_id))
              throw new Error('정책 ID가 중복됩니다.');
            importedPolicies.set(p.policy_id, p);
            if (samples.length < 12)
              samples.push({
                sheet: sheet.name,
                row: n,
                summary: `${p.title ?? p.policy_id} · ${p.rule}`,
              });
          }
        } catch (e) {
          errors.push({
            sheet: sheet.name,
            row: n,
            message:
              e instanceof z.ZodError
                ? e.issues
                    .map((i) => `${i.path.join('.')}: ${i.message}`)
                    .join('; ')
                : e instanceof Error
                  ? e.message
                  : '행을 확인하세요.',
          });
        }
      }
    }
    if (!sheets.length)
      errors.push({
        sheet: '파일',
        row: 1,
        message:
          'products(상품) 또는 policies(정책) 시트가 필요합니다. 설정에서 엑셀 양식을 내려받으세요.',
      });
    const mergedProducts = [
        ...products.filter((p) => !importedProducts.has(p.product_id)),
        ...importedProducts.values(),
      ],
      mergedPolicies = [
        ...policies.filter((p) => !importedPolicies.has(p.policy_id)),
        ...importedPolicies.values(),
      ];
    try {
      validateProducts(mergedProducts);
      validatePolicies(mergedPolicies, mergedProducts);
    } catch (e) {
      errors.push({
        sheet: '전체',
        row: 0,
        message: e instanceof Error ? e.message : '자료 충돌',
      });
    }
    for (const [key, p] of this.pending)
      if (p.expires < Date.now()) this.pending.delete(key);
    if (this.pending.size >= 10)
      throw new AppError(
        'TOO_MANY_PREVIEWS',
        '미리보기가 많습니다. 잠시 후 다시 시도하세요.',
        429,
      );
    const token = randomUUID(),
      expires = Date.now() + 10 * 60 * 1000;
    this.pending.set(token, {
      seller,
      expires,
      products: mergedProducts,
      policies: mergedPolicies,
      snapshots: this.store.commerce.snapshots(seller),
      valid: !errors.length,
    });
    return {
      token,
      expires_at: new Date(expires).toISOString(),
      sheets,
      errors,
      samples,
      changes: {
        products_added: [...importedProducts.keys()].filter(
          (id) => !products.some((p) => p.product_id === id),
        ).length,
        products_updated: [...importedProducts.keys()].filter((id) =>
          products.some((p) => p.product_id === id),
        ).length,
        policies_added: [...importedPolicies.keys()].filter(
          (id) => !policies.some((p) => p.policy_id === id),
        ).length,
        policies_updated: [...importedPolicies.keys()].filter((id) =>
          policies.some((p) => p.policy_id === id),
        ).length,
      },
    };
  }
  apply(seller: string, token: string) {
    const p = this.pending.get(token);
    if (!p || p.seller !== seller || p.expires < Date.now())
      throw new AppError(
        'PREVIEW_EXPIRED',
        '미리보기가 만료됐습니다. 파일을 다시 확인하세요.',
        409,
      );
    if (!p.valid)
      throw new AppError(
        'INVALID_WORKBOOK',
        '오류가 있는 파일은 저장할 수 없습니다.',
      );
    this.store.importCatalog(seller, p.snapshots, p.products, p.policies);
    this.pending.delete(token);
  }
}
export async function exportCurrentWorkbook(store: Store, seller: string) {
  const data = store.exportCurrent(seller),
    book = new ExcelJS.Workbook();
  const add = (name: string, columns: string[], rows: unknown[][]) => {
    if (
      rows.some((row) =>
        row.some(
          (v) =>
            (typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''))
              .length > 32767,
        ),
      )
    )
      throw new AppError(
        'EXCEL_CELL_LIMIT',
        '엑셀 셀 한도(32,767자)를 넘는 기록이 있습니다. 전체 JSON으로 내보내세요.',
      );
    const sheet = book.addWorksheet(name);
    sheet.addRow(columns);
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    for (const row of rows)
      sheet.addRow(
        row.map((v) =>
          v === null || v === undefined
            ? ''
            : typeof v === 'object'
              ? JSON.stringify(v)
              : v,
        ),
      );
    sheet.columns.forEach((c) => (c.width = 25));
  };
  add(
    'products',
    productColumns,
    data.products.flatMap((p) =>
      p.variants.map((v) => [
        p.product_id,
        p.name,
        p.aliases.join('|'),
        p.material,
        p.closes_at,
        p.measurements_cm,
        v.sku,
        v.color,
        v.size,
        v.unit_price_krw,
        v.stock_available,
      ]),
    ),
  );
  add(
    'policies',
    policyColumns,
    data.policies.map((p) => policyColumns.map((c) => p[c as keyof Policy])),
  );
  add(
    'orders',
    [
      'order_id',
      'customer_handle',
      'status',
      'recipient_name',
      'phone_raw',
      'postal_code',
      'address_raw',
      'depositor_name',
      'items',
      'amounts',
      'created_at',
      'confirmed_at',
      'version',
      'payment',
      'origin_request_id',
      'carrier',
      'tracking_number',
      'shipped_at',
    ],
    data.orders.map((o) => [
      o.order_id,
      o.customer_handle,
      o.status,
      o.recipient.name,
      o.recipient.phone_raw,
      o.recipient.postal_code,
      o.recipient.address_raw,
      o.depositor_name,
      o.items.map((i, n) => ({
        ...i,
        label: o.item_labels[n],
        unit_price_krw: o.item_prices[n],
      })),
      o.amounts,
      o.created_at,
      o.confirmed_at,
      o.version,
      o.payment,
      o.origin_request_id,
      o.carrier,
      o.tracking_number,
      o.shipped_at,
    ]),
  );
  add(
    'conversations',
    ['id', 'customer_handle', 'context_label', 'created_at'],
    data.conversations.map((c) => [
      c.id,
      c.customer_handle,
      c.context_label,
      c.created_at,
    ]),
  );
  add(
    'messages',
    ['id', 'conversation_id', 'request_id', 'role', 'text', 'created_at'],
    data.messages.map((m) => [
      m.id,
      m.conversation_id,
      m.request_id,
      m.role,
      m.text,
      m.created_at,
    ]),
  );
  add(
    'analyses',
    ['request_id', 'conversation_id', 'status', 'analysis'],
    data.analyses.map((a) => [
      a.request_id,
      a.conversation_id,
      a.status,
      a.analysis,
    ]),
  );
  add(
    'shipment_events',
    ['event'],
    data.shipment_events.map((e) => [e]),
  );
  add(
    'parcel_exports',
    ['export'],
    data.parcel_exports.map((e) => [e]),
  );
  add(
    'metadata',
    ['key', 'value'],
    [
      ['schema_version', data.schema_version],
      ['seller_id', data.seller_id],
      ['exported_at', data.exported_at],
      ...Object.entries(data.snapshots),
    ],
  );
  add(
    'readme',
    ['항목', '설명'],
    [
      ['용도', '현재 데이터 내보내기. 택배사 업로드 양식이 아닙니다.'],
      [
        '가져오기',
        'products/policies 시트만 반영합니다. 주문·대화·분석 시트는 조회용이며 재가져오지 않습니다.',
      ],
      [
        '상품',
        '동일 product_id는 옵션 전체를 교체합니다. 파일에 없는 상품은 유지합니다. sku는 모든 상품에서 고유해야 합니다.',
      ],
      ['정책', '동일 policy_id를 갱신합니다. 배송비·할인은 각 최대 1개입니다.'],
      [
        'ID 자동 부여',
        '상품 ID·옵션 ID가 비어 있으면 상품명·색상·사이즈로 매칭하거나 생성합니다. 이름이 같은 여러 상품은 상품 ID를 지정하세요.',
      ],
      ['개인정보', '고객 연락처·주소·DM이 포함됩니다. 보관·공유에 주의하세요.'],
      ['시각', data.exported_at],
    ],
  );
  return Buffer.from(await book.xlsx.writeBuffer());
}
