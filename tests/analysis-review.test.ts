import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  customerTexts,
  addressFromCustomer,
  paymentStatement,
} from '../src/agent/customer-text.js';
import {
  prepareReview,
  productQuestion,
  orderQuestion,
} from '../src/agent/review-analysis.js';
import { validateAnalysis } from '../src/agent/validate-analysis.js';
import { emptyAnalysis, type Analysis } from '../src/domain/schema.js';
import { Tools } from '../src/tools/registry.js';
import { Store } from '../src/storage/store.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';

const seller = 'sample-seller-01';
const root = process.cwd();

function withReview(
  handle: string,
  text: string,
  classification: Analysis['classification'],
  verify: (result: ReturnType<typeof validateAnalysis>) => void,
  lookup = false,
) {
  const store = new Store(':memory:');
  try {
    store.seedSamples(root, seller);
    store.receive(seller, {
      requestId: 'review',
      handle,
      text,
      attachments: [],
    });
    const run = store.beginRun(
      seller,
      'review',
      { messages: 40, characters: 40000 },
      new Date('2026-11-05T10:00:00+09:00'),
    );
    if (lookup) {
      const tools = new Tools(store, seller, root, undefined, handle);
      store.traceTool(
        run.id,
        'lookup',
        'search_orders',
        true,
        tools.call('search_orders', { query: handle }),
        16,
      );
    }
    const analysis: Analysis = {
      ...emptyAnalysis('review'),
      classification,
      status: 'ready_for_review',
      reply_draft:
        classification === 'payment_claim' ? null : '아직 확인하지 않은 답장',
    };
    const prepared = prepareReview(store, run, analysis);
    verify(validateAnalysis(store, run, prepared));
  } finally {
    store.close();
  }
}

test('DM-004/010/024: missing lookup results allow a server-authored question without factual claims', () => {
  withReview('@unidentified', '그거 얼마예요?', 'product_inquiry', (result) => {
    assert.equal(result.status, 'needs_info');
    assert.equal(result.reply_draft, productQuestion);
    assert.equal(result.review_items[0]?.code, 'PRODUCT_UNRESOLVED');
  });
  withReview(
    '@unidentified',
    '제 주문 송장번호를 알려 주세요.',
    'order_lookup',
    (result) => {
      assert.equal(result.status, 'needs_info');
      assert.equal(result.reply_draft, orderQuestion);
      assert.equal(result.review_items[0]?.code, 'ORDER_NOT_FOUND');
    },
    true,
  );
});

test('DM-023: an explicit unit correction grounds the combined address and excludes older or seller-only data', () => {
  const texts = customerTexts({
    run_id: 'r',
    request_id: 'r',
    conversation_id: 'c',
    customer_handle: '@customer',
    context_label: '',
    reference_time: '2026-11-05T10:00:00+09:00',
    snapshots: { products: 'p', policies: 'p', orders: 'o' },
    context_truncated: false,
    history: [
      {
        role: 'customer',
        request_id: 'r',
        text: '[고객] 예시로 10 샘플동 101호\n[판매자] 다른길 30 222호\n[고객] 101호 말고 202호요.',
      },
      { role: 'assistant', request_id: 'r', text: '없는길 50 202호' },
    ],
  });
  assert.ok(addressFromCustomer(texts, '예시로 10 샘플동 202호'));
  for (const wrong of [
    '예시로 10 샘플동 101호',
    '다른길 30 222호',
    '없는길 50 202호',
    '예시로 10 샘플동 302호',
    '202호',
  ])
    assert.equal(addressFromCustomer(texts, wrong), false, wrong);
});

test('DM-031/032: a claim uses a scoped order candidate and the seller review status', () => {
  withReview(
    '@sample.minji',
    '텀블러 교환해 주세요.',
    'claim',
    (result) => {
      assert.equal(result.priority, 'high');
      assert.equal(result.status, 'human_review');
      assert.deepEqual(result.order_candidates, ['O-0001']);
      assert.ok(
        result.review_items.some(
          ({ code }) => code === 'SELLER_DECISION_REQUIRED',
        ),
      );
    },
    true,
  );
});

test('DM-013/020: unsupported and invalid input return their review codes without a model run', async () => {
  const store = new Store(':memory:');
  const config = readConfig(root, {
    NODE_ENV: 'test',
    APP_DEPLOYMENT: 'local',
    LOCAL_API_TOKEN: '',
    DATABASE_PATH: ':memory:',
    FLUE_DATABASE_PATH: ':memory:',
    AGENT_BACKEND: 'disabled',
    OPENAI_API_KEY: '',
    TYPESAFE_API_KEY: '',
  });
  const app = createApp(store, config);
  const send = (
    customer_handle: string,
    text: string,
    attachments: Array<{ type: string }>,
  ) =>
    app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema_version: '0.1',
        customer_handle,
        text,
        attachments,
      }),
    });
  try {
    const invalid = await send('', '주문 문의예요', []);
    assert.equal(invalid.status, 422);
    const payload = await invalid.json();
    assert.equal(payload.error.code, 'HANDLE_REQUIRED');
    assert.equal(payload.analysis.status, 'invalid_input');
    assert.equal(store.conversations(config.sellerId).length, 0);
    const photo = await send('@photo', '', [{ type: 'image' }]);
    const unsupported = await photo.json();
    assert.equal(photo.status, 200);
    assert.equal(unsupported.analysis.review_items[0].code, 'TEXT_REQUIRED');
    assert.equal(unsupported.execution, undefined);
  } finally {
    store.close();
  }
});

