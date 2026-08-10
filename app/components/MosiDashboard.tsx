"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { buildConsensus, fitDatedForecast, percentagesToTenths, timePosition } from "../lib/marketMath";

type Screen = "fed" | "models";
type Venue = "CME" | "Polymarket" | "Kalshi" | "Pascal";

type MarketQuote = {
  venue: "Polymarket" | "Kalshi" | "Pascal";
  title: string;
  probability: number;
  volume: number | null;
  volumeLabel: string;
  url: string;
  deadline: string | null;
  quoteKind: string;
  symbol?: string;
};

type Outcome = { label: string; probability: number; quote: MarketQuote };
type Decision = { label: string; meetingDate: string | null; venues: Array<{ venue: MarketQuote["venue"]; outcomes: Outcome[] }> };
type InflationPoint = { period: string; value: number };
type InflationMetric = { label: string; value: number; priorValue: number; delta: number; period: string; seriesId: string; source: string; sourceUrl: string; nextEstimate: number | null; nextEstimatePeriod: string | null; nextEstimateSource: string | null; history: InflationPoint[] };
type VenueStatus = { venue: Venue; status: "live" | "unavailable" | "no_active_market" | "credential_required"; sourceUrl: string; note?: string };
type Release = { label: string; releaseAt: string; source: string; sourceUrl: string };
type Forecast = { company: string; model: string; color: string; source: string; sourceUrl: string; status: string; points: MarketQuote[] };
type FedData = {
  effectiveRate: { value: number | null; period: string; source: string; sourceUrl: string } | null;
  inflation: InflationMetric[];
  decisions: Decision[];
  venues: VenueStatus[];
  releases: Release[];
};
type AiData = { forecasts: Forecast[]; evidence: MarketQuote[] };
type FeedStatus = "live" | "partial" | "stale";
type FeedSource = { source: string; status: "live" | "stale" | "unavailable"; fetchedAt: string | null; note?: string };
type FeedEnvelope<T> = { generatedAt: string; status: FeedStatus; sources: FeedSource[]; data: T };

const outcomeOrder = ["Cut 50+ bp", "Cut 25 bp", "No change", "Hike 25 bp", "Hike 50+ bp"];

function fmtTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function fmtDate(value: string | null, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", options ?? { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value));
}

function pct(value: number) {
  return `${value < 1 && value > 0 ? value.toFixed(1) : value.toFixed(0)}%`;
}

