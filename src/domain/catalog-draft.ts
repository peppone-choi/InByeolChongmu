import { z } from 'zod';
import { policySchema, productSchema, variantSchema } from './schema.js';

const draftQuestion = z.string().trim().min(1).max(400);
const draftTitle = policySchema.shape.title.unwrap();
const policyDraftFields = {
  title: draftTitle,
  rule: policySchema.shape.rule,
};

export const catalogDraftRequestSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(['seller', 'assistant']),
            text: z.string().trim().min(1).max(1500),
          })
          .strict(),
      )
      .min(1)
      .max(11),
  })
  .strict()
  .refine(
    ({ messages }) =>
      messages.every(
        ({ role }, index) => role === (index % 2 ? 'assistant' : 'seller'),
      ) && messages.at(-1)?.role === 'seller',
  );

export const catalogExtractionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('question'), question: draftQuestion }),
  z.strictObject({
    kind: z.literal('product'),
    value: productSchema.omit({ product_id: true }).extend({
      variants: z
        .array(variantSchema.partial({ sku: true }))
        .min(1)
        .max(50),
    }),
  }),
  z.strictObject({ kind: z.literal('text'), ...policyDraftFields }),
  z.strictObject({
    kind: z.literal('shipping'),
    ...policyDraftFields,
    shipping_fee_krw: policySchema.shape.shipping_fee_krw.unwrap(),
  }),
  z.strictObject({
    kind: z.literal('dispatch'),
    ...policyDraftFields,
    next_dispatch_date: policySchema.shape.next_dispatch_date.unwrap(),
  }),
  z.strictObject({
    kind: z.literal('discount'),
    ...policyDraftFields,
    product_name: productSchema.shape.name,
    minimum_quantity: policySchema.shape.minimum_quantity.unwrap().max(10000),
    discount_krw: policySchema.shape.discount_krw.unwrap(),
  }),
]);

export const catalogDraftSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('question'), question: draftQuestion }),
  z.strictObject({
    kind: z.literal('product'),
    value: productSchema,
    snapshot: z.string().min(1),
    create: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal('policy'),
    value: policySchema,
    snapshot: z.string().min(1),
    create: z.boolean(),
  }),
]);

export type CatalogDraftRequest = z.infer<typeof catalogDraftRequestSchema>;
export type CatalogDraft = z.infer<typeof catalogDraftSchema>;
