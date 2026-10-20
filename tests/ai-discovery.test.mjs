import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { aiForecasts, aiForecastsFromEvents } from "../functions/api/data.ts";

const { events } = JSON.parse(readFileSync(new URL("./fixtures/ai-release-events.json", import.meta.url), "utf8"));
const now = new Date("2026-09-17T12:00:00Z");

test("discovers all 14 Release Oracle models from real Polymarket contracts", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const forecasts = aiForecasts(aiForecastsFromEvents(events), [[], [], [], []], []).forecasts;
  const expected = [
    ["Anthropic", "Next Claude Opus"], ["OpenAI", "GPT Luna 5.7+"],
    ["Z.ai", "GLM 5.4+"], ["Anthropic", "Next Claude Sonnet"],
    ["Meta", "Muse Spark 1.4+"], ["Google", "Next Gemini Pro"],
    ["Anthropic", "Fable 5.2+"], ["Google", "Gemini 4.0 Flash"],
    ["Meta", 'Meta\'s "Watermelon" model'], ["xAI", "Grok 5"],
    ["Anthropic", "Claude 6+ (any family)"], ["OpenAI", "GPT-7"],
    ["OpenAI", "GPT Terra 5.7+"], ["SSI", "SSI public model"],
  ];
  for (const [company, model] of expected) {
    const forecast = forecasts.find((item) => item.company === company && item.model === model);
    assert.ok(forecast, model);
    assert.equal(forecast.status, "live", model);
    assert.ok(forecast.points.length >= 2, model);
    assert.ok(forecast.points.every((point) => point.venue === "Polymarket" && Date.parse(point.deadline) > now.getTime()), model);
  }
});

test("keeps unfamiliar models and different version thresholds distinct", () => {
  const names = ["Next Acme Nova (1.0+)", "Next Acme Nova (2.0+)", "Claude Opus 7", "Claude Opus 8", "GPT Astra 6.1+", "GPT Astra 6.2+"];
  const discovered = aiForecastsFromEvents(names.map((name, i) => ({ title: `${name} released by...?`, slug: `new-model-${i}`, markets: [] })));
  const shown = ["Acme Nova 1.0+", "Acme Nova 2.0+", ...names.slice(2)];
  for (const name of shown) assert.ok(discovered.some((forecast) => forecast.model === name), name);
  assert.equal(discovered.find((forecast) => forecast.model === shown[0]).company, "Unknown lab");
});

test("continues excluding noncumulative events and inactive or negative contracts", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const market = events.find((event) => event.title.startsWith("GPT-7")).markets[0];
  const forecasts = aiForecastsFromEvents([
    { title: "Next Acme model released on...?", slug: "daily", markets: [market] },
    { title: "When will the next Acme model be released?", slug: "buckets", markets: [market] },
    { title: "OpenAI social network released by...?", slug: "social", markets: [market] },
    { title: "Next Acme model released by...?", slug: "cumulative", markets: [
      market, { ...market, active: false }, { ...market, closed: true },
      { ...market, acceptingOrders: false },
      { ...market, question: "Will the next Acme model not be released by December 31, 2026?" },
      { ...market, question: "Will the next Acme model be released by January 1, 2026?" },
    ] },
  ]);
  assert.ok(!forecasts.some((forecast) => ["daily", "buckets", "social"].includes(forecast.slug)));
  assert.equal(forecasts.find((forecast) => forecast.slug === "cumulative").points.length, 1);
});

test("merges Kalshi GPT-6 contracts only into GPT-6", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const poly = aiForecastsFromEvents([...events, { title: "Astra released by...?", slug: "astra", markets: [] }]);
  const kalshi = [{ ticker: "KXGPT-OPEN-26DEC31", event_ticker: "KXGPT-OPEN", title: "Will OpenAI release GPT-6 before December 31, 2026?", status: "active", close_time: "2026-12-31T23:59:00Z", last_price_dollars: "0.50" }];
  const result = aiForecasts(poly, [kalshi, [], [], []], []).forecasts;
  assert.equal(result.find((forecast) => forecast.model === "GPT-6").points.filter((point) => point.venue === "Kalshi").length, 1);
  for (const model of ["GPT Luna 5.7+", "GPT Terra 5.7+", "GPT-7", "Astra"]) {
    assert.ok(result.find((forecast) => forecast.model === model).points.every((point) => point.venue !== "Kalshi"), model);
  }
});

test("keeps every current Kalshi release event and separates different venue thresholds", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const { markets } = JSON.parse(readFileSync(new URL("./fixtures/kalshi-live-markets.json", import.meta.url), "utf8"));
  const poly = aiForecastsFromEvents([...events, { title: "GPT Astra 6.1+ released by...?", slug: "astra-plus", markets: [] }]);
  const { forecasts } = aiForecasts(poly, [markets], []);
  for (const eventTicker of new Set(markets.map((market) => market.event_ticker))) {
    const expected = markets.filter((market) => market.event_ticker === eventTicker && Date.parse(market.close_time) > now.getTime());
    const actual = forecasts.flatMap((forecast) => forecast.points).filter((point) => point.symbol?.startsWith(`${eventTicker}-`));
    assert.equal(actual.length, expected.length, eventTicker);
  }
  assert.ok(!forecasts.some((forecast) => forecast.model === "Astra 6.1"));
  assert.equal(forecasts.find((forecast) => forecast.model === "GPT Astra 6.1+").points.filter((point) => point.venue === "Kalshi").length, 8);
  const claude6 = forecasts.filter((forecast) => forecast.model === "Claude 6+ (any family)");
  assert.equal(claude6.length, 1);
  assert.equal(claude6[0].points.filter((point) => point.venue === "Polymarket").length, 3);
  assert.equal(claude6[0].points.filter((point) => point.venue === "Kalshi").length, 5);
  assert.ok(!forecasts.some((forecast) => forecast.model === "Claude 6"));
  assert.equal(forecasts.find((forecast) => forecast.model === "Gemini 4.0 Flash").points.length, 3);
  assert.equal(forecasts.find((forecast) => forecast.model === "Gemini 4").points.length, 6);
  assert.equal(forecasts.find((forecast) => forecast.model === "Next Claude Opus").points.length, 7);
  assert.equal(forecasts.find((forecast) => forecast.model === "Opus 6").points.length, 3);
  const geminiPro = forecasts.filter((forecast) => forecast.model === "Next Gemini Pro");
  assert.equal(geminiPro.length, 1);
  assert.equal(geminiPro[0].points.filter((point) => point.venue === "Kalshi").length, 5);
  assert.equal(geminiPro[0].points.filter((point) => point.venue === "Polymarket").length, 3);
  const invalid = aiForecasts([], [[{ ...markets[0], close_time: "invalid" }, { ...markets[0], status: "closed" }]], []);
  assert.deepEqual(invalid.forecasts, []);
});
