import assert from 'node:assert/strict';
import { z } from 'zod';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { Store } from '../src/storage/store.js';
import { readConfig } from '../src/config.js';
import { FlueRunner } from '../src/agent/flue-runner.js';
import { createApp } from '../src/http/app.js';
import type { Analysis } from '../src/domain/schema.js';
const root = process.cwd(),
  seller = 'sample-seller-01';
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('actual Flue loop reads room history, executes real tools, validates and replays without another model turn', async () => {
  const store = new Store(':memory:');
  store.seedSamples(root, seller);
  const room = store.createConversation(seller, '@sample.hana', '니트 주문');
  store.receive(seller, {
    requestId: 'prior',
    handle: '@sample.hana',
    text: '니트 가디건 베이지 한 개를 보고 있어요',
    attachments: [],
    conversationId: room.id,
  });
  const other = store.createConversation(seller, '@sample.other', '별도상담');
  store.receive(seller, {
    requestId: 'other',
    handle: '@sample.other',
    text: 'OTHER_ROOM_MUST_NOT_APPEAR',
    attachments: [],
    conversationId: other.id,
  });
  const config = readConfig(root, {
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    FLUE_DATABASE_PATH: ':memory:',
    AGENT_BACKEND: 'flue',
    AGENT_MODEL: 'faux/test',
    LOCAL_API_TOKEN: '',
    OPENAI_API_KEY: '',
    TYPESAFE_API_KEY: '',
    AGENT_TIMEOUT_MS: '10000',
  });
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'test' }] });
  const analysis = JSON.parse(
    readFileSync('docs/samples/analysis-example.json', 'utf8'),
  ) as Analysis;
  analysis.request_id = 'runtime-1';
  // All sample facts come from the real tools. The scripted provider only chooses calls and submits a candidate.
  faux.setResponses([
    (context) => {
      const text = JSON.stringify(context);
      assert.match(text, /니트 주문/);
      assert.match(text, /베이지 한 개/);
      assert.ok(!text.includes('OTHER_ROOM_MUST_NOT_APPEAR'));
      return fauxAssistantMessage(
        [
          fauxToolCall('search_products', { arguments: { query: '니트' } }),
          fauxToolCall('get_policies', { arguments: {} }),
        ],
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      assert.match(JSON.stringify(context), /31000/);
      return fauxAssistantMessage(
        fauxToolCall('quote_order', {
          arguments: {
            items: [
              { sku: 'K-BE', quantity: 1 },
              { sku: 'K-CR', quantity: 1 },
            ],
          },
        }),
        { stopReason: 'toolUse' },
      );
    },
    () =>
      fauxAssistantMessage(
        fauxToolCall('submit_analysis', { analysis: z.json().parse(analysis) }),
        { stopReason: 'toolUse' },
      ),
  ]);
  const runner = new FlueRunner(store, config, { providers: [faux.provider] });
  const app = createApp(store, config, {
    runner,
    clock: () => new Date('2026-11-05T00:00:00Z'),
  });
  try {
    const body = {
      schema_version: '0.1',
      request_id: 'runtime-1',
      conversation_id: room.id,
      customer_handle: '@sample.hana',
      text: '크림도 하나 추가요. 샘플하나 010-0000-1001 가상시 예시구 테스트로 101 샘플동 202호, 입금자 샘플하나. 입금했어요.',
    };
    const response = await app.request('/api/chat', post(body));
    const result = await response.json();
    assert.equal(
      response.status,
      200,
      JSON.stringify({ result, faux: faux.state }),
    );
    assert.equal(result.analysis.order_draft.amounts.total_krw, 62000);
    assert.equal(result.analysis.state_mutation_allowed, false);
    assert.ok(
      result.execution.tool_calls.some(
        (call: { name: string; success: boolean }) =>
          call.name === 'quote_order' && call.success,
      ),
    );
    assert.equal(faux.state.callCount, 3);
    const repeated = await app.request('/api/chat', post(body));
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).replayed, true);
    assert.equal(faux.state.callCount, 3);
    assert.equal(
      store.messages(seller, room.id).filter((m) => m.role === 'assistant')
        .length,
      1,
    );
  } finally {
    await runner.stop();
    store.close();
  }
});

