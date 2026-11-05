import { Check, LoaderCircle, TriangleAlert, Wrench } from 'lucide-react';
import type { ExecutionView } from '../../src/domain/http-contract';
const labels: Record<string, string> = {
  classify_inquiry: 'DM 분류',
  search_products: '상품 조회',
  get_policies: '판매 정책 조회',
  search_orders: '고객 주문 조회',
  get_sales_calendar: '판매 일정 조회',
  read_document: '문서 읽기',
  quote_order: '주문 금액 검증',
  submit_analysis: '분석 결과 제출',
};
export function ToolProgress({
  execution,
  running,
}: {
  execution: ExecutionView | null;
  running: boolean;
}) {
  if (!execution && !running) return null;
  return (
    <details
      className="tool-progress"
      aria-label="에이전트 도구 호출"
      open={running}
    >
      <summary>
        <Wrench size={15} />
        <strong>
          에이전트 도구 ·{' '}
          {running
            ? '실행 중'
            : `${execution?.tool_calls.length ?? 0}회 실행 기록`}
        </strong>
      </summary>
      {execution?.tool_calls.length ? (
        <ul>
          {execution.tool_calls.map((call) => (
            <li key={call.id}>
              {call.status === 'running' ? (
                <LoaderCircle className="spinner" size={14} />
              ) : call.status === 'succeeded' ? (
                <Check size={14} />
              ) : (
                <TriangleAlert size={14} />
              )}
              <span>{labels[call.name] ?? call.name}</span>
              <small>
                {call.status === 'running'
                  ? '실행 중'
                  : call.status === 'succeeded'
                    ? '완료'
                    : '실패'}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p>대화 맥락을 읽고 필요한 도구를 선택하고 있어요.</p>
      )}
    </details>
  );
}
