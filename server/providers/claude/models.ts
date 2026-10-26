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
// get_usage reports success with `rate_limits: null` whenever the CLI's own
// GET /api/oauth/usage fails, so the cause is only visible in its debug log.
// Patterns verified against Claude Code 2.1.310.
export function usageFetched(debugLog: string) {
  return /fetchUtilization: 200 after \d+ attempt/.test(debugLog);
}
export function usageFetchError(debugLog: string): CollectionError {
  if (!debugLog.trim())
    return new CollectionError(
      'Claude returned no usage limits and wrote no debug log. Check CLI compatibility.',
    );
  const remembered = /fetchUtilization: 429 remembered.*?not asking again for (\d+)s/.exec(
    debugLog,
  );
  const failure = [...debugLog.matchAll(/Failed to load usage data: (.*)/g)].at(-1)?.[1].trim();
  const status = failure && /status code (\d{3})/.exec(failure)?.[1];
  if (remembered || status === '429') {
    const seconds = remembered ? Number(remembered[1]) : undefined;
    return new CollectionError(
      `Claude's usage endpoint rate-limited this account (HTTP 429)${seconds ? `; the CLI will not ask again for ${seconds}s` : ''}. Other Claude Code sessions on the same login share this limit.`,
      { kind: 'rate_limited', retryAfterMs: seconds && seconds * 1000 },
    );
  }
  if (status) {
    const hint = ['401', '403'].includes(status)
      ? ' Check claude auth status.'
      : status.startsWith('5')
        ? ' This is an upstream error.'
        : '';
    return new CollectionError(`Claude's usage endpoint returned HTTP ${status}.${hint}`);
  }
  if (failure) {
    // Transport errors (DNS, TLS, proxy) carry no response body; still bound and redact them.
    const detail = failure.replace(/(Bearer|sk-ant-)\S*/gi, '[redacted]').slice(0, 160);
    return new CollectionError(`Claude could not reach its usage endpoint: ${detail}`);
  }
  if (!/fetchUtilization: GET/.test(debugLog)) {
    // The CLI suppresses requests after a recent 429 without logging the request.
    return new CollectionError(
      'Claude CLI skipped its usage request, usually because of a recent rate limit.',
      { kind: 'rate_limited' },
    );
  }
  return new CollectionError(
    'Claude returned no usage limits and its debug log did not say why. Check CLI compatibility.',
  );
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
  if (result.rate_limits_available === true && result.rate_limits == null) {
    // readClaudeUsage normally classifies this first from the CLI debug log.
    throw new CollectionError('Claude returned no usage limits; its usage request failed.');
  }
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
