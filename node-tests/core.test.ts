import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { summarize } from '../server/analytics.ts';
import type { Sample } from '../server/database.ts';
import {
  handshakeAndRead,
  readRateLimits,
  waitForResponse,
} from '../server/providers/codex/appserver.ts';
import { parseWindows } from '../server/providers/codex/models.ts';
import { INTERVAL_MS, startScheduler } from '../server/scheduler.ts';
import { FixtureStore as Store } from './helpers.ts';

const response = (used = 37, reset = 20000) => ({
  id: 2,
  result: {
    rateLimits: {
      limitId: 'codex',
      planType: 'pro',
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 15000 },
      secondary: { usedPercent: used, windowDurationMins: 10080, resetsAt: reset },
    },
  },
});
const sample = (used: number | null, at: number, reset = 10000, key = 'primary'): Sample => ({
  provider: 'codex',
  account: 'default',
  snapshot_id: at,
  collected_at: at,
  limit_id: 'codex',
  window_key: key,
  window_duration_minutes: 10080,
  used_percent: used,
  resets_at: reset,
  plan_type: 'pro',
});
test('normal response, weekly duration, renamed windows, multiple limits and legacy mirror', () => {
  assert.equal(parseWindows(response())[1].window_duration_minutes, 10080);
  const bucket = { limitId: 'a', alternate: { windowDurationMins: 10080, usedPercent: 33 } };
  const parsed = parseWindows({
    result: {
      rateLimits: bucket,
      rateLimitsByLimitId: {
        a: bucket,
        b: { renamedAgain: { usedPercent: 8, windowDurationMins: 300 } },
      },
    },
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].window_key, 'alternate');
  assert.equal(parsed[0].resets_at, null);
  assert.equal(parsed[0].plan_type, null);
  assert.equal(parsed[1].limit_id, 'b');
});
test('reject invalid schema and empty buckets; optional metadata stays null', () => {
  for (const value of [
    {},
    { result: {} },
    { result: { rateLimits: { primary: 3 } } },
    { result: { rateLimits: { primary: { usedPercent: 'secret' } } } },
  ])
    assert.throws(() => parseWindows(value));
  assert.equal(
    parseWindows({ result: { rateLimits: { primary: { usedPercent: 5 } } } })[0]
      .window_duration_minutes,
    null,
  );
});
test('atomic persistence, exact recent dedup, raw JSON and reset maxima', () => {
  const store = new Store(':memory:');
  try {
    const raw = { ...response(), extension: { future: true } };
    assert.equal(store.saveRaw(raw, 100), true);
    assert.equal(store.saveRaw({ ...raw, id: 99 }, 130), false);
    assert.equal(store.saveRaw(response(52), 160), true);
    assert.equal(store.saveRaw(response(18, 30000), 220), true);
    const before = [...store.observations()].length;
    assert.throws(() =>
      store.saveRaw({ result: { rateLimits: { primary: { usedPercent: 'x' } } } }),
    );
    assert.equal([...store.observations()].length, before);
    assert.deepEqual([...store.observations()][0].raw_response, raw);
    assert.deepEqual(
      summarize(store.samples(), 'UTC')
        .find((s) => s.duration === 10080)!
        .periods.map((p) => [p.resets_at, p.max_used]),
      [
        [20000, 52],
        [30000, 18],
      ],
    );
  } finally {
    store.close();
  }
});
test('consumption: baseline, corrections, rename, reset, missing observations', () => {
  const series = summarize(
    [
      sample(12, 100),
      sample(19, 400, 10000, 'renamed'),
      sample(17, 700),
      sample(19, 1000),
      sample(3, 10100, 20000),
      sample(5, 10400, 20000),
    ],
    'UTC',
  )[0];
  assert.equal(series.days[0].points, 12); // 7 + 3 after reset + 2; recovery to 19 is not new use
  assert.equal(series.days[0].uncertain, true);
  assert.equal(series.periods[0].max_used, 19);
  assert.equal(summarize([sample(null, 100), sample(9, 400)], 'UTC')[0].days[0].points, 0);
});
test('moving reset timestamp is not mistaken for spending the whole allowance again', () => {
  assert.equal(
    summarize([sample(30, 100, 10000), sample(31, 400, 10300)], 'UTC')[0].days[0].points,
    0,
  );
});
test('local days, Monday weeks, reset periods remain distinct and limits never merge', () => {
  const t = Date.parse('2026-10-04T21:59:00Z') / 1000;
  const series = summarize(
    [
      sample(10, t, t + 10000),
      sample(15, t + 120, t + 10000),
      { ...sample(80, t + 120), limit_id: 'other' },
    ],
    'Europe/Paris',
  );
  assert.equal(series.length, 2);
  assert.deepEqual(
    series[0].days.map((d) => [d.date, d.points]),
    [
      ['2026-10-04', 0],
      ['2026-10-05', 5],
    ],
  );
  assert.deepEqual(
    series[0].weeks.map((d) => d.date),
    ['2026-09-28', '2026-10-05'],
  );
});
test('notification and unrelated response before matching ID; handshake only reads limits', async () => {
  const incoming = [
    { method: 'account/updated', params: {} },
    { id: 90, result: {} },
    { id: 1, result: {} },
    { method: 'event' },
    response(),
  ];
  const sent: Record<string, unknown>[] = [];
  await handshakeAndRead({ send: (m) => sent.push(m), receive: async () => incoming.shift()! });
  assert.deepEqual(
    sent.map((m) => m.method),
    ['initialize', 'initialized', 'account/rateLimits/read'],
  );
  await assert.rejects(
    waitForResponse(
      { send() {}, receive: async () => ({ id: 1, error: { code: -1, message: 'TOKEN_SECRET' } }) },
      1,
    ),
    (e) =>
      e instanceof Error && !e.message.includes('TOKEN_SECRET') && e.message.includes('code -1'),
  );
});
function fake(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-usage-monitor-test-'));
  const path = join(dir, 'codex');
  writeFileSync(path, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test('real subprocess: normal handshake, notifications, EOF cleanup', async () => {
  const f = fake(`const rl=require('readline').createInterface({input:process.stdin});
    rl.on('line',l=>{const m=JSON.parse(l); if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));
    else if(m.method==='account/rateLimits/read'){console.log(JSON.stringify({method:'notification'}));console.log(${JSON.stringify(JSON.stringify(response()))});}
    else if(m.method!=='initialized')process.exit(7);});`);
  try {
    assert.deepEqual(await readRateLimits({ codex: f.path }), response());
  } finally {
    f.cleanup();
  }
});
test('startup failure, malformed JSON, hanging and notification-flood subprocesses', async () => {
  await assert.rejects(readRateLimits({ codex: '/does-not-exist/codex' }), /not found/);
  for (const body of [
    "console.log('malformed');",
    'setInterval(()=>{},1000);',
    "setInterval(()=>console.log(JSON.stringify({method:'event'})),1);",
  ]) {
    const f = fake(body);
    try {
      await assert.rejects(
        readRateLimits({ codex: f.path, timeoutMs: 100 }),
        /malformed|Timed out/,
      );
    } finally {
      f.cleanup();
    }
  }
});
test('five-minute default, startup delay, no overlapping work and stop aborts active collection', async () => {
  assert.equal(INTERVAL_MS, 300000);
  let active = 0,
    maxActive = 0,
    runs = 0;
  const scheduler = startScheduler({
    intervalMs: 10,
    collect: async () => {
      runs++;
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(25);
      active--;
    },
  });
  await delay(80);
  await scheduler.stop();
  assert.ok(runs >= 2);
  assert.equal(maxActive, 1);
  const stoppedRuns = runs;
  await delay(30);
  assert.equal(runs, stoppedRuns);
  let delayed = 0;
  const waiting = startScheduler({
    intervalMs: 1000,
    lastAttemptMs: Date.now(),
    collect: async () => {
      delayed++;
    },
  });
  await delay(15);
  await waiting.stop();
  assert.equal(delayed, 0);
  let aborted = false;
  const aborting = startScheduler({
    collect: (signal) =>
      new Promise((resolve) =>
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        }),
      ),
  });
  await delay(10);
  await aborting.stop();
  assert.equal(aborted, true);
});

