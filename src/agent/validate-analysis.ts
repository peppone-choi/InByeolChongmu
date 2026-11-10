import { z } from 'zod';
import {
  analysisSchema,
  amountSchema,
  type Analysis,
} from '../domain/schema.js';
import { AppError } from '../domain/errors.js';
import type { Store } from '../storage/store.js';
import type { AgentRun } from './types.js';
import {
  addressFromCustomer,
  compactText,
  customerTexts,
  paymentStatement,
} from './customer-text.js';
import { orderQuestion, productQuestion } from './review-analysis.js';

const object = (value: unknown) =>
  z.record(z.string(), z.unknown()).parse(value);
export class AnalysisMismatch extends AppError {
  constructor(
    readonly check: string,
    reason?: string,
  ) {
    super(
      'OUTPUT_MISMATCH',
      reason ?? '조회 근거·계산·고객 범위와 분석 결과가 일치하지 않습니다.',
      503,
    );
  }
}
function mismatch(check: string, reason?: string): never {
  throw new AnalysisMismatch(check, reason);
}
export function validateAnalysis(
  store: Store,
  run: AgentRun,
  raw: unknown,
): Analysis {
  const parsed = analysisSchema.safeParse(raw);
  if (!parsed.success) mismatch('schema');
  const analysis = parsed.data;
  if (
    !analysis.classification ||
    ['failed', 'invalid_input', 'unsupported'].includes(analysis.status)
  )
    mismatch('analysis_state');
  if (analysis.request_id !== run.request_id) mismatch('request_id');
  if (analysis.payment_claim) {
    const statement = paymentStatement(customerTexts(run.input, true));
    if (
      analysis.classification !== 'payment_claim' ||
      !statement ||
      analysis.payment_claim.depositor_name !== statement.depositor_name
    )
      mismatch('payment_claim_source');
  }
  const snapshots = {
    product: run.input.snapshots.products,
    policy: run.input.snapshots.policies,
    order: run.input.snapshots.orders,
  };
  for (const type of ['product', 'policy', 'order'] as const)
    if (store.source(run.seller_id, type).snapshot_id !== snapshots[type])
      throw new AppError(
        'STALE_VERSION',
        '분석 중 자료가 변경됐습니다. 새 요청으로 다시 확인하세요.',
        503,
      );
  const traces = store
    .traces(run.id)
    .filter(
      (t) =>
        t.success && !['submit_analysis', 'classify_inquiry'].includes(t.name),
    );
  const clarification =
    analysis.status === 'needs_info' &&
    !analysis.order_draft &&
    !analysis.evidence.length &&
    ((analysis.classification === 'product_inquiry' &&
      analysis.reply_draft === productQuestion &&
      !analysis.product_candidates.length &&
      !analysis.matched_skus.length) ||
      (analysis.classification === 'order_lookup' &&
        analysis.reply_draft === orderQuestion &&
        !analysis.order_candidates.length &&
        traces.some(({ name }) => name === 'search_orders')));
  if (
    analysis.classification !== 'unrelated' &&
    traces.length === 0 &&
    !clarification
  )
    mismatch('lookup_required');
  const ids = {
    product: new Set<string>(),
    policy: new Set<string>(),
    order: new Set<string>(),
  };
  const skus = new Set<string>();
  const reviewOrders = new Set<string>();
  for (const trace of traces) {
    const result = object(trace.result);
    const type = result.source_type;
    if (type === 'product' || type === 'policy' || type === 'order') {
      if (result.snapshot_id !== snapshots[type]) mismatch('trace_snapshot');
      for (const value of z.array(z.unknown()).parse(result.records)) {
        const record = object(value),
          id = record[type + '_id'];
        if (typeof id !== 'string') mismatch('trace_id');
        if (type === 'order' && result.review_only === true) {
          reviewOrders.add(id);
          continue;
        }
        ids[type].add(id);
        if (type === 'product')
          for (const variant of z.array(z.unknown()).parse(record.variants)) {
            const sku = object(variant).sku;
            if (typeof sku === 'string') skus.add(sku);
          }
      }
    }
    if (trace.name === 'get_sales_calendar')
      for (const event of z.array(z.unknown()).parse(result.events)) {
        const item = object(event);
        if (
          (item.source_type === 'product' || item.source_type === 'policy') &&
          typeof item.source_id === 'string'
        )
          ids[item.source_type].add(item.source_id);
      }
  }
  if (
    analysis.product_candidates.some((id) => !ids.product.has(id)) ||
    analysis.order_candidates.some(
      (id) => !ids.order.has(id) && !reviewOrders.has(id),
    ) ||
    analysis.matched_skus.some((sku) => !skus.has(sku))
  )
    mismatch(
      'unknown_candidate',
      '후보에는 실제 조회한 product_id·order_id·sku만 사용하세요. 상품명이나 도구명은 ID가 아닙니다.',
    );
  if (
    reviewOrders.size &&
    (analysis.status !== 'human_review' ||
      analysis.reply_draft !== null ||
      analysis.order_draft !== null ||
      analysis.order_candidates.some((id) => !reviewOrders.has(id)) ||
      [...reviewOrders].some((id) => !analysis.order_candidates.includes(id)) ||
      !analysis.review_items.some(
        ({ code }) =>
          code ===
          (reviewOrders.size > 1
            ? 'ORDER_AMBIGUOUS'
            : 'ORDER_IDENTITY_UNVERIFIED'),
      ))
  )
    mismatch(
      'review_only',
      '이름으로 찾은 후보는 판매자 확인용입니다. 후보 ID를 모두 표시하고 답장과 주문 초안은 비워 주세요.',
    );
  for (const evidence of analysis.evidence)
    if (
      !ids[evidence.source_type].has(evidence.source_id) ||
      evidence.snapshot_id !== snapshots[evidence.source_type]
    )
      mismatch(
        'unknown_evidence',
        'evidence에는 실제 조회한 자료 ID와 snapshot_id를 사용하세요. quote_order 같은 도구명은 source_id가 아닙니다. 필요한 정책은 get_policies로 조회하세요.',
      );
  if (analysis.order_draft) {
    const draft = analysis.order_draft;
    if (
      draft.customer_handle !== run.input.customer_handle ||
      draft.address_verification !== 'not_checked'
    )
      mismatch('draft_scope');
    const products = store.products(run.seller_id);
    for (const item of draft.items)
      if (item.sku) {
        if (!skus.has(item.sku)) mismatch('sku_lookup');
        const product = products.find((p) =>
            p.variants.some((v) => v.sku === item.sku),
          ),
          variant = product?.variants.find((v) => v.sku === item.sku);
        if (
          !variant ||
          item.product_id !== product?.product_id ||
          item.unit_price_krw !== variant.unit_price_krw
        )
          mismatch('sku_price');
      }
    // A model must not turn absent customer data into a complete payable order.
    const texts = customerTexts(run.input);
    const customerText = texts.map(compactText);
    for (const value of [
      draft.recipient.name,
      draft.recipient.phone_raw,
      draft.recipient.postal_code,
      draft.depositor_name,
    ])
      if (
        value !== null &&
        (!compactText(value) ||
          !customerText.some((text) => text.includes(compactText(value))))
      )
        mismatch(
          'customer_source',
          '수령인·전화·우편번호·입금자는 고객 원문 값을 쓰세요.',
        );
    if (
      draft.recipient.address_raw !== null &&
      (!compactText(draft.recipient.address_raw) ||
        !addressFromCustomer(texts, draft.recipient.address_raw))
    )
      mismatch(
        'customer_source',
        '주소는 고객 원문이나 고객이 명시적으로 정정한 동·호·층을 사용하세요.',
      );
    if (
      !['needs_info', 'human_review', 'awaiting_payment'].includes(
        analysis.status,
      )
    )
      mismatch('draft_status');
    const requireReview = (code: string) => {
      if (
        analysis.status !== 'human_review' ||
        !analysis.review_items.some((item) => item.code === code)
      )
        mismatch('required_review');
    };
    for (const item of draft.items) {
      if (!item.sku) continue;
      const product = products.find((product) =>
        product.variants.some((variant) => variant.sku === item.sku),
      )!;
      const variant = product.variants.find(
        (variant) => variant.sku === item.sku,
      )!;
      if (variant.stock_available === 0) requireReview('OUT_OF_STOCK');
      if (Date.parse(product.closes_at) < Date.parse(run.input.reference_time))
        requireReview('SALE_CLOSED');
    }
    const resolved = draft.items.flatMap((item) =>
      item.sku && item.quantity
        ? [{ sku: item.sku, quantity: item.quantity }]
        : [],
    );
    const normalizeItems = (
      items: Array<{ sku: string; quantity: number }>,
    ) => {
      const quantities = new Map<string, number>();
      for (const item of items)
        quantities.set(
          item.sku,
          (quantities.get(item.sku) ?? 0) + item.quantity,
        );
      return JSON.stringify(
        [...quantities].sort(([a], [b]) => a.localeCompare(b)),
      );
    };
    // Availability warnings matter even when a recipient or total is still missing.
    const quote = resolved.length
      ? traces
          .filter((trace) => trace.name === 'quote_order')
          .map((trace) => object(trace.result))
          .find(
            (value) =>
              normalizeItems(
                z
                  .array(z.object({ sku: z.string(), quantity: z.number() }))
                  .parse(value.items),
              ) === normalizeItems(resolved),
          )
      : undefined;
    if (resolved.length && !quote) mismatch('quote_required');
    if (
      draft.amounts &&
      (!quote ||
        resolved.length !== draft.items.length ||
        JSON.stringify(amountSchema.parse(quote.amounts)) !==
          JSON.stringify(draft.amounts))
    )
      mismatch('quote_amount');
    if (quote)
      for (const review of z
        .array(z.object({ code: z.string() }))
        .parse(quote.review_items))
        requireReview(review.code);
    if (
      !analysis.review_items.some((r) => r.code === 'MANUAL_PAYMENT_CHECK') ||
      !analysis.review_items.some((r) => r.code === 'ADDRESS_UNVERIFIED')
    )
      mismatch('manual_checks');
    if (analysis.status === 'awaiting_payment') {
      if (
        !draft.amounts ||
        analysis.missing_fields.length ||
        analysis.invalid_fields.length ||
        !draft.recipient.name ||
        !draft.recipient.phone_raw ||
        !/^010\d{8}$/.test(draft.recipient.phone_raw.replace(/[- ()]/g, '')) ||
        !draft.recipient.address_raw ||
        !draft.depositor_name ||
        draft.items.length === 0
      )
        mismatch('payment_fields');
    }
  } else if (analysis.status === 'awaiting_payment') {
    const [id] = analysis.order_candidates;
    if (
      analysis.classification !== 'payment_claim' ||
      analysis.order_candidates.length !== 1 ||
      !analysis.evidence.some(
        (e) => e.source_type === 'order' && e.source_id === id,
      ) ||
      !analysis.review_items.some(
        (item) => item.code === 'MANUAL_PAYMENT_CHECK',
      ) ||
      !store
        .orders(run.seller_id)
        .some(
          (order) =>
            order.order_id === id &&
            order.customer_handle === run.input.customer_handle &&
            order.status === 'pending_payment',
        )
    )
      mismatch(
        'payment_draft_required',
        '새 주문 초안 또는 조회 근거가 있는 고객의 입금 대기 주문이 필요합니다.',
      );
  }
  if (
    analysis.classification === 'unrelated' &&
    (analysis.reply_draft !== null || analysis.status !== 'ignored')
  )
    mismatch('unrelated_state');
  if (
    analysis.classification === 'claim' &&
    (analysis.priority !== 'high' || analysis.status !== 'human_review')
  )
    mismatch('claim_state');
  if (
    analysis.reply_draft &&
    analysis.classification !== 'claim' &&
    analysis.evidence.length === 0 &&
    !clarification
  )
    mismatch('reply_evidence_required');
  // Tool arguments can double-escape line breaks; copyable text needs real lines.
  if (analysis.reply_draft)
    analysis.reply_draft = analysis.reply_draft.replace(/\\r\\n|\\n/g, '\n');
  return analysis;
}
