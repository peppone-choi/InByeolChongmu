import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BrowserSessions, sessionCookie, sessionTtl } from './session.js';
import {
  productUpdateSchema,
  policyUpdateSchema,
} from '../domain/http-contract.js';
import {
  saveOrderSchema,
  updateOrderSchema,
  confirmOrderSchema,
  reviewedSchema,
} from '../domain/commerce.js';
import {
  WorkbookImports,
  exportCurrentWorkbook,
} from '../storage/data-workbook.js';
import {
  shipmentImportRequestSchema,
  shipmentCommandSchema,
  parcelTemplateSchema,
  parcelSelectionSchema,
  parcelCreateSchema,
} from '../domain/shipping.js';
import { replyTemplateSchema } from '../domain/reply-template.js';
import {
  previewShipments,
  shipmentWorkbookTemplate,
} from '../storage/shipment-workbook.js';
import { roomDetail, roomSummary } from './room-view.js';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError } from '../domain/errors.js';
import { catalogDraftRequestSchema } from '../domain/catalog-draft.js';
import { createCatalogDrafter } from '../agent/catalog-draft.js';
import type { AgentRunner } from '../agent/types.js';
import { ChatService } from '../agent/service.js';
import { BatchService } from '../agent/batch-service.js';
import {
  createBatchSchema,
  maxBatchBytes,
  processBatchItemSchema,
} from '../domain/batch.js';
import { Store } from '../storage/store.js';
import { Tools, toolCatalog } from '../tools/registry.js';
const resourcesSchemaForReset = reviewedSchema
  .extend({ orders: z.string() })
  .strict();
