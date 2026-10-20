import type { KalshiEnv } from "./kalshi.ts";
import {
  CACHE_TTL, CLEVELAND_NOWCAST, FRED_CSV, fetchJson, fetchText, finiteNumber, getFedSnapshot, kalshiQuote, loadKalshiSeries, loadProvider,
  overallStatus, polymarketQuote, record, records, searchPolymarket, stringValue,
  type DataSnapshot, type JsonRecord, type MarketQuote,
} from "../api/data.ts";

const CLEVELAND_MONTHLY_NOWCAST = "https://www.clevelandfed.org/-/media/files/webcharts/inflationnowcasting/nowcast_month.json";
const CLEVELAND_NOWCAST_PAGE = "https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting";
const GDPNOW_PAGE = "https://www.atlantafed.org/cqer/research/gdpnow";

export type Observation = { period: string; value: number };

export function parseFredCsv(csv: string): Observation[] {
  return csv.trim().split(/\r?\n/).slice(1).flatMap((line) => {
    const [period, raw] = line.split(",");
    const value = finiteNumber(raw === "." ? null : raw);
    return period && value != null ? [{ period, value }] : [];
  });
}

async function fredSeries(id: string, start: string) {
  return parseFredCsv(await fetchText(`${FRED_CSV}?id=${encodeURIComponent(id)}&cosd=${start}`, "text/csv", 20000));
}

