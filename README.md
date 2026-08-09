# MOSI

**Monitoring The Situation** is a compact market-intelligence dashboard for questions where the consensus changes faster than the official record.

The first two screens cover:

- **The Fed** — forward policy-rate expectations across CME, Polymarket, Kalshi, and Pascal, plus a broad inflation dashboard sourced through FRED.
- **AI Models** — market-implied release windows and uncertainty bands for upcoming frontier models.

## Data sources

MOSI reads public market metadata from the Polymarket Gamma API, Kalshi Trade API, and Pascal Read API. Inflation series come from the public FRED CSV service. The CME panel currently links to the official FedWatch surface and is structured for a licensed FedWatch API feed.

Public API failures are isolated: the product continues to render and labels reference data when a venue cannot be reached. Market prices are informational forecasts, not investment advice.

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

## Deployment

The production target is Cloudflare Pages at `mosi-bkchou.pages.dev`, with `mosi.bkchou.com` as the custom hostname.
