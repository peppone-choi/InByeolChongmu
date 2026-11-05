import { serve } from '@hono/node-server';
import { bootstrap } from '../bootstrap.js';
import { createApp } from './app.js';
const { store, config } = bootstrap();
const server = serve(
  {
    fetch: createApp(store, config).fetch,
    hostname: '127.0.0.1',
    port: config.port,
  },
  () =>
    console.log(
      `인별총무 API: http://127.0.0.1:${config.port} (자료 연결됨, 모델 미연결)`,
    ),
);
const shutdown = () =>
  server.close(() => {
    store.close();
    process.exit(0);
  });
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
