import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage/store.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { BrowserSessions, sessionTtl } from '../src/http/session.js';
import {
  roomDetailSchema,
  roomSummarySchema,
  resourcesSchema,
} from '../src/domain/http-contract.js';
import { emptyAnalysis } from '../src/domain/schema.js';

test('browser login protects API, rejects cross-origin login, expires and logs out without exposing token', async () => {
  const store = new Store(':memory:');
  store.seedSamples(process.cwd(), 'sample-seller-01');
  const config = readConfig(process.cwd(), {
    NODE_ENV: 'test',
    LOCAL_API_TOKEN: 'test-connection-token',
    AGENT_BACKEND: 'disabled',
  });
  const app = createApp(store, config);
  const post = (token: string, origin?: string) => ({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify({ token }),
  });
  try {
    assert.equal((await app.request('/api/resources')).status, 401);
    assert.equal(
      (await app.request('/api/session', post('wrong'))).status,
      401,
    );
    assert.equal(
      (
        await app.request(
          '/api/session',
          post(config.apiToken, 'http://evil.test'),
        )
      ).status,
      403,
    );
    const login = await app.request('/api/session', post(config.apiToken));
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.ok(!cookie.includes(config.apiToken));
    const headers = { Cookie: cookie.split(';')[0]! };
    const response = await app.request('/api/resources', { headers });
    resourcesSchema.parse(await response.json());
    assert.equal(
      (await app.request('/api/session', { headers, method: 'DELETE' })).status,
      204,
    );
    assert.equal(
      (await app.request('/api/resources', { headers })).status,
      401,
    );
    let now = 0;
    const sessions = new BrowserSessions('secret', () => now);
    const id = sessions.create();
    assert.equal(sessions.authenticate(undefined, id), 'session');
    now = sessionTtl * 1000;
    assert.equal(sessions.authenticate(undefined, id), null);
  } finally {
    store.close();
  }
});

test('room API restores persisted analysis and safe live tool status with seller isolation', async () => {
  const store = new Store(':memory:');
  store.seedSamples(process.cwd(), 'sample-seller-01');
  const config = readConfig(process.cwd(), {
      NODE_ENV: 'test',
      LOCAL_API_TOKEN: '',
      AGENT_BACKEND: 'disabled',
    }),
    app = createApp(store, config);
  try {
    const { conversation } = store.receive(config.sellerId, {
      requestId: 'web-api-request',
      handle: '@sample.ui',
      text: '니트 재고 문의',
      attachments: [],
    });
    const run = store.beginRun(
      config.sellerId,
      'web-api-request',
      { messages: 40, characters: 40000, timeoutMs: 60000 },
      new Date(),
    );
    store.traceTool(
      run.id,
      'call-products',
      'search_products',
      false,
      { pending: true, private_value: 'never sent' },
      16,
    );
    const detail = roomDetailSchema.parse(
      await (await app.request(`/api/conversations/${conversation.id}`)).json(),
    );
    assert.equal(detail.latest?.execution?.tool_calls[0]?.status, 'running');
    assert.ok(!JSON.stringify(detail).includes('never sent'));
    store.traceTool(
      run.id,
      'call-products',
      'search_products',
      true,
      { records: [] },
      16,
    );
    const analysis = emptyAnalysis('web-api-request');
    analysis.status = 'ready_for_review';
    analysis.reply_draft = '확인한 초안';
    store.finishRun(run.id, analysis, 200);
    const restored = roomDetailSchema.parse(
      await (await app.request(`/api/conversations/${conversation.id}`)).json(),
    );
    assert.equal(restored.latest?.analysis?.reply_draft, '확인한 초안');
    assert.equal(
      restored.latest?.execution?.tool_calls[0]?.status,
      'succeeded',
    );
    const list = (await (await app.request('/api/conversations')).json()) as {
      conversations: unknown[];
    };
    assert.equal(
      roomSummarySchema.parse(list.conversations[0]).latest?.analysis_status,
      'ready_for_review',
    );
    const other = store.createConversation(
      'other-seller',
      '@sample.ui',
      'private',
    );
    assert.equal(
      (await app.request(`/api/conversations/${other.id}`)).status,
      404,
    );
  } finally {
    store.close();
  }
});

test('built web shell is public while static serving cannot expose env or private API', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inbyeol-web-')),
    store = new Store(':memory:');
  try {
    mkdirSync(join(root, 'dist/web/assets'), { recursive: true });
    writeFileSync(
      join(root, 'dist/web/index.html'),
      '<html>inbyeol shell</html>',
    );
    writeFileSync(join(root, 'dist/web/assets/app.js'), 'console.log("web")');
    writeFileSync(join(root, '.env.local'), 'PRIVATE_VALUE=secret');
    const config = readConfig(root, {
        NODE_ENV: 'test',
        LOCAL_API_TOKEN: 'private-token',
        AGENT_BACKEND: 'disabled',
      }),
      app = createApp(store, config);
    const shell = await app.request('/');
    assert.equal(shell.status, 200);
    assert.match(
      shell.headers.get('Content-Security-Policy') ?? '',
      /frame-ancestors 'none'/,
    );
    assert.equal((await app.request('/assets/app.js')).status, 200);
    assert.equal((await app.request('/.env.local')).status, 404);
    assert.equal(
      (await app.request('/assets/%2e%2e/%2e%2e/.env.local')).status,
      404,
    );
    assert.equal((await app.request('/api/resources')).status, 401);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
