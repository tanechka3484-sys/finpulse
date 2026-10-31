/**
 * FinPulse — UI-слой: роутинг вкладок, рендер разделов, поиск,
 * избранное/портфель и обновление котировок «в реальном времени».
 */
(() => {
  'use strict';
  const U = FP.U, API = FP.API;
  const { $, $$ } = U;

  const VIEWS = ['stocks', 'bonds', 'dividends', 'news', 'cycles', 'calc', 'portfolio'];
  const SECTORS = ['all', 'Финансы', 'Энергетика', 'IT', 'Ритейл'];
  const COUPON_FREQ = { 30: 'ежемес.', 91: 'ежекв.', 182: 'полугод.', 365: 'ежегод.' };
  const NEWS_TAGS = { stocks: 'Акции', bonds: 'Облигации', macro: 'Макро' };
  const DIV_STATUS = {
    approved: '<span class="tag tag-up">✓ Одобрено</span>',
    recommended: '<span class="tag tag-warn">◷ Рекомендовано</span>',
    declared: '<span class="tag tag-accent">◷ Объявлено</span>',
    paid: '<span class="tag tag-muted">✓ Выплачено</span>',
  };
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
    divMode: 'upcoming', divStatus: 'all',
    newsTag: 'all', newsImpact: 'all',
    favorites: U.store.get('favorites', ['SBER', 'LKOH', 'YDEX', 'X5']),
    positions: U.store.get('positions', { SBER: { qty: 300, avg: 281.4 }, LKOH: { qty: 5, avg: 7120 }, YDEX: { qty: 12, avg: 3890 } }),
  };
  let chart;
  let drawings;
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
      if (!i) continue;
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
    const fr = FP.FUNDAMENTALS.ratios(s.ticker, s.price);
    const divYield = fr.live && fr.divYield != null ? fr.divYield : s.divYield;
    const r = API.yearRange(s.ticker);
    const pos = Math.min(100, Math.max(0, (s.price - r.low) / (r.high - r.low) * 100));
    const cell = (label, value, sub) => `<div><div class="text-[11px] uppercase tracking-wide text-muted">${label}</div>
      <div class="mt-1 font-semibold num">${value}</div><div class="mt-1 text-xs text-muted num">${sub}</div></div>`;
    $('#chart-metrics').innerHTML = [
      cell('Объём', `<span data-q="${s.ticker}" data-f="volume">${U.compact(s.volume)}</span> шт.`, `оборот ${U.compact(turnover(s), '₽')}`),
      fr.live
        ? cell('P/E', fr.pe ? U.price(fr.pe, 1) : '—', `P/B ${fr.pb ? U.price(fr.pb, 2) : '—'} · ROE ${fr.roe != null ? U.pct(fr.roe, false) : '—'}`)
        : cell('P/E', s.pe ? U.price(s.pe, 1) : '—', `EPS ${U.price(s.eps)} ₽${API.status().mode === 'live' ? ' (справочно)' : ''}`),
      cell('Див. доходность', divYield ? `<span class="text-up">${U.pct(divYield, false)}</span>` : '—', divYield ? 'за 12 мес.' : 'не выплачивает'),
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
    if (!API.quote(ticker)?.price) return;
    state.selected = state.chartTicker = ticker;
    drawings.setKey(ticker);
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
    state.periodStart = bars.length ? bars[0].open : null;
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

  function renderRelatedNews() {
    const el = $('#related-news');
    if (!el) return;
    $('#related-ticker').textContent = state.selected;
    if (!state.news.length && state.newsLoaded) { el.innerHTML = '<p class="text-xs text-muted">Новостей нет.</p>'; return; }
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
  /** est — рейтинг угадан по названию эмитента (не данные рейтингового агентства): помечаем звёздочкой. */
  const ratingTag = (r, score, est) => `<span class="tag ${r === 'н/д' ? 'tag-muted' : score >= 9 ? 'tag-up' : score >= 5 ? 'tag-accent' : 'tag-warn'}" title="${r === 'н/д'
    ? 'Рейтинг не указан в источнике' : est ? 'Оценка по названию эмитента, а не рейтинг агентства. Проверяйте рейтинг выпуска на сайтах АКРА, Эксперт РА, НКР, НРА' : 'Государственная облигация'}">${r}${est ? '*' : ''}</span>`;

  /* ---------- Особенности выпуска (данные T-Invest API, если есть) ---------- */
  const BOND_FLAGS = [
    ['floating', 'Плавающий купон', 'warn', 'Купон пересчитывается вслед за ключевой ставкой или RUONIA'],
    ['amortization', 'Амортизация', 'accent', 'Номинал возвращается частями до погашения'],
    ['subordinated', 'Субординированная', 'down', 'При банкротстве погашается после обычных долгов'],
    ['perpetual', 'Бессрочная', 'down', 'Нет даты погашения, эмитент может не гасить выпуск'],
    ['qual', 'Только для квалов', 'muted', 'Купить могут только квалифицированные инвесторы'],
  ];
  /** Секторы T-Invest API → по-русски. */
  const T_SECTORS = {
    financial: 'Финансы', energy: 'Энергетика', utilities: 'Электроэнергетика', telecom: 'Телеком', it: 'IT',
    consumer: 'Потребительский сектор', materials: 'Сырьё и материалы', industrials: 'Промышленность', real_estate: 'Недвижимость',
    health_care: 'Здравоохранение', government: 'Государство', municipal: 'Регионы и муниципалитеты', other: 'Другое',
    ecomaterials: 'Экоматериалы', green_energy: 'Зелёная энергетика', green_buildings: 'Зелёное строительство', electrocars: 'Электромобили',
  };
  const RISK_LABEL = { low: ['Низкий риск', 'up'], moderate: ['Средний риск', 'warn'], high: ['Высокий риск', 'down'] };

  /** Почему у выпуска такой купон/доходность — разбор по фактам о выпуске. */
  function couponReasons(b) {
    const m = b.meta || {}, out = [];
    const floating = m.floating || b.kind === 'float';
    if (floating) out.push(`Купон <b>плавающий</b>: он привязан к ключевой ставке или RUONIA. Ставки сейчас высокие, поэтому и купон высокий; при снижении ставки ЦБ купон уменьшится. Доходность к погашению (YTM) для таких выпусков условна — её считают так, будто текущий купон сохранится до конца.`);
    if (b.price > 101 && b.coupon > b.ytm + 0.5) out.push(`Облигация стоит <b>дороже номинала</b> (${U.price(b.price)}%): покупатель переплачивает, поэтому реальная доходность к погашению — ${U.pct(b.ytm, false)}, ниже купона ${U.pct(b.coupon, false)}.`);
    if (!floating && m.placement && m.placement >= '2024-06-01' && b.coupon >= 17) out.push(`Выпуск размещён ${U.date(m.placement)} — в период высокой ключевой ставки (до 21% в конце 2024 года). Купон зафиксировали на уровне ставок того времени.`);
    if (m.subordinated) out.push('Выпуск <b>субординированный</b>: при банкротстве эмитента такие долги возвращают в последнюю очередь. За этот риск инвесторам платят надбавку к купону.');
    if (m.perpetual) out.push('Выпуск <b>бессрочный</b>: даты погашения нет, эмитент может не возвращать номинал. Это заметно рискованнее обычной облигации.');
    if (m.amortization) out.push('Выпуск <b>с амортизацией</b>: номинал возвращается частями, купон начисляется на остаток долга.');
    const ofz = state.bonds.filter((x) => x.type === 'ofz' && x.kind === 'fixed' && Math.abs(x.yearsToMaturity - b.yearsToMaturity) <= 1.5);
    if (b.type === 'corp' && !floating && ofz.length && b.currency === 'RUB') {
      const spread = b.ytm - ofz.reduce((a, x) => a + x.ytm, 0) / ofz.length;
      if (spread > 4) out.push(`Доходность на <b>${U.price(spread, 1)} п.п. выше ОФЗ</b> того же срока — рынок закладывает заметный кредитный риск эмитента${b.rating !== 'н/д' ? ', несмотря на высокую метку рейтинга' : ''}.`);
      else if (spread >= 0) out.push(`Доходность выше ОФЗ того же срока на ${U.price(spread, 1)} п.п. — обычная премия за риск корпоративного заёмщика.`);
    }
    if (m.risk === 'high') out.push('Т-Инвестиции относят выпуск к <b>высокому уровню риска</b>.');
    if (b.ratingEst) out.push('Метка рейтинга на сайте (со звёздочкой) — оценка по названию эмитента, а не рейтинг конкретного выпуска. Проверьте рейтинг на сайтах агентств: АКРА, Эксперт РА, НКР, НРА.');
    if (!b.meta && b.type === 'corp') out.push('Подробные признаки выпуска (флоатер, субординированность и др.) появятся, когда сервер загрузит данные Т-Инвестиций.');
    return out;
  }

  /** Описание эмитента из T-Invest API (подгружается при открытии карточки). */
  async function loadIssuer(b) {
    const el = $('#bond-issuer');
    if (!el) return;
    const assetUid = b.meta && b.meta.assetUid;
    if (!assetUid || location.protocol === 'file:') { el.innerHTML = '<p class="text-xs text-muted">Описание компании доступно, когда сайт работает на сервере с токеном Т-Инвестиций.</p>'; return; }
    el.innerHTML = '<span class="skeleton h-16 w-full block"></span>';
    try {
      const r = await fetch(`api/issuer?asset=${encodeURIComponent(assetUid)}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (!$('#bond-issuer') || $('#bond-issuer').dataset.isin !== b.isin) return;   // карточку уже закрыли/сменили
      const text = d.brand.description || d.description || d.brand.info || '';
      const meta = [d.brand.company || d.name, T_SECTORS[d.brand.sector] || d.brand.sector, d.brand.country].filter(Boolean).map((x) => U.escape(x)).join(' · ');
      el.innerHTML = `
        ${meta ? `<div class="text-sm font-medium">${meta}</div>` : ''}
        ${text ? `<p class="mt-1.5 text-sm text-muted leading-relaxed whitespace-pre-line line-clamp-6" id="issuer-text">${U.escape(text)}</p>
          ${text.length > 320 ? '<button type="button" class="mt-1 text-xs text-accent hover:underline" data-expand-issuer>Показать полностью</button>' : ''}`
        : '<p class="text-xs text-muted">Т-Инвестиции не приводят описание этой компании.</p>'}
        <p class="mt-2 text-[11px] text-muted">Источник: Т-Инвестиции.</p>`;
    } catch (e) {
      el.innerHTML = '<p class="text-xs text-muted">Не удалось загрузить описание компании.</p>';
    }
  }

  function renderBondSummary() {
    const b = state.bonds;
    const avg = (list) => list.reduce((a, x) => a + x.ytm, 0) / list.length;
    const ofz = b.filter((x) => x.type === 'ofz' && x.kind === 'fixed'), corpAll = b.filter((x) => x.type === 'corp' && x.currency === 'RUB');
    const aaa = corpAll.filter((x) => x.rating === 'AAA');
    const corpAAA = aaa.length ? aaa : corpAll;
    const corpLabel = aaa.length ? 'Ср. YTM корп. AAA' : 'Ср. YTM корп.';
    const max = [...b].filter((x) => x.currency === 'RUB').sort((x, y) => y.ytm - x.ytm)[0] || b[0];
    const spread = (avg(corpAAA) - avg(ofz)) * 100;
    const spreadText = Number.isFinite(spread) ? `${U.int(spread)} б.п.` : '—';
    $('#bond-summary').innerHTML = [
      statCard('Ср. YTM ОФЗ-ПД', U.pct(avg(ofz), false), `${ofz.length} ${U.plural(ofz.length, ['выпуск', 'выпуска', 'выпусков'])}`, 'landmark'),
      statCard(corpLabel, U.pct(avg(corpAAA), false), `${corpAAA.length} ${U.plural(corpAAA.length, ['выпуск', 'выпуска', 'выпусков'])}`, 'building-2'),
      statCard(aaa.length ? 'Спред AAA к ОФЗ' : 'Спред корп. к ОФЗ', spreadText, 'премия за кредитный риск', 'move-vertical'),
      statCard('Макс. доходность', `<span class="text-warn">${U.pct(max.ytm, false)}</span>`, `${U.escape(max.name)} · ${max.rating}`, 'alert-triangle'),
    ].join('');
    U.icons();
  }

  /** Кривая доходности — лёгкий SVG без библиотек. */
  function renderYieldCurve() {
    const W = 360, H = 230, P = { l: 34, r: 12, t: 14, b: 26 };
    // ОФЗ с постоянным купоном + 15 самых торгуемых рублёвых корпоративных выпусков
    const corp = state.bonds.filter((b) => b.type === 'corp' && b.currency === 'RUB').sort((a, b) => b.turnover - a.turnover).slice(0, 15);
    const pts = [...state.bonds.filter((b) => b.type === 'ofz' && b.kind === 'fixed'), ...corp].map((b) => ({ b, x: b.yearsToMaturity, y: b.ytm }));
    if (!pts.length) return;
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
    const m = b.meta || {};
    const features = [
      ...BOND_FLAGS.filter(([k]) => m[k] || (k === 'floating' && b.kind === 'float')).map(([, label, tone, hint]) => `<span class="tag tag-${tone}" title="${hint}">${label}</span>`),
      m.risk && RISK_LABEL[m.risk] ? `<span class="tag tag-${RISK_LABEL[m.risk][1]}" title="Оценка Т-Инвестиций">${RISK_LABEL[m.risk][0]}</span>` : '',
      m.placement ? `<span class="tag tag-muted">Размещён ${U.date(m.placement)}</span>` : '',
      m.call ? `<span class="tag tag-muted" title="Эмитент может погасить выпуск досрочно">Колл-опцион ${U.date(m.call)}</span>` : '',
    ].join('');
    const reasons = couponReasons(b);
    const item = (label, value) => `<div class="p-3 rounded-lg bg-bg/60 border border-line"><div class="text-[11px] text-muted uppercase tracking-wide">${label}</div><div class="mt-1 font-semibold num">${value}</div></div>`;
    $('#modal-body').innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="flex items-center gap-2"><h3 class="text-lg font-semibold">${U.escape(b.name)}</h3>${ratingTag(b.rating, b.ratingScore, b.ratingEst)}</div>
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
        ${item('Дюрация', b.duration ? `${U.price(b.duration)} г.` : '—')}
        ${item('Номинал', `${U.int(b.nominal)} ₽`)}
      </div>
      <p class="mt-4 text-xs text-muted">Купонный доход на 1 облигацию за год ≈ ${U.price(b.nominal * b.coupon / 100)} ₽ (до НДФЛ). Текущая доходность — ${U.pct(b.coupon / b.price * 100, false)}.</p>
      ${features ? `<div class="mt-4"><div class="text-[11px] text-muted uppercase tracking-wide">Особенности выпуска</div><div class="mt-1.5 flex flex-wrap gap-1.5">${features}</div></div>` : ''}
      ${reasons.length ? `<div class="mt-4 p-3 rounded-lg border border-warn/40 bg-warn/5">
        <div class="text-sm font-semibold">Почему купон ${U.pct(b.coupon, false)}, а доходность ${U.pct(b.ytm, false)}</div>
        <ul class="mt-1.5 space-y-1.5 text-sm text-muted list-disc pl-4">${reasons.map((x) => `<li>${x}</li>`).join('')}</ul>
      </div>` : ''}
      ${b.type === 'corp' ? `<div class="mt-4"><div class="text-[11px] text-muted uppercase tracking-wide">Об эмитенте</div><div id="bond-issuer" data-isin="${b.isin}" class="mt-1.5"></div></div>` : ''}`;
    $('#modal').classList.remove('hidden');
    $('#modal').scrollTop = 0;   // окно прокручивается — каждую карточку открываем с начала
    U.icons();
    if (b.type === 'corp') loadIssuer(b);
  }
  const closeModal = () => $('#modal').classList.add('hidden');

  /* =====================================================================
     Раздел «Дивиденды»
     ===================================================================== */
  function enrichDividends() {
    const list = state.divSource === 'tinvest' ? state.dividends : state.dividends.concat(state.divExtra || []);
    return list.filter((d) => { const s = API.quote(d.ticker); return s && s.price; }).map((d) => {
      const s = API.quote(d.ticker);
      return { ...d, stock: s, yield: d.amount / s.price * 100, days: U.daysUntil(d.exDate), buyBy: d.lastBuyDate || U.prevBusinessDay(d.exDate) };
    });
  }

  function renderDividends() {
    const all = enrichDividends();
    const upcoming = all.filter((d) => d.days >= 0).sort((a, b) => a.days - b.days);

    // Сводка
    const next = upcoming[0];
    const best = [...upcoming].sort((a, b) => b.yield - a.yield)[0];
    const in30 = upcoming.filter((d) => d.days <= 30).length;
    const approved = upcoming.filter((d) => d.status === 'approved' || d.status === 'declared').length;
    $('#div-summary').innerHTML = [
      next ? statCard('Ближайшая отсечка', `${next.ticker} · ${U.date(next.exDate, { day: 'numeric', month: 'short' })}`, `купить до ${U.date(next.buyBy, { day: 'numeric', month: 'short' })} · через ${next.days} ${U.plural(next.days, ['день', 'дня', 'дней'])}`, 'calendar-clock') : statCard('Ближайшая отсечка', '—', ''),
      best ? statCard('Макс. доходность', `<span class="text-up">${U.pct(best.yield, false)}</span>`, `${best.ticker} · ${U.price(best.amount)} ₽ на акцию`, 'percent') : '',
      statCard('Отсечек за 30 дней', in30, `всего предстоящих: ${upcoming.length}`, 'calendar-range'),
      API.status().mode === 'live'
        ? statCard('Выплат за 12 мес.', all.filter((d) => d.days < 0 && d.days >= -365).length, state.divSource === 'tinvest' ? 'по данным Т-Инвестиций' : 'по данным MOEX', 'badge-check')
        : statCard('Одобрено / рекоменд.', `<span class="text-up">${approved}</span> / <span class="text-warn">${upcoming.length - approved}</span>`, 'по предстоящим выплатам', 'badge-check'),
    ].join('');

    // Таблица
    let rows = state.divMode === 'upcoming' ? upcoming : state.divMode === 'past'
      ? all.filter((d) => d.days < 0).sort((a, b) => b.days - a.days)
      : [...all].sort((a, b) => a.exDate.localeCompare(b.exDate));
    if (state.divStatus !== 'all') rows = rows.filter((d) => d.status === state.divStatus);

    // Предстоящих выплат нет (MOEX вносит выплату только после решения собрания) — показываем последние
    let notice = '';
    if (state.divMode === 'upcoming' && !rows.length && all.length) {
      rows = all.filter((d) => d.days < 0 && d.days >= -365).sort((a, b) => b.days - a.days);
      notice = `<tr><td colspan="7" class="!text-left !whitespace-normal text-sm text-muted !py-3">${state.divSource === 'tinvest'
        ? 'Объявленных предстоящих выплат сейчас нет.'
        : 'Объявленных предстоящих выплат сейчас нет: Мосбиржа вносит дивиденд в базу после решения собрания акционеров.'} Ниже — выплаты за последние 12 месяцев.</td></tr>`;
    }

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
          <td class="!text-left hidden md:table-cell text-muted">${U.escape(d.period || '—')}</td>
          <td class="${past ? '' : 'font-semibold'}">${U.date(d.buyBy, { day: 'numeric', month: 'short' })}</td>
          <td><div>${U.date(d.exDate)}</div><div class="text-xs text-muted">${when}</div></td>
          <td class="font-semibold">${U.price(d.amount)} ${d.currency && d.currency !== 'RUB' ? U.escape(d.currency) : '₽'}</td>
          <td><span class="tag ${d.yield >= 10 ? 'tag-up' : 'tag-accent'} num">${U.pct(d.yield, false)}</span></td>
          <td class="hidden sm:table-cell">${DIV_STATUS[d.status] || ''}</td>
        </tr>`);
    }
    $('#div-table tbody').innerHTML = notice + html.join('') || emptyRow(7, 'Нет событий по выбранным фильтрам');
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
          <h3 class="font-semibold leading-snug">${n.link ? `<a href="${U.escape(n.link)}" target="_blank" rel="noopener" class="hover:text-accent transition">${U.escape(n.title)}</a>` : U.escape(n.title)}</h3>
          ${n.summary ? `<p class="text-sm text-muted line-clamp-3">${U.escape(n.summary)}</p>` : ''}
          <div class="mt-auto pt-1 flex flex-wrap items-center gap-1.5">
            <span class="tag ${imp.cls}" ${n.autoImpact ? 'title="Автоматическая оценка по заголовку"' : ''}>${imp.icon} ${imp.label}${n.autoImpact ? '*' : ''}</span>
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

  /** Вкладка «Циклы» (js/cycles.js) — рисуется, когда есть котировки; облигации добавляются по мере загрузки. */
  function renderCycles() {
    if (state.stocks.length) FP.Cycles.render({ stocks: state.stocks, bonds: state.bonds, API });
  }

  /* =====================================================================
     T-Invest API через сервер сайта (Railway): мультипликаторы и дивиденды.
     Без сервера или токена ничего не меняется — остаются данные MOEX.
     ===================================================================== */
  const REGULARITY = { Annual: 'годовой', 'Semi-Anl': 'полугодовой', Quarterly: 'квартальный', Monthly: 'ежемесячный' };

  async function loadTInvest() {
    await pStocksReady;
    for (let attempt = 0; attempt < 12; attempt++) {
      const res = await FP.FUNDAMENTALS.loadLive();
      if (res === 'off') break;
      if (res === 'ok') {
        FP.Screener.rerenderStocks();
        if (state.chartTicker) renderMetrics();
        renderDataSource();
        break;
      }
      await new Promise((r) => setTimeout(r, 20000));   // сервер ещё загружает данные
    }
    if (location.protocol === 'file:') return;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const r = await fetch('api/dividends', { cache: 'no-cache' });
        if (r.ok) {
          const j = await r.json();
          state.dividends = (j.items || []).map((d) => ({
            ...d, id: `${d.ticker}-${d.exDate}-${d.amount}`, period: REGULARITY[d.regularity] || '',
            status: U.daysUntil(d.exDate) >= 0 ? 'declared' : 'paid',
          }));
          state.divSource = 'tinvest';
          state.dividendsLoaded = true;
          renderDividends();
          return;
        }
        const j = await r.json().catch(() => ({}));
        if (r.status !== 503 || j.error !== 'loading') return;
      } catch { return; }
      await new Promise((r) => setTimeout(r, 20000));
    }
  }
  let pStocksReady;

  /** Признаки облигаций (флоатер, амортизация, риск...) с сервера — дополняют список выпусков. */
  async function loadBondsMeta(pBonds) {
    if (location.protocol === 'file:') return;
    await pBonds;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const r = await fetch('api/bonds-meta', { cache: 'no-cache' });
        if (r.ok) {
          const { items } = await r.json();
          let n = 0;
          state.bonds.forEach((b) => {
            const m = items[b.isin];
            if (!m) return;
            b.meta = m; n++;
            if (m.floating && b.type === 'corp') b.kind = 'float';
          });
          if (n) { FP.Screener.setBonds(state.bonds); renderYieldCurve(); }
          return;
        }
        const j = await r.json().catch(() => ({}));
        if (r.status !== 503 || j.error !== 'loading') return;
      } catch { return; }
      await new Promise((res) => setTimeout(res, 20000));
    }
  }

  /* =====================================================================
     Индикатор источника данных
     ===================================================================== */
  function renderDataSource() {
    const st = API.status();
    const el = $('#data-source');
    const live = st.mode === 'live';
    const time = st.updatedAt ? new Date(st.updatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    el.className = `hidden sm:flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border shrink-0 ${live ? 'border-up/40 text-up' : 'border-warn/40 text-warn'}`;
    el.title = live
      ? 'Котировки MOEX ISS (бесплатный доступ — задержка ~15 мин), курсы ЦБ РФ, CoinGecko, новости MOEX и РБК'
      : 'Живые источники недоступны в этом окружении — показаны сгенерированные данные';
    el.innerHTML = live ? `<span class="status-dot open"></span>MOEX · ${time}` : '<span class="status-dot evening"></span>Демо-данные';
    $('#footer-source').textContent = live
      ? `Данные: MOEX ISS (задержка ~15 мин), ЦБ РФ, CoinGecko, РБК${FP.FUNDAMENTALS.live ? ', мультипликаторы и дивиденды — T-Invest API' : '. EPS и сектор — справочно'}. Оценка влияния новостей (*) — автоматическая.`
      : 'Демонстрационные данные: живые источники недоступны в этом окружении.';
    $('#div-status').hidden = live;
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
    if (view === 'cycles') renderCycles();
  }

  function route() {
    const [rawView, param] = location.hash.slice(1).split('/');
    const view = VIEWS.includes(rawView) ? rawView : 'stocks';
    setView(view);
    if (view === 'stocks' && param && state.stocks.length && param.toUpperCase() !== state.chartTicker) loadChart(param);
    if (view === 'calc') FP.Calculators.render(param);
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

      if (t.closest('[data-expand-issuer]')) { $('#issuer-text').classList.remove('line-clamp-6'); t.closest('[data-expand-issuer]').remove(); return; }
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
        FP.Screener.showSector(jump.dataset.sectorJump);
        $('#stock-screener').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      drawings.redraw();
    });

    window.addEventListener('hashchange', route);
  }

  /* =====================================================================
     Реалтайм
     ===================================================================== */
  function onTick({ stocks, indices, rebuildTape }) {
    if (rebuildTape) renderTape(); else updateTape(indices);
    renderDataSource();
    updateQuoteCells(stocks);
    if (!state.chartLoading && stocks.some((c) => c.ticker === state.chartTicker)) {
      const { bars } = API.peekHistory(state.chartTicker, state.interval);
      if (bars.length) chart.updateLast(bars[bars.length - 1]);
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
    drawings = new FP.ChartDrawings(chart, $('#chart-wrap'), $('#draw-toolbar'));
    chart.setType(state.chartType);
    setSeg($('#interval-switch'), 'interval', state.interval);
    setSeg($('#type-switch'), 'type', state.chartType);
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

    const ui = { starBtn, instrument, qPrice, qPct, ratingTag, couponFreq: COUPON_FREQ, selected: () => state.selected };
    FP.Screener.initStocks($('#stock-screener'), ui);
    FP.Screener.initBonds($('#bond-screener'), ui);
    FP.Calculators.init($('#calc-root'), { getBonds: () => state.bonds });

    bindEvents();
    initSearch();
    renderMarketStatus();
    setInterval(renderMarketStatus, 15000);
    route();

    API.ready.then(renderDataSource);

    // Каждый блок отрисовывается, как только «пришли» его данные
    const failed = (sel, what) => (e) => {
      console.error('[FinPulse]', what, e);
      const el = $(sel);
      const msg = `<div class="text-sm text-muted py-8 text-center">Не удалось загрузить ${what}. Обновите страницу позже.</div>`;
      if (el.tagName === 'TBODY') el.innerHTML = `<tr><td colspan="12">${msg}</td></tr>`; else el.innerHTML = msg;
    };
    const has = (t) => API.quote(t)?.price;

    const pIndices = API.getIndices().then((d) => { state.indices = d; renderTape(); }).catch(failed('#ticker-tape', 'котировки индексов'));
    const pStocks = API.getStocks().then((d) => {
      state.stocks = d;
      if (!has(state.selected)) state.selected = d[0].ticker;
      state.favorites = state.favorites.filter(has);
      const [view, param] = location.hash.slice(1).split('/');
      loadChart(view === 'stocks' && param && has(param.toUpperCase()) ? param : state.selected);
      FP.Screener.setStocks(d); renderLeaders(); renderPortfolio();
      // Полный рынок для скринера догружается отдельно; пока показываем основные бумаги
      API.getUniverse().then((all) => {
        if (!all.length) return;
        FP.Screener.setStocks(all);
        // Дивиденды по 100 крупнейшим российским бумагам — для календаря и доходности в скринере
        const top = all.filter((s) => s.country === 'RU' && s.marketCap).sort((a, b) => b.marketCap - a.marketCap).slice(0, 100).map((s) => s.ticker);
        return API.getMoreDividends(top).then((extra) => {
          if (!extra.length || state.divSource === 'tinvest') return;
          state.divExtra = extra;
          if (state.dividendsLoaded) renderDividends();
          FP.Screener.refreshStocks();
        });
      }).catch((e) => console.warn('[FinPulse] Универсум скринера недоступен:', e));
    });
    pStocksReady = pStocks;
    loadTInvest().catch((e) => console.warn('[FinPulse] T-Invest:', e));
    const pNews = Promise.all([API.getNews(), pStocks]).then(([d]) => { state.news = d; state.newsLoaded = true; renderNews(); renderRelatedNews(); }).catch(failed('#news-grid', 'новости'));
    const pBonds = API.getBonds().then((d) => {
      if (!d.length) throw new Error('пустой список облигаций');
      state.bonds = d; renderBondSummary(); FP.Screener.setBonds(d); renderYieldCurve();
      if (state.view === 'cycles') renderCycles();
    }).catch((e) => { failed('#bonds-table tbody', 'облигации')(e); $('#bond-summary').innerHTML = ''; $('#yield-curve').innerHTML = ''; });
    loadBondsMeta(pBonds).catch((e) => console.warn('[FinPulse] bonds meta:', e));
    const pDivs = Promise.all([API.getDividends(), pStocks]).then(([d]) => {
      if (state.divSource !== 'tinvest') state.dividends = d;
      state.dividendsLoaded = true; renderDividends();
    }).catch(failed('#div-table tbody', 'дивиденды'));

    await Promise.all([pIndices, pStocks.catch(failed('#stocks-table tbody', 'котировки акций'))]);
    renderOverview();
    if (state.view === 'cycles') renderCycles();
    API.subscribe(onTick);
    await Promise.all([pNews, pBonds, pDivs]);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
