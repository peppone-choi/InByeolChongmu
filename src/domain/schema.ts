import { z } from 'zod';

const id = z.string().trim().min(1).max(100);
const money = z.number().int().min(0).max(1_000_000_000);
const time = z.iso.datetime({ offset: true });
export const variantSchema = z
  .object({
    sku: id,
    color: id,
    size: id,
    unit_price_krw: money,
    stock_available: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export const productSchema = z
  .object({
    product_id: id,
    name: id,
    aliases: z.array(id).max(100),
    measurements_cm: z
      .record(z.string(), z.number().positive().max(10000))
      .nullable(),
    material: z.string().max(1000).nullable(),
    closes_at: time,
    variants: z.array(variantSchema).min(1).max(1000),
  })
  .strict();
export const policySchema = z
  .object({
    policy_id: id,
    title: id.optional(),
    rule: z.string().min(1).max(10000),
    shipping_fee_krw: money.optional(),
    product_id: id.optional(),
    minimum_quantity: z.number().int().positive().optional(),
    discount_krw: money.optional(),
    next_dispatch_date: z.iso.date().optional(),
  })
  .strict();
export const orderSchema = z
  .object({
    order_id: id,
    customer_handle: id,
    recipient: z
      .object({
        name: id,
        phone_raw: id,
        address_raw: z.string().min(1).max(2000),
        postal_code: z.string().nullable(),
      })
      .strict(),
    depositor_name: id,
    items: z
      .array(
        z
          .object({
            sku: id,
            quantity: z.number().int().positive().max(10000),
            unit_price_krw: money,
          })
          .strict(),
      )
      .min(1),
    amounts: z
      .object({
        subtotal_krw: money,
        discount_krw: money,
        shipping_fee_krw: money,
        total_krw: money,
      })
      .strict(),
    status: z.enum([
      'draft',
      'pending_payment',
      'confirmed',
      'shipped',
      'cancelled',
    ]),
    created_at: time,
    confirmed_at: time.nullable(),
    carrier: z.string().nullable(),
    tracking_number: z.string().nullable(),
    shipped_at: time.nullable(),
    version: z.number().int().positive(),
  })
  .strict();
export const chatSchema = z
  .object({
    schema_version: z.literal('0.1'),
    request_id: id.optional(),
    conversation_id: z.uuid().optional(),
    customer_handle: id,
    text: z.string().max(20000),
    attachments: z
      .array(z.object({ type: z.string().min(1).max(50) }).strict())
      .max(5)
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.text.trim() && value.attachments.length === 0)
      ctx.addIssue({
        code: 'custom',
        path: ['text'],
        message: 'TEXT_REQUIRED',
      });
  });
export type Product = z.infer<typeof productSchema>;
export type Policy = z.infer<typeof policySchema>;
export type Order = z.infer<typeof orderSchema>;
export type ChatRequest = z.infer<typeof chatSchema>;
export const amountSchema = z
  .object({
    subtotal_krw: money,
    discount_krw: money,
    shipping_fee_krw: money,
    total_krw: money,
  })
  .strict();
export const analysisSchema = z
  .object({
    schema_version: z.literal('0.1'),
    request_id: id,
    classification: z
      .enum([
        'product_inquiry',
        'order_request',
        'payment_claim',
        'order_lookup',
        'claim',
        'unrelated',
        'invalid_input',
        'unsupported',
      ])
      .nullable(),
    status: z.enum([
      'invalid_input',
      'unsupported',
      'human_review',
      'needs_info',
      'awaiting_payment',
      'ready_for_review',
      'ignored',
      'failed',
    ]),
    priority: z.enum(['normal', 'high']),
    reply_draft: z.string().max(20000).nullable(),
    order_candidates: z.array(id),
    product_candidates: z.array(id),
    matched_skus: z.array(id),
    payment_claim: z
      .object({
        depositor_name: z.string().max(80).nullable(),
        customer_claimed_paid: z.literal(true),
      })
      .strict()
      .optional(),
    order_draft: z
      .object({
        customer_handle: id,
        recipient: z
          .object({
            name: z.string().nullable(),
            phone_raw: z.string().nullable(),
            address_raw: z.string().nullable(),
            postal_code: z.string().nullable(),
          })
          .strict(),
        depositor_name: z.string().nullable(),
        customer_claimed_paid: z.boolean(),
        items: z.array(
          z
            .object({
              product_id: id.nullable(),
              sku: id.nullable(),
              quantity: z.number().int().positive().nullable(),
              unit_price_krw: money.nullable(),
            })
            .strict(),
        ),
        amounts: amountSchema.nullable(),
        address_verification: z.enum([
          'not_checked',
          'matched',
          'no_match',
          'ambiguous',
          'failed',
          'manually_confirmed',
        ]),
      })
      .strict()
      .nullable(),
    missing_fields: z.array(z.string()),
    invalid_fields: z.array(z.string()),
    review_items: z.array(
      z
        .object({
          code: id,
          message: z.string(),
          retryable: z.boolean().optional(),
        })
        .strict(),
    ),
    evidence: z.array(
      z
        .object({
          source_type: z.enum(['product', 'policy', 'order']),
          source_id: id,
          snapshot_id: id,
          field_paths: z.array(z.string()),
        })
        .strict(),
    ),
    state_mutation_allowed: z.literal(false),
  })
  .strict();
export type Analysis = z.infer<typeof analysisSchema>;
export function emptyAnalysis(requestId: string): Analysis {
  return {
    schema_version: '0.1',
    request_id: requestId,
    classification: null,
    status: 'failed',
    priority: 'normal',
    reply_draft: null,
    order_candidates: [],
    product_candidates: [],
    matched_skus: [],
    order_draft: null,
    missing_fields: [],
    invalid_fields: [],
    review_items: [],
    evidence: [],
    state_mutation_allowed: false,
  };
}
