import assert from "node:assert/strict";
import test from "node:test";
import { buildMedianHistory, weeklyMedianMovement } from "../app/lib/forecastHistory.ts";

test("reconstructs weekly median movement from dated contract histories", () => {
  const now = Date.parse("2026-08-09T12:00:00Z");
  const t0 = Math.floor(Date.parse("2026-07-20T12:00:00Z") / 1000);
  const t1 = Math.floor(Date.parse("2026-08-02T12:00:00Z") / 1000);
  const t2 = Math.floor(now / 1000);
  const contracts = [
    { deadline: "2026-09-01T00:00:00Z", history: [{ t: t0, p: .2 }, { t: t1, p: .35 }, { t: t2, p: .45 }] },
    { deadline: "2026-10-01T00:00:00Z", history: [{ t: t0, p: .55 }, { t: t1, p: .7 }, { t: t2, p: .8 }] },
  ];
  const history = buildMedianHistory(contracts, now);
  assert.ok(history.length >= 2);
  assert.ok(weeklyMedianMovement(history) < 0);
});
