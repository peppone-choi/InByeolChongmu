import { test } from 'node:test';
import { api } from '../web/src/api.js';
import { fork } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import { Store } from '../src/storage/store.js';
import { createApp } from '../src/http/app.js';
import { readConfig } from '../src/config.js';
import { emptyAnalysis, type Analysis } from '../src/domain/schema.js';
import { type SavedOrder, type ConfirmOrder } from '../src/domain/commerce.js';
import {
  WorkbookImports,
  exportCurrentWorkbook,
} from '../src/storage/data-workbook.js';
const seller = 'sample-seller-01',
  now = new Date('2026-11-05T10:00:00+09:00');
function setup(path = ':memory:') {
  const store = new Store(path);
  store.seedSamples(process.cwd(), seller);
  return store;
}
function analysis(store: Store, id = randomUUID(), partial = false) {
  const received = store.receive(seller, {
    requestId: id,
    handle: '@sample.hana',
    text: '가상 주문',
    attachments: [],
  });
  const run = store.beginRun(
    seller,
    id,
    { messages: 40, characters: 40000 },
    now,
  );
  const a = JSON.parse(
    readFileSync('docs/samples/analysis-example.json', 'utf8'),
  ) as Analysis;
  a.request_id = id;
  if (partial) {
    a.order_draft!.recipient.name = null;
    a.order_draft!.items[0]!.sku = null;
  }
  store.finishRun(run.id, a, 200);
  return { id, room: received.conversation.id };
}
function confirmation(store: Store, o: SavedOrder): ConfirmOrder {
  return {
    command_id: randomUUID(),
    expected_version: o.version,
    reviewed_snapshots: store.commerce.snapshots(seller),
    payment_checked: true,
    checked_amount_krw: o.amounts!.total_krw,
    checked_depositor_name: o.depositor_name!,
    address_acknowledged: true,
  };
}
const edit = (o: SavedOrder) => ({
  recipient: o.recipient,
  depositor_name: o.depositor_name,
  items: o.items,
});
const stock = (store: Store, sku = 'K-BE') =>
  store
    .products(seller)
    .flatMap((p) => p.variants)
    .find((v) => v.sku === sku)!.stock_available;

test('R-07/08: analysis saves incomplete draft without stock; seller completes, confirms once, preserves historical price', () => {
  const store = setup();
  try {
    const { id } = analysis(store, undefined, true),
      before = stock(store),
      saved = store.commerce.saveAnalysis(seller, id, now);
    assert.equal(saved.status, 'draft');
    assert.equal(stock(store), before);
    assert.equal(
      store.commerce.saveAnalysis(seller, id, now).order_id,
      saved.order_id,
    );
    const draft = edit(saved);
    draft.recipient.name = '샘플하나';
    draft.items[0]!.sku = 'K-BE';
    const updated = store.commerce.update(
      seller,
      saved.order_id,
      1,
      store.commerce.snapshots(seller),
      draft,
      now,
    );
    assert.equal(updated.status, 'pending_payment');
    assert.equal(updated.amounts!.total_krw, 62000);
    assert.throws(
      () =>
        store.commerce.confirm(
          seller,
          updated.order_id,
          { ...confirmation(store, updated), checked_amount_krw: 1 },
          now,
        ),
      /입금액/,
    );
    assert.equal(stock(store), before);
    const command = confirmation(store, updated),
      confirmed = store.commerce.confirm(
        seller,
        updated.order_id,
        command,
        now,
      );
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(stock(store), before - 1);
    assert.ok(confirmed.payment);
    assert.deepEqual(
      store.commerce.confirm(seller, updated.order_id, command, now),
      confirmed,
    );
    assert.equal(
      store.commerce.confirm(
        seller,
        updated.order_id,
        { ...command, command_id: randomUUID() },
        now,
      ).version,
      2 + 1,
    );
    assert.equal(stock(store), before - 1);
    assert.throws(
      () =>
        store.commerce.confirm(
          seller,
          updated.order_id,
          { ...command, checked_amount_krw: 10 },
          now,
        ),
      /내용이 다릅니다/,
    );
    const products = store.products(seller);
    products[0]!.variants[0]!.unit_price_krw = 35000;
    store.replaceProducts(seller, products);
    assert.equal(
      store.orders(seller).find((o) => o.order_id === confirmed.order_id)!
        .items[0]!.unit_price_krw,
      31000,
    );
    assert.throws(
      () =>
        store.commerce.update(
          seller,
          confirmed.order_id,
          confirmed.version,
          store.commerce.snapshots(seller),
          draft,
          now,
        ),
      /수정할 수/,
    );
  } finally {
    store.close();
  }
});

