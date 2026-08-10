import assert from "node:assert/strict";
import test from "node:test";
import { buildConsensus, buildExpectedPolicyPath, fitDatedForecast, percentagesToTenths, timePosition } from "../app/lib/marketMath.ts";

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

test("turns normalized meeting outcomes into a cumulative expected policy path", () => {
  const labels = ["Cut 50+ bp", "Cut 25 bp", "No change", "Hike 25 bp", "Hike 50+ bp"];
  const venue = (values) => ({ venue: "Polymarket", outcomes: labels.map((label, index) => ({ label, probability: values[index] })) });
  const path = buildExpectedPolicyPath([
    { label: "September decision", meetingDate: "2026-09-16T18:00:00Z", venues: [venue([0, 20, 60, 20, 0])] },
    { label: "October decision", meetingDate: "2026-10-28T18:00:00Z", venues: [venue([0, 0, 60, 40, 0])] },
  ], 3.625, labels, { "Cut 50+ bp": -50, "Cut 25 bp": -25, "No change": 0, "Hike 25 bp": 25, "Hike 50+ bp": 50 });
  assert.equal(path.length, 2);
  assert.equal(path[0].expectedMove, 0);
  assert.equal(path[0].expectedRate, 3.625);
  assert.equal(path[1].expectedMove, 10);
  assert.equal(path[1].expectedRate, 3.725);
});

test("stops the expected policy path at the first incomplete meeting", () => {
  const labels = ["cut", "hold", "hike"];
  const complete = { venue: "Polymarket", outcomes: labels.map((label, index) => ({ label, probability: [10, 70, 20][index] })) };
  const path = buildExpectedPolicyPath([
    { label: "September", meetingDate: "2026-09-16T18:00:00Z", venues: [{ venue: "Kalshi", outcomes: [{ label: "hold", probability: 80 }] }] },
    { label: "October", meetingDate: "2026-10-28T18:00:00Z", venues: [complete] },
  ], 4, labels, { cut: -25, hold: 0, hike: 25 });
  assert.deepEqual(path, []);
});
