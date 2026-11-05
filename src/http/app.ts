import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
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
    if (config.apiToken) {
      const expected = Buffer.from('Bearer ' + config.apiToken),
        provided = Buffer.from(c.req.header('Authorization') ?? '');
      if (
        expected.length !== provided.length ||
        !timingSafeEqual(expected, provided)
      )
        throw new AppError('UNAUTHORIZED', '인증이 필요합니다.', 401);
    }
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
      c.req.method === 'POST' &&
      !/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')
    )
      throw new AppError(
        'JSON_REQUIRED',
        'application/json 본문이 필요합니다.',
        415,
      );
    await next();
  });
  app.get('/health', (c) =>
    c.json({
      status: 'data_ready',
      model_configured: chat.runner.readiness().ready,
      model_status: chat.runner.readiness().code,
      agent_backend: config.agentBackend,
      sqlite: true,
    }),
  );
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
      conversations: store.conversations(config.sellerId, handle),
    });
  });
  app.get('/api/conversations/:id/messages', (c) =>
    c.json({ messages: store.messages(config.sellerId, c.req.param('id')) }),
  );
  app.post('/api/chat', async (c) => {
    const result = await chat.receive(await parseJson(c.req.raw));
    return c.json(result.body, result.httpStatus);
  });
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
