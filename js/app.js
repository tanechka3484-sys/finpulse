/**
 * FinPulse — UI-слой: роутинг вкладок, рендер разделов, поиск,
 * избранное/портфель и обновление котировок «в реальном времени».
 */
(() => {
  'use strict';
  const U = FP.U, API = FP.API;
  const { $, $$ } = U;

  const VIEWS = ['stocks', 'bonds', 'dividends', 'news', 'portfolio'];
  const SECTORS = ['all', 'Финансы', 'Энергетика', 'IT', 'Ритейл'];
  const COUPON_FREQ = { 30: 'ежемес.', 91: 'ежекв.', 182: 'полугод.', 365: 'ежегод.' };
  const NEWS_TAGS = { stocks: 'Акции', bonds: 'Облигации', macro: 'Макро' };
  const IMPACT = {
    positive: { label: 'Позитивно', cls: 'tag-up', icon: '▲' },
    negative: { label: 'Негативно', cls: 'tag-down', icon: '▼' },
    neutral: { label: 'Нейтрально', cls: 'tag-muted', icon: '●' },
  };

  /* =====================================================================
     Состояние
     ===================================================================== */
  const state = {
    view: 'stocks',
    stocks: [], bonds: [], dividends: [], news: [], indices: [],
    selected: U.store.get('selected', 'SBER'),
    chartTicker: null,
    chartLoading: false,
    periodStart: null,
    periodLabel: '',
    interval: U.store.get('interval', '1Y'),
    chartType: U.store.get('chartType', 'candles'),
    sector: 'all',
    sort: { key: 'turnover', dir: -1 },
    bondType: 'all', bondSort: { key: 'ytm', dir: -1 }, bondQuery: '',
    divMode: 'upcoming', divStatus: 'all',
    newsTag: 'all', newsImpact: 'all',
    favorites: U.store.get('favorites', ['SBER', 'LKOH', 'YDEX', 'X5']),
    positions: U.store.get('positions', { SBER: { qty: 300, avg: 281.4 }, LKOH: { qty: 5, avg: 7120 }, YDEX: { qty: 12, avg: 3890 } }),
  };
  let chart;
  let chartReq = 0;

  const turnover = (s) => s.price * s.volume;
  const isFav = (t) => state.favorites.includes(t);

  /* =====================================================================
     Общие кусочки разметки
     ===================================================================== */
  const qPrice = (s, cls = '') => `<span data-q="${s.ticker}" data-f="price" class="num ${cls}">${U.price(s.price)}</span>`;
  const qPct = (s, cls = '') => `<span data-q="${s.ticker}" data-f="pct" class="num ${U.trend(s.changePct)} ${cls}">${U.pct(s.changePct)}</span>`;
  const starBtn = (t) => `<button class="star ${isFav(t) ? 'on' : ''}" data-fav="${t}" title="В избранное" aria-label="Избранное ${t}"><i data-lucide="star" class="w-4 h-4"></i></button>`;
  const instrument = (s, sub = s.name) => `
    <div class="flex items-center gap-2.5 min-w-0">
      ${U.logo(s.ticker)}
      <div class="min-w-0 text-left"><div class="font-semibold leading-tight">${U.escape(s.ticker)}</div>
      <div class="text-xs text-muted truncate max-w-[180px]">${U.escape(sub)}</div></div>
    </div>`;
  const statCard = (label, value, sub = '', icon = '') => `
    <div class="card stat-card">
      <div class="flex items-center justify-between text-xs text-muted">${label}${icon ? `<i data-lucide="${icon}" class="w-4 h-4"></i>` : ''}</div>
      <div class="mt-2 text-xl font-semibold num">${value}</div>
      <div class="mt-1 text-xs text-muted">${sub}</div>
    </div>`;
  const skeletonRows = (tbody, cols, n = 6) => {
    tbody.innerHTML = Array.from({ length: n }, () => `<tr>${Array.from({ length: cols }, (_, i) =>
      `<td><span class="skeleton h-4 ${i === 0 ? 'w-32' : 'w-14'}"></span></td>`).join('')}</tr>`).join('');
  };
  const skeletonCards = (el, n, h = 'h-24') => { el.innerHTML = Array.from({ length: n }, () => `<div class="card"><span class="skeleton ${h} w-full block"></span></div>`).join(''); };
  const emptyRow = (cols, text) => `<tr><td colspan="${cols}" class="!text-center !py-10 text-muted">${text}</td></tr>`;

  function setSeg(container, attr, value) {
    $$(`[data-${attr}]`, container).forEach((b) => b.classList.toggle('active', b.dataset[attr] === value));
  }
  function markSorted(table, sort) {
    $$('th[data-sort]', table).forEach((th) => {
      th.classList.toggle('sorted', th.dataset.sort === sort.key);
      th.classList.toggle('asc', th.dataset.sort === sort.key && sort.dir > 0);
    });
  }
  const sorter = ({ key, dir }) => (a, b) => {
    const x = a[key] ?? -Infinity, y = b[key] ?? -Infinity;
    return (typeof x === 'string' ? x.localeCompare(y, 'ru') : x - y) * dir;
  };

  function toast(msg) {
    const el = $('#toast');
    el.innerHTML = `<div class="toast">${msg}</div>`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.innerHTML = ''; }, 2200);
  }

  /* =====================================================================
     Бегущая строка
     ===================================================================== */
  function renderTape() {
    const item = (i) => `
      <span class="flex items-center gap-2 px-5 border-r border-line/60 whitespace-nowrap" data-idx="${i.symbol}" title="${U.escape(i.name)}">
        <span class="font-semibold">${i.symbol}</span>
        <span class="num font-mono" data-f="value">${U.price(i.value)}</span>
        <span class="num font-mono ${U.trend(i.changePct)}" data-f="chg">${U.arrow(i.changePct)} ${U.pct(i.changePct)}</span>
      </span>`;
    const html = state.indices.map(item).join('');
    const tape = $('#ticker-tape');
    tape.innerHTML = html + html; // дублируем для бесшовной прокрутки
    tape.classList.add('running');
  }
  function updateTape(changed) {
    for (const { symbol, dir } of changed) {
      const i = state.indices.find((x) => x.symbol === symbol);
      $$(`[data-idx="${CSS.escape(symbol)}"]`).forEach((el) => {
        const v = $('[data-f="value"]', el), c = $('[data-f="chg"]', el);
        v.textContent = U.price(i.value); U.flash(v, dir);
        c.textContent = `${U.arrow(i.changePct)} ${U.pct(i.changePct)}`;
        c.classList.remove('text-up', 'text-down', 'text-muted'); c.classList.add(U.trend(i.changePct));
      });
    }
  }

  /* =====================================================================
     Котировки в ячейках (обновление на тиках без перерисовки)
     ===================================================================== */
  function updateQuoteCells(changed) {
    for (const { ticker, dir } of changed) {
      const s = API.quote(ticker);
      $$(`[data-q="${ticker}"]`).forEach((el) => {
        const f = el.dataset.f;
        if (f === 'price') { el.textContent = U.price(s.price); U.flash(el, dir); return; }
        if (f === 'volume') { el.textContent = U.compact(s.volume); return; }
        el.textContent = f === 'full' ? `${U.signed(s.change)} (${U.pct(s.changePct)})` : U.pct(s.changePct);
        el.classList.remove('text-up', 'text-down', 'text-muted'); el.classList.add(U.trend(s.changePct));
      });
    }
  }

  /* =====================================================================
     График и карточка инструмента
     ===================================================================== */
  function renderChartHead() {
    const s = API.quote(state.selected);
    $('#chart-head').innerHTML = `
      <div class="flex items-center gap-3">
        ${U.logo(s.ticker)}
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h1 class="text-lg font-semibold leading-tight truncate">${U.escape(s.name)}</h1>${starBtn(s.ticker)}
          </div>
          <div class="text-xs text-muted">${s.ticker} · MOEX TQBR · ${s.sector} · ${s.isin}</div>
        </div>
      </div>
      <div class="mt-3 flex items-baseline flex-wrap gap-x-3 gap-y-1">
        <span class="text-3xl font-bold tracking-tight">${qPrice(s)}</span><span class="text-muted text-sm -ml-2">₽</span>
        <span data-q="${s.ticker}" data-f="full" class="text-sm font-semibold num ${U.trend(s.changePct)}">${U.signed(s.change)} (${U.pct(s.changePct)})</span>
        <span class="text-xs text-muted">сегодня</span>
        <span id="period-change" class="tag"></span>
      </div>`;
    U.icons();
  }

  function updatePeriodChange() {
    const el = $('#period-change');
    if (!el || state.periodStart == null) return;
    const s = API.quote(state.selected);
    const p = (s.price / state.periodStart - 1) * 100;
    el.className = 'tag ' + (p >= 0 ? 'tag-up' : 'tag-down');
    el.textContent = `${U.pct(p)} за ${state.periodLabel}`;
  }

  function renderMetrics() {
    const s = API.quote(state.selected);
    const r = API.yearRange(s.ticker);
    const pos = Math.min(100, Math.max(0, (s.price - r.low) / (r.high - r.low) * 100));
    const cell = (label, value, sub) => `<div><div class="text-[11px] uppercase tracking-wide text-muted">${label}</div>
      <div class="mt-1 font-semibold num">${value}</div><div class="mt-1 text-xs text-muted num">${sub}</div></div>`;
    $('#chart-metrics').innerHTML = [
      cell('Объём', `<span data-q="${s.ticker}" data-f="volume">${U.compact(s.volume)}</span> шт.`, `оборот ${U.compact(turnover(s), '₽')}`),
      cell('P/E', s.pe ? U.price(s.pe, 1) : '—', `EPS ${U.price(s.eps)} ₽`),
      cell('Див. доходность', s.divYield ? `<span class="text-up">${U.pct(s.divYield, false)}</span>` : '—', s.divYield ? 'за 12 мес.' : 'не выплачивает'),
      cell('Капитализация', U.compact(s.marketCap, '₽'), `β ${U.price(s.beta)} · лот ${s.lot}`),
      cell('52-нед. диапазон', `${U.price(r.low)} – ${U.price(r.high)}`, `<div class="range-bar mt-2"><i style="left:${pos}%"></i></div>`),
      cell('Диапазон дня', `${U.price(s.dayLow)} – ${U.price(s.dayHigh)}`, `откр. ${U.price(s.open)}`),
    ].join('');
  }

  function chartSkeleton(show) {
    const sk = $('#chart-skeleton');
    if (show && !sk.dataset.ready) {
      sk.firstElementChild.innerHTML = Array.from({ length: 48 }, (_, i) =>
        `<span class="skeleton flex-1" style="height:${25 + 45 * Math.abs(Math.sin(i / 5)) + (i % 3) * 6}%"></span>`).join('');
      sk.dataset.ready = '1';
    }
    sk.classList.toggle('hidden', !show);
  }

  async function loadChart(ticker) {
    ticker = ticker.toUpperCase();
    if (!API.quote(ticker)) return;
    state.selected = state.chartTicker = ticker;
    U.store.set('selected', ticker);
    renderChartHead(); renderMetrics(); renderRelatedNews();
    $$('#stocks-table tbody tr[data-row]').forEach((tr) => tr.classList.toggle('selected', tr.dataset.row === ticker));
    document.title = `${ticker} ${U.price(API.quote(ticker).price)} ₽ — FinPulse`;
    await reloadChartData();
  }

  async function reloadChartData() {
    const req = ++chartReq;
    state.chartLoading = true;
    chartSkeleton(true);
    const { bars, intraday, label } = await API.getHistory(state.selected, state.interval);
    if (req !== chartReq) return; // пользователь уже выбрал другой инструмент/интервал
    chart.setData(bars, { intraday });
    state.periodStart = bars[0].open;
    state.periodLabel = label;
    updatePeriodChange();
    state.chartLoading = false;
    chartSkeleton(false);
  }

  function selectStock(ticker, { scroll = true } = {}) {
    const hash = `#stocks/${ticker}`;
    if (location.hash !== hash) location.hash = hash;
    else if (state.chartTicker !== ticker) loadChart(ticker);
    if (scroll) requestAnimationFrame(() => $('#chart-card').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  /* =====================================================================
     Раздел «Акции»: обзор, лидеры, таблица
     ===================================================================== */
  function renderOverview() {
    const s = state.stocks;
    if (!s.length) return;
    const up = s.filter((x) => x.changePct > 0).length, down = s.filter((x) => x.changePct < 0).length;
    const imoex = state.indices.find((i) => i.symbol === 'IMOEX');
    const sectors = SECTORS.slice(1).map((sec) => {
      const list = s.filter((x) => x.sector === sec);
      return { sec, avg: list.reduce((a, x) => a + x.changePct, 0) / list.length };
    }).sort((a, b) => b.avg - a.avg);
    const maxAbs = Math.max(...sectors.map((x) => Math.abs(x.avg)), 0.5);
    $('#market-overview').innerHTML = `
      ${imoex ? `<div class="flex items-baseline justify-between"><span class="text-xs text-muted">IMOEX</span>
        <span class="num font-semibold">${U.price(imoex.value)} <span class="${U.trend(imoex.changePct)} text-xs">${U.pct(imoex.changePct)}</span></span></div>` : ''}
      <div>
        <div class="flex justify-between text-xs mb-1.5"><span class="text-up">Растут: ${up}</span><span class="text-down">Падают: ${down}</span></div>
        <div class="flex h-2 rounded-full overflow-hidden bg-elevated">
          <div class="bg-up" style="width:${up / s.length * 100}%"></div><div class="flex-1"></div><div class="bg-down" style="width:${down / s.length * 100}%"></div>
        </div>
      </div>
      <div class="pt-1 space-y-2">
        <div class="text-xs text-muted">Секторы, ср. изменение</div>
        ${sectors.map(({ sec, avg }) => `
          <button class="w-full grid grid-cols-[84px_1fr_56px] items-center gap-2 text-xs group" data-sector-jump="${sec}">
            <span class="text-left group-hover:text-accent transition">${sec}</span>
            <span class="relative h-1.5 bg-elevated rounded-full"><span class="absolute top-0 h-full rounded-full ${avg >= 0 ? 'bg-up left-1/2' : 'bg-down right-1/2'}" style="width:${Math.abs(avg) / maxAbs * 50}%"></span></span>
            <span class="text-right num ${U.trend(avg)}">${U.pct(avg)}</span>
          </button>`).join('')}
      </div>`;
  }

  function renderLeaders() {
    const row = (s, right) => `
      <div class="leader-row" data-ticker="${s.ticker}">
        ${U.logo(s.ticker)}
        <div class="min-w-0 flex-1"><div class="text-sm font-semibold">${s.ticker}</div><div class="text-xs text-muted truncate">${U.escape(s.name)}</div></div>
        <div class="text-right"><div class="text-sm num">${U.price(s.price)}</div>${right(s)}</div>
      </div>`;
    const pctTag = (s) => `<span class="tag ${s.changePct >= 0 ? 'tag-up' : 'tag-down'} num">${U.pct(s.changePct)}</span>`;
    const by = (fn) => [...state.stocks].sort(fn).slice(0, 5);
    $('#leaders-gainers').innerHTML = by((a, b) => b.changePct - a.changePct).filter((s) => s.changePct > 0).map((s) => row(s, pctTag)).join('') || '<p class="text-sm text-muted py-4">Нет растущих бумаг</p>';
    $('#leaders-losers').innerHTML = by((a, b) => a.changePct - b.changePct).filter((s) => s.changePct < 0).map((s) => row(s, pctTag)).join('') || '<p class="text-sm text-muted py-4">Нет падающих бумаг</p>';
    $('#leaders-active').innerHTML = by((a, b) => turnover(b) - turnover(a)).map((s) => row(s, (x) => `<span class="text-xs text-muted num">${U.compact(turnover(x), '₽')}</span>`)).join('');
  }

  function renderSectorFilter() {
    $('#sector-filter').innerHTML = SECTORS.map((sec) => {
      const n = sec === 'all' ? state.stocks.length : state.stocks.filter((s) => s.sector === sec).length;
      return `<button class="chip ${state.sector === sec ? 'active' : ''}" data-sector="${sec}">${sec === 'all' ? 'Все' : sec} <span class="opacity-60">${n}</span></button>`;
    }).join('');
  }

  function renderStocksTable() {
    const tbody = $('#stocks-table tbody');
    const rows = state.stocks
      .filter((s) => state.sector === 'all' || s.sector === state.sector)
      .map((s) => ({ ...s, turnover: turnover(s), _ref: s }))
      .sort(sorter(state.sort));
    $('#stocks-count').textContent = rows.length;
    tbody.innerHTML = rows.map(({ _ref: s }) => `
      <tr class="clickable ${s.ticker === state.selected ? 'selected' : ''}" data-row="${s.ticker}">
        <td>${starBtn(s.ticker)}</td>
        <td class="!text-left">${instrument(s)}</td>
        <td class="!text-left hidden md:table-cell"><span class="tag tag-muted">${s.sector}</span></td>
        <td class="font-medium">${qPrice(s)}</td>
        <td>${qPct(s, 'font-medium')}</td>
        <td class="hidden sm:table-cell text-muted">${U.compact(turnover(s))}</td>
        <td class="hidden lg:table-cell text-muted">${U.compact(s.marketCap)}</td>
        <td class="hidden lg:table-cell">${s.pe ? U.price(s.pe, 1) : '—'}</td>
        <td class="hidden md:table-cell ${s.divYield >= 10 ? 'text-up font-medium' : ''}">${s.divYield ? U.pct(s.divYield, false) : '—'}</td>
        <td class="hidden sm:table-cell">${U.sparkline(API.sparkline(s.ticker))}</td>
      </tr>`).join('') || emptyRow(10, 'Нет бумаг в секторе');
    markSorted($('#stocks-table'), state.sort);
    U.icons();
  }

  function renderRelatedNews() {
    const el = $('#related-news');
    if (!el) return;
    $('#related-ticker').textContent = state.selected;
    if (!state.news.length) { el.innerHTML = '<span class="skeleton h-12 w-full block"></span><span class="skeleton h-12 w-full block"></span>'; return; }
    let list = state.news.filter((n) => n.tickers.includes(state.selected));
    const fallback = !list.length;
    if (fallback) list = state.news;
    el.innerHTML = (fallback ? '<p class="text-xs text-muted">По бумаге новостей нет — последние новости рынка:</p>' : '') +
      list.slice(0, 3).map((n) => `
        <a href="#news" class="block group">
          <div class="flex items-center gap-2 text-[11px] text-muted"><span class="tag ${IMPACT[n.impact].cls}">${IMPACT[n.impact].icon}</span>${U.escape(n.source)} · ${U.relTime(n.publishedAt)}</div>
          <div class="mt-1 text-sm leading-snug group-hover:text-accent transition">${U.escape(n.title)}</div>
        </a>`).join('');
  }

  /* =====================================================================
     Раздел «Облигации»
     ===================================================================== */
  const ratingTag = (r, score) => `<span class="tag ${score >= 9 ? 'tag-up' : score >= 5 ? 'tag-accent' : 'tag-warn'}">${r}</span>`;

  function renderBondSummary() {
    const b = state.bonds;
    const avg = (list) => list.reduce((a, x) => a + x.ytm, 0) / list.length;
    const ofz = b.filter((x) => x.type === 'ofz'), corpAAA = b.filter((x) => x.type === 'corp' && x.rating === 'AAA');
    const max = [...b].sort((x, y) => y.ytm - x.ytm)[0];
    const spread = (avg(corpAAA) - avg(ofz)) * 100;
    $('#bond-summary').innerHTML = [
      statCard('Ср. YTM ОФЗ', U.pct(avg(ofz), false), `${ofz.length} ${U.plural(ofz.length, ['выпуск', 'выпуска', 'выпусков'])}`, 'landmark'),
      statCard('Ср. YTM корп. AAA', U.pct(avg(corpAAA), false), `${corpAAA.length} ${U.plural(corpAAA.length, ['выпуск', 'выпуска', 'выпусков'])}`, 'building-2'),
      statCard('Спред AAA к ОФЗ', `${U.int(spread)} б.п.`, 'премия за кредитный риск', 'move-vertical'),
      statCard('Макс. доходность', `<span class="text-warn">${U.pct(max.ytm, false)}</span>`, `${U.escape(max.name)} · ${max.rating}`, 'alert-triangle'),
    ].join('');
    U.icons();
  }

  function renderBonds() {
    const q = state.bondQuery.trim().toLowerCase();
    const rows = state.bonds
      .filter((b) => state.bondType === 'all' || b.type === state.bondType)
      .filter((b) => !q || [b.name, b.isin, b.secid, b.issuer].some((v) => v.toLowerCase().includes(q)))
      .sort(sorter(state.bondSort));
    $('#bonds-count').textContent = rows.length;
    $('#bonds-table tbody').innerHTML = rows.map((b) => `
      <tr class="clickable" data-bond="${b.isin}">
        <td class="!text-left">
          <div class="flex items-center gap-2.5">
            <span class="ticker-logo" style="background:${b.type === 'ofz' ? 'rgb(var(--c-accent))' : U.logoColor(b.issuer)}">${b.type === 'ofz' ? 'ОФЗ' : U.escape(b.name.slice(0, 3))}</span>
            <div><div class="font-semibold leading-tight">${U.highlight(b.name, q)}</div><div class="text-xs text-muted font-mono">${U.highlight(b.isin, q)}</div></div>
          </div>
        </td>
        <td>${U.price(b.price)}</td>
        <td class="font-semibold ${b.ytm >= 20 ? 'text-warn' : 'text-up'}">${U.pct(b.ytm, false)}</td>
        <td>${U.pct(b.coupon, false)}</td>
        <td class="hidden sm:table-cell"><span class="text-muted">${COUPON_FREQ[b.couponPeriod] || ''}</span> ${b.couponPeriod} дн.</td>
        <td class="hidden md:table-cell">${U.price(b.duration)} г.</td>
        <td class="hidden md:table-cell"><div>${U.date(b.maturity)}</div><div class="text-xs text-muted">через ${U.price(b.yearsToMaturity, 1)} г.</div></td>
        <td>${ratingTag(b.rating, b.ratingScore)}</td>
      </tr>`).join('') || emptyRow(8, 'Ничего не найдено');
    markSorted($('#bonds-table'), state.bondSort);
  }

  /** Кривая доходности — лёгкий SVG без библиотек. */
  function renderYieldCurve() {
    const W = 360, H = 230, P = { l: 34, r: 12, t: 14, b: 26 };
    const pts = state.bonds.map((b) => ({ b, x: b.yearsToMaturity, y: b.ytm }));
    const xMax = Math.ceil(Math.max(...pts.map((p) => p.x)) / 5) * 5;
    const yMin = Math.floor(Math.min(...pts.map((p) => p.y)) - 1), yCap = 30; // выбросы выше 30% прижимаем к верху
    const sx = (x) => P.l + x / xMax * (W - P.l - P.r);
    const sy = (y) => P.t + (1 - (Math.min(y, yCap) - yMin) / (yCap - yMin)) * (H - P.t - P.b);
    const ofz = pts.filter((p) => p.b.type === 'ofz').sort((a, b) => a.x - b.x);
    const yTicks = []; for (let y = Math.ceil(yMin / 4) * 4; y <= yCap; y += 4) yTicks.push(y);
    const xTicks = []; for (let x = 0; x <= xMax; x += 5) xTicks.push(x);
    const dot = (p) => {
      const clipped = p.y > yCap;
      return `<g class="cursor-pointer" data-bond="${p.b.isin}">
        <circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="5" fill="${p.b.type === 'ofz' ? 'rgb(var(--c-accent))' : 'rgb(var(--c-warn))'}" stroke="rgb(var(--c-surface))" stroke-width="2"><title>${U.escape(p.b.name)}: ${U.pct(p.y, false)}, ${U.price(p.x, 1)} г.</title></circle>
        ${clipped ? `<text x="${sx(p.x) + 8}" y="${sy(p.y) + 4}" font-size="10" fill="rgb(var(--c-warn))">${U.pct(p.y, false)} ↑</text>` : ''}
      </g>`;
    };
    $('#yield-curve').innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" role="img" aria-label="Кривая доходности">
        ${yTicks.map((y) => `<line x1="${P.l}" x2="${W - P.r}" y1="${sy(y)}" y2="${sy(y)}" stroke="rgb(var(--c-line))" stroke-dasharray="3 3"/>
          <text x="${P.l - 6}" y="${sy(y) + 3}" font-size="10" text-anchor="end" fill="rgb(var(--c-muted))">${y}%</text>`).join('')}
        ${xTicks.map((x) => `<text x="${sx(x)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="rgb(var(--c-muted))">${x} л</text>`).join('')}
        <polyline fill="none" stroke="rgb(var(--c-accent))" stroke-width="2" stroke-linejoin="round" points="${ofz.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')}"/>
        ${pts.map(dot).join('')}
      </svg>`;
  }

  function openBond(isin) {
    const b = state.bonds.find((x) => x.isin === isin);
    if (!b) return;
    const toCoupon = U.daysUntil(b.nextCoupon);
    const item = (label, value) => `<div class="p-3 rounded-lg bg-bg/60 border border-line"><div class="text-[11px] text-muted uppercase tracking-wide">${label}</div><div class="mt-1 font-semibold num">${value}</div></div>`;
    $('#modal-body').innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="flex items-center gap-2"><h3 class="text-lg font-semibold">${U.escape(b.name)}</h3>${ratingTag(b.rating, b.ratingScore)}</div>
          <p class="text-xs text-muted mt-1">${U.escape(b.issuer)} · <span class="font-mono">${b.isin}</span> · ${b.type === 'ofz' ? 'Государственная' : 'Корпоративная'}</p>
        </div>
        <button class="icon-btn" data-close aria-label="Закрыть"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <div class="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
        ${item('Цена', `${U.price(b.price)}% <span class="text-xs text-muted font-normal">(${U.price(b.nominal * b.price / 100)} ₽)</span>`)}
        ${item('YTM', `<span class="text-up">${U.pct(b.ytm, false)}</span>`)}
        ${item('Купон', `${U.pct(b.coupon, false)} · ${U.price(b.couponValue)} ₽`)}
        ${item('Выплаты', `${COUPON_FREQ[b.couponPeriod] || ''} (${b.couponPeriod} дн.)`)}
        ${item('Ближайший купон', `${U.date(b.nextCoupon)} <span class="text-xs text-muted font-normal">через ${toCoupon} ${U.plural(toCoupon, ['день', 'дня', 'дней'])}</span>`)}
        ${item('Погашение', U.date(b.maturity))}
        ${item('До погашения', `${U.price(b.yearsToMaturity, 1)} г.`)}
        ${item('Дюрация', `${U.price(b.duration)} г.`)}
        ${item('Номинал', `${U.int(b.nominal)} ₽`)}
      </div>
      <p class="mt-4 text-xs text-muted">Купонный доход на 1 облигацию за год ≈ ${U.price(b.nominal * b.coupon / 100)} ₽ (до НДФЛ). Текущая доходность — ${U.pct(b.coupon / b.price * 100, false)}.</p>`;
    $('#modal').classList.remove('hidden');
    U.icons();
  }
  const closeModal = () => $('#modal').classList.add('hidden');

  /* =====================================================================
     Раздел «Дивиденды»
     ===================================================================== */
  function enrichDividends() {
    return state.dividends.map((d) => {
      const s = API.quote(d.ticker);
      return { ...d, stock: s, yield: d.amount / s.price * 100, days: U.daysUntil(d.exDate), buyBy: U.prevBusinessDay(d.exDate) };
    });
  }

  function renderDividends() {
    const all = enrichDividends();
    const upcoming = all.filter((d) => d.days >= 0).sort((a, b) => a.days - b.days);

    // Сводка
    const next = upcoming[0];
    const best = [...upcoming].sort((a, b) => b.yield - a.yield)[0];
    const in30 = upcoming.filter((d) => d.days <= 30).length;
    const approved = upcoming.filter((d) => d.status === 'approved').length;
    $('#div-summary').innerHTML = [
      next ? statCard('Ближайшая отсечка', `${next.ticker} · ${U.date(next.exDate, { day: 'numeric', month: 'short' })}`, `купить до ${U.date(next.buyBy, { day: 'numeric', month: 'short' })} · через ${next.days} ${U.plural(next.days, ['день', 'дня', 'дней'])}`, 'calendar-clock') : statCard('Ближайшая отсечка', '—', ''),
      best ? statCard('Макс. доходность', `<span class="text-up">${U.pct(best.yield, false)}</span>`, `${best.ticker} · ${U.price(best.amount)} ₽ на акцию`, 'percent') : '',
      statCard('Отсечек за 30 дней', in30, `всего предстоящих: ${upcoming.length}`, 'calendar-range'),
      statCard('Одобрено / рекоменд.', `<span class="text-up">${approved}</span> / <span class="text-warn">${upcoming.length - approved}</span>`, 'по предстоящим выплатам', 'badge-check'),
    ].join('');

    // Таблица
    let rows = state.divMode === 'upcoming' ? upcoming : state.divMode === 'past'
      ? all.filter((d) => d.days < 0).sort((a, b) => b.days - a.days)
      : [...all].sort((a, b) => a.exDate.localeCompare(b.exDate));
    if (state.divStatus !== 'all') rows = rows.filter((d) => d.status === state.divStatus);

    let month = '';
    const html = [];
    for (const d of rows) {
      const m = U.monthTitle(d.exDate);
      if (m !== month) { month = m; html.push(`<tr class="group-row"><td colspan="7">${m}</td></tr>`); }
      const past = d.days < 0;
      const when = d.days === 0 ? '<span class="text-warn">сегодня</span>' : past ? `${-d.days} дн. назад` : `через ${d.days} ${U.plural(d.days, ['день', 'дня', 'дней'])}`;
      html.push(`
        <tr class="clickable ${past ? 'opacity-70' : ''}" data-ticker="${d.ticker}">
          <td class="!text-left">${instrument(d.stock)}</td>
          <td class="!text-left hidden md:table-cell text-muted">${U.escape(d.period)}</td>
          <td class="${past ? '' : 'font-semibold'}">${U.date(d.buyBy, { day: 'numeric', month: 'short' })}</td>
          <td><div>${U.date(d.exDate)}</div><div class="text-xs text-muted">${when}</div></td>
          <td class="font-semibold">${U.price(d.amount)} ₽</td>
          <td><span class="tag ${d.yield >= 10 ? 'tag-up' : 'tag-accent'} num">${U.pct(d.yield, false)}</span></td>
          <td class="hidden sm:table-cell">${d.status === 'approved' ? '<span class="tag tag-up">✓ Одобрено</span>' : '<span class="tag tag-warn">◷ Рекомендовано</span>'}</td>
        </tr>`);
    }
    $('#div-table tbody').innerHTML = html.join('') || emptyRow(7, 'Нет событий по выбранным фильтрам');
    U.icons();
  }

  /* =====================================================================
     Раздел «Новости»
     ===================================================================== */
  function renderNews() {
    const list = state.news
      .filter((n) => state.newsTag === 'all' || n.tags.includes(state.newsTag))
      .filter((n) => state.newsImpact === 'all' || n.impact === state.newsImpact);
    $('#news-grid').innerHTML = list.map((n) => {
      const imp = IMPACT[n.impact];
      return `
        <article class="card news-card impact-${n.impact}">
          <div class="flex items-center justify-between gap-2 text-xs text-muted">
            <span class="flex items-center gap-1.5 font-medium text-fg"><i data-lucide="radio" class="w-3.5 h-3.5 text-accent"></i>${U.escape(n.source)}</span>
            <span class="flex items-center gap-1"><i data-lucide="clock" class="w-3.5 h-3.5"></i>${U.relTime(n.publishedAt)}</span>
          </div>
          <h3 class="font-semibold leading-snug">${U.escape(n.title)}</h3>
          <p class="text-sm text-muted line-clamp-3">${U.escape(n.summary)}</p>
          <div class="mt-auto pt-1 flex flex-wrap items-center gap-1.5">
            <span class="tag ${imp.cls}">${imp.icon} ${imp.label}</span>
            ${n.tags.map((t) => `<span class="tag tag-muted">#${NEWS_TAGS[t]}</span>`).join('')}
            ${n.tickers.map((t) => `<button class="tag tag-accent hover:brightness-125" data-ticker="${t}">$${t} ${(() => { const s = API.quote(t); return s ? `<span class="${U.trend(s.changePct)}">${U.pct(s.changePct)}</span>` : ''; })()}</button>`).join('')}
          </div>
        </article>`;
    }).join('') || '<p class="text-muted text-sm col-span-full py-10 text-center">Новостей по фильтру нет</p>';
    U.icons();
  }

  /* =====================================================================
     Раздел «Портфель / Избранное»
     ===================================================================== */
  const PALETTE = ['#3b82f6', '#22c55e', '#eab308', '#a855f7', '#ef4444', '#06b6d4', '#f97316', '#ec4899', '#84cc16', '#64748b'];

  function portfolioRows() {
    return state.favorites.map((t) => {
      const s = API.quote(t), p = state.positions[t] || { qty: 0, avg: 0 };
      const value = p.qty * s.price, cost = p.qty * p.avg;
      return { s, p, value, cost, pnl: p.qty && p.avg ? value - cost : 0, day: p.qty * s.change };
    });
  }

  function renderPortfolio() {
    $('#fav-count').textContent = state.favorites.length;
    const tbody = $('#pf-table tbody');
    if (!state.favorites.length) {
      tbody.innerHTML = emptyRow(9, 'Список пуст. Нажмите ★ рядом с акцией, чтобы добавить её в избранное.');
    } else {
      tbody.innerHTML = portfolioRows().map(({ s, p }) => `
        <tr data-pf="${s.ticker}">
          <td>${starBtn(s.ticker)}</td>
          <td class="!text-left">${instrument(s)}</td>
          <td>${qPrice(s, 'font-medium')}</td>
          <td>${qPct(s)}</td>
          <td><input class="input input-num" type="number" min="0" step="1" inputmode="decimal" data-pos="qty" value="${p.qty || ''}" placeholder="0" aria-label="Количество ${s.ticker}"></td>
          <td><input class="input input-num" type="number" min="0" step="0.01" inputmode="decimal" data-pos="avg" value="${p.avg || ''}" placeholder="0,00" aria-label="Средняя цена ${s.ticker}"></td>
          <td class="hidden sm:table-cell" data-cell="value"></td>
          <td data-cell="pnl"></td>
          <td><button class="icon-btn !w-8 !h-8" data-ticker="${s.ticker}" title="Открыть график"><i data-lucide="chart-candlestick" class="w-4 h-4"></i></button></td>
        </tr>`).join('');
    }
    updatePortfolioValues();
    U.icons();
  }

  function updatePortfolioValues() {
    const rows = portfolioRows();
    for (const r of rows) {
      const tr = $(`#pf-table tr[data-pf="${r.s.ticker}"]`);
      if (!tr) continue;
      $('[data-cell="value"]', tr).textContent = r.p.qty ? `${U.price(r.value)} ₽` : '—';
      const pct = r.cost ? r.pnl / r.cost * 100 : 0;
      $('[data-cell="pnl"]', tr).innerHTML = r.cost
        ? `<div class="${U.trend(r.pnl)} font-medium num">${U.signed(r.pnl)} ₽</div><div class="text-xs ${U.trend(pct)}">${U.pct(pct)}</div>` : '<span class="text-muted">—</span>';
    }
    const total = rows.reduce((a, r) => a + r.value, 0);
    const cost = rows.reduce((a, r) => a + (r.cost && r.p.avg ? r.cost : 0), 0);
    const pnl = rows.reduce((a, r) => a + r.pnl, 0);
    const day = rows.reduce((a, r) => a + r.day, 0);
    const positions = rows.filter((r) => r.p.qty > 0);
    $('#pf-summary').innerHTML = [
      statCard('Стоимость портфеля', `${U.price(total)} ₽`, `${positions.length} ${U.plural(positions.length, ['позиция', 'позиции', 'позиций'])}`, 'wallet'),
      statCard('Доход за всё время', `<span class="${U.trend(pnl)}">${U.signed(pnl)} ₽</span>`, cost ? `<span class="${U.trend(pnl)}">${U.pct(pnl / cost * 100)}</span> к вложениям ${U.compact(cost, '₽')}` : 'укажите среднюю цену', 'trending-up'),
      statCard('Изменение за день', `<span class="${U.trend(day)}">${U.signed(day)} ₽</span>`, total ? `<span class="${U.trend(day)}">${U.pct(day / (total - day) * 100)}</span>` : '—', 'activity'),
      statCard('В избранном', state.favorites.length, 'бумаг отслеживается', 'star'),
    ].join('');

    const alloc = $('#pf-allocation');
    alloc.classList.toggle('hidden', !total);
    if (total) {
      const parts = positions.sort((a, b) => b.value - a.value);
      alloc.innerHTML = `
        <h3 class="card-title"><i data-lucide="pie-chart" class="w-4 h-4 text-accent"></i>Структура портфеля</h3>
        <div class="mt-3 flex h-3 rounded-full overflow-hidden gap-0.5">${parts.map((r, i) => `<div style="width:${r.value / total * 100}%;background:${PALETTE[i % PALETTE.length]}" title="${r.s.ticker}"></div>`).join('')}</div>
        <div class="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">${parts.map((r, i) => `<span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm" style="background:${PALETTE[i % PALETTE.length]}"></span><b>${r.s.ticker}</b><span class="text-muted num">${U.pct(r.value / total * 100, false)}</span></span>`).join('')}</div>`;
    }
    U.icons();
  }

  function toggleFav(ticker) {
    const on = !isFav(ticker);
    state.favorites = on ? [...state.favorites, ticker] : state.favorites.filter((t) => t !== ticker);
    U.store.set('favorites', state.favorites);
    $$(`[data-fav="${ticker}"]`).forEach((b) => b.classList.toggle('on', on));
    toast(on ? `★ ${ticker} добавлен в избранное` : `${ticker} удалён из избранного`);
    if (state.view === 'portfolio' || !on) renderPortfolio();
    else $('#fav-count').textContent = state.favorites.length;
  }

  /* =====================================================================
     Поиск с автодополнением
     ===================================================================== */
  const search = { items: [], active: -1 };

  function searchFind(raw) {
    const q = raw.trim().toLowerCase();
    if (!q) {
      return [...state.stocks].sort((a, b) => turnover(b) - turnover(a)).slice(0, 5).map((s) => ({ kind: 'stock', s, group: 'Популярное' }));
    }
    const score = (s) => {
      const t = s.ticker.toLowerCase(), n = s.name.toLowerCase();
      if (t === q) return 100;
      if (t.startsWith(q)) return 80;
      if (n.startsWith(q)) return 60;
      if (n.includes(q)) return 40;
      if (s.isin.toLowerCase().includes(q)) return 30;
      return 0;
    };
    const stocks = state.stocks.map((s) => ({ kind: 'stock', s, group: 'Акции', score: score(s) })).filter((x) => x.score).sort((a, b) => b.score - a.score).slice(0, 6);
    const bonds = state.bonds.filter((b) => [b.name, b.isin, b.secid, b.issuer].some((v) => v.toLowerCase().includes(q))).slice(0, 5).map((b) => ({ kind: 'bond', b, group: 'Облигации' }));
    return [...stocks, ...bonds];
  }

  function renderSearch() {
    const input = $('#search-input'), box = $('#search-results');
    const q = input.value.trim();
    search.items = searchFind(input.value);
    if (search.active >= search.items.length) search.active = search.items.length - 1;
    let group = '';
    box.innerHTML = search.items.map((it, i) => {
      const head = it.group !== group ? `<div class="search-group">${(group = it.group)}</div>` : '';
      const cls = `search-item ${i === search.active ? 'active' : ''}`;
      if (it.kind === 'stock') {
        const s = it.s;
        return `${head}<div class="${cls}" data-i="${i}" role="option">${U.logo(s.ticker)}
          <div class="flex-1 min-w-0"><div class="text-sm font-semibold">${U.highlight(s.ticker, q)} <span class="font-normal text-muted">· ${U.highlight(s.name, q)}</span></div>
          <div class="text-xs text-muted">${s.sector} · <span class="font-mono">${U.highlight(s.isin, q)}</span></div></div>
          <div class="text-right"><div class="text-sm num">${U.price(s.price)} ₽</div><div class="text-xs num ${U.trend(s.changePct)}">${U.pct(s.changePct)}</div></div></div>`;
      }
      const b = it.b;
      return `${head}<div class="${cls}" data-i="${i}" role="option"><span class="ticker-logo" style="background:rgb(var(--c-accent))">${b.type === 'ofz' ? 'ОФЗ' : 'BND'}</span>
        <div class="flex-1 min-w-0"><div class="text-sm font-semibold truncate">${U.highlight(b.name, q)}</div><div class="text-xs text-muted font-mono">${U.highlight(b.isin, q)}</div></div>
        <div class="text-right"><div class="text-sm num text-up">${U.pct(b.ytm, false)}</div><div class="text-xs text-muted">YTM</div></div></div>`;
    }).join('') || `<div class="p-4 text-sm text-muted">Ничего не найдено по запросу «${U.escape(q)}»</div>`;
    box.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
  }

  function closeSearch() { $('#search-results').classList.add('hidden'); $('#search-input').setAttribute('aria-expanded', 'false'); search.active = -1; }

  function chooseSearch(i) {
    const it = search.items[i];
    if (!it) return;
    const input = $('#search-input');
    input.value = ''; input.blur(); closeSearch();
    if (it.kind === 'stock') selectStock(it.s.ticker);
    else { location.hash = '#bonds'; openBond(it.b.isin); }
  }

  function initSearch() {
    const input = $('#search-input'), box = $('#search-results');
    input.addEventListener('focus', () => { search.active = -1; renderSearch(); });
    input.addEventListener('input', U.debounce(() => { search.active = 0; renderSearch(); }, 80));
    input.addEventListener('blur', () => setTimeout(closeSearch, 120));
    input.addEventListener('keydown', (e) => {
      const n = search.items.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); search.active = (search.active + 1) % n; renderSearch(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); search.active = (search.active - 1 + n) % n; renderSearch(); }
      else if (e.key === 'Enter') { e.preventDefault(); chooseSearch(Math.max(0, search.active)); }
      else if (e.key === 'Escape') { input.blur(); }
    });
    // mousedown — чтобы сработать раньше blur
    box.addEventListener('mousedown', (e) => {
      const el = e.target.closest('[data-i]');
      if (el) { e.preventDefault(); chooseSearch(+el.dataset.i); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); }
      if (e.key === 'Escape') closeModal();
    });
  }

  /* =====================================================================
     Статус биржи (время МСК)
     ===================================================================== */
  function renderMarketStatus() {
    const msk = new Date(Date.now() + 3 * 3600e3);
    const h = msk.getUTCHours(), m = msk.getUTCMinutes(), dow = msk.getUTCDay(), mins = h * 60 + m;
    const weekday = dow > 0 && dow < 6;
    let cls = '', text = 'Биржа закрыта';
    if (!weekday) text = 'Выходной день';
    else if (mins >= 600 && mins < 1130) { cls = 'open'; text = 'Основная сессия'; }
    else if (mins >= 1145 && mins < 1430) { cls = 'evening'; text = 'Вечерняя сессия'; }
    const el = $('#market-status');
    $('.status-dot', el).className = 'status-dot ' + cls;
    $('.status-text', el).textContent = 'MOEX · ' + text;
    $('.status-clock', el).textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} МСК`;
  }

  /* =====================================================================
     Роутинг вкладок (#stocks/SBER, #bonds, …)
     ===================================================================== */
  function setView(view) {
    if (state.view !== view) window.scrollTo({ top: 0 });
    state.view = view;
    $$('[data-view]').forEach((s) => { s.hidden = s.dataset.view !== view; });
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === view));
    if (view === 'portfolio' && state.stocks.length) renderPortfolio();
    if (view === 'news' && state.news.length) renderNews(); // освежить «N мин назад»
  }

  function route() {
    const [rawView, param] = location.hash.slice(1).split('/');
    const view = VIEWS.includes(rawView) ? rawView : 'stocks';
    setView(view);
    if (view === 'stocks' && param && state.stocks.length && param.toUpperCase() !== state.chartTicker) loadChart(param);
  }

  /* =====================================================================
     События
     ===================================================================== */
  function bindEvents() {
    // Делегирование кликов на весь документ
    document.addEventListener('click', (e) => {
      const t = e.target;
      const fav = t.closest('[data-fav]');
      if (fav) { e.stopPropagation(); toggleFav(fav.dataset.fav); return; }
      if (t.closest('input')) return;

      const closeEl = t.closest('[data-close]');
      if (closeEl) { closeModal(); return; }

      const ticker = t.closest('[data-ticker]');
      if (ticker) { selectStock(ticker.dataset.ticker); return; }

      const row = t.closest('tr[data-row]');
      if (row) { selectStock(row.dataset.row, { scroll: true }); return; }

      const bond = t.closest('[data-bond]');
      if (bond) { openBond(bond.dataset.bond); return; }

      const jump = t.closest('[data-sector-jump]');
      if (jump) {
        state.sector = jump.dataset.sectorJump; renderSectorFilter(); renderStocksTable();
        $('#stocks-table').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });

    // Переключатели графика
    $('#interval-switch').addEventListener('click', (e) => {
      const b = e.target.closest('[data-interval]');
      if (!b || b.dataset.interval === state.interval) return;
      state.interval = b.dataset.interval; U.store.set('interval', state.interval);
      setSeg($('#interval-switch'), 'interval', state.interval);
      reloadChartData();
    });
    $('#type-switch').addEventListener('click', (e) => {
      const b = e.target.closest('[data-type]');
      if (!b) return;
      state.chartType = b.dataset.type; U.store.set('chartType', state.chartType);
      setSeg($('#type-switch'), 'type', state.chartType);
      chart.setType(state.chartType);
    });

    // Фильтр секторов и сортировки
    $('#sector-filter').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sector]');
      if (!b) return;
      state.sector = b.dataset.sector; renderSectorFilter(); renderStocksTable();
    });
    const sortable = (table, key, render) => $(`${table} thead`).addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      const s = state[key];
      state[key] = { key: th.dataset.sort, dir: s.key === th.dataset.sort ? -s.dir : (['ticker', 'name', 'sector', 'maturity'].includes(th.dataset.sort) ? 1 : -1) };
      render();
    });
    sortable('#stocks-table', 'sort', renderStocksTable);
    sortable('#bonds-table', 'bondSort', renderBonds);

    // Облигации
    $('#bond-type').addEventListener('click', (e) => {
      const b = e.target.closest('[data-bondtype]');
      if (!b) return;
      state.bondType = b.dataset.bondtype; setSeg($('#bond-type'), 'bondtype', state.bondType); renderBonds();
    });
    $('#bond-query').addEventListener('input', U.debounce((e) => { state.bondQuery = e.target.value; renderBonds(); }, 100));

    // Дивиденды
    $('#div-mode').addEventListener('click', (e) => {
      const b = e.target.closest('[data-divmode]');
      if (!b) return;
      state.divMode = b.dataset.divmode; setSeg($('#div-mode'), 'divmode', state.divMode); renderDividends();
    });
    $('#div-status').addEventListener('click', (e) => {
      const b = e.target.closest('[data-divstatus]');
      if (!b) return;
      state.divStatus = b.dataset.divstatus; setSeg($('#div-status'), 'divstatus', state.divStatus); renderDividends();
    });

    // Новости
    $('#news-tag').addEventListener('click', (e) => {
      const b = e.target.closest('[data-newstag]');
      if (!b) return;
      state.newsTag = b.dataset.newstag; setSeg($('#news-tag'), 'newstag', state.newsTag); renderNews();
    });
    $('#news-impact').addEventListener('click', (e) => {
      const b = e.target.closest('[data-impact]');
      if (!b) return;
      state.newsImpact = b.dataset.impact; setSeg($('#news-impact'), 'impact', state.newsImpact); renderNews();
    });

    // Портфель: ввод количества / средней цены
    $('#pf-table').addEventListener('input', (e) => {
      const inp = e.target.closest('[data-pos]');
      if (!inp) return;
      const ticker = inp.closest('tr').dataset.pf;
      const p = state.positions[ticker] ||= { qty: 0, avg: 0 };
      p[inp.dataset.pos] = Math.max(0, parseFloat(inp.value.replace(',', '.')) || 0);
      U.store.set('positions', state.positions);
      updatePortfolioValues();
    });

    // Тема
    $('#theme-toggle').addEventListener('click', () => {
      const html = document.documentElement;
      const light = html.classList.contains('dark');
      html.classList.toggle('dark', !light); html.classList.toggle('light', light);
      $('meta[name="theme-color"]').content = light ? '#f1f5f9' : '#0f172a';
      U.store.set('theme', light ? 'light' : 'dark');
      chart.applyTheme();
    });

    window.addEventListener('hashchange', route);
  }

  /* =====================================================================
     Реалтайм
     ===================================================================== */
  function onTick({ stocks, indices }) {
    updateTape(indices);
    updateQuoteCells(stocks);
    if (!state.chartLoading && stocks.some((c) => c.ticker === state.chartTicker)) {
      const { bars } = API.peekHistory(state.chartTicker, state.interval);
      chart.updateLast(bars[bars.length - 1]);
      renderMetrics();
      updatePeriodChange();
      document.title = `${state.chartTicker} ${U.price(API.quote(state.chartTicker).price)} ₽ — FinPulse`;
    }
    if (stocks.length) { renderLeaders(); renderOverview(); }
    if (state.view === 'portfolio') updatePortfolioValues();
  }

  /* =====================================================================
     Старт
     ===================================================================== */
  async function init() {
    U.icons();
    chart = new FP.PriceChart($('#chart'), $('#chart-legend'));
    chart.setType(state.chartType);
    setSeg($('#interval-switch'), 'interval', state.interval);
    setSeg($('#type-switch'), 'type', state.chartType);
    setSeg($('#bond-type'), 'bondtype', state.bondType);
    setSeg($('#div-mode'), 'divmode', state.divMode);
    setSeg($('#div-status'), 'divstatus', state.divStatus);
    setSeg($('#news-tag'), 'newstag', state.newsTag);
    setSeg($('#news-impact'), 'impact', state.newsImpact);
    $('#fav-count').textContent = state.favorites.length;

    // Скелетоны, пока «идут запросы»
    chartSkeleton(true);
    skeletonRows($('#stocks-table tbody'), 10, 8);
    skeletonRows($('#bonds-table tbody'), 8, 8);
    skeletonRows($('#div-table tbody'), 7, 6);
    skeletonCards($('#news-grid'), 6, 'h-40');
    ['#bond-summary', '#div-summary', '#pf-summary'].forEach((s) => skeletonCards($(s), 4, 'h-16'));
    ['#leaders-gainers', '#leaders-losers', '#leaders-active'].forEach((s) => {
      $(s).innerHTML = Array.from({ length: 5 }, () => '<div class="flex items-center gap-3 py-2"><span class="skeleton w-8 h-8"></span><span class="skeleton h-4 flex-1"></span><span class="skeleton h-4 w-14"></span></div>').join('');
    });

    bindEvents();
    initSearch();
    renderMarketStatus();
    setInterval(renderMarketStatus, 15000);
    route();

    // Каждый блок отрисовывается, как только «пришли» его данные
    const pIndices = API.getIndices().then((d) => { state.indices = d; renderTape(); });
    const pStocks = API.getStocks().then((d) => {
      state.stocks = d;
      if (!API.quote(state.selected)) state.selected = 'SBER';
      state.favorites = state.favorites.filter((t) => API.quote(t));
      const [view, param] = location.hash.slice(1).split('/');
      loadChart(view === 'stocks' && param && API.quote(param.toUpperCase()) ? param : state.selected);
      renderSectorFilter(); renderStocksTable(); renderLeaders(); renderPortfolio();
    });
    const pNews = Promise.all([API.getNews(), pStocks]).then(([d]) => { state.news = d; renderNews(); renderRelatedNews(); });
    const pBonds = API.getBonds().then((d) => { state.bonds = d; renderBondSummary(); renderBonds(); renderYieldCurve(); });
    const pDivs = Promise.all([API.getDividends(), pStocks]).then(([d]) => { state.dividends = d; renderDividends(); });

    await Promise.all([pIndices, pStocks]);
    renderOverview();
    API.subscribe(onTick);
    await Promise.all([pNews, pBonds, pDivs]);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
