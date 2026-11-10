import { useEffect, useRef, useState } from 'react';
import { ListChecks, Plus, Trash2 } from 'lucide-react';
import {
  maxBatchBytes,
  maxBatchItems,
  type BatchEntry,
  type BatchItem,
  type BatchView,
  type CreateBatch,
} from '../../src/domain/batch.js';
import { api } from './api';
import { kinds, reviewRank, statusLabels } from './data';

const empty = (): BatchEntry & { key: string } => ({
  key: crypto.randomUUID(),
  customer_handle: '',
  context_label: '',
  text: '',
});
const stateLabels = {
  queued: '대기',
  running: '결과 확인 필요',
  completed: '분석 완료',
  failed: '실패',
};
const pendingItem = (batch: BatchView) =>
  batch.items.find(({ status }) => status === 'running') ??
  batch.items.find(({ status }) => status === 'queued');

export function BatchPanel({
  timeout,
  onChanged,
  onOpenRoom,
}: {
  timeout: number;
  onChanged: () => Promise<void>;
  onOpenRoom: (id: string) => void;
}) {
  const [entries, setEntries] = useState(() => [empty()]);
  const [list, setList] = useState<
    Awaited<ReturnType<typeof api.batches>>['batches']
  >([]);
  const [batch, setBatch] = useState<BatchView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [workingItem, setWorkingItem] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<CreateBatch | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void api.batches().then(
      ({ batches }) => {
        if (mounted.current) setList(batches);
      },
      (error: unknown) => {
        if (mounted.current)
          setError(
            error instanceof Error
              ? error.message
              : '목록을 불러오지 못했습니다.',
          );
      },
    );
    return () => {
      mounted.current = false;
    };
  }, []);
  function update(index: number, field: keyof BatchEntry, value: string) {
    setEntries((items) =>
      items.map((item, i) =>
        i === index ? { ...item, [field]: value } : item,
      ),
    );
  }
  async function action(run: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await run();
    } catch (error) {
      if (mounted.current)
        setError(
          error instanceof Error ? error.message : '처리하지 못했습니다.',
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setBusy(false);
        setWorkingItem(null);
      }
    }
  }
  function show(next: BatchView) {
    const { items: _, ...summary } = next;
    void _;
    setBatch(next);
    setList((current) =>
      [
        summary,
        ...current.filter(({ batch_id }) => batch_id !== summary.batch_id),
      ].slice(0, 50),
    );
  }
  async function save() {
    const body = submitting ?? {
      batch_id: crypto.randomUUID(),
      items: entries.map(({ customer_handle, context_label, text }) => ({
        customer_handle,
        context_label,
        text,
      })),
    };
    if (
      new TextEncoder().encode(JSON.stringify(body)).byteLength > maxBatchBytes
    ) {
      setError('한 번에 보낼 원문이 64 KiB를 넘습니다. 건수를 나누어 주세요.');
      return;
    }
    setSubmitting(body);
    const next = await api.createBatch(body);
    if (!mounted.current) return;
    setSubmitting(null);
    setEntries([empty()]);
    show(next);
  }
  async function process(current: BatchView, retryItem?: BatchItem) {
    let next = current;
    let item = retryItem ?? pendingItem(next);
    while (item && mounted.current) {
      setWorkingItem(item.item_id);
      const previous = item;
      next = await api.processBatch(
        next.batch_id,
        item.item_id,
        item.request_id,
        !!retryItem,
        timeout,
      );
      if (mounted.current) show(next);
      await onChanged();
      if (retryItem) return;
      item = pendingItem(next);
      if (item?.item_id === previous.item_id) break;
    }
  }

  const pending = batch && pendingItem(batch);
  const sorted = batch?.items.toSorted(
    (a, b) =>
      reviewRank(
        a.outcome?.classification ?? null,
        a.outcome?.needs_attention ?? false,
      ) -
      reviewRank(
        b.outcome?.classification ?? null,
        b.outcome?.needs_attention ?? false,
      ),
  );
  return (
    <div className="batch-panel">
      <p className="small muted">
        고객별로 원문을 나누어 붙여넣으세요. 한 번에 최대 {maxBatchItems}건을
        접수하고 한 건씩 분석합니다.
      </p>
      {list.length > 0 && (
        <label className="batch-field">
          접수 목록
          <select
            disabled={busy || !!submitting}
            value={batch?.batch_id ?? ''}
            onChange={(e) => {
              const id = e.target.value;
              if (!id) setBatch(null);
              else
                void action(async () => {
                  const next = await api.batch(id);
                  if (mounted.current) show(next);
                });
            }}
          >
            <option value="">새 접수</option>
            {list.map((item) => (
              <option key={item.batch_id} value={item.batch_id}>
                {new Date(item.created_at).toLocaleString('ko-KR')} ·{' '}
                {item.total}건 ({item.completed + item.failed}건 처리)
              </option>
            ))}
          </select>
        </label>
      )}
      {batch ? (
        <>
          <div className="data-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const next = await api.batch(batch.batch_id);
                  if (mounted.current) show(next);
                  await onChanged();
                })
              }
            >
              상태 새로고침
            </button>
            {pending && (
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() => void action(() => process(batch))}
              >
                <ListChecks size={16} />{' '}
                {pending.status === 'running'
                  ? '같은 요청부터 이어서 분석'
                  : '대기 건 분석'}
              </button>
            )}
          </div>
          <p role="status" className="small">
            총 {batch.total}건 · 완료 {batch.completed}건 · 실패 {batch.failed}
            건{workingItem ? ' · 한 건 분석 중' : ''}
          </p>
          <ol className="batch-list">
            {sorted?.map((item) => (
              <li key={item.item_id}>
                <strong>
                  {batch.items.indexOf(item) + 1}.{' '}
                  {item.customer_handle || '아이디 없음'}
                </strong>
                {item.context_label && (
                  <p className="small muted">{item.context_label}</p>
                )}
                <p>
                  {workingItem === item.item_id
                    ? '분석 중'
                    : stateLabels[item.status]}
                  {item.outcome?.classification &&
                    ' · ' + kinds[item.outcome.classification]}
                  {item.status === 'completed' &&
                    item.outcome?.analysis_status &&
                    ' · ' + statusLabels[item.outcome.analysis_status]}
                </p>
                {item.outcome?.error && (
                  <p className="small error-copy">
                    {item.outcome.error.message}
                  </p>
                )}
                <details>
                  <summary>DM 원문 보기</summary>
                  <p className="batch-original">{item.text}</p>
                </details>
                <div className="data-actions">
                  {item.status === 'completed' && item.conversation_id && (
                    <button
                      type="button"
                      className="button"
                      onClick={() => onOpenRoom(item.conversation_id!)}
                    >
                      결과 검토
                    </button>
                  )}
                  {item.status === 'failed' &&
                    item.outcome?.error?.retryable && (
                      <button
                        type="button"
                        className="button"
                        disabled={busy || pending?.status === 'running'}
                        onClick={() => void action(() => process(batch, item))}
                      >
                        이 건만 다시 분석
                      </button>
                    )}
                </div>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(save);
          }}
        >
          <p className="small muted">
            아래 입력을 확인하고 접수하세요. 접수 후에 분석을 시작할 수
            있습니다.
          </p>
          {entries.map((entry, index) => (
            <fieldset key={entry.key} disabled={busy || !!submitting}>
              <legend>DM {index + 1}</legend>
              <label className="batch-field">
                고객 아이디
                <input
                  required
                  maxLength={100}
                  value={entry.customer_handle}
                  onChange={(e) =>
                    update(index, 'customer_handle', e.target.value)
                  }
                  placeholder="@고객아이디"
                />
              </label>
              <label className="batch-field">
                상담 맥락 (선택)
                <input
                  maxLength={200}
                  value={entry.context_label}
                  onChange={(e) =>
                    update(index, 'context_label', e.target.value)
                  }
                />
              </label>
              <label className="batch-field">
                DM 원문
                <textarea
                  required
                  maxLength={20000}
                  rows={3}
                  value={entry.text}
                  onChange={(e) => update(index, 'text', e.target.value)}
                />
              </label>
              {entries.length > 1 && (
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    setEntries((current) =>
                      current.filter(({ key }) => key !== entry.key),
                    )
                  }
                >
                  <Trash2 size={16} /> 이 입력 삭제
                </button>
              )}
            </fieldset>
          ))}
          <footer>
            <button
              type="button"
              className="button"
              disabled={busy || !!submitting || entries.length >= maxBatchItems}
              onClick={() => setEntries((current) => [...current, empty()])}
            >
              <Plus size={16} /> DM 입력 추가
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={
                busy ||
                entries.some(
                  ({ customer_handle, text }) =>
                    !customer_handle.trim() || !text.trim(),
                )
              }
            >
              {submitting ? '같은 접수 다시 확인' : `${entries.length}건 접수`}
            </button>
          </footer>
        </form>
      )}
      {error && (
        <p className="error-copy" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
