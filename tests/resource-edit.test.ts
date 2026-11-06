import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage/store.js';
import { createApp } from '../src/http/app.js';
import { readConfig } from '../src/config.js';
import { Tools } from '../src/tools/registry.js';
import {
  resourcesSchema,
  roomDetailSchema,
} from '../src/domain/http-contract.js';
import { emptyAnalysis } from '../src/domain/schema.js';
import { validateAnalysis } from '../src/agent/validate-analysis.js';
import { analysisIsStale } from '../web/src/resource-version.js';
const root = process.cwd(),
  seller = 'sample-seller-01';
const put = (body: unknown) => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
function setup(path = ':memory:') {
  const store = new Store(path);
  store.seedSamples(root, seller);
  const config = readConfig(root, {
    NODE_ENV: 'test',
    AGENT_BACKEND: 'disabled',
    LOCAL_API_TOKEN: '',
    OPENAI_API_KEY: '',
    TYPESAFE_API_KEY: '',
  });
  return {
    store,
    config,
    app: createApp(store, config),
    tools: new Tools(
      store,
      seller,
      root,
      () => new Date('2026-11-05T10:00:00+09:00'),
    ),
  };
}

test('seller product and policy forms persist atomically and tools use updated numbers without changing historical orders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbyeol-edits-')),
    file = join(dir, 'app.sqlite'),
    { store, app, tools } = setup(file);
  try {
    const orders = store.orders(seller),
      products = store.products(seller),
      product = products[0]!;
    product.name = '수정 니트';
    product.variants[0]!.unit_price_krw = 35000;
    product.variants[0]!.stock_available = 9;
    const productResponse = await app.request(
      '/api/resources/products/' + product.product_id,
      put({
        snapshot_id: store.source(seller, 'product').snapshot_id,
        product,
      }),
    );
    assert.equal(productResponse.status, 200);
    const saved = resourcesSchema.parse(await productResponse.json());
    assert.equal(saved.products[0]!.variants[0]!.stock_available, 9);
    const shipping = store
      .policies(seller)
      .find((p) => p.shipping_fee_krw !== undefined)!;
    shipping.shipping_fee_krw = 4500;
    shipping.rule = '배송비 무료라고 잘못 쓴 문구';
    const policyResponse = await app.request(
      '/api/resources/policies/' + shipping.policy_id,
      put({ snapshot_id: saved.snapshots.policies, policy: shipping }),
    );
    assert.equal(policyResponse.status, 200);
    const resources = resourcesSchema.parse(await policyResponse.json());
    assert.match(
      resources.policies.find((p) => p.policy_id === shipping.policy_id)!.rule,
      /4,500/,
    );
    assert.ok(!JSON.stringify(resources.policies).includes('무료라고'));
    const quote = tools.call('quote_order', {
      items: [{ sku: product.variants[0]!.sku, quantity: 1 }],
    }) as { amounts: { total_krw: number } };
    assert.equal(quote.amounts.total_krw, 39500);
    assert.deepEqual(store.orders(seller), orders);
    const reopened = new Store(file);
    try {
      assert.equal(reopened.products(seller)[0]!.name, '수정 니트');
      assert.equal(
        reopened.source(seller, 'policy').snapshot_id,
        resources.snapshots.policies,
      );
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale edits and invalid changes never overwrite current records or versions', async () => {
  const { store, app } = setup();
  try {
    const baseline = resourcesSchema.parse(
        await (await app.request('/api/resources')).json(),
      ),
      p = structuredClone(baseline.products[0]!);
    p.name = '먼저 저장';
    assert.equal(
      (
        await app.request(
          '/api/resources/products/' + p.product_id,
          put({ snapshot_id: baseline.snapshots.products, product: p }),
        )
      ).status,
      200,
    );
    p.name = '오래된 창';
    assert.equal(
      (
        await app.request(
          '/api/resources/products/' + p.product_id,
          put({ snapshot_id: baseline.snapshots.products, product: p }),
        )
      ).status,
      409,
    );
    assert.equal(store.products(seller)[0]!.name, '먼저 저장');
    const snapshot = store.source(seller, 'product').snapshot_id,
      invalid = structuredClone(p);
    invalid.product_id = 'renamed';
    assert.equal(
      (
        await app.request(
          '/api/resources/products/' + p.product_id,
          put({ snapshot_id: snapshot, product: invalid }),
        )
      ).status,
      422,
    );
    invalid.product_id = p.product_id;
    invalid.variants[0]!.stock_available = -1;
    assert.equal(
      (
        await app.request(
          '/api/resources/products/' + p.product_id,
          put({ snapshot_id: snapshot, product: invalid }),
        )
      ).status,
      422,
    );
    assert.equal(store.source(seller, 'product').snapshot_id, snapshot);
    const policy = store
        .policies(seller)
        .find((p) => p.discount_krw !== undefined)!,
      policySnapshot = store.source(seller, 'policy').snapshot_id;
    policy.discount_krw = 999999999;
    assert.equal(
      (
        await app.request(
          '/api/resources/policies/' + policy.policy_id,
          put({ snapshot_id: policySnapshot, policy }),
        )
      ).status,
      422,
    );
    assert.equal(store.source(seller, 'policy').snapshot_id, policySnapshot);
    policy.discount_krw = 3000;
    policy.product_id = 'other-seller-product';
    assert.equal(
      (
        await app.request(
          '/api/resources/policies/' + policy.policy_id,
          put({ snapshot_id: policySnapshot, policy }),
        )
      ).status,
      422,
    );
  } finally {
    store.close();
  }
});

