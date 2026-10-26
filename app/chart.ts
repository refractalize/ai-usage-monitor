import type { Series } from '../server/analytics.ts';

export type HistoryView = 'days' | 'weeks' | 'periods';

export function historyChart(
  series: Series | undefined,
  view: HistoryView,
  now: number,
  formatReset: (seconds: number) => string,
) {
  if (!series) return [];
  if (view === 'periods') {
    return series.periods.slice(-12).map((period) => ({
      // Display labels can collide (seconds are hidden, and DST repeats local times).
      id: JSON.stringify([series.id, view, period.resets_at]),
      label: formatReset(period.resets_at) + (period.resets_at > now ? ' · current' : ''),
      value: period.max_used,
      uncertain: false,
      samples: period.samples,
    }));
  }
  return series[view].slice(view === 'days' ? -30 : -12).map((day) => ({
    id: JSON.stringify([series.id, view, day.date]),
    label: day.date,
    value: day.points,
    uncertain: day.uncertain,
    samples: day.samples,
  }));
}
