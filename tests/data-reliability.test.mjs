import assert from "node:assert/strict";
import test from "node:test";
import { overallStatus, readRecentSnapshot, requestForcesRefresh, retainLastLiveSnapshot } from "../functions/api/data.ts";

const health = (source, status) => ({ source, status, fetchedAt: status === "unavailable" ? null : "2026-08-09T20:00:00.000Z" });

test("summarizes provider health without calling empty data live", () => {
  assert.equal(overallStatus([]), "stale");
  assert.equal(overallStatus([health("A", "live"), health("B", "live")]), "live");
  assert.equal(overallStatus([health("A", "live"), health("B", "unavailable")]), "partial");
  assert.equal(overallStatus([health("A", "stale"), health("B", "unavailable")]), "stale");
});

test("only explicit refresh requests bypass provider TTLs", () => {
  assert.equal(requestForcesRefresh(new Request("https://mosi.test/api/ai")), false);
  assert.equal(requestForcesRefresh(new Request("https://mosi.test/api/ai?refresh=123")), true);
});

test("partial refresh retains the prior live data while exposing current health", async () => {
  const previousCaches = globalThis.caches;
  const responses = new Map();
  globalThis.caches = { default: {
    async match(request) { return responses.get(request.url)?.clone(); },
    async put(request, response) { responses.set(request.url, response.clone()); },
  } };
  try {
    const request = new Request("https://mosi.test/api/ai?refresh=1");
    const live = { generatedAt: new Date().toISOString(), status: "live", sources: [health("A", "live")], data: { forecasts: ["complete"] } };
    assert.deepEqual(await retainLastLiveSnapshot(request, live), live);
    assert.deepEqual(await readRecentSnapshot(new Request("https://mosi.test/api/ai")), live);

    const partial = { generatedAt: new Date().toISOString(), status: "partial", sources: [health("A", "unavailable")], data: { forecasts: [] } };
    const retained = await retainLastLiveSnapshot(new Request("https://mosi.test/api/ai?refresh=2"), partial);
    assert.equal(retained.status, "partial");
    assert.deepEqual(retained.sources, partial.sources);
    assert.deepEqual(retained.data, live.data);
  } finally {
    if (previousCaches === undefined) delete globalThis.caches;
    else globalThis.caches = previousCaches;
  }
});