test('AC-10~12: stale data, changed policy, insufficient multi-item stock and SQL failure roll back every write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbyeol-confirm-')),
    file = join(dir, 'app.sqlite'),
    store = setup(file);
  try {
    const { id } = analysis(store),
      o = store.commerce.saveAnalysis(seller, id, now),
      before = stock(store),
      command = confirmation(store, o);
    const policies = store.policies(seller),
      shipping = policies.find((p) => p.shipping_fee_krw !== undefined)!;
    store.updatePolicy(
      seller,
      shipping.policy_id,
      store.source(seller, 'policy').snapshot_id,
      { ...shipping, shipping_fee_krw: 5000 },
    );
    assert.throws(
      () => store.commerce.confirm(seller, o.order_id, command, now),
      /変|바뀌/,
    );
    assert.equal(stock(store), before);
    const updated = store.commerce.update(
      seller,
      o.order_id,
      o.version,
      store.commerce.snapshots(seller),
      edit(o),
      now,
    );
    assert.equal(updated.amounts!.total_krw, 64000);
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TRIGGER reject_order_write BEFORE UPDATE ON managed_orders BEGIN SELECT RAISE(ABORT,'forced rollback'); END",
    );
    const source = store.source(seller, 'product').snapshot_id;
    assert.throws(
      () =>
        store.commerce.confirm(
          seller,
          o.order_id,
          confirmation(store, updated),
          now,
        ),
      /forced rollback/,
    );
    assert.equal(stock(store), before);
    assert.equal(store.source(seller, 'product').snapshot_id, source);
    assert.equal(
      store.commerce.get(seller, o.order_id).status,
      'pending_payment',
    );
    db.exec('DROP TRIGGER reject_order_write');
    db.close();
    const products = store.products(seller);
    products[0]!.variants.find((v) => v.sku === 'K-CR')!.stock_available = 0;
    store.replaceProducts(seller, products);
    const short = store.commerce.update(
      seller,
      o.order_id,
      updated.version,
      store.commerce.snapshots(seller),
      edit(updated),
      now,
    );
    assert.throws(
      () =>
        store.commerce.confirm(
          seller,
          o.order_id,
          confirmation(store, short),
          now,
        ),
      /품절/,
    );
    assert.equal(stock(store), before);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('last stock competition across SQLite connections cannot double confirm and restart keeps confirmation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbyeol-last-')),
    file = join(dir, 'app.sqlite'),
    a = setup(file);
  try {
    const products = a.products(seller);
    products[0]!.variants.find((v) => v.sku === 'K-BE')!.stock_available = 1;
    a.replaceProducts(seller, products);
    const first = analysis(a),
      o1 = a.commerce.saveAnalysis(seller, first.id, now),
      second = analysis(a),
      o2 = a.commerce.saveAnalysis(seller, second.id, now),
      b = new Store(file);
    try {
      const c1 = confirmation(a, o1),
        c2 = confirmation(b, o2);
      a.commerce.confirm(seller, o1.order_id, c1, now);
      assert.throws(
        () => b.commerce.confirm(seller, o2.order_id, c2, now),
        /바뀌/,
      );
      assert.equal(stock(b), 0);
      assert.equal(
        b.commerce.get(seller, o2.order_id).status,
        'pending_payment',
      );
    } finally {
      b.close();
    }
    a.close();
    const reopened = new Store(file);
    try {
      assert.equal(reopened.seedSamples(process.cwd(), seller).inserted, 0);
      assert.equal(stock(reopened), 0);
      assert.equal(
        reopened.commerce.get(seller, o1.order_id).status,
        'confirmed',
      );
    } finally {
      reopened.close();
    }
  } finally {
    try {
      a.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-14/15: catalog CRUD, variants, independent resets retain other areas and never reseed or restock', () => {
  const store = setup();
  try {
    const { id, room } = analysis(store),
      saved = store.commerce.saveAnalysis(seller, id, now),
      confirmed = store.commerce.confirm(
        seller,
        saved.order_id,
        confirmation(store, saved),
        now,
      ),
      after = stock(store);
    const p = structuredClone(store.products(seller)[0]!);
    p.product_id = 'new';
    p.name = '새 상품';
    p.variants = p.variants.map((v) => ({ ...v, sku: 'NEW-' + v.sku }));
    store.createProduct(seller, store.source(seller, 'product').snapshot_id, p);
    assert.equal(store.products(seller).length, 5);
    p.variants.push({ ...p.variants[0]!, sku: 'NEW-OPTION' });
    store.updateProduct(
      seller,
      p.product_id,
      store.source(seller, 'product').snapshot_id,
      p,
    );
    assert.ok(
      store
        .products(seller)
        .find((v) => v.product_id === 'new')!
        .variants.some((v) => v.sku === 'NEW-OPTION'),
    );
    store.deleteResource(
      seller,
      'product',
      'new',
      store.commerce.snapshots(seller),
    );
    assert.equal(store.products(seller).length, 4);
    store.commerce.remove(seller, confirmed.order_id, confirmed.version);
    assert.equal(stock(store), after);
    assert.throws(
      () => store.commerce.saveAnalysis(seller, id, now),
      /찾을 수/,
    );
    store.commerce.reset(seller, store.source(seller, 'order').snapshot_id);
    assert.equal(store.orders(seller).length, 0);
    assert.ok(store.messages(seller, room).length);
    assert.equal(stock(store), after);
    store.resetCatalog(seller, store.commerce.snapshots(seller));
    assert.equal(store.products(seller).length, 0);
    assert.equal(store.policies(seller).length, 0);
    assert.equal(store.seedSamples(process.cwd(), seller).inserted, 0);
    assert.ok(store.messages(seller, room).length);
    store.resetChats(seller);
    assert.equal(store.conversations(seller).length, 0);
    assert.equal(store.orders(seller).length, 0);
    assert.equal(store.products(seller).length, 0);
  } finally {
    store.close();
  }
});

