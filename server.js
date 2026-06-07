/**
 * SOLARA — server
 * Serves the static frontend and proxies real image generation to OpenRouter.
 * The provider API key lives ONLY here, never in the browser.
 *
 *   GET  /api/render/status  -> { enabled, locked, provider }
 *   POST /api/render         -> { image (data-url), model, costUsd }
 *
 * Requires Node >= 18 (global fetch). Run:  npm install && npm start
 */
'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');

// tiny .env loader (no dependency) — host env vars still take precedence
(() => {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      const k = m[1]; let v = m[2].trim().replace(/^["']|["']$/g, '');
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (_) {}
})();

const app = express();
app.set('trust proxy', 1);
// Force HTTPS in production (Railway/Vercel terminate TLS and set x-forwarded-proto)
app.use((req, res, next) => {
  const xfproto = req.headers['x-forwarded-proto'];
  if (process.env.NODE_ENV === 'production' && xfproto && xfproto !== 'https') {
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
  next();
});
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// ---- OpenRouter image model (Google Gemini 2.5 Flash Image, "nano banana") ----
const MODEL = process.env.RENDER_MODEL || 'google/gemini-2.5-flash-image';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// ---- spend protection (in-memory; per-process) ----
const GLOBAL_CAP = Number(process.env.RENDER_DAILY_CAP ?? 400); // ~$0.04/img => ~$16/day
const IP_CAP = Number(process.env.RENDER_IP_DAILY_CAP ?? 25);
let day = '';
let globalCount = 0;
const perIp = new Map();
function rollDay() {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) { day = d; globalCount = 0; perIp.clear(); }
}

const enabled = () => !!process.env.OPENROUTER_API_KEY;

// Unlocked by default once a key is present. Force-lock with RENDER_LOCKED=true,
// or gate on a real Solana mint via SOLR_MINT (mirrors the original design).
function locked() {
  if (String(process.env.RENDER_LOCKED ?? '').toLowerCase() === 'true') return true;
  const m = (process.env.SOLR_MINT ?? '').trim();
  if (m) return m === '11111111111111111111111111111111';
  return false;
}

app.get('/api/render/status', (_req, res) => {
  res.json({ enabled: enabled(), locked: locked(), provider: 'openrouter:' + MODEL });
});

app.post('/api/render', async (req, res) => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(503).json({ error: 'image generation not configured' });
  if (locked()) return res.status(423).json({ error: 'rendering is locked until launch' });

  const ip = (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.ip || 'anon';
  const prompt = String(req.body && req.body.prompt || '').trim().slice(0, 800);
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  rollDay();
  if (globalCount >= GLOBAL_CAP) return res.status(429).json({ error: 'daily render budget reached — try tomorrow' });
  const used = perIp.get(ip) || 0;
  if (used >= IP_CAP) return res.status(429).json({ error: 'render limit reached for now, try later' });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.PUBLIC_URL || 'http://localhost:3000',
        'X-Title': 'SOLARA',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        modalities: ['image', 'text'],
      }),
    });
    clearTimeout(timer);
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.warn('[openrouter]', r.status, t.slice(0, 200));
      return res.status(502).json({ error: 'image provider error' });
    }
    const data = await r.json();
    const url = data && data.choices && data.choices[0] && data.choices[0].message
      && data.choices[0].message.images && data.choices[0].message.images[0]
      && data.choices[0].message.images[0].image_url
      && data.choices[0].message.images[0].image_url.url;
    if (!url || !String(url).startsWith('data:image')) {
      return res.status(502).json({ error: 'no image returned' });
    }
    globalCount += 1;
    perIp.set(ip, used + 1);
    res.json({ image: url, model: 'Gemini 2.5 Flash Image', costUsd: (data.usage && data.usage.cost) || 0 });
  } catch (e) {
    clearTimeout(timer);
    return res.status(502).json({ error: 'image provider unreachable' });
  }
});

// ── Helius (token price / supply / Streamflow locked) ──────────────────────
// Key stays server-side. Frontend calls GET /api/token (no key in the browser).
const heliusUrl = () =>
  process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : null;

async function heliusRpc(method, params) {
  const url = heliusUrl();
  if (!url) throw new Error('HELIUS_API_KEY not set');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params }),
  });
  if (!r.ok) throw new Error('helius ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'helius error');
  return j.result;
}

let tokenCache = { t: 0, data: null };

app.get('/api/token', async (req, res) => {
  const mint = (process.env.TOKEN_MINT || req.query.mint || '').trim();
  if (!heliusUrl() || !mint) return res.json({ configured: false });
  if (tokenCache.data && Date.now() - tokenCache.t < 25000) return res.json(tokenCache.data);

  try {
    // price + supply via Helius DAS
    const asset = await heliusRpc('getAsset', { id: mint, options: { showFungible: true } });
    const ti = (asset && asset.token_info) || {};
    const decimals = Number(ti.decimals ?? 0);
    const supply = Number(ti.supply || 0) / Math.pow(10, decimals);
    let price = ti.price_info && ti.price_info.price_per_token;

    // fallback price (Dexscreener) if Helius has none yet (very new tokens)
    if (!price) {
      try {
        const d = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mint)).json();
        const p = ((d && d.pairs) || []).sort((a, b) => (((b.liquidity || {}).usd) || 0) - (((a.liquidity || {}).usd) || 0))[0];
        if (p) price = parseFloat(p.priceUsd) || 0;
      } catch (_) {}
    }

    const circulating = Number(process.env.CIRCULATING_SUPPLY || 0) || supply;
    const marketCap = price ? price * circulating : 0;

    const data = {
      configured: true,
      price: price || 0,
      marketCap,
      supply,
      circulating,
    };
    tokenCache = { t: Date.now(), data };
    res.json(data);
  } catch (e) {
    res.json({ configured: false, error: String(e.message || e) });
  }
});

// SPA-ish fallback to the landing page
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`SOLARA  →  http://localhost:${PORT}`);
    console.log(`render: ${enabled() ? (locked() ? 'configured but LOCKED' : 'LIVE') : 'simulated only (no OPENROUTER_API_KEY)'}`);
  });
}

module.exports = app; // for Vercel (@vercel/node) and tests
