import { useEffect, useState } from 'react';
import { Download, Truck, Settings2, ArrowUp, ArrowDown } from 'lucide-react';
import type { SavedOrder } from '../../src/domain/commerce';
import {
  parcelFields,
  type ParcelTemplate,
  type ParcelSelection,
  type ParcelPreview,
  type ParcelExport,
} from '../../src/domain/shipping';
import { api, ApiError, downloadParcel } from './api';
const names: Record<string, string> = {
  order_id: '주문번호',
  recipient_name: '받는 분',
  phone: '연락처',
  postal_code: '우편번호',
  address: '주소',
  item_summary: '상품명·수량',
  total_krw: '주문금액',
  shipping_memo: '배송메모',
};
export function ParcelExportPanel({ orders }: { orders: SavedOrder[] }) {
  const [template, setTemplate] = useState<{
      version: string;
      template: ParcelTemplate;
    } | null>(null),
    [editing, setEditing] = useState<ParcelTemplate | null>(null),
    [selected, setSelected] = useState<string[]>(() =>
      orders
        .filter((o) => o.status === 'confirmed')
        .slice(0, 500)
        .map((o) => o.order_id),
    ),
    [notes, setNotes] = useState<Record<string, string>>({}),
    [preview, setPreview] = useState<{
      input: ParcelSelection;
      result: ParcelPreview;
    } | null>(null),
    [history, setHistory] = useState<ParcelExport[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [repeat, setRepeat] = useState(false),
    [pending, setPending] = useState<
      Parameters<typeof api.parcelCreate>[0] | null
    >(null);
  useEffect(() => {
    let live = true;
    void Promise.all([api.parcelTemplate(), api.parcelExports()])
      .then(([t, h]) => {
        if (live) {
          setTemplate(t);
          setHistory(h);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '요청에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };
  const invalidate = () => {
    setPreview(null);
    setRepeat(false);
  };
  const create = () =>
    act(async () => {
      if (!preview) return;
      const input = pending ?? {
        ...preview.input,
        command_id: crypto.randomUUID(),
        fingerprint: preview.result.fingerprint,
        acknowledge_repeat: repeat,
      };
      setPending(input);
      let result: ParcelExport;
      try {
        result = await api.parcelCreate(input);
      } catch (e) {
        if (e instanceof ApiError && e.status > 0 && e.status < 500)
          setPending(null);
        throw e;
      }
      setPending(null);
      setHistory((rows) => [
        result,
        ...rows.filter((row) => row.export_id !== result.export_id),
      ]);
      invalidate();
      await downloadParcel(result.export_id);
      setNotice(
        '택배용 공통 명단을 내려받았습니다. 실제 접수 프로그램 양식과 열을 확인하세요. 주문 상태·재고는 바뀌지 않았습니다.',
      );
    });
  const updateColumn = (
    index: number,
    patch: Partial<ParcelTemplate['columns'][number]>,
  ) => {
    if (editing)
      setEditing({
        ...editing,
        columns: editing.columns.map((c, n) =>
          n === index ? { ...c, ...patch } : c,
        ),
      });
  };
  return (
    <section
      className="parcel-panel resource-editor"
      aria-label="택배용 엑셀 내보내기"
    >
      <header>
        <h2>
          <Truck size={20} />
          택배용 엑셀
        </h2>
        <button
          className="button"
          disabled={busy || !!pending || !template}
          onClick={() => {
            setEditing(editing ? null : structuredClone(template!.template));
            invalidate();
          }}
        >
          <Settings2 size={16} />열 설정
        </button>
      </header>
      <p className="small muted">
        택배사 미정용 공통 발송명단입니다. 실제 택배사 업로드 호환성은 아직
        검증하지 않았습니다. 파일 생성은 접수·발송이 아닙니다.
      </p>
      {editing && (
        <form
          aria-label="택배 엑셀 열 설정"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              if (!template) return;
              const next = await api.saveParcelTemplate(
                template.version,
                editing,
              );
              setTemplate(next);
              setEditing(null);
              invalidate();
              setNotice('열 설정을 저장했습니다.');
            });
          }}
        >
          <fieldset disabled={busy || !!pending}>
            <div className="form-grid">
              <label>
                양식 이름
                <input
                  value={editing.name}
                  maxLength={100}
                  required
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                />
              </label>
              <label>
                시트 이름
                <input
                  value={editing.sheet_name}
                  maxLength={31}
                  required
                  onChange={(e) =>
                    setEditing({ ...editing, sheet_name: e.target.value })
                  }
                />
              </label>
            </div>
            {editing.columns.map((c, n) => (
              <div className="parcel-column" key={c.field}>
                <strong>{names[c.field]}</strong>
                <label>
                  열 이름
                  <input
                    aria-label={`${names[c.field]} 열 이름`}
                    value={c.header}
                    maxLength={100}
                    required
                    onChange={(e) =>
                      updateColumn(n, { header: e.target.value })
                    }
                  />
                </label>
                <label className="check-line">
                  <input
                    type="checkbox"
                    aria-label={`${names[c.field]} 필수`}
                    checked={c.required}
                    disabled={['recipient_name', 'phone', 'address'].includes(
                      c.field,
                    )}
                    onChange={(e) =>
                      updateColumn(n, { required: e.target.checked })
                    }
                  />
                  필수
                </label>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`${names[c.field]} 위로`}
                  disabled={n === 0}
                  onClick={() => {
                    const cols = [...editing.columns];
                    [cols[n - 1], cols[n]] = [cols[n]!, cols[n - 1]!];
                    setEditing({ ...editing, columns: cols });
                  }}
                >
                  <ArrowUp size={16} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`${names[c.field]} 아래로`}
                  disabled={n === editing.columns.length - 1}
                  onClick={() => {
                    const cols = [...editing.columns];
                    [cols[n + 1], cols[n]] = [cols[n]!, cols[n + 1]!];
                    setEditing({ ...editing, columns: cols });
                  }}
                >
                  <ArrowDown size={16} />
                </button>
                {!['recipient_name', 'phone', 'address'].includes(c.field) && (
                  <button
                    type="button"
                    className="button"
                    aria-label={`${names[c.field]} 열 제외`}
                    onClick={() =>
                      setEditing({
                        ...editing,
                        columns: editing.columns.filter((_, i) => i !== n),
                      })
                    }
                  >
                    열 제외
                  </button>
                )}
              </div>
            ))}
            <div className="data-actions">
              {parcelFields
                .filter(
                  (field) => !editing.columns.some((c) => c.field === field),
                )
                .map((field) => (
                  <button
                    key={field}
                    type="button"
                    className="button"
                    onClick={() =>
                      setEditing({
                        ...editing,
                        columns: [
                          ...editing.columns,
                          { field, header: names[field]!, required: false },
                        ],
                      })
                    }
                  >
                    {names[field]} 열 추가
                  </button>
                ))}
            </div>
          </fieldset>
          <div className="data-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              설정 취소
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const latest = await api.parcelTemplate();
                  setTemplate(latest);
                  setEditing(structuredClone(latest.template));
                  invalidate();
                  setNotice('최신 열 설정으로 다시 열었습니다.');
                })
              }
            >
              입력 대신 최신 열 설정으로 다시 열기
            </button>
            <button className="button primary" disabled={busy}>
              열 설정 저장
            </button>
          </div>
        </form>
      )}
      <fieldset disabled={busy || !!pending || !!editing}>
        <div className="data-actions">
          <button
            className="button"
            onClick={() => {
              setSelected(
                orders
                  .filter((o) => o.status === 'confirmed')
                  .slice(0, 500)
                  .map((o) => o.order_id),
              );
              invalidate();
            }}
          >
            확정 주문 선택
          </button>
          <button
            className="button"
            onClick={() => {
              setSelected(orders.slice(0, 500).map((o) => o.order_id));
              invalidate();
            }}
          >
            전체 선택·제외 사유 확인
          </button>
          <button
            className="button"
            onClick={() => {
              setSelected([]);
              invalidate();
            }}
          >
            선택 해제
          </button>
          <span className="small muted">
            선택 {selected.length}건 · 최대 500건
          </span>
        </div>
        <div className="parcel-order-selection">
          {orders.map((o) => (
            <div className="parcel-select-row" key={o.order_id}>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={selected.includes(o.order_id)}
                  disabled={
                    !selected.includes(o.order_id) && selected.length >= 500
                  }
                  onChange={(e) => {
                    setSelected((ids) =>
                      e.target.checked
                        ? [...ids, o.order_id]
                        : ids.filter((id) => id !== o.order_id),
                    );
                    invalidate();
                  }}
                />
                {o.recipient.name ?? o.customer_handle} · {o.customer_handle} ·{' '}
                {o.status === 'confirmed'
                  ? '확정'
                  : o.status === 'shipped'
                    ? '발송'
                    : o.status === 'cancelled'
                      ? '취소'
                      : '미확정'}
              </label>
              {selected.includes(o.order_id) && (
                <label>
                  배송메모
                  <input
                    aria-label={`${o.customer_handle} 배송메모`}
                    value={notes[o.order_id] ?? ''}
                    maxLength={500}
                    onChange={(e) => {
                      setNotes({ ...notes, [o.order_id]: e.target.value });
                      invalidate();
                    }}
                  />
                </label>
              )}
            </div>
          ))}
        </div>
        <button
          className="button primary"
          disabled={!template || !selected.length}
          onClick={() =>
            void act(async () => {
              if (!template) return;
              const input = {
                template_version: template.version,
                order_ids: selected,
                notes: Object.fromEntries(
                  Object.entries(notes).filter(
                    ([id, text]) => selected.includes(id) && text.trim(),
                  ),
                ),
              };
              const result = await api.parcelPreview(input);
              setPreview({ input, result });
              setRepeat(false);
            })
          }
        >
          선택 주문 미리보기
        </button>
      </fieldset>
      {preview && (
        <section className="parcel-preview" aria-label="택배 엑셀 미리보기">
          <h3>
            포함 {preview.result.rows.length}건 · 제외{' '}
            {preview.result.excluded.length}건
          </h3>
          <p className="small muted">
            {preview.result.template.template.name} · 열:{' '}
            {preview.result.template.template.columns
              .map((c) => c.header)
              .join(' / ')}
          </p>
          <div className="parcel-preview-rows">
            {preview.result.rows.map((r) => (
              <article key={r.order_id}>
                <dl className="parcel-row-fields">
                  {preview.result.template.template.columns.map((c) => (
                    <div key={c.field}>
                      <dt>{c.header}</dt>
                      <dd>
                        {typeof r[c.field] === 'number'
                          ? Number(r[c.field]).toLocaleString('ko-KR')
                          : String(r[c.field]) || '미입력'}
                      </dd>
                    </div>
                  ))}
                </dl>
              </article>
            ))}
          </div>
          {preview.result.excluded.map((e) => (
            <p className="error-copy" key={e.order_id}>
              {e.order_id}: {e.reason}
            </p>
          ))}
          {preview.result.previous_exports.length > 0 && (
            <div className="repeat-warning">
              <p>
                <strong>
                  이미 내보낸 주문 {preview.result.previous_exports.length}건
                </strong>
                이 있습니다. 중복 접수에 주의하세요.
              </p>
              {preview.result.previous_exports.map((e) => (
                <p className="small" key={e.order_id}>
                  {e.order_id} · {e.count}회 ·{' '}
                  {new Date(e.last_exported_at).toLocaleString('ko-KR')}
                </p>
              ))}
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={repeat}
                  disabled={busy || !!pending}
                  onChange={(e) => setRepeat(e.target.checked)}
                />
                중복 접수 위험을 확인하고 새 파일을 생성합니다.
              </label>
            </div>
          )}
          <button
            className="button primary"
            disabled={
              busy ||
              !preview.result.rows.length ||
              (!pending && !!preview.result.previous_exports.length && !repeat)
            }
            onClick={() => void create()}
          >
            <Download size={16} />
            {pending
              ? '같은 요청으로 생성 결과 확인'
              : '확인한 명단 엑셀 생성·다운로드'}
          </button>
        </section>
      )}
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
      <details className="parcel-history">
        <summary>내보내기 이력 ({history.length})</summary>
        {history.map((h) => (
          <article key={h.export_id}>
            <strong>
              {h.template_name} · {h.included_order_ids.length}건
            </strong>
            <p className="small muted">
              {new Date(h.created_at).toLocaleString('ko-KR')} · 제외{' '}
              {h.excluded.length}건
            </p>
            <button
              className="button"
              disabled={busy || !h.download_available}
              onClick={() =>
                void act(async () => {
                  await downloadParcel(h.export_id);
                  setNotice(
                    '기존 파일을 다시 받았습니다. 새 내보내기 이력은 만들지 않았습니다. 중복 접수를 주의하세요.',
                  );
                })
              }
            >
              기존 파일 다시 받기
            </button>
            {!h.download_available && (
              <p className="small muted">
                포함된 주문 삭제로 파일이 폐기됐습니다.
              </p>
            )}
          </article>
        ))}
      </details>
    </section>
  );
}
