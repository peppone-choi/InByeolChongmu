import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { FlueRunner, flueReadiness } from '../agent/flue-runner.js';
import {
  evaluationDatasetSchema,
  evaluateResponse,
  type EvaluationCase,
} from '../agent/evaluation.js';
import { readConfig } from '../config.js';
import { resultSchema } from '../domain/http-contract.js';
import { createApp } from '../http/app.js';
import { Store } from '../storage/store.js';

const print = (record: unknown) => console.log(JSON.stringify(record));

async function runCase(
  sample: EvaluationCase,
  sellerId: string,
  includeDrafts: boolean,
) {
  const temporary = mkdtempSync(join(tmpdir(), 'inbyeol-eval-'));
  const store = new Store(':memory:');
  let runner: FlueRunner | undefined;
  const started = performance.now();
  try {
    const config = readConfig(process.cwd(), {
      ...process.env,
      NODE_ENV: 'test',
      APP_DEPLOYMENT: 'local',
      LOCAL_API_TOKEN: '',
      SELLER_ID: sellerId,
      DATABASE_PATH: ':memory:',
      FLUE_DATABASE_PATH: join(temporary, 'flue.sqlite'),
    });
    store.seedSamples(config.root, sellerId);
    const state = () => ({
      products: store.products(sellerId),
      policies: store.policies(sellerId),
      orders: store.commerce.list(sellerId),
      snapshots: ['product', 'policy', 'order'].map((type) =>
        store.source(sellerId, type as 'product' | 'policy' | 'order'),
      ),
    });
    const before = state();
    runner = new FlueRunner(store, config);
    const app = createApp(store, config, {
      runner,
      clock: () => new Date(sample.input.reference_time),
    });
    const { schema_version, request_id, customer_handle, text, attachments } =
      sample.input;
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema_version,
        request_id,
        customer_handle,
        text,
        attachments,
      }),
    });
    const body: unknown = await response.json();
    const result = evaluateResponse(
      sample.expected,
      response.status,
      body,
      isDeepStrictEqual(before, state()),
    );
    const parsed = resultSchema.safeParse(body);
    const run = request_id
      ? store.runForRequest(sellerId, request_id)
      : undefined;
    const tools = run
      ? store.traces(run.id).map(({ name, success, result }) => ({
          name,
          success,
          ...(!success
            ? z
                .object({
                  code: z
                    .string()
                    .regex(/^[A-Z_]{1,80}$/)
                    .optional(),
                  check: z
                    .string()
                    .regex(/^[a-z_]{1,80}$/)
                    .optional(),
                })
                .safeParse(result).data
            : {}),
        }))
      : [];
    const analysis = parsed.success ? parsed.data.analysis : undefined;
    return {
      ...result,
      elapsed_ms: Math.round(performance.now() - started),
      reference_time: sample.input.reference_time,
      snapshot_ids: before.snapshots.map((source) => source.snapshot_id),
      tools,
      review_codes: analysis?.review_items.map(({ code }) => code) ?? [],
      missing_fields: analysis?.missing_fields ?? [],
      invalid_fields: analysis?.invalid_fields ?? [],
      ...(includeDrafts && analysis
        ? { reply_draft: analysis.reply_draft }
        : {}),
    };
  } finally {
    try {
      await runner?.stop();
    } finally {
      store.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: 'boolean', default: false },
      case: { type: 'string', multiple: true },
      'include-drafts': { type: 'boolean', default: false },
    },
  });
  const files = [
    'docs/samples/dm-cases.json',
    'docs/samples/products.json',
    'docs/samples/policies.json',
    'docs/samples/orders.json',
    'assets/sample-store/policy-guide.md',
    'src/agent/runtime-agent.ts',
    'src/agent/review-analysis.ts',
    'src/agent/customer-text.ts',
    'src/agent/typesafe.ts',
    'src/agent/flue-runner.ts',
    'src/agent/service.ts',
    'src/agent/seller-agent.ts',
    'src/agent/validate-analysis.ts',
    'src/agent/evaluation.ts',
    'src/cli/evaluate-agent.ts',
    'src/domain/schema.ts',
    'src/tools/registry.ts',
  ];
  const hashes = Object.fromEntries(
    files.map((path) => [
      path,
      createHash('sha256').update(readFileSync(path)).digest('hex'),
    ]),
  );
  const dataset = evaluationDatasetSchema.parse(
    JSON.parse(readFileSync(files[0]!, 'utf8')),
  );
  for (const path of files.slice(1, 4))
    z.object({
      synthetic: z.literal(true),
      seller_id: z.literal(dataset.seller_id),
    }).parse(JSON.parse(readFileSync(path, 'utf8')));
  const selection = new Set(values.case);
  const samples = dataset.cases.filter(
    ({ case_id }) => !selection.size || selection.has(case_id),
  );
  if (selection.size && samples.length !== selection.size) {
    console.error('Unknown case ID. Use DM-001 through DM-040.');
    process.exitCode = 2;
    return;
  }
  const config = values.live ? readConfig() : undefined;
  const ready = config && flueReadiness(config).ready;
  const counts = { passed: 0, manual_review: 0, failed: 0, not_run: 0 };
  print({
    type: 'run',
    started_at: new Date().toISOString(),
    mode: values.live ? 'live' : 'preview',
    cases: samples.length,
    runtime: 'flue',
    model: config?.agentModel || null,
    jev_model: config?.credentials.jev ? config.typesafeModel : null,
    limits: config
      ? {
          timeout_ms: config.agentTimeoutMs,
          model_calls: config.maxModelCalls,
          tool_calls: config.maxToolCalls,
          output_tokens: config.maxOutputTokens,
          history_messages: config.historyMessages,
          history_characters: config.historyCharacters,
        }
      : null,
    file_sha256: hashes,
    billed_cost: null,
  });
  for (const sample of samples) {
    const base = { type: 'case', case_id: sample.case_id };
    if (!ready) {
      counts.not_run++;
      print({
        ...base,
        outcome: 'not_run',
        reason: values.live ? 'MODEL_NOT_CONFIGURED' : 'LIVE_FLAG_REQUIRED',
      });
      continue;
    }
    try {
      const result = await runCase(
        sample,
        dataset.seller_id,
        values['include-drafts'],
      );
      counts[result.outcome]++;
      print({ ...base, ...result });
    } catch {
      counts.failed++;
      print({
        ...base,
        outcome: 'failed',
        error_code: 'EVALUATION_CASE_FAILED',
        model_calls: null,
      });
    }
  }
  print({ type: 'summary', ...counts, billed_cost: null });
  if (counts.failed || (values.live && counts.not_run)) process.exitCode = 1;
}

try {
  await main();
} catch {
  console.error(
    'Evaluation setup failed. Check arguments, sample files and agent configuration.',
  );
  process.exitCode = 2;
}
