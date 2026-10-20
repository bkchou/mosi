"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { buildConsensus, buildExpectedPolicyPath, fitDatedQuantiles, percentagesToTenths, timePosition } from "../lib/marketMath";
import { mergeWithLocalCache, storedCache, type CacheEnvelope, type LocalFallback, type StoredFeedCache } from "../lib/localFeedCache";
import { buildMedianHistory, weeklyMedianMovement, type PriceHistoryPoint } from "../lib/forecastHistory";

type Screen = "fed" | "models";
type Venue = "Polymarket" | "Kalshi" | "Pascal";

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
  tokenId?: string;
};

type Outcome = { label: string; probability: number; quote: MarketQuote };
type Decision = { label: string; meetingDate: string | null; venues: Array<{ venue: MarketQuote["venue"]; outcomes: Outcome[] }> };
type InflationPoint = { period: string; value: number };
type InflationMetric = { label: string; value: number; priorValue: number; delta: number; period: string; seriesId: string; source: string; sourceUrl: string; nextEstimate: number | null; nextEstimatePeriod: string | null; nextEstimateSource: string | null; history: InflationPoint[] };
type VenueStatus = { venue: Venue; status: "live" | "unavailable" | "no_active_market"; sourceUrl: string; note?: string };
type Release = { label: string; releaseAt: string; source: string; sourceUrl: string };
type Forecast = { company: string; model: string; color: string; source: string; sourceUrl: string; status: string; points: MarketQuote[] };
type SofrPath = { asOf: string; currentTargetRange: string; points: Array<{ period: string; midpoint: number; low: number; high: number }>; source: string; sourceUrl: string };
type TreasuryCurve = { asOf: string; curves: Array<{ label: string; period: string; points: Array<{ label: string; years: number; value: number }> }>; spreads: { twoTen: number; threeMonthTen: number }; source: string; sourceUrl: string };
type FedData = {
  effectiveRate: { value: number | null; period: string; source: string; sourceUrl: string } | null;
  inflation: InflationMetric[];
  decisions: Decision[];
  venues: VenueStatus[];
  releases: Release[];
  sofrPath: SofrPath | null;
  treasury: TreasuryCurve | null;
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

function readDeviceCache(screen: Screen): StoredFeedCache | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(`mosi-feed-v1-${screen}`) ?? "null") as StoredFeedCache | null;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function cacheAge(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
  return minutes < 60 ? `${minutes} min old` : `${Math.floor(minutes / 60)}h ${minutes % 60}m old`;
}

export function MosiDashboard({ screen }: { screen: Screen }) {
  const [feed, setFeed] = useState<FeedEnvelope<FedData | AiData> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localFallbacks, setLocalFallbacks] = useState<LocalFallback[]>([]);

  const acceptFeed = useCallback((payload: FeedEnvelope<FedData | AiData>) => {
    const merged = mergeWithLocalCache(screen, payload as unknown as CacheEnvelope, readDeviceCache(screen));
    setFeed(merged.feed as unknown as FeedEnvelope<FedData | AiData>);
    setLocalFallbacks(merged.fallbacks);
    try { localStorage.setItem(`mosi-feed-v1-${screen}`, JSON.stringify(storedCache(merged.feed, merged.providerFetchedAt))); } catch { /* Live data remains usable when device storage is unavailable. */ }
  }, [screen]);

  const loadFeed = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const path = screen === "fed" ? "/api/fed" : "/api/ai";
      const params = new URLSearchParams();
      if (force) params.set("refresh", String(Date.now()));
      const response = await fetch(`${path}${params.size ? `?${params}` : ""}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Data endpoint returned ${response.status}`);
      acceptFeed(await response.json() as FeedEnvelope<FedData | AiData>);
    } catch (reason) {
      const cached = readDeviceCache(screen);
      if (cached && Date.now() - Date.parse(cached.feed.generatedAt) <= 6 * 60 * 60 * 1000) {
        setFeed({ ...cached.feed, status: "stale", sources: cached.feed.sources.map((source) => ({ ...source, status: "stale", note: "Using this device's last successful snapshot." })) } as unknown as FeedEnvelope<FedData | AiData>);
        setLocalFallbacks(Object.entries(cached.providerFetchedAt).filter(([source, fetchedAt]) => source.startsWith("Kalshi") && Date.now() - Date.parse(fetchedAt) <= 6 * 60 * 60 * 1000).map(([source, cachedAt]) => ({ source, cachedAt })));
      }
      setError(reason instanceof Error ? reason.message : "Live data unavailable");
    } finally {
      setLoading(false);
    }
  }, [acceptFeed, screen]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadFeed(false), 0);
    return () => window.clearTimeout(timer);
  }, [loadFeed]);

  const visibleStatus = loading ? "syncing" : error ? feed ? "stale" : "retry" : feed?.status === "live" ? "current" : feed?.status ?? "syncing";
  const statusTitle = feed ? `${feed.status === "live" ? "CURRENT" : feed.status.toUpperCase()} data · checked ${fmtTime(feed.generatedAt)} · ${feed.sources.map((source) => `${source.source}: ${source.status}${source.fetchedAt ? ` · collected ${fmtTime(source.fetchedAt)}` : ""}`).join(", ")}. Click to refresh.` : "Refresh data";
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
            <p className="dek">{screen === "fed" ? "FOMC decision odds from prediction markets, the options-implied rate path, and the inflation data behind both." : "Market-implied release dates from Polymarket and Kalshi contracts."}</p>
          </div>
        </section>

        {!!localFallbacks.length && <div className="local-cache-note" role="status"><strong>KALSHI LOCAL SNAPSHOT</strong><span>{cacheAge(localFallbacks.map((item) => item.cachedAt).sort()[0])} · current refresh rate-limited · stored only on this device</span></div>}

        {error && !feed ? <EmptyState title="Live data is unavailable" detail={`${error}. No cached or synthetic values are being shown.`} /> : screen === "fed" ? <FedScreen data={fedData ?? null} generatedAt={feed?.generatedAt ?? null} loading={loading} /> : <ModelsScreen data={aiData ?? null} generatedAt={feed?.generatedAt ?? null} loading={loading} />}
      </main>
      <footer><span>MOSI / bkchou</span><span>Market prices are forecasts, not facts. Sources link to the underlying observation or contract.</span></footer>
    </div>
  );
}

