/**
 * FinPulse — демо-источник данных (DemoSource).
 *
 * Используется, когда живые источники недоступны. Отдаёт моки
 * с искусственной задержкой (чтобы были видны скелетоны) и симулирует
 * тики котировок. Чтобы подключить реальный источник, достаточно
 * переписать методы get*() — сигнатуры и форма данных уже готовы:
 *
 *   async getStocks() {
 *     const r = await fetch('https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities.json?iss.meta=off');
 *     const { marketdata, securities } = await r.json();
 *     return mapMoexStocks(securities, marketdata);   // -> [{ ticker, name, price, changePct, ... }]
 *   }
 *
 * а тики — заменить на WebSocket/polling и вызывать subscribe-колбэки.
 */
window.FP = window.FP || {};

FP.DemoSource = (() => {
  'use strict';
  const U = FP.U;
  const M = FP.MOCK;

  const CONFIG = {
    latency: [250, 750],   // имитация сетевой задержки, мс
    tickMs: 2500,          // период «рыночных» тиков
    historyDays: 1260,     // ~5 лет торговых дней
    intradayBars: 105,     // 5-минутные свечи 10:00–18:45
  };

  const wait = () => new Promise((r) => setTimeout(r, CONFIG.latency[0] + Math.random() * (CONFIG.latency[1] - CONFIG.latency[0])));

  /* ---------------- Нормализация «ответа сервера» ---------------- */
  const stocks = M.stocks.map((s) => {
    const prevClose = s.price / (1 + s.changePct / 100);
    return { ...s, prevClose, change: s.price - prevClose, open: prevClose, dayHigh: s.price, dayLow: s.price, avgVolume: s.volume };
  });
  const byTicker = new Map(stocks.map((s) => [s.ticker, s]));

  const indices = M.indices.map((i) => ({ ...i, prev: i.value / (1 + i.changePct / 100) }));

  const RATING_SCORE = { AAA: 10, 'AA+': 9, AA: 8, 'AA-': 7, 'A+': 6, A: 5, 'A-': 4, 'BBB+': 3, BBB: 2, 'BBB-': 1 };
  const bonds = M.bonds.map((b) => ({
    ...b,
    ratingScore: RATING_SCORE[b.rating] ?? 0,
    yearsToMaturity: Math.max(0, U.daysUntil(b.maturity) / 365.25),
    couponValue: b.nominal * b.coupon / 100 * b.couponPeriod / 365,   // ₽ за один купон
    nextCoupon: nextCouponDate(b.maturity, b.couponPeriod),
  }));

  /** Ближайший купон: шагаем от даты погашения назад с шагом купонного периода. */
  function nextCouponDate(maturity, period) {
    const d = U.parseISO(maturity), t = U.today();
    while (true) {
      const prev = new Date(d); prev.setDate(prev.getDate() - period);
      if (prev <= t) return U.isoDate(d);
      d.setTime(prev.getTime());
    }
  }

  /* ---------------- Генерация истории цен ---------------- */
  // Время в барах — UTC-метка календарной даты/часа, поэтому ось
  // Lightweight Charts (UTC) показывает «биржевое» время МСК без сдвигов.
  const utc = (d, h = 0, m = 0) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), h, m) / 1000;

  /** Последние n торговых дней (пн–пт), по возрастанию. */
  function businessDays(n) {
    const out = [], d = U.today();
    while (out.length < n) {
      if (d.getDay() !== 0 && d.getDay() !== 6) out.push(new Date(d));
      d.setDate(d.getDate() - 1);
    }
    return out.reverse();
  }

  /** Броуновский мост из open в close за n баров. */
  function bridge(rng, open, close, n, stepVol, t0, dt, volPerBar) {
    const w = [0];
    for (let i = 1; i <= n; i++) w.push(w[i - 1] + U.gauss(rng) * stepVol);
    const a = Math.log(open), b = Math.log(close);
    const p = (i) => Math.exp(a + w[i] + (b - a - w[n]) * i / n);
    const bars = [];
    for (let i = 0; i < n; i++) {
      const o = p(i), c = p(i + 1);
      bars.push({
        time: t0 + i * dt, open: o, close: c,
        high: Math.max(o, c) * (1 + Math.abs(U.gauss(rng)) * stepVol * 0.5),
        low: Math.min(o, c) * (1 - Math.abs(U.gauss(rng)) * stepVol * 0.5),
        volume: Math.round(volPerBar * Math.exp(U.gauss(rng) * 0.45)),
      });
    }
    return bars;
  }

  /** Склейка мелких баров в крупные (напр. 5м → 1ч, день → неделя). */
  function aggregate(bars, keyFn) {
    const out = [];
    for (const b of bars) {
      const k = keyFn(b.time), last = out[out.length - 1];
      if (last && last._k === k) {
        last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low);
        last.close = b.close; last.volume += b.volume;
      } else out.push({ _k: k, time: k, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    }
    return out;
  }

  const cache = new Map();

  function buildHistory(s) {
    const rng = U.rng(U.hash(s.ticker));
    const N = CONFIG.historyDays, sigma = s.volatility;
    const mu = (rng() - 0.42) * 0.0011;           // у каждой бумаги свой тренд
    const days = businessDays(N);

    // Дневные цены закрытия генерируем назад от текущей цены
    const closes = new Array(N);
    closes[N - 1] = s.price; closes[N - 2] = s.prevClose;
    for (let i = N - 3; i >= 0; i--) closes[i] = closes[i + 1] / Math.exp(mu + sigma * U.gauss(rng));

    const daily = days.map((d, i) => {
      const c = closes[i];
      const o = i === 0 ? c : closes[i - 1] * (1 + U.gauss(rng) * sigma * 0.15);
      const ret = i === 0 ? 0 : Math.abs(Math.log(c / closes[i - 1]));
      return {
        time: utc(d), open: o, close: c,
        high: Math.max(o, c) * (1 + Math.abs(U.gauss(rng)) * sigma * 0.45),
        low: Math.min(o, c) * (1 - Math.abs(U.gauss(rng)) * sigma * 0.45),
        volume: Math.round(s.avgVolume * Math.exp(U.gauss(rng) * 0.3) * (1 + ret / sigma * 0.25)),
      };
    });

    // Сегодня: 5-минутки от цены открытия к текущей цене
    const today = daily[N - 1], lastDay = days[N - 1];
    const intraday = bridge(rng, today.open, s.price, CONFIG.intradayBars, sigma / Math.sqrt(CONFIG.intradayBars) * 1.3,
      utc(lastDay, 10, 0), 300, s.volume / CONFIG.intradayBars);
    Object.assign(today, {
      high: Math.max(...intraday.map((b) => b.high)), low: Math.min(...intraday.map((b) => b.low)),
      volume: intraday.reduce((a, b) => a + b.volume, 0),
    });
    s.open = today.open; s.dayHigh = today.high; s.dayLow = today.low; s.volume = today.volume;

    // Неделя: часовые бары (4 прошлых дня — мост open→close, сегодня — агрегат 5-минуток)
    let hourly = [];
    for (let k = N - 5; k < N - 1; k++) {
      const db = daily[k];
      const bars = bridge(rng, db.open, db.close, 9, sigma / 3 * 1.2, utc(days[k], 10, 0), 3600, db.volume / 9);
      db.high = Math.max(db.high, ...bars.map((b) => b.high)); db.low = Math.min(db.low, ...bars.map((b) => b.low));
      hourly = hourly.concat(bars);
    }
    hourly = hourly.concat(aggregate(intraday, (t) => t - (t % 3600)));

    // Недельные бары для ALL (ключ — понедельник недели)
    const weekly = aggregate(daily, (t) => { const dow = (new Date(t * 1000).getUTCDay() + 6) % 7; return t - dow * 86400; });

    return { daily, intraday, hourly, weekly };
  }

  const history = (ticker) => {
    if (!cache.has(ticker)) cache.set(ticker, buildHistory(byTicker.get(ticker)));
    return cache.get(ticker);
  };
  // История нужна сразу (спарклайны, 52-нед. диапазон), а сама генерация дешёвая
  stocks.forEach((s) => history(s.ticker));

  /** Наборы баров для интервалов графика. */
  const INTERVALS = {
    '1D': (h) => ({ bars: h.intraday, intraday: true, label: 'день' }),
    '1W': (h) => ({ bars: h.hourly, intraday: true, label: 'неделю' }),
    '1M': (h) => ({ bars: h.daily.slice(-22), intraday: false, label: 'месяц' }),
    '1Y': (h) => ({ bars: h.daily.slice(-252), intraday: false, label: 'год' }),
    'ALL': (h) => ({ bars: h.weekly, intraday: false, label: '5 лет' }),
  };

  /* ---------------- Симуляция тиков ---------------- */
  const listeners = new Set();

  function touch(bar, price, vol = 0) {
    if (!bar) return;
    bar.close = price; bar.high = Math.max(bar.high, price); bar.low = Math.min(bar.low, price); bar.volume += vol;
  }

  function tick() {
    const changed = [];
    for (const s of stocks) {
      if (Math.random() > 0.55) continue;
      const before = s.price;
      s.price = Math.max(0.01, s.price * (1 + U.gauss() * s.volatility * 0.05));
      s.change = s.price - s.prevClose;
      s.changePct = s.change / s.prevClose * 100;
      const vol = Math.round(s.avgVolume * 0.0005 * Math.random());
      s.volume += vol;
      s.dayHigh = Math.max(s.dayHigh, s.price); s.dayLow = Math.min(s.dayLow, s.price);
      const h = history(s.ticker);
      touch(h.intraday.at(-1), s.price, vol); touch(h.hourly.at(-1), s.price, vol);
      touch(h.daily.at(-1), s.price, vol); touch(h.weekly.at(-1), s.price, vol);
      changed.push({ ticker: s.ticker, dir: Math.sign(s.price - before) });
    }
    const changedIdx = [];
    for (const i of indices) {
      if (Math.random() > 0.6) continue;
      const before = i.value;
      const vol = i.kind === 'crypto' ? 0.0012 : i.kind === 'fx' ? 0.0003 : 0.0005;
      i.value *= 1 + U.gauss() * vol;
      i.changePct = (i.value / i.prev - 1) * 100;
      changedIdx.push({ symbol: i.symbol, dir: Math.sign(i.value - before) });
    }
    listeners.forEach((fn) => fn({ stocks: changed, indices: changedIdx }));
  }
  let timer = null;

  /* ---------------- Публичный интерфейс ---------------- */
  return {
    CONFIG,
    INTERVALS: Object.keys(INTERVALS),
    async init() {},
    status: () => ({ mode: 'demo', label: 'Демо-данные', updatedAt: null }),

    async getIndices() { await wait(); return indices; },
    async getStocks() { await wait(); return stocks; },
    async getBonds() { await wait(); return bonds; },
    async getDividends() { await wait(); return M.dividends.map((d, i) => ({ id: 'd' + i, ...d })); },
    async getNews() { await wait(); return [...M.news].sort((a, b) => b.publishedAt - a.publishedAt); },

    /** Синхронный доступ к уже загруженной котировке. */
    quote: (ticker) => byTicker.get(ticker),

    async getHistory(ticker, interval = '1Y') {
      await wait();
      return INTERVALS[interval](history(ticker));
    },
    /** Текущий набор баров без задержки (для обновления последней свечи на тиках). */
    peekHistory: (ticker, interval) => INTERVALS[interval](history(ticker)),

    /** 52-недельный диапазон. */
    yearRange(ticker) {
      const bars = history(ticker).daily.slice(-252);
      return { low: Math.min(...bars.map((b) => b.low)), high: Math.max(...bars.map((b) => b.high)) };
    },
    sparkline: (ticker, n = 30) => history(ticker).daily.slice(-n).map((b) => b.close),

    /** Дневные бары индекса (~13 мес.), заканчивающиеся текущим значением. */
    async getIndexHistory(symbol) {
      await wait();
      const idx = indices.find((i) => i.symbol === symbol);
      const rng = U.rng(U.hash('idx:' + symbol)), days = businessDays(275);
      const closes = new Array(days.length);
      closes[days.length - 1] = idx.value;
      for (let i = days.length - 2; i >= 0; i--) closes[i] = closes[i + 1] / Math.exp(0.0004 + 0.011 * U.gauss(rng));
      return days.map((d, i) => {
        const c = closes[i], o = i ? closes[i - 1] : c;
        return { time: utc(d), open: o, close: c, high: Math.max(o, c) * 1.004, low: Math.min(o, c) * 0.996, volume: 0 };
      });
    },

    /** Подписка на «реалтайм». Возвращает функцию отписки. */
    subscribe(fn) {
      listeners.add(fn);
      if (!timer) timer = setInterval(tick, CONFIG.tickMs);
      return () => { listeners.delete(fn); if (!listeners.size) { clearInterval(timer); timer = null; } };
    },
  };
})();