test('AC-25/27: Excel preview never writes, keeps string phones, rejects whole file on formulas and stale apply', async () => {
  const store = setup();
  try {
    const imports = new WorkbookImports(store),
      buffer = await exportCurrentWorkbook(store, seller),
      book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as never);
    assert.equal(
      book.getWorksheet('metadata')!.getRow(5).getCell(2).value,
      store.source(seller, 'product').snapshot_id,
    );
    assert.equal(
      typeof book.getWorksheet('orders')!.getRow(2).getCell(5).value,
      'string',
    );
    const row = book.getWorksheet('products')!.getRow(2);
    row.getCell(10).value = 35000;
    const changed = Buffer.from(await book.xlsx.writeBuffer()),
      before = stock(store);
    const preview = await imports.preview(seller, changed);
    assert.equal(preview.errors.length, 0);
    assert.equal(preview.changes.products_updated, 4);
    assert.notEqual(
      store.products(seller)[0]!.variants[0]!.unit_price_krw,
      35000,
    );
    imports.apply(seller, preview.token);
    assert.equal(store.products(seller)[0]!.variants[0]!.unit_price_krw, 35000);
    assert.equal(stock(store), before);
    const stale = await imports.preview(seller, changed),
      product = store.products(seller)[0]!;
    product.name = '충돌';
    store.updateProduct(
      seller,
      product.product_id,
      store.source(seller, 'product').snapshot_id,
      product,
    );
    assert.throws(() => imports.apply(seller, stale.token), /다른 편집/);
    row.getCell(10).value = { formula: '1+1', result: 2 };
    const bad = await imports.preview(
      seller,
      Buffer.from(await book.xlsx.writeBuffer()),
    );
    assert.ok(bad.errors.some((e) => e.row === 2));
    assert.throws(() => imports.apply(seller, bad.token), /오류/);
    assert.equal(store.products(seller)[0]!.name, '충돌');
    assert.ok(JSON.stringify(store.exportCurrent(seller)).includes('analyses'));
  } finally {
    store.close();
  }
});

test('order API validates seller approval and HTTP reset isolates chat runner cleanup', async () => {
  const store = setup(),
    config = readConfig(process.cwd(), {
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      AGENT_BACKEND: 'disabled',
      LOCAL_API_TOKEN: '',
      OPENAI_API_KEY: '',
      TYPESAFE_API_KEY: '',
    });
  let cleared = false;
  const app = createApp(store, config, {
    clock: () => now,
    runner: {
      readiness: () => ({ ready: false, code: 'TEST' }),
      run: async () => emptyAnalysis('unused'),
      stop: async () => {},
      resetHistory: async () => {
        cleared = true;
      },
    },
  });
  const req = (body: unknown, method = 'POST') => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    const { id } = analysis(store);
    const response = await app.request(
      '/api/orders/from-analysis',
      req({ request_id: id }),
    );
    assert.equal(response.status, 201);
    const { order } = (await response.json()) as { order: SavedOrder };
    assert.equal(
      (
        await app.request(
          `/api/orders/${order.order_id}/confirm`,
          req({ ...confirmation(store, order), payment_checked: false }),
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await app.request(
          `/api/orders/${order.order_id}/confirm`,
          req(confirmation(store, order)),
        )
      ).status,
      200,
    );
    const snapshots = {
      ...store.commerce.snapshots(seller),
      orders: store.source(seller, 'order').snapshot_id,
    };
    assert.equal(
      (
        await app.request(
          '/api/data/reset/chats',
          req({ confirm: '초기화', snapshots }),
        )
      ).status,
      200,
    );
    assert.ok(cleared);
    assert.equal(store.conversations(seller).length, 0);
    assert.ok(store.commerce.get(seller, order.order_id).payment);
    assert.equal(
      (await app.request('/api/data/export?format=xlsx')).status,
      200,
    );
  } finally {
    store.close();
  }
});

