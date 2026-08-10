type JsonRecord = Record<string, unknown>;

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

type DecisionVenue = {
  venue: "Polymarket" | "Kalshi" | "Pascal";
  outcomes: Array<{ label: string; probability: number; quote: MarketQuote }>;
};

export type SourceHealth = {
  source: string;
  status: "live" | "stale" | "unavailable";
  fetchedAt: string | null;
  note?: string;
};

export type EndpointStatus = "live" | "partial" | "stale";

export type DataSnapshot<T> = {
  generatedAt: string;
  status: EndpointStatus;
  sources: SourceHealth[];
  data: T;
};

type ProviderLoad<T> = {
  value: T;
  health: SourceHealth;
};

type ProviderCacheEntry = {
  value?: unknown;
  fetchedAt?: string;
  expiresAt?: number;
  inFlight?: Promise<unknown>;
  retryAt?: number;
  lastErrorNote?: string;
};

const providerCache = new Map<string, ProviderCacheEntry>();

const CACHE_TTL = {
  markets: 60_000,
  rates: 300_000,
  inflation: 21_600_000,
  nowcasts: 1_800_000,
} as const;

const POLY_SEARCH = "https://gamma-api.polymarket.com/public-search";
const KALSHI_API = "https://external-api.kalshi.com/trade-api/v2";
const PASCAL_MARKETS = "https://data.pascal.trade/api/v1/markets";
const FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const EFFR_API = "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json";
const CLEVELAND_NOWCAST = "https://www.clevelandfed.org/-/media/files/webcharts/inflationnowcasting/nowcast_year.json";

const inflationSeries = [
  { label: "Headline CPI", id: "CPIAUCNS", kind: "index", publisher: "BLS" },
  { label: "Core CPI", id: "CPILFENS", kind: "index", publisher: "BLS" },
  { label: "Headline PCE", id: "PCEPI", kind: "index", publisher: "BEA" },
  { label: "Core PCE", id: "PCEPILFE", kind: "index", publisher: "BEA" },
  { label: "Median CPI · 1m ann.", id: "MEDCPIM158SFRBCLE", kind: "rate", publisher: "Cleveland Fed" },
  { label: "Trimmed PCE · YoY", id: "PCETRIM12M159SFRBDAL", kind: "rate", publisher: "Dallas Fed" },
] as const;

const aiEvents = [
  { company: "OpenAI", model: "GPT-6", query: "GPT-6", slug: "gpt-6-released-by", color: "green" },
  { company: "Anthropic", model: "Next Claude Opus", query: "Claude release", slug: "next-claude-opus-released-byptptpt-20260727142323912", color: "coral" },
  { company: "Anthropic", model: "Next Claude Sonnet", query: "Claude release", slug: "next-claude-sonnet-released-byptptpt-20260701203831153", color: "coral" },
  { company: "Anthropic", model: "Next Claude Haiku", query: "Claude release", slug: "next-claude-haiku-released-byptptpt-20260701205353326", color: "coral" },
  { company: "Google", model: "Gemini 4.0", query: "Gemini release", slug: "gemini-4pt0-released-by-june-30-2026", color: "blue" },
  { company: "xAI", model: "Grok 5", query: "Grok release", slug: "grok-5-released-byptptpt-20260710195520919", color: "mono" },
  { company: "xAI", model: "Grok 4.6", query: "Grok release", slug: "grok-4pt6-released-byptptpt-20260804192931960", color: "mono" },
] as const;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadProvider<T>(key: string, source: string, ttl: number, loader: () => Promise<T>, force = false): Promise<ProviderLoad<T>> {
  const now = Date.now();
  const entry = providerCache.get(key) ?? {};
  providerCache.set(key, entry);

  if (!force && entry.value !== undefined && (entry.expiresAt ?? 0) > now) {
    return {
      value: entry.value as T,
      health: { source, status: "live", fetchedAt: entry.fetchedAt ?? null },
    };
  }

  if (!force && (entry.retryAt ?? 0) > now) {
    return entry.value !== undefined ? {
      value: entry.value as T,
      health: { source, status: "stale", fetchedAt: entry.fetchedAt ?? null, note: `Using the last successful response. ${entry.lastErrorNote ?? "Refresh is temporarily paused."}` },
    } : {
      value: undefined as T,
      health: { source, status: "unavailable", fetchedAt: null, note: entry.lastErrorNote ?? "Refresh is temporarily paused." },
    };
  }

  if (!entry.inFlight) {
    entry.inFlight = loader().then((value) => {
      entry.value = value;
      entry.fetchedAt = new Date().toISOString();
      entry.expiresAt = Date.now() + ttl;
      entry.retryAt = undefined;
      entry.lastErrorNote = undefined;
      return value;
    }).finally(() => {
      entry.inFlight = undefined;
    });
  }

  try {
    const value = await entry.inFlight as T;
    return { value, health: { source, status: "live", fetchedAt: entry.fetchedAt ?? null } };
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "";
    const status = message.match(/:\s(\d{3})$/)?.[1];
    const note = status ? `Upstream returned HTTP ${status}.` : /timeout|aborted/i.test(message) ? "Upstream request timed out." : "Source is temporarily unavailable.";
    entry.retryAt = Date.now() + 300_000;
    entry.lastErrorNote = note;
    if (entry.value !== undefined) {
      return {
        value: entry.value as T,
        health: { source, status: "stale", fetchedAt: entry.fetchedAt ?? null, note: `Using the last successful response. ${note}` },
      };
    }
    return {
      value: undefined as T,
      health: { source, status: "unavailable", fetchedAt: null, note },
    };
  }
}

