export const INTERVAL_MS = 5 * 60 * 1000;
export interface SchedulerOptions {
  collect: (signal: AbortSignal) => Promise<void>;
  lastAttemptMs?: number;
  intervalMs?: number;
  now?: () => number;
  onError?: () => void;
}
export function startScheduler(options: SchedulerOptions) {
  const interval = options.intervalMs ?? INTERVAL_MS;
  if (!Number.isFinite(interval) || interval <= 0) throw new Error('Invalid collection interval');
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let active: Promise<void> | undefined;
  let stopped = false;
  const schedule = (wait: number) => {
    timer = setTimeout(run, wait);
  };
  const run = () => {
    if (stopped) return;
    const started = now();
    active = Promise.resolve()
      .then(() => options.collect(controller.signal))
      .catch(() => options.onError?.())
      .finally(() => {
        active = undefined;
        if (!stopped) schedule(Math.max(0, interval - (now() - started)));
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
