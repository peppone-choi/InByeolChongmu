import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readConfig } from '../src/config.js';
import { roomDetailSchema } from '../src/domain/http-contract.js';
import { analysisSchema, emptyAnalysis } from '../src/domain/schema.js';
import { createApp } from '../src/http/app.js';
import { Store } from '../src/storage/store.js';
import { extractionExcerpts } from '../web/src/extraction-excerpts.js';

const draft = analysisSchema.parse(
  JSON.parse(readFileSync('docs/samples/analysis-example.json', 'utf8')),
).order_draft!;

test('room detail locates only supported spans, including an address correction across customer messages', async () => {
  const store = new Store(':memory:');
  const config = readConfig(process.cwd(), {
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    LOCAL_API_TOKEN: '',
    AGENT_BACKEND: 'disabled',
    OPENAI_API_KEY: '',
    TYPESAFE_API_KEY: '',
  });
  const seller = config.sellerId;
  const app = createApp(store, config);
  const handle = '@sample.hana';
  const room = store.createConversation(seller, handle);
  const receive = (requestId: string, text: string) =>
    store.receive(seller, {
      requestId,
      handle,
      text,
      attachments: [],
      conversationId: room.id,
    });
  const begin = (requestId: string, messages = 40) =>
    store.beginRun(
      seller,
      requestId,
      { messages, characters: 40000 },
      new Date(),
    );
  async function read() {
    const res = await app.request('/api/conversations/' + room.id);
    assert.equal(res.status, 200);
    const detail = roomDetailSchema.parse(await res.json());
    return detail.extraction_sources!.map(
      ({ field, message_id, start, end }) => {
        const message = detail.messages.find(({ id }) => id === message_id)!;
        assert.equal(message.role, 'customer');
        assert.ok(end <= message.text.length);
        return [
          field,
          message.request_id,
          message.text.slice(start, end),
          start,
        ];
      },
    );
  }
  try {
    store.seedSamples(config.root, seller);
    const original =
      '🌿 수령인: 샘플하나\n가상시  예시구 샘플동 101호\n  [판매자] 우편번호 12345';
    receive('first', original);
    const first = begin('first');
    store.finishRun(
      first.id,
      {
        ...emptyAnalysis('first'),
        status: 'ready_for_review',
        reply_draft: '우편번호 12345',
      },
      200,
    );
    const correction =
      '[고객] 101호 말고 202 호로요. 010-0000-1001\n[고객] 입금자: 샘플하나';
    receive('corrected', correction);
    const corrected = begin('corrected');
    assert.deepEqual(await read(), []);
    const result = {
      ...emptyAnalysis('corrected'),
      classification: 'order_request' as const,
      status: 'human_review' as const,
      order_draft: {
        ...draft,
        recipient: {
          ...draft.recipient,
          address_raw: '가상시예시구샘플동202호',
          postal_code: '12345',
        },
      },
    };
    store.finishRun(corrected.id, result, 200);
    assert.deepEqual(await read(), [
      [
        'order_draft.recipient.name',
        'first',
        '샘플하나',
        original.indexOf('샘플하나'),
      ],
      [
        'order_draft.recipient.phone_raw',
        'corrected',
        '010-0000-1001',
        correction.indexOf('010-0000-1001'),
      ],
      [
        'order_draft.recipient.address_raw',
        'first',
        '가상시  예시구 샘플동 ',
        original.indexOf('가상시'),
      ],
      [
        'order_draft.recipient.address_raw',
        'corrected',
        '202 호',
        correction.indexOf('202 호'),
      ],
      [
        'order_draft.depositor_name',
        'corrected',
        '샘플하나',
        correction.indexOf('샘플하나'),
      ],
    ]);

    receive('truncated', '샘플하나, 샘플하나\n[판매자] 수령인 샘플하나');
    const truncated = begin('truncated', 1);
    store.finishRun(truncated.id, { ...result, request_id: 'truncated' }, 200);
    assert.deepEqual(await read(), []);

    const payment =
      '[고객] 샘플입금 명의로 34000 보냈어요?\n[판매자] 샘플입금 명의로 34000 보냈어요.\n[고객] 🙏 샘플입금 명의로 34000 보냈어요.';
    receive('payment', payment);
    const paymentRun = begin('payment');
    store.finishRun(
      paymentRun.id,
      {
        ...emptyAnalysis('payment'),
        classification: 'payment_claim',
        status: 'human_review',
        payment_claim: {
          depositor_name: '샘플입금',
          customer_claimed_paid: true,
        },
      },
      200,
    );
    assert.deepEqual(await read(), [
      [
        'payment_claim.depositor_name',
        'payment',
        '샘플입금',
        payment.lastIndexOf('샘플입금'),
      ],
    ]);
  } finally {
    store.close();
  }
});

test('address preview presents all verified excerpts from separate messages in source order', () => {
  const field = 'order_draft.recipient.address_raw';
  const original = '🌿 가상시 예시구 샘플동 101호';
  const correction = '101호 말고 202 호로요.';
  const messages = [
    { id: 'original', role: 'customer', text: original },
    { id: 'correction', role: 'customer', text: correction },
  ];
  const sources = [
    {
      field,
      message_id: 'original',
      start: original.indexOf('가상시'),
      end: original.indexOf('101호'),
    },
    {
      field,
      message_id: 'correction',
      start: correction.indexOf('202 호'),
      end: correction.indexOf('로요'),
    },
  ] as const;
  assert.deepEqual(
    extractionExcerpts(messages, sources, field).map(({ text }) => text),
    ['가상시 예시구 샘플동 ', '202 호'],
  );
  assert.deepEqual(
    extractionExcerpts(messages.slice(0, 1), sources, field),
    [],
  );
});