export function overallStatus(sources: SourceHealth[]): EndpointStatus {
  if (!sources.length) return "stale";
  if (sources.every((source) => source.status === "live")) return "live";
  if (sources.some((source) => source.status === "live")) return "partial";
  return "stale";
}

export const API_CACHE_HEADERS = {
  "cache-control": "public, max-age=60, s-maxage=120, stale-while-revalidate=600",
  "access-control-allow-origin": "*",
};

const LAST_LIVE_SNAPSHOT_TTL = 900_000;

type EdgeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

function stableCacheRequest(request: Request) {
  const url = new URL(request.url);
  url.pathname = `/__mosi_snapshot${url.pathname}`;
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

export async function readRecentSnapshot<T>(request: Request, maxAge = 120_000): Promise<DataSnapshot<T> | null> {
  const edgeCache = (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches?.default;
  if (!edgeCache) return null;
  try {
    const cached = await edgeCache.match(stableCacheRequest(request));
    if (!cached) return null;
    const snapshot = await cached.json() as DataSnapshot<T>;
    const age = Date.now() - Date.parse(snapshot.generatedAt);
    return Number.isFinite(age) && age >= 0 && age <= maxAge ? snapshot : null;
  } catch {
    return null;
  }
}

export async function retainLastLiveSnapshot<T>(request: Request, snapshot: DataSnapshot<T>): Promise<DataSnapshot<T>> {
  const edgeCache = (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches?.default;
  if (!edgeCache) return snapshot;
  const key = stableCacheRequest(request);

  try {
    const cached = await edgeCache.match(key);
    const previous = cached ? await cached.json() as DataSnapshot<T> : null;
    const previousAge = previous ? Date.now() - Date.parse(previous.generatedAt) : Infinity;
    const previousIsUsable = previous != null && Number.isFinite(previousAge) && previousAge >= 0 && previousAge <= LAST_LIVE_SNAPSHOT_TTL;
    const currentLiveSources = snapshot.sources.filter((source) => source.status === "live").length;
    const previousLiveSources = previousIsUsable ? previous.sources.filter((source) => source.status === "live").length : -1;

    if (snapshot.status !== "stale" && (!previousIsUsable || currentLiveSources >= previousLiveSources)) {
      await edgeCache.put(key, new Response(JSON.stringify(snapshot), {
        headers: { "content-type": "application/json", "cache-control": "max-age=900" },
      }));
      return snapshot;
    }
    return previousIsUsable ? { ...snapshot, data: previous.data } : snapshot;
  } catch {
    return snapshot;
  }
}

function kalshiProbability(market: JsonRecord) {
  const bid = finiteNumber(market.yes_bid_dollars);
  const ask = finiteNumber(market.yes_ask_dollars);
  if (bid != null && ask != null) return { probability: ((bid + ask) / 2) * 100, quoteKind: "bid/ask midpoint" };
  const last = finiteNumber(market.last_price_dollars);
  if (last != null) return { probability: last * 100, quoteKind: "last trade" };
  return null;
}

function kalshiQuote(market: JsonRecord): MarketQuote | null {
  const quote = kalshiProbability(market);
  const title = stringValue(market.title);
  const ticker = stringValue(market.ticker);
  const eventTicker = stringValue(market.event_ticker);
  if (quote == null || !title || !ticker) return null;
  const volume = finiteNumber(market.volume_fp ?? market.volume);
  return {
    venue: "Kalshi",
    title,
    probability: quote.probability,
    volume,
    volumeLabel: volume == null ? "Volume unavailable" : `${Math.round(volume).toLocaleString("en-US")} contracts`,
    url: `https://kalshi.com/markets/${eventTicker.toLowerCase()}`,
    deadline: stringValue(market.close_time) || stringValue(market.expiration_time) || null,
    quoteKind: quote.quoteKind,
    symbol: ticker,
  };
}

async function kalshiMarkets(seriesTicker: string, preferEvents = false) {
  const query = `series_ticker=${encodeURIComponent(seriesTicker)}&status=open`;
  const fromEvents = async () => {
    const payload = record(await fetchJson(`${KALSHI_API}/events?${query}&with_nested_markets=true&limit=200`, 4000));
    return records(payload.events).flatMap((event) => records(event.markets)).filter((market) => stringValue(market.status) === "active");
  };
  if (preferEvents) return fromEvents();
  try {
    const payload = record(await fetchJson(`${KALSHI_API}/markets?${query}&limit=1000`, 4000));
    return records(payload.markets).filter((market) => stringValue(market.status) === "active");
  } catch {
    return fromEvents();
  }
}

async function kalshiFedDecisions() {
  const markets = await kalshiMarkets("KXFEDDECISION");
  const groups = new Map<string, JsonRecord[]>();
  for (const market of markets) {
    const eventTicker = stringValue(market.event_ticker);
    if (!/^KXFEDDECISION-\d{2}[A-Z]{3}$/.test(eventTicker)) continue;
    groups.set(eventTicker, [...(groups.get(eventTicker) ?? []), market]);
  }
  return [...groups.entries()].map(([eventTicker, rows]) => {
    const outcomes = rows.map((market) => {
      const quote = kalshiQuote(market);
      const ticker = stringValue(market.ticker);
      let label: string | null = null;
      if (/-H0$/.test(ticker)) label = "No change";
      else if (/-H25$/.test(ticker)) label = "Hike 25 bp";
      else if (/-H(26|50|50PLUS)$/.test(ticker)) label = "Hike 50+ bp";
      else if (/-C25$/.test(ticker)) label = "Cut 25 bp";
      else if (/-C(26|50|50PLUS)$/.test(ticker)) label = "Cut 50+ bp";
      return quote && label ? { label, probability: quote.probability, quote } : null;
    }).filter((item): item is NonNullable<typeof item> => item != null);
    return {
      label: `${({ JAN: "January", FEB: "February", MAR: "March", APR: "April", MAY: "May", JUN: "June", JUL: "July", AUG: "August", SEP: "September", OCT: "October", NOV: "November", DEC: "December" } as Record<string, string>)[eventTicker.slice(-3)] ?? eventTicker.slice(-3)} decision`,
      meetingDate: outcomes.find((item) => item.quote.deadline)?.quote.deadline ?? null,
      venue: { venue: "Kalshi" as const, outcomes },
    };
  }).filter((decision) => decision.venue.outcomes.length > 0 && decision.meetingDate != null && new Date(decision.meetingDate).getTime() >= Date.now() - 86400000);
}

function probabilityFromOutcomePrices(value: unknown, outcomesValue: unknown): number | null {
  try {
    const prices = Array.isArray(value) ? value : JSON.parse(stringValue(value));
    const outcomes = Array.isArray(outcomesValue) ? outcomesValue : JSON.parse(stringValue(outcomesValue));
    const yesIndex = outcomes.findIndex((outcome: unknown) => stringValue(outcome).toLowerCase() === "yes");
    const selected = finiteNumber(prices[yesIndex >= 0 ? yesIndex : 0]);
    return selected == null ? null : selected * 100;
  } catch {
    return null;
  }
}

function deadlineFromQuestion(question: string): string | null {
  const match = question.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*)?(\d{4})/i);
  if (!match) return null;
  const timestamp = Date.parse(`${match[1]} ${match[2]}, ${match[3]} 23:59:00 UTC`);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

async function fetchJson(url: string, timeoutMs = 10000) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "MOSI/1.0 (+https://mosi.bkchou.com)" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function searchPolymarket(query: string) {
  const url = `${POLY_SEARCH}?q=${encodeURIComponent(query)}&limit_per_type=25&events_status=active`;
  return record(await fetchJson(url));
}

function polymarketQuote(market: JsonRecord, eventSlug: string): MarketQuote | null {
  const probability = probabilityFromOutcomePrices(market.outcomePrices, market.outcomes);
  const title = stringValue(market.question || market.title);
  if (probability == null || !title) return null;
  const volume = finiteNumber(market.volumeNum ?? market.volume);
  const marketSlug = stringValue(market.slug);
  return {
    venue: "Polymarket",
    title,
    probability,
    volume,
    volumeLabel: volume == null ? "Volume unavailable" : `$${Math.round(volume).toLocaleString("en-US")} traded`,
    url: `https://polymarket.com/event/${eventSlug}${marketSlug ? `?market=${encodeURIComponent(marketSlug)}` : ""}`,
    deadline: deadlineFromQuestion(title) ?? stringValue(market.endDate) ?? null,
    quoteKind: "market price",
  };
}

function fedOutcomeLabel(title: string) {
  if (/no change/i.test(title)) return "No change";
  if (/(decrease|cut).*(50|more)/i.test(title) || /(50|more).*(decrease|cut)/i.test(title)) return "Cut 50+ bp";
  if (/(decrease|cut).*25/i.test(title) || /25.*(decrease|cut)/i.test(title)) return "Cut 25 bp";
  if (/(increase|hike).*(50|more)/i.test(title) || /(50|more).*(increase|hike)/i.test(title)) return "Hike 50+ bp";
  if (/(increase|hike).*25/i.test(title) || /25.*(increase|hike)/i.test(title)) return "Hike 25 bp";
  return null;
}

function meetingName(title: string) {
  const match = title.match(/Fed Decision in ([A-Za-z]+)/i);
  return match ? `${match[1]} decision` : title;
}

async function polymarketFedDecisions() {
  const payload = await searchPolymarket("Fed Decision");
  return records(payload.events).filter((event) => /Fed Decision in [A-Za-z]+/i.test(stringValue(event.title))).map((event) => {
    const slug = stringValue(event.slug);
    const outcomes = records(event.markets).filter((market) => market.active === true && market.closed === false).map((market) => {
      const quote = polymarketQuote(market, slug);
      const label = fedOutcomeLabel(stringValue(market.question));
      return quote && label ? { label, probability: quote.probability, quote } : null;
    }).filter((item): item is NonNullable<typeof item> => item != null);
    const deadline = outcomes.find((item) => item.quote.deadline)?.quote.deadline ?? null;
    return { label: meetingName(stringValue(event.title)), meetingDate: deadline, venue: { venue: "Polymarket" as const, outcomes } };
  }).filter((decision) => decision.venue.outcomes.length > 0 && decision.meetingDate != null && new Date(decision.meetingDate).getTime() >= Date.now() - 86400000).sort((a, b) => new Date(a.meetingDate!).getTime() - new Date(b.meetingDate!).getTime()).slice(0, 3);
}

async function pascalData() {
  const payload = record(await fetchJson(PASCAL_MARKETS));
  return records(payload.data);
}

function pascalQuote(market: JsonRecord): MarketQuote | null {
  const attributes = record(market.display_attributes);
  const probability = finiteNumber(market.mark_price);
  const symbol = stringValue(market.symbol);
  const event = stringValue(attributes.event_description);
  const description = stringValue(attributes.market_description);
  if (probability == null || !symbol || !event || !description) return null;
  const stats = record(record(market.stats).all_time);
  const volume = finiteNumber(stats.taker_volume_usdc ?? stats.volume_usdc);
  const expectedMs = finiteNumber(attributes.expected_resolution_time_ms);
  return {
    venue: "Pascal",
    title: `${event} — ${description}`,
    probability: probability * 100,
    volume,
    volumeLabel: volume == null ? `${finiteNumber(market.open_interest)?.toLocaleString("en-US") ?? "—"} open interest` : `$${Math.round(volume).toLocaleString("en-US")} traded`,
    url: `https://app.pascal.trade/?marketSymbol=${encodeURIComponent(symbol)}`,
    deadline: expectedMs == null ? null : new Date(expectedMs).toISOString(),
    quoteKind: "mark price",
    symbol,
  };
}

function pascalFedDecisions(markets: JsonRecord[]) {
  const groups = new Map<string, JsonRecord[]>();
  for (const market of markets) {
    const symbol = stringValue(market.symbol);
    const match = symbol.match(/^FED_DECISION_(\d{2}[A-Z]{3})\./);
    if (!match) continue;
    groups.set(match[1], [...(groups.get(match[1]) ?? []), market]);
  }
  return [...groups.entries()].map(([, rows]) => {
    const outcomes = rows.map((market) => {
      const quote = pascalQuote(market);
      const label = fedOutcomeLabel(stringValue(record(market.display_attributes).market_description));
      return quote && label ? { label, probability: quote.probability, quote } : null;
    }).filter((item): item is NonNullable<typeof item> => item != null);
    return {
      label: meetingName(stringValue(record(rows[0]?.display_attributes).event_description)),
      meetingDate: outcomes.find((item) => item.quote.deadline)?.quote.deadline ?? null,
      venue: { venue: "Pascal" as const, outcomes },
    };
  }).filter((decision) => decision.meetingDate != null && new Date(decision.meetingDate).getTime() >= Date.now() - 86400000).sort((a, b) => new Date(a.meetingDate!).getTime() - new Date(b.meetingDate!).getTime()).slice(0, 3);
}

async function inflationMetrics(nowcasts: Map<string, { value: number; period: string }> = new Map()) {
  const ids = inflationSeries.map((series) => series.id).join(",");
  const response = await fetch(`${FRED_CSV}?id=${encodeURIComponent(ids)}`, {
    headers: { accept: "text/csv", "user-agent": "MOSI/1.0 (+https://mosi.bkchou.com)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`FRED inflation batch: ${response.status}`);
  const csv = (await response.text()).trim().split(/\r?\n/).map((line) => line.split(","));
  const header = csv[0];
  const metrics = inflationSeries.flatMap((series) => {
    const column = header.indexOf(series.id);
    if (column < 0) return [];
    const rows = csv.slice(1).map((row) => [row[0], row[column]]).filter((row) => row[0] && finiteNumber(row[1]) != null);
    const rowValues = new Map(rows.map(([period, rawValue]) => [period, finiteNumber(rawValue)!]));
    const history = rows.flatMap(([period, rawValue]) => {
      const observation = finiteNumber(rawValue);
      if (observation == null) return [];
      if (series.kind === "rate") return [{ period, value: observation }];
      const date = new Date(`${period}T00:00:00Z`);
      date.setUTCFullYear(date.getUTCFullYear() - 1);
      const yearAgo = rowValues.get(date.toISOString().slice(0, 10));
      return yearAgo == null || yearAgo === 0 ? [] : [{ period, value: (observation / yearAgo - 1) * 100 }];
    });
    const latest = history.at(-1);
    const prior = history.at(-2);
    if (!latest || !prior) return [];
    const value = latest.value;
    const priorValue = prior.value;
    const nowcastKey = series.label.replace(" · 1m ann.", "");
    const candidateNowcast = nowcasts.get(nowcastKey);
    const nowcast = candidateNowcast && candidateNowcast.period > latest.period ? candidateNowcast : undefined;
    return [{
      label: series.label,
      value,
      priorValue,
      delta: value - priorValue,
      period: latest.period,
      seriesId: series.id,
      source: `${series.publisher} via FRED`,
      sourceUrl: `https://fred.stlouisfed.org/series/${series.id}`,
      nextEstimate: nowcast?.value ?? null,
      nextEstimatePeriod: nowcast?.period ?? null,
      nextEstimateSource: nowcast ? "Cleveland Fed nowcast" : null,
      history,
    }];
  });
  const graphEnd = metrics.map((metric) => metric.history.at(-1)?.period).filter((period): period is string => period != null).sort().at(-1);
  if (!graphEnd) return metrics;
  const cutoff = new Date(`${graphEnd}T00:00:00Z`);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 3);
  const cutoffPeriod = cutoff.toISOString().slice(0, 10);
  return metrics.map((metric) => ({ ...metric, history: metric.history.filter((point) => point.period >= cutoffPeriod) }));
}

async function effectiveRate() {
  const payload = record(await fetchJson(EFFR_API));
  const observations = records(payload.refRates);
  const latest = observations[0];
  if (!latest) return null;
  return {
    value: finiteNumber(latest.percentRate),
    period: stringValue(latest.effectiveDate),
    source: "Federal Reserve Bank of New York",
    sourceUrl: "https://www.newyorkfed.org/markets/reference-rates/effr",
  };
}

async function inflationNowcasts() {
  const payload = records(await fetchJson(CLEVELAND_NOWCAST));
  const currentMonth = new Date(); currentMonth.setUTCDate(1); currentMonth.setUTCHours(0, 0, 0, 0);
  const earliest = new Date(currentMonth); earliest.setUTCMonth(earliest.getUTCMonth() - 2);
  const latest = new Date(currentMonth); latest.setUTCMonth(latest.getUTCMonth() + 1);
  const candidates = payload.map((chart) => {
    const match = stringValue(record(chart.chart).subcaption).match(/^(\d{4})-(\d{1,2})$/);
    const timestamp = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, 1) : NaN;
    return { chart, timestamp };
  }).filter((item) => Number.isFinite(item.timestamp) && item.timestamp >= earliest.getTime() && item.timestamp <= latest.getTime()).sort((a, b) => a.timestamp - b.timestamp);
  const future = candidates.find(({ chart }) => records(chart.dataset).filter((series) => /^Actual (CPI|Core CPI|PCE|Core PCE) Inflation$/.test(stringValue(series.seriesname))).some((series) => !records(series.data).some((item) => finiteNumber(item.value) != null)))?.chart;
  if (!future) return new Map<string, { value: number; period: string }>();
  const periodCode = stringValue(record(future.chart).subcaption);
  const [year, month] = periodCode.split("-").map(Number);
  const period = `${year}-${String(month).padStart(2, "0")}-01`;
  const result = new Map<string, { value: number; period: string }>();
  for (const series of records(future.dataset)) {
    const name = stringValue(series.seriesname);
    if (!/^(CPI Inflation|Core CPI Inflation|PCE Inflation|Core PCE Inflation)$/.test(name)) continue;
    const values = records(series.data).map((item) => finiteNumber(item.value)).filter((value): value is number => value != null);
    const value = values.at(-1);
    if (value == null) continue;
    const label = name === "CPI Inflation" ? "Headline CPI" : name === "Core CPI Inflation" ? "Core CPI" : name === "PCE Inflation" ? "Headline PCE" : "Core PCE";
    result.set(label, { value, period });
  }
  return result;
}

function applyInflationNowcasts<T extends { label: string; period: string; nextEstimate: number | null; nextEstimatePeriod: string | null; nextEstimateSource: string | null }>(metrics: T[], nowcasts: Map<string, { value: number; period: string }>) {
  return metrics.map((metric) => {
    const nowcast = nowcasts.get(metric.label.replace(" · 1m ann.", ""));
    if (!nowcast || nowcast.period <= metric.period) return metric;
    return {
      ...metric,
      nextEstimate: nowcast.value,
      nextEstimatePeriod: nowcast.period,
      nextEstimateSource: "Cleveland Fed nowcast",
    };
  });
}

type AiForecast = { company: string; model: string; query: string; slug: string; color: string; source: string; sourceUrl: string; points: MarketQuote[]; status: string };

async function polymarketAiForecasts(): Promise<AiForecast[]> {
  return Promise.all(aiEvents.map(async (config) => {
    const payload = await searchPolymarket(config.query);
    const event = records(payload.events).find((item) => stringValue(item.slug) === config.slug);
    if (!event) return { ...config, source: "Polymarket", sourceUrl: `https://polymarket.com/event/${config.slug}`, points: [], status: "no_active_market" };
    const points = records(event.markets).filter((market) => market.active === true && market.closed === false).map((market) => polymarketQuote(market, config.slug)).filter((quote): quote is MarketQuote => quote != null && quote.deadline != null && new Date(quote.deadline).getTime() >= Date.now() - 86400000).sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime());
    return { ...config, source: "Polymarket", sourceUrl: `https://polymarket.com/event/${config.slug}`, points, status: points.length ? "live" : "no_active_market" };
  }));
}

function aiForecasts(polymarketForecasts: AiForecast[], kalshiMarketsBySeries: JsonRecord[][], pascalMarkets: JsonRecord[]) {
  let forecasts = polymarketForecasts;
  const [kalshiGpt, kalshiClaude, kalshiGemini, kalshiGrok] = kalshiMarketsBySeries;
  const futureQuotes = (rows: JsonRecord[], tickerPattern: RegExp) => rows.filter((market) => tickerPattern.test(stringValue(market.ticker))).map(kalshiQuote).filter((quote): quote is MarketQuote => quote != null && quote.deadline != null && new Date(quote.deadline).getTime() >= Date.now() - 86400000).sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime());
  const gptPoints = futureQuotes(kalshiGpt, /^KXGPT-OPEN-/);
  const astraPoints = futureQuotes(kalshiGpt, /^KXGPT-ASTRA-/);
  const mythosPoints = futureQuotes(kalshiClaude, /^KXCLAUDE-NXTMYTH-/);
  const geminiPoints = futureQuotes(kalshiGemini, /^KXGEMINI-GEMI35P-/);
  const grok46Points = futureQuotes(kalshiGrok, /^KXGROK-GROK46-/);
  const grok47Points = futureQuotes(kalshiGrok, /^KXGROK-GROK47-/);
  const grokPoints = futureQuotes(kalshiGrok, /^KXGROK-GROK5-/);
  forecasts = forecasts.map((forecast) => {
    if (forecast.company === "OpenAI" && gptPoints.length) return { ...forecast, source: "Polymarket + Kalshi", sourceUrl: "https://polymarket.com/event/gpt-6-released-by", points: [...forecast.points, ...gptPoints].sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime()), status: "live" };
    if (forecast.company === "xAI" && forecast.model === "Grok 5" && grokPoints.length) return { ...forecast, source: "Polymarket + Kalshi", sourceUrl: "https://kalshi.com/markets/kxgrok", points: [...forecast.points, ...grokPoints].sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime()), status: "live" };
    if (forecast.company === "xAI" && forecast.model === "Grok 4.6" && grok46Points.length) return { ...forecast, source: "Polymarket + Kalshi", sourceUrl: "https://kalshi.com/markets/kxgrok", points: [...forecast.points, ...grok46Points].sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime()), status: "live" };
    return forecast;
  });
  const kalshiOnly = [
    { company: "OpenAI", model: "Astra", query: "", slug: "", color: "green", source: "Kalshi", sourceUrl: "https://kalshi.com/markets/kxgpt", points: astraPoints, status: astraPoints.length ? "live" : "no_active_market" },
    { company: "Anthropic", model: "Next Mythos-Class", query: "", slug: "", color: "coral", source: "Kalshi", sourceUrl: "https://kalshi.com/markets/kxclaude", points: mythosPoints, status: mythosPoints.length ? "live" : "no_active_market" },
    { company: "Google", model: "Gemini 3.5 Pro", query: "", slug: "", color: "blue", source: "Kalshi", sourceUrl: "https://kalshi.com/markets/kxgemini", points: geminiPoints, status: geminiPoints.length ? "live" : "no_active_market" },
    { company: "xAI", model: "Grok 4.7", query: "", slug: "", color: "mono", source: "Kalshi", sourceUrl: "https://kalshi.com/markets/kxgrok", points: grok47Points, status: grok47Points.length ? "live" : "no_active_market" },
  ].filter((forecast) => forecast.points.length >= 2);
  forecasts = [...forecasts, ...kalshiOnly].filter((forecast) => forecast.points.length >= 2).sort((a, b) => a.company.localeCompare(b.company) || a.model.localeCompare(b.model));
  const pascalGpt = pascalMarkets.filter((market) => stringValue(market.symbol).startsWith("GPT6_RELEASED_BY.")).map(pascalQuote).filter((quote): quote is MarketQuote => quote != null && quote.deadline != null && new Date(quote.deadline).getTime() >= Date.now() - 86400000).map((quote) => ({ ...quote, title: `${quote.title} · mirrors Polymarket` })).sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime());
  return { forecasts, evidence: [...forecasts.flatMap((forecast) => forecast.points), ...pascalGpt] };
}

