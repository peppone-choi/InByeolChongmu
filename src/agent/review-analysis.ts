import { z } from 'zod';
import {
  analysisSchema,
  orderSchema,
  productSchema,
} from '../domain/schema.js';
import type { Store } from '../storage/store.js';
import type { AgentRun } from './types.js';
import {
  customerTexts,
  hasPaymentQuestion,
  paymentStatement,
} from './customer-text.js';

const messages = {
  PRODUCT_UNRESOLVED: '문의한 상품의 이름이나 게시물을 확인해 주세요.',
  ORDER_NOT_FOUND:
    '현재 고객의 주문을 찾지 못했습니다. 주문 계정이나 주문번호를 확인해 주세요.',
  SOURCE_MISSING: '조회 자료에서 요청한 상품 정보를 확인하지 못했습니다.',
  SELLER_DECISION_REQUIRED: '변경이나 예외 처리는 판매자가 확인해 주세요.',
  OUT_OF_STOCK: '선택한 옵션의 가용 재고가 없습니다.',
  INSUFFICIENT_STOCK: '선택한 수량보다 가용 재고가 적습니다.',
  SALE_CLOSED: '판매 마감이 지났습니다.',
  PAYMENT_MISMATCH:
    '고객이 말한 금액과 주문 금액이 다릅니다. 실제 입금은 판매자가 확인해 주세요.',
  MANUAL_PAYMENT_CHECK: '실제 입금은 판매자가 확인해 주세요.',
  ADDRESS_UNVERIFIED: '수령 주소는 판매자가 확인해 주세요.',
  INVALID_PHONE: '연락처 형식을 확인해 주세요.',
  INVALID_QUANTITY: '주문할 수량을 확인해 주세요.',
} as const;
type ReviewCode = keyof typeof messages;

const orderLookup = z.object({
  records: z.array(z.unknown()),
  review_only: z.literal(true).optional(),
});
const quoteResult = z.object({
  items: z.array(z.object({ sku: z.string(), quantity: z.number() })),
  review_items: z.array(
    z.object({
      code: z.enum(['OUT_OF_STOCK', 'INSUFFICIENT_STOCK', 'SALE_CLOSED']),
    }),
  ),
});

export const productQuestion =
  '[확인 부탁드려요]\n어떤 상품인지 확인할 수 있도록 상품 이름이나 게시물을 알려 주세요.';
export const orderQuestion =
  '[확인 부탁드려요]\n주문하신 계정이나 주문번호를 알려 주시면 확인해 볼게요.';

export function existingPaymentClaim(text: string): boolean {
  return (
    !!paymentStatement([text]) &&
    !/주문\s*(?:할|하려|이요|할게)|새\s*주문|추가\s*주문|살게|사고\s*싶/u.test(
      text,
    )
  );
}

