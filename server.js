/**
 * FinPulse — сервер для Railway (Node.js 22, без зависимостей).
 *
 * 1. Раздаёт сайт: index.html, css/, js/ (gzip, ETag, заголовки безопасности).
 * 2. GET /healthz — проверка работоспособности для Railway.
 * 3. GET /api/fundamentals и /api/dividends — данные T-Invest API (Т-Инвестиции):
 *    мультипликаторы и дивиденды по всем акциям Мосбиржи. Токен берётся только
 *    из переменной окружения T_INVEST_TOKEN и никогда не уходит в браузер.
 *    Ответы кэшируются на 6 часов, обновление идёт в фоне.
 *
 * Без токена сайт работает как раньше: /api/* отвечают 503, и браузер
 * остаётся на открытых данных MOEX.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 8080;
const TOKEN = (process.env.T_INVEST_TOKEN || '').trim();
const ROOT = __dirname;
const REFRESH_MS = 6 * 3600e3;

/* =====================================================================
   T-Invest API (REST-шлюз)
   ===================================================================== */
// Основной адрес REST-шлюза и запасной (старый домен). T_INVEST_API_URL — для тестового сервера.
const API_HOSTS = process.env.T_INVEST_API_URL
  ? [process.env.T_INVEST_API_URL.replace(/\/?$/, '/')]
  : ['https://invest-public-api.tbank.ru/rest/', 'https://invest-public-api.tinkoff.ru/rest/'];
const SERVICE = 'tinkoff.public.invest.api.contract.v1.InstrumentsService/';
let apiHost = API_HOSTS[0];