function combineDecisions(poly: Awaited<ReturnType<typeof polymarketFedDecisions>>, pascal: ReturnType<typeof pascalFedDecisions>, kalshi: Awaited<ReturnType<typeof kalshiFedDecisions>>) {
  const combined = new Map<string, { label: string; meetingDate: string | null; venues: DecisionVenue[] }>();
  for (const decision of [...poly, ...kalshi, ...pascal]) {
    if (!decision.meetingDate) continue;
    const date = new Date(decision.meetingDate);
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    const label = `${new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(date)} decision`;
    const current = combined.get(key) ?? { label, meetingDate: decision.meetingDate, venues: [] };
    current.meetingDate ||= decision.meetingDate;
    current.venues.push(decision.venue);
    combined.set(key, current);
  }
  return [...combined.values()].sort((a, b) => (a.meetingDate ?? "").localeCompare(b.meetingDate ?? "")).slice(0, 3);
}

type FedData = {
  effectiveRate: Awaited<ReturnType<typeof effectiveRate>>;
  inflation: Awaited<ReturnType<typeof inflationMetrics>>;
  inflationErrors: Array<{ seriesId: string; message: string }>;
  decisions: ReturnType<typeof combineDecisions>;
  venues: Array<{ venue: "Polymarket" | "Kalshi" | "Pascal" | "CME"; status: "live" | "unavailable" | "no_active_market" | "credential_required"; sourceUrl: string; note?: string }>;
  releases: Array<{ label: string; releaseAt: string; source: string; sourceUrl: string }>;
};

