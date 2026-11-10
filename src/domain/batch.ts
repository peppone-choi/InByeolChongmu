import { z } from 'zod';
import { analysisSchema } from './schema.js';

export const maxBatchItems = 10;
export const maxBatchBytes = 65536;
export const batchEntrySchema = z
  .object({
    customer_handle: z.string().trim().max(100),
    context_label: z.string().trim().max(200),
    text: z.string().max(20000),
  })
  .strict();
export const createBatchSchema = z
  .object({
    batch_id: z.uuid(),
    items: z.array(batchEntrySchema).min(1).max(maxBatchItems),
  })
  .strict();
export const processBatchItemSchema = z
  .object({
    request_id: z.uuid(),
    retry: z.boolean().default(false),
  })
  .strict();

export const batchOutcomeSchema = z.object({
  classification: analysisSchema.shape.classification,
  analysis_status: analysisSchema.shape.status.nullable(),
  needs_attention: z.boolean(),
  error: z
    .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
    .nullable(),
});
export const batchItemSchema = batchEntrySchema.extend({
  item_id: z.uuid(),
  request_id: z.uuid(),
  conversation_id: z.uuid().nullable(),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  outcome: batchOutcomeSchema.nullable(),
});
export const batchSummarySchema = z.object({
  batch_id: z.uuid(),
  created_at: z.iso.datetime(),
  total: z.number().int(),
  completed: z.number().int(),
  failed: z.number().int(),
});
export const batchListSchema = z.object({
  batches: z.array(batchSummarySchema),
});
export const batchViewSchema = batchSummarySchema.extend({
  items: z.array(batchItemSchema),
});

export type BatchEntry = z.infer<typeof batchEntrySchema>;
export type CreateBatch = z.infer<typeof createBatchSchema>;
export type BatchItem = z.infer<typeof batchItemSchema>;
export type BatchView = z.infer<typeof batchViewSchema>;
export type BatchOutcome = z.infer<typeof batchOutcomeSchema>;
