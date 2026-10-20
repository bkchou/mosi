import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIndicator, buildPrint, monotoneSurvival, nextPrintEvent, parseClevelandNowcasts, parseFredCsv, PRINT_SPECS,
  printPeriod, recessionMarketsFromKalshi, recessionMarketsFromPolymarket, recessionSpans, releaseTime, thresholdDistribution, transformPrints,
} from "../functions/lib/macro.ts";

const ladder = (event, close, rows) => rows.map(([strike, bid, ask]) => ({
  ticker: `${event}-T${strike}`, event_ticker: event, title: `Above ${strike}?`, status: "active", strike_type: "greater",
  floor_strike: strike, yes_bid_dollars: String(bid), yes_ask_dollars: String(ask), volume_fp: "100", close_time: close,
}));

test("smooths a threshold ladder so odds never rise with the strike", () => {
  const fitted = monotoneSurvival([{ strike: .1, probability: .9 }, { strike: .2, probability: .5 }, { strike: .3, probability: .6 }, { strike: .4, probability: .1 }]);
  assert.deepEqual(fitted.map((point) => Number(point.probability.toFixed(3))), [.9, .55, .55, .1]);
});

test("turns survival odds into reported-value buckets and a median", () => {
  const cpi = thresholdDistribution([[0, .99], [.1, .9], [.2, .7], [.3, .3], [.4, .05], [.5, .01]].map(([strike, probability]) => ({ strike, probability })), .1);
  assert.equal(cpi.median, .3);
  assert.equal(cpi.buckets[0].high, 0);
  assert.equal(cpi.buckets.at(-1).low, .5);
  assert.ok(Math.abs(cpi.buckets.reduce((sum, bucket) => sum + bucket.probability, 0) - 1) < 1e-9);
  // Wide contract steps interpolate and round to the reporting grid instead of jumping to the next strike.
  const gdp = thresholdDistribution([[2.5, .8], [3, .7], [3.5, .38], [4, .2]].map(([strike, probability]) => ({ strike, probability })), .1);
  assert.equal(gdp.median, 3.3);
  assert.equal(thresholdDistribution([{ strike: 1, probability: .9 }, { strike: 2, probability: .8 }], .1).medianBound, "above");
});

test("reads reference periods and release times from Kalshi events", () => {
  assert.equal(printPeriod("KXCPI-26OCT", "month"), "2026-10-01");
  assert.equal(printPeriod("KXGDP-26OCT30", "quarter"), "2026-07-01");
  assert.equal(printPeriod("KXGDP-27JAN28", "quarter"), "2026-10-01");
  assert.equal(releaseTime("2026-11-10T13:29:00Z"), "2026-11-10T13:30:00.000Z");
  assert.equal(releaseTime("2026-10-29T12:25:00Z"), "2026-10-29T12:30:00.000Z");
});

test("picks the nearest open event and pairs it with the prior print and nowcast", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const markets = [
    ...ladder("KXCPI-26NOV", "2026-12-10T13:29:00Z", [[.2, .6, .62], [.3, .3, .32]]),
    ...ladder("KXCPI-26OCT", "2026-11-10T13:29:00Z", [[.1, .89, .91], [.2, .69, .71], [.3, .29, .31], [.4, .04, .06]]),
    ...ladder("KXCPI-26SEP", "2026-10-15T12:29:00Z", [[.2, .5, .5], [.3, .5, .5]]),
  ];
  assert.ok(nextPrintEvent(markets, now).every((market) => market.event_ticker === "KXCPI-26OCT"));
  const observations = parseFredCsv("observation_date,CPIAUCSL\n2026-08-01,330.0\n2026-09-01,332.0\n2026-10-01,.\n");
  const print = buildPrint(PRINT_SPECS.find((spec) => spec.key === "cpi"), {
    markets, observations, clevelandMonth: new Map([["CPI Inflation|2026-10-01", .27]]), clevelandYear: new Map(), gdpNow: [],
  }, now);
  assert.equal(print.period, "2026-10-01");
  assert.equal(print.median, .3);
  assert.equal(print.last.period, "2026-09-01");
  assert.ok(Math.abs(print.last.value - (332 / 330 - 1) * 100) < 1e-9);
  assert.equal(print.nowcast.value, .27);
  assert.equal(print.releaseAt, "2026-11-10T13:30:00.000Z");
});

test("derives monthly changes, year-over-year rates and payroll differences", () => {
  const index = [{ period: "2025-09-01", value: 100 }, { period: "2026-08-01", value: 102 }, { period: "2026-09-01", value: 103 }];
  assert.ok(Math.abs(transformPrints(index, "yoy").at(-1).value - 3) < 1e-9);
  assert.deepEqual(transformPrints([{ period: "a", value: 159000 }, { period: "b", value: 159029 }], "diff", 1000), [{ period: "b", value: 29000 }]);
});

test("reads the latest Cleveland Fed estimate for each target month", () => {
  const nowcasts = parseClevelandNowcasts([{ chart: { subcaption: "2026-10" }, dataset: [
    { seriesname: "CPI Inflation", data: [{ value: "0.25" }, { value: "0.268" }, { value: "" }] },
    { seriesname: "Actual CPI Inflation", data: [{ value: "" }] },
  ] }]);
  assert.equal(nowcasts.get("CPI Inflation|2026-10-01"), .268);
  assert.equal(nowcasts.has("Actual CPI Inflation|2026-10-01"), false);
});

test("groups recession contracts by year from both venues", () => {
  const kalshi = recessionMarketsFromKalshi([{ ticker: "KXRECSSNBER-26", event_ticker: "KXRECSSNBER-26", title: "Will there be a recession in 2026?", yes_bid_dollars: "0.03", yes_ask_dollars: "0.04" }]);
  assert.deepEqual(kalshi.map(({ year, quote }) => [year, Number(quote.probability.toFixed(6))]), [[2026, 3.5]]);
  const polymarket = recessionMarketsFromPolymarket([
    { title: "US recession by end of 2027?", slug: "us-recession-by-end-of-2027-x", markets: [{ question: "US recession by end of 2027?", outcomes: '["Yes","No"]', outcomePrices: '["0.355","0.645"]' }] },
    { title: "Recession in Germany?", slug: "de", markets: [{ question: "?", outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]' }] },
  ]);
  assert.deepEqual(polymarket.map(({ year, quote }) => [year, Number(quote.probability.toFixed(6))]), [[2027, 35.5]]);
});

test("flags threshold indicators and shades NBER recessions", () => {
  const sahm = buildIndicator({ key: "sahm", fred: "SAHMREALTIME", label: "Sahm rule", detail: "", unit: "pp", threshold: { value: .5, direction: "above", label: "" } },
    [{ period: "2025-09-01", value: .2 }, { period: "2026-09-01", value: .53 }]);
  assert.equal(sahm.signal, true);
  assert.equal(sahm.yearAgo.value, .2);
  assert.deepEqual(recessionSpans([{ period: "2020-01-01", value: 0 }, { period: "2020-03-01", value: 1 }, { period: "2020-04-01", value: 1 }, { period: "2020-05-01", value: 0 }]), [{ start: "2020-03-01", end: "2020-05-01" }]);
});
