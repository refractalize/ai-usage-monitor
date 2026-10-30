import assert from 'node:assert/strict';
import test from 'node:test';
import { allowanceLabels, historyChart } from '../app/chart.ts';
import type { Period, Series } from '../server/analytics.ts';

const period = (resets_at: number, max_used = 10, plan = 'pro'): Period => ({
  resets_at,
  ended_at: null,
  plan,
  max_used,
  samples: 1,
});
const fixture = (periods: Period[], extra: Partial<Series> = {}): Series => ({
  id: 'example',
  label: 'example · Weekly',
  limit_id: 'example',
  duration: 10080,
  plans: ['pro'],
  periods,
  ...extra,
});

test('each group is one reset period, starting one allowance length before it resets', () => {
  const chart = historyChart(fixture([period(1_000_000, 40), period(1_604_800, 75)]), 1_200_000);
  assert.deepEqual(
    chart.groups.map((g) => [g.starts_at, g.resets_at, g.current]),
    [
      [1_000_000 - 604_800, 1_000_000, false],
      [1_000_000, 1_604_800, true],
    ],
  );
  assert.equal(chart.peak, 75);
  assert.equal(historyChart(fixture([period(5)], { duration: null }), 0).groups[0].starts_at, null);
});

test('the range keeps periods that overlap it, and the max covers just those', () => {
  const day = 86400;
  const now = 100 * day;
  const series = fixture([
    period(now - 40 * day, 100),
    { ...period(now + 2 * day, 60), ended_at: now - 31 * day },
    period(now - 29 * day, 20),
    period(now + day, 30),
  ]);
  const chart = historyChart(series, now, 30);
  assert.deepEqual(
    chart.groups.map((g) => g.resets_at),
    [now - 29 * day, now + day],
  );
  assert.equal(chart.peak, 30);
  assert.equal(historyChart(series, now, 7).groups.length, 1);
  assert.equal(historyChart(series, now, 90).peak, 100);
  assert.equal(historyChart(undefined, 0).peak, 0);
});

test('distinct resets and allowances keep unique, stable chart identities', () => {
  const series = fixture([period(1800000000), period(1800000001)]);
  const ids = historyChart(series, 1800000010).groups.map((g) => g.id);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(
    historyChart(series, 0).groups.map((g) => g.id),
    ids,
  );
  assert.notEqual(historyChart({ ...series, id: 'other' }, 0).groups[0].id, ids[0]);
});

test('one visible plan uses the main colour; several get stable per-plan colours', () => {
  const series = fixture(
    [period(1, 30), period(2, 60), period(3, 90), period(3, 5, 'max'), period(4, 20, 'max')],
    { plans: ['pro', 'max'] },
  );
  const both = historyChart(series, 10);
  assert.deepEqual(
    both.legend.map((p) => [p.label, p.colour, p.peak]),
    [
      ['Max', 0, 20],
      ['Pro', 1, 90],
    ],
  );
  // The changeover period shows two bars, older plan first; the newest plan keeps slot 0.
  assert.deepEqual(
    both.groups[2].bars.map((b) => [b.plan, b.colour, b.value]),
    [
      ['pro', 1, 90],
      ['max', 0, 5],
    ],
  );
  const onlyMax = historyChart({ ...series, periods: series.periods.slice(4) }, 10);
  assert.deepEqual(onlyMax.legend, [
    {
      plan: 'max',
      label: 'Max',
      colour: 'main',
      peak: 20,
    },
  ]);
  assert.equal(onlyMax.groups[0].bars[0].colour, 'main');
});

test('allowance tabs get short labels unless those would collide', () => {
  const labels = allowanceLabels([
    fixture([], { id: 'a', limit_id: 'five_hour', duration: 300 }),
    fixture([], { id: 'b', limit_id: 'seven_day', label: 'seven_day · Weekly' }),
    fixture([], { id: 'c', limit_id: 'model:Fable', label: 'model:Fable · Weekly' }),
  ]);
  assert.deepEqual([...labels.values()], ['5-hour', 'Weekly', 'Fable · Weekly']);
  const clash = allowanceLabels([
    fixture([], { id: 'a', label: 'one · Weekly' }),
    fixture([], { id: 'b', label: 'two · Weekly' }),
  ]);
  assert.deepEqual([...clash.values()], ['one · Weekly', 'two · Weekly']);
});