test('AC-11: simultaneous processes compete for the final unit through the real confirmation function', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbyeol-race-')),
    file = join(dir, 'app.sqlite'),
    store = setup(file);
  try {
    const p = store.products(seller);
    p[0]!.variants.find((v) => v.sku === 'K-BE')!.stock_available = 1;
    store.replaceProducts(seller, p);
    const a = store.commerce.saveAnalysis(seller, analysis(store).id, now),
      b = store.commerce.saveAnalysis(seller, analysis(store).id, now);
    const children = [a, b].map((o) =>
      fork(
        'tests/fixtures/confirm-worker.ts',
        [file, o.order_id, JSON.stringify(confirmation(store, o))],
        {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      ),
    );
    try {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              child.once('message', () => resolve());
              child.once('error', reject);
              child.once('exit', (code) => {
                if (code) reject(new Error('worker startup failed'));
              });
            }),
        ),
      );
      const results = children.map(
        (child) =>
          new Promise<unknown>((resolve, reject) => {
            child.once('message', resolve);
            child.once('error', reject);
          }),
      );
      for (const child of children) child.send('confirm');
      const done = await Promise.all(results);
      assert.equal(done.filter((r) => r === 'confirmed').length, 1);
      assert.equal(done.filter((r) => String(r).includes('바뀌')).length, 1);
      assert.equal(stock(store), 0);
      assert.equal(
        store.commerce
          .list(seller)
          .filter(
            (o) =>
              [a.order_id, b.order_id].includes(o.order_id) &&
              o.status === 'confirmed',
          ).length,
        1,
      );
    } finally {
      for (const child of children) child.kill();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('browser API sends only catalog versions for draft edits and resource deletion', async () => {
  const store = setup(),
    config = readConfig(process.cwd(), {
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      AGENT_BACKEND: 'disabled',
      LOCAL_API_TOKEN: '',
      OPENAI_API_KEY: '',
      TYPESAFE_API_KEY: '',
    }),
    app = createApp(store, config, { clock: () => now }),
    previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => app.request(String(input), init);
  try {
    const saved = store.commerce.saveAnalysis(seller, analysis(store).id, now),
      resources = await api.resources();
    const changed = await api.updateOrder(
      saved.order_id,
      saved.version,
      resources.snapshots,
      { ...edit(saved), depositor_name: '수정 검증' },
    );
    assert.equal(changed.depositor_name, '수정 검증');
    assert.equal(changed.version, 2);
    const title = {
      policy_id: 'new-policy',
      title: '삭제 검증',
      rule: '가상 검증 정책',
    };
    await api.createPolicy(title, resources.snapshots.policies);
    const current = await api.resources();
    const deleted = await api.deleteResource(
      'policies',
      title.policy_id,
      current.snapshots,
    );
    assert.ok(!deleted.policies.some((p) => p.policy_id === title.policy_id));
  } finally {
    globalThis.fetch = previousFetch;
    store.close();
  }
});

test('chat reset after restart clears expired work while live work remains protected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbyeol-reset-expired-')),
    file = join(dir, 'app.sqlite');
  let store = setup(file);
  const config = readConfig(process.cwd(), {
    NODE_ENV: 'test',
    DATABASE_PATH: file,
    FLUE_DATABASE_PATH: ':memory:',
    AGENT_BACKEND: 'disabled',
    LOCAL_API_TOKEN: '',
    OPENAI_API_KEY: '',
    TYPESAFE_API_KEY: '',
  });
  const input = () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      confirm: '초기화',
      snapshots: {
        ...store.commerce.snapshots(seller),
        orders: store.source(seller, 'order').snapshot_id,
      },
    }),
  });
  try {
    store.receive(seller, {
      requestId: 'crashed',
      handle: '@sample.reset',
      text: '가상 문의',
      attachments: [],
    });
    store.beginRun(
      seller,
      'crashed',
      { messages: 40, characters: 40000, timeoutMs: -1 },
      now,
    );
    store.close();
    store = new Store(file);
    const app = createApp(store, config);
    assert.equal(
      (await app.request('/api/data/reset/chats', input())).status,
      200,
    );
    assert.equal(store.conversations(seller).length, 0);
    assert.equal(store.orders(seller).length, 6);
    store.receive(seller, {
      requestId: 'live',
      handle: '@sample.live',
      text: '진행 중인 가상 문의',
      attachments: [],
    });
    const active = store.beginRun(
      seller,
      'live',
      { messages: 40, characters: 40000, timeoutMs: 60000 },
      now,
    );
    assert.equal(
      (await app.request('/api/data/reset/chats', input())).status,
      409,
    );
    assert.equal(store.conversations(seller).length, 1);
    store.finishRun(active.id, emptyAnalysis('live'), 503);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