export function createApp(
  store: Store,
  config: Config,
  options: {
    maxRequests?: number;
    runner?: AgentRunner;
    clock?: () => Date;
  } = {},
) {
  const app = new Hono();
  const sessions = new BrowserSessions(config.apiToken);
  const browserOrigin = (url: URL) =>
    url.host === config.publicHostname ? 'https://' + url.host : url.origin;
  const authenticated = (request: Request, cookie: string | undefined) => {
    if (
      config.publicAccess &&
      new URL(request.url).host === config.publicHostname
    )
      return 'none';
    return sessions.authenticate(
      request.headers.get('Authorization') ?? undefined,
      cookie,
    );
  };
  const chat = new ChatService(store, config, options.runner, options.clock);
  const batches = new BatchService(store.batches, chat, config.sellerId);
  const imports = new WorkbookImports(store);
  const draftCatalog = createCatalogDrafter(store, config);
  let maintenance = false;
  const requireWritable = () => {
    if (maintenance)
      throw new AppError(
        'MAINTENANCE',
        '초기화 중입니다. 잠시 뒤 다시 시도하세요.',
        409,
      );
  };
  let windowStart = Date.now(),
    requests = 0;
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const url = new URL(c.req.url);
    if (
      config.deployment === 'local' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
      throw new AppError(
        'LOCAL_ONLY',
        '현재 서버는 로컬 접근만 지원합니다.',
        403,
      );
    const origin = c.req.header('Origin');
    if (origin && origin !== browserOrigin(url))
      throw new AppError(
        'ORIGIN_NOT_ALLOWED',
        '다른 출처의 요청은 허용하지 않습니다.',
        403,
      );
    const path = c.req.path;
    if (
      (path.startsWith('/api/') || path === '/health') &&
      path !== '/api/session' &&
      !authenticated(c.req.raw, getCookie(c, sessionCookie))
    )
      throw new AppError('UNAUTHORIZED', '연결 인증이 필요합니다.', 401);
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (++requests > (options.maxRequests ?? 120))
      throw new AppError(
        'RATE_LIMITED',
        '로컬 요청 한도를 초과했습니다.',
        429,
        true,
      );
    if (c.req.method !== 'GET') requireWritable();
    await next();
  });
  app.use('/api/*', async (c, next) =>
    bodyLimit({
      maxSize: workbookUploadPaths.has(c.req.path)
        ? 2 * 1024 * 1024
        : c.req.path === '/api/shipment-import/apply'
          ? 256 * 1024
          : maxBatchBytes,
      onError: () => {
        throw new AppError(
          'BODY_TOO_LARGE',
          '요청 크기 제한을 초과했습니다. 엑셀 파일은 최대 2 MiB입니다.',
          413,
        );
      },
    })(c, next),
  );
  app.use('/api/*', async (c, next) => {
    if (
      !workbookUploadPaths.has(c.req.path) &&
      ['POST', 'PUT', 'DELETE'].includes(c.req.method) &&
      c.req.path !== '/api/session' &&
      !/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')
    )
      throw new AppError(
        'JSON_REQUIRED',
        'application/json 본문이 필요합니다.',
        415,
      );
    await next();
  });
  app.get('/api/session', (c) => {
    const method = authenticated(c.req.raw, getCookie(c, sessionCookie));
    return c.json({
      authenticated: method !== null,
      authentication_required: method !== 'none',
      method,
    });
  });
  app.post('/api/session', async (c) => {
    const { token } = z
      .object({ token: z.string().min(1).max(1024) })
      .strict()
      .parse(await parseJson(c.req.raw));
    if (!sessions.verifyToken(token))
      throw new AppError('UNAUTHORIZED', '연결 암호가 맞지 않습니다.', 401);
    setCookie(c, sessionCookie, sessions.create(), {
      httpOnly: true,
      sameSite: 'Strict',
      secure: browserOrigin(new URL(c.req.url)).startsWith('https://'),
      path: '/',
      maxAge: sessionTtl,
    });
    return c.json({
      authenticated: true,
      authentication_required: true,
      method: 'session',
    });
  });
  app.delete('/api/session', (c) => {
    sessions.delete(getCookie(c, sessionCookie));
    deleteCookie(c, sessionCookie, {
      path: '/',
      secure: browserOrigin(new URL(c.req.url)).startsWith('https://'),
    });
    return c.body(null, 204);
  });
  app.get('/health', (c) =>
    c.json({
      status: 'data_ready',
      model_configured: chat.runner.readiness().ready,
      model_status: chat.runner.readiness().code,
      agent_backend: config.agentBackend,
      sqlite: true,
      agent_model: config.agentModel,
      typesafe_configured: config.credentials.jev,
      agent_timeout_ms: config.agentTimeoutMs,
    }),
  );
  const resources = () => ({
    products: store.products(config.sellerId),
    policies: store.policies(config.sellerId),
    snapshots: {
      products: store.source(config.sellerId, 'product').snapshot_id,
      policies: store.source(config.sellerId, 'policy').snapshot_id,
      orders: store.source(config.sellerId, 'order').snapshot_id,
    },
  });
  app.get('/api/resources', (c) => c.json(resources()));
  app.get('/api/reply-template', (c) =>
    c.json({ template: store.replyTemplate(config.sellerId) }),
  );
  app.put('/api/reply-template', async (c) => {
    const input = replyTemplateSchema.parse(await parseJson(c.req.raw));
    store.saveReplyTemplate(config.sellerId, input.template);
    return c.json(input);
  });
  app.get('/api/shipment-import/template', async (c) => {
    c.header('Content-Type', workbookMime);
    c.header(
      'Content-Disposition',
      'attachment; filename="shipment-import.xlsx"',
    );
    return c.body(new Uint8Array(await shipmentWorkbookTemplate()));
  });
  app.post('/api/shipment-import/preview', async (c) => {
    requireWorkbook(c.req.header('Content-Type'));
    return c.json(
      await previewShipments(
        store.commerce,
        config.sellerId,
        Buffer.from(await c.req.arrayBuffer()),
        options.clock?.(),
      ),
    );
  });
  app.post('/api/shipment-import/apply', async (c) => {
    const { entries } = shipmentImportRequestSchema.parse(
      await parseJson(c.req.raw),
    );
    return c.json(
      store.commerce.importShipments(
        config.sellerId,
        entries,
        options.clock?.(),
      ),
    );
  });
  app.post('/api/resources/draft', async (c) =>
    c.json(
      await draftCatalog(
        catalogDraftRequestSchema.parse(await parseJson(c.req.raw)),
        c.req.raw.signal,
      ),
    ),
  );
  app.put('/api/resources/products/:id', async (c) => {
    const input = productUpdateSchema.parse(await parseJson(c.req.raw));
    store.updateProduct(
      config.sellerId,
      c.req.param('id'),
      input.snapshot_id,
      input.product,
    );
    return c.json(resources());
  });
  app.put('/api/resources/policies/:id', async (c) => {
    const input = policyUpdateSchema.parse(await parseJson(c.req.raw));
    store.updatePolicy(
      config.sellerId,
      c.req.param('id'),
      input.snapshot_id,
      input.policy,
    );
    return c.json(resources());
  });
  app.post('/api/resources/products', async (c) => {
    const input = productUpdateSchema.parse(await parseJson(c.req.raw));
    store.createProduct(config.sellerId, input.snapshot_id, input.product);
    return c.json(resources(), 201);
  });
  app.post('/api/resources/policies', async (c) => {
    const input = policyUpdateSchema.parse(await parseJson(c.req.raw));
    store.createPolicy(config.sellerId, input.snapshot_id, input.policy);
    return c.json(resources(), 201);
  });
  app.delete('/api/resources/:kind/:id', async (c) => {
    const kind = z.enum(['products', 'policies']).parse(c.req.param('kind'));
    const snapshots = reviewedSchema.parse(await parseJson(c.req.raw));
    store.deleteResource(
      config.sellerId,
      kind === 'products' ? 'product' : 'policy',
      c.req.param('id'),
      snapshots,
    );
    return c.json(resources());
  });
  app.get('/api/orders', (c) =>
    c.json({ orders: store.commerce.list(config.sellerId) }),
  );
  app.post('/api/orders/from-analysis', async (c) => {
    const input = saveOrderSchema.parse(await parseJson(c.req.raw));
    return c.json(
      {
        order: store.commerce.saveAnalysis(
          config.sellerId,
          input.request_id,
          options.clock?.(),
        ),
      },
      201,
    );
  });
  app.put('/api/orders/:id', async (c) => {
    const input = updateOrderSchema.parse(await parseJson(c.req.raw));
    return c.json({
      order: store.commerce.update(
        config.sellerId,
        c.req.param('id'),
        input.expected_version,
        input.reviewed_snapshots,
        input.draft,
        options.clock?.(),
      ),
    });
  });
  app.post('/api/orders/:id/confirm', async (c) => {
    const input = confirmOrderSchema.parse(await parseJson(c.req.raw));
    return c.json({
      order: store.commerce.confirm(
        config.sellerId,
        c.req.param('id'),
        input,
        options.clock?.(),
      ),
    });
  });
  app.delete('/api/orders/:id', async (c) => {
    const { expected_version } = z
      .object({ expected_version: z.number().int().positive() })
      .strict()
      .parse(await parseJson(c.req.raw));
    store.commerce.remove(config.sellerId, c.req.param('id'), expected_version);
    return c.json({ orders: store.commerce.list(config.sellerId) });
  });
  app.get('/api/orders/:id/shipments', (c) =>
    c.json({
      events: store.commerce.shipmentHistory(
        config.sellerId,
        c.req.param('id'),
      ),
    }),
  );
  app.post('/api/orders/:id/shipments', async (c) =>
    c.json(
      store.commerce.shipment(
        config.sellerId,
        c.req.param('id'),
        shipmentCommandSchema.parse(await parseJson(c.req.raw)),
        options.clock?.(),
      ),
    ),
  );
  app.get('/api/parcel/template', (c) =>
    c.json(store.parcels.template(config.sellerId)),
  );
  app.put('/api/parcel/template', async (c) => {
    const input = z
      .object({ version: z.string(), template: parcelTemplateSchema })
      .strict()
      .parse(await parseJson(c.req.raw));
    return c.json(
      store.parcels.saveTemplate(
        config.sellerId,
        input.version,
        input.template,
      ),
    );
  });
  app.post('/api/parcel/preview', async (c) =>
    c.json(
      store.parcels.preview(
        config.sellerId,
        parcelSelectionSchema.parse(await parseJson(c.req.raw)),
      ),
    ),
  );
  app.post('/api/parcel/exports', async (c) =>
    c.json(
      store.parcels.create(
        config.sellerId,
        parcelCreateSchema.parse(await parseJson(c.req.raw)),
        options.clock?.(),
      ),
      201,
    ),
  );
  app.get('/api/parcel/exports', (c) =>
    c.json({ exports: store.parcels.list(config.sellerId) }),
  );
  app.get('/api/parcel/exports/:id/file', async (c) => {
    const bytes = await store.parcels.download(
      config.sellerId,
      c.req.param('id'),
    );
    c.header(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    c.header(
      'Content-Disposition',
      `attachment; filename="parcel-${c.req.param('id').replace(/[^a-zA-Z0-9-]/g, '')}.xlsx"`,
    );
    return c.body(new Uint8Array(bytes));
  });
  app.get('/api/data/stats', (c) => c.json(store.dataStats(config.sellerId)));
  app.get('/api/data/export', async (c) => {
    const format = z
      .enum(['json', 'xlsx'])
      .parse(c.req.query('format') ?? 'xlsx');
    c.header(
      'Content-Disposition',
      `attachment; filename="inbyeol-data.${format}"`,
    );
    if (format === 'json') return c.json(store.exportCurrent(config.sellerId));
    c.header(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    return c.body(
      new Uint8Array(await exportCurrentWorkbook(store, config.sellerId)),
    );
  });
  app.post('/api/data/import/preview', async (c) => {
    requireWorkbook(c.req.header('Content-Type'));
    return c.json(
      await imports.preview(
        config.sellerId,
        Buffer.from(await c.req.arrayBuffer()),
      ),
    );
  });
  app.post('/api/data/import/apply', async (c) => {
    const { token } = z
      .object({ token: z.uuid() })
      .strict()
      .parse(await parseJson(c.req.raw));
    imports.apply(config.sellerId, token);
    return c.json(resources());
  });
  app.post('/api/data/reset/:scope', async (c) => {
    const scope = z
      .enum(['catalog', 'orders', 'chats'])
      .parse(c.req.param('scope'));
    const input = z
      .object({
        confirm: z.literal('초기화'),
        snapshots: resourcesSchemaForReset,
      })
      .strict()
      .parse(await parseJson(c.req.raw));
    if (batches.busy || store.hasRunning(config.sellerId))
      throw new AppError('AGENT_BUSY', '분석이 끝난 뒤 초기화하세요.', 409);
    if (scope === 'catalog')
      store.resetCatalog(config.sellerId, input.snapshots);
    if (scope === 'orders')
      store.commerce.reset(config.sellerId, input.snapshots.orders);
    if (scope === 'chats') {
      if (!chat.runner.resetHistory)
        throw new AppError(
          'RESET_UNAVAILABLE',
          '실행기의 기록 초기화가 지원되지 않습니다.',
          503,
        );
      maintenance = true;
      try {
        await chat.runner.resetHistory();
        store.resetChats(config.sellerId);
      } finally {
        maintenance = false;
      }
    }
    imports.clear();
    return c.json({ ok: true, resources: resources() });
  });
  app.get('/api/tools', (c) => c.json({ tools: toolCatalog() }));
  app.post('/api/tools/:name', async (c) => {
    const envelope = z
      .object({
        arguments: z.record(z.string(), z.unknown()),
        conversation_id: z.uuid().optional(),
      })
      .strict()
      .parse(await parseJson(c.req.raw));
    const room = envelope.conversation_id
      ? store.conversation(config.sellerId, envelope.conversation_id)
      : undefined;
    const tools = new Tools(
      store,
      config.sellerId,
      config.root,
      () => new Date(),
      room?.customer_handle,
    );
    return c.json({
      result: tools.call(c.req.param('name'), envelope.arguments),
    });
  });
  app.post('/api/conversations', async (c) => {
    const input = z
      .object({
        customer_handle: z.string().trim().min(1).max(100),
        context_label: z.string().trim().max(200).default(''),
      })
      .strict()
      .parse(await parseJson(c.req.raw));
    return c.json(
      {
        conversation: store.createConversation(
          config.sellerId,
          input.customer_handle,
          input.context_label,
        ),
      },
      201,
    );
  });
  app.get('/api/conversations', (c) => {
    const handle = c.req.query('customer_handle');
    if (handle && handle.length > 100)
      throw new AppError('INVALID_INPUT', '고객 아이디가 너무 깁니다.');
    return c.json({
      conversations: store
        .conversations(config.sellerId, handle)
        .map((room) => roomSummary(store, config.sellerId, room.id)),
    });
  });
  app.get('/api/conversations/:id', (c) =>
    c.json(roomDetail(store, config.sellerId, c.req.param('id'))),
  );
  app.get('/api/conversations/:id/messages', (c) =>
    c.json({ messages: store.messages(config.sellerId, c.req.param('id')) }),
  );
  app.post('/api/chat', async (c) => {
    const body = await parseJson(c.req.raw);
    requireWritable();
    const result = await chat.receive(body);
    return c.json(result.body, result.httpStatus);
  });
  app.get('/api/dm-batches', (c) =>
    c.json({ batches: store.batches.list(config.sellerId) }),
  );
  app.post('/api/dm-batches', async (c) => {
    const body = createBatchSchema.parse(await parseJson(c.req.raw));
    requireWritable();
    return c.json(store.batches.create(config.sellerId, body));
  });
  app.get('/api/dm-batches/:id', (c) =>
    c.json(
      store.batches.get(config.sellerId, z.uuid().parse(c.req.param('id'))),
    ),
  );
  app.post('/api/dm-batches/:id/items/:itemId/process', async (c) => {
    const { request_id, retry } = processBatchItemSchema.parse(
      await parseJson(c.req.raw),
    );
    requireWritable();
    return c.json(
      await batches.process(
        z.uuid().parse(c.req.param('id')),
        z.uuid().parse(c.req.param('itemId')),
        request_id,
        retry,
      ),
    );
  });
  const webRoot = resolve(config.root, 'dist/web');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    app.use('/assets/*', async (c, next) => {
      c.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
      );
      await next();
    });
    app.get('/assets/*', serveStatic({ root: webRoot }));
    app.get('/', async (c) => {
      c.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
      );
      c.header('Referrer-Policy', 'no-referrer');
      return serveStatic({ root: webRoot, path: 'index.html' })(
        c,
        async () => {},
      );
    });
  }
  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: '경로를 찾을 수 없습니다.',
          retryable: false,
        },
      },
      404,
    ),
  );
  app.onError((error, c) => {
    const safe =
      error instanceof AppError
        ? error
        : error instanceof z.ZodError
          ? new AppError('INVALID_INPUT', '요청 형식을 확인하세요.')
          : new AppError('INTERNAL_ERROR', '처리 중 오류가 발생했습니다.', 500);
    return c.json(
      {
        error: {
          code: safe.code,
          message: safe.message,
          retryable: safe.retryable,
        },
      },
      safe.status,
    );
  });
  return app;
}
async function parseJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new AppError('INVALID_JSON', 'JSON 형식이 올바르지 않습니다.', 400);
  }
}

const workbookMime =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const workbookUploadPaths = new Set([
  '/api/data/import/preview',
  '/api/shipment-import/preview',
]);
function requireWorkbook(contentType: string | undefined) {
  if (contentType?.split(';')[0]?.trim().toLowerCase() !== workbookMime)
    throw new AppError('XLSX_REQUIRED', '.xlsx 파일을 선택하세요.', 415);
}
