# MOSI

**Monitoring The Situation: Market-Implied Forecasts** is a compact market-intelligence dashboard for questions where the consensus changes faster than the official record.

The screens cover:

- **The Fed** — FOMC decision odds, then one forward graph comparing a target-rate path derived from normalized Polymarket and Kalshi meeting outcomes with the Atlanta Fed's options-implied SOFR path. Below it, the next data prints: for each upcoming CPI, core CPI, core PCE, payrolls, unemployment and GDP release, the distribution of reported values implied by Kalshi's "above X" ladder, with the market median, the last print (FRED), and the Cleveland Fed nowcast or Atlanta Fed GDPNow when one covers the same period. Observed inflation, official EFFR, and expandable Treasury context follow.
- **Recession** — Kalshi and Polymarket recession contracts by year (definitions differ, so venues are not averaged), real GDP growth with GDPNow, and five years of the Sahm rule, 10y–3m curve, jobless claims, high-yield spread, Chauvet–Piger probability and unemployment from FRED.
- **AI Models** — exact market-implied median dates and central 50%/80% release intervals fitted from multiple dated contracts on one shared calendar. Venue probabilities are combined before quantiles are calculated, and unsupported tails remain explicitly open-ended.

## Data sources

MOSI normalizes narrowly matched contracts from the Polymarket Gamma API, Kalshi Trade API, and Pascal Read API in a Cloudflare Pages Function. Pascal identifies its displayed contracts as Polymarket mirrors, so MOSI labels them accordingly instead of treating them as independent consensus.

Kalshi requests use the server-side `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY` secrets when configured. Use a read-only key and store its private key as PKCS#8 PEM. These values belong in Cloudflare Pages secrets, never in client code or source control. Without both secrets, public requests remain available, but Kalshi may rate-limit the hosting provider. AI discovery retains the model and version named in each Kalshi contract; contracts with different version thresholds stay separate.

The forward meeting path converts each normalized decision distribution into its expected basis-point move and accumulates those moves from the current target-range midpoint. The open-ended 50+ bp buckets are conservatively represented at 50 bp; exact outcome probabilities and source contracts remain available in the meeting drawer.

EFFR comes directly from the Federal Reserve Bank of New York. Published inflation observations come from FRED using official BLS, BEA, Cleveland Fed, and Dallas Fed series; available next-period estimates are labeled as Cleveland Fed nowcasts. The forward three-month SOFR path is the Atlanta Fed Market Probability Tracker's daily published output, which is estimated from CME SOFR options. Treasury par yields come from FRED's republication of the Treasury daily yield curve, because Treasury's own XML feed takes 15–20 seconds per request. MOSI does not scrape or claim direct access to CME FedWatch.

Print distributions use each strike's bid/ask midpoint, fitted with pool-adjacent-violators so the probability of exceeding a strike never rises with the strike; each bucket's probability is the difference between adjacent strikes. Releases are timed at the half hour after Kalshi's 8:25/8:29 AM ET close.

There are no numerical fallback forecasts. If a source or exact active contract is unavailable, MOSI shows an unavailable state rather than synthesizing a value. Market prices are informational forecasts, not investment advice.

Each screen has its own cached endpoint (`/api/fed`, `/api/recession`, `/api/ai`). Each upstream provider has its own refresh window and last-good response; the header reports `LIVE`, `PARTIAL`, or `STALE` when current sources differ. Normal page loads reuse the edge cache, while the header refresh control explicitly asks providers for a fresh snapshot.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Validation:

```bash
npm test
npm run lint
```

`npm run build:pages` produces the static Pages bundle in `pages-dist/`.

## Deployment

The production target is Cloudflare Pages at `mosi-bkchou.pages.dev`, with `mosi.bkchou.com` as the custom hostname. The Pages build command is `npm run build:pages` and the output directory is `pages-dist`.

```bash
npm run build:pages
npm run deploy:pages
```
