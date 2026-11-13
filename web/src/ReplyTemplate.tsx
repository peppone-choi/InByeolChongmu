import { useEffect, useState, type FormEvent } from 'react';
import { replyTemplateSchema } from '../../src/domain/reply-template';
import { api } from './api';

export function ReplyTemplate({
  onSaved,
}: {
  onSaved: (template: string) => void;
}) {
  const [text, setText] = useState('');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .replyTemplate()
      .then(({ template }) => {
        if (active) {
          setText(template);
          setReady(true);
        }
      })
      .catch(() => {
        if (active)
          setError('템플릿을 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
      });
    return () => {
      active = false;
    };
  }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = replyTemplateSchema.safeParse({ template: text });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '템플릿을 확인해 주세요.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const { template } = await api.saveReplyTemplate(parsed.data.template);
      setText(template);
      onSaved(template);
      setSaved(true);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : '템플릿을 저장하지 못했습니다.',
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="resource-editor" id="reply-template-settings">
      <h2>답장 템플릿</h2>
      <form onSubmit={(event) => void save(event)}>
        <label>
          우리 상점 답장 문구
          <textarea
            rows={5}
            maxLength={4000}
            value={text}
            disabled={!ready || saving}
            placeholder={
              '안녕하세요, 주문해 주셔서 고마워요 😊\n\n{{답장}}\n\n궁금한 점은 편하게 DM 주세요!'
            }
            onChange={(event) => {
              setText(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <p className="muted small">
          초안이 들어갈 자리에 {'{{답장}}'}을 한 번 넣어 주세요. 비운 채
          저장하면 템플릿을 끕니다.
        </p>
        {error && (
          <p className="error-copy" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="save-success" role="status">
            템플릿을 저장했습니다.
          </p>
        )}
        <footer>
          <button className="button primary" disabled={!ready || saving}>
            템플릿 저장
          </button>
        </footer>
      </form>
    </section>
  );
}
