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
  const venueFits = [...byVenue.entries()].flatMap(([venue, venuePoints]) => {
    let runningProbability = 0;
    const samples = venuePoints
      .filter((point) => point.deadline && new Date(point.deadline).getTime() > now)
      .map((point) => ({ timestamp: new Date(point.deadline!).getTime(), probability: Math.min(.995, Math.max(0, point.probability / 100)) }))
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((sample) => ({ ...sample, probability: runningProbability = Math.max(runningProbability, sample.probability) }));
    if (samples.length < 2 || samples.at(-1)!.probability <= 0) return [];
    const anchored = [{ timestamp: now, probability: 0 }, ...samples];
    const quantile = (probability: number): number | null => {
      for (let index = 1; index < anchored.length; index++) {
        const previous = anchored[index - 1];
        const current = anchored[index];
        if (current.probability < probability) continue;
        const share = current.probability === previous.probability ? 1 : (probability - previous.probability) / (current.probability - previous.probability);
        return previous.timestamp + share * (current.timestamp - previous.timestamp);
      }
      return null;
    };
    const q10 = quantile(.1);
    const q25 = quantile(.25);
    const median = quantile(.5);
    if (q10 == null || q25 == null || median == null) return [];
    return [{ venue, marketCount: samples.length, q10, q25, median, q75: quantile(.75), q90: quantile(.9) }];
  });
  if (!venueFits.length) return null;
  const mean = (key: "q10" | "q25" | "median") => venueFits.reduce((sum, fit) => sum + fit[key], 0) / venueFits.length;
  const optionalMean = (key: "q75" | "q90") => venueFits.every((fit) => fit[key] != null) ? venueFits.reduce((sum, fit) => sum + fit[key]!, 0) / venueFits.length : null;
  return {
    q10: mean("q10"),
    q25: mean("q25"),
    median: mean("median"),
    q75: optionalMean("q75"),
    q90: optionalMean("q90"),
    venues: venueFits.map((fit) => fit.venue),
    venueCount: venueFits.length,
    marketCount: venueFits.reduce((sum, fit) => sum + fit.marketCount, 0),
  };
}

export function timePosition(timestamp: number, bounds: { start: number; end: number }) {
  return Math.max(0, Math.min(100, ((timestamp - bounds.start) / (bounds.end - bounds.start)) * 100));
}
