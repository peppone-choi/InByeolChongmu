import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import ExcelJS from 'exceljs';
import { Store } from '../src/storage/store.js';
import { Tools } from '../src/tools/registry.js';
import { createApp } from '../src/http/app.js';
import { readConfig } from '../src/config.js';
import {
  shipmentCommandSchema,
  parcelTemplateSchema,
  type ShipmentCommand,
} from '../src/domain/shipping.js';
import type { Analysis } from '../src/domain/schema.js';
import { api } from '../web/src/api.js';
const seller = 'sample-seller-01',
  now = new Date('2026-11-06T10:00:00+09:00');
function setup(file = ':memory:') {
  const store = new Store(file);
  store.seedSamples(process.cwd(), seller);
  return store;
}
const command = (version = 1): ShipmentCommand => ({
  command_id: randomUUID(),
  operation: 'register_shipment',
  expected_version: version,
  carrier: '가상택배',
  tracking_number: '001234567890',
  shipped_at: '2026-11-05T09:30:00+09:00',
});
const request = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const appFor = (store: Store, token = '') =>
  createApp(
    store,
    readConfig(process.cwd(), {
      NODE_ENV: 'test',
      AGENT_BACKEND: 'disabled',
      DATABASE_PATH: ':memory:',
      FLUE_DATABASE_PATH: ':memory:',
      LOCAL_API_TOKEN: token,
      OPENAI_API_KEY: '',
      TYPESAFE_API_KEY: '',
    }),
    { clock: () => now, maxRequests: 1000 },
  );

test('AC-18/20/21: shipment register, canonical retry and reasoned correction preserve stock and amounts', () => {
  const store = setup();
  try {
    const before = store.products(seller),
      old = store.commerce.get(seller, 'O-0002'),
      c = command();
    const first = store.commerce.shipment(
      seller,
      'O-0002',
      { ...c, carrier: ' 가상택배 ', tracking_number: ' 00123 4567890 ' },
      now,
    );
    assert.equal(first.order.status, 'shipped');
    assert.equal(first.order.version, 2);
    assert.equal(first.order.tracking_number, '001234567890');
    assert.equal(store.commerce.list(seller).length, 6);
    assert.ok(first.order.historical);
    const retry = store.commerce.shipment(
      seller,
      'O-0002',
      { ...c, shipped_at: '2026-11-05T00:30:00Z' },
      now,
    );
    assert.ok(retry.replayed);
    assert.equal(store.commerce.shipmentHistory(seller, 'O-0002').length, 1);
    assert.throws(
      () =>
        store.commerce.shipment(
          seller,
          'O-0002',
          { ...c, tracking_number: 'other' },
          now,
        ),
      /내용이 다릅니다/,
    );
    assert.throws(
      () => store.commerce.shipment(seller, 'O-0002', command(2), now),
      /이미 발송/,
    );
    const correction = store.commerce.shipment(
      seller,
      'O-0002',
      {
        ...command(2),
        operation: 'update_shipment',
        tracking_number: '000000009999',
        correction_reason: '송장 오입력 정정',
      },
      now,
    );
    assert.equal(correction.order.version, 3);
    assert.equal(correction.event.before.tracking_number, '001234567890');
    assert.equal(correction.event.after.tracking_number, '000000009999');
    assert.equal(correction.event.actor, seller);
    assert.equal(correction.event.correction_reason, '송장 오입력 정정');
    assert.deepEqual(store.products(seller), before);
    assert.deepEqual(correction.order.amounts, old.amounts);
    assert.deepEqual(correction.order.recipient, old.recipient);
    const tool = new Tools(
      store,
      seller,
      process.cwd(),
      () => now,
      '@sample.same1',
    );
    const found = tool.call('search_orders', { query: 'O-0002' }) as {
      records: Array<{ tracking_number: string }>;
    };
    assert.equal(found.records[0]!.tracking_number, '000000009999');
    assert.equal(store.exportCurrent(seller).shipment_events.length, 2);
  } finally {
    store.close();
  }
});

