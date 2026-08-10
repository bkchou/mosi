import assert from "node:assert/strict";
import test from "node:test";
import { buildConsensus, fitDatedForecast, percentagesToTenths, timePosition } from "../app/lib/marketMath.ts";

test("normalizes complete independent venues and excludes mirrors or incomplete venues", () => {
  const labels = ["cut", "hold", "hike"];
  const complete = (venue, values) => ({ venue, outcomes: labels.map((label, index) => ({ label, probability: values[index] })) });
  const { eligibleVenues, outcomes } = buildConsensus([
    complete("Polymarket", [10, 60, 31]),
    { venue: "Kalshi", outcomes: [{ label: "hold", probability: 70 }] },
    complete("Pascal", [10, 60, 31]),
  ], labels);
  assert.deepEqual(eligibleVenues.map((venue) => venue.venue), ["Polymarket"]);
  assert.ok(Math.abs(outcomes.reduce((sum, outcome) => sum + outcome.mean, 0) - 100) < 1e-9);
  const displayed = percentagesToTenths(outcomes.map((outcome) => outcome.mean));
  assert.equal(displayed.reduce((sum, value) => sum + value, 0), 100);
});

test("leaves forecast tails unresolved when active contracts do not reach them", () => {
  const now = Date.UTC(2026, 0, 1);
  const point = (venue, month, probability) => ({ venue, probability, deadline: new Date(Date.UTC(2026, month, 1)).toISOString() });
  const fit = fitDatedForecast([
    point("Polymarket", 2, 25), point("Polymarket", 4, 60),
    point("Kalshi", 3, 30), point("Kalshi", 5, 65),
  ], now);
  assert.ok(fit);
  assert.equal(fit.venueCount, 2);
  assert.equal(fit.marketCount, 4);
  assert.ok(fit.q10 < fit.q25 && fit.q25 < fit.median);
  assert.equal(fit.q75, null);
  assert.equal(fit.q90, null);
});

test("combines venue probabilities before finding the implied date", () => {
  const day = 86400000;
  const now = Date.UTC(2026, 0, 1);
  const point = (venue, offset, probability) => ({ venue, probability, deadline: new Date(now + offset * day).toISOString() });
  const fit = fitDatedForecast([
    point("Polymarket", 10, 20), point("Polymarket", 20, 80),
    point("Kalshi", 10, 49), point("Kalshi", 30, 51),
  ], now);
  assert.ok(fit);
  const medianDay = (fit.median - now) / day;
  assert.ok(medianDay > 15 && medianDay < 16);
  assert.equal(fit.venueCount, 2);
});

test("uses the same proportional position for time axes and graph marks", () => {
  const bounds = { start: Date.UTC(2026, 7, 1), end: Date.UTC(2026, 11, 1) };
  const october = Date.UTC(2026, 9, 1);
  assert.equal(timePosition(bounds.start, bounds), 0);
  assert.equal(timePosition(bounds.end, bounds), 100);
  assert.ok(timePosition(october, bounds) > 49 && timePosition(october, bounds) < 51);
});
