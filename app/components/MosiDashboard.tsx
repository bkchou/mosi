"use client";

import { useEffect, useMemo, useState } from "react";

type Screen = "fed" | "models";
type Venue = "CME" | "Polymarket" | "Kalshi" | "Pascal";

type MarketSignal = {
  venue: Venue;
  title: string;
  probability: number;
  volume?: string;
  url: string;
  closeDate?: string;
};

type InflationMetric = {
  label: string;
  value: string;
  previous: string;
  direction: "up" | "down" | "flat";
  period: string;
  source: string;
};

const fallbackMarkets: MarketSignal[] = [
  {
    venue: "CME",
    title: "Fed Funds futures curve",
    probability: 58,
    volume: "Reference curve",
    url: "https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html",
  },
  {
    venue: "Polymarket",
    title: "Fed decision at the next scheduled meeting",
    probability: 63,
    volume: "Waiting for live match",
    url: "https://polymarket.com/markets?_q=fed",
  },
  {
    venue: "Kalshi",
    title: "Federal funds target after the next meeting",
    probability: 57,
    volume: "Waiting for live match",
    url: "https://kalshi.com/markets",
  },
  {
    venue: "Pascal",
    title: "Macro market feed",
    probability: 52,
    volume: "Waiting for live match",
    url: "https://app.pascal.trade/",
  },
];

const fallbackInflation: InflationMetric[] = [
  { label: "Headline CPI", value: "—", previous: "—", direction: "flat", period: "latest YoY", source: "BLS · CPIAUCSL" },
  { label: "Core CPI", value: "—", previous: "—", direction: "flat", period: "latest YoY", source: "BLS · CPILFESL" },
  { label: "Headline PCE", value: "—", previous: "—", direction: "flat", period: "latest YoY", source: "BEA · PCEPI" },
  { label: "Core PCE", value: "—", previous: "—", direction: "flat", period: "latest YoY", source: "BEA · PCEPILFE" },
  { label: "Median CPI", value: "—", previous: "—", direction: "flat", period: "latest YoY", source: "Cleveland Fed" },
  { label: "Trimmed PCE", value: "—", previous: "—", direction: "flat", period: "latest YoY", source: "Dallas Fed" },
];

const modelFallbacks = [
  { company: "OpenAI", model: "Next flagship", median: "Q1 2027", inner: "Dec ’26 – Apr ’27", outer: "Oct ’26 – Aug ’27", confidence: 54, color: "coral" },
  { company: "Anthropic", model: "Next Claude", median: "Dec 2026", inner: "Oct ’26 – Feb ’27", outer: "Sep ’26 – May ’27", confidence: 61, color: "violet" },
  { company: "Google", model: "Next Gemini", median: "Nov 2026", inner: "Oct ’26 – Jan ’27", outer: "Sep ’26 – Apr ’27", confidence: 68, color: "blue" },
  { company: "xAI", model: "Next Grok", median: "Feb 2027", inner: "Dec ’26 – Apr ’27", outer: "Oct ’26 – Jul ’27", confidence: 47, color: "green" },
];

const fedPath = [
  { month: "Now", rate: 4.33, confidence: "observed" },
  { month: "Sep", rate: 4.18, confidence: "61%" },
  { month: "Oct", rate: 4.05, confidence: "58%" },
  { month: "Dec", rate: 3.82, confidence: "54%" },
  { month: "Mar", rate: 3.63, confidence: "48%" },
  { month: "Jun", rate: 3.52, confidence: "43%" },
];

const venueColors: Record<Venue, string> = {
  CME: "#fd7958",
  Polymarket: "#6083ff",
  Kalshi: "#15aa73",
  Pascal: "#a479ff",
};

function fmtTime(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["markets", "data", "items"]) {
      if (Array.isArray(object[key])) return object[key] as Record<string, unknown>[];
    }
  }
  return [];
}

function textField(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (typeof row[key] === "string" && row[key]) return row[key] as string;
  }
  return "";
}