test('shipment workbook previews exact order IDs and commits atomically with safe retries', async () => {
  const store = setup();
  const app = appFor(store);
  try {
    const template = await app.request('/api/shipment-import/template');
    assert.equal(template.status, 200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(await template.arrayBuffer()) as never);
    const sheet = book.worksheets[0]!;
    sheet.addRow(['O-0002', '가상택배', '001234', command().shipped_at]);
    sheet.addRow(['UNKNOWN', '가상택배', '001235', command().shipped_at]);
    const preview = async () => {
      const response = await app.request('/api/shipment-import/preview', {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
        body: new Uint8Array(await book.xlsx.writeBuffer()),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const checked = await preview();
    assert.equal(checked.errors[0].row, 3);
    assert.equal(checked.entries[0].command.tracking_number, '001234');
    assert.equal(store.commerce.shipmentHistory(seller, 'O-0002').length, 0);
    const good = checked.entries[0];
    const apply = (entries: unknown[]) =>
      app.request('/api/shipment-import/apply', request({ entries }));
    const failure = await apply([
      good,
      {
        ...good,
        row: 3,
        order_id: 'UNKNOWN',
        command: { ...good.command, command_id: randomUUID() },
      },
    ]);
    assert.equal(failure.status, 404);
    assert.equal(store.commerce.shipmentHistory(seller, 'O-0002').length, 0);
    assert.deepEqual(await (await apply([good])).json(), {
      registered: 1,
      replayed: 0,
    });
    assert.deepEqual(await (await apply([good])).json(), {
      registered: 0,
      replayed: 1,
    });
    assert.equal(store.commerce.shipmentHistory(seller, 'O-0002').length, 1);
  } finally {
    store.close();
  }
});

test('AC-19: state, seller, version, missing values and future/pre-confirmation shipment times fail without writes', () => {
  const store = setup();
  try {
    const before = store.orders(seller),
      stock = store.products(seller);
    for (const id of ['O-0004', 'O-0005'])
      assert.throws(
        () => store.commerce.shipment(seller, id, command(), now),
        /확정 주문/,
      );
    assert.throws(
      () => store.commerce.shipment('other-seller', 'O-0002', command(), now),
      /찾을 수 없습니다/,
    );
    assert.throws(
      () => store.commerce.shipment(seller, 'O-0002', command(9), now),
      /변경됐습니다/,
    );
    for (const shipped_at of ['2027-01-01T00:00:00Z', '2020-01-01T00:00:00Z'])
      assert.throws(
        () =>
          store.commerce.shipment(
            seller,
            'O-0002',
            { ...command(), shipped_at },
            now,
          ),
        /발송 시각/,
      );
    for (const patch of [
      { carrier: ' ' },
      { tracking_number: ' ' },
      { shipped_at: '2026-11-05T09:30:00' },
      { operation: 'update_shipment', correction_reason: '' },
    ])
      assert.throws(() =>
        shipmentCommandSchema.parse({ ...command(), ...patch }),
      );
    assert.throws(
      () =>
        store.commerce.shipment(
          seller,
          'O-0002',
          {
            ...command(),
            operation: 'update_shipment',
            correction_reason: '미발송',
          },
          now,
        ),
      /정정은 발송/,
    );
    assert.deepEqual(store.orders(seller), before);
    assert.deepEqual(store.products(seller), stock);
    assert.equal(store.commerce.shipmentHistory(seller, 'O-0002').length, 0);
  } finally {
    store.close();
  }
});

test('AC-19/21: event insertion failure rolls back shipment, version and idempotency result; restart preserves audit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbyeol-shipment-')),
    file = join(dir, 'app.sqlite');
  let store = setup(file);
  const db = new DatabaseSync(file);
  try {
    const before = store.orders(seller),
      c = command();
    db.exec(
      "CREATE TRIGGER fail_history BEFORE INSERT ON shipment_events BEGIN SELECT RAISE(ABORT,'history failure'); END",
    );
    assert.throws(
      () => store.commerce.shipment(seller, 'O-0002', c, now),
      /history failure/,
    );
    assert.deepEqual(store.orders(seller), before);
    assert.equal(store.commerce.shipmentHistory(seller, 'O-0002').length, 0);
    db.exec('DROP TRIGGER fail_history');
    store.commerce.shipment(seller, 'O-0002', c, now);
    store.close();
    store = new Store(file);
    assert.ok(store.commerce.shipment(seller, 'O-0002', c, now).replayed);
    assert.equal(store.commerce.shipmentHistory(seller, 'O-0002').length, 1);
    assert.equal(store.seedSamples(process.cwd(), seller).inserted, 0);
  } finally {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('managed order shipment is visible through the same agent lookup and shares command keys with confirmation', () => {
  const store = setup();
  try {
    store.receive(seller, {
      requestId: 'managed',
      handle: '@sample.hana',
      text: '가상 주문',
      attachments: [],
    });
    const run = store.beginRun(
        seller,
        'managed',
        { messages: 40, characters: 40000 },
        now,
      ),
      a = JSON.parse(
        readFileSync('docs/samples/analysis-example.json', 'utf8'),
      ) as Analysis;
    a.request_id = 'managed';
    store.finishRun(run.id, a, 200);
    const saved = store.commerce.saveAnalysis(seller, 'managed', now),
      confirm = {
        command_id: randomUUID(),
        expected_version: 1,
        reviewed_snapshots: store.commerce.snapshots(seller),
        payment_checked: true as const,
        checked_amount_krw: 62000,
        checked_depositor_name: saved.depositor_name!,
        address_acknowledged: true as const,
      };
    const confirmed = store.commerce.confirm(
      seller,
      saved.order_id,
      confirm,
      now,
    );
    const stock = store.products(seller);
    assert.throws(
      () =>
        store.commerce.shipment(
          seller,
          saved.order_id,
          {
            ...command(2),
            command_id: confirm.command_id,
            shipped_at: now.toISOString(),
          },
          now,
        ),
      /내용이 다릅니다/,
    );
    const shipped = store.commerce.shipment(
      seller,
      saved.order_id,
      { ...command(2), shipped_at: now.toISOString() },
      now,
    );
    assert.equal(
      store.orders(seller).find((o) => o.order_id === saved.order_id)!
        .tracking_number,
      '001234567890',
    );
    assert.deepEqual(store.products(seller), stock);
    assert.deepEqual(shipped.order.amounts, confirmed.amounts);
  } finally {
    store.close();
  }
});

test('AC-13/14: parcel preview excludes pending, cancelled and shipped; workbook preserves string values and configured columns', async () => {
  const store = setup();
  try {
    const before = store.orders(seller),
      stock = store.products(seller),
      template = store.parcels.template(seller),
      selection = {
        template_version: template.version,
        order_ids: before.map((o) => o.order_id),
        notes: { 'O-0002': '=HYPERLINK("bad")' },
      };
    const preview = store.parcels.preview(seller, selection);
    assert.deepEqual(preview.included_order_ids.sort(), [
      'O-0002',
      'O-0003',
      'O-0006',
    ]);
    assert.equal(preview.excluded.length, 3);
    assert.equal(store.parcels.list(seller).length, 0);
    const input = {
        ...selection,
        command_id: randomUUID(),
        fingerprint: preview.fingerprint,
        acknowledge_repeat: false,
      },
      created = store.parcels.create(seller, input, now);
    assert.ok(store.parcels.create(seller, input, now).replayed);
    assert.equal(store.parcels.list(seller).length, 1);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(
      (await store.parcels.download(seller, created.export_id)) as never,
    );
    const sheet = book.getWorksheet('발송명단')!;
    assert.equal(sheet.rowCount, 4);
    assert.equal(sheet.getRow(2).getCell(3).value, '01000000002');
    assert.equal(typeof sheet.getRow(2).getCell(3).value, 'string');
    assert.equal(typeof sheet.getRow(2).getCell(8).value, 'string');
    assert.equal(sheet.getRow(2).getCell(8).formula, undefined);
    const repeated = store.parcels.preview(seller, selection);
    assert.equal(repeated.previous_exports.length, 3);
    assert.throws(
      () =>
        store.parcels.create(
          seller,
          {
            ...input,
            command_id: randomUUID(),
            fingerprint: repeated.fingerprint,
          },
          now,
        ),
      /중복 접수/,
    );
    const second = store.parcels.create(
      seller,
      {
        ...input,
        command_id: randomUUID(),
        fingerprint: repeated.fingerprint,
        acknowledge_repeat: true,
      },
      now,
    );
    assert.notEqual(second.export_id, created.export_id);
    assert.deepEqual(store.orders(seller), before);
    assert.deepEqual(store.products(seller), stock);
    const custom = structuredClone(template.template);
    custom.columns = [
      { field: 'phone', header: '받는분전화', required: true },
      { field: 'recipient_name', header: '수령인', required: true },
      { field: 'address', header: '배송주소', required: true },
      { field: 'postal_code', header: '우편번호', required: true },
    ];
    const updated = store.parcels.saveTemplate(
      seller,
      template.version,
      custom,
    );
    const missing = store.parcels.preview(seller, {
      ...selection,
      template_version: updated.version,
    });
    assert.equal(missing.rows.length, 0);
    assert.equal(missing.excluded.length, 6);
    assert.ok(missing.excluded.some((e) => e.reason.includes('우편번호')));
    assert.throws(
      () => store.parcels.saveTemplate(seller, template.version, custom),
      /변경됐습니다/,
    );
    assert.throws(() =>
      parcelTemplateSchema.parse({ ...custom, sheet_name: "'bad" }),
    );
  } finally {
    store.close();
  }
});

test('parcel preview detects a concurrent shipment/template change and order deletion invalidates stored files', async () => {
  const store = setup();
  try {
    const t = store.parcels.template(seller),
      selection = {
        template_version: t.version,
        order_ids: ['O-0002', 'O-0003'],
        notes: {},
      },
      preview = store.parcels.preview(seller, selection),
      input = {
        ...selection,
        command_id: randomUUID(),
        fingerprint: preview.fingerprint,
        acknowledge_repeat: false,
      };
    store.commerce.shipment(seller, 'O-0002', command(), now);
    assert.throws(
      () => store.parcels.create(seller, input, now),
      /바뀌었습니다/,
    );
    const latest = store.parcels.preview(seller, selection),
      record = store.parcels.create(
        seller,
        { ...input, fingerprint: latest.fingerprint },
        now,
      );
    assert.deepEqual(record.included_order_ids, ['O-0003']);
    store.commerce.remove(seller, 'O-0003', 1);
    assert.equal(store.parcels.list(seller)[0]!.download_available, false);
    await assert.rejects(
      store.parcels.download(seller, record.export_id),
      /삭제돼/,
    );
    assert.equal(
      store.parcels.list(seller)[0]!.included_order_ids[0],
      'O-0003',
    );
    store.commerce.reset(seller, store.source(seller, 'order').snapshot_id);
    assert.equal(store.parcels.list(seller).length, 0);
    assert.equal(store.exportCurrent(seller).shipment_events.length, 0);
    assert.equal(store.parcels.template(seller).version, t.version);
  } finally {
    store.close();
  }
});

test('HTTP/browser shipping and parcel APIs require auth, reject foreign origins and use persistent storage', async () => {
  const store = setup(),
    app = appFor(store),
    previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => app.request(String(input), init);
  try {
    const result = await api.shipment('O-0002', command());
    assert.equal(result.order.status, 'shipped');
    assert.equal((await api.shipmentHistory('O-0002')).length, 1);
    const template = await api.parcelTemplate(),
      selection = {
        template_version: template.version,
        order_ids: ['O-0002', 'O-0003'],
        notes: {},
      },
      preview = await api.parcelPreview(selection),
      record = await api.parcelCreate({
        ...selection,
        command_id: randomUUID(),
        fingerprint: preview.fingerprint,
        acknowledge_repeat: false,
      });
    assert.deepEqual(record.included_order_ids, ['O-0003']);
    assert.equal(
      (await app.request(`/api/parcel/exports/${record.export_id}/file`))
        .status,
      200,
    );
    const locked = appFor(store, 'a'.repeat(40));
    assert.equal(
      (await locked.request('/api/orders/O-0002/shipments')).status,
      401,
    );
    assert.equal(
      (
        await app.request('/api/orders/O-0002/shipments', {
          ...request(command()),
          headers: {
            'Content-Type': 'application/json',
            Origin: 'http://evil.example',
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request(
          '/api/orders/O-0002/shipments',
          request({ ...command(), seller_id: 'evil' }),
        )
      ).status,
      422,
    );
  } finally {
    globalThis.fetch = previousFetch;
    store.close();
  }
});

test('AC-20: two real processes registering one order commit a single shipment and event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbyeol-shipment-race-')),
    file = join(dir, 'app.sqlite'),
    store = setup(file);
  const children = [command(), command()].map((c) =>
    fork('tests/fixtures/shipment-worker.ts', [file, JSON.stringify(c)], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }),
  );
  try {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.once('message', () => resolve());
            child.once('error', reject);
            child.once('exit', (code) => {
              if (code) reject(new Error('Worker failed'));
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
    children.forEach((child) => child.send('start'));
    const done = await Promise.all(results);
    assert.equal(done.filter((v) => v === 'saved').length, 1);
    assert.equal(store.commerce.get(seller, 'O-0002').version, 2);
    assert.equal(store.commerce.shipmentHistory(seller, 'O-0002').length, 1);
  } finally {
    children.forEach((c) => c.kill());
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
