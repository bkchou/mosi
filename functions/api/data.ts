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

const POLY_SEARCH = "https://gamma-api.polymarket.com/public-search";
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
  { company: "Google", model: "Gemini 4.0", query: "Gemini release", slug: "gemini-4pt0-released-by-june-30-2026", color: "blue" },
  { company: "xAI", model: "Grok 5", query: "Grok release", slug: "grok-5-released-byptptpt-20260710195520919", color: "mono" },
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

function kalshiProbability(market: JsonRecord) {
  const last = finiteNumber(market.last_price_dollars);
  if (last != null) return { probability: last * 100, quoteKind: "last trade" };
  const bid = finiteNumber(market.yes_bid_dollars);
  const ask = finiteNumber(market.yes_ask_dollars);
  if (bid != null && ask != null) return { probability: ((bid + ask) / 2) * 100, quoteKind: "bid/ask midpoint" };
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

async function kalshiMarkets(seriesTicker: string) {
  const url = `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&limit=1000`;
  const payload = record(await fetchJson(url));
  return records(payload.markets).filter((market) => stringValue(market.status) === "active");
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

async function fetchJson(url: string) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "MOSI/1.0 (+https://mosi.bkchou.com)" },
    signal: AbortSignal.timeout(10000),
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
  return inflationSeries.flatMap((series) => {
    const column = header.indexOf(series.id);
    if (column < 0) return [];
    const rows = csv.slice(1).map((row) => [row[0], row[column]]).filter((row) => row[0] && finiteNumber(row[1]) != null);
    const latest = rows.at(-1);
    const prior = rows.at(-2);
    if (!latest || !prior) return [];
    let value = finiteNumber(latest[1])!;
    let priorValue = finiteNumber(prior[1])!;
    if (series.kind === "index") {
      const latestDate = new Date(`${latest[0]}T00:00:00Z`);
      const priorDate = new Date(`${prior[0]}T00:00:00Z`);
      latestDate.setUTCFullYear(latestDate.getUTCFullYear() - 1);
      priorDate.setUTCFullYear(priorDate.getUTCFullYear() - 1);
      const yearAgo = finiteNumber(rows.find((row) => row[0] === latestDate.toISOString().slice(0, 10))?.[1]);
      const priorYearAgo = finiteNumber(rows.find((row) => row[0] === priorDate.toISOString().slice(0, 10))?.[1]);
      if (yearAgo == null || priorYearAgo == null) return [];
      value = (value / yearAgo - 1) * 100;
      priorValue = (priorValue / priorYearAgo - 1) * 100;
    }
    const nowcastKey = series.label.replace(" · 1m ann.", "");
    const candidateNowcast = nowcasts.get(nowcastKey);
    const nowcast = candidateNowcast && candidateNowcast.period > latest[0] ? candidateNowcast : undefined;
    return [{
      label: series.label,
      value,
      priorValue,
      delta: value - priorValue,
      period: latest[0],
      seriesId: series.id,
      source: `${series.publisher} via FRED`,
      sourceUrl: `https://fred.stlouisfed.org/series/${series.id}`,
      nextEstimate: nowcast?.value ?? null,
      nextEstimatePeriod: nowcast?.period ?? null,
      nextEstimateSource: nowcast ? "Cleveland Fed nowcast" : null,
    }];
  });
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

async function aiForecasts(pascalMarkets: JsonRecord[]) {
  let forecasts: Array<{ company: string; model: string; query: string; slug: string; color: string; source: string; sourceUrl: string; points: MarketQuote[]; status: string }> = await Promise.all(aiEvents.map(async (config) => {
    const payload = await searchPolymarket(config.query);
    const event = records(payload.events).find((item) => stringValue(item.slug) === config.slug);
    if (!event) return { ...config, source: "Polymarket", sourceUrl: `https://polymarket.com/event/${config.slug}`, points: [], status: "no_active_market" };
    const points = records(event.markets).filter((market) => market.active === true && market.closed === false).map((market) => polymarketQuote(market, config.slug)).filter((quote): quote is MarketQuote => quote != null && quote.deadline != null && new Date(quote.deadline).getTime() >= Date.now() - 86400000).sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime());
    return { ...config, source: "Polymarket", sourceUrl: `https://polymarket.com/event/${config.slug}`, points, status: points.length ? "live" : "no_active_market" };
  }));
  const [kalshiGpt, kalshiClaude, kalshiGemini, kalshiGrok] = await Promise.all(["KXGPT", "KXCLAUDE", "KXGEMINI", "KXGROK"].map((series) => kalshiMarkets(series).catch(() => [])));
  const futureQuotes = (rows: JsonRecord[], tickerPattern: RegExp) => rows.filter((market) => tickerPattern.test(stringValue(market.ticker))).map(kalshiQuote).filter((quote): quote is MarketQuote => quote != null && quote.deadline != null && new Date(quote.deadline).getTime() >= Date.now() - 86400000).sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime());
  const geminiPoints = futureQuotes(kalshiGemini, /^KXGEMINI-GEMI35P-/);
  const grokPoints = futureQuotes(kalshiGrok, /^KXGROK-GROK5-/);
  forecasts = forecasts.map((forecast) => {
    if (forecast.company === "Google" && geminiPoints.length) return { ...forecast, model: "Gemini 3.5 Pro", source: "Kalshi", sourceUrl: "https://kalshi.com/markets/kxgemini", points: geminiPoints, status: "live" };
    if (forecast.company === "xAI" && grokPoints.length) return { ...forecast, model: "Grok 5", source: "Kalshi", sourceUrl: "https://kalshi.com/markets/kxgrok", points: grokPoints, status: "live" };
    return forecast;
  });
  const extraKalshi = [
    ...futureQuotes(kalshiGpt, /^KXGPT-OPEN-/),
    ...futureQuotes(kalshiClaude, /^KXCLAUDE-(NXTMYTH|MYTH)-/),
  ];
  const pascalGpt = pascalMarkets.filter((market) => stringValue(market.symbol).startsWith("GPT6_RELEASED_BY.")).map(pascalQuote).filter((quote): quote is MarketQuote => quote != null && quote.deadline != null && new Date(quote.deadline).getTime() >= Date.now() - 86400000).map((quote) => ({ ...quote, title: `${quote.title} · mirrors Polymarket` })).sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime());
  return { forecasts, evidence: [...forecasts.flatMap((forecast) => forecast.points), ...extraKalshi, ...pascalGpt] };
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

