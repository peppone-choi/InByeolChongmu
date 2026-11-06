import type { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import type { Store } from './store.js';
import { Tools } from '../tools/registry.js';
import {
  shipmentCommandSchema,
  shipmentEventSchema,
  shipmentResultSchema,
  type ShipmentCommand,
} from '../domain/shipping.js';
import { AppError } from '../domain/errors.js';
import { amountSchema, orderSchema, type Order } from '../domain/schema.js';
import {
  savedOrderSchema,
  type SavedOrder,
  type OrderEdit,
  type ConfirmOrder,
  type Reviewed,
} from '../domain/commerce.js';

export class Commerce {
  constructor(
    private db: DatabaseSync,
    private store: Store,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS managed_orders(seller_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(seller_id,id)) STRICT;
    CREATE TABLE IF NOT EXISTS order_origins(seller_id TEXT NOT NULL,request_id TEXT NOT NULL,order_id TEXT NOT NULL,PRIMARY KEY(seller_id,request_id)) STRICT;
    CREATE TABLE IF NOT EXISTS order_commands(seller_id TEXT NOT NULL,command_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(seller_id,command_id)) STRICT;
    CREATE TABLE IF NOT EXISTS shipment_events(seller_id TEXT NOT NULL,order_id TEXT NOT NULL,event_id TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(seller_id,event_id)) STRICT;
    INSERT OR IGNORE INTO schema_migrations VALUES(3);
    INSERT OR IGNORE INTO schema_migrations VALUES(4);`);
  }
  private atomic<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  snapshots(seller: string): Reviewed {
    return {
      products: this.store.source(seller, 'product').snapshot_id,
      policies: this.store.source(seller, 'policy').snapshot_id,
    };
  }
  private check(seller: string, expected: Reviewed) {
    if (
      JSON.stringify(this.snapshots(seller)) !==
      JSON.stringify({
        products: expected.products,
        policies: expected.policies,
      })
    )
      throw new AppError(
        'STALE_VERSION',
        '상품·정책이 바뀌었습니다. 최신 견적을 저장하고 다시 확인하세요.',
        409,
      );
  }
  list(seller: string): SavedOrder[] {
    const managed = this.db
      .prepare(
        'SELECT payload FROM managed_orders WHERE seller_id=? ORDER BY rowid DESC',
      )
      .all(seller)
      .map((r) => savedOrderSchema.parse(JSON.parse(String(r.payload))));
    const history = this.db
      .prepare(
        "SELECT payload FROM records WHERE seller_id=? AND type='order' ORDER BY id DESC",
      )
      .all(seller)
      .map((r) => {
        const o = orderSchema.parse(JSON.parse(String(r.payload)));
        return savedOrderSchema.parse({
          ...o,
          items: o.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
          issues: [],
          item_labels: o.items.map((i) => i.sku),
          item_prices: o.items.map((i) => i.unit_price_krw),
          reviewed_snapshots: this.snapshots(seller),
          origin_request_id: null,
          conversation_id: null,
          historical: true,
          payment: null,
        });
      });
    return [...managed, ...history];
  }
  get(seller: string, id: string): SavedOrder {
    const row = this.db
      .prepare('SELECT payload FROM managed_orders WHERE seller_id=? AND id=?')
      .get(seller, id);
    if (!row) {
      const historic = this.list(seller).find((o) => o.order_id === id);
      if (historic) return historic;
      throw new AppError('ORDER_NOT_FOUND', '주문을 찾을 수 없습니다.', 404);
    }
    return savedOrderSchema.parse(JSON.parse(String(row.payload)));
  }
  private persist(seller: string, order: SavedOrder) {
    order = savedOrderSchema.parse(order);
    if (order.historical) {
      const raw = this.db
        .prepare(
          "SELECT payload FROM records WHERE seller_id=? AND type='order' AND id=?",
        )
        .get(seller, order.order_id);
      if (!raw)
        throw new AppError('ORDER_NOT_FOUND', '주문을 찾을 수 없습니다.', 404);
      const previous = orderSchema.parse(JSON.parse(String(raw.payload)));
      const updated = orderSchema.parse({
        ...previous,
        status: order.status,
        version: order.version,
        carrier: order.carrier,
        tracking_number: order.tracking_number,
        shipped_at: order.shipped_at,
      });
      this.db
        .prepare(
          "UPDATE records SET payload=? WHERE seller_id=? AND type='order' AND id=?",
        )
        .run(JSON.stringify(updated), seller, order.order_id);
    } else
      this.db
        .prepare(
          'INSERT INTO managed_orders VALUES(?,?,?) ON CONFLICT(seller_id,id) DO UPDATE SET payload=excluded.payload',
        )
        .run(seller, order.order_id, JSON.stringify(order));
    this.bump(seller, 'order');
    return order;
  }
  private bump(seller: string, type: 'order' | 'product') {
    this.db
      .prepare(
        'UPDATE sources SET snapshot_id=?,reference_time=? WHERE seller_id=? AND type=?',
      )
      .run(`${type}-${randomUUID()}`, new Date().toISOString(), seller, type);
  }
  private price(seller: string, edit: OrderEdit, now: Date) {
    const issues: string[] = [];
    if (!edit.recipient.name?.trim()) issues.push('받는 분 이름을 입력하세요.');
    if (
      !edit.recipient.phone_raw ||
      !/^0\d{8,10}$/.test(edit.recipient.phone_raw.replace(/[\s()-]/g, ''))
    )
      issues.push('연락처를 확인하세요.');
    if (!edit.recipient.address_raw?.trim())
      issues.push('배송지를 입력하세요.');
    if (
      edit.recipient.postal_code &&
      !/^\d{5}$/.test(edit.recipient.postal_code)
    )
      issues.push('우편번호는 5자리 숫자입니다.');
    if (!edit.depositor_name?.trim()) issues.push('입금자명을 입력하세요.');
    const products = this.store.products(seller);
    const prices = edit.items.map(
      (i) =>
        products.flatMap((p) => p.variants).find((v) => v.sku === i.sku)
          ?.unit_price_krw ?? null,
    );
    const labels = edit.items.map((i) => {
      const p = products.find((p) => p.variants.some((v) => v.sku === i.sku)),
        v = p?.variants.find((v) => v.sku === i.sku);
      return p && v
        ? `${p.name} · ${v.color} / ${v.size}`
        : (i.sku ?? '상품 미선택');
    });
    if (!edit.items.length || edit.items.some((i) => !i.sku || !i.quantity))
      return {
        amounts: null,
        issues: [...issues, '상품과 수량을 모두 선택하세요.'],
        item_labels: labels,
        item_prices: prices,
      };
    try {
      const quote = new Tools(this.store, seller, '', () => now).call(
        'quote_order',
        { items: edit.items },
      ) as { amounts: unknown; review_items: Array<{ code: string }> };
      const messages: Record<string, string> = {
        OUT_OF_STOCK: '품절 상품이 있습니다.',
        INSUFFICIENT_STOCK: '재고가 부족합니다.',
        SALE_CLOSED: '판매가 마감된 상품입니다.',
      };
      for (const r of quote.review_items)
        issues.push(messages[r.code] ?? r.code);
      return {
        amounts: amountSchema.parse(quote.amounts),
        issues: [...new Set(issues)],
        item_labels: labels,
        item_prices: prices,
      };
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      return {
        amounts: null,
        issues: [...issues, e.message],
        item_labels: labels,
        item_prices: prices,
      };
    }
  }
  saveAnalysis(seller: string, request: string, now = new Date()) {
    return this.atomic(() => {
      const prior = this.db
        .prepare(
          'SELECT order_id FROM order_origins WHERE seller_id=? AND request_id=?',
        )
        .get(seller, request);
      if (prior) return this.get(seller, String(prior.order_id));
      const run = this.store.runForRequest(seller, request),
        draft = run?.analysis?.order_draft;
      if (!run || run.status !== 'succeeded' || !draft)
        throw new AppError(
          'ANALYSIS_REQUIRED',
          '저장할 주문 분석 결과가 없습니다.',
          409,
        );
      this.check(seller, run.input.snapshots);
      // A second analysis of a room must not silently create another active order.
      const active = this.list(seller).find(
        (o) =>
          o.conversation_id === run.conversation_id && o.status !== 'cancelled',
      );
      if (active)
        throw new AppError(
          'ROOM_HAS_ORDER',
          '이 방에는 저장한 주문이 있습니다. 주문 화면에서 수정하거나 새 상담 방을 만드세요.',
          409,
        );
      const edit: OrderEdit = {
        recipient: draft.recipient,
        depositor_name: draft.depositor_name,
        items: draft.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
      };
      const priced = this.price(seller, edit, now);
      const order: SavedOrder = {
        ...edit,
        ...priced,
        order_id: randomUUID(),
        customer_handle: run.input.customer_handle,
        status: priced.issues.length ? 'draft' : 'pending_payment',
        version: 1,
        reviewed_snapshots: this.snapshots(seller),
        created_at: now.toISOString(),
        confirmed_at: null,
        origin_request_id: request,
        conversation_id: run.conversation_id,
        historical: false,
        carrier: null,
        tracking_number: null,
        shipped_at: null,
        payment: null,
      };
      this.db
        .prepare('INSERT INTO order_origins VALUES(?,?,?)')
        .run(seller, request, order.order_id);
      return this.persist(seller, order);
    });
  }
  update(
    seller: string,
    id: string,
    version: number,
    snapshots: Reviewed,
    edit: OrderEdit,
    now = new Date(),
  ) {
    return this.atomic(() => {
      const order = this.get(seller, id);
      this.editable(order, version);
      this.check(seller, snapshots);
      const priced = this.price(seller, edit, now);
      return this.persist(seller, {
        ...order,
        ...edit,
        ...priced,
        status: priced.issues.length ? 'draft' : 'pending_payment',
        version: order.version + 1,
        reviewed_snapshots: this.snapshots(seller),
      });
    });
  }
  private editable(order: SavedOrder, version: number) {
    if (order.version !== version)
      throw new AppError(
        'STALE_VERSION',
        '주문이 변경됐습니다. 다시 불러오세요.',
        409,
      );
    if (
      order.historical ||
      !['draft', 'pending_payment'].includes(order.status)
    )
      throw new AppError(
        'ORDER_LOCKED',
        '확정·과거 주문은 수정할 수 없습니다.',
        409,
      );
  }
  confirm(seller: string, id: string, input: ConfirmOrder, now = new Date()) {
    return this.atomic(() => {
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ id, input }))
        .digest('hex');
      const cached = this.db
        .prepare(
          'SELECT * FROM order_commands WHERE seller_id=? AND command_id=?',
        )
        .get(seller, input.command_id);
      if (cached) {
        if (cached.fingerprint !== fingerprint)
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            '같은 요청 ID의 내용이 다릅니다.',
            409,
          );
        return savedOrderSchema.parse(JSON.parse(String(cached.result)));
      }
      const order = this.get(seller, id);
      if (order.status === 'confirmed' && !order.historical) return order;
      this.editable(order, input.expected_version);
      this.check(seller, input.reviewed_snapshots);
      this.check(seller, order.reviewed_snapshots);
      const priced = this.price(seller, order, now);
      if (priced.issues.length || !priced.amounts)
        throw new AppError('ORDER_INCOMPLETE', priced.issues.join(' '), 409);
      if (JSON.stringify(priced.amounts) !== JSON.stringify(order.amounts))
        throw new AppError(
          'PRICE_CHANGED',
          '최신 견적을 저장하고 다시 확인하세요.',
          409,
        );
      if (
        input.payment_checked !== true ||
        input.address_acknowledged !== true ||
        input.checked_amount_krw !== priced.amounts.total_krw ||
        input.checked_depositor_name.trim() !== order.depositor_name?.trim()
      )
        throw new AppError(
          'PAYMENT_MISMATCH',
          '실제 입금액·입금자와 배송지 확인이 필요합니다.',
          409,
        );
      const quantities = new Map<string, number>();
      for (const item of order.items)
        quantities.set(
          item.sku!,
          (quantities.get(item.sku!) ?? 0) + item.quantity!,
        );
      for (const product of this.store.products(seller)) {
        let changed = false;
        for (const v of product.variants) {
          const qty = quantities.get(v.sku);
          if (qty) {
            if (v.stock_available < qty)
              throw new AppError(
                'INSUFFICIENT_STOCK',
                '재고가 부족합니다.',
                409,
              );
            v.stock_available -= qty;
            changed = true;
          }
        }
        if (changed)
          this.db
            .prepare(
              "UPDATE records SET payload=? WHERE seller_id=? AND type='product' AND id=?",
            )
            .run(JSON.stringify(product), seller, product.product_id);
      }
      this.bump(seller, 'product');
      const result = this.persist(seller, {
        ...order,
        status: 'confirmed',
        version: order.version + 1,
        confirmed_at: now.toISOString(),
        issues: [],
        payment: {
          checked_at: now.toISOString(),
          actor: seller,
          amount_krw: input.checked_amount_krw,
          depositor_name: input.checked_depositor_name,
          address_acknowledged: true,
        },
      });
      this.db
        .prepare('INSERT INTO order_commands VALUES(?,?,?,?)')
        .run(seller, input.command_id, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  shipmentHistory(seller: string, id: string) {
    this.get(seller, id);
    return this.db
      .prepare(
        'SELECT payload FROM shipment_events WHERE seller_id=? AND order_id=? ORDER BY rowid',
      )
      .all(seller, id)
      .map((r) => shipmentEventSchema.parse(JSON.parse(String(r.payload))));
  }
  shipment(seller: string, id: string, raw: ShipmentCommand, now = new Date()) {
    const input = shipmentCommandSchema.parse(raw);
    return this.atomic(() => {
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ id, input }))
        .digest('hex');
      const cached = this.db
        .prepare(
          'SELECT fingerprint,result FROM order_commands WHERE seller_id=? AND command_id=?',
        )
        .get(seller, input.command_id);
      if (cached) {
        if (cached.fingerprint !== fingerprint)
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            '같은 요청 ID의 내용이 다릅니다.',
            409,
          );
        return {
          ...shipmentResultSchema.parse(JSON.parse(String(cached.result))),
          replayed: true,
        };
      }
      const order = this.get(seller, id);
      if (input.operation === 'register_shipment' && order.status === 'shipped')
        throw new AppError(
          'SHIPMENT_ALREADY_RECORDED',
          '이미 발송 기록이 있습니다. 정정 기능을 사용하세요.',
          409,
        );
      if (
        order.status !==
        (input.operation === 'register_shipment' ? 'confirmed' : 'shipped')
      )
        throw new AppError(
          'INVALID_ORDER_STATE',
          '발송 등록은 확정 주문, 정정은 발송된 주문만 가능합니다.',
          409,
        );
      if (order.version !== input.expected_version)
        throw new AppError(
          'STALE_VERSION',
          '주문이 변경됐습니다. 최신 기록을 다시 확인하세요.',
          409,
        );
      if (
        !order.confirmed_at ||
        !Number.isFinite(Date.parse(order.confirmed_at)) ||
        Date.parse(input.shipped_at) < Date.parse(order.confirmed_at) ||
        Date.parse(input.shipped_at) > now.getTime()
      )
        throw new AppError(
          'INVALID_SHIPMENT_TIME',
          '발송 시각은 확정 이후이며 현재 시각을 넘을 수 없습니다.',
          422,
        );
      const before = {
          carrier: order.carrier,
          tracking_number: order.tracking_number,
          shipped_at: order.shipped_at,
        },
        after = {
          carrier: input.carrier,
          tracking_number: input.tracking_number,
          shipped_at: input.shipped_at,
        };
      if (
        input.operation === 'update_shipment' &&
        before.carrier?.trim() === after.carrier &&
        before.tracking_number?.replace(/\s/g, '') === after.tracking_number &&
        Date.parse(before.shipped_at ?? '') === Date.parse(after.shipped_at)
      )
        throw new AppError('NO_CHANGE', '정정할 내용을 변경하세요.', 422);
      const saved = this.persist(seller, {
        ...order,
        ...after,
        status: 'shipped',
        version: order.version + 1,
      });
      const event = shipmentEventSchema.parse({
        event_id: randomUUID(),
        command_id: input.command_id,
        order_id: id,
        operation: input.operation,
        version: saved.version,
        actor: seller,
        recorded_at: now.toISOString(),
        correction_reason:
          input.operation === 'update_shipment'
            ? input.correction_reason
            : null,
        before,
        after,
      });
      this.db
        .prepare('INSERT INTO shipment_events VALUES(?,?,?,?)')
        .run(seller, id, event.event_id, JSON.stringify(event));
      const result = {
        command_id: input.command_id,
        order_id: id,
        status: 'shipped' as const,
        version: saved.version,
        order: saved,
        event,
        replayed: false,
      };
      this.db
        .prepare('INSERT INTO order_commands VALUES(?,?,?,?)')
        .run(seller, input.command_id, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  remove(seller: string, id: string, version: number) {
    return this.atomic(() => {
      const order = this.get(seller, id);
      if (order.version !== version)
        throw new AppError('STALE_VERSION', '주문이 변경됐습니다.', 409);
      this.db
        .prepare('DELETE FROM shipment_events WHERE seller_id=? AND order_id=?')
        .run(seller, id);
      this.db
        .prepare(
          'UPDATE parcel_exports SET payload=NULL WHERE seller_id=? AND EXISTS(SELECT 1 FROM json_each(order_ids) WHERE value=?)',
        )
        .run(seller, id);
      this.db
        .prepare('DELETE FROM managed_orders WHERE seller_id=? AND id=?')
        .run(seller, id);
      this.db
        .prepare(
          "DELETE FROM records WHERE seller_id=? AND type='order' AND id=?",
        )
        .run(seller, id);
      this.db
        .prepare(
          "DELETE FROM order_commands WHERE seller_id=? AND COALESCE(json_extract(result,'$.order_id'),json_extract(result,'$.order.order_id'))=?",
        )
        .run(seller, id);
      this.bump(seller, 'order');
    });
  }
  reset(seller: string, snapshot: string) {
    return this.atomic(() => {
      if (this.store.source(seller, 'order').snapshot_id !== snapshot)
        throw new AppError('STALE_VERSION', '주문 목록이 변경됐습니다.', 409);
      this.db
        .prepare('DELETE FROM shipment_events WHERE seller_id=?')
        .run(seller);
      this.db
        .prepare('DELETE FROM parcel_exports WHERE seller_id=?')
        .run(seller);
      this.db
        .prepare('DELETE FROM managed_orders WHERE seller_id=?')
        .run(seller);
      this.db
        .prepare('DELETE FROM order_commands WHERE seller_id=?')
        .run(seller);
      this.db
        .prepare("DELETE FROM records WHERE seller_id=? AND type='order'")
        .run(seller);
      // Origins are tombstones: old analyses cannot deduct stock again after a reset.
      this.bump(seller, 'order');
    });
  }
  projection(seller: string): Order[] {
    return this.db
      .prepare('SELECT payload FROM managed_orders WHERE seller_id=?')
      .all(seller)
      .flatMap((r) => {
        const o = savedOrderSchema.parse(JSON.parse(String(r.payload)));
        if (!o.amounts || o.items.some((i) => !i.sku || !i.quantity)) return [];
        const candidate = orderSchema.safeParse({
          order_id: o.order_id,
          customer_handle: o.customer_handle,
          recipient: o.recipient,
          depositor_name: o.depositor_name,
          items: o.items.map((i, index) => ({
            ...i,
            unit_price_krw: o.item_prices[index],
          })),
          amounts: o.amounts,
          status: o.status,
          created_at: o.created_at,
          confirmed_at: o.confirmed_at,
          carrier: o.carrier,
          tracking_number: o.tracking_number,
          shipped_at: o.shipped_at,
          version: o.version,
        });
        return candidate.success ? [candidate.data] : [];
      });
  }
}
