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
import { AnalysisMismatch, validateAnalysis } from './validate-analysis.js';
import { existingPaymentClaim, prepareReview } from './review-analysis.js';
import { customerTexts } from './customer-text.js';
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
      customerTexts(run.input),
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
        try {
          const latestCustomer = customerTexts(run.input, true);
          if (existingPaymentClaim(latestCustomer.join('\n'))) {
            const traced = store.traces(id);
            const scoped = z
              .looseObject({ records: z.array(z.unknown()) })
              .parse(
                traced.find(
                  ({ call_id }) => call_id === 'payment-context:search_orders',
                )?.result ??
                  tools.call('search_orders', {
                    query: run.input.customer_handle,
                  }),
              );
            for (const [name, args] of [
              ['search_orders', { query: run.input.customer_handle }],
              ['get_policies', {}],
            ] as const) {
              const callId = 'payment-context:' + name;
              if (!traced.some((trace) => trace.call_id === callId)) {
                signal?.throwIfAborted();
                store.traceTool(
                  id,
                  callId,
                  name,
                  true,
                  name === 'search_orders' ? scoped : tools.call(name, args),
                  config.maxToolCalls,
                );
              }
            }
            if (
              !scoped.records.length &&
              !traced.some(
                ({ call_id }) =>
                  call_id === 'payment-context:review-candidates',
              )
            ) {
              const candidates = tools.reviewPaymentCandidates(latestCustomer);
              if (candidates.records.length)
                store.traceTool(
                  id,
                  'payment-context:review-candidates',
                  'search_orders',
                  true,
                  candidates,
                  config.maxToolCalls,
                );
            }
          }
          const analysis = validateAnalysis(
            store,
            run,
            prepareReview(store, run, data.analysis),
          );
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
        } catch (error) {
          store.traceTool(
            id,
            toolCallId,
            'submit_analysis',
            false,
            {
              code: error instanceof AppError ? error.code : 'OUTPUT_MISMATCH',
              ...(error instanceof AnalysisMismatch
                ? { check: error.check }
                : {}),
            },
            config.maxToolCalls,
          );
          throw error;
        }
      },
    });
    useTool(submit);
    return (
      sellerInstructions +
      '\n주문 문의에서 현재 고객의 주문을 찾지 못하면 고객 원문에 적힌 이름으로 search_orders를 호출할 수 있습니다. review_only 결과는 판매자 검토 전용입니다. 받은 모든 주문 ID를 order_candidates에 넣고 human_review, reply_draft와 order_draft는 null로 제출하세요. 후보가 여러 건이면 ORDER_AMBIGUOUS, 한 건이면 ORDER_IDENTITY_UNVERIFIED로 표시하세요. 이 후보를 evidence에 넣지 마세요.' +
      (config.credentials.jev
        ? '\nclassify_inquiry({})는 한 번 호출하고 아래 분류 규칙으로 Jev 결과를 재검토하세요. 조회할 자료가 명확하면 같은 턴에 도구를 함께 호출하세요.'
        : '') +
      `\n도구는 arguments 객체로 호출합니다. 필요한 자료를 실제 조회하고 주문 금액은 quote_order로 계산한 뒤 submit_analysis({analysis:...})를 호출하세요. 일반 텍스트 답변만으로 종료하지 마세요.\n분석 계약: ${outputInstructions}\n현재 요청 ID: ${run.request_id}. 현재 고객: ${run.input.customer_handle}. 기준 시각: ${run.input.reference_time}.\n입력 JSON의 history는 이 방의 기록입니다. assistant 역할도 판매자 검토용 초안이며 입금 확인·정책 승인의 증거가 아닙니다. context_truncated가 true이면 없는 과거 맥락을 추측하지 마세요.\n새 주문은 search_products와 get_policies를 함께 조회한 뒤 quote_order로 계산하세요. 고객이 명시적으로 구매를 요청한 문의는 수령 정보가 빠지거나 상품 후보가 여러 개여도 order_request입니다. search_products의 query에는 상품명이나 별칭과 선택 옵션만 쓰고, 수량·주문 문장 전체는 제외하세요. 여러 색이면 상품 이름으로 조회하세요. 기존 주문·입금·취소·교환·주소 변경은 먼저 search_orders에 현재 customer_handle을 정확히 넣어 조회하세요. 조회 가능한 후보 ID만 사용하세요. 정책 ID를 모르거나 검색 결과가 비면 get_policies({arguments:{}})로 확인하세요. 동일 조회를 반복하지 마세요.
새 주문과 함께 입금했다고 하면 order_request입니다. 기존 주문의 입금 주장은 payment_claim이며 조회한 입금 대기 주문과 get_policies의 입금 확인 정책을 근거로 쓰고 새 order_draft는 비웁니다. 다른 계정에서 입금했다고 해도 입금 문의입니다. 입금 여부나 방법을 묻기만 하면 payment_claim이나 customer_claimed_paid=true로 분류하지 마세요. 고객 원문의 이름을 검색할 때 조사나 호칭을 빼고 실제 이름만 검색하세요. 금액 차이는 PAYMENT_MISMATCH로 표시합니다. 확정 주문의 배송지 변경은 order_lookup, 취소·교환·환불·파손은 claim입니다. 기존 주문 변경과 마감·정책 밖 할인 요청은 SELLER_DECISION_REQUIRED입니다. 가격 흥정·구매 고민은 product_inquiry이며 마감 상품을 명시 수량으로 구매 요청하면 order_request입니다.
상품을 특정할 수 없으면 product_inquiry, PRODUCT_UNRESOLVED, needs_info로 제출하세요. 주문 조회가 비면 order_lookup, ORDER_NOT_FOUND, needs_info로 제출하세요. 사실 근거 없는 확인 질문은 서버가 작성하므로 reply_draft=null로 제출할 수 있습니다. 자료에 없는 소재·비침·착용감은 SOURCE_MISSING, human_review입니다. 품절은 OUT_OF_STOCK입니다. claim은 high 및 human_review, SELLER_DECISION_REQUIRED입니다. 기존 주문 변경에서는 order_draft=null입니다.
 product_candidates는 P001 같은 조회한 product_id, order_candidates는 조회한 order_id만 넣고 상품명·도구명을 넣지 마세요. evidence.source_id도 조회 결과의 product_id·policy_id·order_id만 사용하세요. quote_order는 계산 도구이며 자료 ID가 아니므로 evidence.source_id로 사용하지 마세요. 견적 정책 근거는 get_policies 결과의 POL-SHIPPING·POL-DISCOUNT 등 실제 policy_id를 사용하세요. 주소 검증은 not_checked이며 입금 확인 요구는 판매자용 review_items에 반드시 남기세요. 고객용 reply_draft는 sellerInstructions의 짧은 블록 형식을 따르고 내부 검토 메모를 섞지 마세요. 수령인·연락처·주소·우편번호·입금자명은 고객 원문에서 추출하고 없는 값은 null입니다. 최신 전화번호와 주소 정정을 따르세요. 고객이 이전 동·호·층 대신 새 값을 명시하면 원래 주소에서 해당 토큰만 바꾸세요. 잘못된 값은 invalid_fields에 필드 경로를, review_items에 INVALID_PHONE 또는 INVALID_QUANTITY를 넣으세요. 미정 수량은 null입니다. 확정된 SKU·수량은 금액을 null로 반환할 때도 quote_order로 조회하고 품절·마감 경고를 human_review에 반영하세요. 주문 초안의 review_items에는 MANUAL_PAYMENT_CHECK와 ADDRESS_UNVERIFIED 코드를 사용하세요. 우편번호는 선택 사항이며 null이어도 missing_fields에 넣지 마세요. 가상 주소·미검증 주소와 입금 주장은 review_items에 기록하며 그 이유만으로 needs_info로 낮추지 마세요. 필수 주문 정보와 금액이 완성되면 awaiting_payment, 누락 정보가 있으면 needs_info, 충돌·품절·마감은 human_review로 반환하세요.`
    );
  }
  SellerChatAgent.durability = {
    maxAttempts: 1,
    timeoutMs: config.agentTimeoutMs,
  };
  return SellerChatAgent;
}
