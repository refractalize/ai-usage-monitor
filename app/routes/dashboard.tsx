import { useEffect, useRef, useState } from 'react';
import { Link, type LoaderFunctionArgs, useLoaderData, useRevalidator } from 'react-router';
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
import {
  allowanceLabels,
  type ChartBar,
  type ChartGroup,
  DEFAULT_RANGE,
  historyChart,
  planLabel,
  RANGES,
  type RangeDays,
} from '../chart.ts';
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
  return {
    provider,
    enabled,
    latest: latest && { collected_at: latest.collected_at, windows: latest.windows },
    attempt: store.lastAttempt(scope) ?? null,
    // Reset periods are absolute times; the browser formats them in its own timezone.
    series: summarize(store.samples(scope), 'UTC'),
    now: Date.now() / 1000,
    scheduled: scheduled && enabled.includes(provider),
  };
}
const percent = (n: number) => `${Number(n.toFixed(2))}%`;
const STAMP: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
function stamp(n: number | null, zone: string, options = STAMP) {
  return n === null
    ? 'Unavailable'
    : new Intl.DateTimeFormat('en-GB', { ...options, timeZone: zone }).format(n * 1000);
}
/** Hover text naming the zone a time is shown in, and the same time in UTC. */
function zoneHint(n: number, zone: string) {
  const offset = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(n * 1000)
    .find((part) => part.type === 'timeZoneName')?.value;
  return `${zone}${offset ? ` (${offset})` : ''}\n${stamp(n, 'UTC')} UTC`;
}
function Time({
  seconds,
  zone,
  options,
}: {
  seconds: number | null;
  zone: string;
  options?: Intl.DateTimeFormatOptions;
}) {
  if (seconds === null) return 'Unavailable';
  return (
    <time dateTime={new Date(seconds * 1000).toISOString()} title={zoneHint(seconds, zone)}>
      {stamp(seconds, zone, options)}
    </time>
  );
}
export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const [selected, setSelected] = useState('');
  const [days, setDays] = useState<RangeDays>(DEFAULT_RANGE);
  const chartRef = useRef<HTMLDivElement>(null);
  const revalidator = useRevalidator();
  // The server can't know the viewer's timezone, so times render after hydration.
  // Rechecked on focus in case the device's timezone changed.
  const [timeZone, setTimeZone] = useState<string | null>(null);
  useEffect(() => {
    const syncZone = () => setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    syncZone();
    window.addEventListener('focus', syncZone);
    return () => window.removeEventListener('focus', syncZone);
  }, []);
  const zone = timeZone ?? 'UTC';
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
  const labels = allowanceLabels(data.series);
  const chart = historyChart(series, data.now, days);
  // Long ranges scroll sideways; open on the newest periods.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the chart's columns change.
  useEffect(() => {
    if (chartRef.current) chartRef.current.scrollLeft = chartRef.current.scrollWidth;
  }, [series?.id, days, chart.groups.length, timeZone]);
  // A fixed 0-100% scale keeps the limit line in place and periods comparable.
  const scale = Math.max(100, chart.peak);
  // Axis ticks show each period's start: a date, plus the time for short allowances.
  const tick: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    ...(series && series.duration !== null && series.duration < 1440
      ? { hour: '2-digit', minute: '2-digit' }
      : {}),
  };
  // About a dozen ticks; once columns hit their minimum width and the chart scrolls,
  // every 4th column keeps labels apart.
  const tickEvery = Math.min(4, Math.ceil(chart.groups.length / 12));
  const range = (g: ChartGroup, b: ChartBar, rangeZone: string) =>
    `${g.starts_at === null ? 'Unknown start' : stamp(g.starts_at, rangeZone)} – ${stamp(b.ended_at ?? g.resets_at, rangeZone)}`;
  const plans = chart.legend.length > 1;
  const stale = !data.latest || data.now - data.latest.collected_at > 900;
  // SSR and the first client render match; this avoids flashing UTC times.
  if (!timeZone) {
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
            to={`/?${new URLSearchParams({ provider })}`}
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
            {data.latest ? (
              <Time seconds={data.latest.collected_at} zone={zone} />
            ) : (
              'No observations yet'
            )}
          </p>
        </div>
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
              <dd>
                <Time seconds={w.resets_at} zone={zone} />
              </dd>
              <dt>Plan</dt>
              <dd>{w.plan_type ?? 'Unavailable'}</dd>
            </dl>
          </section>
        ))}
      </div>
      {series && (
        <section className="history">
          <span className="eyebrow">RESET PERIODS</span>
          <div className="chart-controls">
            {data.series.length > 1 && (
              <fieldset className="tabs" aria-label="Allowance" style={{ border: 0, padding: 0 }}>
                {data.series.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    aria-pressed={s.id === series.id}
                    onClick={() => setSelected(s.id)}
                  >
                    {labels.get(s.id)}
                  </button>
                ))}
              </fieldset>
            )}
            <fieldset className="segmented" aria-label="Time range">
              {RANGES.map((d) => (
                <button type="button" key={d} aria-pressed={d === days} onClick={() => setDays(d)}>
                  {d === 7 ? '1 week' : `${d} days`}
                </button>
              ))}
            </fieldset>
          </div>
          <p>
            Highest observed percentage of the {labels.get(series.id)} allowance in each reset
            period of the last {days === 7 ? 'week' : `${days} days`}.
          </p>
          <ul className="legend" aria-label="Chart key">
            {chart.legend.map((p) => (
              <li key={p.label}>
                <span className={`swatch plan-${p.colour}`} />
                {p.label} · max {percent(p.peak)}
                {p.peak >= 100 ? ', limit reached' : ''}
              </li>
            ))}
          </ul>
          <div
            className="chart"
            ref={chartRef}
            role="img"
            aria-label={`${labels.get(series.id)} allowance: highest percentage used per reset period${plans ? `, by plan` : ''}; max ${chart.legend.map((p) => `${plans ? `${p.label} ` : ''}${percent(p.peak)}`).join(', ')} of the 100% limit.`}
          >
            <div className="chart-plot" style={{ minWidth: `${chart.groups.length * 28}px` }}>
              <div className="chart-lines">
                <div className="chart-line limit" style={{ bottom: `${(100 / scale) * 100}%` }} />
              </div>
              {chart.groups.map((g) => (
                <div className="bar-group" key={g.id}>
                  {g.bars.map((b) => (
                    <div className="bar-stack" key={b.id}>
                      <span className="bar-value">{Number(b.value.toFixed(1))}</span>
                      <div
                        className={`bar plan-${b.colour}`}
                        style={{ height: `${Math.max(1, (b.value / scale) * 100)}%` }}
                        title={`${range(g, b, zone)}${plans ? ` · ${planLabel(b.plan)}` : ''}: ${percent(b.value)}\n${range(g, b, 'UTC')} UTC`}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="chart-axis" style={{ minWidth: `${chart.groups.length * 28}px` }}>
              {chart.groups.map((g, i) => (
                // Label about a dozen ticks, counted back from the newest period.
                <small key={g.id}>
                  {(chart.groups.length - 1 - i) % tickEvery === 0 ? (
                    g.current ? (
                      'Now'
                    ) : (
                      <Time seconds={g.starts_at ?? g.resets_at} zone={zone} options={tick} />
                    )
                  ) : (
                    ''
                  )}
                </small>
              ))}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
