import type { Sample } from './database.ts';
import { windowLabel } from './models.ts';
// Percentages of different plans are different units, so every total and period
// belongs to exactly one plan and is never added to another plan's.
export interface Total {
  date: string;
  plan: string | null;
  points: number;
  samples: number;
  uncertain: boolean;
}
export interface Period {
  resets_at: number;
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
  days: Total[];
  weeks: Total[];
  periods: Period[];
}
export function dayAt(seconds: number, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(seconds * 1000));
}
// Providers report the same reset with up to ~1s of jitter between reads (Claude adds
// fractional seconds to every read). Genuine moves, such as Codex shifting a reset by
// minutes, stay distinct.
export const RESET_TOLERANCE_SECONDS = 60;
function monday(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export function summarize(samples: Sample[], timeZone: string): Series[] {
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
    const days = new Map<string, Total>();
    const periods = new Map<string, Period>();
    const highWater = new Map<string, number>();
    const plans: (string | null)[] = [];
    const anchors: number[] = [];
    const canonicalReset = (reset: number) => {
      const anchor = anchors.find((a) => Math.abs(a - reset) <= RESET_TOLERANCE_SECONDS);
      if (anchor !== undefined) return anchor;
      const rounded = Math.round(reset);
      anchors.push(rounded);
      return rounded;
    };
    let previous: Sample | undefined;
    let previousReset: number | undefined;
    for (const row of rows) {
      const plan = row.plan_type;
      if (!plans.includes(plan)) plans.push(plan);
      const date = dayAt(row.collected_at, timeZone);
      const dayKey = JSON.stringify([date, plan]);
      const day = days.get(dayKey) ?? { date, plan, points: 0, samples: 0, uncertain: false };
      days.set(dayKey, day);
      day.samples++;
      const used = row.used_percent;
      if (used === null || row.resets_at === null) {
        day.uncertain = true;
        previous = undefined;
        continue;
      }
      const reset = canonicalReset(row.resets_at);
      const periodKey = JSON.stringify([reset, plan]);
      const period = periods.get(periodKey) ?? {
        resets_at: reset,
        plan,
        max_used: used,
        samples: 0,
      };
      period.max_used = Math.max(period.max_used, used);
      period.samples++;
      periods.set(periodKey, period);
      let high = highWater.get(periodKey);
      // First-ever observation is a baseline, not consumption during that day.
      if (previous && previous.used_percent !== null && previousReset !== undefined) {
        if (previous.plan_type !== plan) {
          // A plan change rescales the percentage; the new plan's first reading is a baseline.
          day.uncertain = true;
        } else if (reset === previousReset && used < previous.used_percent / 2) {
          // The provider reset the allowance early without moving its reset time
          // (seen with Claude's weekly limit): usage since then is new consumption.
          day.points += used;
          high = undefined;
          day.uncertain = true;
        } else if (reset === previousReset) {
          // Small downward corrections are noise; recovering to the high-water mark is not new use.
          day.points += Math.max(0, used - (high ?? previous.used_percent));
          if (used < previous.used_percent) day.uncertain = true;
        } else {
          // A new fixed period can start after the old reset, including an idle delay.
          // A moving/reset-corrected timestamp before expiry is not evidence of new consumption.
          if (reset > previousReset && row.collected_at >= previousReset && high === undefined) {
            day.points += used;
          }
          day.uncertain = true;
        }
        if (
          row.collected_at - previous.collected_at > 600 ||
          dayAt(previous.collected_at, timeZone) !== date
        )
          day.uncertain = true;
      } else {
        day.uncertain = true;
      }
      highWater.set(periodKey, Math.max(high ?? used, used));
      previous = row;
      previousReset = reset;
    }
    const weeks = new Map<string, Total>();
    for (const day of days.values()) {
      const date = monday(day.date);
      const weekKey = JSON.stringify([date, day.plan]);
      const week = weeks.get(weekKey) ?? {
        date,
        plan: day.plan,
        points: 0,
        samples: 0,
        uncertain: false,
      };
      week.points += day.points;
      week.samples += day.samples;
      week.uncertain ||= day.uncertain;
      weeks.set(weekKey, week);
    }
    return {
      id,
      label: `${first.limit_id ?? 'Default'} · ${windowLabel(first.window_duration_minutes, first.window_key)}`,
      limit_id: first.limit_id,
      duration: first.window_duration_minutes,
      plans,
      days: [...days.values()],
      weeks: [...weeks.values()],
      // Stable sort keeps plans within a shared reset in observation order.
      periods: [...periods.values()].sort((a, b) => a.resets_at - b.resets_at),
    };
  });
}
