import { useEffect, useState } from 'react';
import {
  Link,
  type LoaderFunctionArgs,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from 'react-router';
import { summarize } from '../../server/analytics.ts';
import { windowLabel } from '../../server/models.ts';
import {
  PROVIDERS,
  parseProvider,
  providerInfo,
  providerName,
  scopeFor,
} from '../../server/providers.ts';
import { getCollection, getStore } from '../../server/service.ts';
import { displayTimeZone, validTimeZone } from '../../server/timezone.ts';
import { type HistoryView, historyChart, planLabel } from '../chart.ts';
import { ThemeToggle } from '../theme.tsx';
export function meta() {
  return [{ title: 'AI Usage Monitor' }];
}
export function loader({ request }: LoaderFunctionArgs) {
  const store = getStore();
  const { providers: enabled, scheduled } = getCollection();
  const parameter = new URL(request.url).searchParams.get('provider');
  if (parameter && !PROVIDERS.includes(parameter as (typeof PROVIDERS)[number]))
    throw new Response('Unknown provider', { status: 400 });
  const provider = parameter ? parseProvider(parameter) : enabled[0];
  const scope = scopeFor(provider);
  const latest = store.latest(scope);
  const timeZone = displayTimeZone(request.url, process.env.AI_USAGE_TIMEZONE);
  return {
    provider,
    account: scope.account,
    enabled,
    latest: latest && { collected_at: latest.collected_at, windows: latest.windows },
    attempt: store.lastAttempt(scope) ?? null,
    series: summarize(store.samples(scope), timeZone),
    timeZone,
    now: Date.now() / 1000,
    scheduled: scheduled && enabled.includes(provider),
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
  const [view, setView] = useState<HistoryView>('days');
  const revalidator = useRevalidator();
  const [, setSearchParams] = useSearchParams();
  const [browserZone, setBrowserZone] = useState<string | null>(null);
  useEffect(() => {
    const syncZone = () => {
      const zone = validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC';
      setBrowserZone(zone);
      if (zone !== data.timeZone) {
        setSearchParams(
          (params) => {
            params.set('tz', zone);
            return params;
          },
          { replace: true },
        );
      }
    };
    syncZone();
    window.addEventListener('focus', syncZone);
    return () => window.removeEventListener('focus', syncZone);
  }, [data.timeZone, setSearchParams]);
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
  const chart = historyChart(series, view, data.now, (reset) => stamp(reset, data.timeZone));
  const max = Math.max(1, ...chart.groups.flatMap((g) => g.bars.map((b) => b.value)));
  const plans = chart.legend.length > 0;
  const stale = !data.latest || data.now - data.latest.collected_at > 900;
  // SSR and the first client render match. Avoid flashing server-zone dates while
  // the browser supplies its zone and the loader recalculates daily boundaries.
  if (!browserZone || browserZone !== data.timeZone) {
    return (
      <main>
        <h1>AI Usage Monitor</h1>
        <p role="status">Loading your local timezone…</p>
        <noscript>Enable JavaScript to display usage in your local timezone.</noscript>
      </main>
    );
  }
  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">AI USAGE MONITOR</span>
          <h1>{providerName(data.provider)} usage</h1>
          <p>Your allowance, over time.</p>
        </div>
        <div className="header-actions">
          <span className={`badge ${stale ? 'warning' : ''}`}>
            {stale ? 'Awaiting fresh data' : providerInfo(data.provider).freshnessLabel}
          </span>
          <ThemeToggle />
        </div>
      </header>
      <nav className="tabs" aria-label="Usage provider">
        {PROVIDERS.map((provider) => (
          <Link
            className={provider === data.provider ? 'active' : ''}
            aria-current={provider === data.provider ? 'page' : undefined}
            to={`/?${new URLSearchParams({ provider, tz: data.timeZone })}`}
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
              ? 'The collector will retry automatically.'
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
          {plans && (
            <ul className="legend" aria-label="Plans">
              {chart.legend.map((p) => (
                <li key={p.label}>
                  <span className={`swatch plan-${p.colour}`} />
                  {p.label}
                </li>
              ))}
            </ul>
          )}
          <div
            className="chart"
            role="img"
            aria-label={`${series.label}: ${view === 'periods' ? 'reset-period maxima' : 'percentage points consumed'}${plans ? `, by plan (${chart.legend.map((p) => p.label).join(', ')})` : ''}. Exact values in the table below.`}
          >
            {chart.groups.map((g, i) => (
              <div className="bar-column" key={g.id}>
                <div className="bar-group">
                  {g.bars.map((b) => (
                    <div className="bar-stack" key={b.id}>
                      <span className="bar-value">{Number(b.value.toFixed(1))}</span>
                      <div
                        className={`bar plan-${b.colour}`}
                        style={{ height: `${Math.max(2, (b.value / max) * 140)}px` }}
                        title={`${g.label}${plans ? ` · ${planLabel(b.plan)}` : ''}: ${view === 'periods' ? percent(b.value) : points(b.value)}`}
                      />
                    </div>
                  ))}
                </div>
                <small>{view === 'periods' ? i + 1 : g.label.slice(5)}</small>
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
                  {plans && <th>Plan</th>}
                  <th>{view === 'periods' ? 'Max used' : 'Observed spend'}</th>
                  <th>Observations</th>
                </tr>
              </thead>
              <tbody>
                {[...chart.groups].reverse().flatMap((g) =>
                  [...g.bars].reverse().map((b) => (
                    <tr key={b.id}>
                      <td>{g.label}</td>
                      {plans && <td>{planLabel(b.plan)}</td>}
                      <td>
                        {view === 'periods' ? percent(b.value) : points(b.value)}
                        {b.uncertain ? ' *' : ''}
                      </td>
                      <td>{b.samples}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
          <p className="footnote">
            Daily and weekly spend are estimates, not billing totals. Increases are assigned to the
            later observation’s day. * marks a baseline, gap, day boundary, correction, or reset.
            Unobserved usage before a reset may be missed. Allowances are never added together, and
            neither are plans: a percentage of one plan is not comparable with another's.
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
