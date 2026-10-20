import { useMemo } from "react";
import type { PrintsData } from "../../functions/lib/macro";
import { EmptyState, fmtDate, fmtPeriod } from "./ui";

export type { PrintsData };

type Print = PrintsData["prints"][number];
type Bucket = Print["buckets"][number];

function fmtValue(print: Pick<Print, "unit">, value: number, decimals = 1) {
  if (print.unit === "k") return `${value < 0 ? "−" : ""}${Math.abs(Math.round(value / 1000))}k`;
  return `${value < 0 ? "−" : ""}${Math.abs(value).toFixed(decimals)}%`;
}

function bucketLabel(print: Print, bucket: Bucket) {
  const step = (value: number) => print.unit === "k" ? fmtValue(print, value) : fmtValue(print, value).replace("%", "");
  if (bucket.low == null) return `≤${step(bucket.high!)}`;
  if (bucket.high == null) return `>${step(bucket.low)}`;
  if (bucket.high - bucket.low <= print.resolution + 1e-9) return step(bucket.high);
  return `${step(bucket.low)} to ${step(bucket.high)}`;
}

/** Where a value sits on the bucket axis, after rounding it the way the agency would report it. */
function bucketPosition(print: Print, value: number) {
  const reported = Math.round(value / print.resolution) * print.resolution;
  const index = print.buckets.findIndex((bucket) => (bucket.low == null || reported > bucket.low + 1e-9) && (bucket.high == null || reported <= bucket.high + 1e-9));
  if (index < 0) return null;
  const bucket = print.buckets[index];
  const single = bucket.low == null || bucket.high == null || bucket.high - bucket.low <= print.resolution + 1e-9;
  const share = single ? .5 : (reported - bucket.low!) / (bucket.high! - bucket.low!);
  return ((index + Math.min(1, Math.max(0, share))) / print.buckets.length) * 100;
}

function countdown(releaseAt: string | null, now: number) {
  if (!releaseAt) return "";
  const days = Math.round((startOfEasternDay(Date.parse(releaseAt)) - startOfEasternDay(now)) / 86_400_000);
  return days <= 0 ? "Today" : days === 1 ? "Tomorrow" : `In ${days} days`;
}

function startOfEasternDay(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "America/New_York" }).formatToParts(new Date(timestamp));
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"));
}

export function NextPrints({ prints, generatedAt, loading }: { prints: Print[]; generatedAt: string | null; loading: boolean }) {
  const now = generatedAt ? Date.parse(generatedAt) : 0;
  const days = useMemo(() => {
    const groups = new Map<string, Print[]>();
    for (const print of prints) groups.set(print.releaseAt ?? "", [...(groups.get(print.releaseAt ?? "") ?? []), print]);
    return [...groups.entries()];
  }, [prints]);

  return <section className="print-days" id="prints" aria-labelledby="prints-title">
    <h2 className="section-title" id="prints-title">Next prints</h2>
    {!days.length && <EmptyState title={loading ? "Loading release contracts…" : "No upcoming release contracts are open"} compact />}
    {days.map(([releaseAt, prints]) => <section className="print-day" key={releaseAt} aria-label={`Releases on ${fmtDate(releaseAt)}`}>
      <header className="print-day-head">
        <strong>{fmtDate(releaseAt, { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" })}</strong>
        <span>{fmtDate(releaseAt, { hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" })}</span>
        <small>{countdown(releaseAt, now)}</small>
      </header>
      <div className="print-grid">{prints.map((print) => <PrintCard print={print} key={print.key} />)}</div>
    </section>)}
    {!!days.length && <p className="print-note">Kalshi bid/ask midpoints, smoothed so odds never rise with the strike.</p>}
  </section>;
}

function PrintCard({ print }: { print: Print }) {
  const maxProbability = Math.max(...print.buckets.map((bucket) => bucket.probability), .01);
  const medianLabel = print.median == null ? "—" : `${print.medianBound === "below" ? "≤" : print.medianBound === "above" ? ">" : ""}${fmtValue(print, print.median)}`;
  const lastPosition = print.last ? bucketPosition(print, print.last.value) : null;
  const nowcastPosition = print.nowcast ? bucketPosition(print, print.nowcast.value) : null;
  const periodLabel = fmtPeriod(print.period, print.cadence, "long");
  return <article className="panel print-card">
    <header className="print-card-head">
      <div><h2>{print.label}</h2><small>{periodLabel} · {print.detail}</small></div>
      <div className="print-median"><span>MARKET MEDIAN</span><strong>{medianLabel}</strong></div>
    </header>
    <div className="print-histogram" role="img" aria-label={`${print.label} ${periodLabel}: ${print.buckets.map((bucket) => `${bucketLabel(print, bucket)} ${Math.round(bucket.probability * 100)}%`).join(", ")}`}>
      <div className="print-bars" style={{ gridTemplateColumns: `repeat(${print.buckets.length}, minmax(0, 1fr))` }}>
        {print.buckets.map((bucket, index) => <div className="print-bar" key={index}>
          <small>{bucket.probability >= .005 ? Math.round(bucket.probability * 100) : ""}</small>
          <span style={{ height: `${(bucket.probability / maxProbability) * 100}%` }} />
        </div>)}
        {lastPosition != null && <i className="print-marker last" style={{ left: `${lastPosition}%` }} />}
        {nowcastPosition != null && <i className="print-marker nowcast" style={{ left: `${nowcastPosition}%` }} />}
      </div>
      {print.buckets.some((bucket) => bucket.low != null && bucket.high != null && bucket.high - bucket.low > print.resolution + 1e-9)
        // Wide buckets are labeled at their edges, where the contract strikes sit.
        ? <div className="print-axis edges">{print.buckets.slice(1).map((bucket, index) => <span style={{ left: `${((index + 1) / print.buckets.length) * 100}%` }} key={index}>{fmtValue(print, bucket.low!).replace("%", "")}</span>)}</div>
        : <div className="print-axis" style={{ gridTemplateColumns: `repeat(${print.buckets.length}, minmax(0, 1fr))` }}>{print.buckets.map((bucket, index) => <span key={index}>{bucketLabel(print, bucket)}</span>)}</div>}
    </div>
    <footer className={`print-card-foot ${print.nowcast ? "" : "no-nowcast"}`}>
      {print.last ? <a href={print.last.sourceUrl} target="_blank" rel="noreferrer"><i className="last" /><span>Last · {fmtPeriod(print.last.period, print.cadence)}</span><strong>{fmtValue(print, print.last.value)}</strong></a> : <span />}
      {print.nowcast && <a href={print.nowcast.sourceUrl} target="_blank" rel="noreferrer"><i className="nowcast" /><span>{print.nowcast.source}</span><strong>{fmtValue(print, print.nowcast.value, 2)}</strong></a>}
      <a href={print.url} target="_blank" rel="noreferrer" className="print-source"><span>Kalshi · {print.thresholds.length} contracts</span><strong>{Math.round(print.volume).toLocaleString("en-US")} traded ↗</strong></a>
    </footer>
  </article>;
}
