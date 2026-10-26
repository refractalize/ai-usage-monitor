import { CollectionError } from './models.ts';

export const INTERVAL_MS = 5 * 60 * 1000;
export const MAX_BACKOFF_MS = 60 * 60 * 1000;
// Lands just after the upstream retry window rather than on its edge.
const RETRY_MARGIN_MS = 30 * 1000;
export interface SchedulerOptions {
  collect: (signal: AbortSignal) => Promise<void>;
  lastAttemptMs?: number;
  intervalMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
  onBackoff?: (waitMs: number, consecutive: number) => void;
}
// Consecutive rate limits double the wait, never below the upstream hint, capped at an hour.
export function backoffDelay(interval: number, consecutive: number, retryAfterMs = 0) {
  return Math.min(
    Math.max(MAX_BACKOFF_MS, interval),
    Math.max(interval * 2 ** (consecutive - 1), retryAfterMs + RETRY_MARGIN_MS),
  );
}
export function startScheduler(options: SchedulerOptions) {
  const interval = options.intervalMs ?? INTERVAL_MS;
  if (!Number.isFinite(interval) || interval <= 0) throw new Error('Invalid collection interval');
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let active: Promise<void> | undefined;
  let stopped = false;
  let rateLimited = 0;
  const schedule = (wait: number) => {
    timer = setTimeout(run, wait);
  };
  const run = () => {
    if (stopped) return;
    const started = now();
    let wait: number | undefined;
    active = Promise.resolve()
      .then(() => options.collect(controller.signal))
      .then(
        () => {
          rateLimited = 0;
        },
        (error) => {
          // Other failures may be transient, so they retry on the normal interval.
          if (error instanceof CollectionError && error.kind === 'rate_limited') {
            rateLimited++;
            wait = backoffDelay(interval, rateLimited, error.retryAfterMs);
          } else rateLimited = 0;
          options.onError?.(error);
          if (wait !== undefined) options.onBackoff?.(wait, rateLimited);
        },
      )
      .finally(() => {
        active = undefined;
        if (!stopped) schedule(wait ?? Math.max(0, interval - (now() - started)));
      });
  };
  // Clock changes cannot postpone collection for longer than one interval.
  schedule(
    Math.min(interval, Math.max(0, (options.lastAttemptMs ?? -Infinity) + interval - now())),
  );
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
      await active;
    },
  };
}