async function tinvest(method, body, attempt = 0) {
  let res;
  try {
    res = await fetch(apiHost + SERVICE + method, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    // Сетевая ошибка — пробуем запасной адрес шлюза
    const next = API_HOSTS[(API_HOSTS.indexOf(apiHost) + 1) % API_HOSTS.length];
    if (attempt < API_HOSTS.length - 1) { apiHost = next; return tinvest(method, body, attempt + 1); }
    throw e;
  }
  if (res.status === 429 && attempt < 5) {           // лимит запросов — ждём и повторяем
    const wait = Number(res.headers.get('x-ratelimit-reset')) || 5;
    await sleep(wait * 1000);
    return tinvest(method, body, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`T-Invest ${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Quotation / MoneyValue {units, nano} → число. */
const q = (v) => (v && (v.units != null || v.nano != null) ? Number(v.units || 0) + Number(v.nano || 0) / 1e9 : null);
const day = (ts) => (ts ? String(ts).slice(0, 10) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Акции основного режима Мосбиржи (TQBR), доступные через API. */
async function loadShares() {
  const j = await tinvest('Shares', { instrumentStatus: 'INSTRUMENT_STATUS_BASE' });
  return (j.instruments || []).filter((s) => s.classCode === 'TQBR' && s.ticker && s.assetUid);
}

/**
 * Поля «в процентах или долях» в описании API не уточнены. Определяем по набору:
 * если медиана по модулю меньше 1.5, значения — доли, переводим в проценты.
 */
function toPercent(items, key) {
  const vals = items.map((x) => Math.abs(x[key])).filter((v) => v > 0).sort((a, b) => a - b);
  if (!vals.length) return;
  const median = vals[Math.floor(vals.length / 2)];
  if (median < 1.5) items.forEach((x) => { if (x[key] != null) x[key] *= 100; });
}

const cache = {
  shares: null,
  fundamentals: { items: null, updatedAt: null, error: null, loading: false },
  dividends: { items: null, updatedAt: null, error: null, loading: false },
};

async function refreshFundamentals() {
  const c = cache.fundamentals;
  if (c.loading) return;
  c.loading = true;
  try {
    cache.shares = await loadShares();
    const byAsset = new Map(cache.shares.map((s) => [s.assetUid, s]));
    const assets = [...byAsset.keys()];
    const rows = [];
    for (let i = 0; i < assets.length; i += 100) {
      const j = await tinvest('GetAssetFundamentals', { assets: assets.slice(i, i + 100) });
      (j.fundamentals || []).forEach((f) => {
        const s = byAsset.get(f.assetUid);
        if (!s) return;
        rows.push({
          ticker: s.ticker,
          pe: num(f.peRatioTtm), pb: num(f.priceToBookTtm), ps: num(f.priceToSalesTtm),
          evEbitda: num(f.evToEbitdaMrq), ndEbitda: num(f.netDebtToEbitda),
          roe: num(f.roe), margin: num(f.netMarginMrq), divYield: num(f.dividendYieldDailyTtm),
          payout: num(f.dividendPayoutRatioFy), epsTtm: num(f.epsTtm), marketCap: num(f.marketCapitalization),
          currency: f.currency || null,
        });
      });
    }
    // Нулевые значения у API обычно означают «нет данных»
    rows.forEach((r) => ['pe', 'pb', 'ps', 'evEbitda', 'ndEbitda', 'roe', 'margin', 'epsTtm', 'marketCap'].forEach((k) => { if (r[k] === 0) r[k] = null; }));
    ['roe', 'margin', 'divYield', 'payout'].forEach((k) => toPercent(rows, k));
    c.items = Object.fromEntries(rows.map(({ ticker, ...r }) => [ticker, r]));
    c.updatedAt = new Date().toISOString();
    c.error = null;
    console.log(`[t-invest] fundamentals: ${rows.length} бумаг`);
  } catch (e) {
    c.error = String(e.message || e);
    console.error('[t-invest] fundamentals error:', c.error);
  } finally { c.loading = false; }
}

async function refreshDividends() {
  const c = cache.dividends;
  if (c.loading) return;
  c.loading = true;
  try {
    const shares = cache.shares || (cache.shares = await loadShares());
    const from = new Date(Date.now() - 400 * 864e5).toISOString();
    const to = new Date(Date.now() + 365 * 864e5).toISOString();
    const items = [];
    const queue = [...shares];
    // Три запроса параллельно с паузой — с запасом укладываемся в лимиты API
    const worker = async () => {
      while (queue.length) {
        const s = queue.shift();
        try {
          const j = await tinvest('GetDividends', { instrumentId: s.uid || s.figi, from, to });
          (j.dividends || []).forEach((d) => {
            if (/cancel/i.test(d.dividendType || '')) return;
            const amount = q(d.dividendNet);
            if (!amount || !d.recordDate) return;
            items.push({
              ticker: s.ticker, amount, currency: (d.dividendNet.currency || 'rub').toUpperCase(),
              exDate: day(d.recordDate), lastBuyDate: day(d.lastBuyDate), declaredDate: day(d.declaredDate),
              paymentDate: day(d.paymentDate), regularity: d.regularity || '',
            });
          });
        } catch (e) { console.warn('[t-invest] dividends', s.ticker, String(e.message || e).slice(0, 120)); }
        await sleep(250);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    items.sort((a, b) => a.exDate.localeCompare(b.exDate));
    c.items = items;
    c.updatedAt = new Date().toISOString();
    c.error = null;
    console.log(`[t-invest] dividends: ${items.length} событий по ${shares.length} бумагам`);
  } catch (e) {
    c.error = String(e.message || e);
    console.error('[t-invest] dividends error:', c.error);
  } finally { c.loading = false; }
}

async function refreshAll() {
  await refreshFundamentals();
  await refreshDividends();
}

/* =====================================================================
   HTTP
   ===================================================================== */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};

/** Наружу отдаются только файлы сайта — не server.js, Dockerfile и т.п. */
function sitePath(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const full = path.normalize(path.join(ROOT, p));
  const rel = path.relative(ROOT, full).split(path.sep).join('/');
  if (rel.startsWith('..') || !(rel === 'index.html' || rel.startsWith('css/') || rel.startsWith('js/'))) return null;
  return full;
}

function send(req, res, status, body, type, extra = {}) {
  const headers = { ...SECURITY_HEADERS, 'Content-Type': type, ...extra };
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && buf.length > 1024 && /text|json|javascript|svg/.test(type);
  const out = gzipOk ? zlib.gzipSync(buf) : buf;
  if (gzipOk) { headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding'; }
  headers['Content-Length'] = out.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : out);
}
const json = (req, res, status, obj) => send(req, res, status, JSON.stringify(obj), MIME['.json'], { 'Cache-Control': 'no-cache' });

function apiPayload(c, extra = {}) {
  return { source: 'T-Invest API', updatedAt: c.updatedAt, loading: c.loading, ...extra };
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8');

  if (url === '/healthz') return send(req, res, 200, 'ok', 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });

  if (url.startsWith('/api/')) {
    const route = url.split('?')[0];
    if (route === '/api/status') {
      return json(req, res, 200, {
        tInvest: Boolean(TOKEN),
        fundamentals: { count: cache.fundamentals.items ? Object.keys(cache.fundamentals.items).length : 0, updatedAt: cache.fundamentals.updatedAt, error: cache.fundamentals.error },
        dividends: { count: cache.dividends.items ? cache.dividends.items.length : 0, updatedAt: cache.dividends.updatedAt, loading: cache.dividends.loading, error: cache.dividends.error },
      });
    }
    if (!TOKEN) return json(req, res, 503, { error: 'no_token', message: 'T_INVEST_TOKEN не задан' });
    const c = route === '/api/fundamentals' ? cache.fundamentals : route === '/api/dividends' ? cache.dividends : null;
    if (!c) return json(req, res, 404, { error: 'not_found' });
    if (!c.items) return json(req, res, 503, { error: c.loading || !c.error ? 'loading' : 'upstream', message: c.error || 'Данные загружаются' });
    return json(req, res, 200, apiPayload(c, { items: c.items }));
  }

  const file = sitePath(url);
  if (!file) return send(req, res, 404, 'Not Found', 'text/plain; charset=utf-8');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(req, res, 404, 'Not Found', 'text/plain; charset=utf-8');
    const etag = '"' + crypto.createHash('sha1').update(`${st.size}-${st.mtimeMs}`).digest('hex').slice(0, 16) + '"';
    // В именах файлов нет хешей версии — браузер сверяет файл по ETag при каждом открытии
    const headers = { 'Cache-Control': 'no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ...SECURITY_HEADERS, ...headers }); return res.end(); }
    fs.readFile(file, (e, data) => {
      if (e) return send(req, res, 500, 'Error', 'text/plain; charset=utf-8');
      send(req, res, 200, data, MIME[path.extname(file)] || 'application/octet-stream', headers);
    });
  });
});

server.listen(PORT, () => {
  console.log(`FinPulse: http://0.0.0.0:${PORT} · T-Invest API: ${TOKEN ? 'токен задан' : 'нет токена (T_INVEST_TOKEN)'}`);
  if (TOKEN) {
    refreshAll();
    setInterval(refreshAll, REFRESH_MS).unref();
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
