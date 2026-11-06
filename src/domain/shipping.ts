import { z } from 'zod';
import { savedOrderSchema } from './commerce.js';
const shipmentFields = {
  carrier: z.string().trim().min(1).max(100),
  tracking_number: z
    .string()
    .transform((s) => s.replace(/\s/g, ''))
    .pipe(z.string().min(1).max(100)),
  shipped_at: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s).toISOString()),
};
const commandFields = {
  command_id: z.string().trim().min(1).max(100),
  expected_version: z.number().int().positive(),
  ...shipmentFields,
};
export const shipmentCommandSchema = z.discriminatedUnion('operation', [
  z
    .object({ ...commandFields, operation: z.literal('register_shipment') })
    .strict(),
  z
    .object({
      ...commandFields,
      operation: z.literal('update_shipment'),
      correction_reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);
export const shipmentValueSchema = z.object({
  carrier: z.string().nullable(),
  tracking_number: z.string().nullable(),
  shipped_at: z.string().nullable(),
});
export const shipmentEventSchema = z.object({
  event_id: z.string(),
  command_id: z.string(),
  order_id: z.string(),
  operation: z.enum(['register_shipment', 'update_shipment']),
  version: z.number(),
  actor: z.string(),
  recorded_at: z.string(),
  correction_reason: z.string().nullable(),
  before: shipmentValueSchema,
  after: shipmentValueSchema,
});
export const shipmentResultSchema = z.object({
  order_id: z.string(),
  status: z.literal('shipped'),
  version: z.number().int().positive(),
  command_id: z.string(),
  order: savedOrderSchema,
  replayed: z.boolean(),
  event: shipmentEventSchema,
});
export const shipmentHistorySchema = z.object({
  events: z.array(shipmentEventSchema),
});
export type ShipmentCommand = z.infer<typeof shipmentCommandSchema>;
export type ShipmentEvent = z.infer<typeof shipmentEventSchema>;

export const parcelFields = [
  'order_id',
  'recipient_name',
  'phone',
  'postal_code',
  'address',
  'item_summary',
  'total_krw',
  'shipping_memo',
] as const;
export const parcelFieldSchema = z.enum(parcelFields);
export const parcelTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    sheet_name: z
      .string()
      .trim()
      .min(1)
      .max(31)
      .refine(
        (s) =>
          !/[\\/?*[\]:]/.test(s) &&
          Array.from(s).every(
            (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
          ) &&
          !s.startsWith("'") &&
          !s.endsWith("'") &&
          s.toLowerCase() !== 'history',
        '시트 이름에 특수문자를 사용할 수 없습니다.',
      ),
    columns: z
      .array(
        z
          .object({
            field: parcelFieldSchema,
            header: z.string().trim().min(1).max(100),
            required: z.boolean(),
          })
          .strict(),
      )
      .min(3)
      .max(8),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (
      new Set(t.columns.map((c) => c.field)).size !== t.columns.length ||
      new Set(t.columns.map((c) => c.header)).size !== t.columns.length
    )
      ctx.addIssue({
        code: 'custom',
        message: '필드와 열 이름은 중복될 수 없습니다.',
      });
    for (const field of ['recipient_name', 'phone', 'address'])
      if (!t.columns.some((c) => c.field === field && c.required))
        ctx.addIssue({
          code: 'custom',
          message: '수령인·연락처·주소는 필수 열입니다.',
        });
  });
export const defaultParcelTemplate = {
  name: '공통 발송명단',
  sheet_name: '발송명단',
  columns: parcelFields.map((field, i) => ({
    field,
    header: [
      '주문번호',
      '받는 분',
      '연락처',
      '우편번호',
      '주소',
      '상품명·수량',
      '주문금액',
      '배송메모',
    ][i]!,
    required: ['recipient_name', 'phone', 'address'].includes(field),
  })),
};
export const parcelTemplateViewSchema = z.object({
  version: z.string(),
  template: parcelTemplateSchema,
});
export const parcelSelectionSchema = z
  .object({
    template_version: z.string(),
    order_ids: z.array(z.string().min(1).max(100)).min(1).max(500),
    notes: z.record(z.string(), z.string().trim().max(500)).default({}),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (
      new Set(s.order_ids).size !== s.order_ids.length ||
      Object.keys(s.notes).some((id) => !s.order_ids.includes(id))
    )
      ctx.addIssue({
        code: 'custom',
        message: '주문 선택 또는 배송메모의 대상을 확인하세요.',
      });
  });
export const parcelRowSchema = z.object({
  order_id: z.string(),
  recipient_name: z.string(),
  phone: z.string(),
  postal_code: z.string(),
  address: z.string(),
  item_summary: z.string(),
  total_krw: z.number().int(),
  shipping_memo: z.string(),
});
export const parcelPreviewSchema = z.object({
  fingerprint: z.string(),
  template: parcelTemplateViewSchema,
  rows: z.array(parcelRowSchema),
  included_order_ids: z.array(z.string()),
  excluded: z.array(z.object({ order_id: z.string(), reason: z.string() })),
  previous_exports: z.array(
    z.object({
      order_id: z.string(),
      count: z.number(),
      last_exported_at: z.string(),
    }),
  ),
});
export const parcelExportSchema = z.object({
  export_id: z.string(),
  command_id: z.string(),
  created_at: z.string(),
  template_version: z.string(),
  template_name: z.string(),
  included_order_ids: z.array(z.string()),
  excluded: parcelPreviewSchema.shape.excluded,
  download_available: z.boolean(),
  replayed: z.boolean().optional(),
});
export const parcelCreateSchema = parcelSelectionSchema.safeExtend({
  command_id: z.uuid(),
  fingerprint: z.string().min(1),
  acknowledge_repeat: z.boolean(),
});
export type ParcelTemplate = z.infer<typeof parcelTemplateSchema>;
export type ParcelSelection = z.infer<typeof parcelSelectionSchema>;
export type ParcelPreview = z.infer<typeof parcelPreviewSchema>;
export type ParcelExport = z.infer<typeof parcelExportSchema>;
