import { serve } from '@hono/node-server';
import { bootstrap } from '../bootstrap.js';
import { FlueRunner } from '../agent/flue-runner.js';
import { createApp } from './app.js';
const { store, config } = bootstrap();
const runner = new FlueRunner(store, config);
const server = serve(
  {
    fetch: createApp(store, config, { runner }).fetch,
    hostname: config.listenHost,
    port: config.port,
  },
  () =>
    console.log(
      `인별총무 API: http://127.0.0.1:${config.port} (자료 연결됨, 실행기: ${config.agentBackend})`,
    ),
);
const shutdown = () =>
  server.close(async () => {
    await runner.stop();
    store.close();
    process.exit(0);
  });
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