type AiData = ReturnType<typeof aiForecasts>;

export async function getFedSnapshot(force = false): Promise<DataSnapshot<FedData>> {
  const [pascal, polymarket, kalshi, nowcasts, inflation, rate] = await Promise.all([
    loadProvider("pascal-markets", "Pascal Fed decisions", CACHE_TTL.markets, pascalData, force),
    loadProvider("fed-polymarket", "Polymarket Fed decisions", CACHE_TTL.markets, polymarketFedDecisions, force),
    loadProvider("fed-kalshi", "Kalshi Fed decisions", CACHE_TTL.markets, kalshiFedDecisions, force),
    loadProvider("fed-nowcasts", "Cleveland Fed inflation nowcast", CACHE_TTL.nowcasts, inflationNowcasts, force),
    loadProvider("fed-inflation", "FRED inflation observations", CACHE_TTL.inflation, () => inflationMetrics(), force),
    loadProvider("fed-effective-rate", "New York Fed effective rate", CACHE_TTL.rates, effectiveRate, force),
  ]);
  const pascalMarkets = pascal.value ?? [];
  const polymarketDecisions = polymarket.value ?? [];
  const kalshiDecisions = kalshi.value ?? [];
  const pascalDecisions = pascalFedDecisions(pascalMarkets);
  const nowcastValues = nowcasts.value ?? new Map<string, { value: number; period: string }>();
  const inflationValues = applyInflationNowcasts(inflation.value ?? [], nowcastValues);
  const sources = [pascal.health, polymarket.health, kalshi.health, nowcasts.health, inflation.health, rate.health];

  return {
    generatedAt: new Date().toISOString(),
    status: overallStatus([polymarket.health, kalshi.health, nowcasts.health, inflation.health, rate.health]),
    sources,
    data: {
      effectiveRate: rate.value ?? null,
      inflation: inflationValues,
      inflationErrors: inflation.health.status === "unavailable" ? [{ seriesId: "batch", message: "FRED inflation observations are temporarily unavailable." }] : [],
      decisions: combineDecisions(polymarketDecisions, pascalDecisions, kalshiDecisions),
      venues: [
        { venue: "Polymarket", status: polymarketDecisions.length ? "live" : "unavailable", sourceUrl: "https://polymarket.com/markets?_q=fed" },
        { venue: "Pascal", status: pascalDecisions.length ? "live" : "unavailable", sourceUrl: "https://app.pascal.trade/", note: "Mirrors Polymarket contracts" },
        { venue: "Kalshi", status: kalshiDecisions.length ? "live" : "no_active_market", sourceUrl: "https://kalshi.com/markets" },
        { venue: "CME", status: "credential_required", sourceUrl: "https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html" },
      ],
      releases: [
        { label: "CPI · JUL 2026", releaseAt: "2026-08-12T12:30:00.000Z", source: "BLS official calendar", sourceUrl: "https://www.bls.gov/schedule/news_release/cpi.htm" },
        { label: "PCE · JUL 2026", releaseAt: "2026-08-26T12:30:00.000Z", source: "BEA official calendar", sourceUrl: "https://www.bea.gov/news/schedule" },
      ].filter((release) => new Date(release.releaseAt).getTime() > Date.now()),
    },
  };
}

