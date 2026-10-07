import { createRequestHandler } from '@react-router/express';
import express from 'express';
import { enabledProviders, providerName, scopeFor } from './providers.ts';
import { startScheduler } from './scheduler.ts';
import { collect, getStore, safeError } from './service.ts';

const dev = process.env.NODE_ENV !== 'production';
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
const store = getStore();
const providers = enabledProviders();
const schedulers =
  process.env.AI_USAGE_SCHEDULE === 'off'
    ? []
    : providers.map((provider) => {
        const scope = scopeFor(provider);
        const lastAttempt = store.lastAttempt(scope);
        return startScheduler({
          lastAttemptMs: lastAttempt ? lastAttempt.attempted_at * 1000 : undefined,
          collect: async (signal) => {
            try {
              await collect(store, signal, scope);
            } catch (error) {
              console.error(`${providerName(provider)}: ${safeError(error)}`);
            }
          },
        });
      });
const vite = dev
  ? await (await import('vite')).createServer({
      server: { middlewareMode: true },
      appType: 'custom',
    })
  : undefined;
if (vite) app.use(vite.middlewares);
else app.use(express.static('build/client'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(
  createRequestHandler({
    build: vite
      ? () => vite.ssrLoadModule('virtual:react-router/server-build') as never
      : await import('../build/server/index.js'),
  }),
);
const server = app.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1', () => {
  console.error(
    `Subscription usage dashboard listening on port ${process.env.PORT ?? 3000}; collection ${schedulers.length ? 'every 5 minutes' : 'disabled'}.`,
  );
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(schedulers.map((s) => s.stop()));
  await vite?.close();
  server.closeIdleConnections();
  await closed;
  store.close();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
