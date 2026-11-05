import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Tools } from '../src/tools/registry.js';
import { validateAnalysis } from '../src/agent/validate-analysis.js';
import { readConfig, providerEnvironment } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { emptyAnalysis, type Analysis } from '../src/domain/schema.js';
import { classifyWithTypesafe, categories } from '../src/agent/typesafe.js';
import type { AgentRunner } from '../src/agent/types.js';
const root = process.cwd(),
  seller = 'sample-seller-01',
  now = new Date('2026-11-05T00:00:00Z');
const config = () =>
  readConfig(root, {
    NODE_ENV: 'test',
    APP_DEPLOYMENT: 'local',
    DATABASE_PATH: ':memory:',
    AGENT_BACKEND: 'disabled',
    LOCAL_API_TOKEN: '',
    OPENAI_API_KEY: '',
    TYPESAFE_API_KEY: '',
  });
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
function fixture(path = ':memory:') {
  const store = new Store(path);
  store.seedSamples(root, seller);
  const room = store.createConversation(seller, '@sample.hana', '테스트');
  store.receive(seller, {
    requestId: 'test',
    conversationId: room.id,
    handle: '@sample.hana',
    text: '니트 베이지 한 개, 크림 한 개. 샘플하나 010-0000-1001 가상시 예시구 테스트로 101 샘플동 202호. 입금자 샘플하나. 입금했어요.',
    attachments: [],
  });
  const run = store.beginRun(
    seller,
    'test',
    { messages: 40, characters: 40000 },
    now,
  );
  return { store, room, run };
}
test('validation requires real lookup/quote evidence and rejects changed amounts, customer and snapshots', () => {
  const { store, run } = fixture();
  try {
    const analysis = JSON.parse(
      readFileSync('docs/samples/analysis-example.json', 'utf8'),
    ) as Analysis;
    analysis.request_id = 'test';
    assert.throws(() => validateAnalysis(store, run, analysis));
    const tools = new Tools(store, seller, root, () => now, '@sample.hana');
    for (const [name, args] of [
      ['search_products', { query: '니트' }],
      ['get_policies', {}],
      [
        'quote_order',
        {
          items: [
            { sku: 'K-BE', quantity: 1 },
            { sku: 'K-CR', quantity: 1 },
          ],
        },
      ],
    ] as const)
      store.traceTool(run.id, name, name, true, tools.call(name, args), 16);
    assert.equal(
      validateAnalysis(store, run, analysis).order_draft?.amounts?.total_krw,
      62000,
    );
    const wrong = structuredClone(analysis);
    wrong.order_draft!.amounts!.total_krw = 1;
    assert.throws(() => validateAnalysis(store, run, wrong));
    const other = structuredClone(analysis);
    other.order_draft!.customer_handle = '@other';
    assert.throws(() => validateAnalysis(store, run, other));
    const approved = structuredClone(analysis);
    approved.order_draft!.address_verification = 'matched';
    assert.throws(() => validateAnalysis(store, run, approved));
    const invented = structuredClone(analysis);
    invented.product_candidates.push('invented');
    assert.throws(() => validateAnalysis(store, run, invented));
    store.replaceProducts(seller, store.products(seller));
    assert.throws(() => validateAnalysis(store, run, analysis), /자료가 변경/);
  } finally {
    store.close();
  }
});
test('cached runs and scoped history survive SQLite restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbyeol-runs-')),
    path = join(dir, 'app.sqlite');
  const { store, room, run } = fixture(path);
  const analysis = {
    ...emptyAnalysis('test'),
    classification: 'unrelated' as const,
    status: 'ignored' as const,
  };
  store.finishRun(run.id, analysis, 200);
  store.close();
  const reopened = new Store(path);
  try {
    assert.equal(reopened.runForRequest(seller, 'test')?.status, 'succeeded');
    assert.equal(reopened.runById(run.id).input.history.length, 1);
    assert.equal(reopened.messages(seller, room.id).length, 1);
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('one room serializes new messages; identical in-flight requests share the runner result', async () => {
  const store = new Store(':memory:');
  store.seedSamples(root, seller);
  const room = store.createConversation(seller, '@sample.hana', '');
  let release!: () => void,
    entered!: () => void,
    calls = 0;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const running = new Map<string, Promise<Analysis>>();
  const runner: AgentRunner = {
    readiness: () => ({ ready: true, code: null }),
    run: (run) => {
      let pending = running.get(run.id);
      if (!pending) {
        calls++;
        pending = (async () => {
          entered();
          await gate;
          return {
            ...emptyAnalysis(run.request_id),
            classification: 'unrelated',
            status: 'ignored',
          } as Analysis;
        })();
        running.set(run.id, pending);
      }
      return pending;
    },
    stop: async () => {},
  };
  const app = createApp(store, config(), { runner });
  const body = {
    schema_version: '0.1',
    request_id: 'a',
    conversation_id: room.id,
    customer_handle: '@sample.hana',
    text: '광고',
  };
  try {
    const first = app.request('/api/chat', post(body));
    await started;
    const duplicate = app.request('/api/chat', post(body));
    const blocked = await app.request(
      '/api/chat',
      post({ ...body, request_id: 'b' }),
    );
    assert.equal(blocked.status, 409);
    assert.equal(store.messages(seller, room.id).length, 1);
    release();
    const responses = await Promise.all([first, duplicate]);
    assert.ok(responses.every((r) => r.status === 200));
    assert.equal(calls, 1);
    store.receive(seller, {
      requestId: 'c',
      conversationId: room.id,
      handle: '@sample.hana',
      text: 'next',
      attachments: [],
    });
    const next = store.beginRun(
      seller,
      'c',
      { messages: 40, characters: 40000 },
      now,
    );
    const cached = await app.request('/api/chat', post(body));
    assert.equal(cached.status, 200);
    assert.equal((await cached.json()).replayed, true);
    store.finishRun(
      next.id,
      { ...emptyAnalysis('c'), classification: 'unrelated', status: 'ignored' },
      200,
    );
  } finally {
    release();
    store.close();
  }
});
test('TypeSafe request contains only scoped recent history; invalid distributions and upstream failures fail closed', async () => {
  const { store, run } = fixture();
  try {
    const probabilities = Object.fromEntries(
      categories.map((c) => [c, c === 'order_request' ? 1 : 0]),
    );
    const send: typeof fetch = async (url, init) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        'Bearer test-secret',
      );
      const body = JSON.parse(String(init?.body));
      assert.equal(body.state.customer_handle, '@sample.hana');
      assert.equal(body.questions.category.type, 'choice');
      return Response.json({
        model: 'jev-test',
        answers: {
          category: {
            type: 'choice',
            choice: 'order_request',
            confidence: 1,
            probabilities,
          },
        },
      });
    };
    assert.equal(
      (
        await classifyWithTypesafe(
          run.input,
          'test-secret',
          'jev-latest',
          undefined,
          send,
        )
      ).authoritative,
      false,
    );
    await assert.rejects(() =>
      classifyWithTypesafe(
        run.input,
        'test-secret',
        'jev-latest',
        undefined,
        async () =>
          Response.json({
            model: 'test',
            answers: {
              category: {
                type: 'choice',
                choice: 'order_request',
                confidence: 1,
                probabilities: { order_request: 0.4 },
              },
            },
          }),
      ),
    );
    await assert.rejects(
      () =>
        classifyWithTypesafe(
          run.input,
          'test-secret',
          'jev-latest',
          undefined,
          async () => new Response('secret upstream detail', { status: 401 }),
        ),
      (error) =>
        error instanceof Error &&
        !error.message.includes('secret upstream detail'),
    );
  } finally {
    store.close();
  }
});
test('container requires a strong token; provider secrets stay out of serialized config', () => {
  assert.throws(() =>
    readConfig(root, {
      NODE_ENV: 'production',
      APP_DEPLOYMENT: 'container',
      LOCAL_API_TOKEN: '',
    }),
  );
  const configured = readConfig(root, {
    NODE_ENV: 'production',
    APP_DEPLOYMENT: 'container',
    LOCAL_API_TOKEN: 'x'.repeat(32),
    OPENAI_API_KEY: 'fake-secret',
    TYPESAFE_API_KEY: 'fake-typesafe',
  });
  assert.equal(configured.listenHost, '0.0.0.0');
  assert.equal(providerEnvironment(configured).OPENAI_API_KEY, 'fake-secret');
  assert.ok(!JSON.stringify(configured).includes('fake-secret'));
});

