import assert from "node:assert/strict";
import test from "node:test";
import { freshKalshiAiTickers, mergeWithLocalCache, storedCache } from "../app/lib/localFeedCache.ts";

const now = Date.parse("2026-08-10T12:00:00Z");
const quote = (venue, deadline) => ({ venue, deadline, title: `${venue} quote` });
const envelope = (sources, data, generatedAt = "2026-08-10T12:00:00Z") => ({ generatedAt, status: "partial", sources, data });

test("retains fresh device-local Kalshi AI points when the current provider is unavailable", () => {
  const cachedAt = "2026-08-10T11:30:00Z";
  const cachedFeed = envelope([{ source: "Kalshi GPT contracts", status: "live", fetchedAt: cachedAt }], { forecasts: [
    { company: "OpenAI", model: "GPT-6", points: [quote("Polymarket", "2026-09-01"), quote("Kalshi", "2026-10-01")] },
    { company: "OpenAI", model: "Astra", points: [quote("Kalshi", "2026-11-01"), quote("Kalshi", "2026-12-01")] },
  ] });
  const stored = storedCache(cachedFeed, { "Kalshi GPT contracts": cachedAt });
  const current = envelope([{ source: "Kalshi GPT contracts", status: "unavailable", fetchedAt: null }], { forecasts: [
    { company: "OpenAI", model: "GPT-6", points: [quote("Polymarket", "2026-09-01")] },
  ] });
  const merged = mergeWithLocalCache("models", current, stored, now);
  assert.equal(merged.feed.data.forecasts.length, 2);
  assert.deepEqual(merged.feed.data.forecasts.find((item) => item.model === "GPT-6").points.map((point) => point.venue), ["Polymarket", "Kalshi"]);
  assert.deepEqual(merged.fallbacks, [{ source: "Kalshi GPT contracts", cachedAt }]);
});

test("does not reuse Kalshi points older than six hours", () => {
  const cachedAt = "2026-08-10T05:00:00Z";
  const stored = storedCache(envelope([], { forecasts: [{ company: "OpenAI", model: "Astra", points: [quote("Kalshi", "2026-11-01")] }] }), { "Kalshi GPT contracts": cachedAt });
  const current = envelope([{ source: "Kalshi GPT contracts", status: "unavailable", fetchedAt: null }], { forecasts: [] });
  const merged = mergeWithLocalCache("models", current, stored, now);
  assert.deepEqual(merged.feed.data.forecasts, []);
  assert.deepEqual(merged.fallbacks, []);
});

test("restores only the Kalshi venue for a current Fed meeting", () => {
  const cachedAt = "2026-08-10T11:00:00Z";
  const cached = envelope([], { decisions: [{ meetingDate: "2026-09-16T18:00:00Z", venues: [{ venue: "Polymarket" }, { venue: "Kalshi", outcomes: ["cached"] }] }] });
  const stored = storedCache(cached, { "Kalshi Fed decisions": cachedAt });
  const current = envelope([{ source: "Kalshi Fed decisions", status: "unavailable", fetchedAt: null }], { decisions: [{ meetingDate: "2026-09-16T23:59:00Z", venues: [{ venue: "Polymarket", outcomes: ["fresh"] }] }] });
  const merged = mergeWithLocalCache("fed", current, stored, now);
  assert.deepEqual(merged.feed.data.decisions[0].venues.map((venue) => venue.venue), ["Polymarket", "Kalshi"]);
  assert.equal(merged.fallbacks.length, 1);
});

test("reuses exact Kalshi AI tickers only after every series refreshed recently", () => {
  const cachedAt = "2026-08-10T11:30:00Z";
  const sources = ["Kalshi GPT contracts", "Kalshi Claude contracts", "Kalshi Gemini contracts", "Kalshi Grok contracts"];
  const stored = storedCache(envelope([], { forecasts: [{ company: "OpenAI", model: "GPT-6", points: [
    { venue: "Kalshi", deadline: "2026-09-01", symbol: "KXGPT-OPEN-26SEP01" },
    { venue: "Kalshi", deadline: "2026-09-01", symbol: "KXCLAUDE-NXTMYTH-26SEP01" },
    { venue: "Kalshi", deadline: "2026-09-01", symbol: "KXGEMINI-GEMI35P-26SEP01" },
    { venue: "Kalshi", deadline: "2026-09-01", symbol: "KXGROK-GROK5-26SEP01" },
    { venue: "Polymarket", deadline: "2026-09-01", symbol: "ignored" },
  ] }] }), Object.fromEntries(sources.map((source) => [source, cachedAt])));
  assert.deepEqual(freshKalshiAiTickers(stored, now), ["KXCLAUDE-NXTMYTH-26SEP01", "KXGEMINI-GEMI35P-26SEP01", "KXGPT-OPEN-26SEP01", "KXGROK-GROK5-26SEP01"]);
  delete stored.providerFetchedAt["Kalshi Grok contracts"];
  assert.deepEqual(freshKalshiAiTickers(stored, now), []);
});

test("a one-request ticker refresh does not postpone full series discovery", () => {
  const discoveredAt = "2026-08-10T06:15:00Z";
  const sources = ["Kalshi GPT contracts", "Kalshi Claude contracts", "Kalshi Gemini contracts", "Kalshi Grok contracts"];
  const stored = storedCache(envelope([], { forecasts: [] }), Object.fromEntries(sources.map((source) => [source, discoveredAt])));
  const batch = envelope(sources.map((source) => ({ source, status: "live", fetchedAt: "2026-08-10T12:00:00Z", note: "One-request cached-ticker refresh." })), { forecasts: [] });
  const merged = mergeWithLocalCache("models", batch, stored, now);
  assert.deepEqual(merged.providerFetchedAt, Object.fromEntries(sources.map((source) => [source, discoveredAt])));
});
