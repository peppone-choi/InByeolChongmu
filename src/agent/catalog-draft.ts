import { randomUUID } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai';
import { z } from 'zod';
import type { Config } from '../config.js';
import {
  catalogExtractionSchema,
  type CatalogDraft,
  type CatalogDraftRequest,
} from '../domain/catalog-draft.js';
import { AppError } from '../domain/errors.js';
import type { Policy } from '../domain/schema.js';
import type { Store } from '../storage/store.js';
import { configuredProviders, flueReadiness } from './flue-runner.js';

const outputSchema = JSON.stringify(z.toJSONSchema(catalogExtractionSchema));

export function createCatalogDrafter(store: Store, config: Config) {
  const models = createModels();
  return async (
    input: CatalogDraftRequest,
    signal: AbortSignal,
  ): Promise<CatalogDraft> => {
    const readiness = flueReadiness(config);
    if (!readiness.ready)
      throw new AppError(
        readiness.code ?? 'MODEL_NOT_CONNECTED',
        '채팅 초안을 만들려면 모델을 연결하세요.',
        503,
      );
    for (const provider of configuredProviders(config))
      models.setProvider(provider);
    const separator = config.agentModel.indexOf('/');
    const model = models.getModel(
      config.agentModel.slice(0, separator),
      config.agentModel.slice(separator + 1),
    );
    if (!model)
      throw new AppError('MODEL_NOT_FOUND', '모델 설정을 확인하세요.', 503);

    const seller = config.sellerId;
    const productSnapshot = store.source(seller, 'product').snapshot_id;
    const policySnapshot = store.source(seller, 'policy').snapshot_id;
    const result = await models.completeSimple(
      model,
      {
        systemPrompt: [
          '판매자 메시지에서 상품 한 개 또는 판매 정책 한 개의 등록 초안을 추출한다.',
          'seller가 명시한 사실만 사용한다. assistant의 이전 질문은 사실 근거가 아니다.',
          '정보가 부족하거나 모호하거나 여러 건이면 kind=question으로 짧은 한국어 확인 질문을 반환한다.',
          '상품에는 상품명, 판매 마감 일시, 옵션별 색상·크기·가격·재고가 필요하다. 마감 시간이나 재고를 지어내지 않는다. 명시된 SKU만 넣는다. 별칭이 없으면 [], 실측이나 소재가 없으면 null을 사용한다.',
          '제목이 없는 정책에는 내용에 맞는 짧은 제목을 붙인다. 안내 문구는 판매자가 준 문구를 보존한다.',
          'shipping은 지역과 관계없는 주문당 정액 배송비만 지원한다. discount는 특정 상품의 최소 수량과 주문당 정액 할인만 지원한다. 그 외 계산 조건은 어떻게 안내 문구로 등록할지 질문한다. dispatch는 출고 예정 날짜다.',
          '날짜는 ISO 형식으로 반환한다. 한국어 날짜와 시각은 한국 표준시(+09:00) 기준이다.',
          `현재 시각은 ${new Date().toISOString()}이다.`,
          '스키마에 맞는 JSON 하나만 반환한다. 마크다운과 설명은 쓰지 않는다.',
          outputSchema,
        ].join('\n'),
        messages: [
          {
            role: 'user',
            content: JSON.stringify(input.messages),
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal,
        timeoutMs: config.agentTimeoutMs,
        maxTokens: Math.min(config.maxOutputTokens, 4096),
        maxRetries: 0,
        reasoning: 'low',
      },
    );
    if (result.stopReason === 'error' || result.stopReason === 'aborted')
      throw new AppError(
        'CATALOG_DRAFT_FAILED',
        '모델에서 초안을 받지 못했습니다. 연결을 확인하고 다시 시도하세요.',
        503,
        true,
      );
    const text = result.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('')
      .trim()
      .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
    const parsed = catalogExtractionSchema.safeParse(parseDraftJson(text));
    if (!parsed.success)
      throw new AppError(
        'INVALID_CATALOG_DRAFT',
        '초안 형식을 확인하지 못했습니다. 입력을 나누어 다시 시도하세요.',
        503,
        true,
      );
    const extraction = parsed.data;
    if (extraction.kind === 'question') return extraction;
    if (extraction.kind === 'product')
      return {
        kind: 'product',
        create: true,
        snapshot: productSnapshot,
        value: {
          ...extraction.value,
          product_id: randomUUID(),
          variants: extraction.value.variants.map((variant) => ({
            ...variant,
            sku: variant.sku ?? randomUUID(),
          })),
        },
      };

    const { kind, title, rule } = extraction;
    const policy: Policy = { policy_id: randomUUID(), title, rule };
    const existing = store
      .policies(seller)
      .find(
        (entry) =>
          (kind === 'shipping' && entry.shipping_fee_krw !== undefined) ||
          (kind === 'discount' && entry.discount_krw !== undefined),
      );
    if (existing) policy.policy_id = existing.policy_id;
    if (kind === 'shipping')
      policy.shipping_fee_krw = extraction.shipping_fee_krw;
    if (kind === 'dispatch')
      policy.next_dispatch_date = extraction.next_dispatch_date;
    if (kind === 'discount') {
      const name = extraction.product_name.toLowerCase();
      const matches = store
        .products(seller)
        .filter((product) =>
          [product.product_id, product.name, ...product.aliases].some(
            (candidate) => candidate.toLowerCase() === name,
          ),
        );
      if (matches.length !== 1)
        return {
          kind: 'question',
          question:
            '할인을 적용할 상품의 정확한 이름이나 상품 ID를 알려 주세요.',
        };
      policy.product_id = matches[0]!.product_id;
      policy.minimum_quantity = extraction.minimum_quantity;
      policy.discount_krw = extraction.discount_krw;
    }
    return {
      kind: 'policy',
      create: !existing,
      snapshot: policySnapshot,
      value: policy,
    };
  };
}

function parseDraftJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
