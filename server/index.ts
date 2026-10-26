import { createRequestHandler } from '@react-router/express';
import express from 'express';
import { duration, log } from './log.ts';
import { enabledProviders, providerName, scopeFor } from './providers.ts';
import { INTERVAL_MS, startScheduler } from './scheduler.ts';
import { collect, getStore, setCollection } from './service.ts';

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
          // collect() logs every outcome itself.
          collect: (signal) => collect(store, signal, scope),
          onBackoff: (wait, consecutive) =>
            log(
              `${providerName(provider)}: backing off after ${consecutive} rate-limited attempt(s); next attempt in ${duration(wait)} at ${new Date(Date.now() + wait).toISOString()}.`,
            ),
        });
      });
setCollection({ providers, scheduled: schedulers.length > 0 });
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
  log(
    `Subscription usage dashboard listening on port ${process.env.PORT ?? 3000}; ${schedulers.length ? `collecting ${providers.map(providerName).join(', ')} every ${duration(INTERVAL_MS)}` : 'collection disabled'}.`,
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
