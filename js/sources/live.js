/**
 * FinPulse — живой источник данных (LiveSource).
 *
 * Все запросы идут прямо из браузера к открытым API без ключей
 * (у всех включён CORS):
 *   • MOEX ISS (iss.moex.com) — акции TQBR, свечи, индексы IMOEX/RTSI,
 *     юань CNYRUB_TOM, фьючерсы (Brent, золото, S&P 500, NASDAQ),
 *     облигации TQOB/TQCB, дивиденды, новости биржи.
 *     Бесплатные данные ISS приходят с задержкой ~15 минут.
 *   • ЦБ РФ (cbr-xml-daily.ru) — официальные курсы USD и EUR
 *     (биржевые торги долларом и евро на MOEX остановлены в 2024 г.).
 *   • CoinGecko — Bitcoin, Ethereum.
 *   • RSS РБК через rss2json — финансовые новости.
 *
 * Публичный интерфейс совпадает с DemoSource, поэтому UI не знает,
 * откуда пришли данные.
 */
window.FP = window.FP || {};

FP.LiveSource = (() => {
  'use strict';
  const U = FP.U, M = FP.MOCK;

  const ISS = 'https://iss.moex.com/iss/';
  const POLL_MS = 20000;               // котировки акций, индексов, юаня
  const SLOW_EVERY = 3;                // фьючерсы и крипта — каждый 3-й опрос
  const META = new Map(M.stocks.map((s) => [s.ticker, s]));   // сектор, имя, EPS, бета — справочно
  const TICKERS = M.stocks.map((s) => s.ticker);
  const INDEX_ORDER = ['IMOEX', 'RTSI', 'USD/RUB', 'EUR/RUB', 'CNY/RUB', 'BRENT', 'GOLD', 'SPYF', 'NASD', 'BTC/USD', 'ETH/USD'];
  const RATINGS = [[/сбер/i, 'AAA'], [/газпр/i, 'AAA'], [/ржд/i, 'AAA'], [/роснефт|роснфт/i, 'AAA'], [/лукойл/i, 'AAA'], [/вэб/i, 'AAA']];

  /* ---------------- HTTP ---------------- */
  async function getJSON(url, timeout = 15000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  }
  const iss = (path, params = {}) => getJSON(`${ISS}${path}.json?${new URLSearchParams({ 'iss.meta': 'off', ...params })}`);
  /** Блок ISS {columns, data} → массив объектов. */
  const table = (block) => (block && block.columns ? block.data.map((r) => Object.fromEntries(block.columns.map((c, i) => [c, r[i]]))) : []);
  const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(+v) ? null : +v);
  /** Первое ненулевое число (0 в ISS обычно значит «сделок не было»). */
  const first = (...vals) => { for (const v of vals) { const n = num(v); if (n !== null && n !== 0) return n; } return null; };

  /* ---------------- Время ---------------- */
  /** «2026-10-16 10:00:00» (МСК) → UTC-метка с теми же цифрами: ось графика показывает время МСК. */
  const tsLabel = (s) => {
    const [d, t = '00:00:00'] = String(s).split(' ');
    const [y, m, dd] = d.split('-').map(Number), [hh, mm] = t.split(':').map(Number);
    return Date.UTC(y, m - 1, dd, hh, mm) / 1000;
  };
  /** То же время МСК → настоящий unix ms (для «N мин назад»). */
  const mskToMs = (s) => tsLabel(s) * 1000 - 3 * 3600e3;
  const dayKey = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
  const todayMsk = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const daysAgo = (n) => U.daysFromToday(-n);

  /* ---------------- Состояние ---------------- */
  const stocks = M.stocks.map((s) => ({ ...s, price: null, changePct: 0, change: 0, prevClose: null, volume: 0, divYield: 0 }));
  const byTicker = new Map(stocks.map((s) => [s.ticker, s]));
  const hist = new Map(TICKERS.map((t) => [t, { daily: [], last: {} }]));
  const SHARES = 'engines/stock/markets/shares/boards/TQBR';
  const FOREIGN = 'engines/stock/markets/foreignshares/boards/FQBR';
  /** История бумаги (создаётся по требованию — для бумаг из скринера). */
  const histOf = (t) => { if (!hist.has(t)) hist.set(t, { daily: [], last: {} }); return hist.get(t); };
  /** Режим торгов бумаги: основные акции TQBR или иностранные FQBR. */
  const baseOf = (t) => (byTicker.get(t) && byTicker.get(t).base) || SHARES;
  let indices = [];
  let dividends = [];
  let stocksLoad = null;   // промис первичной загрузки свечей и дивидендов
  const status = { mode: 'live', label: 'MOEX ISS · задержка ~15 мин', updatedAt: null };

  /* ---------------- Акции ---------------- */
  async function fetchQuotes() {
    const j = await iss('engines/stock/markets/shares/boards/TQBR/securities', { securities: TICKERS.join(','), 'iss.only': 'securities,marketdata' });
    const sec = new Map(table(j.securities).map((r) => [r.SECID, r]));
    return table(j.marketdata).filter((md) => sec.has(md.SECID)).map((md) => ({ md, sec: sec.get(md.SECID) }));
  }

  function applyQuote(s, { md, sec }) {
    const prev = first(sec.PREVLEGALCLOSEPRICE, sec.PREVPRICE, sec.PREVWAPRICE);
    const last = first(md.LAST);
    const price = first(last, md.LCURRENTPRICE, md.MARKETPRICE, md.LCLOSEPRICE, prev);
    if (price == null) return false;
    const issPct = num(md.LASTTOPREVPRICE);
    if (last && issPct != null) { s.changePct = issPct; s.prevClose = price / (1 + issPct / 100); }
    else { s.prevClose = prev ?? price; s.changePct = (price / s.prevClose - 1) * 100; }
    const changed = s.price !== price;
    s.price = price;
    s.change = price - s.prevClose;
    s.open = first(md.OPEN, s.prevClose);
    s.dayHigh = first(md.HIGH, price);
    s.dayLow = first(md.LOW, price);
    s.volume = num(md.VOLTODAY) ?? 0;
    s.marketCap = first(md.ISSUECAPITALIZATION, num(sec.ISSUESIZE) * price);
    s.lot = num(sec.LOTSIZE) ?? s.lot;
    s.isin = sec.ISIN || s.isin;
    s.pe = s.eps > 0 ? price / s.eps : null;
    return changed;
  }

  /** Свечи ISS с постраничной догрузкой (по 500 строк). */
  async function candles(secid, interval, from, base = 'engines/stock/markets/shares/boards/TQBR') {
    const out = [];
    for (let start = 0; start < 5000;) {
      const j = await iss(`${base}/securities/${secid}/candles`, { interval, from, start });
      const rows = table(j.candles);
      out.push(...rows);
      if (rows.length < 500) break;
      start += rows.length;
    }
    return out.map((r) => ({ time: tsLabel(r.begin), open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume }));
  }

  const divLoaded = new Set();   // по каким бумагам дивиденды уже загружены

  /** Дивидендная доходность за 12 месяцев по выплатам в рублях. */
  function applyDivYield(s, list) {
    if (!s) return;
    const yearAgo = U.daysFromToday(-365), today = U.isoDate(new Date());
    const paid = list.filter((d) => d.currency === 'RUB' && d.exDate > yearAgo && d.exDate <= today);
    s.divYield = s.price ? paid.reduce((a, d) => a + d.amount, 0) / s.price * 100 : 0;
  }

  /** Дивиденды → формат календаря (статус: объявлено / выплачено). */
  const toCalendar = (list) => list
    .filter((d) => d.exDate >= daysAgo(400))
    .map((d) => ({ id: `${d.ticker}-${d.exDate}-${d.amount}`, ...d, period: '', status: U.daysUntil(d.exDate) >= 0 ? 'declared' : 'paid' }));

  async function fetchDividends(t) {
    const j = await iss(`securities/${t}/dividends`);
    return table(j.dividends).map((r) => ({ ticker: t, amount: +r.value, currency: r.currencyid, exDate: String(r.registryclosedate).slice(0, 10) }));
  }

  /** Обновить последний бар, если он относится к текущей торговой сессии. */
  function touch(bar, price) {
    if (!bar || dayKey(bar.time) !== todayMsk()) return;
    bar.close = price; bar.high = Math.max(bar.high, price); bar.low = Math.min(bar.low, price);
  }

  /* ---------------- Индексы, валюты, сырьё, крипта ---------------- */
  const item = (symbol, name, value, changePct, kind) => ({ symbol, name, value, changePct: changePct ?? 0, kind });

  async function moexIndices() {
    const j = await iss('engines/stock/markets/index/securities', { securities: 'IMOEX,RTSI', 'iss.only': 'marketdata' });
    return table(j.marketdata).map((r) => {
      const v = first(r.CURRENTVALUE, r.LASTVALUE);
      if (v == null) return null;
      const prev = first(r.LASTVALUE);
      const pct = num(r.LASTCHANGEPRC) ?? (prev && prev !== v ? (v / prev - 1) * 100 : 0);
      return item(r.SECID, r.SECID === 'IMOEX' ? 'Индекс МосБиржи' : 'Индекс РТС', v, pct, 'index');
    }).filter(Boolean);
  }

  async function cny() {
    const j = await iss('engines/currency/markets/selt/boards/CETS/securities', { securities: 'CNYRUB_TOM', 'iss.only': 'securities,marketdata' });
    const md = table(j.marketdata)[0] || {}, sec = table(j.securities)[0] || {};
    const prev = first(sec.PREVPRICE, sec.PREVWAPRICE);
    const v = first(md.LAST, md.MARKETPRICE, md.WAPRICE, prev);
    return v == null ? [] : [item('CNY/RUB', 'Юань, MOEX', v, prev ? (v / prev - 1) * 100 : 0, 'fx')];
  }

  async function cbr() {
    const j = await getJSON('https://www.cbr-xml-daily.ru/daily_json.js');
    return ['USD', 'EUR'].map((c) => {
      const v = j.Valute[c];
      return item(`${c}/RUB`, `${c === 'USD' ? 'Доллар' : 'Евро'}, курс ЦБ`, v.Value, (v.Value / v.Previous - 1) * 100, 'fx');
    });
  }

  const FUTURES = [
    { asset: 'BR', symbol: 'BRENT', name: 'Нефть Brent, фьючерс MOEX', kind: 'commodity' },
    { asset: 'GOLD', symbol: 'GOLD', name: 'Золото, фьючерс MOEX', kind: 'commodity' },
    { asset: 'SPYF', symbol: 'SPYF', name: 'S&P 500 (фьючерс на SPY), MOEX', kind: 'index' },
    { asset: 'NASD', symbol: 'NASD', name: 'NASDAQ 100 (фьючерс на QQQ), MOEX', kind: 'index' },
  ];
  async function futures() {
    const j = await iss('engines/futures/markets/forts/securities', { 'iss.only': 'securities,marketdata' });
    const md = new Map(table(j.marketdata).map((r) => [r.SECID, r]));
    const today = U.isoDate(new Date());
    const secs = table(j.securities);
    return FUTURES.map((f) => {
      // самый ликвидный (по открытому интересу) неистёкший контракт
      const c = secs.filter((s) => s.ASSETCODE === f.asset && String(s.LASTDELDATE) >= today)
        .sort((a, b) => (num(md.get(b.SECID)?.OPENPOSITION) || 0) - (num(md.get(a.SECID)?.OPENPOSITION) || 0)
          || String(a.LASTDELDATE).localeCompare(String(b.LASTDELDATE)))[0];
      if (!c) return null;
      const m = md.get(c.SECID) || {};
      const prev = first(c.PREVSETTLEPRICE, c.PREVPRICE);
      const v = first(m.LAST, m.SETTLEPRICE, prev);
      if (v == null) return null;
      return item(f.symbol, `${f.name} (${c.SECID})`, v, num(m.LASTCHANGEPRCNT) ?? (prev ? (v / prev - 1) * 100 : 0), f.kind);
    }).filter(Boolean);
  }

  async function crypto() {
    const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true');
    return [['bitcoin', 'BTC/USD', 'Bitcoin'], ['ethereum', 'ETH/USD', 'Ethereum']]
      .filter(([id]) => j[id]).map(([id, sym, name]) => item(sym, name, j[id].usd, j[id].usd_24h_change, 'crypto'));
  }

  /** Собрать бегущую строку; упавшие источники просто пропускаются. */
  async function loadIndices(parts) {
    const results = await Promise.allSettled(parts.map((fn) => fn()));
    const fresh = new Map(indices.map((i) => [i.symbol, i]));
    results.forEach((r) => { if (r.status === 'fulfilled') r.value.forEach((i) => fresh.set(i.symbol, i)); else console.warn('[FinPulse]', r.reason); });
    return INDEX_ORDER.map((s) => fresh.get(s)).filter(Boolean);
  }

  /* ---------------- Новости ---------------- */
  const NEWS_RULES = {
    macro: /ЦБ|Банк[аеу]? России|ключев|ставк|инфляц|ВВП|бюджет|Минфин|рубл|курс|нефт|Brent|ФРС|экономик/i,
    bonds: /облигац|ОФЗ|купон|размещени|доходност|кредитн\w* рейтинг|дефолт/i,
    stocks: /акци|дивиденд|капитализац|IPO|SPO|биржа|индекс Мосбиржи|котировк|прибыл|выручк|отчетност|отчётност/i,
  };
  const POS = /рост|вырос|выросл|повыси|увелич|рекорд|подорожа|укрепи|одобри|снижени\w* ставк|смягч/i;
  const NEG = /паден|упал|упали|снизил|сократ|убыт|санкци|дефолт|ослаб|подешев|обвал|отказ|штраф|понизил/i;
  const NAME_TICKERS = [
    [/Сбер/i, 'SBER'], [/Т-Техн|Т-Банк|Тинькофф/i, 'T'], [/Мосбирж|Московск\w* бирж/i, 'MOEX'], [/Газпром(?!\s*нефт)/i, 'GAZP'],
    [/Лукойл|ЛУКОЙЛ/i, 'LKOH'], [/Роснефт/i, 'ROSN'], [/Новатэк|НОВАТЭК/i, 'NVTK'], [/Яндекс/i, 'YDEX'], [/Хэдхантер|HeadHunter|hh\.ru/i, 'HEAD'],
    [/Positive|Позитив/i, 'POSI'], [/Магнит/i, 'MGNT'], [/X5|Х5|ИКС 5/i, 'X5'], [/Озон|Ozon/i, 'OZON'],
  ];
  const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

  function classify(n) {
    const text = `${n.title} ${n.summary}`;
    const tags = Object.keys(NEWS_RULES).filter((k) => NEWS_RULES[k].test(text));
    const tickers = NAME_TICKERS.filter(([re]) => re.test(text)).map(([, t]) => t);
    if (tickers.length && !tags.includes('stocks')) tags.push('stocks');
    const rateCut = /(понизил|снизил|снижени)\w*\s+(\S+\s+)?ставк/i.test(n.title);
    const p = POS.test(n.title) || rateCut, ng = NEG.test(n.title) && !rateCut;
    return { ...n, tags, tickers, impact: p && !ng ? 'positive' : ng && !p ? 'negative' : 'neutral', autoImpact: true };
  }

  async function fetchNews() {
    const out = [];
    const jobs = [
      iss('sitenews', { lang: 'ru' }).then((j) => table(j.sitenews).slice(0, 15).forEach((r) => out.push({
        id: 'moex' + r.id, title: stripHtml(r.title), summary: '', source: 'Московская Биржа',
        publishedAt: mskToMs(r.published_at), link: `https://www.moex.com/n${r.id}`,
      }))),
      getJSON('https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent('https://rssexport.rbc.ru/rbcnews/news/30/full.rss'))
        .then((j) => (j.items || []).forEach((it) => out.push({
          id: 'rbc' + it.guid, title: stripHtml(it.title), summary: stripHtml(it.description).slice(0, 320), source: 'РБК',
          publishedAt: Date.parse(String(it.pubDate).replace(' ', 'T') + 'Z'), link: it.link,
        }))),
    ];
    (await Promise.allSettled(jobs)).forEach((r) => { if (r.status === 'rejected') console.warn('[FinPulse] news:', r.reason); });
    return out.map(classify)
      .filter((n) => n.source !== 'РБК' || n.tags.length)   // из общей ленты РБК — только про рынки и экономику
      .map((n) => (n.tags.length ? n : { ...n, tags: ['stocks'] }))
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, 30);
  }

  /* ---------------- Облигации ---------------- */
  async function bondBoard(board) {
    const j = await iss(`engines/stock/markets/bonds/boards/${board}/securities`, {
      'iss.only': 'securities,marketdata',
      'securities.columns': 'SECID,SHORTNAME,SECNAME,ISIN,FACEVALUE,FACEUNIT,COUPONPERCENT,COUPONPERIOD,COUPONVALUE,NEXTCOUPON,MATDATE,PREVPRICE,PREVWAPRICE,YIELDATPREVWAPRICE',
      'marketdata.columns': 'SECID,LAST,YIELD,DURATION,VALTODAY',
    });
    const md = new Map(table(j.marketdata).map((r) => [r.SECID, r]));
    const today = U.isoDate(new Date());
    return table(j.securities).map((s) => {
      const m = md.get(s.SECID) || {};
      const ytm = first(m.YIELD, s.YIELDATPREVWAPRICE);
      const price = first(m.LAST, s.PREVPRICE, s.PREVWAPRICE);
      if (!ytm || !price || !s.MATDATE || s.MATDATE <= today || s.MATDATE.startsWith('0000')) return null;
      return { s, m, ytm, price };
    }).filter(Boolean);
  }

  function toBond({ s, m, ytm, price }, type) {
    const name = s.SHORTNAME;
    const rating = type === 'ofz' ? 'AAA' : (RATINGS.find(([re]) => re.test(`${name} ${s.SECNAME}`)) || [])[1] || 'н/д';
    const durDays = num(m.DURATION);
    return {
      isin: s.ISIN || s.SECID, secid: s.SECID, name, issuer: s.SECNAME || name, type, price, ytm,
      coupon: num(s.COUPONPERCENT) ?? 0, couponPeriod: num(s.COUPONPERIOD) ?? 0, maturity: s.MATDATE,
      duration: durDays ? durDays / 365.25 : null, rating, nominal: num(s.FACEVALUE) ?? 1000,
      ratingScore: { AAA: 10, 'AA+': 9 }[rating] ?? 0,
      yearsToMaturity: Math.max(0, U.daysUntil(s.MATDATE) / 365.25),
      couponValue: num(s.COUPONVALUE) ?? 0, nextCoupon: s.NEXTCOUPON && !String(s.NEXTCOUPON).startsWith('0000') ? s.NEXTCOUPON : s.MATDATE,
      turnover: num(m.VALTODAY) ?? 0,
      currency: !s.FACEUNIT || s.FACEUNIT === 'SUR' ? 'RUB' : s.FACEUNIT,
      country: String(s.ISIN || '').slice(0, 2) || 'RU',
      kind: type !== 'ofz' ? 'corp' : /^ОФЗ\s?29/.test(name) ? 'float' : /^ОФЗ\s?52/.test(name) ? 'linker' : 'fixed',
    };
  }

  /* ---------------- Первичная загрузка акций ---------------- */
  async function loadStocks() {
    // Дневные свечи за ~13 мес. (спарклайны, 52-нед. диапазон, 1M/1Y) и дивиденды (доходность) по всем бумагам
    const from = daysAgo(400);
    const [, divs] = await Promise.all([
      Promise.allSettled(TICKERS.map(async (t) => { hist.get(t).daily = await candles(t, 24, from); })),
      Promise.allSettled(TICKERS.map(fetchDividends)),
    ]);
    dividends = divs.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
    TICKERS.forEach((t) => divLoaded.add(t));
    for (const s of stocks) {
      applyDivYield(s, dividends.filter((d) => d.ticker === s.ticker));
      const d = hist.get(s.ticker).daily;
      s.avgVolume = d.length ? d.slice(-20).reduce((a, b) => a + b.volume, 0) / Math.min(20, d.length) : s.volume;
    }
    return stocks.filter((s) => s.price);
  }

  /* ---------------- Универсум для скринера ---------------- */
  /** Отрасль по составу отраслевых индексов MOEX. */
  const SECTOR_INDICES = {
    MOEXOG: 'Энергетика', MOEXFN: 'Финансы', MOEXIT: 'IT', MOEXCN: 'Ритейл', MOEXMM: 'Металлы и добыча',
    MOEXEU: 'Электроэнергетика', MOEXTL: 'Телеком', MOEXCH: 'Химия', MOEXTN: 'Транспорт', MOEXRE: 'Девелопмент',
  };
  async function sectorMap() {
    const m = new Map();
    await Promise.allSettled(Object.entries(SECTOR_INDICES).map(async ([idx, name]) => {
      const j = await iss(`statistics/engines/stock/markets/index/analytics/${idx}`, { limit: 100 });
      table(j.analytics).forEach((r) => { const t = r.ticker || r.secids; if (t && !m.has(t)) m.set(t, name); });
    }));
    return m;
  }

  /** Цены закрытия всех бумаг режима на дату ~N дней назад (ближайший торговый день). */
  async function closesAgo(base, days) {
    for (let k = 0; k < 7; k++) {
      const date = daysAgo(days + k), out = new Map();
      for (let start = 0; start < 3000;) {
        const j = await iss(`history/${base}/securities`, { date, start, 'history.columns': 'SECID,CLOSE,LEGALCLOSEPRICE' });
        const rows = table(j.history);
        rows.forEach((r) => { const c = first(r.LEGALCLOSEPRICE, r.CLOSE); if (c) out.set(r.SECID, c); });
        if (rows.length < 100) break;
        start += rows.length;
      }
      if (out.size) return out;
    }
    return new Map();
  }

  async function boardQuotes(base) {
    const j = await iss(`${base}/securities`, { 'iss.only': 'securities,marketdata' });
    const md = new Map(table(j.marketdata).map((r) => [r.SECID, r]));
    return table(j.securities).filter((s) => md.has(s.SECID)).map((sec) => ({ sec, md: md.get(sec.SECID) }));
  }

  let universeLoad = null;
  async function loadUniverse() {
    await (stocksLoad ||= loadStocks());
    const [main, foreign, sectors] = await Promise.allSettled([boardQuotes(SHARES), boardQuotes(FOREIGN), sectorMap()]);
    const secMap = sectors.status === 'fulfilled' ? sectors.value : new Map();
    const list = [];
    const add = (rows, base) => rows.forEach((q) => {
      const t = q.sec.SECID;
      let s = byTicker.get(t);
      if (!s) {
        s = { ticker: t, name: q.sec.SHORTNAME || t, isin: q.sec.ISIN, sector: null, eps: null, beta: null, lot: 1, base, extra: true, divYield: null };
        if (!applyQuote(s, q)) return;
        byTicker.set(t, s);
      }
      s.country = String(s.isin || q.sec.ISIN || '').slice(0, 2) || 'RU';
      s.currency = !q.sec.CURRENCYID || q.sec.CURRENCYID === 'SUR' ? 'RUB' : q.sec.CURRENCYID;
      s.sector = s.sector || secMap.get(t) || (base === FOREIGN ? 'Иностранные' : 'Прочее');
      list.push(s);
    });
    if (main.status === 'fulfilled') add(main.value, SHARES); else console.warn('[FinPulse] TQBR:', main.reason);
    if (foreign.status === 'fulfilled') add(foreign.value, FOREIGN); else console.warn('[FinPulse] FQBR:', foreign.reason);
    if (!list.length) list.push(...stocks.filter((s) => s.price));

    // Доходность за 1 / 3 / 12 месяцев: ядро — по своим свечам, остальные — по истории торгов
    const periods = [['r1m', 30], ['r3m', 91], ['r1y', 365]];
    const results = await Promise.allSettled(periods.map(([, d]) => closesAgo(SHARES, d)));
    periods.forEach(([key], i) => {
      const map = results[i].status === 'fulfilled' ? results[i].value : new Map();
      list.forEach((s) => { const c = map.get(s.ticker); s[key] = c ? (s.price / c - 1) * 100 : null; });
    });
    return list;
  }

  /* ---------------- Опрос («реалтайм») ---------------- */
  const listeners = new Set();
  let timer = null, pollN = 0;

  async function poll() {
    pollN++;
    const changed = [];
    try {
      for (const q of await fetchQuotes()) {
        const s = byTicker.get(q.md.SECID);
        const before = s.price;
        if (applyQuote(s, q)) {
          changed.push({ ticker: s.ticker, dir: Math.sign(s.price - before) });
          const h = hist.get(s.ticker);
          touch(h.daily[h.daily.length - 1], s.price);
          Object.values(h.last).forEach((r) => touch(r.bars[r.bars.length - 1], s.price));
        }
      }
      status.updatedAt = Date.now();
    } catch (e) { console.warn('[FinPulse] quotes:', e); }

    const before = new Map(indices.map((i) => [i.symbol, i.value]));
    indices = await loadIndices(pollN % SLOW_EVERY === 0 ? [moexIndices, cny, futures, crypto] : [moexIndices, cny]);
    const changedIdx = indices.filter((i) => before.get(i.symbol) !== i.value)
      .map((i) => ({ symbol: i.symbol, dir: Math.sign(i.value - (before.get(i.symbol) ?? i.value)) }));
    listeners.forEach((fn) => fn({ stocks: changed, indices: changedIdx, rebuildTape: changedIdx.some((c) => !before.has(c.symbol)) }));
  }

  /* ---------------- Публичный интерфейс ---------------- */
  return {
    INTERVALS: ['1D', '1W', '1M', '1Y', 'ALL'],

    /** Проверка доступности + первичная загрузка котировок. Бросает, если MOEX недоступна. */
    async init() {
      const quotes = await fetchQuotes();
      quotes.forEach((q) => applyQuote(byTicker.get(q.md.SECID), q));
      if (!stocks.some((s) => s.price)) throw new Error('MOEX ISS вернула пустые котировки');
      status.updatedAt = Date.now();
    },
    status: () => ({ ...status }),

    async getIndices() {
      indices = await loadIndices([moexIndices, cbr, cny, futures, crypto]);
      return indices;
    },

    getStocks() {
      return (stocksLoad ||= loadStocks());
    },

    /** Все акции TQBR (+ иностранные FQBR) для скринера: котировки, страна, отрасль, доходности. */
    getUniverse() {
      return (universeLoad ||= loadUniverse());
    },

    async getBonds() {
      const [ofz, corp] = await Promise.all([bondBoard('TQOB'), bondBoard('TQCB')]);
      // ОФЗ всех видов: 26xxx — постоянный купон, 29xxx — флоатеры, 52xxx — линкеры
      const ofzList = ofz.filter((b) => /^ОФЗ/.test(b.s.SHORTNAME) && b.ytm < 60).map((b) => toBond(b, 'ofz'));
      // Все корпоративные выпуски с адекватной доходностью — для скринера
      const corpList = corp.filter((b) => b.ytm > 0 && b.ytm < 60).map((b) => toBond(b, 'corp'));
      return [...ofzList, ...corpList];
    },

    async getDividends() {
      await (stocksLoad ||= loadStocks());
      return toCalendar(dividends);
    },

    /**
     * Догрузить дивиденды по дополнительным бумагам (до 6 запросов параллельно).
     * Возвращает только новые события; заодно считает дивидендную доходность для скринера.
     */
    async getMoreDividends(tickers) {
      const queue = tickers.filter((t) => !divLoaded.has(t));
      const found = [];
      const worker = async () => {
        while (queue.length) {
          const t = queue.shift();
          try {
            const list = await fetchDividends(t);
            divLoaded.add(t);
            applyDivYield(byTicker.get(t), list);
            found.push(...list);
          } catch (e) { console.warn('[FinPulse] dividends', t, e); }
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      dividends.push(...found);
      return toCalendar(found);
    },

    getNews: fetchNews,

    /** Официальные курсы ЦБ РФ ко всем валютам (за 1 единицу, в рублях). */
    async getRates() {
      const j = await getJSON('https://www.cbr-xml-daily.ru/daily_json.js');
      const out = { RUB: { rate: 1, name: 'Российский рубль' }, _source: 'Банк России', _date: U.date(String(j.Date).slice(0, 10)) };
      Object.values(j.Valute).forEach((c) => { out[c.CharCode] = { rate: c.Value / c.Nominal, name: c.Name }; });
      return out;
    },

    quote: (t) => byTicker.get(t),

    async getHistory(t, interval = '1Y') {
      const h = histOf(t), base = baseOf(t);
      let res;
      if (interval === '1D') {
        const rows = await candles(t, 10, daysAgo(7), base);
        const lastDay = rows.length ? dayKey(rows[rows.length - 1].time) : null;
        res = { bars: rows.filter((r) => dayKey(r.time) === lastDay), intraday: true, label: 'день' };
      } else if (interval === '1W') {
        res = { bars: await candles(t, 60, daysAgo(7), base), intraday: true, label: 'неделю' };
      } else if (interval === 'ALL') {
        res = { bars: await candles(t, 7, daysAgo(5 * 365), base), intraday: false, label: '5 лет' };
      } else {
        if (!h.daily.length) h.daily = await candles(t, 24, daysAgo(400), base);
        res = { bars: h.daily.slice(interval === '1M' ? -22 : -252), intraday: false, label: interval === '1M' ? 'месяц' : 'год' };
      }
      if (!res.bars.length) res = { bars: h.daily.slice(-22), intraday: false, label: 'месяц' };
      h.last[interval] = res;
      return res;
    },
    peekHistory: (t, interval) => histOf(t).last[interval] || { bars: [] },

    yearRange(t) {
      const bars = histOf(t).daily.slice(-252);
      const s = byTicker.get(t);
      if (!bars.length) return { low: s.dayLow ?? s.price, high: s.dayHigh ?? s.price };
      return { low: Math.min(...bars.map((b) => b.low)), high: Math.max(...bars.map((b) => b.high)) };
    },
    sparkline: (t, n = 30) => histOf(t).daily.slice(-n).map((b) => b.close),

    /** Дневные свечи индекса (IMOEX, RTSI) примерно за 13 месяцев. */
    getIndexHistory: (symbol) => candles(symbol, 24, daysAgo(400), 'engines/stock/markets/index'),

    subscribe(fn) {
      listeners.add(fn);
      if (!timer) timer = setInterval(poll, POLL_MS);
      return () => { listeners.delete(fn); if (!listeners.size) { clearInterval(timer); timer = null; } };
    },
  };
})();
