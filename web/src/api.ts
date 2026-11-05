import { z } from 'zod';
import {
  sessionSchema,
  healthSchema,
  resourcesSchema,
  roomSchema,
  roomSummarySchema,
  roomDetailSchema,
  resultSchema,
} from '../../src/domain/http-contract.js';
import type { Product, Policy } from '../../src/domain/schema.js';
import type { ChatRequest } from '../../src/domain/schema.js';
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
