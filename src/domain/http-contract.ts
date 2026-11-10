import { z } from 'zod';
import { analysisSchema, productSchema, policySchema } from './schema.js';
export const executionSchema = z.object({
  run_id: z.string(),
  runtime: z.literal('flue'),
  model_calls: z.number().int(),
  tool_calls: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      success: z.boolean(),
      status: z.enum(['running', 'succeeded', 'failed']),
    }),
  ),
});
export const roomSchema = z.object({
  id: z.string(),
  seller_id: z.string(),
  customer_handle: z.string(),
  context_label: z.string(),
  created_at: z.string(),
});
export const messageSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  request_id: z.string(),
  role: z.enum(['customer', 'assistant']),
  text: z.string(),
  created_at: z.string(),
});
export const extractionFieldSchema = z.enum([
  'order_draft.recipient.name',
  'order_draft.recipient.phone_raw',
  'order_draft.recipient.address_raw',
  'order_draft.recipient.postal_code',
  'order_draft.depositor_name',
  'payment_claim.depositor_name',
]);
const extractionSourceSchema = z
  .object({
    field: extractionFieldSchema,
    message_id: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .refine(({ start, end }) => start < end);
export const resultSchema = z.object({
  conversation_id: z.string(),
  replayed: z.boolean(),
  analysis: analysisSchema,
  execution: executionSchema.optional(),
});
export const latestSchema = z.object({
  request_id: z.string(),
  text: z.string(),
  status: z.enum(['received', 'running', 'succeeded', 'failed']),
  expires_at: z.string().nullable(),
  snapshots: z
    .object({ products: z.string(), policies: z.string(), orders: z.string() })
    .nullable()
    .optional(),
  http_status: z.number().nullable(),
  analysis: analysisSchema.nullable(),
  execution: executionSchema.nullable(),
});
export const roomDetailSchema = z.object({
  conversation: roomSchema,
  messages: z.array(messageSchema),
  latest: latestSchema.nullable(),
  extraction_sources: z.array(extractionSourceSchema).optional(),
});
export const roomSummarySchema = roomSchema.extend({
  latest: latestSchema
    .omit({ text: true, analysis: true, execution: true, snapshots: true })
    .extend({
      preview: z.string(),
      analysis_status: analysisSchema.shape.status.nullable(),
      classification: analysisSchema.shape.classification,
      priority: z.enum(['normal', 'high']),
    })
    .nullable(),
});
export const resourcesSchema = z.object({
  products: z.array(productSchema),
  policies: z.array(policySchema),
  snapshots: z.object({
    products: z.string(),
    policies: z.string(),
    orders: z.string(),
  }),
});
export const healthSchema = z.object({
  status: z.string(),
  model_configured: z.boolean(),
  model_status: z.string().nullable(),
  agent_backend: z.string(),
  agent_model: z.string(),
  typesafe_configured: z.boolean(),
  agent_timeout_ms: z.number(),
  sqlite: z.boolean(),
});
export const sessionSchema = z.object({
  authenticated: z.boolean(),
  authentication_required: z.boolean(),
  method: z.enum(['none', 'bearer', 'session']).nullable(),
});
export type ExecutionView = z.infer<typeof executionSchema>;
export type ChatResult = z.infer<typeof resultSchema>;
export type RoomDetail = z.infer<typeof roomDetailSchema>;
export type ExtractionField = z.infer<typeof extractionFieldSchema>;
export type ExtractionSource = z.infer<typeof extractionSourceSchema>;
export type RoomSummary = z.infer<typeof roomSummarySchema>;
export type Resources = z.infer<typeof resourcesSchema>;
export type Health = z.infer<typeof healthSchema>;
export type Session = z.infer<typeof sessionSchema>;

export const productUpdateSchema = z
  .object({ snapshot_id: z.string().min(1).max(100), product: productSchema })
  .strict();
export const policyUpdateSchema = z
  .object({ snapshot_id: z.string().min(1).max(100), policy: policySchema })
  .strict();