export const onRequestGet = async () => {
  const generatedAt = new Date().toISOString();
  const [pascalResult, polyFedResult, kalshiFedResult, nowcasts, rateResult] = await Promise.all([
    pascalData().catch(() => []),
    polymarketFedDecisions().catch(() => []),
    kalshiFedDecisions().catch(() => []),
    inflationNowcasts().catch(() => new Map<string, { value: number; period: string }>()),
    effectiveRate().catch(() => null),
  ]);
  const pascalFed = pascalFedDecisions(pascalResult);
  const [inflationResult, ai] = await Promise.all([
    inflationMetrics(nowcasts).then((values) => ({ values, error: null as string | null })).catch((reason: unknown) => ({ values: [], error: reason instanceof Error ? reason.message : String(reason) })),
    aiForecasts(pascalResult).catch(() => ({ forecasts: [], evidence: [] })),
  ]);
  const inflation = inflationResult.values;
  const inflationErrors = inflationResult.error ? [{ seriesId: "batch", message: inflationResult.error }] : [];

  return Response.json({
    generatedAt,
    fed: {
      effectiveRate: rateResult,
      inflation,
      inflationErrors,
      decisions: combineDecisions(polyFedResult, pascalFed, kalshiFedResult),
      venues: [
        { venue: "Polymarket", status: polyFedResult.length ? "live" : "unavailable", sourceUrl: "https://polymarket.com/markets?_q=fed" },
        { venue: "Pascal", status: pascalFed.length ? "live" : "unavailable", sourceUrl: "https://app.pascal.trade/", note: "Mirrors Polymarket contracts" },
        { venue: "Kalshi", status: kalshiFedResult.length ? "live" : "no_active_market", sourceUrl: "https://kalshi.com/markets" },
        { venue: "CME", status: "credential_required", sourceUrl: "https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html" },
      ],
      releases: [
        { label: "CPI · JUL 2026", releaseAt: "2026-08-12T12:30:00.000Z", source: "BLS official calendar", sourceUrl: "https://www.bls.gov/schedule/news_release/cpi.htm" },
        { label: "PCE · JUL 2026", releaseAt: "2026-08-26T12:30:00.000Z", source: "BEA official calendar", sourceUrl: "https://www.bea.gov/news/schedule" },
      ].filter((release) => new Date(release.releaseAt).getTime() > Date.now()),
    },
    ai,
  }, {
    headers: {
      "cache-control": "public, max-age=60, s-maxage=120, stale-while-revalidate=600",
      "access-control-allow-origin": "*",
    },
  });
};