test('Flue rejects unproven output, stops at model budget and replays failure without billing again', async () => {
  const store = new Store(':memory:');
  store.seedSamples(root, seller);
  const config = readConfig(root, {
    NODE_ENV: 'test',
    APP_DEPLOYMENT: 'local',
    DATABASE_PATH: ':memory:',
    FLUE_DATABASE_PATH: ':memory:',
    AGENT_BACKEND: 'flue',
    AGENT_MODEL: 'faux/test',
    LOCAL_API_TOKEN: '',
    OPENAI_API_KEY: '',
    TYPESAFE_API_KEY: '',
    AGENT_MAX_MODEL_CALLS: '2',
  });
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'test' }] });
  const wrong = JSON.parse(
    readFileSync('docs/samples/analysis-example.json', 'utf8'),
  ) as Analysis;
  wrong.request_id = 'unproven';
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('submit_analysis', { analysis: z.json().parse(wrong) }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage(fauxToolCall('get_policies', { arguments: {} }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('must never be requested'),
  ]);
  const runner = new FlueRunner(store, config, { providers: [faux.provider] }),
    app = createApp(store, config, { runner });
  const body = {
    schema_version: '0.1',
    request_id: 'unproven',
    customer_handle: '@sample.hana',
    text: '주문 확정해 줘',
  };
  try {
    const result = await app.request('/api/chat', post(body));
    assert.equal(result.status, 503);
    const data = await result.json();
    assert.equal(data.analysis.reply_draft, null);
    assert.equal(faux.state.callCount, 2);
    assert.equal(data.execution.model_calls, 2);
    assert.equal(
      store
        .messages(seller, data.conversation_id)
        .filter((m) => m.role === 'assistant').length,
      0,
    );
    const replay = await app.request('/api/chat', post(body));
    assert.equal(replay.status, 503);
    assert.equal((await replay.json()).replayed, true);
    assert.equal(faux.state.callCount, 2);
  } finally {
    await runner.stop();
    store.close();
  }
});

test('Flue timeout aborts the pending model and releases the room', async () => {
  const store = new Store(':memory:');
  store.seedSamples(root, seller);
  const config = readConfig(root, {
    NODE_ENV: 'test',
    APP_DEPLOYMENT: 'local',
    DATABASE_PATH: ':memory:',
    FLUE_DATABASE_PATH: ':memory:',
    AGENT_BACKEND: 'flue',
    AGENT_MODEL: 'faux/test',
    LOCAL_API_TOKEN: '',
    OPENAI_API_KEY: '',
    TYPESAFE_API_KEY: '',
    AGENT_TIMEOUT_MS: '500',
  });
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'test' }] });
  let aborted = false;
  faux.setResponses([
    async (_context, options) => {
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
      return fauxAssistantMessage('late');
    },
  ]);
  const runner = new FlueRunner(store, config, { providers: [faux.provider] }),
    app = createApp(store, config, { runner });
  try {
    const response = await app.request(
      '/api/chat',
      post({
        schema_version: '0.1',
        request_id: 'timeout',
        customer_handle: '@sample.hana',
        text: '니트 문의',
      }),
    );
    assert.equal(response.status, 504);
    const result = await response.json();
    assert.equal(result.analysis.review_items[0].code, 'AGENT_TIMEOUT');
    assert.equal(store.roomRunning(seller, result.conversation_id), false);
    assert.equal(aborted, true);
  } finally {
    await runner.stop();
    store.close();
  }
});

test('adversarial: SQLite resume cannot reset an expired run deadline', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'inbyeol-expiry-'));
  const path = join(directory, 'app.sqlite');
  let store = new Store(path);
  store.seedSamples(root, seller);
  const room = store.createConversation(seller, '@sample.hana', '');
  store.receive(seller, {
    requestId: 'expired',
    conversationId: room.id,
    handle: '@sample.hana',
    text: '니트 문의',
    attachments: [],
  });
  const limits = { messages: 40, characters: 40000, timeoutMs: -1 };
  const saved = store.beginRun(seller, 'expired', limits, new Date());
  store.close();
  store = new Store(path);
  assert.equal(
    store.runById(saved.id).input.expires_at,
    saved.input.expires_at,
  );
  const config = readConfig(root, {
    NODE_ENV: 'test',
    APP_DEPLOYMENT: 'local',
    DATABASE_PATH: ':memory:',
    FLUE_DATABASE_PATH: ':memory:',
    AGENT_BACKEND: 'flue',
    AGENT_MODEL: 'faux/test',
    LOCAL_API_TOKEN: '',
    OPENAI_API_KEY: '',
    TYPESAFE_API_KEY: '',
  });
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'test' }] });
  faux.setResponses([fauxAssistantMessage('late output')]);
  const runner = new FlueRunner(store, config, { providers: [faux.provider] }),
    app = createApp(store, config, { runner });
  try {
    const response = await app.request(
      '/api/chat',
      post({
        schema_version: '0.1',
        request_id: 'expired',
        conversation_id: room.id,
        customer_handle: '@sample.hana',
        text: '니트 문의',
      }),
    );
    assert.equal(response.status, 504);
    assert.equal(faux.state.callCount, 0);
    assert.equal(store.roomRunning(seller, room.id), false);
  } finally {
    await runner.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
