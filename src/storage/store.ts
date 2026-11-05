import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Analysis } from '../domain/schema.js';
import type { AgentRun, RunInput, ToolTrace } from '../agent/types.js';
import { AppError } from '../domain/errors.js';
import {
  productSchema,
  policySchema,
  orderSchema,
  type Product,
  type Policy,
  type Order,
} from '../domain/schema.js';

export type SourceType = 'product' | 'policy' | 'order';
const schemas = {
  product: productSchema,
  policy: policySchema,
  order: orderSchema,
};
const sourceFiles = {
  product: ['products.json', 'products', 'product_id'],
  policy: ['policies.json', 'policies', 'policy_id'],
  order: ['orders.json', 'orders', 'order_id'],
} as const;
const snapshotSchema = z.object({
  schema_version: z.literal('0.1'),
  synthetic: z.literal(true),
  seller_id: z.string().min(1),
  snapshot_id: z.string().min(1),
  reference_time: z.iso.datetime({ offset: true }),
});
export type Conversation = {
  id: string;
  seller_id: string;
  customer_handle: string;
  context_label: string;
  created_at: string;
};
export type Message = {
  id: string;
  conversation_id: string;
  request_id: string;
  role: 'customer' | 'assistant';
  text: string;
  created_at: string;
};

export class Store {
  private readonly db: DatabaseSync;
  constructor(public readonly path: string) {
    if (path !== ':memory:')
      mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS sources(seller_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('product','policy','order')), snapshot_id TEXT NOT NULL, reference_time TEXT NOT NULL, PRIMARY KEY(seller_id,type)) STRICT;
      CREATE TABLE IF NOT EXISTS records(seller_id TEXT NOT NULL, type TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(seller_id,type,id), FOREIGN KEY(seller_id,type) REFERENCES sources(seller_id,type)) STRICT;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, customer_handle TEXT NOT NULL, context_label TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS conversation_scope ON conversations(seller_id,customer_handle);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), seller_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('customer','assistant')), text TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(seller_id,request_id,role)) STRICT;
      INSERT OR IGNORE INTO schema_migrations VALUES(1);
      CREATE TABLE IF NOT EXISTS agent_runs(id TEXT PRIMARY KEY,seller_id TEXT NOT NULL,request_id TEXT NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id),status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),input TEXT NOT NULL CHECK(json_valid(input)),analysis TEXT,proposed TEXT,http_status INTEGER,model_calls INTEGER NOT NULL DEFAULT 0,UNIQUE(seller_id,request_id)) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_room_run ON agent_runs(seller_id,conversation_id) WHERE status='running';
      CREATE TABLE IF NOT EXISTS agent_tool_calls(run_id TEXT NOT NULL REFERENCES agent_runs(id),call_id TEXT NOT NULL,name TEXT NOT NULL,success INTEGER NOT NULL,result TEXT NOT NULL CHECK(json_valid(result)),PRIMARY KEY(run_id,call_id)) STRICT;
      INSERT OR IGNORE INTO schema_migrations VALUES(2);`);
  }
  close() {
    this.db.close();
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  seedSamples(root: string, sellerId: string) {
    const snapshots = Object.entries(sourceFiles).map(
      ([type, [filename, collection, idKey]]) => {
        const raw: unknown = JSON.parse(
          readFileSync(resolve(root, 'docs/samples', filename), 'utf8'),
        );
        const meta = snapshotSchema.parse(raw);
        if (meta.seller_id !== sellerId)
          throw new AppError(
            'SELLER_MISMATCH',
            '샘플 자료의 판매자와 설정이 다릅니다.',
          );
        const values = z
          .array(schemas[type as SourceType])
          .parse((raw as Record<string, unknown>)[collection]);
        const keys = values.map(
          (value) => (value as Record<string, unknown>)[idKey],
        );
        if (new Set(keys).size !== keys.length)
          throw new AppError('DUPLICATE_ID', '중복 자료 ID입니다.');
        return { type, meta, values, idKey };
      },
    );
    const products = snapshots.find((s) => s.type === 'product')
      ?.values as Product[];
    validateProducts(products);
    const skus = new Set(products.flatMap((p) => p.variants.map((v) => v.sku)));
    for (const order of snapshots.find((s) => s.type === 'order')
      ?.values as Order[]) {
      if (order.items.some((i) => !skus.has(i.sku)))
        throw new AppError('INVALID_SKU', '주문 SKU 근거가 없습니다.');
      const subtotal = order.items.reduce(
        (sum, i) => sum + i.quantity * i.unit_price_krw,
        0,
      );
      if (
        subtotal !== order.amounts.subtotal_krw ||
        subtotal -
          order.amounts.discount_krw +
          order.amounts.shipping_fee_krw !==
          order.amounts.total_krw
      )
        throw new AppError(
          'INVALID_AMOUNT',
          '과거 주문 금액의 산술이 다릅니다.',
        );
    }
    return this.transaction(() => {
      let inserted = 0;
      for (const snapshot of snapshots) {
        if (
          this.db
            .prepare('SELECT 1 FROM sources WHERE seller_id=? AND type=?')
            .get(sellerId, snapshot.type)
        )
          continue;
        this.db
          .prepare('INSERT INTO sources VALUES(?,?,?,?)')
          .run(
            sellerId,
            snapshot.type,
            snapshot.meta.snapshot_id,
            snapshot.meta.reference_time,
          );
        for (const value of snapshot.values)
          this.db
            .prepare('INSERT INTO records VALUES(?,?,?,?)')
            .run(
              sellerId,
              snapshot.type,
              String((value as Record<string, unknown>)[snapshot.idKey]),
              JSON.stringify(value),
            );
        inserted += snapshot.values.length;
      }
      return { inserted };
    });
  }
  source(sellerId: string, type: SourceType) {
    const row = this.db
      .prepare(
        'SELECT snapshot_id,reference_time FROM sources WHERE seller_id=? AND type=?',
      )
      .get(sellerId, type);
    if (!row)
      throw new AppError(
        'SOURCE_MISSING',
        '판매자 자료가 연결되지 않았습니다.',
        503,
      );
    return {
      snapshot_id: String(row.snapshot_id),
      reference_time: String(row.reference_time),
    };
  }
  products(sellerId: string): Product[] {
    return this.readRecords(sellerId, 'product').map((p) =>
      productSchema.parse(p),
    );
  }
  policies(sellerId: string): Policy[] {
    return this.readRecords(sellerId, 'policy').map((p) =>
      policySchema.parse(p),
    );
  }
  orders(sellerId: string): Order[] {
    return this.readRecords(sellerId, 'order').map((p) => orderSchema.parse(p));
  }
  private readRecords(sellerId: string, type: SourceType): unknown[] {
    this.source(sellerId, type);
    return this.db
      .prepare(
        'SELECT payload FROM records WHERE seller_id=? AND type=? ORDER BY id',
      )
      .all(sellerId, type)
      .map((r) => JSON.parse(String(r.payload)) as unknown);
  }
  replaceProducts(sellerId: string, products: Product[]) {
    const valid = z.array(productSchema).min(1).max(10000).parse(products);
    validateProducts(valid);
    return this.transaction(() => {
      this.source(sellerId, 'product');
      const skus = new Set(valid.flatMap((p) => p.variants.map((v) => v.sku)));
      if (
        this.orders(sellerId).some((o) => o.items.some((i) => !skus.has(i.sku)))
      )
        throw new AppError(
          'REFERENCED_SKU',
          '주문 이력이 참조하는 SKU를 삭제할 수 없습니다.',
          409,
        );
      const snapshot =
        'products-' +
        createHash('sha256')
          .update(JSON.stringify(valid))
          .digest('hex')
          .slice(0, 16);
      this.db
        .prepare('DELETE FROM records WHERE seller_id=? AND type=?')
        .run(sellerId, 'product');
      for (const product of valid)
        this.db
          .prepare('INSERT INTO records VALUES(?,?,?,?)')
          .run(
            sellerId,
            'product',
            product.product_id,
            JSON.stringify(product),
          );
      this.db
        .prepare(
          'UPDATE sources SET snapshot_id=?,reference_time=? WHERE seller_id=? AND type=?',
        )
        .run(snapshot, new Date().toISOString(), sellerId, 'product');
      return { snapshot_id: snapshot, products: valid.length };
    });
  }
  createConversation(
    sellerId: string,
    handle: string,
    label = '',
  ): Conversation {
    const result = {
      id: randomUUID(),
      seller_id: sellerId,
      customer_handle: handle,
      context_label: label,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO conversations VALUES(?,?,?,?,?)')
      .run(result.id, sellerId, handle, label, result.created_at);
    return result;
  }
  conversation(sellerId: string, id: string): Conversation {
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE seller_id=? AND id=?')
      .get(sellerId, id);
    if (!row)
      throw new AppError(
        'CONVERSATION_NOT_FOUND',
        '대화방을 찾을 수 없습니다.',
        404,
      );
    return row as unknown as Conversation;
  }
  conversations(sellerId: string, handle?: string): Conversation[] {
    const rows = handle
      ? this.db
          .prepare(
            'SELECT * FROM conversations WHERE seller_id=? AND customer_handle=? ORDER BY created_at,id',
          )
          .all(sellerId, handle)
      : this.db
          .prepare(
            'SELECT * FROM conversations WHERE seller_id=? ORDER BY created_at,id LIMIT 100',
          )
          .all(sellerId);
    return rows as unknown as Conversation[];
  }
  receive(
    sellerId: string,
    input: {
      requestId: string;
      handle: string;
      text: string;
      conversationId?: string;
      attachments: unknown[];
    },
  ) {
    return this.transaction(() => {
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            handle: input.handle,
            text: input.text,
            attachments: input.attachments,
          }),
        )
        .digest('hex');
      const prior = this.db
        .prepare(
          "SELECT * FROM messages WHERE seller_id=? AND request_id=? AND role='customer'",
        )
        .get(sellerId, input.requestId);
      if (prior) {
        if (
          prior.fingerprint !== fingerprint ||
          (input.conversationId &&
            prior.conversation_id !== input.conversationId)
        )
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            '같은 요청 ID에 다른 대화나 내용을 사용할 수 없습니다.',
            409,
          );
        return {
          conversation: this.conversation(
            sellerId,
            String(prior.conversation_id),
          ),
          replayed: true,
        };
      }
      const conversation = input.conversationId
        ? this.conversation(sellerId, input.conversationId)
        : this.createConversation(sellerId, input.handle);
      if (conversation.customer_handle !== input.handle)
        throw new AppError(
          'CUSTOMER_MISMATCH',
          '다른 고객의 대화방에 메시지를 추가할 수 없습니다.',
          403,
        );
      this.db
        .prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)')
        .run(
          randomUUID(),
          conversation.id,
          sellerId,
          input.requestId,
          fingerprint,
          'customer',
          input.text,
          new Date().toISOString(),
        );
      return { conversation, replayed: false };
    });
  }
  messages(sellerId: string, conversationId: string): Message[] {
    this.conversation(sellerId, conversationId);
    return (
      this.db
        .prepare(
          'SELECT id,conversation_id,request_id,role,text,created_at FROM messages WHERE seller_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 200',
        )
        .all(sellerId, conversationId) as unknown as Message[]
    ).reverse();
  }
  runForRequest(sellerId: string, requestId: string): AgentRun | null {
    const row = this.db
      .prepare('SELECT * FROM agent_runs WHERE seller_id=? AND request_id=?')
      .get(sellerId, requestId);
    return row ? this.decodeRun(row) : null;
  }
  runById(id: string): AgentRun {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE id=?').get(id);
    if (!row)
      throw new AppError('RUN_NOT_FOUND', '분석 실행을 찾을 수 없습니다.', 404);
    return this.decodeRun(row);
  }
  private decodeRun(row: Record<string, unknown>): AgentRun {
    return {
      ...row,
      input: JSON.parse(String(row.input)),
      analysis: row.analysis ? JSON.parse(String(row.analysis)) : null,
      proposed: row.proposed ? JSON.parse(String(row.proposed)) : null,
    } as AgentRun;
  }
  roomRunning(sellerId: string, conversationId: string, requestId?: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM agent_runs WHERE seller_id=? AND conversation_id=? AND status='running' AND request_id<>?",
      )
      .get(sellerId, conversationId, requestId ?? '');
  }
  beginRun(
    sellerId: string,
    requestId: string,
    limits: { messages: number; characters: number; timeoutMs?: number },
    now: Date,
  ): AgentRun {
    return this.transaction(() => {
      const existing = this.runForRequest(sellerId, requestId);
      if (existing) return existing;
      const message = this.db
        .prepare(
          "SELECT * FROM messages WHERE seller_id=? AND request_id=? AND role='customer'",
        )
        .get(sellerId, requestId);
      if (!message)
        throw new AppError('MESSAGE_NOT_FOUND', '수신 메시지가 없습니다.', 404);
      const room = this.conversation(sellerId, String(message.conversation_id));
      if (this.roomRunning(sellerId, room.id, requestId))
        throw new AppError(
          'ROOM_BUSY',
          '이 방의 이전 분석이 진행 중입니다.',
          409,
          true,
        );
      const history = this.db
        .prepare(
          `SELECT m.role,m.text,m.request_id FROM messages m
        JOIN messages c ON c.seller_id=m.seller_id AND c.request_id=m.request_id AND c.role='customer'
        WHERE m.seller_id=? AND m.conversation_id=? AND c.rowid<=(SELECT rowid FROM messages WHERE id=?)
        ORDER BY c.rowid DESC,CASE m.role WHEN 'customer' THEN 0 ELSE 1 END DESC LIMIT 400`,
        )
        .all(
          sellerId,
          room.id,
          message.id as string,
        ) as unknown as RunInput['history'];
      history.reverse();
      // The current request must remain complete; never silently cut off its address or correction.
      const chosen: RunInput['history'] = [];
      let characters = 0;
      for (const entry of [...history].reverse()) {
        if (
          chosen.length >= limits.messages ||
          characters + entry.text.length > limits.characters
        )
          break;
        chosen.unshift(entry);
        characters += entry.text.length;
      }
      if (
        !chosen.some(
          (entry) =>
            entry.request_id === requestId && entry.role === 'customer',
        )
      )
        throw new AppError(
          'CONTEXT_TOO_LARGE',
          '현재 메시지를 담기에는 대화 맥락 한도가 작습니다.',
          413,
        );
      const id = randomUUID();
      const input: RunInput = {
        run_id: id,
        request_id: requestId,
        conversation_id: room.id,
        customer_handle: room.customer_handle,
        context_label: room.context_label,
        reference_time: now.toISOString(),
        expires_at: new Date(
          Date.now() + (limits.timeoutMs ?? 60000),
        ).toISOString(),
        snapshots: {
          products: this.source(sellerId, 'product').snapshot_id,
          policies: this.source(sellerId, 'policy').snapshot_id,
          orders: this.source(sellerId, 'order').snapshot_id,
        },
        history: chosen,
        context_truncated: chosen.length < history.length,
      };
      this.db
        .prepare(
          "INSERT INTO agent_runs(id,seller_id,request_id,conversation_id,status,input) VALUES(?,?,?,?,'running',?)",
        )
        .run(id, sellerId, requestId, room.id, JSON.stringify(input));
      return this.runById(id);
    });
  }
  countModelCall(id: string, maximum: number) {
    const changed = this.db
      .prepare(
        "UPDATE agent_runs SET model_calls=model_calls+1 WHERE id=? AND status='running' AND model_calls<?",
      )
      .run(id, maximum).changes;
    if (!changed)
      throw new AppError(
        'MODEL_CALL_LIMIT',
        '모델 호출 한도를 초과했습니다.',
        503,
      );
  }
  traceTool(
    id: string,
    callId: string,
    name: string,
    success: boolean,
    result: unknown,
    maximum: number,
  ) {
    if (this.runById(id).status !== 'running')
      throw new AppError(
        'RUN_FINISHED',
        '종료된 실행의 도구 호출은 허용하지 않습니다.',
        409,
      );
    const count = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM agent_tool_calls WHERE run_id=? AND call_id<>?',
      )
      .get(id, callId);
    if (Number(count?.n) >= maximum)
      throw new AppError(
        'TOOL_CALL_LIMIT',
        '도구 호출 한도를 초과했습니다.',
        503,
      );
    this.db
      .prepare('INSERT OR REPLACE INTO agent_tool_calls VALUES(?,?,?,?,?)')
      .run(id, callId, name, success ? 1 : 0, JSON.stringify(result));
  }
  traces(id: string): ToolTrace[] {
    return this.db
      .prepare(
        'SELECT call_id,name,success,result FROM agent_tool_calls WHERE run_id=? ORDER BY rowid',
      )
      .all(id)
      .map((row) => ({
        call_id: String(row.call_id),
        name: String(row.name),
        success: !!row.success,
        result: JSON.parse(String(row.result)) as unknown,
      }));
  }
  proposeAnalysis(id: string, analysis: Analysis) {
    const changed = this.db
      .prepare(
        "UPDATE agent_runs SET proposed=? WHERE id=? AND status='running'",
      )
      .run(JSON.stringify(analysis), id).changes;
    if (!changed)
      throw new AppError('RUN_FINISHED', '이미 종료된 실행입니다.', 409);
  }
  finishRun(id: string, analysis: Analysis, httpStatus: number) {
    return this.transaction(() => {
      const run = this.runById(id);
      if (run.status !== 'running') return run;
      this.db
        .prepare(
          'UPDATE agent_runs SET status=?,analysis=?,http_status=? WHERE id=?',
        )
        .run(
          httpStatus === 200 ? 'succeeded' : 'failed',
          JSON.stringify(analysis),
          httpStatus,
          id,
        );
      if (httpStatus === 200 && analysis.reply_draft) {
        this.db
          .prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?,?)')
          .run(
            randomUUID(),
            run.conversation_id,
            run.seller_id,
            run.request_id,
            'assistant-draft',
            'assistant',
            analysis.reply_draft,
            new Date().toISOString(),
          );
      }
      return this.runById(id);
    });
  }
  async backupTo(path: string) {
    if (this.path !== ':memory:' && resolve(path) === resolve(this.path))
      throw new AppError(
        'INVALID_BACKUP_PATH',
        '원본과 다른 백업 파일을 지정하세요.',
      );
    mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    if (existsSync(path))
      throw new AppError(
        'BACKUP_EXISTS',
        '기존 파일을 덮어쓰지 않도록 새 백업 경로를 지정하세요.',
        409,
      );
    await backup(this.db, path);
    chmodSync(path, 0o600);
  }
}
export function validateProducts(products: Product[]) {
  const ids = products.map((p) => p.product_id),
    skus = products.flatMap((p) => p.variants.map((v) => v.sku));
  if (new Set(ids).size !== ids.length || new Set(skus).size !== skus.length)
    throw new AppError(
      'DUPLICATE_ID',
      '상품 ID와 SKU는 자료 안에서 고유해야 합니다.',
    );
}
