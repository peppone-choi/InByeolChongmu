import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readConfig } from '../src/config.ts';
export default defineConfig(({ command, isPreview }) => {
  const config =
    command === 'serve' && !isPreview
      ? readConfig()
      : { port: 3000, apiToken: '' };
  const target = `http://127.0.0.1:${config.port}`;
  return {
    plugins: [
      react(),
      {
        name: 'local-api-boundary',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            let pathname: string;
            try {
              pathname = decodeURIComponent((req.url ?? '/').split('?')[0]!);
            } catch {
              res.statusCode = 400;
              res.end('Invalid path');
              return;
            }
            if (
              /(?:^|\/)\.(?:env(?:\.|\/|$)|local(?:\/|$)|git(?:\/|$))|\.sqlite(?:[^/]*)(?:$|\/)|\.(?:pem|key|crt)$/i.test(
                pathname,
              )
            ) {
              res.statusCode = 403;
              res.end('Private file');
              return;
            }
            if (
              req.url?.startsWith('/api/') ||
              req.url?.startsWith('/health')
            ) {
              const host = req.headers.host;
              if (
                !['127.0.0.1:5173', 'localhost:5173'].includes(host ?? '') ||
                (req.headers.origin && req.headers.origin !== `http://${host}`)
              ) {
                res.statusCode = 403;
                res.end('Origin not allowed');
                return;
              }
              if (req.headers.origin) req.headers.origin = target;
            }
            next();
          });
        },
      },
    ],
    envDir: false,
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: Object.fromEntries(
        ['/api', '/health'].map((path) => [
          path,
          {
            target,
            changeOrigin: true,
            configure(proxy) {
              proxy.on('proxyReq', (request) => {
                if (config.apiToken)
                  request.setHeader(
                    'Authorization',
                    `Bearer ${config.apiToken}`,
                  );
              });
            },
          },
        ]),
      ),
      fs: {
        deny: [
          '**/.env',
          '**/.env.*',
          '**/.local/**',
          '**/*.sqlite*',
          '**/.git/**',
          '**/*.{crt,pem,key}',
        ],
      },
    },
    preview: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: { outDir: '../dist/web', emptyOutDir: true },
  };
});
