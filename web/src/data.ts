import type { Analysis } from '../../src/domain/schema';
import type { State } from './workspace';
export type Category = 'all' | 'attention' | 'ready';
export type Page = 'inbox' | 'resources' | 'orders' | 'settings';
export type Conversation = {
  id: string;
  name: string;
  handle: string;
  subject: string;
  kind: string;
  status: Analysis['status'] | 'unanalyzed' | 'running';
  priority: boolean;
  messages: Array<{ role: string; text: string }>;
  draft: string | null;
  note: string;
  order: Analysis['order_draft'];
  evidence: Analysis['evidence'];
  missing: string[];
  analysis: Analysis | null;
  loaded: boolean;
  requestId: string;
};
const kinds: Record<string, string> = {
  product_inquiry: '상품 문의',
  order_request: '주문 요청',
  payment_claim: '입금 주장',
  order_lookup: '주문 조회',
  claim: '클레임',
  unrelated: '판매 무관',
  invalid_input: '잘못된 입력',
  unsupported: '지원하지 않는 입력',
};
export function conversations(state: State): Conversation[] {
  return state.rooms.map((room) => {
    const detail = state.details[room.id],
      latest = detail?.latest,
      analysis = latest?.analysis ?? null,
      pending = state.pending[room.id];
    const running = pending?.sending || latest?.status === 'running';
    return {
      id: room.id,
      name: room.customer_handle.replace(/^@/, ''),
      handle: room.customer_handle,
      subject: room.context_label || '새 상담',
      kind: running
        ? '분석 중'
        : (kinds[
            analysis?.classification ?? room.latest?.classification ?? ''
          ] ?? 'DM 분석'),
      status: running
        ? 'running'
        : (analysis?.status ?? room.latest?.analysis_status ?? 'unanalyzed'),
      priority: (analysis?.priority ?? room.latest?.priority) === 'high',
      messages: detail?.messages ?? [
        { role: 'customer', text: room.latest?.preview ?? '' },
      ],
      draft: running ? null : (analysis?.reply_draft ?? null),
      note:
        analysis?.review_items[0]?.message ||
        (running
          ? '방 맥락과 연결 자료를 읽고 있습니다.'
          : '원문과 자료 근거를 확인한 뒤 답장을 보내주세요.'),
      order: running ? null : (analysis?.order_draft ?? null),
      evidence: running ? [] : (analysis?.evidence ?? []),
      missing: analysis
        ? [...analysis.missing_fields, ...analysis.invalid_fields]
        : [],
      analysis: running ? null : analysis,
      loaded: !!detail,
      requestId: latest?.request_id ?? room.id,
    };
  });
}
export const statusLabels: Record<Conversation['status'], string> = {
  awaiting_payment: '입금 확인',
  ready_for_review: '초안 검토',
  needs_info: '정보 보완',
  human_review: '직접 확인',
  unanalyzed: '분석 전',
  running: '분석 중',
  failed: '분석 실패',
  ignored: '판매 무관',
  unsupported: '지원 범위 밖',
  invalid_input: '입력 확인',
};
export const money = (value: number) =>
  new Intl.NumberFormat('ko-KR').format(value) + '원';
export const needsAttention = (item: Conversation) =>
  !['ready_for_review', 'ignored'].includes(item.status);
export const policyNames: Record<string, string> = {
  'POL-SHIPPING': '배송비',
  'POL-DISCOUNT': '묶음 할인',
  'POL-PAYMENT': '입금 확인과 주문 확정',
  'POL-SHIP-DATE': '출고 일정',
  'POL-EXCEPTION': '교환·환불 및 예외 처리',
  'POL-TONE': '답장 말투',
};
