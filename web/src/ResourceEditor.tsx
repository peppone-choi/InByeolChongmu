import { useState, useEffect, useRef, type FormEvent } from 'react';
import {
  BookOpen,
  Package,
  Pencil,
  Save,
  X,
  LoaderCircle,
  RefreshCw,
  Plus,
  Trash2,
} from 'lucide-react';
import type { Resources } from '../../src/domain/http-contract';
import {
  productSchema,
  policySchema,
  type Product,
  type Policy,
} from '../../src/domain/schema';
import { api, ApiError } from './api';
import { money, policyNames } from './data';
type Editing =
  | { kind: 'product'; value: Product; snapshot: string; create?: boolean }
  | { kind: 'policy'; value: Policy; snapshot: string; create?: boolean };
const localTime = (value: string) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
export function ResourceEditor({
  resources,
  onSaved,
}: {
  resources: Resources | null;
  onSaved: (resources: Resources) => void;
}) {
  const [editing, setEditing] = useState<Editing | null>(null),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [saving, setSaving] = useState(false),
    [conflict, setConflict] = useState(false),
    [generation, setGeneration] = useState(0),
    [policyKind, setPolicyKind] = useState('text'),
    [removing, setRemoving] = useState<{
      kind: 'products' | 'policies';
      id: string;
      name: string;
    } | null>(null);
  const editorRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const editor = editorRef.current;
    if (editor) {
      editor.scrollIntoView({ block: 'start' });
      editor
        .querySelector<HTMLElement>('input,textarea,select')
        ?.focus({ preventScroll: true });
    }
  }, [generation]);
  const open = (kind: 'product' | 'policy', id: string, source = resources) => {
    if (!source) return;
    setError('');
    setSuccess('');
    setConflict(false);
    if (kind === 'product') {
      const value = source.products.find((p) => p.product_id === id);
      if (value)
        setEditing({
          kind,
          value: structuredClone(value),
          snapshot: source.snapshots.products,
        });
    } else {
      const value = source.policies.find((p) => p.policy_id === id);
      if (value)
        setEditing({
          kind,
          value: structuredClone(value),
          snapshot: source.snapshots.policies,
        });
    }
    setGeneration((prior) => prior + 1);
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing || saving) return;
    const form = new FormData(event.currentTarget);
    setError('');
    setSuccess('');
    try {
      setSaving(true);
      let updated: Resources;
      if (editing.kind === 'product') {
        const product = structuredClone(editing.value);
        product.name = String(form.get('name') ?? '').trim();
        product.aliases = String(form.get('aliases') ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        product.material = String(form.get('material') ?? '').trim() || null;
        product.closes_at = new Date(
          String(form.get('closes_at')),
        ).toISOString();
        const measurements = Object.fromEntries(
          Object.keys(product.measurements_cm ?? {}).flatMap((key) => {
            const value = String(form.get('measurement:' + key) ?? '');
            return value.trim() ? [[key, Number(value)]] : [];
          }),
        );
        product.measurements_cm = Object.keys(measurements).length
          ? measurements
          : null;
        product.variants = product.variants.map((v, index) => ({
          ...v,
          color: String(form.get('color:' + index) ?? ''),
          size: String(form.get('size:' + index) ?? ''),
          unit_price_krw: Number(form.get('price:' + index)),
          stock_available: Number(form.get('stock:' + index)),
        }));
        updated = await (
          editing.create ? api.createProduct : api.updateProduct
        )(productSchema.parse(product), editing.snapshot);
      } else {
        const policy = structuredClone(editing.value);
        policy.title =
          String(form.get('title') ?? '').trim() ||
          policyNames[policy.policy_id] ||
          policy.policy_id;
        if (policy.shipping_fee_krw !== undefined)
          policy.shipping_fee_krw = Number(form.get('shipping'));
        else if (policy.discount_krw !== undefined) {
          policy.discount_krw = Number(form.get('discount'));
          policy.minimum_quantity = Number(form.get('minimum'));
          policy.product_id = String(form.get('product'));
        } else if (policy.next_dispatch_date)
          policy.next_dispatch_date = String(form.get('dispatch'));
        else policy.rule = String(form.get('rule') ?? '').trim();
        updated = await (editing.create ? api.createPolicy : api.updatePolicy)(
          policySchema.parse(policy),
          editing.snapshot,
        );
      }
      onSaved(updated);
      setEditing(null);
      setSuccess(
        '저장했습니다. 새 분석부터 수정한 자료를 사용합니다. 기존 초안은 자료 버전을 다시 확인해 주세요.',
      );
    } catch (error) {
      setConflict(error instanceof ApiError && error.code === 'STALE_VERSION');
      setError(
        error instanceof ApiError
          ? error.message
          : '입력값을 확인하세요. 금액·재고·수량은 범위에 맞는 정수여야 합니다.',
      );
    } finally {
      setSaving(false);
    }
  };
  const reload = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const latest = await api.resources();
      onSaved(latest);
      open(
        editing.kind,
        editing.kind === 'product'
          ? editing.value.product_id
          : editing.value.policy_id,
        latest,
      );
    } catch {
      setError('최신 자료를 불러오지 못했습니다. 입력은 유지됩니다.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="settings-page">
      <div className="settings-heading">
        <span className="section-label">연결 자료</span>
        <h1>상품·정책</h1>
        <p>
          판매 자료를 수정하면 저장 후 새 분석에 반영됩니다. 초기 자료는 가상
          샘플입니다.
        </p>
      </div>
      <div className="data-actions">
        <button
          className="button primary"
          disabled={!resources || !!editing || saving}
          onClick={() => {
            if (!resources) return;
            setEditing({
              kind: 'product',
              create: true,
              snapshot: resources.snapshots.products,
              value: {
                product_id: crypto.randomUUID(),
                name: '',
                aliases: [],
                material: null,
                measurements_cm: null,
                closes_at: new Date(Date.now() + 30 * 86400000).toISOString(),
                variants: [
                  {
                    sku: crypto.randomUUID(),
                    color: '',
                    size: '',
                    unit_price_krw: 0,
                    stock_available: 0,
                  },
                ],
              },
            });
            setError('');
            setGeneration((n) => n + 1);
          }}
        >
          <Plus size={16} />
          상품 추가
        </button>
        <label>
          새 정책 종류
          <select
            value={policyKind}
            onChange={(e) => setPolicyKind(e.target.value)}
          >
            <option value="text">안내 문구</option>
            <option value="shipping">배송비</option>
            <option value="discount">상품 할인</option>
            <option value="dispatch">출고 예정일</option>
          </select>
        </label>
        <button
          className="button"
          disabled={!resources || !!editing || saving}
          onClick={() => {
            if (!resources) return;
            const extra =
              policyKind === 'shipping'
                ? { shipping_fee_krw: 0 }
                : policyKind === 'discount'
                  ? {
                      product_id: resources.products[0]?.product_id ?? '',
                      minimum_quantity: 2,
                      discount_krw: 0,
                    }
                  : policyKind === 'dispatch'
                    ? {
                        next_dispatch_date: new Date()
                          .toISOString()
                          .slice(0, 10),
                      }
                    : {};
            setEditing({
              kind: 'policy',
              create: true,
              snapshot: resources.snapshots.policies,
              value: {
                policy_id: crypto.randomUUID(),
                title: '',
                rule: '정책 내용을 입력하세요.',
                ...extra,
              },
            });
            setError('');
            setGeneration((n) => n + 1);
          }}
        >
          <Plus size={16} />
          정책 추가
        </button>
      </div>
      {!resources?.products.length && (
        <p className="muted">
          상품이 없습니다. 상품을 추가하거나 설정에서 엑셀을 가져오세요.
        </p>
      )}
      {error && !editing && (
        <p className="error-copy" role="alert">
          {error}
        </p>
      )}
      {removing && (
        <div
          className="inline-confirm"
          role="alertdialog"
          aria-label="자료 삭제 확인"
        >
          <h2>{removing.name} 삭제</h2>
          <p>
            상품을 삭제하면 연결된 할인 정책도 삭제합니다. 과거 주문과 대화는
            유지합니다. 복구할 수 없습니다.
          </p>
          <button
            className="button"
            disabled={saving}
            onClick={() => setRemoving(null)}
          >
            취소
          </button>
          <button
            className="button danger"
            disabled={saving}
            onClick={() => {
              if (!resources) return;
              setSaving(true);
              setError('');
              void api
                .deleteResource(removing.kind, removing.id, resources.snapshots)
                .then((r) => {
                  onSaved(r);
                  setRemoving(null);
                  setSuccess('자료를 삭제했습니다.');
                })
                .catch((e) =>
                  setError(
                    e instanceof Error ? e.message : '삭제에 실패했습니다.',
                  ),
                )
                .finally(() => setSaving(false));
            }}
          >
            삭제 실행
          </button>
        </div>
      )}
      {success && (
        <p className="save-success" role="status">
          {success}
        </p>
      )}
      {editing && (
        <section
          className="resource-editor"
          ref={editorRef}
          aria-label="자료 수정"
        >
          <header>
            <h2>
              {editing.create
                ? editing.kind === 'product'
                  ? '상품 추가'
                  : '정책 추가'
                : editing.kind === 'product'
                  ? `${editing.value.name} 수정`
                  : `${editing.value.title ?? policyNames[editing.value.policy_id] ?? editing.value.policy_id} 수정`}
            </h2>
            <button
              className="icon-button"
              type="button"
              aria-label="수정 취소"
              disabled={saving}
              onClick={() => {
                setEditing(null);
                setError('');
              }}
            >
              <X size={20} />
            </button>
          </header>
          <form onSubmit={(event) => void save(event)} key={generation}>
            <fieldset disabled={saving}>
              {editing.kind === 'product' ? (
                <>
                  <p className="small muted">
                    상품 ID는 고정됩니다. 옵션은 추가·삭제할 수 있습니다. 과거
                    주문은 저장 당시 정보를 유지합니다.
                  </p>
                  <label>
                    상품명
                    <input
                      name="name"
                      defaultValue={editing.value.name}
                      required
                      maxLength={100}
                    />
                  </label>
                  <label>
                    검색 별칭 <span className="optional">한 줄에 하나</span>
                    <textarea
                      name="aliases"
                      defaultValue={editing.value.aliases.join('\n')}
                      rows={2}
                      maxLength={10000}
                    />
                  </label>
                  <label>
                    소재 <span className="optional">모르면 비워두세요</span>
                    <input
                      name="material"
                      defaultValue={editing.value.material ?? ''}
                      maxLength={1000}
                    />
                  </label>
                  <label>
                    판매 마감일
                    <input
                      name="closes_at"
                      type="datetime-local"
                      defaultValue={localTime(editing.value.closes_at)}
                      required
                    />
                  </label>
                  {Object.entries(editing.value.measurements_cm ?? {}).map(
                    ([key, value]) => (
                      <label key={key}>
                        실측{' '}
                        {(
                          {
                            shoulder: '어깨',
                            chest: '가슴',
                            length: '총장',
                          } as Record<string, string>
                        )[key] ?? key}{' '}
                        (cm)
                        <input
                          name={'measurement:' + key}
                          type="number"
                          step="any"
                          min="0.01"
                          max="10000"
                          defaultValue={value}
                        />
                      </label>
                    ),
                  )}
                  <h3>옵션별 가격·재고</h3>
                  {editing.value.variants.map((variant, index) => (
                    <div className="variant-editor" key={variant.sku}>
                      <strong>옵션 {index + 1}</strong>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`옵션 ${index + 1} 삭제`}
                        disabled={editing.value.variants.length === 1}
                        onClick={() => {
                          if (editing.kind === 'product')
                            setEditing({
                              ...editing,
                              value: {
                                ...editing.value,
                                variants: editing.value.variants.filter(
                                  (_, n) => n !== index,
                                ),
                              },
                            });
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                      <label>
                        색상
                        <input
                          name={'color:' + index}
                          defaultValue={variant.color}
                          maxLength={100}
                          required
                        />
                      </label>
                      <label>
                        크기
                        <input
                          name={'size:' + index}
                          defaultValue={variant.size}
                          maxLength={100}
                          required
                        />
                      </label>
                      <label>
                        가격 (원)
                        <input
                          name={'price:' + index}
                          type="number"
                          min="0"
                          max="1000000000"
                          step="1"
                          defaultValue={variant.unit_price_krw}
                          required
                        />
                      </label>
                      <label>
                        재고 (개)
                        <input
                          name={'stock:' + index}
                          type="number"
                          min="0"
                          max="1000000"
                          step="1"
                          defaultValue={variant.stock_available}
                          required
                        />
                      </label>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      if (editing.kind === 'product')
                        setEditing({
                          ...editing,
                          value: {
                            ...editing.value,
                            variants: [
                              ...editing.value.variants,
                              {
                                sku: crypto.randomUUID(),
                                color: '',
                                size: '',
                                unit_price_krw: 0,
                                stock_available: 0,
                              },
                            ],
                          },
                        });
                    }}
                  >
                    <Plus size={16} />
                    옵션 추가
                  </button>
                </>
              ) : (
                <>
                  <label>
                    정책 제목
                    <input
                      name="title"
                      required
                      maxLength={100}
                      defaultValue={
                        editing.value.title ??
                        policyNames[editing.value.policy_id] ??
                        ''
                      }
                    />
                  </label>
                  <p className="small muted">
                    정책 ID: {editing.value.policy_id}. 입금 확인·주문 확정·환불
                    승인은 계속 판매자가 맡습니다.
                  </p>
                  {editing.value.shipping_fee_krw !== undefined ? (
                    <label>
                      배송비 (원)
                      <input
                        name="shipping"
                        type="number"
                        min="0"
                        max="1000000000"
                        step="1"
                        defaultValue={editing.value.shipping_fee_krw}
                        required
                      />
                    </label>
                  ) : editing.value.discount_krw !== undefined ? (
                    <>
                      <label>
                        할인 상품
                        <select
                          name="product"
                          defaultValue={editing.value.product_id}
                          required
                        >
                          {resources?.products.map((product) => (
                            <option
                              key={product.product_id}
                              value={product.product_id}
                            >
                              {product.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        최소 구매 수량
                        <input
                          name="minimum"
                          type="number"
                          min="1"
                          max="10000"
                          step="1"
                          defaultValue={editing.value.minimum_quantity}
                          required
                        />
                      </label>
                      <label>
                        할인액 (원)
                        <input
                          name="discount"
                          type="number"
                          min="0"
                          max="1000000000"
                          step="1"
                          defaultValue={editing.value.discount_krw}
                          required
                        />
                      </label>
                    </>
                  ) : editing.value.next_dispatch_date ? (
                    <label>
                      다음 출고 예정일
                      <input
                        name="dispatch"
                        type="date"
                        defaultValue={editing.value.next_dispatch_date}
                        required
                      />
                    </label>
                  ) : (
                    <label>
                      정책 문구
                      <textarea
                        name="rule"
                        defaultValue={editing.value.rule}
                        rows={5}
                        required
                        maxLength={10000}
                      />
                    </label>
                  )}
                  {(editing.value.shipping_fee_krw !== undefined ||
                    editing.value.discount_krw !== undefined ||
                    editing.value.next_dispatch_date) && (
                    <p className="small muted">
                      계산·일정과 문구가 어긋나지 않도록 정책 문구는 입력한
                      값으로 자동 작성합니다.
                    </p>
                  )}
                </>
              )}
            </fieldset>
            {error && (
              <p className="error-copy" role="alert">
                {error}
              </p>
            )}
            {conflict && (
              <button
                className="button"
                type="button"
                disabled={saving}
                onClick={() => void reload()}
              >
                <RefreshCw size={16} />
                입력 대신 최신 자료로 다시 열기
              </button>
            )}
            <footer>
              <button
                className="button"
                type="button"
                disabled={saving}
                onClick={() => {
                  setEditing(null);
                  setError('');
                }}
              >
                취소
              </button>
              <button
                className="button primary"
                disabled={saving}
                type="submit"
              >
                {saving ? (
                  <LoaderCircle className="spinner" size={16} />
                ) : (
                  <Save size={16} />
                )}{' '}
                {saving ? '저장 중' : '저장'}
              </button>
            </footer>
          </form>
        </section>
      )}
      <div className="resource-top">
        <h2>
          상품표 <span>{resources?.products.length ?? 0}종</span>
        </h2>
        <span className="outline-badge">
          {resources?.snapshots.products ?? '연결 전'}
        </span>
      </div>
      <div className="product-table">
        {resources?.products.map((product) => (
          <article key={product.product_id}>
            <div className="resource-product-name">
              <Package size={20} />
              <div>
                <h3>{product.name}</h3>
                <small>{product.product_id}</small>
              </div>
              <button
                className="button resource-edit-button"
                aria-label={`${product.name} 수정`}
                disabled={!!editing || saving}
                onClick={() => open('product', product.product_id)}
              >
                <Pencil size={14} />
                수정
              </button>
              <button
                className="icon-button danger"
                aria-label={`${product.name} 삭제`}
                disabled={!!editing || saving}
                onClick={() =>
                  setRemoving({
                    kind: 'products',
                    id: product.product_id,
                    name: product.name,
                  })
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className="variant-list">
              {product.variants.map((variant) => (
                <div key={variant.sku}>
                  <span>
                    {variant.color} · {variant.size}
                  </span>
                  <span>{money(variant.unit_price_krw)}</span>
                  <span
                    className={
                      variant.stock_available === 0 ? 'error-copy' : 'muted'
                    }
                  >
                    {variant.stock_available === 0
                      ? '품절'
                      : `재고 ${variant.stock_available}개`}
                  </span>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
      <div className="resource-top policy-heading">
        <h2>판매 정책</h2>
        <span className="outline-badge">
          {resources?.snapshots.policies ?? '연결 전'}
        </span>
      </div>
      <div className="editable-policies">
        {resources?.policies.map((policy) => (
          <article key={policy.policy_id}>
            <header>
              <h3>
                {policy.title ??
                  policyNames[policy.policy_id] ??
                  policy.policy_id}
              </h3>
              <button
                className="button"
                aria-label={`${policy.title ?? policyNames[policy.policy_id] ?? policy.policy_id} 수정`}
                disabled={!!editing || saving}
                onClick={() => open('policy', policy.policy_id)}
              >
                <Pencil size={14} />
                수정
              </button>
              <button
                className="icon-button danger"
                aria-label={`${policy.title ?? policyNames[policy.policy_id] ?? policy.policy_id} 삭제`}
                disabled={!!editing || saving}
                onClick={() =>
                  setRemoving({
                    kind: 'policies',
                    id: policy.policy_id,
                    name:
                      policy.title ??
                      policyNames[policy.policy_id] ??
                      policy.policy_id,
                  })
                }
              >
                <Trash2 size={16} />
              </button>
            </header>
            <p>{policy.rule}</p>
          </article>
        ))}
      </div>
      <p className="resource-note">
        <BookOpen size={16} />이 자료가 에이전트의 조회·계산 기준입니다.
        저장해도 과거 주문 금액과 재고 차감 이력은 바뀌지 않습니다.
      </p>
    </section>
  );
}