test('SQLite WAL allows a separate reader transaction during collection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-usage-monitor-wal-'));
  const path = join(dir, 'usage.sqlite3');
  const writer = new Store(path);
  const reader = new Store(path);
  try {
    writer.saveRaw(response(10), 100);
    reader.db.exec('BEGIN');
    assert.equal(reader.latest()!.windows[1].used_percent, 10);
    writer.saveRaw(response(20), 400);
    assert.equal(reader.latest()!.windows[1].used_percent, 10); // stable read snapshot
    reader.db.exec('COMMIT');
    assert.equal(reader.latest()!.windows[1].used_percent, 20);
    assert.equal(writer.db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
  } finally {
    reader.close();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('scheduler retries after failure and collects immediately when overdue', async () => {
  let calls = 0,
    errors = 0;
  const s = startScheduler({
    intervalMs: 15,
    lastAttemptMs: Date.now() - 1000,
    collect: async () => {
      calls++;
      if (calls === 1) throw new Error('network');
    },
    onError: () => {
      errors++;
    },
  });
  await delay(60);
  await s.stop();
  assert.ok(calls >= 2);
  assert.equal(errors, 1);
});

test('old schema is refused without migration or data deletion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-usage-monitor-legacy-'));
  const path = join(dir, 'usage.sqlite3');
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE snapshots (id INTEGER PRIMARY KEY, collected_at REAL, raw_response TEXT, result_json TEXT)',
  );
  db.exec("INSERT INTO snapshots VALUES (1,100,'{}','{}')");
  db.close();
  assert.throws(() => new Store(path), /old schema/);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM snapshots').get()!.n, 1);
  check.close();
  rmSync(dir, { recursive: true, force: true });
});
test('failed collection records sanitized failure and no bogus snapshot', async () => {
  const { collect } = await import('../server/service.ts');
  const store = new Store(':memory:');
  const before = process.env.CODEX_BIN;
  process.env.CODEX_BIN = '/does-not-exist/codex';
  try {
    await assert.rejects(collect(store), /not found/);
    assert.equal(store.latest(), null);
    assert.equal(store.lastAttempt()!.succeeded, 0);
  } finally {
    if (before === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = before;
    store.close();
  }
});