export function MosiDashboard({ screen }: { screen: Screen }) {
  const [feed, setFeed] = useState<FeedEnvelope<FedData | AiData> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadFeed = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const path = screen === "fed" ? "/api/fed" : "/api/ai";
      const response = await fetch(force ? `${path}?refresh=${Date.now()}` : path, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Data endpoint returned ${response.status}`);
      setFeed(await response.json() as FeedEnvelope<FedData | AiData>);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Live data unavailable");
    } finally {
      setLoading(false);
    }
  }, [screen]);

  useEffect(() => {
    let active = true;
    const path = screen === "fed" ? "/api/fed" : "/api/ai";
    fetch(path, { headers: { accept: "application/json" } })
      .then((response) => {
        if (!response.ok) throw new Error(`Data endpoint returned ${response.status}`);
        return response.json() as Promise<FeedEnvelope<FedData | AiData>>;
      })
      .then((payload) => { if (active) { setFeed(payload); setError(null); } })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Live data unavailable"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [screen]);

  const visibleStatus = loading ? "syncing" : error ? feed ? "stale" : "retry" : feed?.status ?? "syncing";
  const statusTitle = feed ? `${feed.status.toUpperCase()} data · updated ${fmtTime(feed.generatedAt)} · ${feed.sources.map((source) => `${source.source}: ${source.status}`).join(", ")}. Click to refresh.` : "Refresh data";
  const fedData = screen === "fed" ? feed?.data as FedData | undefined : undefined;
  const aiData = screen === "models" ? feed?.data as AiData | undefined : undefined;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Monitoring the Situation home"><span className="brand-wordmark"><span><b>Mo</b>nitoring</span><small>-the-</small><span><b>Si</b>tuation</span></span></a>
        <nav className="primary-nav" aria-label="Primary navigation">
          <a className={screen === "fed" ? "active" : ""} href="/">The Fed</a>
          <a className={screen === "models" ? "active" : ""} href="/ai-models">AI Models</a>
        </nav>
        <button className="status-pill" type="button" onClick={() => void loadFeed(true)} title={statusTitle} aria-label={`${visibleStatus} data. Refresh`}>
          <span className={`pulse ${visibleStatus === "syncing" || visibleStatus === "partial" ? "amber" : visibleStatus === "stale" || visibleStatus === "retry" ? "red" : ""}`} />{visibleStatus}
        </button>
      </header>

      <main className={screen === "fed" ? "fed-main" : "models-main"}>
        <section className="hero-row">
          <div>
            <p className="eyebrow">{screen === "fed" ? "MONETARY POLICY" : "FRONTIER MODEL RELEASES"}</p>
            <h1>{screen === "fed" ? "Where rates go next." : "When the next models land."}</h1>
            <p className="dek">{screen === "fed" ? "Live meeting-outcome probabilities from public prediction markets, alongside the inflation data policymakers are reacting to." : "Dated prediction-market contracts on one calendar. Every point is a quoted probability—not a generated estimate."}</p>
          </div>
        </section>

        {error && !feed ? <EmptyState title="Live data is unavailable" detail={`${error}. No cached or synthetic values are being shown.`} /> : screen === "fed" ? <FedScreen data={fedData ?? null} loading={loading} /> : <ModelsScreen data={aiData ?? null} generatedAt={feed?.generatedAt ?? null} loading={loading} />}
      </main>
      <footer><span>MOSI / bkchou</span><span>Market prices are forecasts, not facts. Sources link to the underlying observation or contract.</span></footer>
    </div>
  );
}

function FedScreen({ data, loading }: { data: FedData | null; loading: boolean }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const decision = data?.decisions[selectedIndex] ?? data?.decisions[0] ?? null;
  const { eligibleVenues: independentVenues, outcomes: consensus } = useMemo(() => buildConsensus(decision?.venues ?? [], outcomeOrder), [decision]);
  const displayedConsensus = useMemo(() => {
    const displayMeans = percentagesToTenths(consensus.map((outcome) => outcome.mean));
    return consensus.map((outcome, index) => ({ ...outcome, displayMean: displayMeans[index] }));
  }, [consensus]);
  const topOutcome = consensus.reduce<(typeof consensus)[number] | null>((best, item) => item.mean != null && (!best || best.mean == null || item.mean > best.mean) ? item : best, null);
  const independentVenueCount = independentVenues.length;

  return (
    <>
      <section className="signal-strip" aria-label="Current monetary policy summary">
        <div><span>Effective fed funds rate</span><strong>{data?.effectiveRate?.value == null ? "—" : `${data.effectiveRate.value.toFixed(2)}%`}</strong><small>{data?.effectiveRate ? `NY FED · ${data.effectiveRate.period}` : "Source unavailable"}</small></div>
        <div><span>Next tracked decision</span><strong>{decision ? fmtDate(decision.meetingDate, { month: "short", day: "numeric", timeZone: "UTC" }) : "—"}</strong><small>{decision?.label ?? "No active decision market"}</small></div>
        <div><span>Top consensus outcome</span><strong className="accent">{topOutcome?.label ?? "—"}</strong><small>{topOutcome?.mean == null ? "No quote" : `${pct(topOutcome.mean)} equal-weight mean`}</small></div>
        <div><span>Independent sources</span><strong>{decision ? independentVenueCount : "—"}</strong><small>{decision ? independentVenueCount ? independentVenues.map((venue) => venue.venue).join(" + ") : "No complete venue" : "Checking sources"}</small></div>
      </section>

      <section className="dashboard-grid fed-one-screen-grid">
        <article className="panel path-panel">
          <PanelHeading kicker="MEETING OUTCOMES" title="Consensus probability graph" aside="Venue midpoints normalized to 100%" />
          {data?.decisions.length ? <>
            <div className="decision-tabs" role="tablist" aria-label="Fed meeting">
              {data.decisions.map((item, index) => <button key={item.label} type="button" className={index === selectedIndex ? "active" : ""} onClick={() => setSelectedIndex(index)}>{item.label}<small>{fmtDate(item.meetingDate, { month: "short", day: "numeric", timeZone: "UTC" })}</small></button>)}
            </div>
            <ConsensusGraph outcomes={displayedConsensus} />
          </> : <EmptyState title={loading ? "Syncing decision markets…" : "No active Fed decision contracts found"} detail="No substitute probabilities are shown." compact />}
          <div className="source-ribbon"><span><i className={independentVenueCount ? "live-dot" : "muted-dot"} /> {independentVenueCount ? `${independentVenues.map((venue) => venue.venue).join(" + ")} eligible` : "No complete independent venue"}</span><span>Each eligible venue normalized before averaging</span><span>Pascal mirror · CME licensed</span></div>
        </article>

        <article className="panel inflation-compact-panel">
          <PanelHeading kicker="LAGGING INDICATORS" title="Inflation history + gauges" aside="36-month window · year over year" />
          {!!data?.inflation.length && <InflationHistory metrics={data.inflation} />}
          <div className="inflation-compact-grid">
            {(data?.inflation ?? []).map((metric) => <InflationCard metric={metric} key={metric.seriesId} />)}
          </div>
          {!data?.inflation.length && <EmptyState title={loading ? "Syncing inflation…" : "Inflation observations unavailable"} detail="No substitute values are shown." compact />}
        </article>
      </section>

      {!!data?.releases.length && <section className="release-tape" aria-label="Upcoming inflation releases">
        <div><span>NEXT RELEASES</span><strong>Official agency calendar</strong></div>
        {data.releases.map((release) => <a href={release.sourceUrl} target="_blank" rel="noreferrer" key={release.label}><span>{release.label}</span><strong>{fmtDate(release.releaseAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" })}</strong><small>{release.source}</small></a>)}
      </section>}
    </>
  );
}

const inflationGraphColors: Record<string, string> = {
  CPIAUCNS: "#f16645",
  CPILFENS: "#a9472f",
  PCEPI: "#497ad8",
  PCEPILFE: "#7553a6",
  PCETRIM12M159SFRBDAL: "#0c9b65",
};

function InflationHistory({ metrics }: { metrics: InflationMetric[] }) {
  const series = metrics.filter((metric) => inflationGraphColors[metric.seriesId] && metric.history.length > 1);
  const points = series.flatMap((metric) => metric.history.map((point) => ({ ...point, timestamp: new Date(`${point.period}T00:00:00Z`).getTime() })));
  if (!points.length) return null;
  const start = Math.min(...points.map((point) => point.timestamp));
  const end = Math.max(...points.map((point) => point.timestamp));
  const values = points.map((point) => point.value);
  const yMin = Math.min(0, Math.floor(Math.min(...values)));
  const yMax = Math.max(yMin + 1, Math.ceil(Math.max(...values)));
  const plot = { left: 42, right: 612, top: 12, bottom: 142 };
  const x = (timestamp: number) => plot.left + ((timestamp - start) / Math.max(1, end - start)) * (plot.right - plot.left);
  const y = (value: number) => plot.bottom - ((value - yMin) / (yMax - yMin)) * (plot.bottom - plot.top);
  const ticks = Array.from({ length: yMax - yMin + 1 }, (_, index) => yMin + index).filter((_, index, all) => all.length <= 6 || index % 2 === 0);
  const monthTicks: number[] = [];
  const cursor = new Date(start); cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1); cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= end) { if (cursor.getUTCMonth() === 0 || cursor.getUTCMonth() === 6) monthTicks.push(cursor.getTime()); cursor.setUTCMonth(cursor.getUTCMonth() + 1); }
  return <div className="inflation-history">
    <svg viewBox="0 0 624 166" role="img" aria-label="Historical year-over-year inflation rates over the last 36 months">
      {ticks.map((tick) => <g className="inflation-y-tick" key={tick}><line x1={plot.left} x2={plot.right} y1={y(tick)} y2={y(tick)} /><text x={plot.left - 8} y={y(tick) + 3}>{tick}%</text></g>)}
      {monthTicks.map((tick) => <g className="inflation-x-tick" key={tick}><line x1={x(tick)} x2={x(tick)} y1={plot.top} y2={plot.bottom} /><text x={x(tick)} y="158">{fmtDate(new Date(tick).toISOString(), { month: "short", year: new Date(tick).getUTCMonth() === 0 ? "2-digit" : undefined, timeZone: "UTC" }).toUpperCase()}</text></g>)}
      {series.map((metric) => {
        const path = metric.history.map((point, index) => `${index ? "L" : "M"}${x(new Date(`${point.period}T00:00:00Z`).getTime()).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
        const latest = metric.history.at(-1)!;
        return <g className="inflation-series" style={{ color: inflationGraphColors[metric.seriesId] }} key={metric.seriesId}>
          <path d={path} />
          {metric.history.map((point) => <circle cx={x(new Date(`${point.period}T00:00:00Z`).getTime())} cy={y(point.value)} r="5" key={point.period}><title>{metric.label} · {fmtDate(`${point.period}T00:00:00Z`, { month: "long", year: "numeric", timeZone: "UTC" })}: {point.value.toFixed(2)}%</title></circle>)}
          <circle className="latest-point" cx={x(new Date(`${latest.period}T00:00:00Z`).getTime())} cy={y(latest.value)} r="3" />
        </g>;
      })}
    </svg>
    <div className="inflation-legend">{series.map((metric) => <a href={metric.sourceUrl} target="_blank" rel="noreferrer" key={metric.seriesId}><i style={{ background: inflationGraphColors[metric.seriesId] }} /><span>{metric.label}</span><strong>{metric.value.toFixed(1)}%</strong></a>)}</div>
  </div>;
}

