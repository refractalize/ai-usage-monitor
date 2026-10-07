import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { summarize } from '../server/analytics.ts';
import type { JsonObject } from '../server/models.ts';
import { parseClaudeWindows } from '../server/providers/claude/models.ts';
import {
  initializeAndReadClaude,
  readClaudeUsage,
  waitForControlResponse,
} from '../server/providers/claude/transport.ts';
import { enabledProviders, type Scope } from '../server/providers.ts';
import { collectProviders } from '../server/service.ts';
import { FixtureStore as Store } from './helpers.ts';

const scope: Scope = { provider: 'claude', account: 'default' };
function response(
  limits: JsonObject = {
    five_hour: { utilization: 12, resets_at: '2026-10-06T15:00:00Z' },
    seven_day: { utilization: 37, resets_at: '2026-10-12T09:00:00+02:00' },
  },
) {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'usage',
      response: {
        subscription_type: 'pro',
        rate_limits_available: true,
        rate_limits: limits,
        session: { total_api_duration_ms: 0, model_usage: {} },
        behaviors: null,
      },
    },
  };
}
test('Claude maps known durations, ISO timezone offsets, subscription and percentages', () => {
  const windows = parseClaudeWindows(response());
  assert.deepEqual(
    windows.map((w) => [w.limit_id, w.window_duration_minutes, w.used_percent]),
    [
      ['five_hour', 300, 12],
      ['seven_day', 10080, 37],
    ],
  );
  assert.equal(windows[1].resets_at, Date.parse('2026-10-12T07:00:00Z') / 1000);
  assert.equal(windows[0].plan_type, 'pro');
});
test('Claude preserves unknown windows without guessing duration; missing optional fields are null', () => {
  const r = response({
    seven_day: {},
    future_bucket: { utilization: 5, resets_at: null },
    seven_day_sonnet: null,
  });
  const windows = parseClaudeWindows(r);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].used_percent, null);
  assert.equal(windows[0].resets_at, null);
  assert.equal(windows[1].window_duration_minutes, null);
});
test('Claude model allowances stay separate; raw limits and extra dollar usage are not double-counted', () => {
  const windows = parseClaudeWindows(
    response({
      seven_day: { utilization: 20 },
      seven_day_opus: { utilization: 60 },
      model_scoped: [{ display_name: 'Example model', utilization: 75, resets_at: null }],
      limits: [{ utilization: 75 }],
      extra_usage: { utilization: 10 },
      spend: { utilization: 50, resets_at: null },
    }),
  );
  assert.equal(windows.length, 3);
  assert.equal(new Set(windows.map((w) => w.limit_id)).size, 3);
  assert.equal(windows[2].limit_id, 'model:Example model');
  const store = new Store(':memory:');
  try {
    store.saveRaw(
      response({
        seven_day: { utilization: 20, resets_at: '2026-10-12T00:00:00Z' },
        seven_day_opus: { utilization: 60, resets_at: '2026-10-12T00:00:00Z' },
      }),
      100,
      scope,
    );
    const series = summarize(store.samples(scope), 'UTC');
    assert.equal(series.length, 2);
    assert.deepEqual(
      series.map((s) => s.periods[0].max_used),
      [20, 60],
    );
  } finally {
    store.close();
  }
});
test('Claude rejects unavailable quotas and invalid payloads without logging response contents', () => {
  const unavailable = response();
  unavailable.response.response.rate_limits_available = false;
  assert.throws(() => parseClaudeWindows(unavailable), /unavailable/);
  for (const limits of [
    {},
    { five_hour: 8 },
    { five_hour: { utilization: 'SECRET' } },
    { seven_day: { utilization: -1 } },
    { seven_day: { utilization: 101 } },
    { seven_day: { utilization: 5, resets_at: '2026-10-12' } },
    { model_scoped: [{ display_name: 'same' }, { display_name: 'same' }] },
  ])
    assert.throws(
      () => parseClaudeWindows(response(limits)),
      (e) => e instanceof Error && !e.message.includes('SECRET'),
    );
});
test('provider and account scope isolates latest, deduplication, attempts, exports, and analytics', () => {
  const store = new Store(':memory:');
  const other = { ...scope, account: 'work' };
  const codex = { provider: 'codex' as const, account: 'default' };
  try {
    const raw = response();
    assert.equal(store.saveRaw(raw, 100, scope), true);
    assert.equal(store.saveRaw(raw, 100, other), true);
    assert.equal(store.saveRaw(raw, 130, scope), false);
    assert.equal(
      store.saveRaw(
        {
          result: {
            rateLimits: {
              limitId: 'seven_day',
              secondary: {
                windowDurationMins: 10080,
                usedPercent: 90,
                resetsAt: Date.parse('2026-10-12T07:00:00Z') / 1000,
              },
            },
          },
        },
        100,
        codex,
      ),
      true,
    );
    store.attempt(100, true, 'saved', scope);
    store.attempt(101, false, 'failed', codex);
    assert.equal(store.lastAttempt(scope)!.succeeded, 1);
    assert.equal(store.lastAttempt(codex)!.succeeded, 0);
    assert.equal(store.lastAttempt(other), undefined);
    assert.equal(store.latest(scope)!.provider, 'claude');
    assert.equal(store.latest(other)!.account, 'work');
    assert.equal([...store.observations(scope)].length, 1);
    assert.deepEqual(store.latest(scope)!.raw_response, raw);
    const merged = summarize(
      [...store.samples(scope), ...store.samples(other), ...store.samples(codex)],
      'UTC',
    );
    assert.equal(merged.length, 5);
    const count = [...store.observations(scope)].length;
    assert.throws(() => store.saveRaw(response({}), 300, scope));
    assert.equal([...store.observations(scope)].length, count);
  } finally {
    store.close();
  }
});
test('Claude control exchange only initializes and reads, ignoring other events and IDs', async () => {
  const messages = [
    { type: 'system' },
    { type: 'control_response', response: { request_id: 'other' } },
    {
      type: 'control_response',
      response: { request_id: 'init', subtype: 'success', response: {} },
    },
    response(),
  ];
  const sent: JsonObject[] = [];
  await initializeAndReadClaude({
    send: (m) => sent.push(m),
    receive: async () => messages.shift()!,
  });
  assert.deepEqual(sent, [
    {
      type: 'control_request',
      request_id: 'init',
      request: { subtype: 'initialize', hooks: {}, sdkMcpServers: [], promptSuggestions: false },
    },
    {
      type: 'control_request',
      request_id: 'usage',
      request: { subtype: 'get_usage', skip_behaviors: true },
    },
  ]);
  await assert.rejects(
    waitForControlResponse(
      {
        send() {},
        receive: async () => ({
          type: 'control_response',
          response: {
            request_id: 'usage',
            subtype: 'error',
            error: 'secret access token',
          },
        }),
      },
      'usage',
    ),
    (e) => e instanceof Error && !e.message.includes('secret'),
  );
});
function fake(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-test-'));
  const path = join(dir, 'claude');
  writeFileSync(path, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function successfulFake(log?: string) {
  return fake(`const fs=require('fs');const rl=require('readline').createInterface({input:process.stdin});
    ${log ? `fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));` : ''}
    rl.on('line',line=>{const m=JSON.parse(line);
      if(m.type!=='control_request'||!['initialize','get_usage'].includes(m.request.subtype))process.exit(12);
      if(m.request.subtype==='get_usage'&&m.request.skip_behaviors!==true)process.exit(13);
      console.log(JSON.stringify({type:'system',payload:'ignored'}));
      console.log(JSON.stringify(m.request.subtype==='initialize'?{type:'control_response',response:{request_id:m.request_id,subtype:'success',response:{}}}:${JSON.stringify(response())}));
    });`);
}
test('Claude subprocess uses isolated working directory, no tools/hooks/session persistence, and closes cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-args-'));
  const log = join(dir, 'args.json');
  const f = successfulFake(log);
  try {
    assert.deepEqual(await readClaudeUsage({ claude: f.path }), response());
    const { args, cwd } = JSON.parse(readFileSync(log, 'utf8'));
    for (const flag of [
      '--no-session-persistence',
      '--strict-mcp-config',
      '--tools',
      '--setting-sources',
    ])
      assert.ok(args.includes(flag));
    assert.ok(args.includes('{"disableAllHooks":true}'));
    assert.equal(existsSync(cwd), false);
  } finally {
    f.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('Claude missing executable, malformed output, EOF and timeout fail clearly; abort stops hangs', async () => {
  await assert.rejects(readClaudeUsage({ claude: '/not-installed/claude' }), /not found/);
  for (const body of [
    "console.log('bad json');",
    'process.exit(1);',
    'setInterval(()=>{},1000);',
    "setInterval(()=>console.log(JSON.stringify({type:'system'})),1);",
  ]) {
    const f = fake(body);
    try {
      await assert.rejects(
        readClaudeUsage({ claude: f.path, timeoutMs: 100 }),
        /malformed|closed stdout|Timed out/,
      );
    } finally {
      f.cleanup();
    }
  }
  const f = fake('setInterval(()=>{},1000)');
  const abort = new AbortController();
  try {
    const promise = readClaudeUsage({ claude: f.path, signal: abort.signal });
    const assertion = assert.rejects(promise, /cancelled/);
    await delay(30);
    abort.abort();
    await assertion;
  } finally {
    f.cleanup();
  }
});
test('a failing Codex collector does not prevent Claude from saving', async () => {
  const f = successfulFake();
  const store = new Store(':memory:');
  const oldCodex = process.env.CODEX_BIN,
    oldClaude = process.env.CLAUDE_BIN;
  process.env.CODEX_BIN = '/not-installed/codex';
  process.env.CLAUDE_BIN = f.path;
  try {
    const outcomes = await collectProviders(store, ['codex', 'claude']);
    assert.deepEqual(
      outcomes.map((o) => o.status),
      ['rejected', 'fulfilled'],
    );
    assert.equal(store.latest(), null);
    assert.ok(store.latest(scope));
    assert.equal(store.lastAttempt()!.succeeded, 0);
    assert.equal(store.lastAttempt(scope)!.succeeded, 1);
  } finally {
    if (oldCodex === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = oldCodex;
    if (oldClaude === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = oldClaude;
    store.close();
    f.cleanup();
  }
});
test('Claude is opt-in and enabled-provider configuration is validated', () => {
  const old = process.env.USAGE_PROVIDERS;
  try {
    delete process.env.USAGE_PROVIDERS;
    assert.deepEqual(enabledProviders(), ['codex']);
    process.env.USAGE_PROVIDERS = 'codex,claude,codex';
    assert.deepEqual(enabledProviders(), ['codex', 'claude']);
    process.env.USAGE_PROVIDERS = 'wrong';
    assert.throws(enabledProviders, /Provider must/);
  } finally {
    if (old === undefined) delete process.env.USAGE_PROVIDERS;
    else process.env.USAGE_PROVIDERS = old;
  }
});
