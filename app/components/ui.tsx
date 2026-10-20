export function fmtTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function fmtDate(value: string | null, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", options ?? { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value));
}

/** FRED periods are the first day of the month or quarter they describe. */
export function fmtPeriod(period: string, cadence: "month" | "quarter" | "day" = "month", style: "short" | "long" = "short") {
  const date = new Date(`${period}T00:00:00Z`);
  if (cadence === "quarter") return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
  if (cadence === "day") return fmtDate(date.toISOString(), { month: "short", day: "numeric", timeZone: "UTC" });
  return fmtDate(date.toISOString(), { month: style, year: "numeric", timeZone: "UTC" });
}

export function PanelHeading({ kicker, title, aside }: { kicker: string; title: string; aside: string }) {
  return <div className="panel-heading"><div><span>{kicker}</span><h2>{title}</h2></div><small>{aside}</small></div>;
}

export function EmptyState({ title, detail, compact = false }: { title: string; detail?: string; compact?: boolean }) {
  return <div className={`empty-state ${compact ? "compact" : ""}`}><strong>{title}</strong>{detail && <span>{detail}</span>}</div>;
}
