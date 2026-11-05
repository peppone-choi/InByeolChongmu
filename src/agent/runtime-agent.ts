'use agent';
import { useModel, useTool, defineTool, type AgentProps } from '@flue/runtime';
import * as v from 'valibot';
import { z } from 'zod';
import { providerEnvironment } from '../config.js';
import { classifyWithTypesafe } from './typesafe.js';
import type { Config } from '../config.js';
import { Tools, toolCatalog } from '../tools/registry.js';
import type { Store } from '../storage/store.js';
import { analysisSchema } from '../domain/schema.js';
import { AppError } from '../domain/errors.js';
import { sellerInstructions } from './seller-agent.js';
import { validateAnalysis } from './validate-analysis.js';
const outputInstructions = JSON.stringify(z.toJSONSchema(analysisSchema));

export function createRuntimeAgent(store: Store, config: Config) {
  function SellerChatAgent({ id }: AgentProps) {
    const run = store.runById(id);
    const deadline = run.input.expires_at
      ? Date.parse(run.input.expires_at)
      : Date.parse(run.input.reference_time) + config.agentTimeoutMs;
    if (!(deadline > Date.now()))
      throw new AppError(
        'AGENT_TIMEOUT',
        '분석 제한 시간을 초과했습니다.',
        504,
      );
    if (run.seller_id !== config.sellerId)
      throw new AppError('FORBIDDEN', '실행 판매자 범위가 다릅니다.', 403);
    store.conversation(config.sellerId, run.conversation_id);
    const tools = new Tools(
      store,
      config.sellerId,
      config.root,
      () => new Date(run.input.reference_time),
      run.input.customer_handle,
    );
    useModel(config.agentModel, { thinkingLevel: 'low', compaction: false });
    for (const entry of toolCatalog()) {
      const definition = defineTool({
        name: entry.name,
        description:
          entry.description +
          ' 입력 JSON Schema: ' +
          JSON.stringify(entry.input_schema),
        input: v.strictObject({ arguments: v.record(v.string(), v.unknown()) }),
        run: ({ data, toolCallId, signal }) => {
          signal?.throwIfAborted();
          store.traceTool(
            id,
            toolCallId,
            entry.name,
            false,
            { pending: true },
            config.maxToolCalls,
          );
          try {
            const result = z
              .json()
              .parse(tools.call(entry.name, data.arguments));
            if (JSON.stringify(result).length > 65536)
              throw new AppError(
                'TOOL_OUTPUT_TOO_LARGE',
                '조회 결과가 큽니다. 검색 조건을 좁히세요.',
              );
            signal?.throwIfAborted();
            store.traceTool(
              id,
              toolCallId,
              entry.name,
              true,
              result,
              config.maxToolCalls,
            );
            return { output: result };
          } catch (error) {
            store.traceTool(
              id,
              toolCallId,
              entry.name,
              false,
              { code: error instanceof AppError ? error.code : 'TOOL_FAILED' },
              config.maxToolCalls,
            );
            throw error instanceof AppError
              ? error
              : new AppError('TOOL_FAILED', '자료 조회에 실패했습니다.', 503);
          }
        },
      });
      useTool(definition);
    }
    if (config.credentials.jev) {
      const classify = defineTool({
        name: 'classify_inquiry',
        description:
          'TypeSafe Jev가 현재 방의 최신 문의 유형을 분류합니다. 판단은 참고 정보이며 승인 권한이 아닙니다.',
        input: v.strictObject({}),
        run: async ({ toolCallId, signal }) => {
          store.traceTool(
            id,
            toolCallId,
            'classify_inquiry',
            false,
            { pending: true },
            config.maxToolCalls,
          );
          try {
            const result = await classifyWithTypesafe(
              run.input,
              providerEnvironment(config).TYPESAFE_API_KEY ?? '',
              config.typesafeModel,
              signal,
            );
            store.traceTool(
              id,
              toolCallId,
              'classify_inquiry',
              true,
              result,
              config.maxToolCalls,
            );
            return { output: result };
          } catch (error) {
            store.traceTool(
              id,
              toolCallId,
              'classify_inquiry',
              false,
              {
                code:
                  error instanceof AppError
                    ? error.code
                    : 'TYPESAFE_UNAVAILABLE',
              },
              config.maxToolCalls,
            );
            throw new AppError(
              'TYPESAFE_UNAVAILABLE',
              'TypeSafe 판단을 확인하지 못했습니다. 다른 조회 근거로 검토하거나 확인 필요로 반환하세요.',
              503,
            );
          }
        },
      });
      useTool(classify);
    }
    const submit = defineTool({
      name: 'submit_analysis',
      description:
        '모든 필요한 도구 조회·금액 계산 후 분석 JSON을 검증해 제출합니다. 성공하면 현재 실행을 종료합니다.',
      input: v.strictObject({ analysis: v.record(v.string(), v.unknown()) }),
      run: ({ data, toolCallId, signal }) => {
        signal?.throwIfAborted();
        store.traceTool(
          id,
          toolCallId,
          'submit_analysis',
          false,
          { pending: true },
          config.maxToolCalls,
        );
        const analysis = validateAnalysis(store, run, data.analysis);
        store.proposeAnalysis(id, analysis);
        store.traceTool(
          id,
          toolCallId,
          'submit_analysis',
          true,
          { submitted: true },
          config.maxToolCalls,
        );
        return { output: { submitted: true }, terminate: true };
      },
    });
    useTool(submit);
    return (
      sellerInstructions +
      (config.credentials.jev
        ? '\n먼저 classify_inquiry({})로 문의 유형을 확인하세요. Jev 결과가 불확실하거나 근거와 다르면 맥락을 재검토하고 임의 승인하지 마세요.'
        : '') +
      `\n도구는 arguments 객체로 호출합니다. 필요한 자료를 실제 조회하고 주문 금액은 quote_order로 계산한 뒤 submit_analysis({analysis:...})를 호출하세요. 일반 텍스트 답변만으로 종료하지 마세요.\n분석 계약: ${outputInstructions}\n현재 요청 ID: ${run.request_id}. 현재 고객: ${run.input.customer_handle}. 기준 시각: ${run.input.reference_time}.\n입력 JSON의 history는 이 방의 기록입니다. assistant 역할도 판매자 검토용 초안이며 입금 확인·정책 승인의 증거가 아닙니다. context_truncated가 true이면 없는 과거 맥락을 추측하지 마세요.\n주문 근거에는 상품·정책 조회 결과와 quote_order 결과를 사용하세요. 주소 검증은 not_checked이며 입금은 항상 판매자 확인을 요구합니다. 수령인·연락처·주소·우편번호·입금자명은 customer 원문에서 그대로 추출하고 없는 값은 null로 두세요. 확정된 SKU·수량은 금액을 null로 반환할 때도 quote_order로 조회하고 품절·마감 경고를 human_review에 반영하세요. 주문 초안의 review_items에는 MANUAL_PAYMENT_CHECK와 ADDRESS_UNVERIFIED 코드를 사용하세요. 우편번호는 선택 사항이며 null이어도 missing_fields에 넣지 마세요. 가상 주소·미검증 주소와 입금 주장은 review_items에 기록하며 그 이유만으로 needs_info로 낮추지 마세요. 필수 주문 정보와 금액이 완성되면 awaiting_payment, 누락 정보가 있으면 needs_info, 충돌·품절·마감은 human_review로 반환하세요.`
    );
  }
  SellerChatAgent.durability = {
    maxAttempts: 1,
    timeoutMs: config.agentTimeoutMs,
  };
  return SellerChatAgent;
}