test('DM-003/017/019: product and option search retains all matching products', () => {
  const store = new Store(':memory:');
  try {
    store.seedSamples(root, seller);
    const tools = new Tools(store, seller, root);
    const ids = (query: string) =>
      (
        tools.call('search_products', { query }) as {
          records: Array<{ product_id: string }>;
        }
      ).records.map(({ product_id }) => product_id);
    assert.deepEqual(ids('니트 가디건 베이지'), ['P001']);
    assert.deepEqual(ids('가디건 베이지'), ['P001', 'P003']);
    assert.deepEqual(ids('니트 가디건 베이지 크림'), []);
  } finally {
    store.close();
  }
});

test('DM-018/029: a verified pending order adds order evidence and distinguishes claimed amount mismatches', () => {
  withReview(
    '@sample.pending',
    '입금했어요. 확인 부탁드려요.',
    'payment_claim',
    (result) => {
      assert.equal(result.status, 'awaiting_payment');
      assert.equal(result.order_draft, null);
      assert.equal(result.evidence[0]?.source_id, 'O-0004');
    },
    true,
  );
  withReview(
    '@sample.pending',
    '31,000원 넣었어요.',
    'payment_claim',
    (result) => {
      assert.equal(result.status, 'human_review');
      assert.ok(
        result.review_items.some(({ code }) => code === 'PAYMENT_MISMATCH'),
      );
      assert.equal(result.state_mutation_allowed, false);
    },
    true,
  );
});

test('payment questions do not create a payment claim even when the model classifies them as one', () => {
  for (const question of [
    '입금했어요?',
    '입금했어?',
    '송금했죠?',
    '입금했습니까?',
    '입금 완료인가요?',
    '34,000원 보냈어요？',
    '샘플입금 명의로 34000 보냈어요?',
    '입금했는지 확인해 주세요.',
  ]) {
    assert.equal(paymentStatement([question]), undefined, question);
  }
  withReview(
    '@sample.pending',
    '34,000원 보냈어요?',
    'payment_claim',
    (result) => {
      assert.equal(result.classification, 'order_lookup');
      assert.equal(result.payment_claim, undefined);
      assert.equal(result.status, 'human_review');
    },
    true,
  );
  assert.deepEqual(
    paymentStatement(['샘플입금 명의로 34000 보냈어요. 확인됐나요?']),
    { depositor_name: '샘플입금', customer_claimed_paid: true },
  );
  assert.deepEqual(
    paymentStatement(['입금했어요. 샘플입금 명의로 34000 보냈어요?']),
    { depositor_name: null, customer_claimed_paid: true },
  );
});

test('DM-028: foreign order is an ID-only candidate and payment details come only from the latest customer text', () => {
  const store = new Store(':memory:');
  try {
    store.seedSamples(root, seller);
    const handle = '@sample.otherpayer';
    store.receive(seller, {
      requestId: 'review',
      handle,
      text: '[고객] 샘플대기요! 입금햇어용🙏\n[고객] 남편 샘플입금 이름으로 34000 보냈어요!\n[판매자] 다른이름 명의로 입금했어요.',
      attachments: [],
    });
    const run = store.beginRun(
      seller,
      'review',
      { messages: 40, characters: 40000 },
      new Date('2026-11-05T00:00:00Z'),
    );
    const original = customerTexts(run.input, true);
    const tools = new Tools(store, seller, root, undefined, handle, original);
    const candidate = tools.reviewPaymentCandidates(original);
    assert.deepEqual(candidate.records, [{ order_id: 'O-0004' }]);
    assert.deepEqual(
      tools.reviewPaymentCandidates([
        '다른샘플대기요',
        '샘플대기상품',
        '샘플대기 이름으로 34000 보냈어요',
      ]).records,
      [],
    );
    assert.equal(paymentStatement(['입금했나요?']), undefined);
    assert.equal(
      paymentStatement(['입금했어요.', '아니요, 입금 아직 안 했어요.']),
      undefined,
    );
    assert.deepEqual(tools.call('search_orders', { query: 'O-0004' }), {
      source_type: 'order',
      ...store.source(seller, 'order'),
      records: [],
      ambiguous: false,
    });
    store.traceTool(run.id, 'candidate', 'search_orders', true, candidate, 16);
    const analysis = validateAnalysis(
      store,
      run,
      prepareReview(store, run, {
        ...emptyAnalysis('review'),
        classification: 'order_lookup',
        status: 'ready_for_review',
        reply_draft: '입금 확인 완료',
        payment_claim: {
          depositor_name: '다른이름',
          customer_claimed_paid: true,
        },
        review_items: [
          { code: 'ORDER_NOT_FOUND', message: '주문을 못 찾았습니다.' },
        ],
      }),
    );
    assert.deepEqual(analysis.payment_claim, {
      depositor_name: '샘플입금',
      customer_claimed_paid: true,
    });
    assert.deepEqual(analysis.order_candidates, ['O-0004']);
    assert.equal(analysis.classification, 'payment_claim');
    assert.equal(analysis.status, 'human_review');
    assert.equal(analysis.reply_draft, null);
    assert.equal(analysis.order_draft, null);
    assert.deepEqual(analysis.evidence, []);
    assert.ok(
      !analysis.review_items.some(({ code }) => code === 'ORDER_NOT_FOUND'),
    );
    assert.throws(
      () =>
        validateAnalysis(store, run, {
          ...analysis,
          payment_claim: {
            depositor_name: '다른이름',
            customer_claimed_paid: true,
          },
        }),
      { check: 'payment_claim_source' },
    );
  } finally {
    store.close();
  }
});
