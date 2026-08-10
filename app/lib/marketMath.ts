export type ConsensusVenue = {
  venue: string;
  outcomes: Array<{ label: string; probability: number }>;
};

export function buildConsensus(venues: ConsensusVenue[], labels: string[]) {
  const eligibleVenues = venues.filter((venue) =>
    (venue.venue === "Polymarket" || venue.venue === "Kalshi") &&
    labels.every((label) => venue.outcomes.some((outcome) => outcome.label === label)),
  );
  const outcomes = labels.map((label) => {
    const values = eligibleVenues.flatMap((venue) => {
      const total = venue.outcomes.reduce((sum, outcome) => sum + outcome.probability, 0);
      const outcome = venue.outcomes.find((item) => item.label === label);
      return outcome && total > 0 ? [(outcome.probability / total) * 100] : [];
    });
    return {
      label,
      mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      low: values.length ? Math.min(...values) : null,
      high: values.length ? Math.max(...values) : null,
      sourceCount: values.length,
    };
  });
  return { eligibleVenues, outcomes };
}

export function percentagesToTenths(values: Array<number | null>) {
  if (values.some((value) => value == null)) return values;
  const exact = values.map((value) => value! * 10);
  const units = exact.map(Math.floor);
  const remaining = 1000 - units.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) })).sort((a, b) => b.remainder - a.remainder);
  for (let index = 0; index < remaining; index++) units[order[index % order.length].index] += 1;
  return units.map((value) => value / 10);
}

export type DatedForecastPoint = { venue: string; probability: number; deadline: string | null };

export function fitDatedForecast(points: DatedForecastPoint[], now = Date.now()) {
  const byVenue = new Map<string, DatedForecastPoint[]>();
  for (const point of points) byVenue.set(point.venue, [...(byVenue.get(point.venue) ?? []), point]);
  const venueCurves = [...byVenue.entries()].flatMap(([venue, venuePoints]) => {
    let runningProbability = 0;
    const grouped = new Map<number, number[]>();
    for (const point of venuePoints) {
      const timestamp = point.deadline ? new Date(point.deadline).getTime() : NaN;
      if (!Number.isFinite(timestamp) || timestamp <= now) continue;
      grouped.set(timestamp, [...(grouped.get(timestamp) ?? []), Math.min(.995, Math.max(0, point.probability / 100))]);
    }
    const samples = [...grouped.entries()]
      .map(([timestamp, probabilities]) => ({ timestamp, probability: probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length }))
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((sample) => ({ ...sample, probability: runningProbability = Math.max(runningProbability, sample.probability) }));
    return samples.length >= 2 && samples.at(-1)!.probability > 0 ? [{ venue, samples }] : [];
  });
  if (!venueCurves.length) return null;

  const commonEnd = Math.min(...venueCurves.map((curve) => curve.samples.at(-1)!.timestamp));
  const timestamps = [...new Set([now, ...venueCurves.flatMap((curve) => curve.samples.map((sample) => sample.timestamp).filter((timestamp) => timestamp <= commonEnd)), commonEnd])].sort((a, b) => a - b);
  const interpolate = (samples: Array<{ timestamp: number; probability: number }>, timestamp: number) => {
    const anchored = [{ timestamp: now, probability: 0 }, ...samples];
    for (let index = 1; index < anchored.length; index++) {
      const previous = anchored[index - 1];
      const current = anchored[index];
      if (timestamp > current.timestamp) continue;
      const share = (timestamp - previous.timestamp) / Math.max(1, current.timestamp - previous.timestamp);
      return previous.probability + share * (current.probability - previous.probability);
    }
    return samples.at(-1)!.probability;
  };
  let runningProbability = 0;
  const aggregate = timestamps.map((timestamp) => {
    const probability = venueCurves.reduce((sum, curve) => sum + interpolate(curve.samples, timestamp), 0) / venueCurves.length;
    return { timestamp, probability: runningProbability = Math.max(runningProbability, probability) };
  });
  const quantile = (probability: number): number | null => {
    for (let index = 1; index < aggregate.length; index++) {
      const previous = aggregate[index - 1];
      const current = aggregate[index];
      if (current.probability < probability) continue;
      const share = current.probability === previous.probability ? 1 : (probability - previous.probability) / (current.probability - previous.probability);
      return previous.timestamp + share * (current.timestamp - previous.timestamp);
    }
    return null;
  };
  const q10 = quantile(.1);
  const q25 = quantile(.25);
  const median = quantile(.5);
  if (q10 == null || q25 == null || median == null) return null;
  return {
    q10,
    q25,
    median,
    q75: quantile(.75),
    q90: quantile(.9),
    venues: venueCurves.map((curve) => curve.venue),
    venueCount: venueCurves.length,
    marketCount: venueCurves.reduce((sum, curve) => sum + curve.samples.length, 0),
  };
}

export function timePosition(timestamp: number, bounds: { start: number; end: number }) {
  return Math.max(0, Math.min(100, ((timestamp - bounds.start) / (bounds.end - bounds.start)) * 100));
}