const policyMoves: Record<string, number> = { "Cut 50+ bp": -50, "Cut 25 bp": -25, "No change": 0, "Hike 25 bp": 25, "Hike 50+ bp": 50 };

function targetRange(range: string | undefined) {
  const values = range?.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return values.length >= 2 ? { low: values[0] / 100, high: values[1] / 100 } : null;
}

// Decision markets close at 11:59 PM ET on announcement day, so the ET date is the meeting date.
function fmtMeeting(value: string | null, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  return fmtDate(value, { ...options, timeZone: "America/New_York" });
}

function signedBp(value: number) {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(0)} bp`;
}

function FedScreen({ data, generatedAt, loading }: { data: FedData | null; generatedAt: string | null; loading: boolean }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const decision = data?.decisions[selectedIndex] ?? data?.decisions[0] ?? null;
  const { eligibleVenues: independentVenues, outcomes: consensus } = useMemo(() => buildConsensus(decision?.venues ?? [], outcomeOrder), [decision]);
  const displayedConsensus = useMemo(() => {
    const displayMeans = percentagesToTenths(consensus.map((outcome) => outcome.mean));
    return consensus.map((outcome, index) => ({ ...outcome, displayMean: displayMeans[index] }));
  }, [consensus]);
  const range = targetRange(data?.sofrPath?.currentTargetRange);
  const currentTargetMidpoint = range ? (range.low + range.high) / 2 : data?.effectiveRate?.value ?? null;
  const policyPath = useMemo(() => currentTargetMidpoint == null ? [] : buildExpectedPolicyPath(data?.decisions ?? [], currentTargetMidpoint, outcomeOrder, policyMoves), [currentTargetMidpoint, data?.decisions]);
  const lastMeeting = policyPath.at(-1);
  const finalSofr = data?.sofrPath?.points.at(-1);

  return (
    <>
      <section className="dashboard-grid fed-story-grid">
        <article className="panel decision-panel" id="fed-decision">
          <PanelHeading kicker="FOMC DECISION ODDS" title={decision ? `${fmtMeeting(decision.meetingDate, { month: "long", day: "numeric", year: "numeric" })} meeting` : "No active decision markets"} aside={independentVenues.map((venue) => venue.venue).join(" + ")} />
          {data?.decisions.length ? <>
            {data.decisions.length > 1 && <div className="decision-tabs" role="tablist" aria-label="FOMC meeting">
              {data.decisions.map((item, index) => <button key={item.label} type="button" role="tab" aria-selected={index === selectedIndex} className={index === selectedIndex ? "active" : ""} onClick={() => setSelectedIndex(index)}>{fmtMeeting(item.meetingDate)}</button>)}
            </div>}
            <ConsensusGraph outcomes={displayedConsensus} />
            <details className="meeting-disclosure">
              <summary><span>Contracts</span><small>{independentVenues.reduce((sum, venue) => sum + venue.outcomes.length, 0)} quotes</small></summary>
              <MeetingContracts venues={independentVenues} />
            </details>
          </> : <EmptyState title={loading ? "Loading decision markets…" : "No active Fed decision contracts found"} compact />}
          <div className="policy-source-line"><span>Polymarket and Kalshi quotes are normalized to 100% and equally weighted. Pascal mirrors Polymarket, so it is not counted.</span></div>
        </article>

        <article className="panel policy-path-panel">
          <PanelHeading kicker="RATE PATH" title="Expected policy rate" aside="Meetings from prediction markets · 3-month SOFR from options" />
          <div className="policy-summary" aria-label="Rate path summary">
            <div><span>TARGET RANGE</span><strong>{range ? `${range.low.toFixed(2)}–${range.high.toFixed(2)}%` : "—"}</strong><small>{data?.effectiveRate?.value == null ? "EFFR unavailable" : `EFFR ${data.effectiveRate.value.toFixed(2)}% · ${fmtDate(`${data.effectiveRate.period}T00:00:00Z`, { month: "short", day: "numeric", timeZone: "UTC" })}`}</small></div>
            <div><span>{lastMeeting ? `EXPECTED AFTER ${fmtMeeting(lastMeeting.meetingDate).toUpperCase()}` : "EXPECTED TARGET"}</span><strong>{lastMeeting ? `${lastMeeting.expectedRate.toFixed(2)}%` : "—"}</strong><small>{lastMeeting && currentTargetMidpoint != null ? `${signedBp((lastMeeting.expectedRate - currentTargetMidpoint) * 100)} over ${policyPath.length} meeting${policyPath.length === 1 ? "" : "s"}` : "No complete market"}</small></div>
            <div><span>{finalSofr ? `3M SOFR · ${fmtDate(`${finalSofr.period}T00:00:00Z`, { month: "short", year: "numeric", timeZone: "UTC" }).toUpperCase()}` : "3M SOFR"}</span><strong>{finalSofr ? `${finalSofr.midpoint.toFixed(2)}%` : "—"}</strong><small>{finalSofr ? `${finalSofr.low.toFixed(2)}–${finalSofr.high.toFixed(2)}% middle 50%` : "Atlanta Fed unavailable"}</small></div>
          </div>
          {data?.sofrPath && currentTargetMidpoint != null && generatedAt ? <PolicyPathGraph currentRate={currentTargetMidpoint} effectiveRate={data.effectiveRate?.value ?? null} meetings={policyPath} sofr={data.sofrPath} now={Date.parse(generatedAt)} /> : <EmptyState title={loading ? "Loading the rate path…" : "Rate path unavailable"} compact />}
          <div className="policy-source-line"><span>Expected move = probability-weighted outcomes; 50+ bp outcomes count as 50 bp.</span>{data?.sofrPath && <a href={data.sofrPath.sourceUrl} target="_blank" rel="noreferrer">Atlanta Fed SOFR model · {data.sofrPath.asOf} ↗</a>}</div>
        </article>

        <article className="panel inflation-path-panel">
          <PanelHeading kicker="INFLATION" title="Year-over-year inflation" aside="Solid observed · dashed Cleveland Fed nowcast" />
          {!!data?.inflation.length && <InflationHistory metrics={data.inflation} />}
          {!!data?.inflation.length && <InflationReadout metrics={data.inflation} />}
          {!data?.inflation.length && <EmptyState title={loading ? "Loading inflation…" : "Inflation observations unavailable"} compact />}
        </article>

        <details className="panel treasury-disclosure">
          <summary><div><span>RATES CONTEXT</span><strong>Treasury yield curve</strong></div><small>{data?.treasury ? `10Y ${data.treasury.curves[0]?.points.find((point) => point.label === "10Y")?.value.toFixed(2) ?? "—"}% · 2s10s ${(data.treasury.spreads.twoTen * 100).toFixed(0)} bp · ${data.treasury.asOf}` : "Unavailable"}</small></summary>
          {data?.treasury ? <TreasuryCurveGraph data={data.treasury} /> : <EmptyState title={loading ? "Loading Treasury curve…" : "Treasury curve unavailable"} compact />}
        </details>
      </section>

      {!!data?.releases.length && <section className="release-tape" aria-label="Upcoming inflation releases">
        <div><span>NEXT RELEASES</span><strong>Inflation data</strong></div>
        {data.releases.map((release) => <a href={release.sourceUrl} target="_blank" rel="noreferrer" key={release.label}><span>{release.label}</span><strong>{fmtDate(release.releaseAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" })}</strong><small>{release.source}</small></a>)}
      </section>}
    </>
  );
}

type PolicyPathPoint = ReturnType<typeof buildExpectedPolicyPath>[number];

function PolicyPathGraph({ currentRate, effectiveRate, meetings, sofr, now }: { currentRate: number; effectiveRate: number | null; meetings: PolicyPathPoint[]; sofr: SofrPath; now: number }) {
  const [inspected, setInspected] = useState<{ label: string; value: string; detail: string; kind: "meeting" | "sofr" } | null>(null);
  const width = 1000, height = 280, left = 62, right = 972, top = 24, bottom = 222;
  const sofrPoints = sofr.points.map((point) => ({ ...point, timestamp: Date.parse(`${point.period}T00:00:00Z`) }));
  const meetingPoints = meetings.map((point) => ({ ...point, timestamp: Date.parse(point.meetingDate) }));
  const end = Math.max(now + 120 * 86_400_000, ...sofrPoints.map((point) => point.timestamp), ...meetingPoints.map((point) => point.timestamp));
  const values = [currentRate, effectiveRate ?? currentRate, ...sofrPoints.flatMap((point) => [point.low, point.high]), ...meetingPoints.map((point) => point.expectedRate)];
  const min = Math.floor((Math.min(...values) - .12) * 4) / 4;
  const max = Math.ceil((Math.max(...values) + .12) * 4) / 4;
  const x = (timestamp: number) => left + ((timestamp - now) / Math.max(1, end - now)) * (right - left);
  const y = (value: number) => bottom - ((value - min) / Math.max(.01, max - min)) * (bottom - top);
  const yTicks = Array.from({ length: Math.round((max - min) * 4) + 1 }, (_, index) => min + index / 4).filter((_, index, all) => all.length <= 7 || index % 2 === 0);
  const monthTicks: number[] = [];
  const cursor = new Date(now); cursor.setUTCDate(1); cursor.setUTCHours(0, 0, 0, 0); cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  while (cursor.getTime() < end) { monthTicks.push(cursor.getTime()); cursor.setUTCMonth(cursor.getUTCMonth() + 2); }
  const band = `${sofrPoints.map((point) => `${x(point.timestamp)},${y(point.high)}`).join(" ")} ${[...sofrPoints].reverse().map((point) => `${x(point.timestamp)},${y(point.low)}`).join(" ")}`;
  const sofrLine = sofrPoints.map((point, index) => `${index ? "L" : "M"}${x(point.timestamp)},${y(point.midpoint)}`).join(" ");
  const meetingLine = [{ timestamp: now, expectedRate: currentRate }, ...meetingPoints].map((point, index) => `${index ? "L" : "M"}${x(point.timestamp)},${y(point.expectedRate)}`).join(" ");
  const inspect = (value: NonNullable<typeof inspected>) => ({ onPointerEnter: () => setInspected(value), onPointerDown: () => setInspected(value), onFocus: () => setInspected(value), onBlur: () => setInspected(null) });
  return <div className="policy-graph-wrap">
    <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Forward policy-rate path from prediction markets and the Atlanta Fed SOFR options model">
      <text className="graph-axis-unit" x="4" y="13">RATE %</text>
      {yTicks.map((tick) => <g className="policy-y-tick" key={tick}><line x1={left} x2={right} y1={y(tick)} y2={y(tick)} /><text x={left - 10} y={y(tick) + 4}>{tick.toFixed(2)}%</text></g>)}
      {monthTicks.map((tick) => <g className="policy-x-tick" key={tick}><line x1={x(tick)} x2={x(tick)} y1={top} y2={bottom} /><text x={x(tick)} y="246">{fmtDate(new Date(tick).toISOString(), { month: "short", year: new Date(tick).getUTCMonth() === 0 ? "2-digit" : undefined, timeZone: "UTC" }).toUpperCase()}</text></g>)}
      <line className="current-rate-rule" x1={left} x2={right} y1={y(currentRate)} y2={y(currentRate)} />
      <polygon className="policy-sofr-band" points={band} />
      <path className="policy-sofr-line" d={sofrLine} />
      <path className="policy-meeting-line" d={meetingLine} />
      <g className="policy-current-point interactive-point" tabIndex={0} role="img" aria-label={`Current target midpoint ${currentRate.toFixed(3)} percent${effectiveRate == null ? "" : `, effective federal funds rate ${effectiveRate.toFixed(3)} percent`}`} {...inspect({ label: "TODAY", value: `${currentRate.toFixed(3)}% target midpoint`, detail: effectiveRate == null ? "EFFR unavailable" : `${effectiveRate.toFixed(3)}% effective federal funds rate`, kind: "meeting" })}><circle cx={x(now)} cy={y(currentRate)} r="5" /></g>
      {meetingPoints.map((point) => <g className="policy-meeting-point interactive-point" tabIndex={0} role="img" aria-label={`${point.label}, ${point.expectedRate.toFixed(3)} percent expected target midpoint, ${point.expectedMove >= 0 ? "+" : ""}${point.expectedMove.toFixed(1)} basis points expected decision`} {...inspect({ label: `${fmtMeeting(point.meetingDate, { month: "long", day: "numeric", year: "numeric" })} FOMC`, value: `${point.expectedRate.toFixed(3)}% expected target midpoint`, detail: `${point.expectedMove >= 0 ? "+" : ""}${point.expectedMove.toFixed(1)} bp expected decision`, kind: "meeting" })} key={point.meetingDate}><circle cx={x(point.timestamp)} cy={y(point.expectedRate)} r="5" /><text x={x(point.timestamp)} y={y(point.expectedRate) - 11}>{point.expectedRate.toFixed(2)}%</text><text className="date" x={x(point.timestamp)} y={y(point.expectedRate) + 18}>{fmtMeeting(point.meetingDate).toUpperCase()}</text></g>)}
      {sofrPoints.map((point) => <g className="policy-sofr-point interactive-point" tabIndex={0} role="img" aria-label={`${fmtDate(`${point.period}T00:00:00Z`, { month: "long", year: "numeric", timeZone: "UTC" })}, expected three-month SOFR ${point.midpoint.toFixed(3)} percent, interquartile range ${point.low.toFixed(3)} to ${point.high.toFixed(3)} percent`} {...inspect({ label: `${fmtDate(`${point.period}T00:00:00Z`, { month: "long", year: "numeric", timeZone: "UTC" })} 3-month SOFR`, value: `${point.midpoint.toFixed(3)}% expected`, detail: `${point.low.toFixed(3)}–${point.high.toFixed(3)}% interquartile range`, kind: "sofr" })} key={point.period}><circle cx={x(point.timestamp)} cy={y(point.midpoint)} r="4" /><text x={x(point.timestamp)} y={y(point.midpoint) + 18}>{point.midpoint.toFixed(2)}%</text></g>)}
    </svg>
    <div className={`graph-inspector ${inspected?.kind ?? "meeting"}`} aria-live="polite"><span>{inspected?.label ?? "TODAY"}</span><strong>{inspected?.value ?? `${currentRate.toFixed(3)}% target midpoint`}</strong><small>{inspected?.detail ?? (effectiveRate == null ? "EFFR unavailable" : `${effectiveRate.toFixed(3)}% effective federal funds rate`)}</small></div>
    <div className="policy-legend"><a href="#fed-decision"><i className="meetings" /> Expected target midpoint</a><span><i className="sofr" /> Expected 3-month SOFR</span><span><i className="band" /> SOFR middle 50%</span></div>
  </div>;
}

function MeetingContracts({ venues }: { venues: Decision["venues"] }) {
  const rows = venues.flatMap((venue) => venue.outcomes.map((outcome) => ({ venue: venue.venue, ...outcome })));
  return <div className="meeting-contracts"><table><caption>Underlying Fed decision contracts</caption><thead><tr><th>OUTCOME</th><th>VENUE</th><th>RAW QUOTE</th><th>PRICE TYPE</th><th>ACTIVITY</th><th>MARKET</th></tr></thead><tbody>
    {rows.map((row) => <tr key={`${row.venue}-${row.label}-${row.quote.symbol ?? row.quote.title}`}><td><strong>{row.label}</strong></td><td>{row.venue}</td><td><b>{pct(row.probability)}</b></td><td>{row.quote.quoteKind}</td><td>{row.quote.volumeLabel}</td><td><a className="market-link" href={row.quote.url} target="_blank" rel="noreferrer">OPEN ↗</a></td></tr>)}
  </tbody></table></div>;
}

function InflationReadout({ metrics }: { metrics: InflationMetric[] }) {
  return <div className="inflation-readout">{metrics.map((metric) => <a href={metric.sourceUrl} target="_blank" rel="noreferrer" key={metric.seriesId}><span>{inflationGraphColors[metric.seriesId] && <i style={{ background: inflationGraphColors[metric.seriesId] }} />}{metric.label}</span><strong>{metric.value.toFixed(1)}%</strong><small>PREV {metric.priorValue.toFixed(1)}%{metric.nextEstimate == null ? "" : ` · NEXT ${metric.nextEstimate.toFixed(1)}%`}</small></a>)}</div>;
}

function TreasuryCurveGraph({ data }: { data: TreasuryCurve }) {
  const width = 420, height = 170, left = 40, right = 404, top = 16, bottom = 128;
  const all = data.curves.flatMap((curve) => curve.points.map((point) => point.value));
  const min = Math.floor((Math.min(...all) - .1) * 4) / 4;
  const max = Math.ceil((Math.max(...all) + .1) * 4) / 4;
  const latest = data.curves[0];
  const x = (index: number) => left + index * ((right - left) / Math.max(1, latest.points.length - 1));
  const y = (value: number) => bottom - ((value - min) / Math.max(.01, max - min)) * (bottom - top);
  const ticks = [min, (min + max) / 2, max];
  const curveClass = (label: string) => label === "Latest" ? "curve-0" : label === "1 month ago" ? "curve-1" : "curve-2";
  return <section className="rate-graph-block treasury-block">
    <div className="rate-graph-title"><div><span>TREASURY PAR YIELD CURVE</span><strong>2s10s {(data.spreads.twoTen * 100).toFixed(0)} bp · 3m10y {(data.spreads.threeMonthTen * 100).toFixed(0)} bp</strong></div><small>{data.curves.map((curve) => `${curve.label} ${fmtDate(`${curve.period}T00:00:00Z`, { month: "short", day: "numeric", timeZone: "UTC" })}`).join(" · ")}</small></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`U.S. Treasury yield curves through ${data.asOf}`}>
      {ticks.map((tick) => <g className="rate-grid" key={tick}><line x1={left} x2={right} y1={y(tick)} y2={y(tick)} /><text x={left - 7} y={y(tick) + 3}>{tick.toFixed(2)}%</text></g>)}
      {data.curves.map((curve) => <path className={`treasury-line ${curveClass(curve.label)}`} d={curve.points.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.value)}`).join(" ")} key={`${curve.label}-${curve.period}`} />)}
      {latest.points.map((point, index) => <g className="rate-point" key={point.label}><circle className="treasury-dot" cx={x(index)} cy={y(point.value)} r="3"><title>{point.label} · {point.value.toFixed(2)}% on {data.asOf}</title></circle><text x={x(index)} y="145">{point.label}</text><text className="rate-value" x={x(index)} y="160">{point.value.toFixed(2)}</text></g>)}
    </svg>
    <div className="curve-key">{data.curves.map((curve) => <span key={`${curve.label}-${curve.period}`}><i className={curve.label === "Latest" ? "latest" : curve.label === "1 month ago" ? "month" : "year"} /> {curve.label}</span>)}<a className="rate-source" href={data.sourceUrl} target="_blank" rel="noreferrer">{data.source} · {data.asOf} ↗</a></div>
  </section>;
}