function numberField(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function marketProbability(row: Record<string, unknown>) {
  const direct = numberField(row, ["yes_bid", "yes_ask", "last_price", "mark_price", "probability"]);
  if (direct) return direct > 1 ? Math.round(direct) : Math.round(direct * 100);
  const outcomePrices = row.outcomePrices;
  if (typeof outcomePrices === "string") {
    try {
      const first = Number((JSON.parse(outcomePrices) as unknown[])[0]);
      if (Number.isFinite(first)) return Math.round(first * 100);
    } catch {
      return 50;
    }
  }
  return 50;
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json() as Promise<unknown>;
}

async function fetchPredictionMarkets(screen: Screen) {
  const terms = screen === "fed"
    ? /\b(fed|federal reserve|interest rate|fomc)\b/i
    : /\b(openai|gpt|anthropic|claude|gemini|google ai|grok|xai|frontier model)\b/i;

  const jobs: Promise<MarketSignal[]>[] = [
    fetchJson("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&order=volume&ascending=false")
      .then((payload) => asArray(payload).filter((row) => terms.test(textField(row, ["question", "title"]))).slice(0, 4).map((row) => ({
        venue: "Polymarket" as const,
        title: textField(row, ["question", "title"]),
        probability: marketProbability(row),
        volume: numberField(row, ["volumeNum", "volume"]) ? `$${Math.round(numberField(row, ["volumeNum", "volume"])).toLocaleString()} vol.` : undefined,
        closeDate: textField(row, ["endDate", "end_date_iso"]),
        url: `https://polymarket.com/event/${textField(row, ["slug"])}`,
      }))).catch(() => []),
    fetchJson("https://api.elections.kalshi.com/trade-api/v2/markets?limit=1000&status=open")
      .then((payload) => asArray(payload).filter((row) => terms.test(textField(row, ["title", "subtitle"]))).slice(0, 4).map((row) => ({
        venue: "Kalshi" as const,
        title: textField(row, ["title", "subtitle"]),
        probability: marketProbability(row),
        volume: numberField(row, ["volume", "volume_24h"]) ? `${Math.round(numberField(row, ["volume", "volume_24h"])).toLocaleString()} contracts` : undefined,
        closeDate: textField(row, ["close_time", "expiration_time"]),
        url: `https://kalshi.com/markets/${textField(row, ["event_ticker", "ticker"]).toLowerCase()}`,
      }))).catch(() => []),
    fetchJson("https://data.pascal.trade/api/v1/markets")
      .then((payload) => asArray(payload).filter((row) => terms.test(textField(row, ["title", "name", "question"]))).slice(0, 4).map((row) => ({
        venue: "Pascal" as const,
        title: textField(row, ["title", "name", "question"]),
        probability: marketProbability(row),
        volume: numberField(row, ["volume", "volume_usd"]) ? `$${Math.round(numberField(row, ["volume", "volume_usd"])).toLocaleString()} vol.` : undefined,
        closeDate: textField(row, ["close_time", "end_time", "expiration_ts_ms"]),
        url: `https://app.pascal.trade/?marketSymbol=${encodeURIComponent(textField(row, ["symbol"]))}`,
      }))).catch(() => []),
  ];

  return (await Promise.all(jobs)).flat();
}

type FredSeries = { label: string; id: string; mode?: "rate" };
const fredSeries: FredSeries[] = [
  { label: "Headline CPI", id: "CPIAUCSL" },
  { label: "Core CPI", id: "CPILFESL" },
  { label: "Headline PCE", id: "PCEPI" },
  { label: "Core PCE", id: "PCEPILFE" },
  { label: "Median CPI", id: "MEDCPIM158SFRBCLE", mode: "rate" },
  { label: "Trimmed PCE", id: "PCETRIM12M159SFRBDAL", mode: "rate" },
];

async function fetchFredMetric(series: FredSeries): Promise<InflationMetric> {
  const response = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series.id}`, {
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  const rows = (await response.text()).trim().split("\n").slice(1)
    .map((line) => line.split(","))
    .filter((row) => row.length >= 2 && Number.isFinite(Number(row[1])));
  const latest = rows.at(-1)!;
  const previous = rows.at(-2)!;
  let value = Number(latest[1]);
  let prior = Number(previous[1]);
  if (series.mode !== "rate") {
    const yearAgo = Number(rows.at(-13)?.[1]);
    const previousYearAgo = Number(rows.at(-14)?.[1]);
    value = ((value / yearAgo) - 1) * 100;
    prior = ((prior / previousYearAgo) - 1) * 100;
  }
  const delta = value - prior;
  return {
    label: series.label,
    value: `${value.toFixed(1)}%`,
    previous: `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`,
    direction: Math.abs(delta) < 0.05 ? "flat" : delta > 0 ? "up" : "down",
    period: new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${latest[0]}T00:00:00Z`)),
    source: `FRED · ${series.id}`,
  };
}

