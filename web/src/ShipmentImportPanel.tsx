import { useState } from 'react';
import { Download } from 'lucide-react';
import { api, ApiError } from './api';

export function ShipmentImportPanel({
  onSaved,
}: {
  onSaved: () => Promise<unknown>;
}) {
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof api.shipmentImportPreview>
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function read(file: File | undefined) {
    setPreview(null);
    setError('');
    setNotice('');
    if (!file) return;
    setBusy(true);
    try {
      setPreview(await api.shipmentImportPreview(file));
    } catch (error) {
      setError(
        error instanceof ApiError
          ? error.message
          : '파일을 읽지 못했습니다. 다시 선택해 주세요.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview?.entries.length || preview.errors.length || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.shipmentImportApply(preview.entries);
      setPreview(null);
      setNotice(
        `송장 ${result.registered + result.replayed}건을 발송 기록에서 확인했습니다.`,
      );
      try {
        await onSaved();
      } catch {
        setError('송장은 저장됐습니다. 주문 목록을 새로고침해 주세요.');
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setPreview(null);
      setError(
        error instanceof ApiError
          ? error.message
          : '등록 결과를 확인하지 못했습니다. 같은 미리보기로 다시 시도해 주세요.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="resource-editor" aria-label="송장 엑셀 업로드">
      <h2>송장 엑셀 업로드</h2>
      <p>
        택배사 파일의 값을 양식에 옮겨 주세요. 확정·미발송 주문을 주문 ID로
        연결합니다.
      </p>
      <div className="data-actions">
        <a className="button" href="/api/shipment-import/template" download>
          <Download size={16} /> 송장 등록 양식 받기
        </a>
        <label>
          송장 엑셀 파일
          <input
            type="file"
            accept=".xlsx"
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              void read(file);
            }}
          />
        </label>
      </div>
      <p className="muted small">
        송장번호는 텍스트로 입력하세요. 발송 시각 예시 2026-11-13T14:30:00+09:00
      </p>
      {busy && <p role="status">송장 파일을 처리하고 있어요.</p>}
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
      {preview && (
        <>
          <h3>
            등록 가능 {preview.entries.length}건 · 오류 {preview.errors.length}
            건
          </h3>
          {preview.errors.length > 0 && (
            <ul className="error-copy">
              {preview.errors.map(({ row, message }) => (
                <li key={row}>
                  {row}행 · {message}
                </li>
              ))}
            </ul>
          )}
          {preview.entries.length > 0 && (
            <ol>
              {preview.entries.map(({ row, order_id, command }) => (
                <li key={row}>
                  {row}행 · {order_id} · {command.carrier} ·{' '}
                  {command.tracking_number} ·{' '}
                  {new Date(command.shipped_at).toLocaleString('ko-KR', {
                    timeZone: 'Asia/Seoul',
                  })}{' '}
                  (한국 시간)
                </li>
              ))}
            </ol>
          )}
          <button
            className="button primary"
            disabled={
              busy || !!preview.errors.length || !preview.entries.length
            }
            onClick={() => void apply()}
          >
            확인한 송장 일괄 등록
          </button>
        </>
      )}
    </section>
  );
}
