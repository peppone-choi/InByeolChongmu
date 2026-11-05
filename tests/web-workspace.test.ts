import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Workspace } from '../web/src/workspace.js';
import { ApiError, type Api } from '../web/src/api.js';
import type {
  ChatResult,
  RoomDetail,
  RoomSummary,
} from '../src/domain/http-contract.js';
import type { ChatRequest } from '../src/domain/schema.js';
import { emptyAnalysis } from '../src/domain/schema.js';
function fixture() {
  const rooms: RoomSummary[] = ['a', 'b'].map((id) => ({
    id,
    seller_id: 'seller',
    customer_handle: '@sample.' + id,
    context_label: id,
    created_at: new Date().toISOString(),
    latest: null,
  }));
  const details: Record<string, RoomDetail> = Object.fromEntries(
    rooms.map((room) => [
      room.id,
      { conversation: room, messages: [], latest: null },
    ]),
  );
  const calls: ChatRequest[] = [];
  let handler: (input: ChatRequest) => Promise<ChatResult> = async (input) =>
    result(input);
  const transport: Omit<Api, 'updateProduct' | 'updatePolicy'> = {
    session: async () => ({
      authenticated: true,
      authentication_required: false,
      method: 'none',
    }),
    login: async () => ({
      authenticated: true,
      authentication_required: true,
      method: 'session',
    }),
    health: async () => ({
      status: 'data_ready',
      model_configured: true,
      model_status: null,
      agent_backend: 'flue',
      agent_model: 'test',
      typesafe_configured: false,
      agent_timeout_ms: 1000,
      sqlite: true,
    }),
    resources: async () => ({
      products: [],
      policies: [],
      snapshots: { products: 'p', policies: 'r', orders: 'o' },
    }),
    rooms: async () => rooms,
    room: async (id) => structuredClone(details[id]!),
    create: async () => rooms[0]!,
    chat: async (input) => {
      calls.push(input);
      const value = await handler(input);
      details[input.conversation_id!]!.latest = {
        request_id: input.request_id!,
        text: input.text,
        status: value.analysis.status === 'failed' ? 'failed' : 'succeeded',
        expires_at: null,
        http_status: 200,
        analysis: value.analysis,
        execution: value.execution ?? null,
      };
      return value;
    },
  };
  let seq = 0;
  const workspace = new Workspace(transport, () => `request-${++seq}`);
  return {
    workspace,
    calls,
    details,
    setHandler: (next: typeof handler) => {
      handler = next;
    },
  };
}
function result(input: ChatRequest, failed = false): ChatResult {
  const analysis = emptyAnalysis(input.request_id!);
  analysis.status = failed ? 'failed' : 'ready_for_review';
  analysis.reply_draft = failed ? null : '결과 ' + input.conversation_id;
  return {
    conversation_id: input.conversation_id!,
    replayed: false,
    analysis,
    execution: {
      run_id: 'run',
      runtime: 'flue',
      model_calls: 1,
      tool_calls: [],
    },
  };
}

test('room switches keep async results scoped and duplicate sends are suppressed', async () => {
  const f = fixture();
  await f.workspace.start();
  let resolve!: (result: ChatResult) => void;
  f.setHandler(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const sending = f.workspace.send('a', '주문');
  await f.workspace.send('a', '중복');
  await f.workspace.select('b');
  resolve(result(f.calls[0]!));
  await sending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.workspace.getSnapshot().activeId, 'b');
  assert.equal(
    f.workspace.getSnapshot().details.a?.latest?.analysis?.reply_draft,
    '결과 a',
  );
  assert.equal(f.workspace.getSnapshot().details.b?.latest, null);
});
test('unknown network outcome retries same request; terminal failure explicitly gets a new request', async () => {
  const f = fixture();
  await f.workspace.start();
  f.setHandler(async () => {
    throw new ApiError('network');
  });
  await f.workspace.send('a', '주문');
  const first = f.calls[0]!.request_id;
  f.details.a!.latest = {
    request_id: first!,
    text: '주문',
    status: 'running',
    expires_at: null,
    http_status: null,
    analysis: null,
    execution: null,
  };
  await f.workspace.refresh('a');
  assert.equal(f.workspace.getSnapshot().pending.a?.error, 'network');

  f.setHandler(async (input) => result(input, true));
  await f.workspace.retry('a');
  assert.equal(f.calls[1]!.request_id, first);
  f.setHandler(async (input) => result(input));
  await f.workspace.retry('a');
  assert.notEqual(f.calls[2]!.request_id, first);
  assert.equal(f.workspace.getSnapshot().pending.a?.error, null);
});
test('reload restores saved result without invoking model; interrupted run resumes its original request', async () => {
  const f = fixture(),
    analysis = emptyAnalysis('saved');
  analysis.status = 'ready_for_review';
  analysis.reply_draft = 'saved draft';
  f.details.a!.latest = {
    request_id: 'saved',
    text: 'saved text',
    status: 'succeeded',
    expires_at: null,
    http_status: 200,
    analysis,
    execution: null,
  };
  await f.workspace.start();
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.workspace.getSnapshot().details.a?.latest?.analysis?.reply_draft,
    'saved draft',
  );
  f.details.a!.latest = {
    ...f.details.a!.latest,
    status: 'running',
    analysis: null,
  };
  await f.workspace.select('a');
  await f.workspace.retry('a');
  assert.equal(f.calls[0]!.request_id, 'saved');
});

test('explicit reanalysis after source edits creates a new request instead of replaying a saved success', async () => {
  const f = fixture();
  await f.workspace.start();
  await f.workspace.send('a', '주문');
  const first = f.calls[0]!.request_id;
  await f.workspace.reanalyze('a');
  assert.notEqual(f.calls[1]!.request_id, first);
  assert.equal(f.calls[1]!.text, '주문');
});
