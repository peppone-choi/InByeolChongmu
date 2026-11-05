import { randomUUID } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import { chatSchema, emptyAnalysis } from '../domain/schema.js';
import type { Config } from '../config.js';
import type { Store } from '../storage/store.js';

export class ChatService {
  constructor(
    private readonly store: Store,
    private readonly config: Config,
  ) {}
  async receive(raw: unknown) {
    const parsed = chatSchema.safeParse(raw);
    if (!parsed.success)
      throw new AppError(
        'INVALID_INPUT',
        '고객 아이디·대화·입력 형식을 확인하세요.',
      );
    const input = parsed.data,
      requestId = input.request_id ?? randomUUID();
    const received = this.store.receive(this.config.sellerId, {
      requestId,
      handle: input.customer_handle,
      text: input.text,
      attachments: input.attachments,
      ...(input.conversation_id
        ? { conversationId: input.conversation_id }
        : {}),
    });
    const analysis = emptyAnalysis(requestId);
    if (!input.text.trim() && input.attachments.length) {
      analysis.classification = 'unsupported';
      analysis.status = 'unsupported';
      analysis.review_items = [
        {
          code: 'IMAGE_ONLY_UNSUPPORTED',
          message: '사진만 있는 DM은 지원하지 않습니다.',
        },
      ];
      return {
        httpStatus: 200 as const,
        body: {
          conversation_id: received.conversation.id,
          replayed: received.replayed,
          analysis,
        },
      };
    }
    analysis.review_items = [
      {
        code: 'MODEL_NOT_CONNECTED',
        message:
          '메시지는 저장됐지만 모델 실행기는 아직 연결되지 않았습니다. 실제 모델 연결·검증 후 분석할 수 있습니다.',
        retryable: false,
      },
    ];
    return {
      httpStatus: 503 as const,
      body: {
        conversation_id: received.conversation.id,
        replayed: received.replayed,
        analysis,
      },
    };
  }
}