export async function getAiSnapshot(force = false): Promise<DataSnapshot<AiData>> {
  const polymarketPromise = loadProvider("ai-polymarket", "Polymarket AI contracts", CACHE_TTL.markets, polymarketAiForecasts, force);
  const kalshiConfigs = [
    ["gpt", "GPT", "KXGPT"],
    ["claude", "Claude", "KXCLAUDE"],
    ["gemini", "Gemini", "KXGEMINI"],
    ["grok", "Grok", "KXGROK"],
  ] as const;
  const kalshiLoads: Array<ProviderLoad<JsonRecord[]>> = [];
  for (const [key, label, series] of kalshiConfigs) {
    kalshiLoads.push(await loadProvider(`ai-kalshi-${key}`, `Kalshi ${label} contracts`, CACHE_TTL.markets, () => kalshiMarkets(series, true), force));
  }
  const polymarket = await polymarketPromise;
  const [kalshiGpt, kalshiClaude, kalshiGemini, kalshiGrok] = kalshiLoads;
  const sources = [polymarket.health, kalshiGpt.health, kalshiClaude.health, kalshiGemini.health, kalshiGrok.health];
  return {
    generatedAt: new Date().toISOString(),
    status: overallStatus(sources),
    sources,
    data: aiForecasts(polymarket.value ?? [], [kalshiGpt.value ?? [], kalshiClaude.value ?? [], kalshiGemini.value ?? [], kalshiGrok.value ?? []], []),
  };
}

export function requestForcesRefresh(request: Request | undefined) {
  return request ? new URL(request.url).searchParams.has("refresh") : false;
}

export const onRequestGet = async ({ request }: { request: Request }) => {
  const [fed, ai] = await Promise.all([
    getFedSnapshot(requestForcesRefresh(request)),
    getAiSnapshot(requestForcesRefresh(request)),
  ]);
  return Response.json({
    generatedAt: new Date().toISOString(),
    fed: fed.data,
    ai: ai.data,
  }, { headers: API_CACHE_HEADERS });
};
