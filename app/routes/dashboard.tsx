import { useEffect, useState } from 'react';
import { Link, type LoaderFunctionArgs, useLoaderData, useRevalidator } from 'react-router';
import { summarize } from '../../server/analytics.ts';
import { windowLabel } from '../../server/models.ts';
import {
  enabledProviders,
  PROVIDERS,
  parseProvider,
  providerInfo,
  providerName,
  scopeFor,
} from '../../server/providers.ts';
import { getStore } from '../../server/service.ts';
export function meta() {
  return [{ title: 'AI Usage Monitor' }];
}
export function loader({ request }: LoaderFunctionArgs) {
  const store = getStore();
  const enabled = enabledProviders();
  const parameter = new URL(request.url).searchParams.get('provider');
  if (parameter && !PROVIDERS.includes(parameter as (typeof PROVIDERS)[number]))
    throw new Response('Unknown provider', { status: 400 });
  const provider = parameter ? parseProvider(parameter) : enabled[0];
  const scope = scopeFor(provider);
  const latest = store.latest(scope);
  const timeZone =
    process.env.AI_USAGE_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    provider,
    account: scope.account,
    enabled,
    latest: latest && { collected_at: latest.collected_at, windows: latest.windows },
    attempt: store.lastAttempt(scope) ?? null,
    series: summarize(store.samples(scope), timeZone),
    timeZone,
    now: Date.now() / 1000,
    scheduled: process.env.AI_USAGE_SCHEDULE !== 'off' && enabled.includes(provider),
  };
}
const percent = (n: number) => `${Number(n.toFixed(2))}%`;
const points = (n: number) => `${Number(n.toFixed(2))} pp`;
function stamp(n: number | null, zone: string) {
  return n === null
    ? 'Unavailable'
    : new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(n * 1000);
}
export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const [selected, setSelected] = useState('');
  const [view, setView] = useState<'days' | 'weeks' | 'periods'>('days');
  const revalidator = useRevalidator();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void revalidator.revalidate();
    }, 60_000);
    return () => clearInterval(timer);
  }, [revalidator.revalidate]);
  const series =
    data.series.find((s) => s.id === selected) ??
    data.series.find((s) => s.duration === 10080) ??
    data.series[0];
  const chart = series
    ? view === 'periods'
      ? series.periods.slice(-12).map((p) => ({
          label: stamp(p.resets_at, data.timeZone) + (p.resets_at > data.now ? ' · current' : ''),
          value: p.max_used,
          uncertain: false,
          samples: p.samples,
        }))
      : series[view].slice(view === 'days' ? -30 : -12).map((d) => ({
          label: d.date,
          value: d.points,
          uncertain: d.uncertain,
          samples: d.samples,
        }))
    : [];
  const max = Math.max(1, ...chart.map((d) => d.value));
  const stale = !data.latest || data.now - data.latest.collected_at > 900;
  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">AI USAGE MONITOR</span>
          <h1>{providerName(data.provider)} usage</h1>
          <p>Your allowance, over time.</p>
        </div>
        <span className={`badge ${stale ? 'warning' : ''}`}>
          {stale ? 'Awaiting fresh data' : providerInfo(data.provider).freshnessLabel}
        </span>
      </header>
      <nav className="tabs" aria-label="Usage provider">
        {PROVIDERS.map((provider) => (
          <Link
            className={provider === data.provider ? 'active' : ''}
            aria-current={provider === data.provider ? 'page' : undefined}
            to={`/?provider=${provider}`}
            key={provider}
          >
            {providerName(provider)}
            {!data.enabled.includes(provider) ? ' · disabled' : ''}
          </Link>
        ))}
      </nav>
      {providerInfo(data.provider).notice && (
        <p className="notice">{providerInfo(data.provider).notice}</p>
      )}
      <section className="collection">
        <div>
          <strong>
            {data.scheduled ? 'Collecting every 5 minutes' : 'Automatic collection paused'}
          </strong>
          <p>
            Last observation:{' '}
            {data.latest ? stamp(data.latest.collected_at, data.timeZone) : 'No observations yet'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void revalidator.revalidate()}
          disabled={revalidator.state !== 'idle'}
        >
          Refresh view
        </button>
      </section>
      {data.attempt?.succeeded === 0 && (
        <p role="status" className="notice">
          Latest collection failed: {data.attempt.message} Stored history is still available.
        </p>
      )}
      {!data.latest && (
        <section className="empty">
          <h2>Ready for your first observation</h2>
          <p>
            Authenticate {providerName(data.provider)} using its normal login flow.{' '}
            {data.scheduled
              ? 'The collector will try again on its next five-minute run.'
              : 'Enable this provider in USAGE_PROVIDERS to start scheduled collection.'}
          </p>
        </section>
      )}
      <div className="cards">
        {data.latest?.windows.map((w) => (
          <section className="card" key={JSON.stringify([w.limit_id, w.window_key])}>
            <span className="eyebrow">{w.limit_id ?? 'Default allowance'}</span>
            <h2>{windowLabel(w.window_duration_minutes, w.window_key)}</h2>
            <div className="metric">
              {w.used_percent === null ? '—' : percent(w.used_percent)} <span>used</span>
            </div>
            {w.used_percent !== null && (
              <>
                <progress
                  max={100}
                  value={Math.min(100, w.used_percent)}
                  aria-label={`${windowLabel(w.window_duration_minutes)} used`}
                />
                <p>{percent(Math.max(0, 100 - w.used_percent))} remaining</p>
              </>
            )}
            <dl>
              <dt>Resets</dt>
              <dd>{stamp(w.resets_at, data.timeZone)}</dd>
              <dt>Plan</dt>
              <dd>{w.plan_type ?? 'Unavailable'}</dd>
            </dl>
          </section>
        ))}
      </div>
      {series && (
        <section className="history">
          <div className="section-title">
            <div>
              <span className="eyebrow">OBSERVED CONSUMPTION</span>
              <h2>Where your allowance goes</h2>
            </div>
            <label>
              Allowance
              <select value={series.id} onChange={(e) => setSelected(e.target.value)}>
                {data.series.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset
            className="tabs"
            aria-label="History grouping"
            style={{ border: 0, padding: 0 }}
          >
            {(['days', 'weeks', 'periods'] as const).map((v) => (
              <button type="button" key={v} aria-pressed={view === v} onClick={() => setView(v)}>
                {v === 'days' ? 'Daily spend' : v === 'weeks' ? 'Weekly spend' : 'By reset'}
              </button>
            ))}
          </fieldset>
          <p>
            {view === 'periods'
              ? 'Maximum observed percentage used in each quota period.'
              : `Observed percentage points consumed, grouped by ${view === 'days' ? 'day' : 'week starting Monday'}.`}
          </p>
          <div
            className="chart"
            role="img"
            aria-label={`${series.label}: ${view === 'periods' ? 'reset-period maxima' : 'percentage points consumed'}. Exact values in the table below.`}
          >
            {chart.map((d, i) => (
              <div className="bar-column" key={d.label}>
                <span className="bar-value">{Number(d.value.toFixed(1))}</span>
                <div
                  className="bar"
                  style={{ height: `${Math.max(2, (d.value / max) * 140)}px` }}
                  title={`${d.label}: ${view === 'periods' ? percent(d.value) : points(d.value)}`}
                />
                <small>{view === 'periods' ? i + 1 : d.label.slice(5)}</small>
              </div>
            ))}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>
                    {view === 'periods' ? 'Reset time' : view === 'days' ? 'Day' : 'Week starting'}
                  </th>
                  <th>{view === 'periods' ? 'Max used' : 'Observed spend'}</th>
                  <th>Observations</th>
                </tr>
              </thead>
              <tbody>
                {[...chart].reverse().map((d) => (
                  <tr key={d.label}>
                    <td>{d.label}</td>
                    <td>
                      {view === 'periods' ? percent(d.value) : points(d.value)}
                      {d.uncertain ? ' *' : ''}
                    </td>
                    <td>{d.samples}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="footnote">
            Daily and weekly spend are estimates, not billing totals. Increases are assigned to the
            later observation’s day. * marks a baseline, gap, day boundary, correction, or reset.
            Unobserved usage before a reset may be missed. Allowances are never added together.
          </p>
        </section>
      )}
      <footer>
        Account name: {data.account}. Times and day boundaries: {data.timeZone}. Quota status only ·
        No model requests · No token or dollar tracking
      </footer>
    </main>
  );
}
