import { config as dotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

const environments = new WeakMap<object, Record<string, string>>();
export function providerEnvironment(config: Config) {
  return { ...(environments.get(config) ?? {}) };
}

const configSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  APP_DEPLOYMENT: z.enum(['local', 'container']).default('local'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default('.local/inbyeol.sqlite'),
  SELLER_ID: z.string().min(1).max(100).default('sample-seller-01'),
  LOCAL_API_TOKEN: z.string().default(''),
  AGENT_CONVERSATION_ID: z.string().default(''),
  AGENT_MODEL: z.string().default(''),
  TYPESAFE_MODEL: z.string().min(1).default('jev-latest'),
  FLUE_DATABASE_PATH: z.string().min(1).default('.local/flue.sqlite'),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(300000).default(60000),
  AGENT_MAX_MODEL_CALLS: z.coerce.number().int().min(1).max(32).default(8),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(64).default(16),
  AGENT_MAX_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .min(256)
    .max(16384)
    .default(4096),
  AGENT_HISTORY_MESSAGES: z.coerce.number().int().min(1).max(200).default(40),
  AGENT_HISTORY_CHARACTERS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(100000)
    .default(40000),
  AGENT_BACKEND: z
    .enum(['disabled', 'flue', 'hermes', 'openai-agents'])
    .default('disabled'),
});
export function readConfig(
  root = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
) {
  const fileEnv: NodeJS.ProcessEnv = {};
  dotenv({
    path: [resolve(root, '.env.local'), resolve(root, '.env')],
    processEnv: fileEnv,
    quiet: true,
  });
  const values = { ...fileEnv, ...env };
  const parsed = configSchema.parse(values);
  if (
    (parsed.NODE_ENV === 'production' ||
      parsed.APP_DEPLOYMENT === 'container') &&
    (parsed.APP_DEPLOYMENT !== 'container' ||
      parsed.LOCAL_API_TOKEN.length < 32)
  )
    throw new Error(
      'Container deployment requires APP_DEPLOYMENT=container and LOCAL_API_TOKEN of at least 32 characters.',
    );
  const result = {
    root: resolve(root),
    port: parsed.PORT,
    deployment: parsed.APP_DEPLOYMENT,
    listenHost: parsed.APP_DEPLOYMENT === 'container' ? '0.0.0.0' : '127.0.0.1',
    sellerId: parsed.SELLER_ID,
    databasePath:
      parsed.DATABASE_PATH === ':memory:'
        ? ':memory:'
        : resolve(root, parsed.DATABASE_PATH),
    apiToken: parsed.LOCAL_API_TOKEN,
    agentBackend: parsed.AGENT_BACKEND,
    conversationId: parsed.AGENT_CONVERSATION_ID,
    agentModel: parsed.AGENT_MODEL,
    typesafeModel: parsed.TYPESAFE_MODEL,
    flueDatabasePath:
      parsed.FLUE_DATABASE_PATH === ':memory:'
        ? ':memory:'
        : resolve(root, parsed.FLUE_DATABASE_PATH),
    agentTimeoutMs: parsed.AGENT_TIMEOUT_MS,
    maxModelCalls: parsed.AGENT_MAX_MODEL_CALLS,
    maxToolCalls: parsed.AGENT_MAX_TOOL_CALLS,
    maxOutputTokens: parsed.AGENT_MAX_OUTPUT_TOKENS,
    historyMessages: parsed.AGENT_HISTORY_MESSAGES,
    historyCharacters: parsed.AGENT_HISTORY_CHARACTERS,
    credentials: {
      openai: !!values.OPENAI_API_KEY?.trim(),
      jev: !!values.TYPESAFE_API_KEY?.trim(),
      gateway:
        !!values.CLOUDFLARE_ACCOUNT_ID?.trim() &&
        !!values.CLOUDFLARE_AI_GATEWAY_ID?.trim() &&
        !!(
          values.AI_GATEWAY_API_KEY?.trim() ||
          values.CLOUDFLARE_API_TOKEN?.trim()
        ),
    },
  };
  environments.set(
    result,
    Object.fromEntries(
      ['OPENAI_API_KEY', 'TYPESAFE_API_KEY'].flatMap((name) =>
        values[name] ? [[name, values[name]!]] : [],
      ),
    ),
  );
  return result;
}
export type Config = ReturnType<typeof readConfig>;
