import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { Store } from '../storage/store.js';

const query = z.string().trim().min(1).max(200);
const itemsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            sku: query,
            quantity: z.number().int().positive().max(10000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const toolSchemas = {
  search_products: z.object({ query }).strict(),
  get_policies: z.object({ query: query.optional() }).strict(),
  search_orders: z.object({ query }).strict(),
  get_sales_calendar: z
    .object({
      from: z.iso.datetime({ offset: true }),
      to: z.iso.datetime({ offset: true }),
    })
    .strict(),
  read_document: z.object({ document_id: z.literal('policy-guide') }).strict(),
  quote_order: itemsSchema,
};
export type ToolName = keyof typeof toolSchemas;
const descriptions: Record<ToolName, string> = {
  search_products:
    '조회 전용: 상품명·별칭·SKU로 모든 후보와 가격·재고·버전을 찾습니다.',
  get_policies: '조회 전용: 판매 정책을 근거 ID와 자료 버전으로 반환합니다.',
  search_orders:
    '조회 전용: 고객 아이디·이름·주문 ID로 찾으며 연결된 방에서는 해당 고객만 조회합니다.',
  get_sales_calendar:
    '조회 전용: 자료에 명시된 공구 마감·출고 예정일을 기간으로 조회합니다. 외부 캘린더가 아닙니다.',
  read_document:
    '조회 전용: 허용된 가상 판매 문서만 읽습니다. 임의 파일 경로를 받지 않습니다.',
  quote_order:
    '코드 계산: 실제 상품 가격·할인·배송비로 합계를 구합니다. 확정·재고 변경은 하지 않습니다.',
};
export function toolCatalog() {
  return Object.entries(toolSchemas).map(([name, schema]) => ({
    name,
    description: descriptions[name as ToolName],
    input_schema: z.toJSONSchema(schema),
    read_only: true,
  }));
}
export class Tools {
  constructor(
    private readonly store: Store,
    private readonly sellerId: string,
    private readonly root: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly customerHandle?: string,
  ) {}
  call(name: string, input: unknown): unknown {
    if (!Object.hasOwn(toolSchemas, name))
      throw new AppError('TOOL_NOT_ALLOWED', '허용되지 않은 도구입니다.', 404);
    const parsed = toolSchemas[name as ToolName].safeParse(input);
    if (!parsed.success)
      throw new AppError('INVALID_TOOL_INPUT', '도구 입력 형식을 확인하세요.');
    switch (name as ToolName) {
      case 'search_products':
        return this.searchProducts(
          toolSchemas.search_products.parse(input).query,
        );
      case 'get_policies':
        return this.policies(toolSchemas.get_policies.parse(input).query);
      case 'search_orders':
        return this.orders(toolSchemas.search_orders.parse(input).query);
      case 'get_sales_calendar':
        return this.calendar(toolSchemas.get_sales_calendar.parse(input));
      case 'read_document':
        return this.document();
      case 'quote_order':
        return this.quote(toolSchemas.quote_order.parse(input).items);
    }
  }
  private searchProducts(value: string) {
    const needle = value.toLocaleLowerCase('ko');
    const records = this.store
      .products(this.sellerId)
      .filter((p) =>
        [
          p.product_id,
          p.name,
          ...p.aliases,
          ...p.variants.map((v) => v.sku),
        ].some((field) => field.toLocaleLowerCase('ko').includes(needle)),
      );
    return {
      source_type: 'product',
      ...this.store.source(this.sellerId, 'product'),
      records,
      ambiguous: records.length > 1,
    };
  }
  private policies(value?: string) {
    const records = this.store
      .policies(this.sellerId)
      .filter(
        (p) => !value || p.policy_id.includes(value) || p.rule.includes(value),
      );
    return {
      source_type: 'policy',
      ...this.store.source(this.sellerId, 'policy'),
      records,
    };
  }
  private orders(value: string) {
    const needle = value.toLocaleLowerCase('ko');
    const matches = this.store
      .orders(this.sellerId)
      .filter(
        (o) =>
          (!this.customerHandle || o.customer_handle === this.customerHandle) &&
          [o.order_id, o.customer_handle, o.recipient.name].some(
            (v) => v.toLocaleLowerCase('ko') === needle,
          ),
      );
    // Candidate lists omit addresses and phone numbers; an unambiguous match can include its record.
    return {
      source_type: 'order',
      ...this.store.source(this.sellerId, 'order'),
      ambiguous: matches.length > 1,
      records:
        matches.length === 1
          ? matches
          : matches.map((o) => ({
              order_id: o.order_id,
              customer_handle: o.customer_handle,
              recipient_name: o.recipient.name,
              status: o.status,
            })),
    };
  }
  private calendar({ from, to }: { from: string; to: string }) {
    const start = Date.parse(from),
      end = Date.parse(to);
    if (end < start || end - start > 366 * 86400000)
      throw new AppError(
        'INVALID_DATE_RANGE',
        '일정 범위는 순서에 맞는 최대 366일이어야 합니다.',
      );
    const events: Array<Record<string, string>> = [];
    for (const p of this.store.products(this.sellerId))
      if (Date.parse(p.closes_at) >= start && Date.parse(p.closes_at) <= end)
        events.push({
          kind: 'sale_closes',
          at: p.closes_at,
          source_type: 'product',
          source_id: p.product_id,
          snapshot_id: this.store.source(this.sellerId, 'product').snapshot_id,
        });
    for (const p of this.store.policies(this.sellerId))
      if (p.next_dispatch_date) {
        const day = Date.parse(p.next_dispatch_date + 'T00:00:00+09:00');
        if (day <= end && day + 86400000 > start)
          events.push({
            kind: 'dispatch_planned',
            date: p.next_dispatch_date,
            timezone: 'Asia/Seoul',
            source_type: 'policy',
            source_id: p.policy_id,
            snapshot_id: this.store.source(this.sellerId, 'policy').snapshot_id,
          });
      }
    return { external_calendar_connected: false, events };
  }
  private document() {
    const expectedBase = resolve(
      realpathSync(this.root),
      'assets/sample-store',
    );
    const base = realpathSync(expectedBase);
    if (base !== expectedBase)
      throw new AppError(
        'DOCUMENT_NOT_ALLOWED',
        '문서 디렉터리의 심볼릭 링크는 허용하지 않습니다.',
        403,
      );
    const path = realpathSync(resolve(base, 'policy-guide.md'));
    const rel = relative(base, path);
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new AppError(
        'DOCUMENT_NOT_ALLOWED',
        '허용된 문서 범위를 벗어납니다.',
        403,
      );
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 65536)
      throw new AppError('INVALID_DOCUMENT', '문서 크기나 형식을 확인하세요.');
    const content = readFileSync(path, 'utf8');
    return {
      document_id: 'policy-guide',
      version: createHash('sha256').update(content).digest('hex'),
      synthetic: true,
      authority: 'sample_policy',
      content,
    };
  }
  private quote(items: Array<{ sku: string; quantity: number }>) {
    const products = this.store.products(this.sellerId),
      policies = this.store.policies(this.sellerId);
    const bySku = new Map(
      products.flatMap((p) =>
        p.variants.map((v) => [v.sku, { p, v }] as const),
      ),
    );
    const grouped = new Map<string, number>();
    for (const i of items)
      grouped.set(i.sku, (grouped.get(i.sku) ?? 0) + i.quantity);
    let subtotal = 0;
    const productQuantities = new Map<string, number>();
    const review: Array<{ code: string; sku?: string }> = [];
    const resolved = [...grouped].map(([sku, quantity]) => {
      const match = bySku.get(sku);
      if (!match)
        throw new AppError(
          'PRODUCT_UNRESOLVED',
          '상품 SKU의 가격 근거를 찾지 못했습니다.',
        );
      if (quantity > 10000)
        throw new AppError(
          'INVALID_QUANTITY',
          'SKU별 수량 상한은 10,000개입니다.',
        );
      subtotal += match.v.unit_price_krw * quantity;
      productQuantities.set(
        match.p.product_id,
        (productQuantities.get(match.p.product_id) ?? 0) + quantity,
      );
      if (match.v.stock_available < quantity)
        review.push({
          code:
            match.v.stock_available === 0
              ? 'OUT_OF_STOCK'
              : 'INSUFFICIENT_STOCK',
          sku,
        });
      if (Date.parse(match.p.closes_at) < this.clock().getTime())
        review.push({ code: 'SALE_CLOSED', sku });
      return {
        product_id: match.p.product_id,
        sku,
        quantity,
        unit_price_krw: match.v.unit_price_krw,
      };
    });
    const shipping = policies.filter((p) => p.shipping_fee_krw !== undefined);
    const discounts = policies.filter((p) => p.discount_krw !== undefined);
    if (shipping.length !== 1 || discounts.length > 1)
      throw new AppError(
        'SOURCE_MISSING',
        '지원하는 배송비·할인 규칙을 명확히 확인할 수 없습니다.',
        503,
      );
    const shippingFee = shipping[0]?.shipping_fee_krw;
    if (shippingFee === undefined)
      throw new AppError('SOURCE_MISSING', '배송비 정책이 없습니다.', 503);
    let discount = 0;
    for (const policy of discounts) {
      if (
        !policy.product_id ||
        !policy.minimum_quantity ||
        policy.discount_krw === undefined
      )
        throw new AppError('SOURCE_MISSING', '할인 조건이 불완전합니다.', 503);
      if (
        (productQuantities.get(policy.product_id) ?? 0) >=
        policy.minimum_quantity
      )
        discount += policy.discount_krw;
    }
    const total = subtotal - discount + shippingFee;
    if (
      !Number.isSafeInteger(total) ||
      Math.max(total, subtotal) > 1_000_000_000 ||
      total < 0
    )
      throw new AppError('INVALID_AMOUNT', '지원 금액 범위를 벗어납니다.');
    return {
      items: resolved,
      amounts: {
        subtotal_krw: subtotal,
        discount_krw: discount,
        shipping_fee_krw: shippingFee,
        total_krw: total,
      },
      review_items: review,
      can_confirm: false,
      state_mutation_allowed: false,
      snapshots: {
        products: this.store.source(this.sellerId, 'product').snapshot_id,
        policies: this.store.source(this.sellerId, 'policy').snapshot_id,
      },
    };
  }
}
