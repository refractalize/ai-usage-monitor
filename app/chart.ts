import type { Series } from '../server/analytics.ts';
import { windowLabel } from '../server/models.ts';

// 'main' while one plan is visible; otherwise a categorical slot. Slot 0 is always the
// newest plan and shares the main colour, so colours follow plans and never repaint
// as older bars scroll away.
export type PlanColour = 'main' | 0 | 1 | 2;
export interface ChartBar {
  id: string;
  plan: string | null;
  colour: PlanColour;
  value: number;
  /** Set when the period was replaced before its scheduled reset. */
  ended_at: number | null;
}
/** One reset period: the allowance's window ending at `resets_at`. */
export interface ChartGroup {
  id: string;
  /** Null when the allowance's duration is unknown. */
  starts_at: number | null;
  resets_at: number;
  current: boolean;
  bars: ChartBar[];
}
export interface PlanKey {
  plan: string | null;
  label: string;
  colour: PlanColour;
  /** Highest percentage used on this plan in the periods shown. */
  peak: number;
}
export interface HistoryChart {
  groups: ChartGroup[];
  /** Plans in the periods shown, newest first. */
  legend: PlanKey[];
  /** Highest percentage used in any period shown; 0 when nothing is shown. */
  peak: number;
}

/** Chart ranges in days; a period is shown if any of it falls within the range. */
export const RANGES = [7, 30, 60, 90] as const;
export type RangeDays = (typeof RANGES)[number];
export const DEFAULT_RANGE: RangeDays = 30;

export function planLabel(plan: string | null) {
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : 'Unknown plan';
}

/** Short tab labels ("5-hour", "Weekly", "Fable · Weekly"), falling back to the full
    series label wherever the short ones would collide. */
export function allowanceLabels(series: Series[]): Map<string, string> {
  const short = series.map((s) => {
    const window = windowLabel(s.duration, s.label);
    const model = s.limit_id?.startsWith('model:') ? s.limit_id.slice('model:'.length) : null;
    return model ? `${model} · ${window}` : window;
  });
  return new Map(
    series.map((s, i) => [
      s.id,
      short.indexOf(short[i]) === short.lastIndexOf(short[i]) ? short[i] : s.label,
    ]),
  );
}

export function historyChart(
  series: Series | undefined,
  now: number,
  days: number = DEFAULT_RANGE,
): HistoryChart {
  if (!series) return { groups: [], legend: [], peak: 0 };
  const since = now - days * 86400;
  const visible = series.periods.filter((p) => (p.ended_at ?? p.resets_at) > since);
  const keys = [...new Set(visible.map((p) => p.resets_at))];
  const newestFirst = [...series.plans].reverse();
  const shown = newestFirst.filter((plan) => visible.some((p) => p.plan === plan));
  // Three validated hues; any older plans beyond that share the last slot.
  const colour = (plan: string | null): PlanColour =>
    shown.length < 2 ? 'main' : (Math.min(2, newestFirst.indexOf(plan)) as 0 | 1 | 2);
  const order = (plan: string | null) => series.plans.indexOf(plan);
  const groups = keys.map((reset) => ({
    // Display labels can collide (seconds are hidden, and DST repeats local times).
    id: JSON.stringify([series.id, reset]),
    starts_at: series.duration === null ? null : reset - series.duration * 60,
    resets_at: reset,
    current: reset > now && visible.some((p) => p.resets_at === reset && p.ended_at === null),
    bars: visible
      .filter((p) => p.resets_at === reset)
      .sort((a, b) => order(a.plan) - order(b.plan))
      .map((p) => ({
        id: JSON.stringify([series.id, reset, p.plan]),
        plan: p.plan,
        colour: colour(p.plan),
        value: p.max_used,
        ended_at: p.ended_at,
      })),
  }));
  return {
    groups,
    legend: shown.map((plan) => ({
      plan,
      label: planLabel(plan),
      colour: colour(plan),
      peak: Math.max(...visible.filter((p) => p.plan === plan).map((p) => p.max_used)),
    })),
    peak: Math.max(0, ...visible.map((p) => p.max_used)),
  };
}
