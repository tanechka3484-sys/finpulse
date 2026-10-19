/**
 * FinPulse — вкладка «Экономические циклы».
 *
 * Фаза определяется по модели «инвестиционных часов» (Merrill Lynch Investment Clock):
 * две оси — динамика роста экономики и динамика инфляции — дают четыре фазы:
 *   Спад (рост ↓, инфляция ↓) → Восстановление (↑, ↓) → Перегрев (↑, ↑) → Стагфляция (↓, ↑).
 *
 * Положение на часах считается по рыночным сигналам из уже загруженных данных
 * (тренд IMOEX, ширина рынка, наклон кривой ОФЗ, циклические vs защитные сектора,
 * нефтегаз vs рынок) и по макро-оценке пользователя (ВВП и инфляция по данным
 * Росстата и ЦБ). Модель упрощённая и носит справочный характер.
 */
window.FP = window.FP || {};

FP.Cycles = (() => {
  'use strict';
  const U = FP.U;
  const { $, $$ } = U;

  /* ---------------- Фазы и их «плейбук» ---------------- */
  const PHASES = {
    reflation: {
      name: 'Спад', alias: 'рефляция', g: -1, i: -1, color: 'accent',
      about: 'Экономика замедляется, инфляция снижается. Центробанк смягчает политику и снижает ставку.',
      best: 'Длинные облигации с фиксированным купоном: при снижении ставок их цена растёт сильнее всего.',
      stocks: 'Защитные компании со стабильным спросом и дивидендами.',
      bonds: 'Длинные ОФЗ-ПД, высокая дюрация.',
      worst: 'Сырьё и циклические акции.',
      sectors: ['Ритейл'], assets: { 'Облигации': 3, 'Акции': 1, 'Сырьё': -2, 'Кэш': 0 },
    },
    recovery: {
      name: 'Восстановление', alias: 'ранний цикл', g: 1, i: -1, color: 'up',
      about: 'Рост ускоряется, инфляция ещё низкая, ставки остаются низкими. Прибыли компаний быстро восстанавливаются.',
      best: 'Акции, особенно циклические: банки, технологии.',
      stocks: 'Финансы и IT, бумаги с высокой бетой.',
      bonds: 'Корпоративные облигации, средняя дюрация.',
      worst: 'Кэш и депозиты.',
      sectors: ['Финансы', 'IT'], assets: { 'Облигации': 1, 'Акции': 3, 'Сырьё': 0, 'Кэш': -2 },
    },
    overheat: {
      name: 'Перегрев', alias: 'поздний цикл', g: 1, i: 1, color: 'warn',
      about: 'Экономика работает на пределе мощностей, инфляция растёт, центробанк повышает ставку.',
      best: 'Сырьё и сырьевые компании: нефтегаз, металлы.',
      stocks: 'Энергетика и экспортёры.',
      bonds: 'Короткие облигации и флоатеры; длинные ОФЗ дешевеют.',
      worst: 'Длинные облигации.',
      sectors: ['Энергетика'], assets: { 'Облигации': -2, 'Акции': 1, 'Сырьё': 3, 'Кэш': 0 },
    },
    stagflation: {
      name: 'Стагфляция', alias: 'жёсткая политика', g: -1, i: 1, color: 'down',
      about: 'Рост замедляется, а инфляция остаётся высокой. Ставки высокие, прибыли компаний под давлением.',
      best: 'Кэш, депозиты и денежный рынок: высокая ставка при низком риске.',
      stocks: 'Защитные компании с дивидендами, минимальная доля акций роста.',
      bonds: 'Флоатеры и короткие ОФЗ.',
      worst: 'Акции роста и длинные облигации.',
      sectors: ['Ритейл'], assets: { 'Облигации': -1, 'Акции': -2, 'Сырьё': 1, 'Кэш': 3 },
    },
  };
  const ORDER = ['reflation', 'recovery', 'overheat', 'stagflation'];
  // Полные имена классов — чтобы Tailwind CDN гарантированно их сгенерировал
  const TEXT = { accent: 'text-accent', up: 'text-up', warn: 'text-warn', down: 'text-down' };
  const TAG = { accent: 'tag-accent', up: 'tag-up', warn: 'tag-warn', down: 'tag-down' };
  const phaseOf = (g, i) => (g >= 0 ? (i >= 0 ? 'overheat' : 'recovery') : (i >= 0 ? 'stagflation' : 'reflation'));

  /** Циклы экономики России — качественная справка. */
  const HISTORY = [
    { years: '1998', phase: 'stagflation', text: 'Дефолт по ГКО и девальвация рубля: резкий спад и всплеск инфляции.' },
    { years: '1999–2008', phase: 'recovery', text: 'Долгий подъём на фоне роста цен на нефть и притока капитала.' },
    { years: '2008–2009', phase: 'reflation', text: 'Мировой финансовый кризис: глубокий спад ВВП, падение рынка акций.' },
    { years: '2010–2013', phase: 'recovery', text: 'Восстановление, к 2013 году — постепенное замедление роста.' },
    { years: '2014–2016', phase: 'stagflation', text: 'Падение нефти и санкции: девальвация, рост инфляции и рецессия.' },
    { years: '2017–2019', phase: 'recovery', text: 'Инфляция у цели, ЦБ снижает ставку, умеренный рост экономики.' },
    { years: '2020', phase: 'reflation', text: 'Пандемия: спад и резкое смягчение денежно-кредитной политики.' },
    { years: '2021', phase: 'overheat', text: 'Быстрое восстановление и ускорение инфляции; ЦБ начинает повышать ставку.' },
    { years: '2022', phase: 'stagflation', text: 'Санкционный шок: экстренное повышение ставки, затем её быстрое снижение.' },
    { years: '2023–2024', phase: 'overheat', text: 'Рост на госрасходах, дефицит кадров, высокая инфляция; ставка поднята до 21%.' },
    { years: '2025', phase: 'stagflation', text: 'Охлаждение экономики при всё ещё высокой инфляции; ЦБ начинает снижать ставку.' },
  ];

  /* ---------------- Расчёты ---------------- */
  const sma = (arr, n) => { const s = arr.slice(-n); return s.reduce((a, b) => a + b, 0) / s.length; };
  const ret = (arr, n) => {
    if (arr.length <= n) return null;
    const r = arr[arr.length - 1] / arr[arr.length - 1 - n] - 1;
    return Number.isFinite(r) ? r : null;
  };
  const avg = (xs) => { const v = xs.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

  let indexCloses = null;   // кэш дневных закрытий IMOEX
  let indexLoad = null;
  let selectedPhase = null;
  let macro = U.store.get('cycleMacro', { growth: 0, infl: 0 });
  let ctx = null;

  function computeSignals({ stocks, bonds, API }) {
    const out = [];
    const sig = (s) => out.push(s);
    const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'neu');

    // 1. Тренд IMOEX: цена против 200-дневной средней
    if (indexCloses && indexCloses.length >= 64) {
      const n = Math.min(200, indexCloses.length);
      const last = indexCloses[indexCloses.length - 1], ma = sma(indexCloses, n);
      const d = (last / ma - 1) * 100;
      const g = d > 2 ? 1 : d < -2 ? -1 : 0;
      sig({ id: 'trend', title: 'Тренд IMOEX', value: `${U.pct(d)} к SMA${n}`, g, i: 0, w: 1, tone: tone(g),
        detail: g > 0 ? 'Рынок выше долгосрочной средней — ожидания роста.' : g < 0 ? 'Рынок ниже долгосрочной средней — ожидания замедления.' : 'Рынок около долгосрочной средней.' });
    }

    // 2. Ширина рынка: доля бумаг выше своей SMA200
    const above = stocks.map((s) => { const c = API.sparkline(s.ticker, 200); return c.length >= 60 ? s.price > sma(c, c.length) : null; }).filter((x) => x != null);
    if (above.length) {
      const share = above.filter(Boolean).length / above.length * 100;
      const g = share >= 60 ? 1 : share <= 40 ? -1 : 0;
      sig({ id: 'breadth', title: 'Ширина рынка', value: `${U.int(share)}% бумаг выше SMA200`, g, i: 0, w: 0.75, tone: tone(g),
        detail: g > 0 ? 'Рост широкий, а не за счёт пары бумаг.' : g < 0 ? 'Большинство бумаг в нисходящем тренде.' : 'Рынок разделён примерно поровну.' });
    }

    // 3. Наклон кривой ОФЗ: длинные (≥10 лет) минус короткие (≤3 лет)
    const ofz = bonds.filter((b) => b.type === 'ofz' && (b.kind || 'fixed') === 'fixed');
    const short = avg(ofz.filter((b) => b.yearsToMaturity <= 3).map((b) => b.ytm));
    const long = avg(ofz.filter((b) => b.yearsToMaturity >= 10).map((b) => b.ytm));
    if (short != null && long != null) {
      const slope = long - short;
      const g = slope > 0.5 ? 1 : slope < -0.5 ? -1 : 0, i = slope < -0.5 ? 1 : 0;
      sig({ id: 'curve', title: 'Кривая ОФЗ', value: `${slope >= 0 ? '+' : '−'}${U.int(Math.abs(slope) * 100)} б.п. (10л − 3л)`, g, i, w: 1, tone: tone(g),
        detail: slope < -0.5 ? 'Кривая инвертирована: жёсткая политика ЦБ против инфляции, риск замедления.' : slope > 0.5 ? 'Нормальная кривая: рынок не ждёт спада.' : 'Плоская кривая — переходный период.' });
    }

    // 4. Циклические (финансы, энергетика) против защитных (ритейл) за 3 месяца
    const sectorRet = (sec) => avg(stocks.filter((s) => s.sector === sec).map((s) => ret(API.sparkline(s.ticker, 64), 63)));
    const cyc = avg([sectorRet('Финансы'), sectorRet('Энергетика')]), def = sectorRet('Ритейл');
    if (cyc != null && def != null) {
      const d = (cyc - def) * 100;
      const g = d > 3 ? 1 : d < -3 ? -1 : 0;
      sig({ id: 'rotation', title: 'Циклические vs защитные', value: `${U.pct(d)} за 3 мес.`, g, i: 0, w: 0.75, tone: tone(g),
        detail: 'Финансы и энергетика против ритейла. Опережение циклических — признак ускорения роста.' });
    }

    // 5. Нефтегаз против рынка за 3 месяца — косвенный инфляционный сигнал
    const energy = sectorRet('Энергетика'), mkt = indexCloses && indexCloses.length >= 64 ? ret(indexCloses, 63) : null;
    if (energy != null && mkt != null) {
      const d = (energy - mkt) * 100;
      const i = d > 3 ? 1 : d < -3 ? -1 : 0;
      sig({ id: 'commod', title: 'Нефтегаз vs IMOEX', value: `${U.pct(d)} за 3 мес.`, g: 0, i, w: 0.75, tone: i > 0 ? 'neg' : i < 0 ? 'pos' : 'neu',
        detail: 'Опережение сырьевых бумаг обычно сопровождает рост инфляционного давления.' });
    }

    // 6–7. Макро-оценка пользователя
    if (macro.growth) out.push({ id: 'm-growth', g: macro.growth, i: 0, w: 3, macro: true });
    if (macro.infl) out.push({ id: 'm-infl', g: 0, i: macro.infl, w: 3, macro: true });
    return out;
  }

  /** На какие оси влияет каждый сигнал (g — рост, i — инфляция). */
  const AXES = { trend: 'g', breadth: 'g', curve: 'gi', rotation: 'g', commod: 'i', 'm-growth': 'g', 'm-infl': 'i' };

  /** Сводная точка на часах: средневзвешенное по сигналам каждой оси, g, i ∈ [-1, 1]. */
  function position(signals) {
    const axis = (k) => {
      const used = signals.filter((s) => AXES[s.id].includes(k));
      const wsum = used.reduce((a, s) => a + s.w, 0);
      return wsum ? used.reduce((a, s) => a + s[k] * s.w, 0) / wsum : 0;
    };
    return { g: axis('g'), i: axis('i') };
  }

  /* ---------------- Отрисовка ---------------- */
  function clockSvg(pos, current) {
    const S = 300, C = S / 2, R = 128;
    const fill = (k) => `rgb(var(--c-${PHASES[k].color}) / ${k === current ? 0.22 : 0.07})`;
    // Квадранты: x — рост (вправо ↑), y — инфляция (вверх ↑)
    const quads = { overheat: [0, -90], stagflation: [-90, -180], reflation: [180, 90], recovery: [90, 0] };
    const arc = (a0, a1) => {
      const p = (a) => [C + R * Math.cos(a * Math.PI / 180), C + R * Math.sin(a * Math.PI / 180)];
      const [x0, y0] = p(a0), [x1, y1] = p(a1);
      return `M${C},${C} L${x0.toFixed(1)},${y0.toFixed(1)} A${R},${R} 0 0,0 ${x1.toFixed(1)},${y1.toFixed(1)} Z`;
    };
    const label = (k, x, y) => `<text x="${x}" y="${y}" text-anchor="middle" font-size="12" font-weight="600" fill="rgb(var(--c-${k === current ? PHASES[k].color : 'muted'}))">${PHASES[k].name}</text>`;
    const px = C + pos.g * R * 0.82, py = C - pos.i * R * 0.82;
    return `
      <svg viewBox="-28 -12 ${S + 56} ${S + 24}" class="w-full max-w-[340px] mx-auto h-auto" role="img" aria-label="Инвестиционные часы, текущая фаза: ${PHASES[current].name}">
        ${Object.entries(quads).map(([k, [a0, a1]]) => `<path d="${arc(a0, a1)}" fill="${fill(k)}" stroke="rgb(var(--c-line))" class="cursor-pointer" data-phase="${k}"><title>${PHASES[k].name}</title></path>`).join('')}
        <circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="rgb(var(--c-line))"/>
        <line x1="${C - R - 8}" y1="${C}" x2="${C + R + 8}" y2="${C}" stroke="rgb(var(--c-muted) / .5)" stroke-dasharray="3 3"/>
        <line x1="${C}" y1="${C - R - 8}" x2="${C}" y2="${C + R + 8}" stroke="rgb(var(--c-muted) / .5)" stroke-dasharray="3 3"/>
        <text x="${C + R + 10}" y="${C - 6}" font-size="10" text-anchor="end" fill="rgb(var(--c-muted))">рост ↑</text>
        <text x="${C - R - 10}" y="${C - 6}" font-size="10" fill="rgb(var(--c-muted))">рост ↓</text>
        <text x="${C + 6}" y="${C - R - 2}" font-size="10" fill="rgb(var(--c-muted))">инфляция ↑</text>
        <text x="${C + 6}" y="${C + R + 10}" font-size="10" fill="rgb(var(--c-muted))">инфляция ↓</text>
        ${label('overheat', C + R * 0.5, C - R * 0.5)}${label('stagflation', C - R * 0.5, C - R * 0.5)}
        ${label('reflation', C - R * 0.5, C + R * 0.5 + 8)}${label('recovery', C + R * 0.5, C + R * 0.5 + 8)}
        <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="14" fill="rgb(var(--c-${PHASES[current].color}) / .25)" class="cycle-pulse"/>
        <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="7" fill="rgb(var(--c-${PHASES[current].color}))" stroke="rgb(var(--c-surface))" stroke-width="2.5"/>
      </svg>`;
  }

  const assetBar = (score) => {
    const cls = score > 0 ? 'bg-up' : score < 0 ? 'bg-down' : 'bg-muted';
    return `<span class="relative h-1.5 bg-elevated rounded-full block"><span class="absolute top-0 h-full rounded-full ${cls} ${score >= 0 ? 'left-1/2' : 'right-1/2'}" style="width:${Math.max(4, Math.abs(score) / 3 * 50)}%"></span></span>`;
  };

  function phaseDetail(key, current, stocks, API) {
    const p = PHASES[key];
    const tickers = stocks.filter((s) => p.sectors.includes(s.sector))
      .map((s) => ({ s, r: ret(API.sparkline(s.ticker, 64), 63) }))
      .sort((a, b) => (b.r ?? -1) - (a.r ?? -1));
    return `
      <div class="flex flex-wrap items-center gap-2">
        <span class="tag ${TAG[p.color]}">${key === current ? 'Ближайшая фаза по модели' : 'Фаза цикла'}</span>
        <span class="text-xs text-muted">${p.alias}</span>
      </div>
      <h3 class="mt-2 text-2xl font-semibold">${p.name}</h3>
      <p class="mt-2 text-sm text-muted leading-relaxed max-w-prose">${p.about}</p>
      <dl class="mt-4 grid gap-3 sm:grid-cols-2 text-sm">
        <div><dt class="text-[11px] uppercase tracking-wide text-muted">Лучше всего</dt><dd class="mt-1">${p.best}</dd></div>
        <div><dt class="text-[11px] uppercase tracking-wide text-muted">Хуже всего</dt><dd class="mt-1">${p.worst}</dd></div>
        <div><dt class="text-[11px] uppercase tracking-wide text-muted">Акции</dt><dd class="mt-1">${p.stocks}</dd></div>
        <div><dt class="text-[11px] uppercase tracking-wide text-muted">Облигации</dt><dd class="mt-1">${p.bonds}</dd></div>
      </dl>
      <div class="mt-4">
        <div class="text-[11px] uppercase tracking-wide text-muted">Классы активов</div>
        <div class="mt-2 grid gap-2">${Object.entries(p.assets).map(([a, v]) => `
          <div class="grid grid-cols-[90px_1fr_74px] items-center gap-3 text-xs"><span>${a}</span>${assetBar(v)}<span class="text-right ${v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-muted'}">${v > 1 ? 'лидер' : v > 0 ? 'выше рынка' : v < -1 ? 'аутсайдер' : v < 0 ? 'ниже рынка' : 'нейтрально'}</span></div>`).join('')}
        </div>
      </div>
      ${tickers.length ? `<div class="mt-4">
        <div class="text-[11px] uppercase tracking-wide text-muted">Бумаги из секторов фазы · ${p.sectors.join(', ')} · доходность за 3 мес.</div>
        <div class="mt-2 flex flex-wrap gap-1.5">${tickers.map(({ s, r }) => `<button class="tag tag-accent hover:brightness-125" data-ticker="${s.ticker}">$${s.ticker} ${r != null ? `<span class="${U.trend(r)}">${U.pct(r * 100)}</span>` : ''}</button>`).join('')}</div>
      </div>` : ''}`;
  }

  function signalCard(s) {
    const cls = s.tone === 'pos' ? 'text-up' : s.tone === 'neg' ? 'text-down' : 'text-muted';
    const icon = s.tone === 'pos' ? '▲' : s.tone === 'neg' ? '▼' : '●';
    const axes = [s.g ? `рост ${s.g > 0 ? '↑' : '↓'}` : '', s.i ? `инфляция ${s.i > 0 ? '↑' : '↓'}` : ''].filter(Boolean).join(', ') || 'нейтрально';
    return `
      <div class="card stat-card">
        <div class="flex items-center justify-between gap-2 text-xs text-muted"><span>${s.title}</span><span class="${cls}">${icon}</span></div>
        <div class="mt-2 font-semibold num">${s.value}</div>
        <div class="mt-1 text-xs text-muted leading-snug">${s.detail}</div>
        <div class="mt-2 text-[11px] ${cls}">Сигнал: ${axes}</div>
      </div>`;
  }

  function macroCard() {
    const seg = (key, opts) => `<div class="seg" data-macro="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${macro[key] === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
    return `
      <div class="card sm:col-span-2 xl:col-span-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="card-title"><i data-lucide="sliders-horizontal" class="w-4 h-4 text-accent"></i>Макро-оценка</h3>
            <p class="mt-1 text-xs text-muted max-w-prose">Открытых API с макростатистикой России без ключей нет, поэтому укажите направление сами по свежим данным
              <a class="text-accent hover:underline" href="https://rosstat.gov.ru/" target="_blank" rel="noopener">Росстата</a> и
              <a class="text-accent hover:underline" href="https://www.cbr.ru/key-indicators/" target="_blank" rel="noopener">Банка России</a>.
              У этой оценки самый большой вес в модели: она весит почти столько же, сколько все рыночные сигналы вместе. Выбор сохраняется в браузере.</p>
          </div>
        </div>
        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <div><div class="text-xs text-muted mb-1.5">Рост ВВП</div>${seg('growth', [[1, 'Ускоряется'], [0, 'Не задано'], [-1, 'Замедляется']])}</div>
          <div><div class="text-xs text-muted mb-1.5">Инфляция</div>${seg('infl', [[1, 'Растёт'], [0, 'Не задано'], [-1, 'Снижается']])}</div>
        </div>
      </div>`;
  }

  function render(next) {
    if (next) ctx = next;
    const root = $('#cycles-root');
    if (!root || !ctx || !ctx.stocks.length) return;

    // Индекс грузим один раз, затем перерисовываем
    if (!indexCloses && !indexLoad) {
      indexLoad = ctx.API.getIndexHistory('IMOEX')
        .then((bars) => { indexCloses = bars.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0); })
        .catch((e) => { console.warn('[FinPulse] IMOEX history:', e); indexCloses = []; })
        .then(() => render());
    }

    const signals = computeSignals(ctx);
    const pos = position(signals);
    const current = phaseOf(pos.g, pos.i);
    const shown = selectedPhase || current;
    const strength = Math.min(1, Math.hypot(pos.g, pos.i) / Math.SQRT2);
    // Если по оси нет уверенного сигнала, честно показываем обе возможные фазы
    const flatG = Math.abs(pos.g) < 0.1, flatI = Math.abs(pos.i) < 0.1;
    const headline = flatG && flatI ? 'Не определена'
      : flatI ? `${PHASES[phaseOf(pos.g, -1)].name} или ${PHASES[phaseOf(pos.g, 1)].name}`
      : flatG ? `${PHASES[phaseOf(-1, pos.i)].name} или ${PHASES[phaseOf(1, pos.i)].name}`
      : PHASES[current].name;
    const flatNote = flatG && flatI ? 'Сигналы уравновешивают друг друга.'
      : flatI ? 'Направление инфляции не определено — укажите его в макро-оценке.'
      : flatG ? 'Направление роста не определено — укажите его в макро-оценке.' : '';
    const certainty = strength > 0.55 ? 'выраженная' : strength > 0.25 ? 'умеренная' : 'слабая — сигналы противоречат друг другу';
    const marketSignals = signals.filter((s) => !s.macro);
    const macroSet = macro.growth || macro.infl;

    root.innerHTML = `
      <div class="grid gap-5 xl:grid-cols-[400px_minmax(0,1fr)]">
        <div class="card">
          <h3 class="card-title"><i data-lucide="clock-3" class="w-4 h-4 text-accent"></i>Инвестиционные часы</h3>
          <div class="mt-3">${clockSvg(pos, current)}</div>
          <div class="mt-3 text-center">
            <div class="text-xs text-muted">Модель указывает на фазу</div>
            <div class="text-xl font-semibold ${flatG || flatI ? '' : TEXT[PHASES[current].color]}">${headline}</div>
            ${flatNote ? `<div class="mt-1 text-xs text-warn">${flatNote}</div>` : `<div class="mt-1 text-xs text-muted">Определённость: ${certainty}</div>`}
            <div class="mt-2 text-[11px] text-muted">Рост ${U.signed(pos.g * 100, 0)} · инфляция ${U.signed(pos.i * 100, 0)} (шкала −100…+100)</div>
            ${macroSet || flatNote ? '' : '<div class="mt-2 text-[11px] text-warn">Только рыночные сигналы — задайте макро-оценку ниже для точности.</div>'}
          </div>
          <div class="mt-4 flex justify-center gap-1 flex-wrap">${ORDER.map((k) => `<button class="chip ${k === shown ? 'active' : ''}" data-phase="${k}">${PHASES[k].name}</button>`).join('')}</div>
        </div>
        <div class="card min-w-0">${phaseDetail(shown, current, ctx.stocks, ctx.API)}</div>
      </div>

      <div>
        <h3 class="text-base font-semibold">Сигналы цикла</h3>
        <p class="text-xs text-muted mt-1">Рассчитаны по загруженным котировкам. Каждый сигнал сдвигает точку на часах по оси роста или инфляции.</p>
        <div class="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          ${marketSignals.map(signalCard).join('') || '<div class="card text-sm text-muted">Недостаточно данных для рыночных сигналов.</div>'}
          ${indexCloses ? '' : '<div class="card"><span class="skeleton h-20 w-full block"></span></div>'}
          ${macroCard()}
        </div>
      </div>

      <div class="card">
        <h3 class="card-title"><i data-lucide="history" class="w-4 h-4 text-accent"></i>Циклы экономики России</h3>
        <p class="text-xs text-muted mt-1">Справочно: упрощённая классификация периодов по модели часов.</p>
        <ol class="mt-4 grid gap-x-6 gap-y-3 md:grid-cols-2">
          ${HISTORY.map((h) => `
            <li class="grid grid-cols-[86px_1fr] gap-3 items-baseline">
              <span class="font-semibold num text-sm">${h.years}</span>
              <span class="text-sm"><span class="tag ${TAG[PHASES[h.phase].color]} mr-1.5">${PHASES[h.phase].name}</span><span class="text-muted">${h.text}</span></span>
            </li>`).join('')}
        </ol>
      </div>
      <p class="text-[11px] text-muted">Модель «инвестиционных часов» — упрощение: реальные циклы не всегда проходят фазы по порядку и зависят от внешних шоков. Не является инвестиционной рекомендацией.</p>`;
    U.icons();
  }

  function bind() {
    const root = $('#cycles-root');
    if (!root || root.dataset.bound) return;
    root.dataset.bound = '1';
    root.addEventListener('click', (e) => {
      const ph = e.target.closest('[data-phase]');
      if (ph) { selectedPhase = ph.dataset.phase; render(); return; }
      const btn = e.target.closest('[data-macro] [data-v]');
      if (btn) {
        macro = { ...macro, [btn.closest('[data-macro]').dataset.macro]: +btn.dataset.v };
        U.store.set('cycleMacro', macro);
        selectedPhase = null;
        render();
      }
    });
  }

  return { render: (c) => { bind(); render(c); } };
})();
