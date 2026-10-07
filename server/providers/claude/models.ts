import { CollectionError, type JsonObject, object, type Window } from '../../models.ts';

const durations: Record<string, number> = {
  five_hour: 300,
  seven_day: 10080,
  seven_day_opus: 10080,
  seven_day_sonnet: 10080,
  seven_day_oauth_apps: 10080,
  seven_day_cowork: 10080,
};
export function claudeResult(response: unknown): JsonObject {
  if (
    !object(response) ||
    response.type !== 'control_response' ||
    !object(response.response) ||
    response.response.subtype !== 'success' ||
    !object(response.response.response)
  ) {
    throw new CollectionError('Invalid Claude usage response.');
  }
  return response.response.response;
}
function resetTime(value: unknown) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new CollectionError('Invalid Claude reset timestamp.');
  }
  const seconds = Date.parse(value) / 1000;
  if (!Number.isFinite(seconds)) throw new CollectionError('Invalid Claude reset timestamp.');
  return seconds;
}
export function parseClaudeWindows(response: unknown): Window[] {
  const result = claudeResult(response);
  if (result.rate_limits_available !== true || !object(result.rate_limits)) {
    throw new CollectionError(
      'Claude subscription limits are unavailable. Check claude auth login --claudeai and network access.',
    );
  }
  const plan = result.subscription_type ?? null;
  if (plan !== null && typeof plan !== 'string')
    throw new CollectionError('Invalid Claude subscription metadata.');
  const windows: Window[] = [];
  function add(key: string, value: unknown, duration: number | null, id = key) {
    if (value == null) return;
    if (!object(value)) throw new CollectionError('Invalid Claude quota window.');
    const used = value.utilization ?? null;
    if (
      used !== null &&
      (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100)
    ) {
      throw new CollectionError('Invalid Claude quota percentage.');
    }
    windows.push({
      limit_id: id,
      window_key: key,
      window_duration_minutes: duration,
      used_percent: used as number | null,
      resets_at: resetTime(value.resets_at),
      plan_type: plan as string | null,
    });
  }
  for (const [key, value] of Object.entries(result.rate_limits)) {
    // Extra-usage money/spend limits aren't subscription allowance windows.
    if (['extra_usage', 'spend', 'limits', 'model_scoped'].includes(key)) continue;
    if (key in durations) add(key, value, durations[key]);
    else if (object(value) && 'utilization' in value && 'resets_at' in value) add(key, value, null);
  }
  // This is the CLI's projection of per-model weekly limits. The raw `limits`
  // array is preserved but not guessed at or added a second time.
  const scoped = result.rate_limits.model_scoped;
  if (scoped != null) {
    if (!Array.isArray(scoped)) throw new CollectionError('Invalid Claude model quota list.');
    const names = new Set<string>();
    for (const row of scoped) {
      if (!object(row) || typeof row.display_name !== 'string' || !row.display_name.trim()) {
        throw new CollectionError('Invalid Claude model quota metadata.');
      }
      if (names.has(row.display_name))
        throw new CollectionError('Ambiguous Claude model quota names.');
      names.add(row.display_name);
      add(`model_scoped:${row.display_name}`, row, 10080, `model:${row.display_name}`);
    }
  }
  if (!windows.length) throw new CollectionError('Claude returned no subscription quota windows.');
  return windows;
}
