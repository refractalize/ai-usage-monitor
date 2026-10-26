import { type Window, windowLabel } from './models.ts';

// One timestamped line per event so plain container logs are readable without `-t`.
export function log(message: string) {
  console.error(`${new Date().toISOString()} ${message}`);
}
export function duration(ms: number) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
export function describeWindows(windows: Window[]) {
  return windows
    .map((w) => {
      const used = w.used_percent === null ? '?' : `${Math.round(w.used_percent * 10) / 10}%`;
      const resets =
        w.resets_at === null
          ? ''
          : ` (resets ${new Date(w.resets_at * 1000).toISOString().slice(0, 16)}Z)`;
      return `${w.limit_id ?? w.window_key} ${windowLabel(w.window_duration_minutes, w.window_key)} ${used}${resets}`;
    })
    .join(', ');
}
