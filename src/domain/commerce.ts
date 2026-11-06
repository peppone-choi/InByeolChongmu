import { z } from 'zod';
import { amountSchema, orderSchema } from './schema.js';
const text = z.string().trim().max(2000).nullable();
const short = z.string().trim().max(100).nullable();
export const reviewedSchema = z
  .object({ products: z.string(), policies: z.string() })
  .strict();
export const orderEditSchema = z
  .object({
    recipient: z
      .object({
        name: short,
        phone_raw: short,
        address_raw: text,
        postal_code: short,
      })
      .strict(),
    depositor_name: short,
    items: z
      .array(
        z
          .object({
            sku: z.string().trim().min(1).max(100).nullable(),
            quantity: z.number().int().min(1).max(10000).nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const savedOrderSchema = orderEditSchema.extend({
  order_id: z.string(),
  customer_handle: z.string(),
  status: orderSchema.shape.status,
  version: z.number().int().positive(),
  amounts: amountSchema.nullable(),
  issues: z.array(z.string()),
  item_labels: z.array(z.string()),
  item_prices: z.array(z.number().int().min(0).max(1e9).nullable()),
  reviewed_snapshots: reviewedSchema,
  created_at: z.string(),
  confirmed_at: z.string().nullable(),
  origin_request_id: z.string().nullable(),
  conversation_id: z.string().nullable(),
  historical: z.boolean(),
  carrier: z.string().nullable(),
  tracking_number: z.string().nullable(),
  shipped_at: z.string().nullable(),
  payment: z
    .object({
      checked_at: z.string(),
      actor: z.string(),
      amount_krw: z.number(),
      depositor_name: z.string(),
      address_acknowledged: z.literal(true),
    })
    .nullable(),
});
export const saveOrderSchema = z
  .object({ request_id: z.string().min(1).max(100) })
  .strict();
export const updateOrderSchema = z
  .object({
    expected_version: z.number().int().positive(),
    reviewed_snapshots: reviewedSchema,
    draft: orderEditSchema,
  })
  .strict();
export const confirmOrderSchema = z
  .object({
    command_id: z.uuid(),
    expected_version: z.number().int().positive(),
    reviewed_snapshots: reviewedSchema,
    payment_checked: z.literal(true),
    checked_amount_krw: z.number().int().min(0).max(1e9),
    checked_depositor_name: z.string().trim().min(1).max(100),
    address_acknowledged: z.literal(true),
  })
  .strict();
export const orderListSchema = z.object({ orders: z.array(savedOrderSchema) });
export type SavedOrder = z.infer<typeof savedOrderSchema>;
export type OrderEdit = z.infer<typeof orderEditSchema>;
export type ConfirmOrder = z.infer<typeof confirmOrderSchema>;
export type Reviewed = z.infer<typeof reviewedSchema>;
