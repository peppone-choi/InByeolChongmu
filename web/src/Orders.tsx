import { useEffect, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  Package,
  RefreshCw,
  Save,
  Trash2,
  Plus,
} from 'lucide-react';
import type {
  SavedOrder,
  ConfirmOrder,
  OrderEdit,
} from '../../src/domain/commerce';
import type { Resources } from '../../src/domain/http-contract';
import { ShipmentPanel } from './ShipmentPanel';
import { ShipmentImportPanel } from './ShipmentImportPanel';
import { ParcelExportPanel } from './ParcelExportPanel';
import { api, ApiError } from './api';
import { money } from './data';
const labels: Record<string, string> = {
  draft: '정보 보완',
  pending_payment: '입금 확인 대기',
  confirmed: '확정',
  shipped: '발송',
  cancelled: '취소',
};
export function Orders({
  initialId,
  resources,
  onResources,
}: {
  initialId: string | null;
  resources: Resources | null;
  onResources: (r: Resources) => void;
}) {
  const [orders, setOrders] = useState<SavedOrder[]>([]),
    [selected, setSelected] = useState<string | null>(initialId),
    [edit, setEdit] = useState<OrderEdit | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [command, setCommand] = useState<ConfirmOrder | null>(null),
    [confirmedChecks, setConfirmedChecks] = useState(false),
    [deleteTarget, setDeleteTarget] = useState<SavedOrder | null>(null),
    [showParcel, setShowParcel] = useState(false),
    [showImport, setShowImport] = useState(false);
  const order = orders.find((o) => o.order_id === selected);
  const load = async () => {
    const [rows, r] = await Promise.all([api.orders(), api.resources()]);
    setOrders(rows);
    onResources(r);
    return rows;
  };
  useEffect(() => {
    let live = true;
    void api
      .orders()
      .then((rows) => {
        if (live) {
          setOrders(rows);
          setSelected((id) => id ?? rows[0]?.order_id ?? null);
        }
      })
      .catch((e) => {
        if (live) setError(String(e.message));
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    setEdit(
      order
        ? {
            recipient: structuredClone(order.recipient),
            depositor_name: order.depositor_name,
            items: structuredClone(order.items),
          }
        : null,
    );
    setCommand(null);
    setConfirmedChecks(false);
  }, [order]);
  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : '요청을 확인하세요.');
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      if (!order || !edit || !resources) return;
      const saved = await api.updateOrder(
        order.order_id,
        order.version,
        resources.snapshots,
        edit,
      );
      setOrders((rows) =>
        rows.map((o) => (o.order_id === saved.order_id ? saved : o)),
      );
      await load();
      setNotice('최신 가격·정책으로 저장했습니다. 입금 확인 후 확정하세요.');
    });
  const confirm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void act(async () => {
      if (!order || !resources) return;
      const input = command ?? {
        command_id: crypto.randomUUID(),
        expected_version: order.version,
        reviewed_snapshots: {
          products: resources.snapshots.products,
          policies: resources.snapshots.policies,
        },
        payment_checked: true as const,
        checked_amount_krw: Number(form.get('amount')),
        checked_depositor_name: String(form.get('depositor')),
        address_acknowledged: true as const,
      };
      setCommand(input);
      try {
        const saved = await api.confirmOrder(order.order_id, input);
        setOrders((rows) =>
          rows.map((o) => (o.order_id === saved.order_id ? saved : o)),
        );
        await load();
        setNotice('주문을 확정하고 재고에 반영했습니다.');
      } catch (e) {
        if (e instanceof ApiError && e.status > 0) setCommand(null);
        throw e;
      }
    });
  };
  const editable =
    order &&
    !order.historical &&
    ['draft', 'pending_payment'].includes(order.status);
  const dirty =
    order &&
    edit &&
    JSON.stringify({
      recipient: order.recipient,
      depositor_name: order.depositor_name,
      items: order.items,
    }) !== JSON.stringify(edit);
  return (
    <section className="orders-page settings-page">
      <div className="settings-heading">
        <span className="section-label">판매 기록</span>
        <h1>주문</h1>
        <p>
          DM 검토에서 주문을 저장하세요. 판매자가 입금을 확인하고 확정하면
          재고를 차감합니다.
        </p>
      </div>
      <div className="data-actions">
        <button
          className="button"
          disabled={busy}
          aria-expanded={showImport}
          onClick={() => setShowImport((value) => !value)}
        >
          송장 엑셀 업로드
        </button>
        <label>
          아이디·이름 검색
          <input
            aria-label="주문 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="고객 아이디 또는 수령인"
          />
        </label>
        <label>
          상태
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">전체</option>
            {Object.entries(labels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await load();
            })
          }
        >
          <RefreshCw size={16} />
          새로고침
        </button>
      </div>
      <div className="data-actions">
        <button
          className="button"
          disabled={busy}
          onClick={() => setShowParcel((v) => !v)}
        >
          {showParcel ? '택배 엑셀 닫기' : '택배용 엑셀 내보내기'}
        </button>
      </div>
      {showParcel && <ParcelExportPanel orders={orders} />}
      {showImport && <ShipmentImportPanel onSaved={load} />}
      {error && (
        <p className="error-copy" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="save-success" role="status">
          {notice}
        </p>
      )}
      <div className="order-layout">
        <div className="order-list" aria-label="주문 목록">
          {orders
            .filter(
              (o) =>
                (filter === 'all' || filter === o.status) &&
                `${o.customer_handle} ${o.recipient.name ?? ''}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
            )
            .map((o) => (
              <button
                key={o.order_id}
                className={`order-row ${o.order_id === selected ? 'selected' : ''}`}
                disabled={busy}
                onClick={() => {
                  if (
                    dirty &&
                    !window.confirm(
                      '저장하지 않은 수정 내용이 있습니다. 다른 주문을 열까요?',
                    )
                  )
                    return;
                  setSelected(o.order_id);
                  setError('');
                  setNotice('');
                }}
              >
                <strong>{o.recipient.name ?? o.customer_handle}</strong>
                <span>
                  {o.customer_handle} · {labels[o.status]}
                </span>
                <span>
                  {o.amounts ? money(o.amounts.total_krw) : '금액 확인 필요'}
                </span>
                <small>{o.order_id}</small>
              </button>
            ))}
          {!orders.length && <p className="muted">저장한 주문이 없습니다.</p>}
        </div>
        {order && edit ? (
          <article
            className="resource-editor order-editor"
            key={order.order_id}
          >
            <header>
              <div>
                <h2>
                  <Package size={19} /> {order.customer_handle}
                </h2>
                <p className="small muted">
                  {labels[order.status]} · 버전 {order.version}
                  {order.historical ? ' · 과거 기록' : ''}
                </p>
              </div>
              <button
                className="button danger"
                disabled={busy}
                onClick={() => setDeleteTarget(order)}
              >
                <Trash2 size={16} />
                기록 삭제
              </button>
            </header>
            <p className="small muted">
              임시 저장은 재고를 예약하지 않습니다. 확정 주문의 금액과 상품
              정보는 저장 당시 값을 유지합니다.
            </p>
            <fieldset disabled={busy || !editable}>
              <div className="form-grid">
                {(
                  ['name', 'phone_raw', 'postal_code', 'address_raw'] as const
                ).map((key, i) => (
                  <label key={key}>
                    {['받는 분', '연락처', '우편번호 (선택)', '배송지'][i]}
                    <input
                      value={edit.recipient[key] ?? ''}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          recipient: {
                            ...edit.recipient,
                            [key]: e.target.value || null,
                          },
                        })
                      }
                      maxLength={key === 'address_raw' ? 2000 : 100}
                    />
                  </label>
                ))}
                <label>
                  입금자명
                  <input
                    value={edit.depositor_name ?? ''}
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        depositor_name: e.target.value || null,
                      })
                    }
                    maxLength={100}
                  />
                </label>
              </div>
              <h3>주문 상품</h3>
              {edit.items.map((item, index) => (
                <div className="order-item" key={index}>
                  <label>
                    상품·옵션
                    <select
                      value={item.sku ?? ''}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          items: edit.items.map((v, n) =>
                            n === index
                              ? { ...v, sku: e.target.value || null }
                              : v,
                          ),
                        })
                      }
                    >
                      <option value="">선택하세요</option>
                      {!editable && item.sku && (
                        <option value={item.sku}>
                          {order.item_labels[index] ?? item.sku} ·{' '}
                          {order.item_prices[index] !== null &&
                          order.item_prices[index] !== undefined
                            ? money(order.item_prices[index]!)
                            : '단가 확인 필요'}
                        </option>
                      )}
                      {editable &&
                        resources?.products.flatMap((p) =>
                          p.variants.map((v) => (
                            <option key={v.sku} value={v.sku}>
                              {p.name} · {v.color}/{v.size} · 재고{' '}
                              {v.stock_available}
                            </option>
                          )),
                        )}
                      {editable &&
                        item.sku &&
                        !resources?.products.some((p) =>
                          p.variants.some((v) => v.sku === item.sku),
                        ) && (
                          <option value={item.sku}>
                            {order.item_labels[index] ?? item.sku} (현재
                            상품표에 없음)
                          </option>
                        )}
                    </select>
                  </label>
                  <label>
                    수량
                    <input
                      type="number"
                      min={1}
                      max={10000}
                      value={item.quantity ?? ''}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          items: edit.items.map((v, n) =>
                            n === index
                              ? {
                                  ...v,
                                  quantity: e.target.value
                                    ? Number(e.target.value)
                                    : null,
                                }
                              : v,
                          ),
                        })
                      }
                    />
                  </label>
                  <button
                    className="icon-button"
                    aria-label={`주문 상품 ${index + 1} 삭제`}
                    onClick={() =>
                      setEdit({
                        ...edit,
                        items: edit.items.filter((_, n) => n !== index),
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              <button
                className="button"
                onClick={() =>
                  setEdit({
                    ...edit,
                    items: [...edit.items, { sku: null, quantity: 1 }],
                  })
                }
              >
                <Plus size={16} />
                상품 추가
              </button>
            </fieldset>
            {editable && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void save()}
              >
                <Save size={16} />
                최신 견적으로 저장
              </button>
            )}
            <div className="order-totals">
              {order.amounts ? (
                <>
                  <span>상품 {money(order.amounts.subtotal_krw)}</span>
                  <span>할인 {money(order.amounts.discount_krw)}</span>
                  <span>배송 {money(order.amounts.shipping_fee_krw)}</span>
                  <strong>총 {money(order.amounts.total_krw)}</strong>
                </>
              ) : (
                <strong>금액 확인 필요</strong>
              )}
            </div>
            {order.issues.length > 0 && (
              <ul className="order-issues">
                {order.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
            {editable && (
              <form
                className="payment-check"
                onSubmit={confirm}
                key={`${order.order_id}:${order.version}`}
              >
                <h3>판매자 입금 확인</h3>
                <p>
                  은행에서 확인한 실제 입금 내역을 입력하세요. 고객의
                  “입금했어요” 메시지는 입금 확인이 아닙니다.
                </p>
                <fieldset
                  disabled={
                    busy || !!dirty || !!order.issues.length || !!command
                  }
                >
                  <label>
                    실제 입금액 (원)
                    <input
                      type="number"
                      name="amount"
                      required
                      min={0}
                      max={1e9}
                    />
                  </label>
                  <label>
                    실제 입금자명
                    <input name="depositor" required maxLength={100} />
                  </label>
                  <label className="check-line">
                    <input
                      type="checkbox"
                      required
                      checked={confirmedChecks}
                      onChange={(e) => setConfirmedChecks(e.target.checked)}
                    />
                    실제 입금을 확인했고, 배송지도 직접 확인했습니다.
                  </label>
                </fieldset>
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    !!dirty ||
                    !!order.issues.length ||
                    (!command && !confirmedChecks)
                  }
                >
                  <CheckCircle2 size={16} />
                  {command
                    ? '같은 요청으로 확정 결과 확인'
                    : '입금 확인 후 주문 확정'}
                </button>
                {dirty && (
                  <p className="small muted">수정 내용을 먼저 저장하세요.</p>
                )}
              </form>
            )}
            {['confirmed', 'shipped'].includes(order.status) && (
              <ShipmentPanel
                key={order.order_id}
                order={order}
                busy={busy}
                onBusy={setBusy}
                onSaved={async (updated) => {
                  setOrders((rows) =>
                    rows.map((o) =>
                      o.order_id === updated.order_id ? updated : o,
                    ),
                  );
                  await load();
                }}
              />
            )}
            {order.payment && (
              <p className="save-success">
                {order.payment.checked_at} · 판매자 {order.payment.actor} 확인 ·{' '}
                {money(order.payment.amount_krw)} ·{' '}
                {order.payment.depositor_name}
              </p>
            )}
          </article>
        ) : (
          <p className="muted">주문을 선택하세요.</p>
        )}
      </div>
      {deleteTarget && (
        <div
          className="inline-confirm"
          role="alertdialog"
          aria-label="주문 기록 삭제 확인"
        >
          <h2>이 주문 기록을 삭제할까요?</h2>
          <p>
            {deleteTarget.customer_handle} · {deleteTarget.recipient.name} ·{' '}
            {labels[deleteTarget.status]}
          </p>
          <p>
            삭제 후 복구할 수 없습니다.{' '}
            <strong>이미 차감된 재고는 복원하지 않습니다.</strong> 발송·정정
            이력도 삭제하고, 이 주문이 포함된 택배 파일의 재다운로드를
            중단합니다. 대화와 상품·정책은 유지합니다.
          </p>
          <button
            className="button"
            disabled={busy}
            onClick={() => setDeleteTarget(null)}
          >
            취소
          </button>
          <button
            className="button danger"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const rows = await api.deleteOrder(
                  deleteTarget.order_id,
                  deleteTarget.version,
                );
                setOrders(rows);
                setSelected(rows[0]?.order_id ?? null);
                setDeleteTarget(null);
                await load();
                setNotice(
                  '주문 기록을 삭제했습니다. 재고는 변경하지 않았습니다.',
                );
              })
            }
          >
            기록 삭제 실행
          </button>
        </div>
      )}
    </section>
  );
}