export function prepareReview(
  store: Store,
  run: AgentRun,
  raw: unknown,
): unknown {
  const parsed = analysisSchema.safeParse(raw);
  if (
    !parsed.success ||
    !parsed.data.classification ||
    ['failed', 'invalid_input', 'unsupported'].includes(parsed.data.status)
  )
    return raw;
  const analysis = parsed.data;
  delete analysis.payment_claim;
  const latestText = customerTexts(run.input, true).join('\n');
  const statement = paymentStatement([latestText]);
  if (!statement && hasPaymentQuestion(latestText)) {
    if (analysis.classification === 'payment_claim') {
      analysis.classification = 'order_lookup';
      analysis.status = 'human_review';
      analysis.reply_draft = null;
      analysis.order_draft = null;
      analysis.review_items = analysis.review_items.filter(
        ({ code }) =>
          code !== 'PAYMENT_MISMATCH' && code !== 'MANUAL_PAYMENT_CHECK',
      );
    } else if (analysis.order_draft) {
      analysis.order_draft.customer_claimed_paid = false;
    }
  }
  const add = (code: ReviewCode) => {
    if (!analysis.review_items.some((item) => item.code === code))
      analysis.review_items.push({ code, message: messages[code] });
  };
  const has = (code: string) =>
    analysis.review_items.some((item) => item.code === code);
  const traces = store.traces(run.id).filter(({ success }) => success);
  const orders = traces
    .filter(({ name }) => name === 'search_orders')
    .flatMap(({ result }) => orderLookup.safeParse(result).data ?? []);
  const knownOrders = new Map(
    orders.flatMap(({ records }) =>
      records.flatMap((record) => {
        const order = orderSchema.safeParse(record);
        return order.success &&
          order.data.customer_handle === run.input.customer_handle
          ? [[order.data.order_id, order.data] as const]
          : [];
      }),
    ),
  );
  const inquiry = ['order_lookup', 'payment_claim', 'claim'].includes(
    analysis.classification ?? '',
  );
  if (inquiry && !analysis.order_candidates.length && knownOrders.size === 1)
    analysis.order_candidates = [...knownOrders.keys()];
  const text = customerTexts(run.input).join('\n');
  const payment = existingPaymentClaim(latestText);
  const scoped =
    knownOrders.size === 1 ? [...knownOrders.values()][0] : undefined;
  if (payment && scoped?.status === 'pending_payment')
    analysis.order_candidates = [scoped.order_id];
  const order =
    analysis.order_candidates.length === 1
      ? knownOrders.get(analysis.order_candidates[0]!)
      : undefined;
  const thirdPartyPayer =
    payment &&
    /(?:남편|아내|배우자|친구|가족|부모님|대신).{0,35}(?:이름|명의|계좌)/u.test(
      text,
    );
  if (payment && (order?.status === 'pending_payment' || thirdPartyPayer))
    analysis.classification = 'payment_claim';
  const crossAccount = orders.filter(({ review_only }) => review_only);
  if (payment && crossAccount.length) analysis.classification = 'payment_claim';
  if (analysis.classification === 'payment_claim' && statement)
    analysis.payment_claim = statement;
  if (crossAccount.length) {
    const ids = crossAccount.flatMap(({ records }) =>
      z
        .array(z.object({ order_id: z.string() }))
        .parse(records)
        .map(({ order_id }) => order_id),
    );
    analysis.order_candidates = [...new Set(ids)];
    analysis.status = 'human_review';
    analysis.reply_draft = null;
    analysis.order_draft = null;
    analysis.missing_fields = [];
    analysis.invalid_fields = [];
    analysis.review_items = analysis.review_items.filter(
      ({ code }) =>
        ![
          'ORDER_NOT_FOUND',
          'ORDER_AMBIGUOUS',
          'ORDER_IDENTITY_UNVERIFIED',
        ].includes(code),
    );
    const ambiguous = new Set(ids).size > 1;
    const code = ambiguous ? 'ORDER_AMBIGUOUS' : 'ORDER_IDENTITY_UNVERIFIED';
    analysis.review_items.push({
      code,
      message: '판매자가 고객을 확인해 주세요.',
    });
    if (analysis.classification === 'payment_claim')
      add('SELLER_DECISION_REQUIRED');
    return analysis;
  }
  if (thirdPartyPayer && analysis.classification === 'payment_claim') {
    add('SELLER_DECISION_REQUIRED');
    analysis.status = 'human_review';
    analysis.reply_draft = null;
    analysis.order_draft = null;
    return analysis;
  }
  if (
    analysis.classification === 'order_request' &&
    has('SELLER_DECISION_REQUIRED') &&
    /(?:가격|얼마|[만천]원|만원|\d+원).{0,28}(?:맞|가능|안될)|입금하면.{0,14}(?:되|돼)/u.test(
      text,
    ) &&
    !analysis.order_draft?.recipient.name
  )
    analysis.classification = 'product_inquiry';
  if (
    (analysis.classification === 'product_inquiry' ||
      analysis.classification === 'order_request') &&
    /깎아|(?:현금|계좌이체).{0,30}(?:안될|안돼|되나요|될까요|가능)|(?:[만천]원|\d+원)(?:에|으로).{0,8}(?:안될|안돼|가능)/u.test(
      latestText,
    )
  ) {
    analysis.classification = 'product_inquiry';
    analysis.order_draft = null;
    add('SELLER_DECISION_REQUIRED');
  }
  const addressChange =
    analysis.classification === 'claim' &&
    /(?:주소|배송지|수령지).{0,90}(?:바꿀|바꿔|변경|수정)/su.test(text);
  if (addressChange) analysis.classification = 'order_lookup';
  if (
    analysis.classification === 'claim' ||
    addressChange ||
    has('ADDRESS_CHANGE_REQUESTED')
  ) {
    add('SELLER_DECISION_REQUIRED');
    analysis.status = 'human_review';
    analysis.priority =
      analysis.classification === 'claim' ? 'high' : analysis.priority;
  }
  if (analysis.classification === 'product_inquiry') {
    if (/소재|원단|재질|혼용/u.test(latestText)) {
      const matches = new Map(
        traces
          .filter(({ name }) => name === 'search_products')
          .flatMap(({ result }) => {
            const lookup = z
              .object({
                records: z.array(productSchema),
                snapshot_id: z.string(),
              })
              .safeParse(result);
            if (!lookup.success) return [];
            return lookup.data.records.map(
              (product) =>
                [
                  product.product_id,
                  { product, snapshot: lookup.data.snapshot_id },
                ] as const,
            );
          }),
      );
      const match = [...matches.values()][0];
      if (matches.size === 1 && match?.product.material === null) {
        analysis.product_candidates = [match.product.product_id];
        analysis.evidence = [
          {
            source_type: 'product',
            source_id: match.product.product_id,
            snapshot_id: match.snapshot,
            field_paths: ['material'],
          },
        ];
        analysis.reply_draft =
          '[확인 중이에요]\n소재는 정확히 확인해서 안내해 드릴게요.';
        analysis.review_items = analysis.review_items.filter(
          ({ code }) => code !== 'PRODUCT_UNRESOLVED',
        );
        analysis.missing_fields = analysis.missing_fields.filter(
          (field) => field !== 'product',
        );
        analysis.status = 'human_review';
        add('SOURCE_MISSING');
      }
    }
    const selected = store
      .products(run.seller_id)
      .filter(
        (p) =>
          analysis.product_candidates.includes(p.product_id) ||
          p.variants.some(({ sku }) => analysis.matched_skus.includes(sku)) ||
          analysis.evidence.some(
            (e) => e.source_type === 'product' && e.source_id === p.product_id,
          ),
      );
    if (
      !selected.length &&
      !analysis.order_draft &&
      !analysis.evidence.length
    ) {
      add('PRODUCT_UNRESOLVED');
      analysis.reply_draft = productQuestion;
      analysis.status = 'needs_info';
    }
    if (
      selected.some(({ material }) => material === null) &&
      /소재|원단|재질|혼용/u.test(text)
    )
      add('SOURCE_MISSING');
    if (selected.length && /비쳐|비침|부해|잘 맞을|착용감/u.test(text))
      add('SOURCE_MISSING');
    if (
      selected.some((p) =>
        p.variants.some(
          ({ sku, stock_available }) =>
            analysis.matched_skus.includes(sku) && stock_available === 0,
        ),
      )
    )
      add('OUT_OF_STOCK');
  }
  if (
    analysis.classification === 'order_lookup' &&
    !analysis.order_draft &&
    !analysis.order_candidates.length &&
    orders.length &&
    orders.every(({ records }) => records.length === 0) &&
    !has('SELLER_DECISION_REQUIRED')
  ) {
    add('ORDER_NOT_FOUND');
    analysis.status = 'needs_info';
    analysis.reply_draft = orderQuestion;
  }
  if (
    analysis.classification === 'payment_claim' &&
    order?.status === 'pending_payment'
  ) {
    const amounts = [
      ...latestText.matchAll(
        /(?<![\d-])(\d{1,3}(?:,\d{3})+|\d{4,})(?:\s*원)?\s*(?:입금|송금|넣었|보냈)/gu,
      ),
    ];
    const amount =
      amounts.length === 1
        ? Number(amounts[0]![1]!.replaceAll(',', ''))
        : undefined;
    const differs = amount !== undefined && amount !== order.amounts.total_krw;
    if (differs) add('PAYMENT_MISMATCH');
    add('MANUAL_PAYMENT_CHECK');
    if (payment || !analysis.order_draft) {
      analysis.order_draft = null;
      analysis.missing_fields = [];
      analysis.invalid_fields = [];
      analysis.status = differs ? 'human_review' : 'awaiting_payment';
      analysis.reply_draft = differs
        ? '[입금 확인]\n말씀해 주신 금액과 주문 금액을 대조한 뒤 안내드릴게요.'
        : '[입금 확인]\n입금 내역을 확인한 뒤 안내드릴게요.';
      const policyIds = traces
        .filter(({ name }) => name === 'get_policies')
        .flatMap(
          ({ result }) =>
            z
              .object({ records: z.array(z.object({ policy_id: z.string() })) })
              .safeParse(result).data?.records ?? [],
        )
        .map(({ policy_id }) => policy_id);
      analysis.evidence = [
        {
          source_type: 'order',
          source_id: order.order_id,
          snapshot_id: run.input.snapshots.orders,
          field_paths: ['status', 'amounts.total_krw'],
        },
        ...['POL-PAYMENT', ...(differs ? ['POL-SHIPPING'] : [])]
          .filter((id) => policyIds.includes(id))
          .map((id) => ({
            source_type: 'policy' as const,
            source_id: id,
            snapshot_id: run.input.snapshots.policies,
            field_paths: ['rule'],
          })),
      ];
    }
  }
  const draft = analysis.order_draft;
  if (draft) {
    add('MANUAL_PAYMENT_CHECK');
    add('ADDRESS_UNVERIFIED');
    if (
      analysis.classification === 'payment_claim' &&
      draft.items.length &&
      !analysis.order_candidates.length
    )
      analysis.classification = 'order_request';
    const phone = draft.recipient.phone_raw;
    const invalid = new Set(
      analysis.invalid_fields.map((field) =>
        field.replace(/^order_draft\./u, ''),
      ),
    );
    invalid.delete('INVALID_PHONE');
    invalid.delete('INVALID_QUANTITY');
    if (
      (phone && !/^010\d{8}$/.test(phone.replace(/[- ()]/g, ''))) ||
      has('INVALID_PHONE') ||
      analysis.invalid_fields.includes('INVALID_PHONE')
    ) {
      invalid.add('recipient.phone_raw');
      add('INVALID_PHONE');
    }
    if (
      has('INVALID_QUANTITY') ||
      analysis.invalid_fields.includes('INVALID_QUANTITY')
    ) {
      for (const [index, item] of draft.items.entries())
        if (item.quantity === null) invalid.add(`items[${index}].quantity`);
      add('INVALID_QUANTITY');
    }
    analysis.invalid_fields = [...invalid];
    analysis.missing_fields = [
      ...(['name', 'phone_raw', 'address_raw'] as const).flatMap((field) =>
        draft.recipient[field] ? [] : ['recipient.' + field],
      ),
      ...(!draft.depositor_name ? ['depositor_name'] : []),
      ...draft.items.flatMap((item, index) => [
        ...(!item.sku ? [`items[${index}].sku`] : []),
        ...(item.quantity === null ? [`items[${index}].quantity`] : []),
      ]),
    ].filter((field) => !invalid.has(field));
    const totals = (
      items: Array<{ sku: string | null; quantity: number | null }>,
    ) => {
      const result = new Map<string, number>();
      for (const { sku, quantity } of items)
        if (sku && quantity) result.set(sku, (result.get(sku) ?? 0) + quantity);
      return JSON.stringify([...result].sort(([a], [b]) => a.localeCompare(b)));
    };
    const quote = traces
      .filter(({ name }) => name === 'quote_order')
      .map(({ result }) => quoteResult.safeParse(result).data)
      .find((q) => q && totals(q.items) === totals(draft.items));
    for (const { code } of quote?.review_items ?? []) add(code);
    analysis.status =
      draft.amounts &&
      !analysis.missing_fields.length &&
      !invalid.size &&
      draft.items.length
        ? 'awaiting_payment'
        : 'needs_info';
  }
  if (
    has('PRODUCT_AMBIGUOUS') &&
    analysis.product_candidates.length > 1 &&
    !analysis.order_draft?.items.some(({ sku }) => sku)
  )
    analysis.matched_skus = [];
  if (
    [
      'SELLER_DECISION_REQUIRED',
      'SOURCE_MISSING',
      'OUT_OF_STOCK',
      'INSUFFICIENT_STOCK',
      'SALE_CLOSED',
      'PAYMENT_MISMATCH',
    ].some(has)
  )
    analysis.status = 'human_review';
  return analysis;
}
