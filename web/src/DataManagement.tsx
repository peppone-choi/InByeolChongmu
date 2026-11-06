import { useState } from 'react';
import { Download, Upload, Trash2, Database } from 'lucide-react';
import type { Resources } from '../../src/domain/http-contract';
import type { ImportPreview } from '../../src/domain/data-contract';
import { api } from './api';
export function DataManagement({
  resources,
  onSaved,
  onChatsReset,
}: {
  resources: Resources | null;
  onSaved: (r: Resources) => void;
  onChatsReset: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [scope, setScope] = useState<'catalog' | 'orders' | 'chats' | null>(null),
    [counts, setCounts] = useState({ orders: 0, chats: 0 }),
    [word, setWord] = useState('');
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
  const download = (format: 'xlsx' | 'json') =>
    act(async () => {
      const response = await fetch(`/api/data/export?format=${format}`, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        const raw = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(
          raw?.error?.message ??
            '내보내기에 실패했습니다. 연결 상태를 확인하세요.',
        );
      }
      const blob = await response.blob(),
        url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = `inbyeol-data-${new Date().toISOString().slice(0, 10)}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(
        '현재 데이터를 내보냈습니다. 고객 개인정보가 포함된 파일은 안전하게 보관하세요.',
      );
    });
  const choose = (next: typeof scope) =>
    act(async () => {
      const [latest, stats] = await Promise.all([
        api.resources(),
        api.dataStats(),
      ]);
      onSaved(latest);
      setCounts({ orders: stats.orders, chats: stats.chats });
      setScope(next);
      setWord('');
    });
  return (
    <section className="setting-section data-management">
      <header>
        <Database size={20} />
        <div>
          <h2>자료 가져오기·내보내기·초기화</h2>
          <p>
            서버에 저장된 자료를 관리합니다. 내보내기 파일에는 고객 개인정보가
            포함됩니다.
          </p>
        </div>
      </header>
      <div className="data-actions">
        <button
          className="button"
          disabled={busy}
          onClick={() => void download('xlsx')}
        >
          <Download size={16} />
          현재 데이터 엑셀 내보내기
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() => void download('json')}
        >
          <Download size={16} />
          전체 JSON 내보내기
        </button>
      </div>
      <p className="small muted">
        엑셀: 상품·정책·주문·대화·분석 시트. 택배사 등록 양식이 아닙니다.
        상품·정책 시트는 가져오기 양식으로 쓸 수 있습니다.
      </p>
      <label className="file-label">
        <Upload size={16} />
        상품·정책 엑셀 분석
        <input
          type="file"
          accept=".xlsx"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            setPreview(null);
            void act(async () => {
              if (file.size > 2 * 1024 * 1024)
                throw new Error('파일은 최대 2 MiB입니다.');
              setPreview(await api.importPreview(file));
            });
          }}
        />
      </label>
      <p className="small muted">
        products(상품)·policies(정책) 시트, 최대 2 MiB·시트당 10,000행. 동일
        상품 ID는 옵션 전체를 교체하며 파일에 없는 상품·정책은 유지합니다.
        주문·대화 시트는 가져오지 않습니다.
      </p>
      {preview && (
        <div className="import-preview" aria-label="엑셀 분석 미리보기">
          <h3>저장 전 미리보기</h3>
          {preview.sheets.map((s) => (
            <p key={s.name}>
              <strong>
                {s.name} · {s.rows}행
              </strong>
              <br />
              <span className="small muted">
                인식한 열: {s.columns.join(', ')}
              </span>
            </p>
          ))}
          <p>
            상품 추가 {preview.changes.products_added} · 상품 갱신{' '}
            {preview.changes.products_updated} · 정책 추가{' '}
            {preview.changes.policies_added} · 정책 갱신{' '}
            {preview.changes.policies_updated}
          </p>
          <ul>
            {preview.samples.map((s, i) => (
              <li key={i}>
                {s.sheet} {s.row}행: {s.summary}
              </li>
            ))}
          </ul>
          {preview.errors.length > 0 ? (
            <>
              <p className="error-copy">
                오류 {preview.errors.length}건, 아직 저장하지 않았습니다.
              </p>
              <ul className="order-issues">
                {preview.errors.map((e, i) => (
                  <li key={i}>
                    {e.sheet} {e.row}행: {e.message}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>
              검증을 통과했습니다. 아래 버튼을 누르면 전체 변경을 한 번에
              저장합니다.
            </p>
          )}
          <div className="data-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              미리보기 닫기
            </button>
            <button
              className="button primary"
              disabled={busy || !!preview.errors.length}
              onClick={() =>
                void act(async () => {
                  const latest = await api.importApply(preview.token);
                  onSaved(latest);
                  setPreview(null);
                  setNotice(
                    '상품·정책을 가져왔습니다. 기존 분석은 다시 확인하세요.',
                  );
                })
              }
            >
              검증된 변경 가져오기
            </button>
          </div>
          <p className="small muted">
            미리보기는 10분간 유효합니다. 그 사이 자료가 바뀌면 다시 분석해야
            합니다.
          </p>
        </div>
      )}
      <div className="reset-options">
        <h3>영역별 초기화</h3>
        <p className="small muted">
          다른 영역은 유지합니다. 삭제 전 데이터를 내보낼 수 있습니다.
        </p>
        <button
          className="button danger"
          disabled={busy}
          onClick={() => void choose('catalog')}
        >
          <Trash2 size={16} />
          상품·정책 비우기
        </button>
        <button
          className="button danger"
          disabled={busy}
          onClick={() => void choose('orders')}
        >
          <Trash2 size={16} />
          주문 기록 비우기
        </button>
        <button
          className="button danger"
          disabled={busy}
          onClick={() => void choose('chats')}
        >
          <Trash2 size={16} />
          채팅 기록 비우기
        </button>
      </div>
      {scope && (
        <div
          className="inline-confirm"
          role="alertdialog"
          aria-label="영역 초기화 확인"
        >
          <h3>
            {scope === 'catalog'
              ? `상품 ${resources?.products.length ?? 0}종·정책 ${resources?.policies.length ?? 0}개`
              : scope === 'orders'
                ? `주문 ${counts.orders}건`
                : `채팅 ${counts.chats}개 방(전체)`}
            비우기
          </h3>
          <p>
            {scope === 'catalog'
              ? '상품과 정책만 비웁니다. 주문·대화는 유지하며 재시작해도 샘플을 다시 채우지 않습니다.'
              : scope === 'orders'
                ? '주문 기록만 삭제합니다. 이미 차감된 재고는 복원하지 않습니다. 상품·정책·대화는 유지합니다.'
                : '전체 대화·원문·분석·도구 실행 기록과 별도 Flue 저장소를 삭제합니다. 상품·정책·주문은 유지합니다. 외부 모델 서비스 기록과 이미 내려받은 파일은 삭제되지 않습니다.'}
          </p>
          <p>
            <strong>복구할 수 없습니다.</strong> 실행하려면 ‘초기화’를
            입력하세요.
          </p>
          <input
            aria-label="초기화 확인 문구"
            value={word}
            onChange={(e) => setWord(e.target.value)}
            disabled={busy}
          />
          <div className="data-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => setScope(null)}
            >
              취소
            </button>
            <button
              className="button danger"
              disabled={busy || word !== '초기화'}
              onClick={() =>
                void act(async () => {
                  if (!resources) return;
                  const result = await api.resetData(
                    scope,
                    resources.snapshots,
                  );
                  onSaved(result.resources);
                  if (scope === 'chats') await onChatsReset();
                  setScope(null);
                  setPreview(null);
                  setNotice('선택한 영역을 초기화했습니다.');
                })
              }
            >
              선택 영역 초기화 실행
            </button>
          </div>
        </div>
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
    </section>
  );
}
