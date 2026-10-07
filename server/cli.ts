import { parseArgs } from 'node:util';
import { summarize } from './analytics.ts';
import { Store } from './database.ts';
import { CollectionError, windowLabel } from './models.ts';
import {
  enabledProviders,
  PROVIDERS,
  parseProvider,
  providerInfo,
  providerName,
  scopeFor,
} from './providers.ts';
import { collectProviders, safeError } from './service.ts';

let store: Store | undefined;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      weeks: { type: 'string', default: '12' },
      format: { type: 'string', default: 'jsonl' },
      provider: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      `Usage: collect|status|history|dump [--provider ${PROVIDERS.join('|')}|all] [--db PATH] [--weeks 12] [--format json|jsonl]`,
    );
  } else {
    const command = positionals[0];
    if (!['collect', 'status', 'history', 'dump'].includes(command))
      throw new CollectionError('Expected collect, status, history, or dump. Use --help.');
    const weeks = Number(values.weeks);
    if (!Number.isInteger(weeks) || weeks < 1)
      throw new CollectionError('--weeks must be a positive integer.');
    if (!['json', 'jsonl'].includes(values.format ?? 'jsonl'))
      throw new CollectionError('--format must be json or jsonl.');
    const providers =
      values.provider === 'all'
        ? PROVIDERS
        : values.provider
          ? [parseProvider(values.provider)]
          : enabledProviders();
    store = new Store(values.db);
    if (command === 'collect') {
      const results = await collectProviders(store, [...providers]);
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.error(`${providerName(providers[i])}: ${safeError(r.reason)}`);
          process.exitCode = 1;
        }
      });
    }
    const exported = [];
    for (const provider of providers) {
      const scope = scopeFor(provider);
      if (command === 'status') {
        console.log(`${providerName(provider)} usage (account name: ${scope.account})\n`);
        const latest = store.latest(scope);
        if (!latest) console.log('No observations yet. Run collect.');
        else {
          for (const w of latest.windows)
            console.log(
              `${w.limit_id ?? 'Default'} · ${windowLabel(w.window_duration_minutes, w.window_key)}: ${w.used_percent ?? '?'}% used; plan ${w.plan_type ?? 'unknown'}; resets ${w.resets_at ? new Date(w.resets_at * 1000).toLocaleString() : 'unknown'}`,
            );
          console.log(`Collected: ${new Date(latest.collected_at * 1000).toLocaleString()}`);
        }
        const attempt = store.lastAttempt(scope);
        if (attempt?.succeeded === 0) console.log(`Last attempt failed: ${attempt.message}`);
        if (providerInfo(provider).notice) console.log(providerInfo(provider).notice);
      }
      if (command === 'history') {
        console.log(`${providerName(provider)} (account name: ${scope.account})`);
        for (const series of summarize(store.samples(scope), 'UTC').filter(
          (s) => s.duration === 10080,
        )) {
          console.log(series.label);
          for (const p of series.periods.slice(-weeks))
            console.log(
              `${new Date(p.resets_at * 1000).toLocaleString()}  ${p.max_used}%${p.resets_at > Date.now() / 1000 ? ' current' : ''}`,
            );
        }
      }
      if (command === 'dump') {
        for (const row of store.observations(scope)) {
          if (values.format === 'json') exported.push(row);
          else console.log(JSON.stringify(row));
        }
      }
    }
    if (command === 'dump' && values.format === 'json') console.log(JSON.stringify(exported));
  }
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  store?.close();
}
