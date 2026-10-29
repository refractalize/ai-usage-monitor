import type { Series } from '../server/analytics.ts';

export type HistoryView = 'days' | 'weeks' | 'periods';
// 'main' while one plan is visible; otherwise a categorical slot. Slot 0 is always the
// newest plan and shares the main colour, so colours follow plans and never repaint
// as older bars scroll away.
export type PlanColour = 'main' | 0 | 1 | 2;
export interface ChartBar {
  id: string;
  plan: string | null;
  colour: PlanColour;
  value: number;
  uncertain: boolean;
  samples: number;
}
export interface ChartGroup {
  id: string;
  label: string;
  bars: ChartBar[];
}
export interface PlanKey {
  plan: string | null;
  label: string;
  colour: PlanColour;
}
export interface HistoryChart {
  groups: ChartGroup[];
  /** Legend entries, newest plan first; empty while only one plan is visible. */
  legend: PlanKey[];
}

export function planLabel(plan: string | null) {
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : 'Unknown plan';
}

export function historyChart(
  series: Series | undefined,
  view: HistoryView,
  now: number,
  formatReset: (seconds: number) => string,
): HistoryChart {
  if (!series) return { groups: [], legend: [] };
  const rows =
    view === 'periods'
      ? series.periods.map((p) => ({
          key: p.resets_at,
          label: formatReset(p.resets_at) + (p.resets_at > now ? ' · current' : ''),
          plan: p.plan,
          value: p.max_used,
          uncertain: false,
          samples: p.samples,
        }))
      : series[view].map((t) => ({
          key: t.date,
          label: t.date,
          plan: t.plan,
          value: t.points,
          uncertain: t.uncertain,
          samples: t.samples,
        }));
  const keys = [...new Set(rows.map((r) => r.key))].slice(view === 'days' ? -30 : -12);
  const visible = rows.filter((r) => keys.includes(r.key));
  const newestFirst = [...series.plans].reverse();
  const shown = newestFirst.filter((plan) => visible.some((r) => r.plan === plan));
  // Three validated hues; any older plans beyond that share the last slot.
  const colour = (plan: string | null): PlanColour =>
    shown.length < 2 ? 'main' : (Math.min(2, newestFirst.indexOf(plan)) as 0 | 1 | 2);
  const order = (plan: string | null) => series.plans.indexOf(plan);
  const groups = keys.map((key) => {
    const matching = visible.filter((r) => r.key === key);
    return {
      // Display labels can collide (seconds are hidden, and DST repeats local times).
      id: JSON.stringify([series.id, view, key]),
      label: matching[0].label,
      bars: matching
        .sort((a, b) => order(a.plan) - order(b.plan))
        .map((r) => ({
          id: JSON.stringify([series.id, view, key, r.plan]),
          plan: r.plan,
          colour: colour(r.plan),
          value: r.value,
          uncertain: r.uncertain,
          samples: r.samples,
        })),
    };
  });
  return {
    groups,
    legend:
      shown.length < 2
        ? []
        : shown.map((plan) => ({ plan, label: planLabel(plan), colour: colour(plan) })),
  };
}