test('write endpoints reject missing auth, foreign origins, non-JSON and additional seller fields', async () => {
  const { store, config } = setup();
  const app = createApp(store, { ...config, apiToken: 'protected-token' });
  try {
    const product = store.products(seller)[0]!,
      input = {
        snapshot_id: store.source(seller, 'product').snapshot_id,
        product,
      },
      path = '/api/resources/products/' + product.product_id;
    assert.equal((await app.request(path, put(input))).status, 401);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer protected-token',
    };
    assert.equal(
      (
        await app.request(path, {
          ...put(input),
          headers: { ...headers, Origin: 'http://evil.test' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request(path, {
          method: 'PUT',
          headers: { Authorization: 'Bearer protected-token' },
          body: JSON.stringify(input),
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await app.request(path, {
          ...put({ ...input, seller_id: 'other' }),
          headers,
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await app.request('/api/resources/products/other-id', {
          ...put(input),
          headers,
        })
      ).status,
      404,
    );
  } finally {
    store.close();
  }
});

test('changed sources invalidate in-flight submissions and saved drafts while restoring original run versions', async () => {
  const { store, app } = setup();
  try {
    const received = store.receive(seller, {
        requestId: 'draft',
        handle: '@sample.version',
        text: '상품 문의',
        attachments: [],
      }),
      run = store.beginRun(
        seller,
        'draft',
        { messages: 40, characters: 40000 },
        new Date(),
      );
    const analysis = emptyAnalysis('draft');
    analysis.classification = 'unrelated';
    analysis.status = 'ignored';
    const before = resourcesSchema.parse(
      await (await app.request('/api/resources')).json(),
    );
    const product = store.products(seller)[0]!;
    product.name = '변경';
    store.updateProduct(
      seller,
      product.product_id,
      before.snapshots.products,
      product,
    );
    assert.throws(() => validateAnalysis(store, run, analysis), /자료가 변경/);
    store.finishRun(run.id, analysis, 200);
    const latest = roomDetailSchema.parse(
      await (
        await app.request('/api/conversations/' + received.conversation.id)
      ).json(),
    ).latest;
    assert.equal(latest?.snapshots?.products, before.snapshots.products);
    assert.equal(analysisIsStale(latest, before), false);
    const current = resourcesSchema.parse(
      await (await app.request('/api/resources')).json(),
    );
    assert.equal(analysisIsStale(latest, current), true);
  } finally {
    store.close();
  }
});

test('policy edits preserve calculation kinds and validate dispatch dates and free text', async () => {
  const { store, app } = setup();
  try {
    const policies = store.policies(seller),
      shipping = policies.find((p) => p.shipping_fee_krw !== undefined)!,
      revision = store.source(seller, 'policy').snapshot_id;
    assert.equal(
      (
        await app.request(
          '/api/resources/policies/' + shipping.policy_id,
          put({
            snapshot_id: revision,
            policy: { ...shipping, discount_krw: 100 },
          }),
        )
      ).status,
      422,
    );
    const tone = policies.find((p) => p.policy_id === 'POL-TONE')!;
    assert.equal(
      (
        await app.request(
          '/api/resources/policies/' + tone.policy_id,
          put({ snapshot_id: revision, policy: { ...tone, rule: '   ' } }),
        )
      ).status,
      422,
    );
    const date = policies.find((p) => p.next_dispatch_date)!;
    assert.equal(
      (
        await app.request(
          '/api/resources/policies/' + date.policy_id,
          put({
            snapshot_id: revision,
            policy: { ...date, next_dispatch_date: '2026-02-30' },
          }),
        )
      ).status,
      422,
    );
    assert.equal(store.source(seller, 'policy').snapshot_id, revision);
  } finally {
    store.close();
  }
});
