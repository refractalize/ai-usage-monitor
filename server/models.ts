export class CollectionError extends Error {}
export type JsonObject = Record<string, unknown>;
export function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export interface Window {
  limit_id: string | null;
  window_key: string;
  window_duration_minutes: number | null;
  used_percent: number | null;
  resets_at: number | null;
  plan_type: string | null;
}
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    object(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}
export interface NormalizedSnapshot {
  raw_response: JsonObject;
  windows: Window[];
  deduplication_value: unknown;
}
export function windowLabel(minutes: number | null, key = 'Unknown window') {
  if (minutes === 10080) return 'Weekly';
  if (minutes === null) return key;
  return minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
}
