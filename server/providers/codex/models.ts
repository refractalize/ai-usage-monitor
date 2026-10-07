import { CollectionError, canonical, object, type Window } from '../../models.ts';

function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string')
    throw new CollectionError('Invalid text metadata in rate-limit response.');
  return value;
}
function number(value: unknown, integer = false): number | null {
  if (value == null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new CollectionError('Invalid numeric metadata in rate-limit response.');
  }
  return value;
}
export function parseWindows(response: unknown): Window[] {
  if (!object(response) || !object(response.result))
    throw new CollectionError('Invalid rate-limit response.');
  const { rateLimits: legacy, rateLimitsByLimitId: multiple } = response.result;
  if (multiple != null && !object(multiple))
    throw new CollectionError('Invalid rate-limit bucket map.');
  if (legacy != null && !object(legacy))
    throw new CollectionError('Invalid legacy rate-limit bucket.');
  const buckets: [string | null, unknown][] = Object.entries(multiple ?? {});
  if (object(legacy)) {
    const id = text(legacy.limitId);
    if (
      !buckets.some(
        ([key, b]) =>
          key === id ||
          (object(b) && ((id !== null && b.limitId === id) || canonical(b) === canonical(legacy))),
      )
    )
      buckets.push([id, legacy]);
  }
  if (!buckets.length)
    throw new CollectionError('No rate-limit buckets returned; check Codex ChatGPT login.');
  const windows: Window[] = [];
  for (const [mapId, bucket] of buckets) {
    if (!object(bucket)) throw new CollectionError('Invalid rate-limit bucket.');
    const limit_id = text(bucket.limitId ?? mapId);
    const plan_type = text(bucket.planType);
    for (const [window_key, value] of Object.entries(bucket)) {
      if (value == null) continue;
      if (!object(value)) {
        if (['primary', 'secondary'].includes(window_key))
          throw new CollectionError('Invalid rate-limit window.');
        continue;
      }
      if (!('usedPercent' in value || 'windowDurationMins' in value)) continue;
      const window_duration_minutes = number(value.windowDurationMins, true);
      const used_percent = number(value.usedPercent);
      const resets_at = number(value.resetsAt, true);
      if (
        (window_duration_minutes !== null && window_duration_minutes <= 0) ||
        (used_percent !== null && used_percent < 0) ||
        (resets_at !== null && !Number.isFinite(new Date(resets_at * 1000).getTime()))
      ) {
        throw new CollectionError('Invalid rate-limit window metadata.');
      }
      windows.push({
        limit_id,
        window_key,
        window_duration_minutes,
        used_percent,
        resets_at,
        plan_type,
      });
    }
  }
  return windows;
}
