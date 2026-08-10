import { fitDatedForecast } from "./marketMath.ts";

export type PriceHistoryPoint = { t: number; p: number };
export type HistoryContract = { deadline: string | null; tokenId?: string; history: PriceHistoryPoint[] };

export function buildMedianHistory(contracts: HistoryContract[], now = Date.now()) {
  const day = 86_400_000;
  const start = Math.max(now - 180 * day, ...contracts.flatMap((contract) => contract.history.slice(0, 1).map((point) => point.t * 1000)));
  const observations: Array<{ observedAt: number; median: number }> = [];
  for (let observedAt = start; observedAt <= now; observedAt += 7 * day) {
    const points = contracts.flatMap((contract) => {
      if (!contract.deadline || Date.parse(contract.deadline) <= observedAt) return [];
      const price = contract.history.filter((point) => point.t * 1000 <= observedAt).at(-1);
      return price ? [{ venue: "Polymarket", deadline: contract.deadline, probability: price.p * 100 }] : [];
    });
    const fit = fitDatedForecast(points, observedAt);
    if (fit?.median) observations.push({ observedAt, median: fit.median });
  }
  const latest = observations.at(-1);
  if (!latest || now - latest.observedAt > day) {
    const points = contracts.flatMap((contract) => {
      const price = contract.history.at(-1);
      return price && contract.deadline ? [{ venue: "Polymarket", deadline: contract.deadline, probability: price.p * 100 }] : [];
    });
    const fit = fitDatedForecast(points, now);
    if (fit?.median) observations.push({ observedAt: now, median: fit.median });
  }
  return observations;
}

export function weeklyMedianMovement(history: Array<{ observedAt: number; median: number }>) {
  const latest = history.at(-1);
  if (!latest) return null;
  const target = latest.observedAt - 7 * 86_400_000;
  const prior = history.filter((point) => point.observedAt <= target).at(-1);
  if (!prior) return null;
  return Math.round((latest.median - prior.median) / 86_400_000);
}
