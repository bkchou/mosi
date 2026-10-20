import { useMemo } from "react";
import type { RecessionData } from "../../functions/lib/macro";
import { EmptyState, PanelHeading, fmtPeriod } from "./ui";

export type { RecessionData };

type Indicator = RecessionData["indicators"][number];

function fmtIndicator(indicator: Pick<Indicator, "unit">, value: number) {
  const sign = value < 0 ? "−" : "";
  const magnitude = Math.abs(value);
  if (indicator.unit === "bp") return `${sign}${magnitude.toFixed(0)}bp`;
  if (indicator.unit === "k") return `${sign}${magnitude.toFixed(magnitude >= 100 ? 0 : 1)}k`;
  if (indicator.unit === "pp") return `${sign}${magnitude.toFixed(2)}`;
  return `${sign}${magnitude.toFixed(magnitude < 10 ? 1 : 0)}%`;
}

export function RecessionScreen({ data, generatedAt, loading }: { data: RecessionData | null; generatedAt: string | null; loading: boolean }) {
  // Every indicator shares one time axis, so a series with a shorter history starts partway in.
  const domain = useMemo<Domain | null>(() => {
    const periods = data?.indicators.flatMap((indicator) => [indicator.history[0]?.period, indicator.latest.period]).filter(Boolean).map((period) => Date.parse(period!)) ?? [];
    if (!periods.length) return null;
    const start = Math.min(...periods), end = Math.max(...periods);
    const years: number[] = [];
    for (let year = new Date(start).getUTCFullYear() + 1; Date.UTC(year, 0, 1) <= end; year++) years.push(Date.UTC(year, 0, 1));
    return { start, end, years };
  }, [data?.indicators]);
  return <section className="dashboard-grid recession-grid">
    <article className="panel recession-odds-panel">
      <PanelHeading title="Recession odds" aside={generatedAt ? "Kalshi · Polymarket" : ""} />
      {data?.markets.length ? <div className="recession-years">
        {data.markets.map((market) => <div className="recession-year" key={market.year}>
          <h3>{market.year}</h3>
          {market.venues.map(({ venue, quote }) => <a className="recession-venue" href={quote.url} target="_blank" rel="noreferrer" key={venue}>
            <span>{venue}</span>
            <div className="recession-meter"><i style={{ width: `${Math.min(100, quote.probability)}%` }} /></div>
            <strong>{quote.probability < 10 ? quote.probability.toFixed(1) : quote.probability.toFixed(0)}%</strong>
            <small>{quote.volumeLabel}</small>
          </a>)}
        </div>)}
      </div> : <EmptyState title={loading ? "Loading recession contracts…" : "No recession contracts are open"} compact />}
    </article>

    <article className="panel gdp-panel">
      <PanelHeading title="Real GDP growth" aside="Annualized q/q · BEA" />
      {data?.gdp.quarters.length ? <GdpBars gdp={data.gdp} /> : <EmptyState title={loading ? "Loading GDP…" : "GDP unavailable"} compact />}
    </article>

    <div className="indicator-grid">
      {data?.indicators.map((indicator) => <IndicatorCard indicator={indicator} recessions={data.recessions} domain={domain!} key={indicator.key} />)}
    </div>
  </section>;
}

function GdpBars({ gdp }: { gdp: RecessionData["gdp"] }) {
  const bars = [...gdp.quarters.map((point) => ({ ...point, nowcast: false })), ...(gdp.nowcast ? [{ ...gdp.nowcast, nowcast: true }] : [])];
  const high = Math.max(1, ...bars.map((bar) => bar.value)), low = Math.min(0, ...bars.map((bar) => bar.value));
  const span = high - low;
  const zero = (high / span) * 100;
  return <div className="gdp-bars">
    <div className="gdp-plot" style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}>
      <i className="gdp-zero" style={{ top: `${zero}%` }} />
      {bars.map((bar) => <a href={bar.nowcast ? gdp.nowcastUrl : gdp.sourceUrl} target="_blank" rel="noreferrer" className={`gdp-bar ${bar.value < 0 ? "negative" : ""} ${bar.nowcast ? "nowcast" : ""}`} key={bar.period} title={`${fmtPeriod(bar.period, "quarter")}${bar.nowcast ? " GDPNow" : ""}: ${bar.value.toFixed(1)}%`}>
        <span style={bar.value >= 0 ? { top: `${zero - (bar.value / span) * 100}%`, height: `${(bar.value / span) * 100}%` } : { top: `${zero}%`, height: `${(-bar.value / span) * 100}%` }}>
          <b className={bar.value >= 0 ? "above" : "below"}>{bar.value.toFixed(1)}</b>
        </span>
      </a>)}
    </div>
    <div className="gdp-axis" style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}>
      {bars.map((bar) => <span key={bar.period}>{bar.nowcast ? "GDPNow" : fmtPeriod(bar.period, "quarter").replace(" 20", " ’")}</span>)}
    </div>
    <p>Hatched: Atlanta Fed GDPNow for the current quarter.</p>
  </div>;
}

