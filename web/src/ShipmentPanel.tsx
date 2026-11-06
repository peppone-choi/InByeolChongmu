import { useEffect, useState, type FormEvent } from 'react';
import { Truck, History, Save } from 'lucide-react';
import type { SavedOrder } from '../../src/domain/commerce';
import type { ShipmentCommand, ShipmentEvent } from '../../src/domain/shipping';
import { api, ApiError } from './api';
const localTime = (time: string) => {
  const d = new Date(time);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 23);
};
const displayTime = (value: string) => new Date(value).toLocaleString('ko-KR');
export function ShipmentPanel({
  order,
  busy,
  onBusy,
  onSaved,
}: {
  order: SavedOrder;
  busy: boolean;
  onBusy: (b: boolean) => void;
  onSaved: (o: SavedOrder) => Promise<void>;
}) {
  const [events, setEvents] = useState<ShipmentEvent[]>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [correcting, setCorrecting] = useState(false),
    [pending, setPending] = useState<ShipmentCommand | null>(null),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void api
      .shipmentHistory(order.order_id)
      .then((rows) => {
        if (live) {
          setEvents(rows);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (live) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [order.order_id, order.version]);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const form = new FormData(e.currentTarget);
    onBusy(true);
    setError('');
    setNotice('');
    void (async () => {
      try {
        const input =
          pending ??
          (() => {
            const common = {
              command_id: crypto.randomUUID(),
              expected_version: order.version,
              carrier: String(form.get('carrier')),
              tracking_number: String(form.get('tracking')),
              shipped_at: new Date(
                String(form.get('shipped_at')),
              ).toISOString(),
            };
            return order.status === 'shipped'
              ? {
                  ...common,
                  operation: 'update_shipment' as const,
                  correction_reason: String(form.get('reason')),
                }
              : { ...common, operation: 'register_shipment' as const };
          })();
        setPending(input);
        const result = await api.shipment(order.order_id, input);
        setPending(null);
        setCorrecting(false);
        await onSaved(result.order);
        setNotice(
          result.replayed
            ? '저장된 처리 결과를 다시 확인했습니다.'
            : '발송 기록과 이력을 저장했습니다. 재고·금액은 변경하지 않았습니다.',
        );
      } catch (e) {
        if (e instanceof ApiError && e.status > 0 && e.status < 500)
          setPending(null);
        setError(
          e instanceof Error
            ? e.message
            : '결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.',
        );
      } finally {
        onBusy(false);
      }
    })();
  };
  return (
    <section className="shipment-panel" aria-label="발송·송장 기록">
      <h3>
        <Truck size={17} />
        발송·송장
      </h3>
      <p className="small muted">
        실제 발송한 뒤 직접 기록하세요. 송장 발급·배송 조회·고객 전송을 자동으로
        실행하지 않습니다.
      </p>
      {order.status === 'shipped' && (
        <>
          <dl className="shipment-summary">
            <dt>택배사</dt>
            <dd>{order.carrier ?? '미기록'}</dd>
            <dt>송장번호</dt>
            <dd>{order.tracking_number ?? '미기록'}</dd>
            <dt>발송일</dt>
            <dd>
              {order.shipped_at ? displayTime(order.shipped_at) : '미기록'}
            </dd>
          </dl>
          {!correcting && (
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                setCorrecting(true);
                setError('');
              }}
            >
              송장·발송 기록 정정
            </button>
          )}
        </>
      )}
      {(order.status === 'confirmed' || correcting) && (
        <form
          onSubmit={submit}
          key={`${order.order_id}:${order.version}:${correcting}`}
        >
          <fieldset disabled={busy || !!pending}>
            <div className="form-grid">
              <label>
                택배사
                <input
                  name="carrier"
                  required
                  maxLength={100}
                  defaultValue={order.carrier ?? ''}
                />
              </label>
              <label>
                송장번호
                <input
                  name="tracking"
                  required
                  maxLength={100}
                  defaultValue={order.tracking_number ?? ''}
                  inputMode="text"
                />
              </label>
              <label>
                실제 발송 시각
                <input
                  type="datetime-local"
                  step="0.001"
                  name="shipped_at"
                  required
                  defaultValue={localTime(
                    order.shipped_at ?? new Date().toISOString(),
                  )}
                />
              </label>
            </div>
            {correcting && (
              <label>
                정정 사유
                <textarea name="reason" required maxLength={1000} rows={2} />
              </label>
            )}
            <label className="check-line">
              <input type="checkbox" required />
              실제 발송 내역을 확인했습니다.
              {correcting ? ' 변경 전후와 정정 사유가 이력에 남습니다.' : ''}
            </label>
          </fieldset>
          <div className="data-actions">
            {correcting && !pending && (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => setCorrecting(false)}
              >
                정정 취소
              </button>
            )}
            <button className="button primary" disabled={busy}>
              <Save size={16} />
              {pending
                ? '같은 요청으로 결과 확인'
                : correcting
                  ? '정정 기록 저장'
                  : '발송·송장 기록 저장'}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="error-copy" role="alert">
          {error}
          <br />
          <span className="small">
            버전 충돌이면 주문을 새로고침한 뒤 다시 확인하세요.
          </span>
        </p>
      )}
      {notice && (
        <p className="save-success" role="status">
          {notice}
        </p>
      )}
      <details className="shipment-history">
        <summary>
          <History size={16} />
          발송·정정 이력 ({events.length})
        </summary>
        {loading ? (
          <p>이력을 불러오는 중입니다.</p>
        ) : events.length === 0 ? (
          <p className="small muted">
            이 앱에서 기록한 발송 이력이 없습니다. 기존 송장은 위에 표시합니다.
          </p>
        ) : (
          events.map((event) => (
            <article key={event.event_id}>
              <strong>
                {event.operation === 'register_shipment'
                  ? '최초 발송 등록'
                  : '발송 기록 정정'}{' '}
                · 버전 {event.version}
              </strong>
              <p className="small muted">
                {displayTime(event.recorded_at)} · 판매자 {event.actor}
              </p>
              {event.correction_reason && (
                <p>사유: {event.correction_reason}</p>
              )}
              <p>
                변경 전: {event.before.carrier ?? '없음'} /{' '}
                {event.before.tracking_number ?? '없음'} /{' '}
                {event.before.shipped_at
                  ? displayTime(event.before.shipped_at)
                  : '없음'}
              </p>
              <p>
                변경 후: {event.after.carrier} / {event.after.tracking_number} /{' '}
                {event.after.shipped_at
                  ? displayTime(event.after.shipped_at)
                  : '없음'}
              </p>
            </article>
          ))
        )}
      </details>
    </section>
  );
}
