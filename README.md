# SOLARA

Distributed GPU‑compute mesh — landing + live console with **real** AI image
generation. White/orange, liquid‑glass UI, Inter typography, an interactive
WebGL globe, a deterministic network simulation, and a render backend that
proxies to OpenRouter (Google **Gemini 2.5 Flash Image**).

The network metrics (jobs, providers, settlements, globe traffic) are a
deterministic **simulation**. The render console produces a **real** image when
the backend is configured with an API key; otherwise it falls back to a
simulated preview. Nothing is charged to the visitor — the project pays the
provider, protected by spend caps. The `$SOLR` token / contract is a preview
placeholder, not a live token.

## Run locally

Requires **Node ≥ 18**.

```bash
npm install
cp .env.example .env        # then paste your OpenRouter key into .env
npm start                   # http://localhost:3000
```

Without a key it still runs — the render console just shows simulated previews.

Get a key: https://openrouter.ai/keys  (the model is `google/gemini-2.5-flash-image`).

## How real generation works

- The browser calls `POST /api/render { prompt }`.
- The **server** adds your `OPENROUTER_API_KEY` and calls OpenRouter. The key is
  never exposed to the client.
- Returns a base64 `data:image/...` URL that the console draws into the output.
- `GET /api/render/status` tells the frontend whether to use the live path.

### Spend protection (important)
Each image costs roughly **$0.04**. With an open page, cap it:

| env | default | meaning |
|---|---|---|
| `RENDER_DAILY_CAP` | `400` | max images/day across everyone (~$16/day) |
| `RENDER_IP_DAILY_CAP` | `25` | max images/day per visitor IP |
| `RENDER_LOCKED` | `false` | set `true` to force the paid path off |
| `SOLR_MINT` | – | optional: gate rendering on a real Solana mint |

> Caps are in‑memory (per process). For multi‑instance hosting, move them to
> Redis/Upstash. The original CANAS used the same in‑memory approach.

## Configure your token — LIVE price + market cap (Helius)

Real **price / market cap / supply** come from **Helius**, server-side, so the
Helius key never touches the browser. The frontend just calls `GET /api/token`.
(Token-locking has been removed — there's no Streamflow / staking setup.)

### When your token launches — do exactly this:

**1) Set the mint on the server** (Railway → Variables, or Vercel → Env):
```bash
HELIUS_API_KEY=...          # https://dashboard.helius.dev
TOKEN_MINT=<your SPL mint>   # Helius returns price / market cap / supply
# CIRCULATING_SUPPLY=182400000   # optional; else uses on-chain supply
```
Then **redeploy** (Railway: it redeploys on save; Vercel: trigger a redeploy).

**2) Put the mint in the site** (`public/index.html`, the `const TOKEN = {` block)
so the copy-address button and chart link work:
```js
contract: '<your SPL mint>',   // shows the address + enables Dexscreener fallback
dexUrl:   '',                  // optional — auto-fills from Dexscreener once contract is set
```

- **Price + market cap**: server calls Helius DAS `getAsset` for `TOKEN_MINT`
  (`price_info.price_per_token` × circulating supply). If Helius has no price yet
  (brand-new token), it falls back to Dexscreener automatically.
- **Circulating supply** tile uses `CONFIG.circulatingSupply` (in `TOKEN`).
- Results are cached 25s server-side; the page refreshes every 30s.

### Frontend config (`public/index.html`, `const TOKEN = {`)
Used for the **View chart** button + the preview numbers shown before launch:
```js
contract: '',     // your mint (also enables a client-side Dexscreener fallback)
dexUrl: '',       // your Dexscreener pair link for the "View chart" button
                  // (auto-filled from Dexscreener if left empty and contract set)
previewPrice: 0.0413,
circulatingSupply: 182_400_000,
allocation: [ ['Network rewards',50],['Community & ecosystem',25],['Treasury',15],['Liquidity',10] ],
```

> Solscan and Jupiter links were removed — only the single DEX link remains, and
> there's no "preview" badge on the panel. The token mint is public, so it's
> fine in the frontend; only the **Helius key** must stay in server env.

## Deploy

Any Node host works. Examples:

**Render.com / Railway / Fly.io**
- New Web Service from this repo.
- Build: `npm install` · Start: `npm start`
- Add env var `OPENROUTER_API_KEY` (and any caps). Done.

**A VPS**
```bash
npm install
OPENROUTER_API_KEY=sk-or-... PORT=3000 node server.js
# put nginx/caddy in front for TLS, or use `pm2 start server.js`
```

**Vercel** (alternative): serve `public/` statically and move the two routes
into `api/render.js` / `api/render/status.js` as serverless functions (same
logic as `server.js`). Express also works on Vercel via a single catch‑all
function if you prefer.

## Structure
```
server.js            Express: static hosting + /api/render proxy + spend caps
public/index.html    the full SOLARA frontend (self‑contained, one file)
package.json         start script + express dep
.env.example         all config knobs
```

## Honesty / safety notes
- Network stats are simulated and labeled as a preview build.
- Real rendering is rate‑limited and locked behind a flag/mint by default.
- If you launch a token or claim a live network, make sure the public copy
  matches what's actually running — synthetic metrics presented as a real
  on‑chain network can mislead buyers.

MIT.
