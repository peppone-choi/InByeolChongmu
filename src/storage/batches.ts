import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  batchItemSchema,
  batchSummarySchema,
  type BatchOutcome,
  type CreateBatch,
} from '../domain/batch.js';
import { AppError } from '../domain/errors.js';
import type { Store } from './store.js';

const summaries = `SELECT b.id AS batch_id,b.created_at,COUNT(*) AS total,
  SUM(i.status='completed') AS completed,SUM(i.status='failed') AS failed
  FROM dm_batches b JOIN dm_batch_items i ON i.batch_id=b.id WHERE b.seller_id=?`;

export class Batches {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dm_batches(
        id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS dm_batches_scope ON dm_batches(seller_id,created_at);
      CREATE TABLE IF NOT EXISTS dm_batch_items(
        item_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES dm_batches(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, request_id TEXT NOT NULL,
        customer_handle TEXT NOT NULL, context_label TEXT NOT NULL, text TEXT NOT NULL,
        conversation_id TEXT REFERENCES conversations(id),
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
        outcome TEXT CHECK(json_valid(outcome)), UNIQUE(batch_id,position)
      ) STRICT;
    `);
  }
  private atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  list(seller: string, limit = 50) {
    return this.db
      .prepare(
        summaries +
          ' GROUP BY b.id ORDER BY b.created_at DESC,b.rowid DESC LIMIT ?',
      )
      .all(seller, limit)
      .map((row) => batchSummarySchema.parse(row));
  }
  get(seller: string, id: string) {
    const summary = this.db
      .prepare(summaries + ' AND b.id=? GROUP BY b.id')
      .get(seller, id);
    if (!summary)
      throw new AppError(
        'BATCH_NOT_FOUND',
        '일괄 접수 목록을 찾을 수 없습니다.',
        404,
      );
    const items = this.db
      .prepare(
        'SELECT item_id,request_id,conversation_id,customer_handle,context_label,text,status,outcome FROM dm_batch_items WHERE batch_id=? ORDER BY position',
      )
      .all(id)
      .map((row) =>
        batchItemSchema.parse({
          ...row,
          outcome: row.outcome
            ? (JSON.parse(String(row.outcome)) as unknown)
            : null,
        }),
      );
    return { ...batchSummarySchema.parse(summary), items };
  }
  create(seller: string, input: CreateBatch) {
    return this.atomic(() => {
      const existing = this.db
        .prepare('SELECT seller_id FROM dm_batches WHERE id=?')
        .get(input.batch_id);
      if (existing) {
        const batch = this.get(seller, input.batch_id);
        if (
          JSON.stringify(
            batch.items.map(({ customer_handle, context_label, text }) => ({
              customer_handle,
              context_label,
              text,
            })),
          ) !== JSON.stringify(input.items)
        )
          throw new AppError(
            'BATCH_ID_CONFLICT',
            '같은 일괄 접수 ID에 다른 내용을 저장할 수 없습니다.',
            409,
          );
        return batch;
      }
      this.db
        .prepare('INSERT INTO dm_batches VALUES(?,?,?)')
        .run(input.batch_id, seller, new Date().toISOString());
      const insert = this.db.prepare(`INSERT INTO dm_batch_items
        (item_id,batch_id,position,request_id,customer_handle,context_label,text,status)
        VALUES(?,?,?,?,?,?,?,'queued')`);
      input.items.forEach(
        ({ customer_handle, context_label, text }, position) => {
          const id = randomUUID();
          insert.run(
            id,
            input.batch_id,
            position,
            id,
            customer_handle,
            context_label,
            text,
          );
        },
      );
      return this.get(seller, input.batch_id);
    });
  }
  claim(
    seller: string,
    batchId: string,
    itemId: string,
    requestId: string,
    retry: boolean,
  ) {
    return this.atomic(() => {
      const batch = this.get(seller, batchId);
      const item = batch.items.find(({ item_id }) => item_id === itemId);
      if (!item)
        throw new AppError(
          'BATCH_ITEM_NOT_FOUND',
          '접수 건을 찾을 수 없습니다.',
          404,
        );
      if (item.request_id !== requestId || item.status === 'completed') return;
      const pending =
        batch.items.find(({ status }) => status === 'running') ??
        batch.items.find(({ status }) => status === 'queued');
      if (
        retry
          ? item.status !== 'failed' || !item.outcome?.error?.retryable
          : item.status === 'failed'
      )
        return;
      if (
        pending &&
        pending.item_id !== itemId &&
        (!retry || pending.status === 'running')
      )
        throw new AppError(
          'BATCH_OUT_OF_ORDER',
          '앞서 실행 중인 건부터 이어서 처리하세요.',
          409,
          true,
        );
      const room =
        item.conversation_id ??
        (item.customer_handle && item.text.trim()
          ? this.store.createConversation(
              seller,
              item.customer_handle,
              item.context_label,
            ).id
          : null);
      const next = {
        ...item,
        request_id: retry ? randomUUID() : requestId,
        conversation_id: room,
        status: 'running' as const,
        outcome: null,
      };
      this.db
        .prepare(
          "UPDATE dm_batch_items SET request_id=?, conversation_id=?, status='running', outcome=NULL WHERE batch_id=? AND item_id=?",
        )
        .run(next.request_id, room, batchId, itemId);
      return next;
    });
  }
  finish(
    batchId: string,
    itemId: string,
    requestId: string,
    outcome: BatchOutcome,
  ) {
    this.db
      .prepare(
        "UPDATE dm_batch_items SET status=?, outcome=? WHERE batch_id=? AND item_id=? AND request_id=? AND status='running'",
      )
      .run(
        outcome.error ? 'failed' : 'completed',
        JSON.stringify(outcome),
        batchId,
        itemId,
        requestId,
      );
  }
  clear(seller: string) {
    this.db.prepare('DELETE FROM dm_batches WHERE seller_id=?').run(seller);
  }
  export(seller: string) {
    return this.list(seller, -1).map(({ batch_id }) =>
      this.get(seller, batch_id),
    );
  }
}
