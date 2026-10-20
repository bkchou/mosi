import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeKalshiAiMarket } from "../app/lib/kalshiAi.ts";

const { markets } = JSON.parse(readFileSync(new URL("./fixtures/kalshi-ai-markets.json", import.meta.url), "utf8"));

test("maps Kalshi release markets by their exact event identity and title", () => {
  const grouped = Map.groupBy(markets, (market) => market.event_ticker);
  assert.equal(grouped.get("KXGPT-ASTRA61").length, 2);
  assert.deepEqual(normalizeKalshiAiMarket(grouped.get("KXGPT-ASTRA61")[0]), {
    company: "OpenAI", model: "Astra 6.1", color: "green",
  });
  assert.deepEqual(normalizeKalshiAiMarket(markets[3]), {
    company: "OpenAI", model: "GPT-6", color: "green",
  });
  assert.deepEqual(normalizeKalshiAiMarket(markets[4]), {
    company: "xAI", model: "Grok 5", color: "mono",
  });
  assert.deepEqual(normalizeKalshiAiMarket(markets[5]), {
    company: "xAI", model: "Grok 4.6", color: "mono",
  });
  assert.deepEqual(normalizeKalshiAiMarket(markets[11]), {
    company: "xAI", model: "Grok 4.7", color: "mono",
  });
});

test("preserves unfamiliar model and version labels without threshold aliases", () => {
  const astra61 = normalizeKalshiAiMarket(markets[0]);
  const astra62 = normalizeKalshiAiMarket(markets[2]);
  const luna = normalizeKalshiAiMarket({
    event_ticker: "KXGPT-LUNA57",
    title: "Will OpenAI release Luna 5.7 before Nov 14, 2026?",
  });
  assert.equal(astra61.model, "Astra 6.1");
  assert.equal(astra62.model, "Astra 6.2");
  assert.notEqual(astra61.model, astra62.model);
  assert.deepEqual(luna, { company: "OpenAI", model: "Luna 5.7", color: "green" });
  assert.deepEqual(normalizeKalshiAiMarket(markets[6]), {
    company: "Anthropic", model: "Claude 6+ (any family)", color: "coral",
  });
  assert.deepEqual(normalizeKalshiAiMarket(markets[9]), {
    company: "Google", model: "Next Gemini Pro", color: "blue",
  });
});

test("rejects markets whose question does not match their Kalshi AI series", () => {
  assert.equal(normalizeKalshiAiMarket({
    event_ticker: "KXGPT-GROK5",
    title: "Will xAI release Grok 5 before Dec 31, 2026?",
  }), null);
  assert.equal(normalizeKalshiAiMarket({
    event_ticker: "KXPETS-ASTRA61",
    title: "Will OpenAI release Astra 6.1 before Sep 25, 2026?",
  }), null);
  assert.equal(normalizeKalshiAiMarket({
    event_ticker: "KXGPT-ASTRA61",
    title: "Will OpenAI release Astra 6.1 in 2026?",
  }), null);
});
