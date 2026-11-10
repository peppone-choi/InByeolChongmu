import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import {
  batchListSchema,
  batchViewSchema,
  type BatchItem,
} from '../src/domain/batch.js';
import { emptyAnalysis } from '../src/domain/schema.js';
import { AppError } from '../src/domain/errors.js';
import type { AgentRunner } from '../src/agent/types.js';
import { prepareReview } from '../src/agent/review-analysis.js';
import { validateAnalysis } from '../src/agent/validate-analysis.js';
import { customerTexts } from '../src/agent/customer-text.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { Store } from '../src/storage/store.js';
import { Tools } from '../src/tools/registry.js';

const samples = z
  .object({
    cases: z.array(
      z.object({
        case_id: z.string(),
        input: z.object({ customer_handle: z.string(), text: z.string() }),
      }),
    ),
  })
  .parse(JSON.parse(readFileSync('docs/samples/dm-cases.json', 'utf8')));

test('batch list keeps older unfinished work beyond the newest 50 receipts', async () => {
  const store = new Store(':memory:');
  try {
    const config = readConfig(process.cwd(), {
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      AGENT_BACKEND: 'disabled',
      OPENAI_API_KEY: '',
      TYPESAFE_API_KEY: '',
      LOCAL_API_TOKEN: '',
    });
    const seller = config.sellerId;
    const create = (owner = seller) =>
      store.batches.create(owner, {
        batch_id: randomUUID(),
        items: [
          { customer_handle: '@sample', context_label: '', text: '문의' },
        ],
      });
    const start = () => {
      const { batch_id, items } = create();
      const { item_id, request_id } = items[0]!;
      store.batches.claim(seller, batch_id, item_id, request_id, false);
      return { batch_id, item_id, request_id };
    };
    const finish = (retryable?: boolean) => {
      const { batch_id, item_id, request_id } = start();
      store.batches.finish(batch_id, item_id, request_id, {
        classification: null,
        analysis_status: null,
        needs_attention: retryable !== undefined,
        error:
          retryable === undefined
            ? null
            : { code: 'TEST', message: '테스트 오류', retryable },
      });
      return batch_id;
    };
    const queued = create().batch_id;
    const running = start().batch_id;
    const retryable = finish(true);
    const finalFailure = finish(false);
    const completed = finish();
    const recent = Array.from({ length: 50 }, () => finish());
    const otherSeller = create('different-seller').batch_id;
    const app = createApp(store, config);
    const response = await app.request('/api/dm-batches');
    assert.equal(response.status, 200);
    const ids = batchListSchema
      .parse(await response.json())
      .batches.map(({ batch_id }) => batch_id);
    assert.deepEqual(ids, [...recent.toReversed(), retryable, running, queued]);
    for (const hidden of [finalFailure, completed, otherSeller])
      assert.ok(!ids.includes(hidden));
    const detail = await app.request('/api/dm-batches/' + queued);
    assert.equal(detail.status, 200);
    assert.equal(
      batchViewSchema.parse(await detail.json()).items[0]?.status,
      'queued',
    );
    assert.equal(store.batches.export(seller).length, 55);
  } finally {
    store.close();
  }
});

