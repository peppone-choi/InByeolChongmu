import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Tools } from '../src/tools/registry.js';
import { createApp } from '../src/http/app.js';
import { readConfig } from '../src/config.js';
import { createFlueTools } from '../src/agent/flue-tools.js';
import { createSellerAgent } from '../src/agent/seller-agent.js';
import { analysisSchema } from '../src/domain/schema.js';
import { exportProducts, importProducts } from '../src/storage/workbook.js';
import ExcelJS from 'exceljs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/tools/mcp.js';

const root = process.cwd(),
  seller = 'sample-seller-01';
const clock = () => new Date('2026-11-05T10:00:00+09:00');
function setup(path = ':memory:') {
  const store = new Store(path);
  store.seedSamples(root, seller);
  const config = readConfig(root, {
    NODE_ENV: 'test',
    DATABASE_PATH: path,
    AGENT_BACKEND: 'disabled',
    LOCAL_API_TOKEN: '',
    OPENAI_API_KEY: '',
    TYPESAFE_API_KEY: '',
  });
  return {
    store,
    config,
    tools: new Tools(store, seller, root, clock),
    app: createApp(store, config),
  };
}
function post(body: unknown) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

test('SQLite persists edited source, rooms and messages across restart without reseeding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbyeol-db-'));
  const path = join(dir, 'store.sqlite');
  const { store } = setup(path);
  try {
    const products = store.products(seller);
    products[0]!.variants[0]!.stock_available = 99;
    store.replaceProducts(seller, products);
    const received = store.receive(seller, {
      requestId: 'req-disk',
      handle: '@sample.persist',
      text: '주문',
      attachments: [],
    });
    store.close();
    const reopened = new Store(path);
    try {
      assert.equal(reopened.seedSamples(root, seller).inserted, 0);
      assert.equal(
        reopened.products(seller)[0]!.variants[0]!.stock_available,
        99,
      );
      assert.equal(
        reopened.messages(seller, received.conversation.id)[0]!.text,
        '주문',
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real SQLite tools preserve aliases, ambiguity, historical records and money', () => {
  const { store, tools } = setup();
  try {
    const before = JSON.stringify([
      store.products(seller),
      store.orders(seller),
    ]);
    const search = tools.call('search_products', { query: '가디건' }) as {
      records: unknown[];
      ambiguous: boolean;
    };
    assert.equal(search.records.length, 2);
    assert.equal(search.ambiguous, true);
    const orders = tools.call('search_orders', { query: '샘플동명' }) as {
      records: Array<Record<string, unknown>>;
      ambiguous: boolean;
    };
    assert.equal(orders.ambiguous, true);
    assert.equal(orders.records.length, 2);
    assert.ok(!JSON.stringify(orders).includes('address_raw'));
    const quote = tools.call('quote_order', {
      items: [
        { sku: 'K-BE', quantity: 1 },
        { sku: 'K-CR', quantity: 1 },
      ],
    }) as { amounts: unknown; can_confirm: boolean };
    assert.deepEqual(quote.amounts, {
      subtotal_krw: 62000,
      discount_krw: 3000,
      shipping_fee_krw: 3000,
      total_krw: 62000,
    });
    assert.equal(quote.can_confirm, false);
    const calendar = tools.call('get_sales_calendar', {
      from: '2026-11-05T00:00:00+09:00',
      to: '2026-11-07T23:59:00+09:00',
    }) as { events: unknown[] };
    assert.equal(calendar.events.length, 1);
    assert.match(
      JSON.stringify(
        tools.call('read_document', { document_id: 'policy-guide' }),
      ),
      /3,000/,
    );
    assert.equal(
      JSON.stringify([store.products(seller), store.orders(seller)]),
      before,
    );
  } finally {
    store.close();
  }
});

test('tool inputs reject unknown tools, SQL/path injection, bad numbers and unsupported policies', () => {
  const { store, tools } = setup();
  try {
    assert.throws(() => tools.call('confirm_order', {}));
    assert.throws(() =>
      tools.call('quote_order', { items: [{ sku: 'K-BE', quantity: true }] }),
    );
    assert.throws(() =>
      tools.call('quote_order', { items: [{ sku: 'K-BE', quantity: 0 }] }),
    );
    assert.throws(() =>
      tools.call('quote_order', { items: [{ sku: 'unknown', quantity: 1 }] }),
    );
    assert.throws(() =>
      tools.call('read_document', { document_id: '../../.env.local' }),
    );
    assert.throws(() =>
      tools.call('search_products', { query: '가디건', seller_id: 'other' }),
    );
    assert.throws(() =>
      tools.call('get_sales_calendar', {
        from: '2026-11-07T00:00:00Z',
        to: '2026-11-05T00:00:00Z',
      }),
    );
    assert.deepEqual(
      (
        tools.call('search_products', { query: "' OR 1=1 --" }) as {
          records: unknown[];
        }
      ).records,
      [],
    );
    assert.throws(() =>
      new Tools(store, 'other', root).call('get_policies', {}),
    );
  } finally {
    store.close();
  }
});

test('allowlisted file rejects symlink escape', () => {
  const { store } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'inbyeol-files-'));
  try {
    mkdirSync(join(dir, 'assets/sample-store'), { recursive: true });
    writeFileSync(join(dir, 'secret'), 'secret');
    symlinkSync(
      join(dir, 'secret'),
      join(dir, 'assets/sample-store/policy-guide.md'),
    );
    assert.throws(() =>
      new Tools(store, seller, dir).call('read_document', {
        document_id: 'policy-guide',
      }),
    );
    rmSync(join(dir, 'assets/sample-store'), { recursive: true });
    mkdirSync(join(dir, 'outside-allowlist'));
    writeFileSync(
      join(dir, 'outside-allowlist/policy-guide.md'),
      'private content',
    );
    symlinkSync(
      join(dir, 'outside-allowlist'),
      join(dir, 'assets/sample-store'),
      'dir',
    );
    assert.throws(() =>
      new Tools(store, seller, dir).call('read_document', {
        document_id: 'policy-guide',
      }),
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chat rooms isolate customer and context; retries persist a single message', async () => {
  const { store, app } = setup();
  try {
    const first = store.createConversation(seller, '@sample.a', '가디건 주문');
    const second = store.createConversation(seller, '@sample.a', '텀블러 상담');
    const other = store.createConversation('other-seller', '@sample.a', '외부');
    const body = {
      schema_version: '0.1',
      request_id: 'req-room',
      customer_handle: '@sample.a',
      conversation_id: first.id,
      text: '입금했어요',
    };
    let response = await app.request('/api/chat', post(body));
    assert.equal(response.status, 503);
    const result = await response.json();
    analysisSchema.parse(result.analysis);
    assert.equal(result.conversation_id, first.id);
    assert.equal(result.analysis.review_items[0].code, 'MODEL_NOT_CONNECTED');
    assert.equal(result.analysis.reply_draft, null);
    response = await app.request('/api/chat', post(body));
    assert.equal((await response.json()).replayed, true);
    assert.equal(store.messages(seller, first.id).length, 1);
    assert.equal(store.messages(seller, second.id).length, 0);
    assert.equal(
      (await app.request('/api/chat', post({ ...body, text: '다른내용' })))
        .status,
      409,
    );
    assert.equal(
      (
        await app.request(
          '/api/chat',
          post({ ...body, conversation_id: second.id }),
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await app.request(
          '/api/chat',
          post({
            ...body,
            request_id: 'different',
            customer_handle: '@sample.b',
          }),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request(
          '/api/chat',
          post({ ...body, request_id: 'foreign', conversation_id: other.id }),
        )
      ).status,
      404,
    );
    assert.equal(
      (await app.request(`/api/conversations/${other.id}/messages`)).status,
      404,
    );
    const messages = await (
      await app.request(`/api/conversations/${first.id}/messages`)
    ).json();
    assert.equal(messages.messages[0].text, '입금했어요');
  } finally {
    store.close();
  }
});

test('HTTP rejects malformed, untrusted and oversized requests without storing messages', async () => {
  const { store, config } = setup();
  try {
    const app = createApp(store, config);
    const body = {
      schema_version: '0.1',
      customer_handle: '@sample.a',
      text: 'hello',
    };
    assert.equal(
      (await app.request('/api/chat', post({ ...body, seller_id: 'other' })))
        .status,
      422,
    );
    assert.equal(
      (await app.request('/api/chat', post({ ...body, text: ' ' }))).status,
      422,
    );
    assert.equal(
      (
        await app.request('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
      400,
    );
    assert.equal(
      (await app.request('/api/chat', { method: 'POST', body: 'text' })).status,
      415,
    );
    assert.equal(
      (
        await app.request(
          '/api/chat',
          post({ ...body, text: 'x'.repeat(70000) }),
        )
      ).status,
      413,
    );
    assert.equal(store.conversations(seller).length, 0);
    assert.equal((await app.request('http://evil.test/health')).status, 403);
    assert.equal(
      (
        await app.request('/health', {
          headers: { Origin: 'https://evil.test' },
        })
      ).status,
      403,
    );
    const protectedApp = createApp(
      store,
      { ...config, apiToken: 'local-test-token' },
      { maxRequests: 1 },
    );
    assert.equal((await protectedApp.request('/health')).status, 401);
    assert.equal(
      (
        await protectedApp.request('/health', {
          headers: { Authorization: 'Bearer local-test-token' },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await protectedApp.request('/health', {
          headers: { Authorization: 'Bearer local-test-token' },
        })
      ).status,
      429,
    );
  } finally {
    store.close();
  }
});

test('room-bound order tool cannot retrieve another customer and image-only chat stays unsupported', async () => {
  const { store, app } = setup();
  try {
    const room = store.createConversation(seller, '@sample.same1');
    const response = await app.request(
      '/api/tools/search_orders',
      post({ conversation_id: room.id, arguments: { query: '@sample.same2' } }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).result.records, []);
    const image = await app.request(
      '/api/chat',
      post({
        schema_version: '0.1',
        customer_handle: '@sample.photo',
        text: '',
        attachments: [{ type: 'image' }],
      }),
    );
    assert.equal(image.status, 200);
    assert.equal((await image.json()).analysis.status, 'unsupported');
  } finally {
    store.close();
  }
});

test('XLSX product import is atomic and validates duplicate SKUs and formulas', async () => {
  const { store } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'inbyeol-xlsx-'));
  const file = join(dir, 'products.xlsx');
  try {
    await exportProducts(store, seller, file);
    let workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    workbook.getWorksheet('products')!.getRow(2).getCell(11).value = 17;
    await workbook.xlsx.writeFile(file);
    await importProducts(store, seller, file);
    assert.equal(store.products(seller)[0]!.variants[0]!.stock_available, 17);
    const snapshot = store.source(seller, 'product').snapshot_id;
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    workbook.getWorksheet('products')!.getRow(3).getCell(7).value = 'K-BE';
    await workbook.xlsx.writeFile(file);
    await assert.rejects(importProducts(store, seller, file));
    assert.equal(store.source(seller, 'product').snapshot_id, snapshot);
    await exportProducts(store, seller, file);
    await workbook.xlsx.readFile(file);
    workbook.getWorksheet('products')!.getRow(2).getCell(10).value = {
      formula: '1+1',
      result: 2,
    };
    await workbook.xlsx.writeFile(file);
    await assert.rejects(importProducts(store, seller, file));
    assert.equal(store.source(seller, 'product').snapshot_id, snapshot);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP SDK client actually lists and calls SQLite tools with scoped order access', async () => {
  const { store, config } = setup();
  const room = store.createConversation(seller, '@sample.same1');
  const server = createMcpServer(store, { ...config, conversationId: room.id });
  const client = new Client({ name: 'integration-test', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.equal((await client.listTools()).tools.length, 6);
    const response = await client.callTool({
      name: 'search_products',
      arguments: { query: 'K-BE' },
    });
    assert.equal(response.isError, undefined);
    assert.match(JSON.stringify(response.content), /31000/);
    const orders = await client.callTool({
      name: 'search_orders',
      arguments: { query: '@sample.same2' },
    });
    assert.match(JSON.stringify(orders.content), /records/);
    assert.ok(!JSON.stringify(orders.content).includes('O-0003'));
    const invalid = await client.callTool({
      name: 'quote_order',
      arguments: { items: [{ sku: 'K-BE', quantity: 0 }] },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});

test('Flue tools are real frozen definitions and factory requires a seller-owned room', async () => {
  const { store, config, tools } = setup();
  try {
    const definitions = createFlueTools(tools);
    assert.equal(definitions.length, 6);
    assert.ok(Object.isFrozen(definitions[0]));
    const search = definitions.find(
      (definition) => definition.name === 'search_products',
    )!;
    const executed = await search.run({
      toolCallId: 'offline-check',
      log: { info() {}, warn() {}, error() {} },
      data: { arguments: { query: 'K-BE' } },
    });
    assert.match(JSON.stringify(executed), /31000/);
    const room = store.createConversation(seller, '@sample.same1');
    assert.equal(
      createSellerAgent(store, config, room.id, 'openai/configure-later').name,
      'SellerAgent',
    );
    assert.throws(() => createSellerAgent(store, config, room.id, ''));
    const foreign = store.createConversation('other', '@sample.same1');
    assert.throws(() =>
      createSellerAgent(store, config, foreign.id, 'openai/configure-later'),
    );
  } finally {
    store.close();
  }
});

test('env.local wins over env; process config wins; keys stay out of serialized config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbyeol-env-'));
  try {
    writeFileSync(
      join(dir, '.env'),
      'PORT=4000\nOPENAI_API_KEY=test-secret-value\n',
    );
    writeFileSync(join(dir, '.env.local'), 'PORT=4001\n');
    const config = readConfig(dir, {});
    assert.equal(config.port, 4001);
    assert.equal(config.credentials.openai, true);
    assert.ok(!JSON.stringify(config).includes('test-secret-value'));
    assert.equal(readConfig(dir, { PORT: '4002' }).port, 4002);
    assert.throws(() => readConfig(dir, { NODE_ENV: 'production' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('online SQLite backup restores records and rooms without changing the original', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbyeol-backup-'));
  const path = join(dir, 'original.sqlite');
  const backupPath = join(dir, 'backup.sqlite');
  const { store } = setup(path);
  try {
    const room = store.createConversation(
      seller,
      '@sample.backup',
      '백업 검증',
    );
    await store.backupTo(backupPath);
    const restored = new Store(backupPath);
    try {
      assert.equal(restored.products(seller).length, 4);
      assert.equal(
        restored.conversation(seller, room.id).context_label,
        '백업 검증',
      );
    } finally {
      restored.close();
    }
    await assert.rejects(store.backupTo(path));
    await assert.rejects(store.backupTo(backupPath));
    assert.equal(store.conversations(seller).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
