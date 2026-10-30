import type { Sample } from './database.ts';
import { windowLabel } from './models.ts';
// Percentages of different plans are different units, so every period belongs to
// exactly one plan and is never compared with another plan's.
export interface Period {
  resets_at: number;
  /** When a later period replaced this one before its reset (an early reset or a plan
      change), else null. */
  ended_at: number | null;
  plan: string | null;
  max_used: number;
  samples: number;
}
export interface Series {
  id: string;
  label: string;
  limit_id: string | null;
  duration: number | null;
  /** Plans in order of first observation. */
  plans: (string | null)[];
  periods: Period[];
}
// Providers report the same reset with up to ~1s of jitter between reads (Claude adds
// fractional seconds to every read). Genuine moves, such as Codex shifting a reset by
// minutes, stay distinct.
export const RESET_TOLERANCE_SECONDS = 60;
export function summarize(samples: Sample[]): Series[] {
  // Renames are matched by duration. If a bucket has two windows of the same duration,
  // retain their keys rather than silently combining distinct allowances.
  const ambiguous = new Set<string>();
  const seen = new Set<string>();
  for (const s of samples) {
    const base = JSON.stringify([s.provider, s.account, s.limit_id, s.window_duration_minutes]);
    const at = `${s.snapshot_id}:${base}`;
    if (seen.has(at)) ambiguous.add(base);
    seen.add(at);
  }
  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    const base = JSON.stringify([s.provider, s.account, s.limit_id, s.window_duration_minutes]);
    const key = JSON.stringify([
      s.provider,
      s.account,
      s.limit_id,
      s.window_duration_minutes,
      s.window_duration_minutes === null || ambiguous.has(base) ? s.window_key : null,
    ]);
    const group = groups.get(key) ?? [];
    group.push(s);
    groups.set(key, group);
  }
  return [...groups].map(([id, rows]) => {
    const first = rows[0];
    const periods = new Map<string, Period>();
    const plans: (string | null)[] = [];
    const anchors: number[] = [];
    const canonicalReset = (reset: number) => {
      const anchor = anchors.find((a) => Math.abs(a - reset) <= RESET_TOLERANCE_SECONDS);
      if (anchor !== undefined) return anchor;
      const rounded = Math.round(reset);
      anchors.push(rounded);
      return rounded;
    };
    let open: Period | undefined;
    for (const row of rows) {
      const plan = row.plan_type;
      if (!plans.includes(plan)) plans.push(plan);
      const used = row.used_percent;
      if (used === null || row.resets_at === null) continue;
      const reset = canonicalReset(row.resets_at);
      const periodKey = JSON.stringify([reset, plan]);
      let period = periods.get(periodKey);
      if (!period && open?.plan === plan && open.max_used === 0) {
        // Codex slides an unused allowance's reset forward on every reading until it is
        // used, so a period with no use yet follows its reset instead of splitting.
        periods.delete(JSON.stringify([open.resets_at, plan]));
        open.resets_at = reset;
        period = open;
      }
      period ??= { resets_at: reset, ended_at: null, plan, max_used: used, samples: 0 };
      if (open && period !== open && open.ended_at === null && row.collected_at < open.resets_at)
        open.ended_at = row.collected_at;
      period.max_used = Math.max(period.max_used, used);
      period.samples++;
      periods.set(periodKey, period);
      open = period;
    }
    return {
      id,
      label: `${first.limit_id ?? 'Default'} · ${windowLabel(first.window_duration_minutes, first.window_key)}`,
      limit_id: first.limit_id,
      duration: first.window_duration_minutes,
      plans,
      // Stable sort keeps plans within a shared reset in observation order.
      periods: [...periods.values()].sort((a, b) => a.resets_at - b.resets_at),
    };
  });
}
