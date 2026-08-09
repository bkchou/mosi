"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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
type InflationMetric = { label: string; value: number; priorValue: number; delta: number; period: string; seriesId: string; source: string; sourceUrl: string; nextEstimate: number | null; nextEstimatePeriod: string | null; nextEstimateSource: string | null };
type VenueStatus = { venue: Venue; status: "live" | "unavailable" | "no_active_market" | "credential_required"; sourceUrl: string; note?: string };
type Release = { label: string; releaseAt: string; source: string; sourceUrl: string };
type Forecast = { company: string; model: string; color: string; source: string; sourceUrl: string; status: string; points: MarketQuote[] };
type DashboardData = {
  generatedAt: string;
  fed: {
    effectiveRate: { value: number | null; period: string; source: string; sourceUrl: string } | null;
    inflation: InflationMetric[];
    decisions: Decision[];
    venues: VenueStatus[];
    releases: Release[];
  };
  ai: { forecasts: Forecast[]; evidence: MarketQuote[] };
};

const venueColors: Record<Venue, string> = {
  CME: "#fd7958",
  Polymarket: "#6083ff",
  Kalshi: "#15aa73",
  Pascal: "#a479ff",
};

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
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/data?t=${Date.now()}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Data endpoint returned ${response.status}`);
      setData(await response.json() as DashboardData);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Live data unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch(`/api/data?t=${Date.now()}`, { headers: { accept: "application/json" } })
      .then((response) => {
        if (!response.ok) throw new Error(`Data endpoint returned ${response.status}`);
        return response.json() as Promise<DashboardData>;
      })
      .then((payload) => { if (active) setData(payload); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Live data unavailable"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="MOSI home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>MOSI</span></a>
        <nav className="primary-nav" aria-label="Primary navigation">
          <a className={screen === "fed" ? "active" : ""} href="/">The Fed</a>
          <a className={screen === "models" ? "active" : ""} href="/ai-models">AI Models</a>
        </nav>
        <button className="status-pill" type="button" onClick={() => void refresh()} title="Refresh live data" aria-label={loading ? "Data syncing" : error ? "Data unavailable. Retry" : "Live data. Refresh"}>
          <span className={`pulse ${loading ? "amber" : error ? "red" : ""}`} />{loading ? "Syncing" : error ? "Retry" : "Live"}
        </button>
      </header>

      <main>
        <section className="hero-row">
          <div>
            <p className="eyebrow">{screen === "fed" ? "MONETARY POLICY" : "FRONTIER MODEL RELEASES"}</p>
            <h1>{screen === "fed" ? "Where rates go next." : "When the next models land."}</h1>
            <p className="dek">{screen === "fed" ? "Live meeting-outcome probabilities from public prediction markets, alongside the inflation data policymakers are reacting to." : "Dated prediction-market contracts on one calendar. Every point is a quoted probability—not a generated estimate."}</p>
          </div>
          <div className="update-block"><span>DATA SNAPSHOT</span><strong>{data ? fmtTime(data.generatedAt) : loading ? "Connecting…" : "Unavailable"}</strong></div>
        </section>

        {error && !data ? <EmptyState title="Live data is unavailable" detail={`${error}. No cached or synthetic values are being shown.`} /> : screen === "fed" ? <FedScreen data={data?.fed ?? null} loading={loading} /> : <ModelsScreen data={data?.ai ?? null} generatedAt={data?.generatedAt ?? null} loading={loading} />}
      </main>
      <footer><span>MOSI / bkchou</span><span>Market prices are forecasts, not facts. Sources link to the underlying observation or contract.</span></footer>
    </div>
  );
}

function FedScreen({ data, loading }: { data: DashboardData["fed"] | null; loading: boolean }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const decision = data?.decisions[selectedIndex] ?? data?.decisions[0] ?? null;
  const primaryVenue = decision?.venues.find((item) => item.venue === "Polymarket") ?? decision?.venues[0];
  const topOutcome = primaryVenue?.outcomes.reduce<Outcome | null>((best, item) => !best || item.probability > best.probability ? item : best, null) ?? null;
  const liveVenueCount = data?.venues.filter((venue) => venue.status === "live").length ?? 0;

  return (
    <>
      <section className="signal-strip" aria-label="Current monetary policy summary">
        <div><span>Effective fed funds rate</span><strong>{data?.effectiveRate?.value == null ? "—" : `${data.effectiveRate.value.toFixed(2)}%`}</strong><small>{data?.effectiveRate ? `NY FED · ${data.effectiveRate.period}` : "Source unavailable"}</small></div>
        <div><span>Next tracked decision</span><strong>{decision ? fmtDate(decision.meetingDate, { month: "short", day: "numeric", timeZone: "UTC" }) : "—"}</strong><small>{decision?.label ?? "No active decision market"}</small></div>
        <div><span>{primaryVenue?.venue ?? "Market"} top outcome</span><strong className="accent">{topOutcome?.label ?? "—"}</strong><small>{topOutcome ? `${pct(topOutcome.probability)} quoted probability` : "No quote"}</small></div>
        <div><span>Public feeds connected</span><strong>{data ? `${liveVenueCount} live` : "—"}</strong><small>{data ? "Pascal mirrors Polymarket" : "Checking sources"}</small></div>
      </section>

      <section className="dashboard-grid fed-grid">
        <article className="panel path-panel">
          <PanelHeading kicker="MEETING OUTCOMES" title="Observed decision probability graph" aside="Live venue quotes · not a modeled curve" />
          {data?.decisions.length ? <>
            <div className="decision-tabs" role="tablist" aria-label="Fed meeting">
              {data.decisions.map((item, index) => <button key={item.label} type="button" className={index === selectedIndex ? "active" : ""} onClick={() => setSelectedIndex(index)}>{item.label}<small>{fmtDate(item.meetingDate, { month: "short", day: "numeric", timeZone: "UTC" })}</small></button>)}
            </div>
            {decision && <DecisionGraph decision={decision} />}
          </> : <EmptyState title={loading ? "Syncing decision markets…" : "No active Fed decision contracts found"} detail="No substitute probabilities are shown." compact />}
        </article>

        <article className="panel venue-panel">
          <PanelHeading kicker="SOURCE STATUS" title="What is actually connected" aside="No simulated venue data" />
          <div className="venue-status-list">
            {(data?.venues ?? []).map((venue) => <VenueStatusRow item={venue} decision={decision} key={venue.venue} />)}
            {!data && <EmptyState title="Checking sources…" compact />}
          </div>
        </article>
      </section>

      <section className="inflation-section">
        <PanelHeading kicker="LAGGING INDICATORS" title="Inflation, from every angle" aside="Latest vs previous published observation" />
        <div className="inflation-grid">
          {(data?.inflation ?? []).map((metric) => <InflationCard metric={metric} key={metric.seriesId} />)}
        </div>
        {!data?.inflation.length && <EmptyState title={loading ? "Syncing FRED observations…" : "Inflation observations unavailable"} detail="No substitute values are shown." compact />}
      </section>

      {!!data?.releases.length && <section className="release-tape" aria-label="Upcoming inflation releases">
        <div><span>NEXT RELEASES</span><strong>Official agency calendar</strong></div>
        {data.releases.map((release) => <a href={release.sourceUrl} target="_blank" rel="noreferrer" key={release.label}><span>{release.label}</span><strong>{fmtDate(release.releaseAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" })}</strong><small>{release.source}</small></a>)}
      </section>}
    </>
  );
}

function DecisionGraph({ decision }: { decision: Decision }) {
  return <div className="decision-graph" role="img" aria-label={`${decision.label} probabilities by venue`}>
    <div className="outcome-axis"><span />{outcomeOrder.map((label) => <span key={label}>{label.replace(" bp", "")}</span>)}</div>
    {decision.venues.map((venue) => <div className="outcome-row" key={venue.venue}>
      <div className="outcome-venue"><i style={{ background: venueColors[venue.venue] }} />{venue.venue}</div>
      {outcomeOrder.map((label) => {
        const outcome = venue.outcomes.find((item) => item.label === label);
        return <a className="outcome-cell" key={label} href={outcome?.quote.url} target="_blank" rel="noreferrer" aria-label={outcome ? `${venue.venue} ${label}: ${pct(outcome.probability)}` : `${venue.venue} ${label}: unavailable`}>
          <span style={{ height: `${Math.max(outcome?.probability ?? 0, 1)}%` }} />
          <strong>{outcome ? pct(outcome.probability) : "—"}</strong>
        </a>;
      })}
    </div>)}
    <div className="graph-caption"><span>0%</span><strong>Bar height = quoted YES probability</strong><span>100%</span></div>
  </div>;
}

function VenueStatusRow({ item, decision }: { item: VenueStatus; decision: Decision | null }) {
  const venueData = decision?.venues.find((venue) => venue.venue === item.venue);
  const top = venueData?.outcomes.reduce<Outcome | null>((best, outcome) => !best || outcome.probability > best.probability ? outcome : best, null) ?? null;
  const statusLabel = item.status === "live" ? "LIVE QUOTES" : item.status === "credential_required" ? "LICENSED FEED NEEDED" : item.status === "no_active_market" ? "NO MATCHED ACTIVE MARKET" : "UNAVAILABLE";
  return <a className="venue-status-row" href={top?.quote.url ?? item.sourceUrl} target="_blank" rel="noreferrer">
    <span className="venue-mark" style={{ background: venueColors[item.venue] }}>{item.venue[0]}</span>
    <span className="market-copy"><strong>{item.venue}</strong><span>{top ? top.label : statusLabel}</span><small>{item.note ? `${item.note} · ` : ""}{top ? `${top.quote.quoteKind} · ${top.quote.volumeLabel}` : "No probability displayed"}</small></span>
    <span className="market-prob"><strong>{top ? pct(top.probability) : "—"}</strong><small>{item.status === "live" ? "TOP" : "STATUS"}</small></span><span className="arrow">↗</span>
  </a>;
}

function InflationCard({ metric }: { metric: InflationMetric }) {
  const direction = Math.abs(metric.delta) < .05 ? "flat" : metric.delta > 0 ? "up" : "down";
  return <a className="metric-card" href={metric.sourceUrl} target="_blank" rel="noreferrer">
    <div><span>{metric.label}</span><small>{fmtDate(`${metric.period}T00:00:00Z`, { month: "short", year: "numeric", timeZone: "UTC" })}</small></div>
    <strong>{metric.value.toFixed(1)}%</strong>
    <p className={direction}>{metric.delta >= 0 ? "+" : ""}{metric.delta.toFixed(1)} pp <span>vs prior</span></p>
    <div className="metric-gauges"><span><small>PREV</small><strong>{metric.priorValue.toFixed(1)}%</strong></span><span><small>NEXT NOWCAST{metric.nextEstimatePeriod ? ` · ${fmtDate(`${metric.nextEstimatePeriod}T00:00:00Z`, { month: "short", timeZone: "UTC" }).toUpperCase()}` : ""}</small><strong>{metric.nextEstimate == null ? "—" : `${metric.nextEstimate.toFixed(1)}%`}</strong></span></div>
    <footer>{metric.source} · {metric.seriesId}{metric.nextEstimateSource ? ` · Next: ${metric.nextEstimateSource}` : ""}</footer>
  </a>;
}

function ModelsScreen({ data, generatedAt, loading }: { data: DashboardData["ai"] | null; generatedAt: string | null; loading: boolean }) {
  const forecasts = useMemo(() => data?.forecasts ?? [], [data?.forecasts]);
  const crossing = useMemo(() => forecasts.flatMap((forecast) => forecast.points.filter((point) => point.deadline && point.probability >= 50).map((point) => ({ ...point, company: forecast.company, model: forecast.model }))).sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime())[0], [forecasts]);
  const bounds = useMemo(() => {
    const dates = forecasts.flatMap((forecast) => forecast.points.map((point) => point.deadline ? new Date(point.deadline).getTime() : NaN)).filter(Number.isFinite);
    const currentMonth = new Date(); currentMonth.setUTCDate(1); currentMonth.setUTCHours(0, 0, 0, 0);
    const fiveMonthsOut = new Date(currentMonth); fiveMonthsOut.setUTCMonth(fiveMonthsOut.getUTCMonth() + 5);
    const minDate = dates.length ? Math.min(...dates) : currentMonth.getTime();
    const maxDate = dates.length ? Math.max(...dates) : fiveMonthsOut.getTime();
    const start = new Date(minDate); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    const end = new Date(maxDate); end.setUTCMonth(end.getUTCMonth() + 1, 1); end.setUTCHours(0, 0, 0, 0);
    return { start: start.getTime(), end: end.getTime() };
  }, [forecasts]);
  const months = useMemo(() => {
    const values: number[] = [];
    const cursor = new Date(bounds.start);
    while (cursor.getTime() < bounds.end) { values.push(cursor.getTime()); cursor.setUTCMonth(cursor.getUTCMonth() + 1); }
    return values;
  }, [bounds]);

  return <>
    <section className="model-summary">
      <div className="summary-copy"><span className="label">EARLIEST TRADED DEADLINE ≥50%</span><strong>{crossing?.deadline ? fmtDate(crossing.deadline, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Not available"}</strong><p>{crossing ? `${crossing.model} is quoted at ${pct(crossing.probability)} to release by this deadline on ${crossing.venue}.` : "No active contract in the current set crosses 50%."}</p></div>
      <div className="confidence-key"><span><i className="point" /> Market quote</span><span><i className="line" /> Deadline curve</span></div>
    </section>

    <article className="panel calendar-panel">
      <PanelHeading kicker="SHARED CALENDAR" title="Dated model-release probability graphs" aside={generatedAt ? `Snapshot ${fmtTime(generatedAt)}` : "Live public contracts"} />
      <div className="calendar-wrap">
        <div className="calendar-axis"><span className="axis-spacer" /><div>{months.map((month) => <span key={month}>{fmtDate(new Date(month).toISOString(), { month: "short", year: month === months[0] ? "2-digit" : undefined, timeZone: "UTC" }).toUpperCase()}</span>)}</div><span>LAST</span></div>
        {forecasts.map((forecast) => <ReleaseCurve forecast={forecast} bounds={bounds} months={months} key={`${forecast.company}-${forecast.model}`} />)}
        {!forecasts.length && <EmptyState title={loading ? "Syncing dated contracts…" : "No active dated release contracts found"} detail="No generated release windows are shown." compact />}
      </div>
      <div className="calendar-foot"><span>Every row uses the same date axis and 0–100% vertical scale.</span><span><i className="point" /> quoted YES value</span><span><i className="line" /> cumulative deadline curve</span></div>
    </article>

    <section className="panel evidence-panel">
      <PanelHeading kicker="UNDERLYING CONTRACTS" title="What the markets are actually trading" aside={`${data?.evidence.length ?? 0} sourced quotes`} />
      <div className="evidence-grid">{(data?.evidence ?? []).slice(0, 16).map((market, index) => <MarketRow market={market} key={`${market.venue}-${market.title}-${index}`} />)}</div>
      {!data?.evidence.length && <EmptyState title="No contract quotes available" compact />}
    </section>
  </>;
}

function ReleaseCurve({ forecast, bounds, months }: { forecast: Forecast; bounds: { start: number; end: number }; months: number[] }) {
  const width = 1000;
  const height = 76;
  const points = forecast.points.filter((point) => point.deadline).map((point) => ({ quote: point, x: ((new Date(point.deadline!).getTime() - bounds.start) / (bounds.end - bounds.start)) * width, y: height - 8 - (point.probability / 100) * (height - 16) }));
  const last = forecast.points.at(-1);
  const crossing = forecast.points.find((point) => point.probability >= 50);
  return <div className={`calendar-row ${forecast.color}`}>
    <a className="calendar-label" href={forecast.sourceUrl} target="_blank" rel="noreferrer"><span>{forecast.company}</span><strong>{forecast.model}</strong><small>{crossing?.deadline ? `≥50% by ${fmtDate(crossing.deadline, { month: "short", day: "numeric", timeZone: "UTC" })}` : "No ≥50% deadline"}</small></a>
    <div className="calendar-track" aria-label={`${forecast.model} release-by probabilities from ${forecast.source}`}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        {months.map((month) => <line x1={((month - bounds.start) / (bounds.end - bounds.start)) * width} x2={((month - bounds.start) / (bounds.end - bounds.start)) * width} y1="0" y2={height} className="month-grid" key={month} />)}
        <line x1="0" x2={width} y1={height / 2} y2={height / 2} className="fifty-line" />
        {points.length > 1 && <polyline points={points.map((point) => `${point.x},${point.y}`).join(" ")} className="release-line" />}
        {points.map((point) => <g key={`${point.quote.title}-${point.x}`}><circle cx={point.x} cy={point.y} r="5" className="release-point" /><text x={Math.min(point.x + 9, width - 48)} y={Math.max(point.y - 6, 10)}>{pct(point.quote.probability)}</text></g>)}
      </svg>
    </div>
    <div className="calendar-score"><strong>{last ? pct(last.probability) : "—"}</strong><span>{last?.deadline ? `BY ${fmtDate(last.deadline, { month: "short", day: "numeric", timeZone: "UTC" })}` : "NO QUOTE"}</span></div>
  </div>;
}

function MarketRow({ market }: { market: MarketQuote }) {
  return <a className="market-row" href={market.url} target="_blank" rel="noreferrer">
    <span className="venue-mark" style={{ background: venueColors[market.venue] }}>{market.venue[0]}</span>
    <span className="market-copy"><strong>{market.venue}</strong><span>{market.title}</span><small>{market.quoteKind} · {market.volumeLabel}{market.deadline ? ` · ${fmtDate(market.deadline, { month: "short", day: "numeric", timeZone: "UTC" })}` : ""}</small></span>
    <span className="market-prob"><strong>{pct(market.probability)}</strong><small>YES</small></span><span className="arrow">↗</span>
  </a>;
}

function PanelHeading({ kicker, title, aside }: { kicker: string; title: string; aside: string }) {
  return <div className="panel-heading"><div><span>{kicker}</span><h2>{title}</h2></div><small>{aside}</small></div>;
}

function EmptyState({ title, detail, compact = false }: { title: string; detail?: string; compact?: boolean }) {
  return <div className={`empty-state ${compact ? "compact" : ""}`}><strong>{title}</strong>{detail && <span>{detail}</span>}</div>;
}
