import { init, instrument } from '@flue/runtime';
import { start, sqlite, type Flue } from '@flue/runtime/node';
import type { Provider } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Config } from '../config.js';
import { providerEnvironment } from '../config.js';
import { AppError } from '../domain/errors.js';
import type { Store } from '../storage/store.js';
import type { AgentRunner, AgentRun } from './types.js';
import { createRuntimeAgent } from './runtime-agent.js';
import { validateAnalysis } from './validate-analysis.js';

export class FlueRunner implements AgentRunner {
  private runtime: Promise<Flue> | undefined;
  private removeInstrumentation: (() => Promise<void>) | undefined;
  private readonly agent: ReturnType<typeof createRuntimeAgent>;
  private readonly countedTurns = new Set<string>();
  private readonly active = new Map<
    string,
    Promise<ReturnType<typeof validateAnalysis>>
  >();
  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly options: { providers?: Provider[] } = {},
  ) {
    this.agent = createRuntimeAgent(store, config);
  }
  readiness() {
    if (this.config.agentBackend !== 'flue')
      return {
        ready: false,
        code:
          this.config.agentBackend === 'disabled'
            ? 'MODEL_NOT_CONNECTED'
            : 'BACKEND_NOT_IMPLEMENTED',
      };
    if (!this.config.agentModel)
      return { ready: false, code: 'AGENT_MODEL_REQUIRED' };
    if (
      !this.options.providers &&
      (!this.config.agentModel.startsWith('openai/') ||
        !this.config.credentials.openai)
    )
      return {
        ready: false,
        code: this.config.agentModel.startsWith('openai/')
          ? 'OPENAI_API_KEY_REQUIRED'
          : 'PROVIDER_NOT_IMPLEMENTED',
      };
    return { ready: true, code: null };
  }
  private async ensureStarted() {
    if (!this.runtime) {
      if (
        this.config.flueDatabasePath !== ':memory:' &&
        resolve(this.config.flueDatabasePath) ===
          resolve(this.config.databasePath)
      )
        throw new AppError(
          'INVALID_RUNTIME_DATABASE',
          '앱 DB와 Flue DB 경로를 분리하세요.',
          503,
        );
      if (this.config.flueDatabasePath !== ':memory:')
        mkdirSync(dirname(this.config.flueDatabasePath), {
          recursive: true,
          mode: 0o700,
        });
      const candidates: Provider[] = this.options.providers ?? [
        {
          ...openaiProvider(),
          auth: {
            apiKey: {
              name: 'OpenAI environment key',
              resolve: async () => {
                const key = providerEnvironment(this.config).OPENAI_API_KEY;
                return key ? { auth: { apiKey: key } } : undefined;
              },
            },
          },
        },
      ];
      const providers = candidates.map(
        (provider) =>
          ({
            ...provider,
            streamSimple: (model, context, options) =>
              provider.streamSimple(model, context, {
                ...options,
                maxTokens: Math.min(
                  options?.maxTokens ?? this.config.maxOutputTokens,
                  this.config.maxOutputTokens,
                ),
                timeoutMs: this.config.agentTimeoutMs,
                maxRetries: 0,
              }),
          }) satisfies Provider,
      );
      this.removeInstrumentation = instrument({
        observe: () => {},
        dispose: () => {},
        interceptor: async (operation, context, next) => {
          if (operation.type === 'model') {
            if (!context.instanceId)
              throw new AppError(
                'RUN_CONTEXT_MISSING',
                '모델 실행의 방 범위를 확인하지 못했습니다.',
                503,
              );
            const turnKey = context.instanceId + ':' + operation.turnId;
            if (!this.countedTurns.has(turnKey)) {
              this.store.countModelCall(
                context.instanceId,
                this.config.maxModelCalls,
              );
              this.countedTurns.add(turnKey);
            }
          }
          return next();
        },
      });
      this.runtime = start({
        agents: [this.agent],
        db: sqlite(this.config.flueDatabasePath),
        env: {},
        providers,
      })
        .then((runtime) => {
          if (this.config.flueDatabasePath !== ':memory:')
            chmodSync(this.config.flueDatabasePath, 0o600);
          return runtime;
        })
        .catch(async (error) => {
          await this.removeInstrumentation?.();
          this.removeInstrumentation = undefined;
          this.runtime = undefined;
          throw error;
        });
    }
    await this.runtime;
  }
  run(run: AgentRun) {
    const existing = this.active.get(run.id);
    if (existing) return existing;
    const promise = this.execute(run).finally(() => {
      this.active.delete(run.id);
      for (const key of this.countedTurns)
        if (key.startsWith(run.id + ':')) this.countedTurns.delete(key);
    });
    this.active.set(run.id, promise);
    return promise;
  }
  private async execute(run: AgentRun) {
    const ready = this.readiness();
    if (!ready.ready)
      throw new AppError(
        ready.code ?? 'MODEL_NOT_CONNECTED',
        '모델 설정을 확인하세요.',
        503,
      );
    const deadline = run.input.expires_at
      ? Date.parse(run.input.expires_at)
      : Date.parse(run.input.reference_time) + this.config.agentTimeoutMs;
    const checkDeadline = () => {
      if (!(deadline > Date.now()))
        throw new AppError(
          'AGENT_TIMEOUT',
          '분석 제한 시간을 초과했습니다.',
          504,
        );
    };
    checkDeadline();
    await this.ensureStarted();
    checkDeadline();
    const handle = init(this.agent, { id: run.id });
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new AppError('AGENT_TIMEOUT', '분석 제한 시간을 초과했습니다.', 504),
        ),
      deadline - Date.now(),
    );
    try {
      const receipt = await handle.dispatch({
        message: JSON.stringify(run.input),
        idempotencyKey: run.request_id,
      });
      await handle.read(receipt, { signal: controller.signal });
      const proposed = this.store.runById(run.id).proposed;
      if (!proposed)
        throw new AppError(
          'OUTPUT_MISMATCH',
          '에이전트가 검증된 분석 결과를 제출하지 않았습니다.',
          503,
        );
      return validateAnalysis(this.store, run, proposed);
    } catch (error) {
      if (controller.signal.aborted) {
        await handle.abort().catch(() => {});
        throw new AppError(
          'AGENT_TIMEOUT',
          '분석 제한 시간을 초과했습니다.',
          504,
        );
      }
      if (error instanceof AppError) throw error;
      throw new AppError(
        'AGENT_EXECUTION_FAILED',
        '모델 실행이 실패했습니다. 인증·모델 접근·도구 결과를 확인하세요.',
        503,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  async stop() {
    await Promise.allSettled([...this.active.values()]);
    const runtime = this.runtime;
    this.runtime = undefined;
    if (runtime) await (await runtime).stop();
    await this.removeInstrumentation?.();
    this.removeInstrumentation = undefined;
  }
}
