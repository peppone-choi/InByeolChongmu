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
import { roomDetail, roomSummary } from './room-view.js';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError } from '../domain/errors.js';
import type { AgentRunner } from '../agent/types.js';
import { ChatService } from '../agent/service.js';
import { Store } from '../storage/store.js';
import { Tools, toolCatalog } from '../tools/registry.js';
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
  const authenticated = (request: Request, cookie: string | undefined) =>
    sessions.authenticate(
      request.headers.get('Authorization') ?? undefined,
      cookie,
    );
  const chat = new ChatService(store, config, options.runner, options.clock);
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
    if (origin && origin !== url.origin)
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
    await next();
  });
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 65536,
      onError: () => {
        throw new AppError(
          'BODY_TOO_LARGE',
          '요청 본문은 최대 64 KiB입니다.',
          413,
        );
      },
    }),
  );
  app.use('/api/*', async (c, next) => {
    if (
      ['POST', 'PUT'].includes(c.req.method) &&
      !/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')
    )
      throw new AppError(
        'JSON_REQUIRED',
        'application/json 본문이 필요합니다.',
        415,
      );
    await next();
  });
  app.get('/api/session', (c) =>
    c.json({
      authenticated:
        authenticated(c.req.raw, getCookie(c, sessionCookie)) !== null,
      authentication_required: !!config.apiToken,
      method: authenticated(c.req.raw, getCookie(c, sessionCookie)),
    }),
  );
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
      secure: new URL(c.req.url).protocol === 'https:',
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
    deleteCookie(c, sessionCookie, { path: '/' });
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
    const result = await chat.receive(await parseJson(c.req.raw));
    return c.json(result.body, result.httpStatus);
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
