import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { Store } from './store.js';
import { AppError } from '../domain/errors.js';
import {
  defaultParcelTemplate,
  parcelTemplateSchema,
  parcelSelectionSchema,
  parcelCreateSchema,
  parcelPreviewSchema,
  parcelExportSchema,
  type ParcelTemplate,
  type ParcelSelection,
  type ParcelPreview,
  type ParcelExport,
} from '../domain/shipping.js';
import { z } from 'zod';
const payloadSchema = z.object({
  preview: parcelPreviewSchema,
  selection: parcelSelectionSchema,
});
export class Parcels {
  constructor(
    private db: DatabaseSync,
    private store: Store,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS parcel_templates(seller_id TEXT PRIMARY KEY,version TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
 CREATE TABLE IF NOT EXISTS parcel_exports(seller_id TEXT NOT NULL,id TEXT NOT NULL,command_id TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at TEXT NOT NULL,template_version TEXT NOT NULL,template_name TEXT NOT NULL,order_ids TEXT NOT NULL CHECK(json_valid(order_ids)),excluded TEXT NOT NULL CHECK(json_valid(excluded)),payload TEXT CHECK(payload IS NULL OR json_valid(payload)),PRIMARY KEY(seller_id,id),UNIQUE(seller_id,command_id)) STRICT;
 INSERT OR IGNORE INTO schema_migrations VALUES(4);`);
  }
  private atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  template(seller: string) {
    const row = this.db
      .prepare('SELECT version,payload FROM parcel_templates WHERE seller_id=?')
      .get(seller);
    return row
      ? {
          version: String(row.version),
          template: parcelTemplateSchema.parse(JSON.parse(String(row.payload))),
        }
      : {
          version: 'common-v1',
          template: parcelTemplateSchema.parse(defaultParcelTemplate),
        };
  }
  saveTemplate(seller: string, version: string, raw: ParcelTemplate) {
    const template = parcelTemplateSchema.parse(raw);
    return this.atomic(() => {
      if (this.template(seller).version !== version)
        throw new AppError(
          'STALE_VERSION',
          '열 설정이 변경됐습니다. 최신 설정을 다시 불러오세요.',
          409,
        );
      const next = randomUUID();
      this.db
        .prepare(
          'INSERT INTO parcel_templates VALUES(?,?,?) ON CONFLICT(seller_id) DO UPDATE SET version=excluded.version,payload=excluded.payload',
        )
        .run(seller, next, JSON.stringify(template));
      return { version: next, template };
    });
  }
  list(seller: string): ParcelExport[] {
    return this.db
      .prepare(
        'SELECT * FROM parcel_exports WHERE seller_id=? ORDER BY rowid DESC',
      )
      .all(seller)
      .map((row) =>
        parcelExportSchema.parse({
          export_id: String(row.id),
          command_id: String(row.command_id),
          created_at: String(row.created_at),
          template_version: String(row.template_version),
          template_name: String(row.template_name),
          included_order_ids: JSON.parse(String(row.order_ids)),
          excluded: JSON.parse(String(row.excluded)),
          download_available: row.payload !== null,
        }),
      );
  }
  preview(seller: string, raw: ParcelSelection): ParcelPreview {
    const selection = parcelSelectionSchema.parse(raw),
      template = this.template(seller);
    if (template.version !== selection.template_version)
      throw new AppError(
        'STALE_VERSION',
        '열 설정이 변경됐습니다. 설정을 새로 불러오세요.',
        409,
      );
    const orders = this.store.commerce.list(seller),
      rows: ParcelPreview['rows'] = [],
      excluded: ParcelPreview['excluded'] = [],
      previous_exports: ParcelPreview['previous_exports'] = [],
      exports = this.list(seller);
    const versions: Array<{ id: string; version: number | null }> = [];
    for (const id of selection.order_ids) {
      const o = orders.find((o) => o.order_id === id);
      versions.push({ id, version: o?.version ?? null });
      let reason = '';
      if (!o) reason = '주문을 찾을 수 없습니다.';
      else if (o.status !== 'confirmed')
        reason =
          o.status === 'shipped'
            ? '이미 발송한 주문입니다.'
            : o.status === 'cancelled'
              ? '취소된 주문입니다.'
              : '입금 확인·확정 전 주문입니다.';
      else if (o.shipped_at || o.tracking_number || o.carrier)
        reason = '기존 발송 정보가 있어 확인이 필요합니다.';
      else if (
        !o.amounts ||
        !o.confirmed_at ||
        !o.items.length ||
        o.items.some((i) => !i.sku || !i.quantity)
      )
        reason = '확정 주문의 상품·금액·확정 시각을 확인하세요.';
      if (reason || !o) {
        excluded.push({ order_id: id, reason });
        continue;
      }
      const row = {
        order_id: id,
        recipient_name: o.recipient.name ?? '',
        phone: (o.recipient.phone_raw ?? '').replace(/[\s()-]/g, ''),
        postal_code: o.recipient.postal_code ?? '',
        address: o.recipient.address_raw ?? '',
        item_summary: o.items
          .map((i, n) => `${o.item_labels[n] ?? i.sku} × ${i.quantity}`)
          .join(' / '),
        total_krw: o.amounts!.total_krw,
        shipping_memo: selection.notes[id] ?? '',
      };
      if (!/^0\d{8,10}$/.test(row.phone))
        reason = '연락처 형식이 올바르지 않습니다.';
      if (row.postal_code && !/^\d{5}$/.test(row.postal_code))
        reason = '우편번호 형식이 올바르지 않습니다.';
      const missing = template.template.columns
        .filter(
          (c) =>
            c.required &&
            (row[c.field] === null || String(row[c.field]).trim() === ''),
        )
        .map((c) => c.header);
      if (missing.length) reason = `필수값 누락: ${missing.join(', ')}`;
      if (
        template.template.columns.some(
          (c) => String(row[c.field]).length > 32767,
        )
      )
        reason = '엑셀 셀 한도(32,767자)를 넘습니다.';
      if (reason) {
        excluded.push({ order_id: id, reason });
        continue;
      }
      rows.push(row);
      const prior = exports.filter((e) => e.included_order_ids.includes(id));
      if (prior.length)
        previous_exports.push({
          order_id: id,
          count: prior.length,
          last_exported_at: prior[0]!.created_at,
        });
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          selection,
          template,
          versions,
          rows,
          excluded,
          previous_exports,
        }),
      )
      .digest('hex');
    return {
      fingerprint,
      template,
      rows,
      included_order_ids: rows.map((r) => r.order_id),
      excluded,
      previous_exports,
    };
  }
  create(
    seller: string,
    raw: z.infer<typeof parcelCreateSchema>,
    now = new Date(),
  ) {
    const input = parcelCreateSchema.parse(raw),
      signature = createHash('sha256')
        .update(JSON.stringify(input))
        .digest('hex');
    return this.atomic(() => {
      const prior = this.db
        .prepare(
          'SELECT id,fingerprint FROM parcel_exports WHERE seller_id=? AND command_id=?',
        )
        .get(seller, input.command_id);
      if (prior) {
        if (prior.fingerprint !== signature)
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            '같은 내보내기 요청의 내용이 다릅니다.',
            409,
          );
        return {
          ...this.list(seller).find((e) => e.export_id === prior.id)!,
          replayed: true,
        };
      }
      const selection = parcelSelectionSchema.parse({
          template_version: input.template_version,
          order_ids: input.order_ids,
          notes: input.notes,
        }),
        preview = this.preview(seller, selection);
      if (preview.fingerprint !== input.fingerprint)
        throw new AppError(
          'STALE_VERSION',
          '주문·발송 상태 또는 내보내기 이력이 바뀌었습니다. 미리보기를 다시 확인하세요.',
          409,
        );
      if (!preview.rows.length)
        throw new AppError(
          'NO_EXPORTABLE_ORDERS',
          '내보낼 확정·미발송 주문이 없습니다.',
          422,
        );
      if (preview.previous_exports.length && !input.acknowledge_repeat)
        throw new AppError(
          'REEXPORT_CONFIRMATION_REQUIRED',
          '이전에 내보낸 주문입니다. 중복 접수 위험을 확인하세요.',
          409,
        );
      const id = randomUUID(),
        created = now.toISOString();
      this.db
        .prepare('INSERT INTO parcel_exports VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(
          seller,
          id,
          input.command_id,
          signature,
          created,
          preview.template.version,
          preview.template.template.name,
          JSON.stringify(preview.included_order_ids),
          JSON.stringify(preview.excluded),
          JSON.stringify({ selection, preview }),
        );
      return {
        ...this.list(seller).find((e) => e.export_id === id)!,
        replayed: false,
      };
    });
  }
  async download(seller: string, id: string) {
    const record = this.db
      .prepare('SELECT * FROM parcel_exports WHERE seller_id=? AND id=?')
      .get(seller, id);
    if (!record)
      throw new AppError(
        'EXPORT_NOT_FOUND',
        '내보내기 기록을 찾을 수 없습니다.',
        404,
      );
    if (record.payload === null)
      throw new AppError(
        'EXPORT_INVALIDATED',
        '포함된 주문이 삭제돼 파일을 다시 받을 수 없습니다. 남은 주문을 새로 선택하세요.',
        409,
      );
    const { preview } = payloadSchema.parse(JSON.parse(String(record.payload))),
      book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet(preview.template.template.sheet_name);
    book.created = new Date(String(record.created_at));
    book.modified = book.created;
    sheet.addRow(preview.template.template.columns.map((c) => c.header));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    for (const row of preview.rows)
      sheet.addRow(preview.template.template.columns.map((c) => row[c.field]));
    sheet.columns.forEach((c) => (c.width = 25));
    return Buffer.from(await book.xlsx.writeBuffer());
  }
}