const inflationGraphColors: Record<string, string> = {
  CPIAUCNS: "#f16645",
  CPILFENS: "#a9472f",
  PCEPI: "#497ad8",
  PCEPILFE: "#7553a6",
  PCETRIM12M159SFRBDAL: "#0c9b65",
};

function InflationHistory({ metrics }: { metrics: InflationMetric[] }) {
  const [rangeMonths, setRangeMonths] = useState<12 | 36>(36);
  const [inspected, setInspected] = useState<{ label: string; value: string; detail: string } | null>(null);
  const fullSeries = metrics.filter((metric) => inflationGraphColors[metric.seriesId] && metric.history.length > 1);
  const fullPoints = fullSeries.flatMap((metric) => metric.history.map((point) => new Date(`${point.period}T00:00:00Z`).getTime()));
  const observedEnd = fullPoints.length ? Math.max(...fullPoints) : 0;
  const cutoff = new Date(observedEnd); cutoff.setUTCMonth(cutoff.getUTCMonth() - rangeMonths);
  const series = fullSeries.map((metric) => ({ ...metric, history: metric.history.filter((point) => Date.parse(`${point.period}T00:00:00Z`) >= cutoff.getTime()) })).filter((metric) => metric.history.length > 1);
  const points = series.flatMap((metric) => metric.history.map((point) => ({ ...point, timestamp: new Date(`${point.period}T00:00:00Z`).getTime() })));
  if (!points.length) return null;
  const start = Math.min(...points.map((point) => point.timestamp));
  const forecasts = series.flatMap((metric) => metric.nextEstimate != null && metric.nextEstimatePeriod ? [{ timestamp: Date.parse(`${metric.nextEstimatePeriod}T00:00:00Z`), value: metric.nextEstimate }] : []);
  const end = Math.max(observedEnd, ...forecasts.map((point) => point.timestamp));
  const values = [...points.map((point) => point.value), ...forecasts.map((point) => point.value)];
  const yMin = Math.min(0, Math.floor(Math.min(...values)));
  const yMax = Math.max(yMin + 1, Math.ceil(Math.max(...values)));
  const plot = { left: 54, right: 980, top: 18, bottom: 206 };
  const x = (timestamp: number) => plot.left + ((timestamp - start) / Math.max(1, end - start)) * (plot.right - plot.left);
  const y = (value: number) => plot.bottom - ((value - yMin) / (yMax - yMin)) * (plot.bottom - plot.top);
  const ticks = Array.from({ length: yMax - yMin + 1 }, (_, index) => yMin + index).filter((_, index, all) => all.length <= 6 || index % 2 === 0);
  const monthTicks: number[] = [];
  const cursor = new Date(start); cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1); cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= end) { if (cursor.getUTCMonth() === 0 || cursor.getUTCMonth() === 6) monthTicks.push(cursor.getTime()); cursor.setUTCMonth(cursor.getUTCMonth() + 1); }
  const inspect = (value: NonNullable<typeof inspected>) => ({ onPointerEnter: () => setInspected(value), onPointerDown: () => setInspected(value), onFocus: () => setInspected(value), onBlur: () => setInspected(null) });
  return <div className="inflation-history">
    <div className="graph-toolbar"><div><span>VIEW</span><button type="button" aria-pressed={rangeMonths === 12} className={rangeMonths === 12 ? "active" : ""} onClick={() => setRangeMonths(12)}>1Y</button><button type="button" aria-pressed={rangeMonths === 36} className={rangeMonths === 36 ? "active" : ""} onClick={() => setRangeMonths(36)}>3Y</button></div></div>
    <svg viewBox="0 0 1000 244" role="group" aria-label="Historical year-over-year inflation rates with next-period Cleveland Fed nowcasts">
      <text className="graph-axis-unit" x="4" y="13">YOY %</text>
      {end > observedEnd && <rect className="forecast-zone" x={x(observedEnd)} y={plot.top} width={Math.max(0, x(end) - x(observedEnd))} height={plot.bottom - plot.top} />}
      {ticks.map((tick) => <g className="inflation-y-tick" key={tick}><line x1={plot.left} x2={plot.right} y1={y(tick)} y2={y(tick)} /><text x={plot.left - 8} y={y(tick) + 3}>{tick}%</text></g>)}
      {monthTicks.map((tick) => <g className="inflation-x-tick" key={tick}><line x1={x(tick)} x2={x(tick)} y1={plot.top} y2={plot.bottom} /><text x={x(tick)} y="231">{fmtDate(new Date(tick).toISOString(), { month: "short", year: new Date(tick).getUTCMonth() === 0 ? "2-digit" : undefined, timeZone: "UTC" }).toUpperCase()}</text></g>)}
      {end > observedEnd && <g className="forecast-boundary"><line x1={x(observedEnd)} x2={x(observedEnd)} y1={plot.top} y2={plot.bottom} /><text x={x(observedEnd) + 7} y={plot.top + 10}>NEXT ESTIMATE</text></g>}
      {series.map((metric) => {
        const segments: InflationPoint[][] = [];
        for (const point of metric.history) {
          const previous = segments.at(-1)?.at(-1);
          const gap = previous ? Date.parse(`${point.period}T00:00:00Z`) - Date.parse(`${previous.period}T00:00:00Z`) : 0;
          if (!previous || gap > 45 * 86_400_000) segments.push([point]); else segments.at(-1)!.push(point);
        }
        const latest = metric.history.at(-1)!;
        const latestTime = Date.parse(`${latest.period}T00:00:00Z`);
        const nextTime = metric.nextEstimatePeriod ? Date.parse(`${metric.nextEstimatePeriod}T00:00:00Z`) : null;
        return <g className="inflation-series" style={{ color: inflationGraphColors[metric.seriesId] }} key={metric.seriesId}>
          {segments.map((segment, segmentIndex) => <path d={segment.map((point, index) => `${index ? "L" : "M"}${x(Date.parse(`${point.period}T00:00:00Z`)).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ")} key={segmentIndex} />)}
          {metric.history.map((point) => <circle className="interactive-point" tabIndex={0} role="img" aria-label={`${metric.label}, ${fmtDate(`${point.period}T00:00:00Z`, { month: "long", year: "numeric", timeZone: "UTC" })}, ${point.value.toFixed(2)} percent, observed ${metric.source}`} {...inspect({ label: metric.label, value: `${point.value.toFixed(2)}%`, detail: `${fmtDate(`${point.period}T00:00:00Z`, { month: "long", year: "numeric", timeZone: "UTC" })} · observed ${metric.source}` })} cx={x(new Date(`${point.period}T00:00:00Z`).getTime())} cy={y(point.value)} r="6" key={point.period} />)}
          <circle className="latest-point" cx={x(latestTime)} cy={y(latest.value)} r="3" />
          {metric.nextEstimate != null && nextTime != null && <><path className="inflation-forecast-line" d={`M${x(latestTime)},${y(latest.value)} L${x(nextTime)},${y(metric.nextEstimate)}`} /><circle className="forecast-point interactive-point" tabIndex={0} role="img" aria-label={`${metric.label} next estimate ${metric.nextEstimate.toFixed(2)} percent, ${metric.nextEstimateSource}`} {...inspect({ label: `${metric.label} · NEXT ESTIMATE`, value: `${metric.nextEstimate.toFixed(2)}%`, detail: `${fmtDate(`${metric.nextEstimatePeriod}T00:00:00Z`, { month: "long", year: "numeric", timeZone: "UTC" })} · ${metric.nextEstimateSource}` })} cx={x(nextTime)} cy={y(metric.nextEstimate)} r="5" /></>}
        </g>;
      })}
    </svg>
    <div className="graph-inspector inflation-inspector" aria-live="polite"><span>{inspected?.label ?? series[0].label}</span><strong>{inspected?.value ?? `${series[0].value.toFixed(2)}%`}</strong><small>{inspected?.detail ?? `${fmtDate(`${series[0].period}T00:00:00Z`, { month: "long", year: "numeric", timeZone: "UTC" })} · observed ${series[0].source}`}</small></div>
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

/** Returns null when no venue has two active dated contracts. */
function calendarForecast(forecast: Forecast, now: number): CalendarForecast | null {
  const futurePoints = forecast.points.filter((point) => point.deadline && new Date(point.deadline).getTime() > now);
  const fit = futurePoints.length >= 2 ? fitDatedQuantiles(futurePoints, now) : null;
  if (!fit) return null;
  const lastDeadline = Math.max(...futurePoints.map((point) => new Date(point.deadline!).getTime()));
  return { ...forecast, ...fit, lastDeadline, source: fit.venues.join(" + ") };
}

const labLogos: Record<string, string> = {
  OpenAI: "openai", Anthropic: "anthropic", Google: "google", xAI: "xai", Meta: "meta", Mistral: "mistral",
  Microsoft: "microsoft", "Moonshot AI": "moonshot", "Z.ai": "zai", DeepSeek: "deepseek", Alibaba: "alibaba",
};

function LabLogo({ company }: { company: string }) {
  const logo = labLogos[company];
  // eslint-disable-next-line @next/next/no-img-element -- static 64px marks; no optimization needed.
  return logo ? <img className="lab-logo" src={`/labs/${logo}.png`} alt="" width={16} height={16} /> : <i className="lab-logo" aria-hidden="true">{company.charAt(0)}</i>;
}

function ModelsScreen({ data, generatedAt, loading }: { data: AiData | null; generatedAt: string | null; loading: boolean }) {
  const [expandedForecast, setExpandedForecast] = useState<string | null>(null);
  const now = useMemo(() => generatedAt ? Date.parse(generatedAt) : 0, [generatedAt]);
  const forecasts = useMemo(() => data?.forecasts ?? [], [data?.forecasts]);
  const calendarForecasts = useMemo(() => forecasts.flatMap((forecast) => calendarForecast(forecast, now) ?? []).sort((a, b) => (a.median ?? Infinity) - (b.median ?? Infinity) || a.lastDeadline - b.lastDeadline), [forecasts, now]);
  const fitted = useMemo(() => calendarForecasts.filter((forecast): forecast is CalendarForecast & { median: number } => forecast.median != null), [calendarForecasts]);
  const earliest = fitted[0];
  const bounds = useMemo(() => {
    const dates = calendarForecasts.flatMap((forecast) => [forecast.q10, forecast.q90, forecast.median, forecast.lastDeadline, ...forecast.points.map((point) => point.deadline ? new Date(point.deadline).getTime() : NaN)]).filter((value): value is number => value != null && Number.isFinite(value));
    const currentMonth = new Date(now); currentMonth.setUTCDate(1); currentMonth.setUTCHours(0, 0, 0, 0);
    const fiveMonthsOut = new Date(currentMonth); fiveMonthsOut.setUTCMonth(fiveMonthsOut.getUTCMonth() + 5);
    const minDate = dates.length ? Math.min(...dates) : currentMonth.getTime();
    const maxDate = dates.length ? Math.max(...dates) : fiveMonthsOut.getTime();
    const start = new Date(minDate); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    const end = new Date(maxDate); end.setUTCMonth(end.getUTCMonth() + 1, 1); end.setUTCHours(0, 0, 0, 0);
    return { start: start.getTime(), end: end.getTime() };
  }, [calendarForecasts, now]);
  const months = useMemo(() => {
    const values: number[] = [];
    const cursor = new Date(bounds.start);
    while (cursor.getTime() < bounds.end) { values.push(cursor.getTime()); cursor.setUTCMonth(cursor.getUTCMonth() + 1); }
    return values;
  }, [bounds]);

  return <>
    <section className="model-summary">
      <div className="summary-copy"><span className="label">EARLIEST MEDIAN</span><strong>{earliest ? fmtDate(new Date(earliest.median).toISOString(), { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Not available"}</strong><p>{earliest ? <><b>{earliest.model}</b> · {earliest.company}{earliest.q25 != null && earliest.q75 != null ? ` · 50% window ${fmtDate(new Date(earliest.q25).toISOString(), { month: "short", day: "numeric", timeZone: "UTC" })} – ${fmtDate(new Date(earliest.q75).toISOString(), { month: "short", day: "numeric", timeZone: "UTC" })}` : ""}</> : "No model reaches 50% by its last contract."}</p></div>
    </section>

    <article className="panel calendar-panel">
      <PanelHeading kicker="RELEASE CALENDAR" title="Market-implied release dates" aside={generatedAt ? `Updated ${fmtTime(generatedAt)}` : ""} />
      <div className="calendar-wrap">
        {calendarForecasts.length ? <><TimelineAxis bounds={bounds} months={months} now={now} />{calendarForecasts.map((forecast) => {
          const key = `${forecast.company}-${forecast.model}`;
          return <ForecastBand forecast={forecast} bounds={bounds} months={months} now={now} expanded={expandedForecast === key} onToggle={() => setExpandedForecast((current) => current === key ? null : key)} key={key} />;
        })}</> : <EmptyState title={loading ? "Loading contracts…" : "No model has two or more active dated contracts"} compact />}
      </div>
      <div className="calendar-foot"><span>Venues are averaged into one curve per model. Select a row for its contracts.</span><span><i className="outer" /> 80%</span><span><i className="inner" /> 50%</span><span><i className="median" /> Median</span></div>
    </article>

  </>;
}

function TimelineAxis({ bounds, months, now }: { bounds: { start: number; end: number }; months: number[]; now: number }) {
  const today = timePosition(now, bounds);
  return <div className="calendar-axis"><span className="axis-spacer" /><div className="timeline-axis">{months.map((month, index) => {
    // Skip labels the TODAY marker would cover; the first label is left-aligned and wider.
    const position = timePosition(month, bounds);
    if (Math.abs(position - today) < 4 || (index === 0 && today - position < 9)) return null;
    const date = new Date(month);
    const label = fmtDate(date.toISOString(), { month: "short", timeZone: "UTC" }).toUpperCase();
    const showYear = index === 0 || date.getUTCMonth() === 0;
    return <span className={index === 0 ? "first" : index === months.length - 1 ? "last" : ""} style={{ left: `${position}%` }} key={month}>{label}{showYear ? ` · ${date.getUTCFullYear()}` : ""}</span>;
  })}<i className="today-axis" style={{ left: `${today}%` }}><b>TODAY</b><small>{fmtDate(new Date(now).toISOString(), { month: "short", day: "numeric" }).toUpperCase()}</small></i></div><span>DETAIL</span></div>;
}

function CalendarGuides({ bounds, months, now }: { bounds: { start: number; end: number }; months: number[]; now: number }) {
  const today = timePosition(now, bounds);
  return <><i className="calendar-elapsed" style={{ width: `${today}%` }} />{months.map((month) => <i className="month-rule" style={{ left: `${timePosition(month, bounds)}%` }} key={month} />)}<i className="today-rule" style={{ left: `${today}%` }} /></>;
}

function ForecastBand({ forecast, bounds, months, now, expanded, onToggle }: { forecast: CalendarForecast; bounds: { start: number; end: number }; months: number[]; now: number; expanded: boolean; onToggle: () => void }) {
  const last = timePosition(forecast.lastDeadline, bounds);
  const lastLabel = fmtDate(new Date(forecast.lastDeadline).toISOString(), { month: "short", day: "numeric", timeZone: "UTC" }).toUpperCase();
  const band = (className: string, from: number | null, to: number | null) => {
    if (from == null) return null;
    const left = timePosition(from, bounds);
    return <div className={`${className} ${to == null ? "open-ended" : ""}`} style={{ left: `${left}%`, width: `${Math.max(0, (to == null ? last : timePosition(to, bounds)) - left)}%` }} />;
  };
  const ariaLabel = forecast.median == null
    ? `${forecast.model}: 50 percent not reached by the last contract on ${fmtDate(new Date(forecast.lastDeadline).toISOString())}`
    : `${forecast.model}: market-implied median date ${fmtDate(new Date(forecast.median).toISOString())}`;
  return <div className={`calendar-item ${forecast.color} ${expanded ? "expanded" : ""}`}>
    <button className="calendar-row" type="button" onClick={onToggle} aria-expanded={expanded}>
      <div className="calendar-label"><span><LabLogo company={forecast.company} />{forecast.company}</span><strong>{forecast.model}</strong><small>{forecast.source}</small></div>
      <div className="calendar-track" aria-label={ariaLabel}>
        <CalendarGuides bounds={bounds} months={months} now={now} />
        {band("calendar-outer", forecast.q10, forecast.q90)}
        {band("calendar-inner", forecast.q25, forecast.q75)}
        {forecast.median == null
          ? <div className="calendar-unresolved" style={{ left: `${last}%`, width: `${100 - last}%` }}><span>50% AFTER {lastLabel}</span></div>
          : <div className="calendar-median" style={{ left: `${timePosition(forecast.median, bounds)}%` }}><span>{fmtDate(new Date(forecast.median).toISOString(), { month: "short", day: "numeric", timeZone: "UTC" })}</span></div>}
        {forecast.median != null && (forecast.q75 == null || forecast.q90 == null) && <span className="calendar-tail-label" style={{ left: `${last}%` }}>AFTER {lastLabel}</span>}
      </div>
      <div className="calendar-score"><strong>{forecast.marketCount}</strong><span>CONTRACT{forecast.marketCount === 1 ? "" : "S"}</span><i aria-hidden="true">{expanded ? "−" : "+"}</i></div>
    </button>
    {expanded && <ForecastDetails forecast={forecast} now={now} />}
  </div>;
}

function ForecastDetails({ forecast, now }: { forecast: CalendarForecast; now: number }) {
  const futurePoints = forecast.points.filter((point) => point.deadline && new Date(point.deadline).getTime() > now).sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime());
  const exact = (value: number | null) => value == null ? `After ${fmtDate(new Date(forecast.lastDeadline).toISOString(), { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}` : fmtDate(new Date(value).toISOString(), { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return <div className="contract-drawer">
    <div className="fit-readout"><span><small>10%</small><strong>{exact(forecast.q10)}</strong></span><span><small>25%</small><strong>{exact(forecast.q25)}</strong></span><span className="primary"><small>50% MEDIAN</small><strong>{exact(forecast.median)}</strong></span><span><small>75%</small><strong>{exact(forecast.q75)}</strong></span><span><small>90%</small><strong>{exact(forecast.q90)}</strong></span></div>
    <ForecastHistory forecast={forecast} now={now} />
    <div className="contract-table" role="table" aria-label={`${forecast.model} source contracts`}>
      <div className="contract-table-head" role="row"><span>DEADLINE</span><span>VENUE</span><span>YES</span><span>QUOTE</span><span>ACTIVITY</span><span>MARKET</span></div>
      {futurePoints.map((point) => <a href={point.url} target="_blank" rel="noreferrer" role="row" key={`${point.venue}-${point.symbol ?? point.title}-${point.deadline}`}>
        <strong>{fmtDate(point.deadline, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}</strong><span>{point.venue}</span><b>{pct(point.probability)}</b><span>{point.quoteKind}</span><span>{point.volumeLabel}</span><span className="market-link">OPEN ↗</span>
      </a>)}
    </div>
  </div>;
}

function ForecastHistory({ forecast, now }: { forecast: CalendarForecast; now: number }) {
  const [history, setHistory] = useState<Array<{ observedAt: number; median: number }> | null>(null);
  const [failed, setFailed] = useState(false);
  const contracts = useMemo(() => forecast.points.filter((point) => point.venue === "Polymarket" && point.tokenId && point.deadline), [forecast.points]);
  useEffect(() => {
    let active = true;
    if (contracts.length < 2) return;
    void Promise.all(contracts.slice(0, 12).map(async (contract) => {
      const response = await fetch(`https://clob.polymarket.com/prices-history?market=${encodeURIComponent(contract.tokenId!)}&interval=1m&fidelity=60`);
      if (!response.ok) throw new Error(`History returned ${response.status}`);
      const payload = await response.json() as { history?: Array<{ t: number | string; p: number | string }> };
      return { deadline: contract.deadline, tokenId: contract.tokenId, history: (payload.history ?? []).map((point) => ({ t: Number(point.t), p: Number(point.p) })).filter((point) => Number.isFinite(point.t) && Number.isFinite(point.p)) as PriceHistoryPoint[] };
    })).then((values) => { if (active) setHistory(buildMedianHistory(values, now)); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [contracts, now]);
  // Price history comes from Polymarket only; other venues have nothing to show here.
  if (contracts.length < 2) return null;
  if (failed) return <div className="history-empty"><strong>FORECAST MOVEMENT</strong><span>Price history is temporarily unavailable.</span></div>;
  if (!history) return <div className="history-empty"><strong>FORECAST MOVEMENT</strong><span>Loading Polymarket price history…</span></div>;
  if (history.length < 2) return <div className="history-empty"><strong>FORECAST MOVEMENT</strong><span>Not enough history to compare the median.</span></div>;
  const movement = weeklyMedianMovement(history);
  const minX = history[0].observedAt, maxX = history.at(-1)!.observedAt;
  const medians = history.map((point) => point.median), minY = Math.min(...medians), maxY = Math.max(...medians);
  const x = (value: number) => 12 + (value - minX) / Math.max(1, maxX - minX) * 476;
  const y = (value: number) => 82 - (value - minY) / Math.max(1, maxY - minY) * 64;
  const movementText = movement == null ? "Weekly comparison unavailable" : movement === 0 ? "Median unchanged this week" : `Median moved ${Math.abs(movement)} day${Math.abs(movement) === 1 ? "" : "s"} ${movement < 0 ? "earlier" : "later"} this week`;
  return <div className="forecast-history"><div><span>POLYMARKET FORECAST MOVEMENT</span><strong>{movementText}</strong></div><svg viewBox="0 0 500 96" role="img" aria-label={movementText}><polyline points={history.map((point) => `${x(point.observedAt)},${y(point.median)}`).join(" ")} /><circle cx={x(history.at(-1)!.observedAt)} cy={y(history.at(-1)!.median)} r="4" /><text x="488" y={Math.max(12, y(history.at(-1)!.median) - 7)} textAnchor="end">{fmtDate(new Date(history.at(-1)!.median).toISOString(), { month: "short", day: "numeric", timeZone: "UTC" })}</text></svg></div>;
}

function PanelHeading({ kicker, title, aside }: { kicker: string; title: string; aside: string }) {
  return <div className="panel-heading"><div><span>{kicker}</span><h2>{title}</h2></div><small>{aside}</small></div>;
}

function EmptyState({ title, detail, compact = false }: { title: string; detail?: string; compact?: boolean }) {
  return <div className={`empty-state ${compact ? "compact" : ""}`}><strong>{title}</strong>{detail && <span>{detail}</span>}</div>;
}
