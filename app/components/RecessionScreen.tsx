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
  return <section className="dashboard-grid recession-grid">
    <article className="panel recession-odds-panel">
      <PanelHeading kicker="RECESSION ODDS" title="Prediction markets" aside={generatedAt ? "Kalshi · Polymarket" : ""} />
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
      {data && <dl className="recession-definitions">
        {Object.entries(data.definitions).map(([venue, definition]) => <div key={venue}><dt>{venue}</dt><dd>{definition}</dd></div>)}
      </dl>}
    </article>

    <article className="panel gdp-panel">
      <PanelHeading kicker="GDP" title="Real GDP growth" aside="Annualized q/q · BEA" />
      {data?.gdp.quarters.length ? <GdpBars gdp={data.gdp} /> : <EmptyState title={loading ? "Loading GDP…" : "GDP unavailable"} compact />}
    </article>

    <div className="indicator-grid">
      {data?.indicators.map((indicator) => <IndicatorCard indicator={indicator} recessions={data.recessions} key={indicator.key} />)}
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

function IndicatorCard({ indicator, recessions }: { indicator: Indicator; recessions: RecessionData["recessions"] }) {
  const width = 320, height = 92, pad = 4;
  const history = indicator.history;
  const start = Date.parse(history[0].period), end = Date.parse(history.at(-1)!.period);
  const values = history.map((point) => point.value).concat(indicator.threshold ? [indicator.threshold.value] : [], indicator.include);
  const min = Math.min(...values), max = Math.max(...values);
  const x = (period: string) => pad + ((Date.parse(period) - start) / Math.max(1, end - start)) * (width - pad * 2);
  const y = (value: number) => height - pad - ((value - min) / Math.max(1e-9, max - min)) * (height - pad * 2);
  const status = indicator.signal == null ? null : indicator.signal ? "Signaling" : "Not signaling";
  const change = indicator.yearAgo ? indicator.latest.value - indicator.yearAgo.value : null;
  const cadence = indicator.history.length > 200 ? "day" : "month";
  return <a className={`panel indicator-card ${indicator.signal ? "signal" : ""}`} href={indicator.sourceUrl} target="_blank" rel="noreferrer">
    <header>
      <div><h3>{indicator.label}</h3><small>{indicator.detail}</small></div>
      {status && <span className="indicator-status">{status}</span>}
    </header>
    <div className="indicator-value">
      <strong>{fmtIndicator(indicator, indicator.latest.value)}</strong>
      <small>{fmtPeriod(indicator.latest.period, cadence)}{change != null ? ` · ${change >= 0 ? "+" : "−"}${fmtIndicator(indicator, Math.abs(change))} vs. a year ago` : ""}</small>
    </div>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${indicator.label} history`}>
      {recessions.filter((span) => span.end >= history[0].period).map((span) => <rect className="recession-shade" key={span.start} x={x(span.start < history[0].period ? history[0].period : span.start)} y={0} width={Math.max(2, x(span.end) - x(span.start < history[0].period ? history[0].period : span.start))} height={height} />)}
      {indicator.threshold && <line className="indicator-threshold" x1={0} x2={width} y1={y(indicator.threshold.value)} y2={y(indicator.threshold.value)} />}
      <polyline points={history.map((point) => `${x(point.period).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ")} />
    </svg>
    <footer><span>{history[0].period.slice(0, 4)}</span>{indicator.threshold && <span>{indicator.threshold.label}</span>}<span>{indicator.latest.period.slice(0, 4)}</span></footer>
  </a>;
}
