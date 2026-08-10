# MOSI

**Monitoring The Situation: Market-Implied Forecasts** is a compact market-intelligence dashboard for questions where the consensus changes faster than the official record.

The first two screens cover:

- **The Fed** — a compact consensus distribution from normalized Polymarket and Kalshi meeting outcomes, plus official EFFR and inflation observations.
- **AI Models** — exact market-implied median dates and central 50%/80% release intervals fitted from multiple dated contracts on one shared calendar. Venue probabilities are combined before quantiles are calculated, and unsupported tails remain explicitly open-ended.

## Data sources

MOSI normalizes narrowly matched contracts from the Polymarket Gamma API, Kalshi Trade API, and Pascal Read API in a Cloudflare Pages Function. Pascal identifies its displayed contracts as Polymarket mirrors, so MOSI labels them accordingly instead of treating them as independent consensus.

EFFR comes directly from the Federal Reserve Bank of New York. Published inflation observations come from FRED using official BLS, BEA, Cleveland Fed, and Dallas Fed series; available next-period estimates are labeled as Cleveland Fed nowcasts. CME FedWatch is shown as unavailable until a licensed API credential is configured.

There are no numerical fallback forecasts. If a source or exact active contract is unavailable, MOSI shows an unavailable state rather than synthesizing a value. Market prices are informational forecasts, not investment advice.

The Fed and AI screens use separate cached endpoints. Each upstream provider has its own refresh window and last-good response; the header reports `LIVE`, `PARTIAL`, or `STALE` when current sources differ. Normal page loads reuse the edge cache, while the header refresh control explicitly asks providers for a fresh snapshot.

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