function isoYearsAgo(years: number, now = new Date()) {
  const date = new Date(now); date.setUTCFullYear(date.getUTCFullYear() - years); date.setUTCDate(1);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Next data print: Kalshi "above X" ladders turned into a distribution.

export type Threshold = { strike: number; probability: number };

/** Pool-adjacent-violators fit so P(value > strike) never rises with the strike. */
export function monotoneSurvival(points: Threshold[]): Threshold[] {
  const sorted = [...points].sort((a, b) => a.strike - b.strike);
  const blocks: Array<{ sum: number; count: number }> = [];
  for (const point of sorted) {
    blocks.push({ sum: Math.min(1, Math.max(0, point.probability)), count: 1 });
    while (blocks.length > 1 && blocks.at(-2)!.sum / blocks.at(-2)!.count < blocks.at(-1)!.sum / blocks.at(-1)!.count) {
      const last = blocks.pop()!;
      blocks.at(-1)!.sum += last.sum; blocks.at(-1)!.count += last.count;
    }
  }
  const fitted = blocks.flatMap((block) => Array.from({ length: block.count }, () => block.sum / block.count));
  return sorted.map((point, index) => ({ strike: point.strike, probability: fitted[index] }));
}

export type Bucket = { low: number | null; high: number | null; probability: number };

/**
 * Buckets follow the contract boundaries: (low, high], with open tails. Strikes the market
 * treats as near-certain on either end are folded into the tails.
 */
export function thresholdDistribution(points: Threshold[], resolution: number) {
  const survival = monotoneSurvival(points);
  if (survival.length < 2) return null;
  const first = Math.max(0, survival.findLastIndex((point) => point.probability >= .98));
  const lastCandidate = survival.findIndex((point) => point.probability <= .02);
  const last = lastCandidate < 0 ? survival.length - 1 : Math.max(first + 1, lastCandidate);
  const kept = survival.slice(first, last + 1);
  const buckets: Bucket[] = [
    { low: null, high: kept[0].strike, probability: 1 - kept[0].probability },
    ...kept.slice(1).map((point, index) => ({ low: kept[index].strike, high: point.strike, probability: kept[index].probability - point.probability })),
    { low: kept.at(-1)!.strike, high: null, probability: kept.at(-1)!.probability },
  ];
  const crossing = survival.findIndex((point) => point.probability <= .5);
  let median: number | null = null;
  let medianBound: "below" | "above" | null = null;
  if (crossing === 0) { median = survival[0].strike; medianBound = "below"; }
  else if (crossing < 0) { median = survival.at(-1)!.strike; medianBound = "above"; }
  else {
    const previous = survival[crossing - 1], current = survival[crossing];
    const share = (previous.probability - .5) / Math.max(1e-9, previous.probability - current.probability);
    const interpolated = previous.strike + share * (current.strike - previous.strike);
    // When contracts sit one reporting step apart, (low, high] holds a single print: high.
    median = current.strike - previous.strike <= resolution + 1e-9 ? current.strike : Math.round(interpolated / resolution) * resolution;
  }
  return { buckets, median: median == null ? null : Number(median.toFixed(6)), medianBound, survival };
}

type PriorKind = "mom" | "yoy" | "diff" | "level";
type PrintSpec = {
  key: string;
  series: string;
  label: string;
  detail: string;
  unit: "%" | "k";
  resolution: number;
  fred: string;
  prior: PriorKind;
  priorScale?: number;
  cadence: "month" | "quarter";
  nowcast?: { kind: "cleveland-month" | "cleveland-year"; name: string } | { kind: "gdpnow" };
  publisher: string;
};

export const PRINT_SPECS: PrintSpec[] = [
  { key: "cpi", series: "KXCPI", label: "CPI", detail: "Headline · month over month", unit: "%", resolution: .1, fred: "CPIAUCSL", prior: "mom", cadence: "month", nowcast: { kind: "cleveland-month", name: "CPI Inflation" }, publisher: "BLS" },
  { key: "core-cpi", series: "KXCPICORE", label: "Core CPI", detail: "Ex food & energy · month over month", unit: "%", resolution: .1, fred: "CPILFESL", prior: "mom", cadence: "month", nowcast: { kind: "cleveland-month", name: "Core CPI Inflation" }, publisher: "BLS" },
  { key: "cpi-yoy", series: "KXCPIYOY", label: "CPI", detail: "Headline · year over year", unit: "%", resolution: .1, fred: "CPIAUCNS", prior: "yoy", cadence: "month", nowcast: { kind: "cleveland-year", name: "CPI Inflation" }, publisher: "BLS" },
  { key: "core-cpi-yoy", series: "KXCPICOREYOY", label: "Core CPI", detail: "Ex food & energy · year over year", unit: "%", resolution: .1, fred: "CPILFENS", prior: "yoy", cadence: "month", nowcast: { kind: "cleveland-year", name: "Core CPI Inflation" }, publisher: "BLS" },
  { key: "core-pce", series: "KXPCECORE", label: "Core PCE", detail: "Ex food & energy · month over month", unit: "%", resolution: .1, fred: "PCEPILFE", prior: "mom", cadence: "month", nowcast: { kind: "cleveland-month", name: "Core PCE Inflation" }, publisher: "BEA" },
  { key: "payrolls", series: "KXPAYROLLS", label: "Nonfarm payrolls", detail: "Monthly change", unit: "k", resolution: 1000, fred: "PAYEMS", prior: "diff", priorScale: 1000, cadence: "month", publisher: "BLS" },
  { key: "unemployment", series: "KXU3", label: "Unemployment rate", detail: "U-3 · seasonally adjusted", unit: "%", resolution: .1, fred: "UNRATE", prior: "level", cadence: "month", publisher: "BLS" },
  { key: "gdp", series: "KXGDP", label: "Real GDP", detail: "Advance estimate · annualized q/q", unit: "%", resolution: .1, fred: "A191RL1Q225SBEA", prior: "level", cadence: "quarter", nowcast: { kind: "gdpnow" }, publisher: "BEA" },
];

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/** The reference period from a Kalshi event ticker, as the first day of the month or quarter. */
export function printPeriod(eventTicker: string, cadence: PrintSpec["cadence"]) {
  const match = eventTicker.match(/-(\d{2})([A-Z]{3})(\d{2})?$/);
  if (!match || !MONTHS[match[2]]) return null;
  const year = 2000 + Number(match[1]);
  const month = MONTHS[match[2]];
  if (cadence === "month") return `${year}-${String(month).padStart(2, "0")}-01`;
  // GDP events are named for the release date; the advance estimate covers the prior quarter.
  const releaseQuarter = Math.floor((month - 1) / 3);
  const quarter = (releaseQuarter + 3) % 4;
  return `${releaseQuarter === 0 ? year - 1 : year}-${String(quarter * 3 + 1).padStart(2, "0")}-01`;
}

export function transformPrints(observations: Observation[], kind: PriorKind, scale = 1): Observation[] {
  if (kind === "level") return observations;
  const byPeriod = new Map(observations.map((point) => [point.period, point.value]));
  return observations.flatMap((point, index) => {
    if (kind === "diff" || kind === "mom") {
      const previous = observations[index - 1];
      if (!previous) return [];
      return [{ period: point.period, value: kind === "diff" ? (point.value - previous.value) * scale : (point.value / previous.value - 1) * 100 }];
    }
    const date = new Date(`${point.period}T00:00:00Z`); date.setUTCFullYear(date.getUTCFullYear() - 1);
    const yearAgo = byPeriod.get(date.toISOString().slice(0, 10));
    return yearAgo ? [{ period: point.period, value: (point.value / yearAgo - 1) * 100 }] : [];
  });
}

/** Releases happen on the half hour after Kalshi closes trading (8:25 or 8:29 AM ET). */
export function releaseTime(closeTime: string) {
  const timestamp = Date.parse(closeTime);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(Math.ceil(timestamp / 1_800_000) * 1_800_000).toISOString();
}

export function nextPrintEvent(markets: JsonRecord[], now = Date.now()) {
  const upcoming = markets.filter((market) => Date.parse(stringValue(market.close_time)) > now && finiteNumber(market.floor_strike) != null && stringValue(market.strike_type) === "greater");
  const eventTicker = upcoming.sort((a, b) => stringValue(a.close_time).localeCompare(stringValue(b.close_time)))[0]?.event_ticker;
  return eventTicker ? upcoming.filter((market) => market.event_ticker === eventTicker) : [];
}

export type ClevelandNowcasts = Map<string, number>;

/** Keys are `<series name>|<YYYY-MM-01>`, using the latest daily estimate for each target month. */
export function parseClevelandNowcasts(payload: unknown): ClevelandNowcasts {
  const result: ClevelandNowcasts = new Map();
  for (const chart of records(payload)) {
    const match = stringValue(record(chart.chart).subcaption).match(/^(\d{4})-(\d{1,2})$/);
    if (!match) continue;
    const period = `${match[1]}-${match[2].padStart(2, "0")}-01`;
    for (const series of records(chart.dataset)) {
      const name = stringValue(series.seriesname);
      if (name.startsWith("Actual")) continue;
      const value = records(series.data).map((item) => finiteNumber(item.value)).filter((item): item is number => item != null).at(-1);
      if (value != null) result.set(`${name}|${period}`, value);
    }
  }
  return result;
}

type PrintInputs = {
  markets: JsonRecord[];
  observations: Observation[];
  clevelandMonth: ClevelandNowcasts;
  clevelandYear: ClevelandNowcasts;
  gdpNow: Observation[];
};

export function buildPrint(spec: PrintSpec, inputs: PrintInputs, now = Date.now()) {
  const markets = nextPrintEvent(inputs.markets, now);
  if (!markets.length) return null;
  const eventTicker = stringValue(markets[0].event_ticker);
  const period = printPeriod(eventTicker, spec.cadence);
  const quotes = markets.flatMap((market) => {
    const quote = kalshiQuote(market);
    return quote ? [{ strike: finiteNumber(market.floor_strike)!, quote }] : [];
  }).sort((a, b) => a.strike - b.strike);
  const distribution = thresholdDistribution(quotes.map(({ strike, quote }) => ({ strike, probability: quote.probability / 100 })), spec.resolution);
  if (!distribution || !period) return null;
  const prints = transformPrints(inputs.observations, spec.prior, spec.priorScale);
  const last = prints.filter((point) => point.period < period).at(-1) ?? null;
  let nowcast: { value: number; source: string; sourceUrl: string } | null = null;
  if (spec.nowcast?.kind === "gdpnow") {
    const value = inputs.gdpNow.find((point) => point.period === period)?.value;
    if (value != null) nowcast = { value, source: "Atlanta Fed GDPNow", sourceUrl: GDPNOW_PAGE };
  } else if (spec.nowcast) {
    const value = (spec.nowcast.kind === "cleveland-month" ? inputs.clevelandMonth : inputs.clevelandYear).get(`${spec.nowcast.name}|${period}`);
    if (value != null) nowcast = { value, source: "Cleveland Fed nowcast", sourceUrl: CLEVELAND_NOWCAST_PAGE };
  }
  const closeTime = stringValue(markets[0].close_time);
  const volume = quotes.reduce((sum, { quote }) => sum + (quote.volume ?? 0), 0);
  return {
    key: spec.key,
    label: spec.label,
    detail: spec.detail,
    unit: spec.unit,
    resolution: spec.resolution,
    cadence: spec.cadence,
    period,
    releaseAt: releaseTime(closeTime),
    eventTicker,
    url: `https://kalshi.com/markets/${spec.series.toLowerCase()}`,
    volume,
    median: distribution.median,
    medianBound: distribution.medianBound,
    buckets: distribution.buckets,
    thresholds: quotes.map(({ strike, quote }, index) => ({ strike, probability: distribution.survival[index].probability * 100, quote })),
    last: last && { ...last, source: `${spec.publisher} via FRED`, sourceUrl: `https://fred.stlouisfed.org/series/${spec.fred}` },
    history: prints.filter((point) => point.period < period).slice(-12),
    nowcast,
  };
}

export type PrintsData = { prints: Array<NonNullable<ReturnType<typeof buildPrint>>> };

export async function getPrintsSnapshot(force = false, env: KalshiEnv = {}): Promise<DataSnapshot<PrintsData>> {
  const start = isoYearsAgo(3);
  const fredIds = [...new Set([...PRINT_SPECS.map((spec) => spec.fred), "GDPNOW"])];
  const [kalshi, fred, clevelandMonth, clevelandYear] = await Promise.all([
    Promise.all(PRINT_SPECS.map((spec) => loadKalshiSeries(spec.series, `Kalshi ${spec.series}`, force, env))),
    loadProvider("prints-fred", "FRED economic data", CACHE_TTL.inflation, async () => {
      const results = await Promise.all(fredIds.map(async (id) => [id, await fredSeries(id, start)] as const));
      return Object.fromEntries(results);
    }, force),
    loadProvider("prints-cleveland-month", "Cleveland Fed monthly nowcast", CACHE_TTL.nowcasts, async () => [...parseClevelandNowcasts(await fetchJson(CLEVELAND_MONTHLY_NOWCAST, 20000))], force),
    loadProvider("prints-cleveland-year", "Cleveland Fed annual nowcast", CACHE_TTL.nowcasts, async () => [...parseClevelandNowcasts(await fetchJson(CLEVELAND_NOWCAST, 20000))], force),
  ]);
  const fredValues = fred.value ?? {};
  const prints = PRINT_SPECS.flatMap((spec, index) => buildPrint(spec, {
    markets: kalshi[index].value ?? [],
    observations: fredValues[spec.fred] ?? [],
    clevelandMonth: new Map(clevelandMonth.value ?? []),
    clevelandYear: new Map(clevelandYear.value ?? []),
    gdpNow: fredValues.GDPNOW ?? [],
  }) ?? []).sort((a, b) => (a.releaseAt ?? "").localeCompare(b.releaseAt ?? ""));
  // Kalshi health is summarized as one source so the status pill stays readable.
  const kalshiHealth = kalshi.every((load) => load.health.status === "live") ? kalshi[0].health
    : kalshi.find((load) => load.health.status !== "live")!.health;
  const sources = [{ ...kalshiHealth, source: "Kalshi economic contracts" }, fred.health, clevelandMonth.health, clevelandYear.health];
  return { generatedAt: new Date().toISOString(), status: overallStatus(sources), sources, data: { prints } };
}

/** The Fed page carries the next data prints alongside the rate markets they move. */
export async function getFedPageSnapshot(force = false, env: KalshiEnv = {}) {
  const [fed, prints] = await Promise.all([getFedSnapshot(force, env), getPrintsSnapshot(force, env)]);
  const status = fed.status === "live" && prints.status === "live" ? "live" : fed.status === "stale" && prints.status === "stale" ? "stale" : "partial";
  return { ...fed, status, sources: [...fed.sources, ...prints.sources], data: { ...fed.data, prints: prints.data.prints } } satisfies DataSnapshot<unknown>;
}

// ---------------------------------------------------------------------------
// Recession watch.

type IndicatorSpec = {
  key: string;
  fred: string;
  label: string;
  detail: string;
  unit: "pp" | "bp" | "%" | "k";
  threshold?: { value: number; direction: "above" | "below"; label: string };
  daily?: boolean;
  scale?: number;
  /** Values the chart's y-axis must include, so a quiet series is not magnified into noise. */
  include?: number[];
};

export const RECESSION_INDICATORS: IndicatorSpec[] = [
  { key: "sahm", fred: "SAHMREALTIME", label: "Sahm rule", detail: "3-month average unemployment vs. its 12-month low", unit: "pp", threshold: { value: .5, direction: "above", label: "0.50 trigger" } },
  { key: "curve", fred: "T10Y3M", label: "Yield curve", detail: "10-year minus 3-month Treasury", unit: "bp", scale: 100, threshold: { value: 0, direction: "below", label: "Inverted below 0" }, daily: true },
  { key: "claims", fred: "IC4WSA", label: "Initial jobless claims", detail: "4-week average", unit: "k", scale: .001 },
  { key: "spread", fred: "BAMLH0A0HYM2", label: "High-yield spread", detail: "ICE BofA US high yield over Treasuries", unit: "bp", scale: 100, daily: true },
  { key: "probability", fred: "RECPROUSM156N", label: "Recession probability", detail: "Chauvet–Piger smoothed, from payrolls, output, income and sales", unit: "%", include: [0, 10] },
  { key: "unemployment", fred: "UNRATE", label: "Unemployment rate", detail: "U-3 · seasonally adjusted", unit: "%" },
];

/** Daily series are thinned to one point per week; the latest observation is always kept. */
export function thinDaily(points: Observation[], days = 7) {
  const result: Observation[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (!previous || Date.parse(point.period) - Date.parse(previous.period) >= days * 86_400_000) result.push(point);
  }
  if (points.length && result.at(-1) !== points.at(-1)) result.push(points.at(-1)!);
  return result;
}

/** Contiguous USREC = 1 months as [start, end) periods. */
export function recessionSpans(points: Observation[]) {
  const spans: Array<{ start: string; end: string }> = [];
  let start: string | null = null;
  for (const point of points) {
    if (point.value >= 1 && start == null) start = point.period;
    if (point.value < 1 && start != null) { spans.push({ start, end: point.period }); start = null; }
  }
  if (start != null) spans.push({ start, end: points.at(-1)!.period });
  return spans;
}

export function buildIndicator(spec: IndicatorSpec, observations: Observation[]) {
  const scaled = observations.map((point) => ({ period: point.period, value: point.value * (spec.scale ?? 1) }));
  const latest = scaled.at(-1);
  if (!latest) return null;
  const yearAgoTarget = new Date(`${latest.period}T00:00:00Z`); yearAgoTarget.setUTCFullYear(yearAgoTarget.getUTCFullYear() - 1);
  const yearAgo = scaled.filter((point) => point.period <= yearAgoTarget.toISOString().slice(0, 10)).at(-1) ?? null;
  const signal = spec.threshold
    ? (spec.threshold.direction === "above" ? latest.value >= spec.threshold.value : latest.value < spec.threshold.value)
    : null;
  return {
    key: spec.key,
    label: spec.label,
    detail: spec.detail,
    unit: spec.unit,
    threshold: spec.threshold ?? null,
    include: spec.include ?? [],
    signal,
    latest,
    yearAgo,
    history: spec.daily ? thinDaily(scaled) : scaled,
    sourceUrl: `https://fred.stlouisfed.org/series/${spec.fred}`,
  };
}

export function recessionMarketsFromPolymarket(events: JsonRecord[]) {
  return events.flatMap((event) => {
    const year = stringValue(event.title).match(/^US recession by end of (\d{4})\?$/)?.[1];
    const market = records(event.markets)[0];
    const quote = year && market ? polymarketQuote(market, stringValue(event.slug)) : null;
    return quote ? [{ year: Number(year), quote }] : [];
  });
}

export function recessionMarketsFromKalshi(markets: JsonRecord[]) {
  return markets.flatMap((market) => {
    const year = stringValue(market.event_ticker).match(/^KXRECSSNBER-(\d{2})$/)?.[1];
    const quote = year ? kalshiQuote(market) : null;
    return quote ? [{ year: 2000 + Number(year), quote }] : [];
  });
}

export type RecessionData = {
  markets: Array<{ year: number; venues: Array<{ venue: MarketQuote["venue"]; quote: MarketQuote }> }>;
  gdp: { quarters: Observation[]; nowcast: Observation | null; sourceUrl: string; nowcastUrl: string };
  indicators: Array<NonNullable<ReturnType<typeof buildIndicator>>>;
  recessions: Array<{ start: string; end: string }>;
};

export async function getRecessionSnapshot(force = false, env: KalshiEnv = {}): Promise<DataSnapshot<RecessionData>> {
  // Five years keeps the 2020 spike from flattening every chart; recession shading still appears if one starts.
  const start = isoYearsAgo(5);
  const ids = [...RECESSION_INDICATORS.map((spec) => spec.fred), "USREC", "A191RL1Q225SBEA", "GDPNOW"];
  const [kalshi, polymarket, fred] = await Promise.all([
    loadKalshiSeries("KXRECSSNBER", "Kalshi recession contracts", force, env),
    loadProvider("recession-polymarket", "Polymarket recession contracts", CACHE_TTL.markets, async () => records((await searchPolymarket("US recession by end of")).events), force),
    loadProvider("recession-fred", "FRED economic data", CACHE_TTL.dailyMarketData, async () => {
      const results = await Promise.allSettled(ids.map(async (id) => [id, await fredSeries(id, start)] as const));
      const loaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      if (!loaded.length) throw new Error("FRED unavailable");
      return Object.fromEntries(loaded);
    }, force),
  ]);
  const byYear = new Map<number, RecessionData["markets"][number]["venues"]>();
  for (const { year, quote } of [...recessionMarketsFromKalshi(kalshi.value ?? []), ...recessionMarketsFromPolymarket(polymarket.value ?? [])]) {
    byYear.set(year, [...(byYear.get(year) ?? []), { venue: quote.venue, quote }]);
  }
  const series = fred.value ?? {};
  const quarters = (series.A191RL1Q225SBEA ?? []).slice(-12);
  const lastQuarter = quarters.at(-1)?.period ?? "";
  const sources = [kalshi.health, polymarket.health, fred.health];
  return {
    generatedAt: new Date().toISOString(),
    status: overallStatus(sources),
    sources,
    data: {
      markets: [...byYear.entries()].sort(([a], [b]) => a - b).map(([year, venues]) => ({ year, venues: venues.sort((a, b) => a.venue.localeCompare(b.venue)) })),
      gdp: {
        quarters,
        nowcast: (series.GDPNOW ?? []).filter((point) => point.period > lastQuarter).at(-1) ?? null,
        sourceUrl: "https://fred.stlouisfed.org/series/A191RL1Q225SBEA",
        nowcastUrl: GDPNOW_PAGE,
      },
      indicators: RECESSION_INDICATORS.flatMap((spec) => buildIndicator(spec, series[spec.fred] ?? []) ?? []),
      recessions: recessionSpans(series.USREC ?? []),
    },
  };
}
