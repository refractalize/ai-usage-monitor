import assert from 'node:assert/strict';
import test from 'node:test';
import { adapters, type ProviderAdapter } from '../server/adapters.ts';
import { Store } from '../server/database.ts';
import { CollectionError, type JsonObject } from '../server/models.ts';
import { PROVIDERS, parseProvider, providerInfo } from '../server/providers.ts';
import { collect } from '../server/service.ts';

test('every registered provider has an adapter and display metadata', () => {
  assert.deepEqual(Object.keys(adapters).sort(), [...PROVIDERS].sort());
  for (const provider of PROVIDERS) {
    assert.equal(parseProvider(provider), provider);
    assert.ok(providerInfo(provider).name);
    assert.equal(typeof adapters[provider].read, 'function');
  }
  assert.throws(() => parseProvider('toString'), /Provider must/);
});

test('generic collection uses an injected adapter, forwards cancellation, and stores its normalized snapshot', async () => {
  const store = new Store(':memory:');
  const signal = new AbortController().signal;
  const scope = { provider: 'codex' as const, account: 'synthetic' };
  // Deliberately unlike either bundled provider's schema.
  const raw: JsonObject = { allowance: 42, request: 'synthetic-request' };
  let normalized = 0;
  const adapter: ProviderAdapter = {
    async read(options) {
      assert.equal(options.signal, signal);
      return raw;
    },
    normalize(response) {
      assert.equal(response, raw);
      normalized++;
      return {
        raw_response: response,
        deduplication_value: { allowance: response.allowance },
        windows: [
          {
            limit_id: 'example',
            window_key: 'renamed',
            window_duration_minutes: 10080,
            used_percent: 42,
            resets_at: 20000,
            plan_type: null,
          },
        ],
      };
    },
  };
  try {
    await collect(store, signal, scope, adapter);
    assert.equal(normalized, 1);
    assert.deepEqual(store.latest(scope)?.raw_response, raw);
    assert.equal(store.latest(scope)?.windows[0].used_percent, 42);
    assert.equal(store.latest(), null);
    await collect(store, signal, scope, adapter);
    assert.equal([...store.observations(scope)].length, 1);
    assert.equal(store.lastAttempt(scope)?.succeeded, 1);
  } finally {
    store.close();
  }
});

test('normalization failures create a sanitized attempt without inserting a snapshot', async () => {
  const store = new Store(':memory:');
  const adapter: ProviderAdapter = {
    async read() {
      return {};
    },
    normalize() {
      throw new CollectionError('Invalid example quota response.');
    },
  };
  try {
    await assert.rejects(collect(store, undefined, undefined, adapter), /Invalid example quota/);
    assert.equal(store.latest(), null);
    assert.equal(store.lastAttempt()?.succeeded, 0);
  } finally {
    store.close();
  }
});

test('Claude session metadata does not defeat deduplication but changed quota metadata does', () => {
  const store = new Store(':memory:');
  const scope = { provider: 'claude' as const, account: 'default' };
  const raw = (sessionTime: number, used: number) => ({
    type: 'control_response',
    response: {
      subtype: 'success',
      response: {
        subscription_type: 'example',
        rate_limits_available: true,
        rate_limits: { seven_day: { utilization: used, resets_at: null } },
        session: { total_duration_ms: sessionTime },
      },
    },
  });
  try {
    assert.equal(store.save(adapters.claude.normalize(raw(1, 10)), 100, scope), true);
    assert.equal(store.save(adapters.claude.normalize(raw(2, 10)), 130, scope), false);
    assert.equal(store.save(adapters.claude.normalize(raw(3, 11)), 140, scope), true);
  } finally {
    store.close();
  }
});
