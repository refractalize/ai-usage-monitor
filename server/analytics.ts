import type { Sample } from './database.ts';
import { windowLabel } from './models.ts';
export interface Total {
  date: string;
  points: number;
  samples: number;
  uncertain: boolean;
}
export interface Period {
  resets_at: number;
  max_used: number;
  samples: number;
}
export interface Series {
  id: string;
  label: string;
  limit_id: string | null;
  duration: number | null;
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
    const periods = new Map<number, Period>();
    const highWater = new Map<number, number>();
    let previous: Sample | undefined;
    for (const row of rows) {
      const date = dayAt(row.collected_at, timeZone);
      const day = days.get(date) ?? { date, points: 0, samples: 0, uncertain: false };
      days.set(date, day);
      day.samples++;
      const used = row.used_percent;
      const reset = row.resets_at;
      if (used === null || reset === null) {
        day.uncertain = true;
        previous = undefined;
        continue;
      }
      const period = periods.get(reset) ?? { resets_at: reset, max_used: used, samples: 0 };
      period.max_used = Math.max(period.max_used, used);
      period.samples++;
      periods.set(reset, period);
      const high = highWater.get(reset);
      // First-ever observation is a baseline, not consumption during that day.
      if (previous && previous.used_percent !== null && previous.resets_at !== null) {
        if (reset === previous.resets_at) {
          day.points += Math.max(0, used - (high ?? previous.used_percent));
          if (used < previous.used_percent) day.uncertain = true;
        } else {
          // A new fixed period can start after the old reset, including an idle delay.
          // A moving/reset-corrected timestamp before expiry is not evidence of new consumption.
          if (
            reset > previous.resets_at &&
            row.collected_at >= previous.resets_at &&
            high === undefined
          ) {
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
      highWater.set(reset, Math.max(high ?? used, used));
      previous = row;
    }
    const weeks = new Map<string, Total>();
    for (const day of days.values()) {
      const date = monday(day.date);
      const week = weeks.get(date) ?? { date, points: 0, samples: 0, uncertain: false };
      week.points += day.points;
      week.samples += day.samples;
      week.uncertain ||= day.uncertain;
      weeks.set(date, week);
    }
    return {
      id,
      label: `${first.limit_id ?? 'Default'} · ${windowLabel(first.window_duration_minutes, first.window_key)}`,
      limit_id: first.limit_id,
      duration: first.window_duration_minutes,
      days: [...days.values()],
      weeks: [...weeks.values()],
      periods: [...periods.values()].sort((a, b) => a.resets_at - b.resets_at),
    };
  });
}