function provenOrder() {
  const { store, run } = fixture();
  const tools = new Tools(store, seller, root, () => now, '@sample.hana');
  for (const [name, args] of [
    ['search_products', { query: '니트' }],
    ['get_policies', {}],
    [
      'quote_order',
      {
        items: [
          { sku: 'K-BE', quantity: 1 },
          { sku: 'K-CR', quantity: 1 },
        ],
      },
    ],
  ] as const)
    store.traceTool(run.id, name, name, true, tools.call(name, args), 16);
  const analysis = JSON.parse(
    readFileSync('docs/samples/analysis-example.json', 'utf8'),
  ) as Analysis;
  analysis.request_id = 'test';
  return { store, run, tools, analysis };
}
test('adversarial: invented recipient fields cannot become a payable order even with valid quote evidence', () => {
  const { store, run, analysis } = provenOrder();
  try {
    run.input.history.push({
      role: 'assistant',
      request_id: 'untrusted-draft',
      text: '지어낸수령인 010-9999-9999 원문에 없는 다른 주소 99999 가짜입금자',
    });
    for (const [field, value] of [
      ['name', '지어낸수령인'],
      ['phone_raw', '010-9999-9999'],
      ['address_raw', '원문에 없는 다른 주소'],
      ['postal_code', '99999'],
    ] as const) {
      const fake = structuredClone(analysis);
      fake.order_draft!.recipient[field] = value;
      assert.throws(() => validateAnalysis(store, run, fake), field);
    }
    const fake = structuredClone(analysis);
    fake.order_draft!.depositor_name = '가짜입금자';
    assert.throws(() => validateAnalysis(store, run, fake), 'depositor');
  } finally {
    store.close();
  }
});
test('adversarial: null amounts cannot bypass stock warnings or omit the matching quote', () => {
  const { store, run, tools, analysis } = provenOrder();
  try {
    const unsafe = structuredClone(analysis);
    unsafe.order_draft!.items = [
      { product_id: 'P001', sku: 'K-BK', quantity: 1, unit_price_krw: 33000 },
    ];
    unsafe.order_draft!.amounts = null;
    unsafe.matched_skus = ['K-BK'];
    unsafe.status = 'needs_info';
    unsafe.order_draft!.recipient.phone_raw = null;
    unsafe.missing_fields = ['recipient.phone_raw'];
    assert.throws(() => validateAnalysis(store, run, unsafe), 'missing quote');
    store.traceTool(
      run.id,
      'black-quote',
      'quote_order',
      true,
      tools.call('quote_order', { items: [{ sku: 'K-BK', quantity: 1 }] }),
      16,
    );
    assert.throws(
      () => validateAnalysis(store, run, unsafe),
      'hidden stock warning',
    );
    unsafe.status = 'human_review';
    unsafe.review_items.push({ code: 'OUT_OF_STOCK', message: '품절' });
    assert.equal(validateAnalysis(store, run, unsafe).status, 'human_review');
  } finally {
    store.close();
  }
});