/** Three to five round ticks spanning the values. */
function niceTicks(min: number, max: number) {
  const raw = Math.max(1e-9, max - min) / 3;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw)!;
  const ticks: number[] = [];
  for (let value = Math.floor(min / step) * step; value <= Math.ceil(max / step) * step + step / 2; value += step) ticks.push(Number(value.toFixed(6)));
  return ticks;
}

/** Tick labels share the decimals their step needs, so 5 and 10 read alike. */
function fmtTick(value: number, step: number) {
  const decimals = Math.max(0, Math.min(2, Math.ceil(-Math.log10(step) - 1e-9) + (step / 10 ** Math.floor(Math.log10(step)) === 2.5 ? 1 : 0)));
  return value === 0 ? "0" : `${value < 0 ? "−" : ""}${Math.abs(value).toFixed(decimals)}`;
}

type Domain = { start: number; end: number; years: number[] };

function IndicatorCard({ indicator, recessions, domain }: { indicator: Indicator; recessions: RecessionData["recessions"]; domain: Domain }) {
  const width = 320, height = 100;
  const history = indicator.history;
  const values = history.map((point) => point.value).concat(indicator.threshold ? [indicator.threshold.value] : [], indicator.include);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const min = ticks[0], max = ticks.at(-1)!;
  const xShare = (timestamp: number) => (timestamp - domain.start) / Math.max(1, domain.end - domain.start);
  const x = (period: string) => xShare(Date.parse(period)) * width;
  const yShare = (value: number) => 1 - (value - min) / Math.max(1e-9, max - min);
  const status = indicator.signal == null ? null : indicator.signal ? "Signaling" : "Not signaling";
  const change = indicator.yearAgo ? indicator.latest.value - indicator.yearAgo.value : null;
  const cadence = indicator.history.length > 200 ? "day" : "month";
  const unit = indicator.unit === "pp" ? "pp" : indicator.unit;
  return <a className={`panel indicator-card ${indicator.signal ? "signal" : ""}`} href={indicator.sourceUrl} target="_blank" rel="noreferrer">
    <header>
      <div><h3>{indicator.label}</h3><small>{indicator.detail}</small></div>
      {status && <span className="indicator-status">{status}</span>}
    </header>
    <div className="indicator-value">
      <strong>{fmtIndicator(indicator, indicator.latest.value)}</strong>
      <small>{fmtPeriod(indicator.latest.period, cadence)}{change != null ? ` · ${change >= 0 ? "+" : "−"}${fmtIndicator(indicator, Math.abs(change))} vs. a year ago` : ""}</small>
    </div>
    <div className="indicator-plot">
      <span className="indicator-unit">{unit}</span>
      {ticks.map((tick) => <span className="indicator-y" style={{ top: `${yShare(tick) * 100}%` }} key={tick}>{fmtTick(tick, ticks[1] - ticks[0])}</span>)}
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${indicator.label} history`}>
        {ticks.map((tick) => <line className="indicator-grid-line" x1={0} x2={width} y1={yShare(tick) * height} y2={yShare(tick) * height} key={tick} />)}
        {domain.years.map((year) => <line className="indicator-year-line" x1={xShare(year) * width} x2={xShare(year) * width} y1={0} y2={height} key={year} />)}
        {recessions.filter((span) => Date.parse(span.end) >= domain.start).map((span) => {
          const left = Math.max(0, x(span.start));
          return <rect className="recession-shade" key={span.start} x={left} y={0} width={Math.max(2, x(span.end) - left)} height={height} />;
        })}
        {indicator.threshold && <line className="indicator-threshold" x1={0} x2={width} y1={yShare(indicator.threshold.value) * height} y2={yShare(indicator.threshold.value) * height} />}
        <polyline points={history.map((point) => `${x(point.period).toFixed(1)},${(yShare(point.value) * height).toFixed(1)}`).join(" ")} />
      </svg>
      {indicator.threshold && <span className="indicator-threshold-label" style={{ top: `${yShare(indicator.threshold.value) * 100}%` }}>{indicator.threshold.label}</span>}
      <div className="indicator-x">{domain.years.map((year) => <span style={{ left: `${xShare(year) * 100}%` }} key={year}>{new Date(year).getUTCFullYear()}</span>)}</div>
    </div>
  </a>;
}
