import { AppError } from '../domain/errors.js';
import type { Batches } from '../storage/batches.js';
import type { ChatService } from './service.js';

export class BatchService {
  private active = false;
  constructor(
    private readonly batches: Batches,
    private readonly chat: ChatService,
    private readonly seller: string,
  ) {}

  get busy() {
    return this.active;
  }

  async process(
    batchId: string,
    itemId: string,
    requestId: string,
    retry: boolean,
  ) {
    if (this.active)
      throw new AppError(
        'BATCH_BUSY',
        '다른 접수 건을 분석 중입니다. 잠시 뒤 결과를 확인하세요.',
        409,
        true,
      );
    const item = this.batches.claim(
      this.seller,
      batchId,
      itemId,
      requestId,
      retry,
    );
    if (!item) return this.batches.get(this.seller, batchId);
    this.active = true;
    try {
      const { httpStatus, body } = await this.chat.receive({
        schema_version: '0.1',
        request_id: item.request_id,
        ...(item.conversation_id
          ? { conversation_id: item.conversation_id }
          : {}),
        customer_handle: item.customer_handle,
        text: item.text,
      });
      const { analysis } = body;
      const reason = analysis.review_items[0];
      const error =
        httpStatus >= 400
          ? {
              code: reason?.code ?? 'ANALYSIS_FAILED',
              message: reason?.message ?? '분석에 실패했습니다.',
              retryable: httpStatus >= 500,
            }
          : null;
      this.batches.finish(batchId, itemId, item.request_id, {
        classification: analysis.classification,
        analysis_status: analysis.status,
        needs_attention:
          !!error ||
          analysis.review_items.length > 0 ||
          ['human_review', 'needs_info', 'awaiting_payment'].includes(
            analysis.status,
          ),
        error,
      });
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        error.status >= 500 ||
        error.status === 409
      )
        throw error;
      this.batches.finish(batchId, itemId, item.request_id, {
        classification: null,
        analysis_status: null,
        needs_attention: true,
        error: { code: error.code, message: error.message, retryable: false },
      });
    } finally {
      this.active = false;
    }
    return this.batches.get(this.seller, batchId);
  }
}