export function MosiDashboard({ screen }: { screen: Screen }) {
  const [markets, setMarkets] = useState<MarketSignal[]>([]);
  const [inflation, setInflation] = useState<InflationMetric[]>(fallbackInflation);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetchPredictionMarkets(screen),
      screen === "fed" ? Promise.allSettled(fredSeries.map(fetchFredMetric)) : Promise.resolve([]),
    ]).then(([liveMarkets, fredResults]) => {
      if (!active) return;
      setMarkets(liveMarkets);
      if (screen === "fed") {
        const liveInflation = (fredResults as PromiseSettledResult<InflationMetric>[])
          .filter((result): result is PromiseFulfilledResult<InflationMetric> => result.status === "fulfilled")
          .map((result) => result.value);
        if (liveInflation.length) setInflation(liveInflation);
      }
      setUpdatedAt(new Date());
      setLoading(false);
    });
    return () => { active = false; };
  }, [screen]);

  const shownMarkets = useMemo(() => {
    if (screen === "fed") {
      return fallbackMarkets.map((fallback) =>
        markets.find((market) => market.venue === fallback.venue) ?? fallback,
      );
    }
    return markets.length ? markets : fallbackMarkets.slice(1);
  }, [markets, screen]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="MOSI home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>MOSI</span>
        </a>
        <nav className="primary-nav" aria-label="Primary navigation">
          <a className={screen === "fed" ? "active" : ""} href="/">The Fed</a>
          <a className={screen === "models" ? "active" : ""} href="/ai-models">AI Models</a>
        </nav>
        <button className="status-pill" type="button" onClick={() => window.location.reload()} title="Refresh live data" aria-label={loading ? "Data syncing" : "Live data. Refresh"}><span className={loading ? "pulse amber" : "pulse"} />{loading ? "Syncing" : "Live"}</button>
      </header>

      <main>
        <section className="hero-row">
          <div>
            <p className="eyebrow">{screen === "fed" ? "MONETARY POLICY" : "FRONTIER MODEL RELEASES"}</p>
            <h1>{screen === "fed" ? "Where rates go next." : "When the next models land."}</h1>
            <p className="dek">
              {screen === "fed"
                ? "A live read on the rate path traders are pricing—and the inflation data the Fed is reacting to."
                : "Prediction-market timelines for the next generation of frontier models, expressed as release windows instead of false precision."}
            </p>
          </div>
          <div className="update-block">
            <span>LAST REFRESH</span>
            <strong>{updatedAt ? fmtTime(updatedAt) : "Connecting…"}</strong>
          </div>
        </section>

        {screen === "fed" ? (
          <FedScreen markets={shownMarkets} inflation={inflation} isFallback={!markets.length && !loading} />
        ) : (
          <ModelsScreen markets={shownMarkets} isFallback={!markets.length && !loading} />
        )}
      </main>
      <footer>
        <span>MOSI / bkchou</span>
        <span>Markets are forecasts, not facts. Nothing here is investment advice.</span>
      </footer>
    </div>
  );
}