test('AC-15: durable mixed batch isolates rooms, continues after failures and retries one item', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbyeol-batch-'));
  const path = join(dir, 'data.sqlite');
  const root = process.cwd();
  const config = readConfig(root, {
    NODE_ENV: 'test',
    DATABASE_PATH: path,
    AGENT_BACKEND: 'disabled',
    OPENAI_API_KEY: '',
    TYPESAFE_API_KEY: '',
    LOCAL_API_TOKEN: '',
  });
  const seller = config.sellerId;
  let store = new Store(path);
  const calls: string[] = [];
  let failOrder = true;
  let release!: () => void;
  let started!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const ids = ['DM-001', 'DM-002', 'DM-009', 'DM-020'];
  const input = {
    batch_id: randomUUID(),
    items: ids.map((case_id) => ({
      ...samples.cases.find((sample) => sample.case_id === case_id)!.input,
      context_label: case_id,
    })),
  };
  const runner: AgentRunner = {
    readiness: () => ({ ready: true, code: null }),
    stop: () => Promise.resolve(),
    resetHistory: () => Promise.resolve(),
    async run(run) {
      const { context_label, customer_handle } = run.input;
      calls.push(context_label);
      const original = input.items.find(
        (entry) => entry.context_label === context_label,
      )!;
      assert.equal(original.customer_handle, customer_handle);
      assert.ok(
        run.input.history
          .filter(({ role }) => role === 'customer')
          .every(({ text }) => text === original.text),
      );
      if (context_label === 'DM-001') {
        started();
        await barrier;
      }
      if (context_label === 'DM-002' && failOrder) {
        failOrder = false;
        throw new AppError('MODEL_CALL_LIMIT', '테스트용 모델 한도', 503);
      }
      const tools = new Tools(
        store,
        seller,
        root,
        undefined,
        customer_handle,
        customerTexts(run.input),
      );
      const result = {
        ...emptyAnalysis(run.request_id),
        status: 'ready_for_review' as const,
      };
      if (context_label === 'DM-009') {
        store.traceTool(
          run.id,
          'lookup',
          'search_orders',
          true,
          tools.call('search_orders', { query: '샘플동명' }),
          16,
        );
        return validateAnalysis(
          store,
          run,
          prepareReview(store, run, {
            ...result,
            classification: 'order_lookup',
          }),
        );
      }
      store.traceTool(
        run.id,
        'lookup',
        'search_products',
        true,
        tools.call('search_products', { query: '니트' }),
        16,
      );
      return validateAnalysis(
        store,
        run,
        prepareReview(store, run, {
          ...result,
          classification:
            context_label === 'DM-002' ? 'order_request' : 'product_inquiry',
          product_candidates: ['P001'],
        }),
      );
    },
  };
  const newApp = () =>
    createApp(store, config, {
      runner,
      clock: () => new Date('2026-11-05T00:00:00Z'),
    });
  let app = newApp();
  const post = (route: string, data: unknown) =>
    app.request(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  const pathFor = '/api/dm-batches/' + input.batch_id;
  const responseBatch = async (response: Response) => {
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return batchViewSchema.parse(body);
  };
  const run = (item: BatchItem, retry = false) =>
    post(pathFor + '/items/' + item.item_id + '/process', {
      request_id: item.request_id,
      retry,
    });
  try {
    store.seedSamples(root, seller);
    const initial = store.commerce.snapshots(seller);
    const created = await responseBatch(await post('/api/dm-batches', input));
    const [a, b, c, d] = created.items;
    assert.ok(a && b && c && d);
    assert.deepEqual(
      await responseBatch(await post('/api/dm-batches', input)),
      created,
    );
    assert.equal(
      (await post('/api/dm-batches', { ...input, items: input.items.slice(1) }))
        .status,
      409,
    );
    assert.equal(
      (
        await post('/api/dm-batches', {
          batch_id: randomUUID(),
          items: Array(11).fill(input.items[0]),
        })
      ).status,
      422,
    );
    assert.throws(() => store.batches.get('another-seller', input.batch_id), {
      code: 'BATCH_NOT_FOUND',
    });
    assert.equal((await run(c)).status, 409);
    const first = run(a);
    await running;
    assert.equal(
      (await responseBatch(await app.request(pathFor))).items[0]?.status,
      'running',
    );
    assert.equal((await run(b)).status, 409);
    assert.equal(
      (
        await post('/api/data/reset/chats', {
          confirm: '초기화',
          snapshots: {
            ...initial,
            orders: store.source(seller, 'order').snapshot_id,
          },
        })
      ).status,
      409,
    );
    release();
    await responseBatch(await first);
    await responseBatch(await run(a));
    await responseBatch(await run(b));
    const interrupted = store.batches.claim(
      seller,
      input.batch_id,
      c.item_id,
      c.request_id,
      false,
    )!;
    // Simulate a process exit after the chat result committed and before the batch status was written.
    const chatResponse = await post('/api/chat', {
      schema_version: '0.1',
      request_id: c.request_id,
      conversation_id: interrupted.conversation_id,
      customer_handle: c.customer_handle,
      text: c.text,
    });
    assert.equal(
      chatResponse.status,
      200,
      JSON.stringify(await chatResponse.json()),
    );
    store.close();
    store = new Store(path);
    app = newApp();
    assert.equal(
      (await responseBatch(await app.request(pathFor))).items[2]?.status,
      'running',
    );
    assert.deepEqual(calls, ids.slice(0, 3));
    await responseBatch(await run(c));
    const done = await responseBatch(await run(d));
    assert.deepEqual(
      done.items.map(({ status }) => status),
      ['completed', 'failed', 'completed', 'failed'],
    );
    assert.equal(done.items[3]?.outcome?.error?.code, 'HANDLE_REQUIRED');
    assert.equal(done.items[3]?.conversation_id, null);
    const roomC = done.items[2]?.conversation_id;
    assert.ok(roomC);
    const analysisC = store.runForRequest(seller, c.request_id)?.analysis;
    assert.deepEqual(analysisC?.order_candidates, ['O-0002', 'O-0003']);
    assert.equal(analysisC?.reply_draft, null);
    assert.equal(analysisC?.order_draft, null);
    const retry = await responseBatch(await run(done.items[1]!, true));
    assert.notEqual(retry.items[1]?.request_id, b.request_id);
    assert.equal(
      retry.items[1]?.conversation_id,
      done.items[1]?.conversation_id,
    );
    assert.equal(retry.items[1]?.status, 'completed');
    await responseBatch(await run(done.items[1]!, true));
    assert.deepEqual(calls, ['DM-001', 'DM-002', 'DM-009', 'DM-002']);
    assert.equal(
      new Set(
        retry.items.flatMap(({ conversation_id }) => conversation_id ?? []),
      ).size,
      3,
    );
    assert.deepEqual(store.commerce.snapshots(seller), initial);
    assert.equal(
      store.exportCurrent(seller).dm_batches[0]?.batch_id,
      input.batch_id,
    );
    const reset = await post('/api/data/reset/chats', {
      confirm: '초기화',
      snapshots: {
        ...initial,
        orders: store.source(seller, 'order').snapshot_id,
      },
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(store.batches.list(seller), []);
    assert.equal(store.conversations(seller).length, 0);
    assert.deepEqual(store.commerce.snapshots(seller), initial);
  } finally {
    release();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
