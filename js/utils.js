/**
 * FinPulse — утилиты: DOM-хелперы, форматирование чисел/дат,
 * детерминированный генератор случайных чисел, localStorage-обёртка.
 */
window.FP = window.FP || {};

FP.U = (() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /** Подсветить вхождение запроса в тексте (с экранированием). */
  const highlight = (text, q) => {
    const s = String(text);
    if (!q) return escape(s);
    const i = s.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return escape(s);
    return escape(s.slice(0, i)) + '<mark>' + escape(s.slice(i, i + q.length)) + '</mark>' + escape(s.slice(i + q.length));
  };

  /* ---------- Детерминированный RNG (одинаковые графики при каждой загрузке) ---------- */
  const hash = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  const rng = (seed) => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** Нормальное распределение N(0,1) (Box–Muller). */
  const gauss = (r = Math.random) => {
    let u = 0, v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  /* ---------- Числа ---------- */
  const fmtCache = {};
  const nf = (min, max) => (fmtCache[min + ':' + max] ||= new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: min, maximumFractionDigits: max,
  }));

  /** Цена: крупные значения без копеек. */
  const price = (v, digits) => {
    if (v == null || Number.isNaN(v)) return '—';
    const d = digits ?? (Math.abs(v) >= 10000 ? 0 : 2);
    return nf(d, d).format(v);
  };
  const signed = (v, digits) => (v > 0 ? '+' : v < 0 ? '−' : '') + price(Math.abs(v), digits);
  const pct = (v, withSign = true) => {
    if (v == null || Number.isNaN(v)) return '—';
    const sign = withSign ? (v > 0 ? '+' : v < 0 ? '−' : '') : (v < 0 ? '−' : '');
    return sign + nf(2, 2).format(Math.abs(v)) + '%';
  };
  const int = (v) => nf(0, 0).format(v);
  /** Компактная запись: 6,74 трлн ₽ */
  const compact = (v, unit = '') => {
    if (v == null) return '—';
    const a = Math.abs(v);
    const [div, suf] = a >= 1e12 ? [1e12, 'трлн'] : a >= 1e9 ? [1e9, 'млрд'] : a >= 1e6 ? [1e6, 'млн'] : a >= 1e3 ? [1e3, 'тыс.'] : [1, ''];
    const n = v / div;
    return nf(0, Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2).format(n) + (suf ? ' ' + suf : '') + (unit ? ' ' + unit : '');
  };
  const trend = (v) => (v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-muted');
  const arrow = (v) => (v > 0 ? '▲' : v < 0 ? '▼' : '•');

  /** Русское склонение: plural(5, ['день','дня','дней']) */
  const plural = (n, forms) => {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  };

  /* ---------- Даты ---------- */
  const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const parseISO = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  /** ISO-дата со смещением от сегодняшнего дня (для моков, «живущих» относительно текущей даты). */
  const daysFromToday = (n) => { const d = today(); d.setDate(d.getDate() + n); return isoDate(d); };
  const daysUntil = (iso) => Math.round((parseISO(iso) - today()) / 864e5);
  const date = (iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
    parseISO(iso).toLocaleDateString('ru-RU', opts).replace(' г.', '');
  const monthTitle = (iso) => {
    const s = parseISO(iso).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  /** Предыдущий рабочий день (режим торгов T+1: купить нужно до даты отсечки). */
  const prevBusinessDay = (iso) => {
    const d = parseISO(iso);
    do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6);
    return isoDate(d);
  };
  const relTime = (ts) => {
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60) return 'только что';
    if (diff < 3600) { const m = Math.floor(diff / 60); return `${m} мин назад`; }
    if (diff < 86400) { const h = Math.floor(diff / 3600); return `${h} ${plural(h, ['час', 'часа', 'часов'])} назад`; }
    return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  /* ---------- Прочее ---------- */
  /**
   * Число из поля ввода: принимает и запятую, и точку (на русской клавиатуре телефона
   * дробь набирается через запятую), пробелы-разделители тысяч игнорирует.
   * Пустая строка или мусор → null.
   */
  const parseNum = (v) => {
    if (v == null) return null;
    const s = String(v).replace(/[\s\u00a0]/g, '').replace(',', '.');
    if (s === '' || s === '-' || s === '.') return null;
    const x = Number(s);
    return Number.isFinite(x) ? x : null;
  };
  /** Оставить в поле только цифры, один разделитель и минус в начале. */
  const cleanNumInput = (el) => {
    const v = el.value, c = v.replace(/[^\d.,\-\s]/g, '').replace(/(?!^)-/g, '');
    if (c !== v) el.value = c;
  };

  const debounce = (fn, ms = 150) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  /** localStorage может быть недоступен (приватный режим, file://) — не падаем. */
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('fp:' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem('fp:' + key, JSON.stringify(value)); } catch { /* ignore */ } },
  };

  /** Мини-график (SVG) по массиву значений. */
  const sparkline = (values, { w = 96, h = 28 } = {}) => {
    if (!values || values.length < 2) return '';
    const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
    const pts = values.map((v, i) => `${(i / (values.length - 1) * w).toFixed(1)},${(h - 2 - (v - min) / span * (h - 4)).toFixed(1)}`);
    const up = values[values.length - 1] >= values[0];
    const color = up ? 'rgb(var(--c-up))' : 'rgb(var(--c-down))';
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="inline-block align-middle" aria-hidden="true">
      <polyline fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(' ')}"/></svg>`;
  };

  /** Цвет «логотипа»-аватара по тикеру. */
  const logoColor = (ticker) => `hsl(${hash(ticker) % 360} 62% 42%)`;
  const logo = (ticker, size = '') => `<span class="ticker-logo ${size}" style="background:${logoColor(ticker)}">${escape(ticker.slice(0, 4))}</span>`;

  /** Перерисовать иконки Lucide (после вставки HTML с data-lucide). */
  const icons = () => { if (window.lucide) window.lucide.createIcons(); };

  /** Кратковременная подсветка ячейки при изменении значения. */
  const flash = (el, dir) => {
    if (!el || !dir) return;
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth; // перезапуск анимации
    el.classList.add(dir > 0 ? 'flash-up' : 'flash-down');
  };

  return {
    $, $$, escape, highlight, hash, rng, gauss,
    price, signed, pct, int, compact, trend, arrow, plural,
    isoDate, parseISO, today, daysFromToday, daysUntil, date, monthTitle, prevBusinessDay, relTime,
    debounce, parseNum, cleanNumInput, store, sparkline, logo, logoColor, icons, flash,
  };
})();