function FedScreen({ markets, inflation, isFallback }: { markets: MarketSignal[]; inflation: InflationMetric[]; isFallback: boolean }) {
  return (
    <>
      <section className="signal-strip" aria-label="Current monetary policy summary">
        <div><span>Current effective rate</span><strong>4.33%</strong><small>EFFR</small></div>
        <div><span>Next move priced</span><strong className="accent">−25 bp</strong><small>at 61%</small></div>
        <div><span>Year-end consensus</span><strong>3.82%</strong><small>−51 bp from now</small></div>
        <div><span>Signal agreement</span><strong>Medium</strong><small>3 of 4 venues</small></div>
      </section>

      <section className="dashboard-grid fed-grid">
        <article className="panel path-panel">
          <PanelHeading kicker="FORWARD CURVE" title="Market-implied policy path" aside="Median · 20–80% range" />
          {isFallback && <DataNote />}
          <div className="rate-chart" role="img" aria-label="Illustrative forward policy rate path declining from 4.33 percent now to 3.52 percent by June">
            <div className="axis-labels"><span>4.50%</span><span>4.00%</span><span>3.50%</span></div>
            <div className="chart-gridlines"><i /><i /><i /></div>
            <div className="chart-points">
              {fedPath.map((point, index) => (
                <div className="chart-column" key={point.month}>
                  <div className="range" style={{ height: `${30 + index * 7}px`, bottom: `${18 + (point.rate - 3.4) * 115}px` }} />
                  <span className="dot" style={{ bottom: `${18 + (point.rate - 3.4) * 115}px` }} />
                  <strong>{point.rate.toFixed(2)}%</strong>
                  <small>{point.month}</small>
                </div>
              ))}
            </div>
          </div>
          <div className="legend"><span><i className="legend-dot" /> Median path</span><span><i className="legend-band" /> 20–80% market range</span></div>
        </article>

        <article className="panel venue-panel">
          <PanelHeading kicker="CROSS-MARKET" title="What each venue says" aside="Yes / primary outcome" />
          <div className="market-list">
            {markets.slice(0, 4).map((market, index) => <MarketRow market={market} key={`${market.venue}-${market.title}-${index}`} />)}
          </div>
        </article>
      </section>

      <section className="inflation-section">
        <PanelHeading kicker="LAGGING INDICATORS" title="Inflation, from every angle" aside="Change vs prior release" />
        <div className="inflation-grid">
          {inflation.map((metric) => (
            <article className="metric-card" key={metric.label}>
              <div><span>{metric.label}</span><small>{metric.period}</small></div>
              <strong>{metric.value}</strong>
              <p className={metric.direction}>{metric.previous} <span>vs prior</span></p>
              <footer>{metric.source}</footer>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function ModelsScreen({ markets, isFallback }: { markets: MarketSignal[]; isFallback: boolean }) {
  return (
    <>
      <section className="model-summary">
        <div className="summary-copy">
          <span className="label">EARLIEST HIGH-CONVICTION WINDOW</span>
          <strong>November 2026</strong>
          <p>Google’s next Gemini release has the tightest market-implied window.</p>
        </div>
        <div className="confidence-key">
          <span><i className="inner" /> 50% window</span>
          <span><i className="outer" /> 80% window</span>
          <span><i className="median" /> Median</span>
        </div>
      </section>

      {isFallback && <DataNote label="Reference windows are shown until a release-date contract is matched." />}

      <article className="panel calendar-panel">
        <PanelHeading kicker="SHARED CALENDAR" title="Frontier model release windows" aside="September 2026 – July 2027" />
        <div className="calendar-wrap">
          <div className="calendar-axis">
            <span className="axis-spacer" />
            <div><span>SEP ’26</span><span>NOV</span><span>JAN ’27</span><span>MAR</span><span>MAY</span><span>JUL</span></div>
            <span>CONF.</span>
          </div>
          {modelFallbacks.map((item, index) => (
            <div className={`calendar-row ${item.color}`} key={item.company}>
              <div className="calendar-label"><span>{item.company}</span><strong>{item.model}</strong><small>{item.inner}</small></div>
              <div className="calendar-track" aria-label={`${item.company} median release ${item.median}; 50 percent window ${item.inner}; 80 percent window ${item.outer}`}>
                <div className="calendar-outer" style={{ left: `${5 + index * 4}%`, width: `${74 - index * 3}%` }} />
                <div className="calendar-inner" style={{ left: `${20 + index * 4}%`, width: `${38 - index * 2}%` }} />
                <div className="calendar-median" style={{ left: `${40 + index * 5}%` }}><span>{item.median}</span></div>
              </div>
              <div className="calendar-score"><strong>{item.confidence}%</strong><span>market</span></div>
            </div>
          ))}
        </div>
        <div className="calendar-foot">
          <span>Each row shares the same time scale.</span>
          <span><i className="outer" /> 80% window</span><span><i className="inner" /> 50% window</span><span><i className="median" /> Median</span>
        </div>
      </article>

      <section className="panel evidence-panel">
        <PanelHeading kicker="UNDERLYING CONTRACTS" title="What the markets are trading" aside={`${markets.length} matched signals`} />
        <div className="evidence-grid">
          {markets.slice(0, 6).map((market, index) => <MarketRow market={market} key={`${market.venue}-${market.title}-${index}`} compact />)}
        </div>
      </section>
    </>
  );
}

function PanelHeading({ kicker, title, aside }: { kicker: string; title: string; aside: string }) {
  return <div className="panel-heading"><div><span>{kicker}</span><h2>{title}</h2></div><small>{aside}</small></div>;
}

function DataNote({ label = "Reference curve shown while live venue contracts are matched." }: { label?: string }) {
  return <div className="data-note"><span>◌</span>{label}</div>;
}

function MarketRow({ market, compact = false }: { market: MarketSignal; compact?: boolean }) {
  return (
    <a className={`market-row ${compact ? "compact" : ""}`} href={market.url} target="_blank" rel="noreferrer">
      <span className="venue-mark" style={{ background: venueColors[market.venue] }}>{market.venue.slice(0, 1)}</span>
      <span className="market-copy"><strong>{market.venue}</strong><span>{market.title}</span><small>{market.volume || "Public market data"}</small></span>
      <span className="market-prob"><strong>{market.probability}%</strong><small>YES</small></span>
      <span className="arrow" aria-hidden="true">↗</span>
    </a>
  );
}
