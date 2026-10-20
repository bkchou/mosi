export type KalshiAiIdentity = {
  company: string;
  model: string;
  color: string;
};

type AiSeries = {
  company: string;
  color: string;
};

const AI_SERIES: Record<string, AiSeries> = {
  KXGPT: { company: "OpenAI", color: "green" },
  KXCLAUDE: { company: "Anthropic", color: "coral" },
  KXGEMINI: { company: "Google", color: "blue" },
  KXGROK: { company: "xAI", color: "mono" },
};

const TITLE_COMPANIES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
  spacexai: "xAI",
};

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Identifies a Kalshi AI release market from its event and question text.
 *
 * The event ticker identifies the lab. Question text preserves model versions;
 * cross-venue aliases require matching release criteria.
 */
export function normalizeKalshiAiMarket(market: Record<string, unknown>): KalshiAiIdentity | null {
  const eventTicker = stringValue(market.event_ticker);
  const seriesName = eventTicker.split("-", 1)[0];
  const series = AI_SERIES[seriesName];
  if (!series || !new RegExp(`^${seriesName}-[A-Z0-9]+(?:-[A-Z0-9]+)*$`).test(eventTicker)) return null;

  const title = stringValue(market.title);
  const match = /^Will\s+(OpenAI|Anthropic|Google|xAI|SpaceXAI)\s+release\s+(.+?)\s+before\s+.+\?$/i.exec(title);
  if (!match) return null;

  const titleCompany = TITLE_COMPANIES[match[1].toLowerCase()];
  const model = match[2].replace(/\s+/g, " ").trim();
  if (titleCompany !== series.company || !model) return null;

  // Both contracts ask for the next public Gemini Pro release, without a version threshold.
  if (eventTicker === "KXGEMINI-NEXTPRO" && model.toLowerCase() === "next gemini pro model") {
    return { ...series, model: "Next Gemini Pro" };
  }
  return { ...series, model };
}
