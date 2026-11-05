import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../config.js';
import { Store } from '../storage/store.js';
import { FlueRunner } from '../agent/flue-runner.js';
import { createApp } from '../http/app.js';

// Explicit live command only. Never seed the user's application or runtime database.
const temporary = mkdtempSync(join(tmpdir(), 'inbyeol-live-'));
const config = readConfig(process.cwd(), {
  ...process.env,
  NODE_ENV: 'test',
  APP_DEPLOYMENT: 'local',
  LOCAL_API_TOKEN: '',
  DATABASE_PATH: ':memory:',
  FLUE_DATABASE_PATH: join(temporary, 'flue.sqlite'),
});
const store = new Store(':memory:');
store.seedSamples(config.root, config.sellerId);
const runner = new FlueRunner(store, config);
const app = createApp(store, config, {
  runner,
  clock: () => new Date('2026-11-05T00:00:00Z'),
});
const room = store.createConversation(
  config.sellerId,
  '@sample.hana',
  '가상 니트 주문',
);
store.receive(config.sellerId, {
  requestId: 'live-prior',
  conversationId: room.id,
  handle: '@sample.hana',
  text: '니트 가디건 베이지 한 개 주문할게요.',
  attachments: [],
});
const sources = JSON.stringify([
  store.products(config.sellerId),
  store.orders(config.sellerId),
]);
try {
  assert.ok(
    runner.readiness().ready,
    'Configure AGENT_BACKEND=flue, AGENT_MODEL and OPENAI_API_KEY first.',
  );
  const body = {
    schema_version: '0.1',
    request_id: 'live-order',
    conversation_id: room.id,
    customer_handle: '@sample.hana',
    text: '크림도 하나 추가요. 받는 사람 샘플하나, 010-0000-1001, 가상시 예시구 테스트로 101 샘플동 202호, 입금자 샘플하나. 입금했어요.',
  };
  const request = () =>
    app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const start = Date.now(),
    response = await request(),
    result = await response.json();
  console.log(
    JSON.stringify({
      check: 'live-order',
      http_status: response.status,
      status: result.analysis?.status,
      classification: result.analysis?.classification,
      missing_fields: result.analysis?.missing_fields,
      invalid_fields: result.analysis?.invalid_fields,
      review_codes: result.analysis?.review_items?.map(
        (r: { code: string }) => r.code,
      ),
      execution: result.execution,
      elapsed_ms: Date.now() - start,
    }),
  );
  assert.equal(
    response.status,
    200,
    'Live agent did not return validated analysis.',
  );
  assert.equal(
    result.analysis.order_draft?.amounts?.total_krw,
    62000,
    'Independent sample price check failed.',
  );
  assert.equal(result.analysis.state_mutation_allowed, false);
  assert.equal(
    result.analysis.status,
    'awaiting_payment',
    'A complete virtual order must not be reported as missing information.',
  );
  assert.deepEqual(result.analysis.missing_fields, []);
  assert.deepEqual(result.analysis.invalid_fields, []);
  assert.equal(result.analysis.order_draft.recipient.name, '샘플하나');
  assert.equal(
    result.analysis.order_draft.recipient.phone_raw,
    '010-0000-1001',
  );
  assert.equal(
    result.analysis.order_draft.recipient.address_raw,
    '가상시 예시구 테스트로 101 샘플동 202호',
  );
  assert.equal(result.analysis.order_draft.depositor_name, '샘플하나');
  assert.equal(result.analysis.order_draft.address_verification, 'not_checked');
  assert.ok(
    result.execution.tool_calls.some(
      (call: { name: string; success: boolean }) =>
        call.name === 'quote_order' && call.success,
    ),
  );
  if (config.credentials.jev)
    assert.ok(
      result.execution.tool_calls.some(
        (call: { name: string; success: boolean }) =>
          call.name === 'classify_inquiry' && call.success,
      ),
      'TypeSafe tool did not succeed.',
    );
  const replay = await request(),
    cached = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(cached.replayed, true);
  assert.equal(cached.execution.model_calls, result.execution.model_calls);
  assert.equal(
    JSON.stringify([
      store.products(config.sellerId),
      store.orders(config.sellerId),
    ]),
    sources,
  );
  console.log(
    JSON.stringify({
      check: 'replay-and-read-only',
      passed: true,
      total_krw: 62000,
      typesafe_verified: config.credentials.jev,
    }),
  );
} catch {
  console.error(
    'Live verification failed; see safe status and tool metadata above.',
  );
  process.exitCode = 1;
} finally {
  await runner.stop();
  store.close();
  rmSync(temporary, { recursive: true, force: true });
}
