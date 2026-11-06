import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  Inbox,
  BookOpen,
  Settings,
  ChevronRight,
  ChevronDown,
  ArrowLeft,
  ClipboardPaste,
  Search,
  Check,
  Copy,
  CheckCheck,
  MessageSquare,
  TriangleAlert,
  X,
  SlidersHorizontal,
  FileText,
  Package,
  Save,
  UserRound,
  ShieldCheck,
  Plus,
  RotateCcw,
  HelpCircle,
  LoaderCircle,
  Unplug,
  PanelRightOpen,
  Layers2,
  LockKeyhole,
} from 'lucide-react';
import {
  conversations,
  policyNames,
  statusLabels,
  money,
  needsAttention,
  type Conversation,
  type Category,
  type Page,
} from './data';
import { workspace } from './workspace';
import { analysisIsStale } from './resource-version';
import { Orders } from './Orders';
import { DataManagement } from './DataManagement';
import { api } from './api';
import { ResourceEditor } from './ResourceEditor';
import { ToolProgress } from './ToolProgress';
import './tokens.css';
import './styles.css';
type Preferences = { largeText: boolean; showEvidence: boolean };
const preferenceKey = 'inbyeol-ui-preferences-v1';
function readPreferences(): Preferences {
  try {
    const saved = JSON.parse(
      localStorage.getItem(preferenceKey) ?? 'null',
    ) as Partial<Preferences> | null;
    return {
      largeText: saved?.largeText === true,
      showEvidence: saved?.showEvidence !== false,
    };
  } catch {
    return { largeText: false, showEvidence: true };
  }
}
function Button({
  children,
  onClick,
  primary = false,
  disabled = false,
  className = '',
  label,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  className?: string;
  label?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      className={`button ${primary ? 'primary' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      {children}
    </button>
  );
}
function Status({ conversation }: { conversation: Conversation }) {
  return (
    <span className={`status status-${conversation.status}`}>
      {conversation.priority ? (
        <TriangleAlert size={16} />
      ) : (
        <span className="status-dot" />
      )}
      {statusLabels[conversation.status]}
    </span>
  );
}
export default function App() {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const items = conversations(state),
    activeId = state.activeId;
  const products = {
    products: state.resources?.products ?? [],
    snapshot_id: state.resources?.snapshots.products ?? '미연결',
  };
  const policies = {
    policies: state.resources?.policies ?? [],
    snapshot_id: state.resources?.snapshots.policies ?? '미연결',
  };
  const [creating, setCreating] = useState(false),
    [followup, setFollowup] = useState<Record<string, string>>({}),
    [loginError, setLoginError] = useState(''),
    [orderSaving, setOrderSaving] = useState(false),
    [orderError, setOrderError] = useState(''),
    [orderId, setOrderId] = useState<string | null>(null);
  useEffect(() => {
    void workspace.start();
  }, [workspace]);
  const [page, setPage] = useState<Page>('inbox'),
    [category, setCategory] = useState<Category>('all'),
    [search, setSearch] = useState(''),
    [mobilePane, setMobilePane] = useState<'list' | 'conversation' | 'details'>(
      'list',
    );
  const [preferences, setPreferences] = useState(readPreferences),
    [preferenceError, setPreferenceError] = useState(false),
    [edited, setEdited] = useState<Record<string, string>>({}),
    [reviewed, setReviewed] = useState<Set<string>>(new Set()),
    [copyState, setCopyState] = useState<
      'idle' | 'loading' | 'success' | 'error' | 'unverified'
    >('idle');
  const [modal, setModal] = useState<'new' | 'about' | null>(null),
    [formError, setFormError] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null),
    returnFocus = useRef<HTMLElement | null>(null),
    draftRef = useRef<HTMLTextAreaElement>(null);
  const active = items.find((item) => item.id === activeId) ?? items[0];
  const editId = active?.requestId ?? '';
  const draft = active ? (edited[editId] ?? active.draft ?? '') : '';
  const pending = active ? state.pending[active.id] : undefined;
  const currentLatest = active ? state.details[active.id]?.latest : null;
  const execution =
    currentLatest &&
    (!pending?.sending || pending.input.request_id === currentLatest.request_id)
      ? currentLatest.execution
      : null;
  const busy = active?.status === 'running';
  const stale = analysisIsStale(currentLatest, state.resources);

  const currentId = useRef(active?.id);
  currentId.current = active?.id;
  const visible = items.filter(
    (item) =>
      (category === 'all' ||
        (category === 'attention'
          ? needsAttention(item)
          : item.status === 'ready_for_review')) &&
      `${item.name} ${item.handle} ${item.subject}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  const attentionCount = items.filter(needsAttention).length;
  useEffect(() => {
    document.title = `${page === 'inbox' ? 'DM 검토' : page === 'resources' ? '상품·정책' : page === 'orders' ? '주문' : '설정'} · 인별총무`;
  }, [page]);
  useEffect(() => {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(preferences));
      setPreferenceError(false);
    } catch {
      setPreferenceError(true);
    }
  }, [preferences]);
  useEffect(() => {
    if (modal) {
      setFormError('');
      returnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
      returnFocus.current?.focus();
    }
  }, [modal]);
  useEffect(() => {
    setCopyState('idle');
  }, [activeId]);
  const selectItem = (id: string) => {
    void workspace.select(id);
    setMobilePane('conversation');
  };
  const navigate = (next: Page) => {
    setPage(next);
    setModal(null);
  };
  const copy = async () => {
    if (!active || !draft.trim() || stale) return;
    const id = active.id;
    setCopyState('loading');
    try {
      const resources = await workspace.refreshResources();
      if (currentId.current !== id || draftRef.current?.value !== draft) return;
      if (analysisIsStale(currentLatest, resources)) {
        setCopyState('idle');
        return;
      }
    } catch {
      if (currentId.current === id) setCopyState('unverified');
      return;
    }
    try {
      await navigator.clipboard.writeText(draft);
      if (currentId.current === id && draftRef.current?.value === draft)
        setCopyState('success');
    } catch {
      if (currentId.current === id && draftRef.current?.value === draft) {
        setCopyState('error');
        draftRef.current?.focus();
        draftRef.current?.select();
      }
    }
  };
  const toggleReview = () => {
    if (!active) return;
    setReviewed((prior) => {
      const next = new Set(prior);
      if (next.has(editId)) next.delete(editId);
      else next.add(editId);
      return next;
    });
  };
  const addDM = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creating) return;
    const form = new FormData(event.currentTarget),
      handle = String(form.get('handle') ?? '').trim(),
      text = String(form.get('text') ?? '').trim(),
      subject = String(form.get('subject') ?? '').trim();
    if (!handle.replace(/^@/, '').trim() || !text) {
      setFormError('고객 아이디와 DM 원문을 입력해 주세요.');
      return;
    }
    setCreating(true);
    try {
      const id = await workspace.add(
        handle.startsWith('@') ? handle : '@' + handle,
        subject,
        text,
      );
      setCategory('all');
      setSearch('');
      setModal(null);
      selectItem(id);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : 'DM을 추가하지 못했어요.',
      );
    } finally {
      setCreating(false);
    }
  };
  if (!state.authenticated && !state.loading)
    return (
      <main className="login-page">
        <section className="setting-section">
          <h1>인별총무 연결</h1>
          <p>
            서버의 LOCAL_API_TOKEN을 입력해 작업 공간을 여세요. 모델 키는 서버
            env에서 관리합니다.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const token = String(new FormData(form).get('token') ?? '');
              form.reset();
              setLoginError('');
              void workspace
                .login(token)
                .catch((error) =>
                  setLoginError(
                    error instanceof Error
                      ? error.message
                      : '연결하지 못했어요.',
                  ),
                );
            }}
          >
            <label>
              연결 암호
              <input name="token" type="password" required autoComplete="off" />
            </label>
            <Button primary type="submit">
              연결
            </Button>
          </form>
          {(loginError || state.error) && (
            <p role="alert">{loginError || state.error}</p>
          )}
          <Button onClick={() => void workspace.start()}>
            연결 상태 다시 확인
          </Button>
        </section>
      </main>
    );
  return (
    <div className={`app ${preferences.largeText ? 'large-text' : ''}`}>
      <a className="skip-link" href="#main">
        본문으로 건너뛰기
      </a>
      <aside className="sidebar" aria-label="주 메뉴">
        <a
          href="#inbox"
          className="brand"
          onClick={(event) => {
            event.preventDefault();
            navigate('inbox');
          }}
        >
          <span className="brand-symbol">
            <Layers2 size={24} />
          </span>
          <span>
            인별총무<span className="brand-sub">INBYEOL</span>
          </span>
        </a>
        <span className="sidebar-label">내 작업 공간</span>
        <nav>
          {(
            [
              { id: 'inbox', label: 'DM 검토', Icon: Inbox },
              { id: 'orders', label: '주문', Icon: Package },
              { id: 'resources', label: '상품·정책', Icon: BookOpen },
              { id: 'settings', label: '설정', Icon: Settings },
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? 'active' : ''}`}
              onClick={() => navigate(id)}
              aria-current={page === id ? 'page' : undefined}
            >
              <Icon size={20} />
              <span>{label}</span>
              {id === 'inbox' && (
                <span className="nav-count">{items.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="quiet-help" onClick={() => setModal('about')}>
            <HelpCircle size={20} />
            사용 안내
          </button>
          <button className="store-switch" onClick={() => navigate('settings')}>
            <span className="store-avatar">샘</span>
            <span>
              <strong>샘플 상점</strong>
              <small>가상 자료 작업 공간</small>
            </span>
            <ChevronDown size={16} />
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span>내 작업 공간</span>
            <ChevronRight size={16} />
            <strong>
              {page === 'inbox'
                ? 'DM 검토'
                : page === 'resources'
                  ? '상품·정책'
                  : page === 'orders'
                    ? '주문'
                    : '설정'}
            </strong>
          </div>
          <div className="top-actions">
            <button className="preview-badge" onClick={() => setModal('about')}>
              {state.loading
                ? '연결 중'
                : state.error
                  ? '연결 확인 필요'
                  : '채팅 API 연결'}
              <span>SQLite</span>
            </button>
            <span className="top-divider" />
            <span className="top-avatar" aria-label="샘플 상점">
              샘
            </span>
          </div>
        </header>
        <main id="main" className={`main-content page-${page}`}>
          {state.error && (
            <div role="alert" className="connection-error">
              {state.error}
              <Button onClick={() => void workspace.start()}>다시 연결</Button>
            </div>
          )}
          {state.loading && (
            <p role="status">서버의 대화와 자료를 불러오고 있어요.</p>
          )}
          {page === 'inbox' && (
            <>
              <div className="page-heading">
                <div>
                  <h1>DM 검토</h1>
                  <p>대화를 살펴보고, 답장을 준비하세요.</p>
                </div>
                <Button onClick={() => setModal('new')}>
                  <Plus size={20} />
                  DM 추가
                </Button>
              </div>
              <div className={`workbench pane-${mobilePane}`}>
                <section className="conversation-list" aria-label="대화 목록">
                  <div className="list-top">
                    <div className="list-title">
                      <h2>대화</h2>
                      <span>{items.length}건</span>
                      <SlidersHorizontal size={16} aria-hidden="true" />
                    </div>
                    <label className="search-field">
                      <Search size={16} />
                      <span className="sr-only">대화 검색</span>
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="이름, 아이디로 검색"
                      />
                    </label>
                    <div className="filters" aria-label="대화 필터">
                      <button
                        className={category === 'all' ? 'selected' : ''}
                        onClick={() => setCategory('all')}
                        aria-pressed={category === 'all'}
                      >
                        전체 <span>{items.length}</span>
                      </button>
                      <button
                        className={category === 'attention' ? 'selected' : ''}
                        onClick={() => setCategory('attention')}
                        aria-pressed={category === 'attention'}
                      >
                        확인 필요 <span>{attentionCount}</span>
                      </button>
                      <button
                        className={category === 'ready' ? 'selected' : ''}
                        onClick={() => setCategory('ready')}
                        aria-pressed={category === 'ready'}
                      >
                        초안 검토
                      </button>
                    </div>
                  </div>
                  <div className="list-items">
                    {visible.map((item) => (
                      <button
                        key={item.id}
                        className={`conversation-item ${active?.id === item.id ? 'selected' : ''}`}
                        onClick={() => selectItem(item.id)}
                        aria-pressed={active?.id === item.id}
                      >
                        <div className="item-first">
                          <span className="avatar">{item.name.slice(-2)}</span>
                          <span className="item-person">
                            <strong>{item.name}</strong>
                            <small>{item.handle}</small>
                          </span>
                          {reviewed.has(item.requestId) ? (
                            <CheckCheck
                              className="review-check"
                              size={16}
                              aria-label="초안 검토 표시됨"
                            />
                          ) : (
                            <span className="item-case">
                              {item.id.startsWith('DM-')
                                ? item.id.slice(3)
                                : '새 DM'}
                            </span>
                          )}
                        </div>
                        <strong className="item-subject">{item.subject}</strong>
                        <p>
                          {
                            item.messages
                              .filter((m) => m.role === 'customer')
                              .at(-1)?.text
                          }
                        </p>
                        <Status conversation={item} />
                      </button>
                    ))}
                    {!visible.length && items.length > 0 && (
                      <div className="empty-state">
                        <Search size={32} />
                        <h3>찾는 대화가 없어요</h3>
                        <p>검색어나 필터를 바꿔보세요.</p>
                        <Button
                          onClick={() => {
                            setSearch('');
                            setCategory('all');
                          }}
                        >
                          전체 대화 보기
                        </Button>
                      </div>
                    )}
                  </div>
                  <footer className="list-foot">
                    <FileText size={16} />
                    서버에 저장된 대화 · 자동 전송 없음
                  </footer>
                </section>
                {!active && (
                  <section className="conversation-pane">
                    <div className="empty-state">
                      <MessageSquare size={40} />
                      <h2>첫 DM을 추가해 보세요</h2>
                      <p>
                        고객과 상담 맥락별로 방을 만들고 자료에 근거한 답장을
                        준비합니다.
                      </p>
                      <Button primary onClick={() => setModal('new')}>
                        DM 추가
                      </Button>
                    </div>
                  </section>
                )}
                {active && (
                  <>
                    <section
                      className="conversation-pane"
                      aria-label="원문과 답장 초안"
                    >
                      <header className="conversation-header">
                        <button
                          className="icon-button mobile-back"
                          aria-label="대화 목록으로"
                          onClick={() => setMobilePane('list')}
                        >
                          <ArrowLeft size={20} />
                        </button>
                        <span className="avatar">{active.name.slice(-2)}</span>
                        <div className="conversation-person">
                          <h2>{active.name}</h2>
                          <p>
                            {active.handle}
                            <span>·</span>
                            {active.subject}
                          </p>
                        </div>
                        <button
                          className="icon-button detail-button"
                          aria-label="검토 정보 보기"
                          onClick={() => setMobilePane('details')}
                        >
                          <PanelRightOpen size={20} />
                          <span>검토 정보</span>
                        </button>
                      </header>
                      <div className="conversation-scroll">
                        <div className="section-caption">
                          <MessageSquare size={16} />
                          <span>붙여넣은 원문</span>
                          <span className="case-id">
                            {active.loaded
                              ? 'SQLite 저장 이력'
                              : '이력 불러오는 중'}
                          </span>
                        </div>
                        <div className="message-stream">
                          {active.messages.map((message, index) => (
                            <div
                              key={index}
                              className={`message message-${message.role}`}
                            >
                              <span className="message-author">
                                {message.role === 'assistant'
                                  ? '에이전트 · 답장 초안 (전송 전)'
                                  : active.name}
                              </span>
                              <div className="bubble">{message.text}</div>
                            </div>
                          ))}
                        </div>
                        <div
                          className={`review-notice ${active.priority ? 'urgent' : ''}`}
                        >
                          <TriangleAlert size={20} />
                          <div>
                            <strong>
                              {active.status === 'awaiting_payment'
                                ? '입금은 직접 확인해 주세요'
                                : active.status === 'ready_for_review'
                                  ? '복사 전에 내용만 확인해 주세요'
                                  : active.status === 'unanalyzed'
                                    ? '분석 전 DM입니다'
                                    : '판매자 확인이 필요해요'}
                            </strong>
                            <p>{active.note}</p>
                          </div>
                        </div>
                      </div>
                      <section className="draft-section">
                        <div className="draft-heading">
                          <h3>
                            <FileText size={20} />
                            답장 초안
                          </h3>
                          <span className="tiny-label">
                            {active.draft !== null
                              ? '에이전트 생성 · 검토 필요'
                              : '생성된 초안 없음'}
                          </span>
                        </div>
                        {stale && (
                          <div className="review-notice" role="alert">
                            <TriangleAlert size={20} />
                            <div>
                              <strong>상품·정책이 변경됐어요</strong>
                              <p>
                                이 초안은 수정 전 자료로 작성됐습니다. 최신
                                자료로 다시 분석한 뒤 복사해 주세요.
                              </p>
                              <Button
                                disabled={!!busy}
                                onClick={() =>
                                  void workspace.reanalyze(active.id)
                                }
                              >
                                최신 자료로 다시 분석 (모델 재호출)
                              </Button>
                            </div>
                          </div>
                        )}
                        <ToolProgress
                          execution={execution ?? null}
                          running={!!busy}
                        />
                        {pending?.error && (
                          <div className="state-panel error-panel" role="alert">
                            <Unplug size={24} />
                            <strong>처리 상태를 확인해 주세요</strong>
                            <p>{pending.error}</p>
                            <Button
                              onClick={() => void workspace.retry(active.id)}
                              disabled={!!pending?.sending}
                            >
                              <RotateCcw size={16} />
                              {pending.terminal
                                ? '다시 분석 (모델 재호출)'
                                : '같은 요청으로 결과 확인'}
                            </Button>
                          </div>
                        )}
                        {busy ? (
                          <div className="state-panel" role="status">
                            <LoaderCircle size={24} className="spinner" />
                            <strong>에이전트가 분석하고 있어요</strong>
                            <p>
                              대화 맥락과 자료를 조회하고 검증합니다. 다른 방도
                              살펴볼 수 있어요.
                            </p>
                          </div>
                        ) : active.draft !== null ? (
                          <>
                            <label className="sr-only" htmlFor="reply-draft">
                              답장 초안 수정
                            </label>
                            <textarea
                              id="reply-draft"
                              ref={draftRef}
                              className="draft-editor"
                              value={draft}
                              onChange={(e) => {
                                setEdited((prior) => ({
                                  ...prior,
                                  [editId]: e.target.value,
                                }));
                                setCopyState('idle');
                                setReviewed((prior) => {
                                  const next = new Set(prior);
                                  next.delete(editId);
                                  return next;
                                });
                              }}
                            />
                            <div className="draft-meta">
                              <span>
                                {draft.length}자 · 자유롭게 수정하세요
                              </span>
                              {edited[editId] !== undefined && (
                                <button
                                  onClick={() => {
                                    setEdited((prior) => {
                                      const next = { ...prior };
                                      delete next[editId];
                                      return next;
                                    });
                                    setCopyState('idle');
                                    setReviewed((prior) => {
                                      const next = new Set(prior);
                                      next.delete(editId);
                                      return next;
                                    });
                                  }}
                                >
                                  생성된 초안 복원
                                </button>
                              )}
                            </div>
                            <div className="draft-actions">
                              <button
                                className={`review-toggle ${reviewed.has(editId) ? 'checked' : ''}`}
                                aria-pressed={reviewed.has(editId)}
                                onClick={toggleReview}
                              >
                                {reviewed.has(editId) ? (
                                  <CheckCheck size={16} />
                                ) : (
                                  <Check size={16} />
                                )}
                                초안 검토 표시
                              </button>
                              <Button
                                primary
                                onClick={() => void copy()}
                                disabled={
                                  !draft.trim() ||
                                  stale ||
                                  copyState === 'loading'
                                }
                              >
                                {copyState === 'loading' ? (
                                  <LoaderCircle size={16} />
                                ) : copyState === 'success' ? (
                                  <Check size={16} />
                                ) : (
                                  <Copy size={16} />
                                )}{' '}
                                {copyState === 'success'
                                  ? '복사했어요'
                                  : copyState === 'loading'
                                    ? '복사 중'
                                    : '답장 복사'}
                              </Button>
                            </div>
                            <p
                              className={`copy-help ${copyState === 'error' ? 'error-copy' : ''}`}
                              role="status"
                            >
                              {copyState === 'unverified'
                                ? '자료 버전을 확인하지 못했어요. 서버 연결을 확인한 뒤 다시 복사해 주세요.'
                                : copyState === 'error'
                                  ? '클립보드에 접근하지 못했어요. 선택된 내용을 직접 복사해 주세요.'
                                  : '답장은 인스타그램에서 직접 보내주세요.'}
                            </p>
                          </>
                        ) : (
                          <div className="state-panel">
                            <MessageSquare size={32} />
                            <strong>
                              {active.loaded
                                ? '생성된 답장 초안이 없어요'
                                : '대화 이력을 불러오고 있어요'}
                            </strong>
                            <p>{active.note}</p>
                            {active.loaded &&
                              !pending?.error &&
                              ['unanalyzed', 'failed'].includes(
                                active.status,
                              ) && (
                                <Button
                                  onClick={() =>
                                    void workspace.retry(active.id)
                                  }
                                  disabled={!!busy}
                                >
                                  {active.status === 'failed'
                                    ? '다시 분석 (모델 재호출)'
                                    : '저장한 DM 분석하기'}
                                </Button>
                              )}
                          </div>
                        )}
                      </section>
                      <form
                        className="followup-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const text = followup[active.id]?.trim();
                          if (!text || busy || pending?.error) return;
                          setFollowup((prior) => ({
                            ...prior,
                            [active.id]: '',
                          }));
                          void workspace.send(active.id, text);
                        }}
                      >
                        <label htmlFor="followup">이 방에 이어서 받은 DM</label>
                        <textarea
                          id="followup"
                          rows={2}
                          maxLength={20000}
                          value={followup[active.id] ?? ''}
                          onChange={(event) =>
                            setFollowup((prior) => ({
                              ...prior,
                              [active.id]: event.target.value,
                            }))
                          }
                          placeholder="고객의 다음 메시지를 붙여넣으세요."
                          disabled={
                            !active.loaded || !!busy || !!pending?.error
                          }
                        />
                        <Button
                          primary
                          type="submit"
                          disabled={
                            !active.loaded ||
                            !!busy ||
                            !!pending?.error ||
                            !followup[active.id]?.trim()
                          }
                        >
                          <ClipboardPaste size={16} />
                          보내고 분석
                        </Button>
                      </form>
                      <footer className="conversation-footer">
                        <ShieldCheck size={16} />
                        <span>
                          검토 표시는 화면에서만 적용돼요. 주문·재고는 변경되지
                          않습니다.
                        </span>
                      </footer>
                    </section>
                    <aside
                      className="details-pane"
                      aria-label="주문 정보와 근거"
                    >
                      <header className="details-header">
                        <button
                          className="icon-button mobile-back"
                          aria-label="대화로 돌아가기"
                          onClick={() => setMobilePane('conversation')}
                        >
                          <ArrowLeft size={20} />
                        </button>
                        <h2>검토 정보</h2>
                        <span className="outline-badge">{active.kind}</span>
                      </header>
                      <div className="details-scroll">
                        <div className="detail-section">
                          <div className="detail-section-heading">
                            <h3>처리 상태</h3>
                            <Status conversation={active} />
                          </div>
                          <p className="muted small">
                            {active.status === 'awaiting_payment'
                              ? '입금 내역·수령지 확인 후 별도 확정이 필요해요.'
                              : '원문과 에이전트 결과를 함께 확인해 주세요.'}
                          </p>
                        </div>
                        {active.order && active.missing.length > 0 && (
                          <div className="detail-section">
                            <h3>추가로 확인할 내용</h3>
                            <ul className="missing-list">
                              {active.missing.map((field) => (
                                <li key={field}>
                                  <TriangleAlert size={16} />
                                  {field}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {active.analysis &&
                          active.analysis.review_items.length > 0 && (
                            <div className="detail-section">
                              <h3>판매자 확인 사항</h3>
                              <ul className="missing-list">
                                {active.analysis.review_items.map(
                                  (item, index) => (
                                    <li key={index}>
                                      <TriangleAlert size={16} />
                                      {item.message}
                                    </li>
                                  ),
                                )}
                              </ul>
                            </div>
                          )}
                        {active.order ? (
                          <>
                            <div className="detail-section">
                              <h3>
                                <Package size={16} />
                                주문 상품
                              </h3>
                              {active.order.items.map((item, index) => {
                                const product = stale
                                    ? undefined
                                    : products.products.find(
                                        (p) =>
                                          p.product_id === item.product_id ||
                                          p.variants.some(
                                            (v) => v.sku === item.sku,
                                          ),
                                      ),
                                  variant = product?.variants.find(
                                    (v) => v.sku === item.sku,
                                  );
                                return (
                                  <div className="product-summary" key={index}>
                                    <div className="product-monogram">
                                      <Package size={20} />
                                    </div>
                                    <div>
                                      <strong>
                                        {product?.name ??
                                          item.product_id ??
                                          '상품 확인 필요'}
                                      </strong>
                                      <p>
                                        {variant
                                          ? `${variant.color} · ${variant.size}`
                                          : (item.sku ?? '옵션 확인 필요')}
                                      </p>
                                      <span>
                                        {item.quantity ?? '?'}개 ·{' '}
                                        {item.unit_price_krw === null
                                          ? '가격 미확인'
                                          : money(item.unit_price_krw)}
                                      </span>
                                    </div>
                                  </div>
                                );
                              })}
                              {active.order.amounts && (
                                <>
                                  <div className="amount-lines">
                                    <div>
                                      <span>상품 금액</span>
                                      <span>
                                        {money(
                                          active.order.amounts.subtotal_krw,
                                        )}
                                      </span>
                                    </div>
                                    <div>
                                      <span>묶음 할인</span>
                                      <span>
                                        −
                                        {money(
                                          active.order.amounts.discount_krw,
                                        )}
                                      </span>
                                    </div>
                                    <div>
                                      <span>배송비</span>
                                      <span>
                                        {money(
                                          active.order.amounts.shipping_fee_krw,
                                        )}
                                      </span>
                                    </div>
                                  </div>
                                  <div className="total-line">
                                    <span>안내 금액</span>
                                    <strong>
                                      {money(active.order.amounts.total_krw)}
                                    </strong>
                                  </div>
                                </>
                              )}
                              <button
                                className="button primary"
                                disabled={
                                  orderSaving ||
                                  !!busy ||
                                  !currentLatest?.analysis?.order_draft
                                }
                                onClick={() => {
                                  if (!currentLatest) return;
                                  setOrderSaving(true);
                                  setOrderError('');
                                  void api
                                    .saveOrder(currentLatest.request_id)
                                    .then(async (o) => {
                                      setOrderId(o.order_id);
                                      await workspace.refreshResources();
                                      setPage('orders');
                                    })
                                    .catch((e) =>
                                      setOrderError(
                                        e instanceof Error
                                          ? e.message
                                          : '주문 저장에 실패했습니다.',
                                      ),
                                    )
                                    .finally(() => setOrderSaving(false));
                                }}
                              >
                                <Save size={16} />
                                {orderSaving ? '저장 중' : '주문으로 저장'}
                              </button>
                              {orderError && (
                                <p className="error-copy" role="alert">
                                  {orderError}
                                </p>
                              )}
                              <p className="small muted">
                                주문 초안입니다. 입금 확인·주문 확정 전이며
                                재고는 변경되지 않습니다.
                              </p>
                            </div>
                            <div className="detail-section">
                              <h3>
                                <UserRound size={16} />
                                수령 정보
                              </h3>
                              <dl className="recipient">
                                <dt>받는 사람</dt>
                                <dd>
                                  {active.order.recipient.name ?? '미확인'}
                                </dd>
                                <dt>연락처</dt>
                                <dd>
                                  {active.order.recipient.phone_raw ?? '미확인'}
                                </dd>
                                <dt>주소</dt>
                                <dd>
                                  {active.order.recipient.address_raw ??
                                    '미확인'}
                                  <span className="inline-note">
                                    주소 확인:{' '}
                                    {
                                      {
                                        not_checked: '조회 전',
                                        matched: '일치',
                                        no_match: '불일치',
                                        ambiguous: '추가 확인',
                                        failed: '조회 실패',
                                        manually_confirmed: '판매자 확인',
                                      }[active.order.address_verification]
                                    }
                                  </span>
                                </dd>
                                <dt>입금자</dt>
                                <dd>
                                  {active.order.depositor_name ?? '미확인'}
                                </dd>
                              </dl>
                            </div>
                          </>
                        ) : (
                          <div className="detail-section">
                            <h3>
                              {active.missing.length
                                ? '추가로 확인할 내용'
                                : '주문 정보'}
                            </h3>
                            {active.missing.length ? (
                              <ul className="missing-list">
                                {active.missing.map((field) => (
                                  <li key={field}>
                                    <TriangleAlert size={16} />
                                    {field}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="muted small">
                                {active.kind === '상품 문의'
                                  ? '상품 문의 단계예요. 주문 정보는 아직 없어요.'
                                  : '이 대화에는 주문 초안을 표시하지 않았어요.'}
                              </p>
                            )}
                          </div>
                        )}
                        {preferences.showEvidence && (
                          <div className="detail-section evidence-section">
                            <h3>
                              <BookOpen size={16} />
                              답장에 참고한 자료
                            </h3>
                            {active.evidence.length ? (
                              active.evidence.map((evidence) => {
                                const product = stale
                                    ? undefined
                                    : products.products.find(
                                        (p) =>
                                          p.product_id === evidence.source_id,
                                      ),
                                  policy = policies.policies.find(
                                    (p) => p.policy_id === evidence.source_id,
                                  );
                                return (
                                  <details
                                    key={`${evidence.source_type}:${evidence.source_id}`}
                                  >
                                    <summary>
                                      <FileText size={16} />
                                      <span>
                                        {product?.name ??
                                          policyNames[evidence.source_id] ??
                                          evidence.source_id}
                                        <small>
                                          {evidence.snapshot_id} ·{' '}
                                          {evidence.source_id}
                                        </small>
                                      </span>
                                      <ChevronDown size={16} />
                                    </summary>
                                    <p>
                                      {stale
                                        ? '자료가 수정되어 현재 자료를 과거 분석의 근거로 표시하지 않습니다. 최신 자료로 다시 분석해 주세요.'
                                        : (policy?.rule ??
                                          (product
                                            ? `${product.name} · ${product.variants.map((v) => `${v.color}/${v.size} ${money(v.unit_price_krw)} · 재고 ${v.stock_available}개`).join(', ')}`
                                            : '에이전트가 조회한 주문 기록. 현재 방의 분석 결과를 확인하세요.'))}
                                    </p>
                                    <p className="small muted">
                                      참조 필드:{' '}
                                      {evidence.field_paths.join(', ') ||
                                        '전체'}
                                    </p>
                                  </details>
                                );
                              })
                            ) : (
                              <p className="muted small">
                                주문을 식별하거나 분석한 뒤 근거를 표시합니다.
                              </p>
                            )}
                          </div>
                        )}
                        <div className="detail-footnote">
                          <LockKeyhole size={16} />
                          <p>자동 주문 확정이나 고객 전송은 하지 않아요.</p>
                        </div>
                      </div>
                    </aside>
                  </>
                )}
              </div>
            </>
          )}
          {page === 'orders' && (
            <Orders
              initialId={orderId}
              resources={state.resources}
              onResources={(r) => workspace.acceptResources(r)}
            />
          )}
          {page === 'resources' && (
            <ResourceEditor
              resources={state.resources}
              onSaved={(resources) => workspace.acceptResources(resources)}
            />
          )}
          {page === 'settings' && (
            <section className="settings-page">
              <div className="settings-heading">
                <span className="section-label">작업 공간</span>
                <h1>설정</h1>
                <p>화면을 편하게 맞추고, 연결 범위를 확인하세요.</p>
              </div>
              <section className="setting-section">
                <header>
                  <SlidersHorizontal size={20} />
                  <div>
                    <h2>화면 표시</h2>
                    <p>이 브라우저에만 저장됩니다.</p>
                  </div>
                </header>
                <div className="setting-row">
                  <label htmlFor="large-text">
                    <strong>대화 글자 크게 보기</strong>
                    <span>원문과 답장 초안의 글자를 키웁니다.</span>
                  </label>
                  <input
                    id="large-text"
                    type="checkbox"
                    role="switch"
                    checked={preferences.largeText}
                    onChange={(e) =>
                      setPreferences((p) => ({
                        ...p,
                        largeText: e.target.checked,
                      }))
                    }
                  />
                </div>
                <div className="setting-row">
                  <label htmlFor="show-evidence">
                    <strong>자료 근거 표시</strong>
                    <span>검토 정보에서 상품표와 정책 근거를 보여줍니다.</span>
                  </label>
                  <input
                    id="show-evidence"
                    type="checkbox"
                    role="switch"
                    checked={preferences.showEvidence}
                    onChange={(e) =>
                      setPreferences((p) => ({
                        ...p,
                        showEvidence: e.target.checked,
                      }))
                    }
                  />
                </div>
                <p
                  className={`preference-status ${preferenceError ? 'error-copy' : ''}`}
                  role="status"
                >
                  {preferenceError
                    ? '브라우저 저장소를 사용할 수 없어 이번 화면에만 적용됩니다.'
                    : '변경하면 자동으로 저장됩니다.'}
                </p>
              </section>
              <section className="setting-section">
                <header>
                  <Unplug size={20} />
                  <div>
                    <h2>에이전트·자료 연결</h2>
                    <p>
                      서버에서 읽은 실제 연결 설정입니다. 키 설정 여부가 모델의
                      응답 성공을 보장하지는 않습니다.
                    </p>
                  </div>
                </header>
                <div className="connection-row">
                  <span>채팅 API · SQLite</span>
                  <span className="outline-badge">
                    {state.health ? '연결됨' : '확인 필요'}
                  </span>
                  <p>
                    방·고객·상담 맥락별 이력과 분석 결과를 서버에 저장합니다.
                  </p>
                </div>
                <div className="connection-row">
                  <span>에이전트 실행기</span>
                  <span className="outline-badge">
                    {state.health?.agent_backend ?? '미확인'}
                  </span>
                  <p>
                    {state.health?.agent_model || '모델 미설정'} ·{' '}
                    {state.health?.model_configured
                      ? '실행 설정 준비'
                      : '실행 설정 확인 필요'}{' '}
                    · 제한{' '}
                    {Math.round((state.health?.agent_timeout_ms ?? 0) / 1000)}초
                  </p>
                </div>
                <div className="connection-row">
                  <span>TypeSafe / Jev 분류</span>
                  <span className="outline-badge">
                    {state.health?.typesafe_configured
                      ? '키 설정됨'
                      : '키 없음'}
                  </span>
                  <p>
                    OpenAI·TypeSafe 키는 서버 env로 관리하며 브라우저에 전달하지
                    않습니다.
                  </p>
                </div>
                <div className="connection-row">
                  <span>상품·정책</span>
                  <span className="outline-badge">SQLite 자료</span>
                  <p>
                    {products.products.length}종 · 정책{' '}
                    {policies.policies.length}개. 초기 자료는 가상 샘플이며 실제
                    판매 자료로 교체해야 합니다.
                  </p>
                </div>
                <Button onClick={() => void workspace.start()}>
                  연결 상태·자료 새로고침
                </Button>
              </section>
              <DataManagement
                resources={state.resources}
                onSaved={(r) => workspace.acceptResources(r)}
                onChatsReset={async () => {
                  setEdited({});
                  setReviewed(new Set());
                  setFollowup({});
                  setOrderId(null);
                  await workspace.clearChats();
                }}
              />
              <footer className="settings-footer">
                인별총무 · 에이전트 작업 공간
                <span>초안 수정·검토 표시는 이 화면에만 보관됩니다.</span>
              </footer>
            </section>
          )}
        </main>
      </div>
      <dialog
        ref={dialogRef}
        className="dialog"
        onCancel={() => setModal(null)}
        onClose={() => {
          if (modal) setModal(null);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            const rect = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              setModal(null);
          }
        }}
        aria-labelledby="dialog-title"
      >
        <header>
          <h2 id="dialog-title">
            {modal === 'new' ? 'DM 추가' : '이 화면에서 할 수 있는 일'}
          </h2>
          <button
            className="icon-button"
            onClick={() => setModal(null)}
            aria-label="닫기"
          >
            <X size={20} />
          </button>
        </header>
        {modal === 'new' ? (
          <form
            onSubmit={(event) => void addDM(event)}
            onChange={() => {
              if (formError) setFormError('');
            }}
          >
            <p className="muted">
              고객과 상담 맥락별로 새 방을 만들고 에이전트가 분석합니다.
            </p>
            <label>
              고객 아이디
              <input
                name="handle"
                aria-describedby={formError ? 'dm-input-error' : undefined}
                placeholder="@sample.customer"
                required
                maxLength={100}
              />
            </label>
            <label>
              상담 맥락 <span className="optional">선택</span>
              <input
                name="subject"
                placeholder="예: 니트 가디건 주문"
                maxLength={200}
              />
            </label>
            <label>
              DM 원문
              <textarea
                name="text"
                aria-describedby={formError ? 'dm-input-error' : undefined}
                placeholder="고객의 대화를 붙여넣으세요."
                required
                maxLength={20000}
                rows={6}
              />
            </label>
            <p className="small muted">
              원문과 결과는 SQLite에 저장됩니다. 초기 상품·정책은 가상
              자료입니다.
            </p>
            {formError && (
              <p className="error-copy" role="alert" id="dm-input-error">
                {formError}
              </p>
            )}
            <footer>
              <Button onClick={() => setModal(null)}>취소</Button>
              <Button primary type="submit" disabled={creating}>
                <ClipboardPaste size={16} />
                {creating ? '방 만드는 중' : '추가하고 분석'}
              </Button>
            </footer>
          </form>
        ) : (
          <div className="about-content">
            <p>
              DM을 넣으면 에이전트가 방 이력을 읽고 상품·정책·주문·문서·일정을
              조회합니다. 금액은 계산 도구로 검증합니다.
            </p>
            <p>
              원문·생성 결과·도구 호출 상태는 서버 SQLite에 저장됩니다. 답장
              수정과 검토 표시는 이 화면에서만 유지됩니다.
            </p>
            <p className="muted">
              초기 자료는 가상 샘플입니다. 실제 DM 전송, 자동 입금 확인, 재고
              변경은 수행하지 않습니다.
            </p>
            <Button primary onClick={() => setModal(null)}>
              확인
            </Button>
          </div>
        )}
      </dialog>
    </div>
  );
}
