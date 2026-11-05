import { z } from 'zod';
import {
  analysisSchema,
  amountSchema,
  type Analysis,
} from '../domain/schema.js';
import { AppError } from '../domain/errors.js';
import type { Store } from '../storage/store.js';
import type { AgentRun } from './types.js';

const object = (value: unknown) =>
  z.record(z.string(), z.unknown()).parse(value);
function mismatch(): never {
  throw new AppError(
    'OUTPUT_MISMATCH',
    '조회 근거·계산·고객 범위와 분석 결과가 일치하지 않습니다.',
    503,
  );
}
export function validateAnalysis(
  store: Store,
  run: AgentRun,
  raw: unknown,
): Analysis {
  const parsed = analysisSchema.safeParse(raw);
  if (!parsed.success) mismatch();
  const analysis = parsed.data;
  if (
    !analysis.classification ||
    ['failed', 'invalid_input', 'unsupported'].includes(analysis.status)
  )
    mismatch();
  if (analysis.request_id !== run.request_id) mismatch();
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
  if (analysis.classification !== 'unrelated' && traces.length === 0)
    mismatch();
  const ids = {
    product: new Set<string>(),
    policy: new Set<string>(),
    order: new Set<string>(),
  };
  const skus = new Set<string>();
  for (const trace of traces) {
    const result = object(trace.result);
    const type = result.source_type;
    if (type === 'product' || type === 'policy' || type === 'order') {
      if (result.snapshot_id !== snapshots[type]) mismatch();
      for (const value of z.array(z.unknown()).parse(result.records)) {
        const record = object(value),
          id = record[type + '_id'];
        if (typeof id !== 'string') mismatch();
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
    analysis.order_candidates.some((id) => !ids.order.has(id)) ||
    analysis.matched_skus.some((sku) => !skus.has(sku))
  )
    mismatch();
  for (const evidence of analysis.evidence)
    if (
      !ids[evidence.source_type].has(evidence.source_id) ||
      evidence.snapshot_id !== snapshots[evidence.source_type]
    )
      mismatch();
  if (analysis.order_draft) {
    const draft = analysis.order_draft;
    if (
      draft.customer_handle !== run.input.customer_handle ||
      draft.address_verification !== 'not_checked'
    )
      mismatch();
    const products = store.products(run.seller_id);
    for (const item of draft.items)
      if (item.sku) {
        if (!skus.has(item.sku)) mismatch();
        const product = products.find((p) =>
            p.variants.some((v) => v.sku === item.sku),
          ),
          variant = product?.variants.find((v) => v.sku === item.sku);
        if (
          !variant ||
          item.product_id !== product?.product_id ||
          item.unit_price_krw !== variant.unit_price_krw
        )
          mismatch();
      }
    if (draft.amounts) {
      const normalize = (
        items: Array<{ sku: string | null; quantity: number | null }>,
      ) => {
        const quantities = new Map<string, number>();
        for (const item of items) {
          if (!item.sku || !item.quantity) mismatch();
          quantities.set(
            item.sku,
            (quantities.get(item.sku) ?? 0) + item.quantity,
          );
        }
        return JSON.stringify(
          [...quantities].sort(([a], [b]) => a.localeCompare(b)),
        );
      };
      const quote = traces
        .filter((t) => t.name === 'quote_order')
        .map((t) => object(t.result))
        .find(
          (value) =>
            normalize(
              z
                .array(z.object({ sku: z.string(), quantity: z.number() }))
                .parse(value.items),
            ) === normalize(draft.items),
        );
      if (
        !quote ||
        JSON.stringify(amountSchema.parse(quote.amounts)) !==
          JSON.stringify(draft.amounts)
      )
        mismatch();
      for (const value of z
        .array(z.object({ code: z.string() }))
        .parse(quote.review_items))
        if (
          !analysis.review_items.some((review) => review.code === value.code) ||
          analysis.status !== 'human_review'
        )
          mismatch();
    }
    if (
      !analysis.review_items.some((r) => r.code === 'MANUAL_PAYMENT_CHECK') ||
      !analysis.review_items.some((r) => r.code === 'ADDRESS_UNVERIFIED')
    )
      mismatch();
    if (analysis.status === 'awaiting_payment') {
      if (
        !draft.amounts ||
        analysis.missing_fields.length ||
        analysis.invalid_fields.length ||
        !draft.recipient.name ||
        !draft.recipient.phone_raw ||
        !draft.recipient.address_raw ||
        !draft.depositor_name ||
        draft.items.length === 0
      )
        mismatch();
    }
  } else if (analysis.status === 'awaiting_payment') mismatch();
  if (
    analysis.classification === 'unrelated' &&
    (analysis.reply_draft !== null || analysis.status !== 'ignored')
  )
    mismatch();
  if (
    analysis.classification === 'claim' &&
    (analysis.priority !== 'high' || analysis.status !== 'human_review')
  )
    mismatch();
  if (
    analysis.reply_draft &&
    analysis.classification !== 'claim' &&
    analysis.evidence.length === 0
  )
    mismatch();
  return analysis;
}