function ConsensusGraph({ outcomes }: { outcomes: Array<{ label: string; mean: number | null; displayMean: number | null; low: number | null; high: number | null; sourceCount: number }> }) {
  return <div className="consensus-graph" role="img" aria-label="Equal-weight mean of normalized Polymarket and Kalshi Fed decision probabilities">
    {outcomes.map((outcome) => <div className="consensus-column" key={outcome.label}>
      <div className="consensus-plot"><span style={{ height: `${Math.max(outcome.mean ?? 0, 1)}%` }} /><strong>{outcome.displayMean == null ? "—" : `${outcome.displayMean.toFixed(1)}%`}</strong></div>
      <div className="consensus-label"><strong>{outcome.label}</strong><small>{outcome.low == null || outcome.high == null ? "No quote" : outcome.sourceCount > 1 ? `${pct(outcome.low)}–${pct(outcome.high)} range` : "1 source"}</small></div>
    </div>)}
  </div>;
}

function InflationCard({ metric }: { metric: InflationMetric }) {
  const direction = Math.abs(metric.delta) < .05 ? "flat" : metric.delta > 0 ? "up" : "down";
  return <a className="metric-card" href={metric.sourceUrl} target="_blank" rel="noreferrer" title={`${metric.source} · ${metric.seriesId}`}>
    <div><span>{metric.label}</span><small>{fmtDate(`${metric.period}T00:00:00Z`, { month: "short", year: "numeric", timeZone: "UTC" })}</small></div>
    <strong>{metric.value.toFixed(1)}%</strong>
    <p className={direction}>{metric.delta >= 0 ? "+" : ""}{metric.delta.toFixed(1)} pp <span>vs prior</span></p>
    <div className="metric-gauges"><span><small>PREV</small><strong>{metric.priorValue.toFixed(1)}%</strong></span><span><small>NEXT NOWCAST{metric.nextEstimatePeriod ? ` · ${fmtDate(`${metric.nextEstimatePeriod}T00:00:00Z`, { month: "short", timeZone: "UTC" }).toUpperCase()}` : ""}</small><strong>{metric.nextEstimate == null ? "—" : `${metric.nextEstimate.toFixed(1)}%`}</strong></span></div>
    <footer>{metric.source} · {metric.seriesId}{metric.nextEstimateSource ? ` · Next: ${metric.nextEstimateSource}` : ""}</footer>
  </a>;
}

