import { z } from 'zod';
import {
  shipmentResultSchema,
  shipmentHistorySchema,
  parcelTemplateViewSchema,
  parcelTemplateSchema,
  parcelSelectionSchema,
  parcelPreviewSchema,
  parcelCreateSchema,
  parcelExportSchema,
  type ShipmentCommand,
} from '../../src/domain/shipping.js';
import {
  savedOrderSchema,
  orderListSchema,
  type OrderEdit,
  type ConfirmOrder,
  type Reviewed,
} from '../../src/domain/commerce.js';
import { importPreviewSchema } from '../../src/domain/data-contract.js';
import {
  sessionSchema,
  healthSchema,
  resourcesSchema,
  roomSchema,
  roomSummarySchema,
  roomDetailSchema,
  resultSchema,
  type Resources,
} from '../../src/domain/http-contract.js';
import type { Product, Policy } from '../../src/domain/schema.js';
import type { ChatRequest } from '../../src/domain/schema.js';
import {
  batchListSchema,
  batchViewSchema,
  type CreateBatch,
} from '../../src/domain/batch.js';
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = 'NETWORK_ERROR',
  ) {
    super(message);
  }
}
async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  timeout = 15000,
  method = 'POST',
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...(body === undefined
        ? {}
        : {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new ApiError(
      '서버 응답을 확인하지 못했어요. 같은 요청으로 결과를 다시 확인해 주세요.',
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new ApiError('서버 응답 형식이 올바르지 않습니다.', response.status);
  }
  const parsed = schema.safeParse(raw);
  // Chat failures carry a persisted analysis even on HTTP 503/504.
  if (parsed.success) return parsed.data;
  const error = z
    .object({ error: z.object({ code: z.string(), message: z.string() }) })
    .safeParse(raw);
  throw new ApiError(
    error.success
      ? error.data.error.message
      : '서버 응답 형식을 확인해 주세요.',
    response.status,
    error.success ? error.data.error.code : 'INVALID_RESPONSE',
  );
}
export const api = {
  batches: () => request('/api/dm-batches', batchListSchema),
  batch: (id: string) => request(`/api/dm-batches/${id}`, batchViewSchema),
  createBatch: (body: CreateBatch) =>
    request('/api/dm-batches', batchViewSchema, body),
  processBatch: (
    id: string,
    itemId: string,
    requestId: string,
    retry: boolean,
    timeout: number,
  ) =>
    request(
      `/api/dm-batches/${id}/items/${itemId}/process`,
      batchViewSchema,
      { request_id: requestId, retry },
      timeout,
    ),
  session: () => request('/api/session', sessionSchema),
  login: (token: string) => request('/api/session', sessionSchema, { token }),
  health: () => request('/health', healthSchema),
  resources: () => request('/api/resources', resourcesSchema),
  updateProduct: (product: Product, snapshot: string) =>
    request(
      `/api/resources/products/${encodeURIComponent(product.product_id)}`,
      resourcesSchema,
      { product, snapshot_id: snapshot },
      15000,
      'PUT',
    ),
  updatePolicy: (policy: Policy, snapshot: string) =>
    request(
      `/api/resources/policies/${encodeURIComponent(policy.policy_id)}`,
      resourcesSchema,
      { policy, snapshot_id: snapshot },
      15000,
      'PUT',
    ),
  createProduct: (product: Product, snapshot: string) =>
    request('/api/resources/products', resourcesSchema, {
      product,
      snapshot_id: snapshot,
    }),
  createPolicy: (policy: Policy, snapshot: string) =>
    request('/api/resources/policies', resourcesSchema, {
      policy,
      snapshot_id: snapshot,
    }),
  deleteResource: (
    kind: 'products' | 'policies',
    id: string,
    snapshots: Reviewed,
  ) =>
    request(
      `/api/resources/${kind}/${encodeURIComponent(id)}`,
      resourcesSchema,
      { products: snapshots.products, policies: snapshots.policies },
      15000,
      'DELETE',
    ),
  shipmentHistory: (id: string) =>
    request(
      `/api/orders/${encodeURIComponent(id)}/shipments`,
      shipmentHistorySchema,
    ).then((r) => r.events),
  shipment: (id: string, input: ShipmentCommand) =>
    request(
      `/api/orders/${encodeURIComponent(id)}/shipments`,
      shipmentResultSchema,
      input,
    ),
  parcelTemplate: () =>
    request('/api/parcel/template', parcelTemplateViewSchema),
  saveParcelTemplate: (
    version: string,
    template: z.infer<typeof parcelTemplateSchema>,
  ) =>
    request(
      '/api/parcel/template',
      parcelTemplateViewSchema,
      { version, template },
      15000,
      'PUT',
    ),
  parcelPreview: (input: z.infer<typeof parcelSelectionSchema>) =>
    request('/api/parcel/preview', parcelPreviewSchema, input),
  parcelCreate: (input: z.infer<typeof parcelCreateSchema>) =>
    request('/api/parcel/exports', parcelExportSchema, input),
  parcelExports: () =>
    request(
      '/api/parcel/exports',
      z.object({ exports: z.array(parcelExportSchema) }),
    ).then((r) => r.exports),
  dataStats: () =>
    request(
      '/api/data/stats',
      z.object({
        products: z.number(),
        policies: z.number(),
        orders: z.number(),
        chats: z.number(),
      }),
    ),
  orders: () => request('/api/orders', orderListSchema).then((r) => r.orders),
  saveOrder: (request_id: string) =>
    request(
      '/api/orders/from-analysis',
      z.object({ order: savedOrderSchema }),
      { request_id },
    ).then((r) => r.order),
  updateOrder: (
    id: string,
    expected_version: number,
    reviewed_snapshots: Reviewed,
    draft: OrderEdit,
  ) =>
    request(
      `/api/orders/${encodeURIComponent(id)}`,
      z.object({ order: savedOrderSchema }),
      {
        expected_version,
        reviewed_snapshots: {
          products: reviewed_snapshots.products,
          policies: reviewed_snapshots.policies,
        },
        draft,
      },
      15000,
      'PUT',
    ).then((r) => r.order),
  confirmOrder: (id: string, input: ConfirmOrder) =>
    request(
      `/api/orders/${encodeURIComponent(id)}/confirm`,
      z.object({ order: savedOrderSchema }),
      input,
    ).then((r) => r.order),
  deleteOrder: (id: string, expected_version: number) =>
    request(
      `/api/orders/${encodeURIComponent(id)}`,
      orderListSchema,
      { expected_version },
      15000,
      'DELETE',
    ).then((r) => r.orders),
  resetData: (
    scope: 'catalog' | 'orders' | 'chats',
    snapshots: Resources['snapshots'],
  ) =>
    request(
      `/api/data/reset/${scope}`,
      z.object({ ok: z.boolean(), resources: resourcesSchema }),
      { confirm: '초기화', snapshots },
      30000,
    ),
  importApply: (token: string) =>
    request('/api/data/import/apply', resourcesSchema, { token }),
  importPreview: async (file: File) => {
    const response = await fetch('/api/data/import/preview', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      body: file,
      signal: AbortSignal.timeout(30000),
    });
    const raw: unknown = await response.json();
    const parsed = importPreviewSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const error = z
      .object({ error: z.object({ message: z.string() }) })
      .safeParse(raw);
    throw new ApiError(
      error.success ? error.data.error.message : '파일 분석에 실패했습니다.',
      response.status,
    );
  },
  rooms: () =>
    request(
      '/api/conversations',
      z.object({ conversations: z.array(roomSummarySchema) }),
    ).then((r) => r.conversations),
  room: (id: string) =>
    request(`/api/conversations/${encodeURIComponent(id)}`, roomDetailSchema),
  create: (handle: string, context: string) =>
    request('/api/conversations', z.object({ conversation: roomSchema }), {
      customer_handle: handle,
      context_label: context,
    }).then((r) => r.conversation),
  chat: (input: ChatRequest, timeout: number) =>
    request('/api/chat', resultSchema, input, timeout),
};
export type Api = typeof api;

export async function downloadParcel(id: string) {
  const response = await fetch(
    `/api/parcel/exports/${encodeURIComponent(id)}/file`,
    { credentials: 'same-origin', signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok) {
    const raw: unknown = await response.json();
    const error = z
      .object({ error: z.object({ message: z.string() }) })
      .safeParse(raw);
    throw new ApiError(
      error.success ? error.data.error.message : '파일을 내려받지 못했습니다.',
      response.status,
    );
  }
  const blob = await response.blob(),
    url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = `parcel-${id}.xlsx`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
