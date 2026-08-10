import assert from "node:assert/strict";
import test from "node:test";
import { buildTreasuryCurve, overallStatus, parseAtlantaMpt, parseTreasuryYieldXml, readRecentSnapshot, requestForcesRefresh, retainLastLiveSnapshot } from "../functions/api/data.ts";

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

test("parses Atlanta Fed published SOFR path without synthetic values", () => {
  const html = `<script>
    var contract1_startDate = ["2026-09-16"]; var contract2_startDate = ["2026-12-16"];
    var contract3_startDate = ["2027-03-17"]; var contract4_startDate = ["2027-06-16"];
    var RateMovesBasisPoints = ["350 - 375"]; var dates = ["2026-08-06"];
    var RateMovesMidpoint1 = [["2026-08-06",386.008]]; var RateMovesMidpoint2 = [["2026-08-06",403.9724]];
    var RateMovesMidpoint3 = [["2026-08-06",412.9848]]; var RateMovesMidpoint4 = [["2026-08-06",416.048]];
    var RateMovesRange1 = [{"x":"2026-08-06","low":"376.05","high":"395.33"}];
    var RateMovesRange2 = [{"x":"2026-08-06","low":"376.09","high":"432.11"}];
    var RateMovesRange3 = [{"x":"2026-08-06","low":"373.63","high":"450.82"}];
    var RateMovesRange4 = [{"x":"2026-08-06","low":"368.13","high":"460.83"}];
  </script>`;
  const parsed = parseAtlantaMpt(html);
  assert.equal(parsed.asOf, "2026-08-06");
  assert.equal(parsed.currentTargetRange, "350 - 375");
  assert.deepEqual(parsed.points[0], { period: "2026-09-16", midpoint: 3.86008, low: 3.7605, high: 3.9533 });
  assert.equal(parsed.points.length, 4);
});

test("parses complete official Treasury curve observations", () => {
  const fields = (date, offset) => `<entry><m:properties><d:NEW_DATE m:type="Edm.DateTime">${date}T00:00:00</d:NEW_DATE>${[
    ["BC_3MONTH", 3.5], ["BC_1YEAR", 3.6], ["BC_2YEAR", 3.7], ["BC_5YEAR", 3.8], ["BC_10YEAR", 3.9], ["BC_30YEAR", 4.1],
  ].map(([key, value]) => `<d:${key} m:type="Edm.Double">${value + offset}</d:${key}>`).join("")}</m:properties></entry>`;
  const parsed = parseTreasuryYieldXml(`<feed>${fields("2026-08-06", 0)}${fields("2026-08-07", .01)}</feed>`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].period, "2026-08-07");
  assert.equal(parsed[1].values.BC_30YEAR, 4.109999999999999);
});

test("Treasury rollover tolerates an empty current-year feed and keeps valid comparison labels", () => {
  assert.deepEqual(parseTreasuryYieldXml("<feed></feed>", true), []);
  const values = { BC_3MONTH: 3.5, BC_1YEAR: 3.6, BC_2YEAR: 3.7, BC_5YEAR: 3.8, BC_10YEAR: 3.9, BC_30YEAR: 4.1 };
  const curve = buildTreasuryCurve([
    { period: "2024-12-30", values },
    { period: "2025-11-28", values },
    { period: "2025-12-31", values },
  ]);
  assert.equal(curve.asOf, "2025-12-31");
  assert.deepEqual(curve.curves.map((item) => [item.label, item.period]), [["Latest", "2025-12-31"], ["1 month ago", "2025-11-28"], ["1 year ago", "2024-12-30"]]);
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
