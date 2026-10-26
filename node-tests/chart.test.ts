import assert from 'node:assert/strict';
import test from 'node:test';
import { historyChart } from '../app/chart.ts';
import type { Series } from '../server/analytics.ts';

const fixture = (resets: number[]): Series => ({
  id: 'example',
  label: 'Weekly',
  limit_id: 'example',
  duration: 10080,
  days: [{ date: '2026-10-25', points: 3, samples: 2, uncertain: false }],
  weeks: [{ date: '2026-10-25', points: 3, samples: 2, uncertain: false }],
  periods: resets.map((reset) => ({ resets_at: reset, max_used: 10, samples: 1 })),
});

test('distinct resets sharing a displayed minute retain unique, stable chart identities', () => {
  const series = fixture([1800000000, 1800000001]);
  const format = () => 'Same displayed minute';
  const expected = historyChart(series, 'periods', Infinity, format);
  assert.equal(expected[0].label, expected[1].label);
  assert.equal(new Set(expected.map((row) => row.id)).size, 2);
  for (let i = 0; i < 5; i++) {
    historyChart(series, 'days', Infinity, format);
    assert.deepEqual(historyChart(series, 'periods', Infinity, format), expected);
  }
  assert.deepEqual(
    historyChart(series, 'periods', 0, format).map((r) => r.id),
    expected.map((r) => r.id),
  );
});

test('DST repeated wall-clock times and different views/allowances cannot collide', () => {
  const series = fixture(
    ['2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z'].map((t) => Date.parse(t) / 1000),
  );
  const format = (t: number) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Paris',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(t * 1000);
  const periods = historyChart(series, 'periods', Infinity, format);
  assert.equal(periods[0].label, periods[1].label);
  assert.notEqual(periods[0].id, periods[1].id);
  const day = historyChart(series, 'days', Infinity, format)[0];
  assert.notEqual(day.id, historyChart(series, 'weeks', Infinity, format)[0].id);
  assert.notEqual(day.id, historyChart({ ...series, id: 'other' }, 'days', Infinity, format)[0].id);
});
