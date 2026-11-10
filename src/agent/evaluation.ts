import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { analysisSchema, chatSchema } from '../domain/schema.js';
import { resultSchema } from '../domain/http-contract.js';

const strings = z.array(z.string());
const expectedSchema = z
  .object({
    classification: analysisSchema.shape.classification,
    status: analysisSchema.shape.status,
    state_mutation_allowed: z.literal(false),
    priority: analysisSchema.shape.priority.optional(),
    matched_skus: strings.optional(),
    order_candidates: strings.optional(),
    product_candidates: strings.optional(),
    quantities: z.array(z.number().int().positive()).optional(),
    total_krw: z.number().int().nonnegative().optional(),
    missing_fields: strings.optional(),
    invalid_fields: strings.optional(),
    review_codes: strings.optional(),
    evidence_required: strings.optional(),
    reply_must_be_null: z.literal(true).optional(),
    amounts_must_be_null: z.literal(true).optional(),
    extracted_fields: z
      .partialRecord(
        z.enum([
          'recipient.name',
          'recipient.phone_raw',
          'recipient.address_raw',
          'recipient.postal_code',
          'depositor_name',
          'customer_claimed_paid',
        ]),
        z.union([z.string(), z.boolean(), z.null()]),
      )
      .optional(),
    must_not_claim: strings.optional(),
    notes: strings.optional(),
  })
  .strict()
  .refine(
    (expected) =>
      !expected.quantities ||
      expected.quantities.length === expected.matched_skus?.length,
    'Expected quantities must align with matched_skus.',
  );

export const evaluationDatasetSchema = z
  .object({
    synthetic: z.literal(true),
    seller_id: z.literal('sample-seller-01'),
    cases: z
      .array(
        z.object({
          case_id: z.string().regex(/^DM-\d{3}$/),
          input: z.object({
            ...chatSchema.shape,
            // Invalid inputs must reach the production HTTP validation path.
            customer_handle: z.string(),
            reference_time: z.iso.datetime({ offset: true }),
            attachments: z
              .array(
                z
                  .object({ kind: z.string().min(1).max(50) })
                  .transform(({ kind }) => ({
                    type: kind,
                  })),
              )
              .max(5),
          }),
          expected: expectedSchema,
        }),
      )
      .length(40),
  })
  .refine(
    ({ cases }) => new Set(cases.map(({ case_id }) => case_id)).size === 40,
    'Each sample must have a unique case ID.',
  );

export type EvaluationCase = z.infer<
  typeof evaluationDatasetSchema
>['cases'][number];

export function evaluateResponse(
  expected: EvaluationCase['expected'],
  httpStatus: number,
  body: unknown,
  sourcesUnchanged: boolean,
) {
  const parsed = resultSchema.safeParse(body);
  const error = z
    .object({ error: z.object({ code: z.string().regex(/^[A-Z_]{1,80}$/) }) })
    .safeParse(body);
  const rejection =
    httpStatus === 422 && error.success
      ? z.object({ analysis: analysisSchema }).safeParse(body).data?.analysis
      : undefined;
  const analysis = parsed.success ? parsed.data.analysis : rejection;
  const checks: Record<string, boolean> = {
    http_status:
      httpStatus === (expected.status === 'invalid_input' ? 422 : 200),
    sources_unchanged: sourcesUnchanged,
    classification: analysis?.classification === expected.classification,
    status: analysis?.status === expected.status,
    state_mutation_allowed:
      analysis?.state_mutation_allowed === expected.state_mutation_allowed,
  };
  const equal = (field: string, wanted: unknown, actual: unknown) => {
    if (wanted !== undefined) checks[field] = isDeepStrictEqual(wanted, actual);
  };
  const unordered = (field: string, wanted?: string[], actual?: string[]) =>
    equal(field, wanted?.toSorted(), actual?.toSorted());

  equal('priority', expected.priority, analysis?.priority);
  unordered('matched_skus', expected.matched_skus, analysis?.matched_skus);
  unordered(
    'order_candidates',
    expected.order_candidates,
    analysis?.order_candidates,
  );
  unordered(
    'product_candidates',
    expected.product_candidates,
    analysis?.product_candidates,
  );
  unordered(
    'missing_fields',
    expected.missing_fields,
    analysis?.missing_fields,
  );
  unordered(
    'invalid_fields',
    expected.invalid_fields,
    analysis?.invalid_fields,
  );
  const draft = analysis?.order_draft;
  if (expected.quantities) {
    const quantities = new Map<string, number>();
    for (const { sku, quantity } of draft?.items ?? [])
      if (sku && quantity !== null)
        quantities.set(sku, (quantities.get(sku) ?? 0) + quantity);
    equal(
      'quantities',
      expected.quantities,
      expected.matched_skus!.map((sku) => quantities.get(sku)),
    );
  }
  equal('total_krw', expected.total_krw, draft?.amounts?.total_krw);
  if (expected.amounts_must_be_null)
    checks.amounts_must_be_null =
      !!analysis && (draft?.amounts ?? null) === null;
  if (expected.reply_must_be_null)
    checks.reply_must_be_null = analysis?.reply_draft === null;
  if (expected.review_codes)
    checks.review_codes = expected.review_codes.every((code) =>
      analysis?.review_items.some((item) => item.code === code),
    );
  if (expected.evidence_required)
    checks.evidence_required = expected.evidence_required.every((id) =>
      analysis?.evidence.some((item) => item.source_id === id),
    );
  const extracted = {
    ...draft,
    ...draft?.recipient,
    ...analysis?.payment_claim,
  };
  for (const [field, value] of Object.entries(expected.extracted_fields ?? {}))
    equal(
      'extracted_fields.' + field,
      value,
      extracted[field.replace(/^recipient\./, '') as keyof typeof extracted],
    );
  const manualReview = [
    ...(analysis?.reply_draft ? ['초안 사실성·말투·사용 가능 여부'] : []),
    ...(expected.notes ?? []),
    ...(expected.must_not_claim ?? []).map(
      (claim) => '금지 의미 확인: ' + claim,
    ),
  ];
  return {
    outcome: Object.values(checks).includes(false)
      ? ('failed' as const)
      : manualReview.length
        ? ('manual_review' as const)
        : ('passed' as const),
    http_status: httpStatus,
    error_code: error.success
      ? error.data.error.code
      : analysis?.status === 'failed'
        ? (analysis.review_items[0]?.code ?? null)
        : null,
    classification: analysis?.classification ?? null,
    status: analysis?.status ?? null,
    model_calls: parsed.success
      ? (parsed.data.execution?.model_calls ?? 0)
      : rejection
        ? 0
        : null,
    checks,
    manual_review: manualReview,
  };
}