type CalendarForecast = Forecast & {
  median: number | null;
  q10: number | null;
  q25: number | null;
  q75: number | null;
  q90: number | null;
  lastDeadline: number;
  venueCount: number;
  marketCount: number;
};

function calendarForecast(forecast: Forecast): CalendarForecast | null {
  const futurePoints = forecast.points.filter((point) => point.deadline && new Date(point.deadline).getTime() > Date.now());
  if (futurePoints.length < 2) return null;
  const lastDeadline = Math.max(...futurePoints.map((point) => new Date(point.deadline!).getTime()));
  const fit = fitDatedForecast(forecast.points);
  if (fit) return { ...forecast, ...fit, lastDeadline, source: fit.venues.join(" + ") };
  const venues = [...new Set(futurePoints.map((point) => point.venue))];
  return { ...forecast, median: null, q10: null, q25: null, q75: null, q90: null, lastDeadline, venueCount: venues.length, marketCount: futurePoints.length, source: venues.join(" + ") };
}

function ModelsScreen({ data, generatedAt, loading }: { data: AiData | null; generatedAt: string | null; loading: boolean }) {
  const forecasts = useMemo(() => data?.forecasts ?? [], [data?.forecasts]);
  const calendarForecasts = useMemo(() => forecasts.map(calendarForecast).filter((forecast): forecast is CalendarForecast => forecast != null).sort((a, b) => (a.median ?? Infinity) - (b.median ?? Infinity) || a.lastDeadline - b.lastDeadline), [forecasts]);
  const fitted = useMemo(() => calendarForecasts.filter((forecast): forecast is CalendarForecast & { median: number } => forecast.median != null), [calendarForecasts]);
  const earliest = fitted[0];
  const bounds = useMemo(() => {
    const dates = calendarForecasts.flatMap((forecast) => [forecast.q10, forecast.q90, forecast.median, forecast.lastDeadline, ...forecast.points.map((point) => point.deadline ? new Date(point.deadline).getTime() : NaN)]).filter((value): value is number => value != null && Number.isFinite(value));
    const currentMonth = new Date(); currentMonth.setUTCDate(1); currentMonth.setUTCHours(0, 0, 0, 0);
    const fiveMonthsOut = new Date(currentMonth); fiveMonthsOut.setUTCMonth(fiveMonthsOut.getUTCMonth() + 5);
    const minDate = dates.length ? Math.min(...dates) : currentMonth.getTime();
    const maxDate = dates.length ? Math.max(...dates) : fiveMonthsOut.getTime();
    const start = new Date(minDate); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    const end = new Date(maxDate); end.setUTCMonth(end.getUTCMonth() + 1, 1); end.setUTCHours(0, 0, 0, 0);
    return { start: start.getTime(), end: end.getTime() };
  }, [calendarForecasts]);
  const months = useMemo(() => {
    const values: number[] = [];
    const cursor = new Date(bounds.start);
    while (cursor.getTime() < bounds.end) { values.push(cursor.getTime()); cursor.setUTCMonth(cursor.getUTCMonth() + 1); }
    return values;
  }, [bounds]);

  return <>
    <section className="model-summary">
      <div className="summary-copy"><span className="label">EARLIEST 50% IMPLIED DATE</span><strong>{earliest ? fmtDate(new Date(earliest.median).toISOString(), { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Not available"}</strong><p>{earliest ? `${earliest.model}, derived from ${earliest.marketCount} live deadline contracts across ${earliest.venueCount} venue${earliest.venueCount === 1 ? "" : "s"}.` : "No release series currently reaches 50% across its active dated contracts."}</p></div>
      <div className="confidence-key"><span><i className="inner" /> 50% band</span><span><i className="outer" /> 80% band</span><span><i className="median" /> 50% date</span></div>
    </section>

    <article className="panel calendar-panel">
      <PanelHeading kicker="SHARED CALENDAR" title="Expected model releases" aside={generatedAt ? `Deadline CDF · ${fmtTime(generatedAt)}` : "Live public contracts"} />
      <div className="calendar-wrap">
        <TimelineAxis bounds={bounds} months={months} />
        {calendarForecasts.map((forecast) => <ForecastBand forecast={forecast} bounds={bounds} months={months} key={`${forecast.company}-${forecast.model}`} />)}
        {!calendarForecasts.length && <EmptyState title={loading ? "Fitting dated contracts…" : "No model has enough active dated contracts"} detail="At least two release-by markets are required; no fallback window is shown." compact />}
      </div>
      <div className="calendar-foot"><span>Venues reaching 50% are fitted and equally weighted; rows without a crossing remain open-ended.</span><span><i className="outer" /> 80%</span><span><i className="inner" /> 50%</span><span><i className="median" /> 50% date</span></div>
    </article>

  </>;
}

function TimelineAxis({ bounds, months }: { bounds: { start: number; end: number }; months: number[] }) {
  return <div className="calendar-axis"><span className="axis-spacer" /><div className="timeline-axis">{months.map((month, index) => {
    const date = new Date(month);
    const label = fmtDate(date.toISOString(), { month: "short", timeZone: "UTC" }).toUpperCase();
    const showYear = index === 0 || date.getUTCMonth() === 0;
    return <span className={index === 0 ? "first" : index === months.length - 1 ? "last" : ""} style={{ left: `${timePosition(month, bounds)}%` }} key={month}>{label}{showYear ? ` · ${date.getUTCFullYear()}` : ""}</span>;
  })}</div><span>FIT</span></div>;
}

function ForecastBand({ forecast, bounds, months }: { forecast: CalendarForecast; bounds: { start: number; end: number }; months: number[] }) {
  const label = <a className="calendar-label" href={forecast.sourceUrl} target="_blank" rel="noreferrer"><span>{forecast.company}</span><strong>{forecast.model}</strong><small>{forecast.source} · {forecast.marketCount} markets</small></a>;
  if (forecast.median == null || forecast.q10 == null || forecast.q25 == null) {
    const last = timePosition(forecast.lastDeadline, bounds);
    return <div className={`calendar-row ${forecast.color}`}>
      {label}
      <div className="calendar-track" aria-label={`${forecast.model}: active release-by contracts do not reach a 50 percent probability through ${fmtDate(new Date(forecast.lastDeadline).toISOString())}`}>
        {months.map((month) => <i className="month-rule" style={{ left: `${timePosition(month, bounds)}%` }} key={month} />)}
        <div className="calendar-unresolved" style={{ left: `${last}%`, width: `${100 - last}%` }}><span>50% NOT REACHED</span><small>THROUGH {fmtDate(new Date(forecast.lastDeadline).toISOString(), { month: "short", day: "numeric", timeZone: "UTC" }).toUpperCase()}</small></div>
      </div>
      <div className="calendar-score"><strong>{forecast.venueCount}</strong><span>VENUE{forecast.venueCount === 1 ? "" : "S"}</span></div>
    </div>;
  }
  const outerLeft = timePosition(forecast.q10, bounds);
  const outerRight = forecast.q90 == null ? 100 : timePosition(forecast.q90, bounds);
  const innerLeft = timePosition(forecast.q25, bounds);
  const innerRight = forecast.q75 == null ? 100 : timePosition(forecast.q75, bounds);
  const median = timePosition(forecast.median, bounds);
  return <div className={`calendar-row ${forecast.color}`}>
    {label}
    <div className="calendar-track" aria-label={`${forecast.model}: 50 percent implied date ${fmtDate(new Date(forecast.median).toISOString())}; ${forecast.q75 == null || forecast.q90 == null ? "one or more confidence intervals remain open-ended" : "central 50 percent and 80 percent release intervals"}`}>
      {months.map((month) => <i className="month-rule" style={{ left: `${timePosition(month, bounds)}%` }} key={month} />)}
      <div className={`calendar-outer ${forecast.q90 == null ? "open-ended" : ""}`} style={{ left: `${outerLeft}%`, width: `${outerRight - outerLeft}%` }} />
      <div className={`calendar-inner ${forecast.q75 == null ? "open-ended" : ""}`} style={{ left: `${innerLeft}%`, width: `${innerRight - innerLeft}%` }} />
      <div className="calendar-median" style={{ left: `${median}%` }}><span>{fmtDate(new Date(forecast.median).toISOString(), { month: "short", day: "numeric", timeZone: "UTC" })}</span></div>
    </div>
    <div className="calendar-score"><strong>{forecast.venueCount}</strong><span>VENUE{forecast.venueCount === 1 ? "" : "S"}</span></div>
  </div>;
}

function PanelHeading({ kicker, title, aside }: { kicker: string; title: string; aside: string }) {
  return <div className="panel-heading"><div><span>{kicker}</span><h2>{title}</h2></div><small>{aside}</small></div>;
}

function EmptyState({ title, detail, compact = false }: { title: string; detail?: string; compact?: boolean }) {
  return <div className={`empty-state ${compact ? "compact" : ""}`}><strong>{title}</strong>{detail && <span>{detail}</span>}</div>;
}
