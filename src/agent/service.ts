import { randomUUID } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import { chatSchema, emptyAnalysis, type Analysis } from '../domain/schema.js';
import type { Config } from '../config.js';
import type { Store } from '../storage/store.js';
import type { AgentRunner, AgentRun } from './types.js';
import { FlueRunner } from './flue-runner.js';
import { executionView } from './run-view.js';
export class ChatService {
  readonly runner: AgentRunner;
  constructor(
    private readonly store: Store,
    private readonly config: Config,
    runner?: AgentRunner,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.runner = runner ?? new FlueRunner(store, config);
  }
  private result(
    conversationId: string,
    replayed: boolean,
    analysis: Analysis,
    httpStatus: 200 | 503 | 504,
    run?: AgentRun,
  ) {
    return {
      httpStatus,
      body: {
        conversation_id: conversationId,
        replayed,
        analysis,
        ...(run
          ? {
              execution: executionView(this.store, run),
            }
          : {}),
      },
    };
  }
  async receive(raw: unknown) {
    const parsed = chatSchema.safeParse(raw);
    if (!parsed.success)
      throw new AppError(
        'INVALID_INPUT',
        '고객 아이디·대화·입력 형식을 확인하세요.',
      );
    const input = parsed.data,
      requestId = input.request_id ?? randomUUID();
    const previous = this.store.runForRequest(this.config.sellerId, requestId);
    if (input.conversation_id) {
      const room = this.store.conversation(
        this.config.sellerId,
        input.conversation_id,
      );
      if (room.customer_handle !== input.customer_handle)
        throw new AppError(
          'CUSTOMER_MISMATCH',
          '다른 고객의 대화방에 메시지를 추가할 수 없습니다.',
          403,
        );
      if (
        (!previous || previous.status === 'running') &&
        this.store.roomRunning(
          this.config.sellerId,
          input.conversation_id,
          requestId,
        )
      )
        throw new AppError(
          'ROOM_BUSY',
          '이 방의 이전 분석이 진행 중입니다.',
          409,
          true,
        );
    }
    const received = this.store.receive(this.config.sellerId, {
      requestId,
      handle: input.customer_handle,
      text: input.text,
      attachments: input.attachments,
      ...(input.conversation_id
        ? { conversationId: input.conversation_id }
        : {}),
    });
    const cached = previous;
    if (cached && cached.status !== 'running' && cached.analysis)
      return this.result(
        received.conversation.id,
        true,
        cached.analysis,
        cached.http_status === 200
          ? 200
          : cached.http_status === 504
            ? 504
            : 503,
        cached,
      );
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
      return this.result(
        received.conversation.id,
        received.replayed,
        analysis,
        200,
      );
    }
    const ready = this.runner.readiness();
    if (!ready.ready) {
      analysis.review_items = [
        {
          code: ready.code ?? 'MODEL_NOT_CONNECTED',
          message:
            '메시지는 저장됐습니다. .env.local의 실행기·모델·키 설정을 확인하세요.',
          retryable: false,
        },
      ];
      return this.result(
        received.conversation.id,
        received.replayed,
        analysis,
        503,
      );
    }
    const run =
      cached ??
      this.store.beginRun(
        this.config.sellerId,
        requestId,
        {
          messages: this.config.historyMessages,
          characters: this.config.historyCharacters,
          timeoutMs: this.config.agentTimeoutMs,
        },
        this.clock(),
      );
    try {
      const validated = await this.runner.run(run);
      const finished = this.store.finishRun(run.id, validated, 200);
      return this.result(
        received.conversation.id,
        received.replayed,
        finished.analysis!,
        200,
        finished,
      );
    } catch (error) {
      const safe =
        error instanceof AppError
          ? error
          : new AppError(
              'AGENT_EXECUTION_FAILED',
              '모델 실행에 실패했습니다.',
              503,
            );
      const failed = emptyAnalysis(requestId);
      failed.review_items = [
        { code: safe.code, message: safe.message, retryable: false },
      ];
      const status = safe.status === 504 ? 504 : 503;
      const finished = this.store.finishRun(run.id, failed, status);
      return this.result(
        received.conversation.id,
        received.replayed,
        finished.analysis!,
        status,
        finished,
      );
    }
  }
}
