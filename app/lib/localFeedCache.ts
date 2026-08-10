export type CacheSource = { source: string; status: "live" | "stale" | "unavailable"; fetchedAt: string | null; note?: string };
export type CacheQuote = { venue: string; deadline: string | null; [key: string]: unknown };
export type CacheForecast = { company: string; model: string; points: CacheQuote[]; [key: string]: unknown };
export type CacheDecision = { meetingDate: string | null; venues: Array<{ venue: string; [key: string]: unknown }>; [key: string]: unknown };
export type CacheEnvelope = {
  generatedAt: string;
  status: "live" | "partial" | "stale";
  sources: CacheSource[];
  data: { forecasts?: CacheForecast[]; evidence?: CacheQuote[]; decisions?: CacheDecision[]; [key: string]: unknown };
};
export type StoredFeedCache = { version: 1; feed: CacheEnvelope; providerFetchedAt: Record<string, string> };
export type LocalFallback = { source: string; cachedAt: string };

const MAX_LOCAL_AGE = 6 * 60 * 60 * 1000;
const KALSHI_AI_SOURCES = ["Kalshi GPT contracts", "Kalshi Claude contracts", "Kalshi Gemini contracts", "Kalshi Grok contracts"];

function freshEnough(value: string | undefined, now: number) {
  if (!value) return false;
  const age = now - Date.parse(value);
  return Number.isFinite(age) && age >= 0 && age <= MAX_LOCAL_AGE;
}

function forecastKey(forecast: CacheForecast) {
  return `${forecast.company}\u0000${forecast.model}`;
}

function decisionKey(decision: CacheDecision) {
  return decision.meetingDate?.slice(0, 7) ?? "";
}

function kalshiCompany(source: string) {
  if (/GPT/i.test(source)) return "OpenAI";
  if (/Claude/i.test(source)) return "Anthropic";
  if (/Gemini/i.test(source)) return "Google";
  if (/Grok/i.test(source)) return "xAI";
  return null;
}

export function mergeWithLocalCache(screen: "fed" | "models", current: CacheEnvelope, stored: StoredFeedCache | null, now = Date.now()) {
  const providerFetchedAt = { ...(stored?.providerFetchedAt ?? {}) };
  for (const source of current.sources) {
    if (source.status === "live" && !source.note?.includes("One-request cached-ticker refresh.")) providerFetchedAt[source.source] = source.fetchedAt ?? current.generatedAt;
  }
  const fallbacks: LocalFallback[] = [];
  if (!stored) return { feed: current, providerFetchedAt, fallbacks };

  if (screen === "models") {
    const unavailableCompanies = new Map<string, { source: string; cachedAt: string }>();
    for (const source of current.sources.filter((item) => item.source.startsWith("Kalshi") && item.status !== "live")) {
      const company = kalshiCompany(source.source);
      const cachedAt = providerFetchedAt[source.source];
      if (company && freshEnough(cachedAt, now)) unavailableCompanies.set(company, { source: source.source, cachedAt });
    }
    if (unavailableCompanies.size) {
      const currentForecasts = current.data.forecasts ?? [];
      const cachedForecasts = stored.feed.data.forecasts ?? [];
      const byKey = new Map(currentForecasts.map((forecast) => [forecastKey(forecast), forecast]));
      for (const cached of cachedForecasts) {
        const fallback = unavailableCompanies.get(cached.company);
        if (!fallback) continue;
        const stalePoints = cached.points.filter((point) => point.venue === "Kalshi");
        if (!stalePoints.length) continue;
        const active = byKey.get(forecastKey(cached));
        const freshPoints = active?.points.filter((point) => point.venue !== "Kalshi") ?? [];
        const deduped = new Map([...freshPoints, ...stalePoints].map((point) => [`${point.venue}\u0000${point.deadline ?? ""}\u0000${String(point.symbol ?? point.title ?? "")}`, point]));
        byKey.set(forecastKey(cached), { ...(active ?? cached), points: [...deduped.values()] });
        if (!fallbacks.some((item) => item.source === fallback.source)) fallbacks.push(fallback);
      }
      const forecasts = [...byKey.values()].sort((a, b) => a.company.localeCompare(b.company) || a.model.localeCompare(b.model));
      current = { ...current, data: { ...current.data, forecasts, evidence: forecasts.flatMap((forecast) => forecast.points) } };
    }
  } else {
    const source = current.sources.find((item) => item.source === "Kalshi Fed decisions" && item.status !== "live");
    const cachedAt = providerFetchedAt["Kalshi Fed decisions"];
    if (source && freshEnough(cachedAt, now)) {
      const cachedDecisions = stored.feed.data.decisions ?? [];
      const byKey = new Map((current.data.decisions ?? []).map((decision) => [decisionKey(decision), decision]));
      for (const cached of cachedDecisions) {
        const kalshi = cached.venues.find((venue) => venue.venue === "Kalshi");
        if (!kalshi) continue;
        const active = byKey.get(decisionKey(cached));
        if (active) byKey.set(decisionKey(cached), { ...active, venues: [...active.venues.filter((venue) => venue.venue !== "Kalshi"), kalshi] });
        else byKey.set(decisionKey(cached), { ...cached, venues: [kalshi] });
      }
      current = { ...current, data: { ...current.data, decisions: [...byKey.values()].sort((a, b) => (a.meetingDate ?? "").localeCompare(b.meetingDate ?? "")) } };
      if (cachedDecisions.some((decision) => decision.venues.some((venue) => venue.venue === "Kalshi"))) fallbacks.push({ source: source.source, cachedAt });
    }
  }

  return { feed: current, providerFetchedAt, fallbacks };
}

export function storedCache(feed: CacheEnvelope, providerFetchedAt: Record<string, string>): StoredFeedCache {
  return { version: 1, feed, providerFetchedAt };
}

export function freshKalshiAiTickers(stored: StoredFeedCache | null, now = Date.now()) {
  if (!stored || !KALSHI_AI_SOURCES.every((source) => freshEnough(stored.providerFetchedAt[source], now))) return [];
  const tickers = [...new Set((stored.feed.data.forecasts ?? []).flatMap((forecast) => forecast.points).filter((point) => point.venue === "Kalshi").map((point) => typeof point.symbol === "string" ? point.symbol : "").filter((ticker) => /^KX(?:GPT|CLAUDE|GEMINI|GROK)-[A-Z0-9-]+$/.test(ticker)))].sort();
  return ["KXGPT-", "KXCLAUDE-", "KXGEMINI-", "KXGROK-"].every((prefix) => tickers.some((ticker) => ticker.startsWith(prefix))) ? tickers : [];
}
