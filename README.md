# MOSI

**Monitoring The Situation: Market-Implied Forecasts** is a compact market-intelligence dashboard for questions where the consensus changes faster than the official record.

The first two screens cover:

- **The Fed** — exact meeting-outcome quotes from Polymarket, Kalshi, and Pascal, plus official EFFR and inflation observations.
- **AI Models** — cumulative release-by probabilities for upcoming frontier models on one shared calendar.

## Data sources

MOSI normalizes narrowly matched contracts from the Polymarket Gamma API, Kalshi Trade API, and Pascal Read API in a Cloudflare Pages Function. Pascal identifies its displayed contracts as Polymarket mirrors, so MOSI labels them accordingly instead of treating them as independent consensus.

EFFR comes directly from the Federal Reserve Bank of New York. Published inflation observations come from FRED using official BLS, BEA, Cleveland Fed, and Dallas Fed series; available next-period estimates are labeled as Cleveland Fed nowcasts. CME FedWatch is shown as unavailable until a licensed API credential is configured.

There are no numerical fallback forecasts. If a source or exact active contract is unavailable, MOSI shows an unavailable state rather than synthesizing a value. Market prices are informational forecasts, not investment advice.

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
