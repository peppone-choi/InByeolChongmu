import { config as dotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default('.local/inbyeol.sqlite'),
  SELLER_ID: z.string().min(1).max(100).default('sample-seller-01'),
  LOCAL_API_TOKEN: z.string().default(''),
  AGENT_CONVERSATION_ID: z.string().default(''),
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
  return {
    root: resolve(root),
    port: parsed.PORT,
    sellerId: parsed.SELLER_ID,
    databasePath:
      parsed.DATABASE_PATH === ':memory:'
        ? ':memory:'
        : resolve(root, parsed.DATABASE_PATH),
    apiToken: parsed.LOCAL_API_TOKEN,
    agentBackend: parsed.AGENT_BACKEND,
    conversationId: parsed.AGENT_CONVERSATION_ID,
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
}
export type Config = ReturnType<typeof readConfig>;
