/**
 * FinPulse — вкладка «Экономические циклы».
 *
 * Деловой цикл показан волной на шкале времени: восстановление → рост → замедление → рецессия.
 * Текущая фаза оценивается по схеме «инвестиционных часов» Merrill Lynch: две оси —
 * динамика роста и динамика инфляции — дают четыре фазы:
 *   Восстановление (рост ↑, инфляция ↓) → Рост/пик (↑, ↑) → Замедление (↓, ↑) → Рецессия (↓, ↓).
 * Угол точки (рост, инфляция) — это и есть фаза синусоиды на волне.
 *
 * Положение считается по рыночным сигналам из уже загруженных данных
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
      name: 'Рецессия', alias: 'спад, дно цикла', g: -1, i: -1, color: 'down',
      about: 'Экономика сокращается, инфляция снижается. Центробанк смягчает политику и снижает ставку.',
      best: 'Облигации: ЦБ переходит к смягчению, и длинные облигации с фиксированным купоном дорожают сильнее всего.',
      stocks: 'Лучше держатся наименее чувствительные к экономике компании: защитные, со стабильным спросом и дивидендами.',
      bonds: 'Длинные ОФЗ-ПД, высокая дюрация.',
      worst: 'Сырьё и циклические акции.',
      sectors: ['Ритейл'], assets: { 'Облигации': 3, 'Акции': -1, 'Сырьё': -2, 'Кэш': 1 },
    },
    recovery: {
      name: 'Восстановление', alias: 'выход из спада', g: 1, i: -1, color: 'up',
      about: 'Рост ускоряется, инфляция ещё низкая, ставки остаются низкими. Прибыли компаний быстро восстанавливаются.',
      best: 'Акции: в начале цикла чувствительные к экономике активы обычно показывают лучший результат за весь цикл.',
      stocks: 'Финансы и IT, бумаги с высокой бетой.',
      bonds: 'Корпоративные облигации, средняя дюрация.',
      worst: 'Кэш и депозиты.',
      sectors: ['Финансы', 'IT'], assets: { 'Облигации': 1, 'Акции': 3, 'Сырьё': 0, 'Кэш': -2 },
    },
    overheat: {
      name: 'Рост', alias: 'подъём к пику, перегрев', g: 1, i: 1, color: 'accent',
      about: 'Экономика растёт выше потенциала и подходит к пику: мощности загружены, инфляция ускоряется, центробанк повышает ставку.',
      best: 'Акции по-прежнему выигрывают от растущей экономики, но их преимущество сужается.',
      stocks: 'Широкий рынок: технологии и финансы; по мере роста инфляции — постепенно энергетика.',
      bonds: 'Короткие облигации и флоатеры: ЦБ ужесточает политику, длинные ОФЗ дешевеют.',
      worst: 'Длинные облигации.',
      sectors: ['IT', 'Финансы', 'Энергетика'], assets: { 'Облигации': -1, 'Акции': 2, 'Сырьё': 1, 'Кэш': 0 },
    },
    stagflation: {
      name: 'Замедление', alias: 'после пика, стагфляция', g: -1, i: 1, color: 'warn',
      about: 'Рост тормозит, а инфляция ещё высокая. Ставки остаются высокими, прибыли компаний под давлением.',
      best: 'Сырьё и короткие инструменты (депозиты, денежный рынок): инфляция ещё растёт, ставки высокие.',
      stocks: 'Сырьевые компании и защитные бумаги с дивидендами; меньше акций роста.',
      bonds: 'Флоатеры и короткие ОФЗ; кривая доходности плоская или перевёрнутая.',
      worst: 'Акции роста и длинные облигации.',
      sectors: ['Энергетика', 'Ритейл'], assets: { 'Облигации': -1, 'Акции': -1, 'Сырьё': 2, 'Кэш': 2 },
    },
  };
  // Порядок фаз делового цикла: восстановление → рост → замедление → рецессия
  const ORDER = ['recovery', 'overheat', 'stagflation', 'reflation'];
  // Полные имена классов — чтобы Tailwind CDN гарантированно их сгенерировал
  const TEXT = { accent: 'text-accent', up: 'text-up', warn: 'text-warn', down: 'text-down' };
  const TAG = { accent: 'tag-accent', up: 'tag-up', warn: 'tag-warn', down: 'tag-down' };
  const phaseOf = (g, i) => (g >= 0 ? (i >= 0 ? 'overheat' : 'recovery') : (i >= 0 ? 'stagflation' : 'reflation'));

  /**
   * Мировой цикл по оценке Fidelity (Asset Allocation Research Team) — для сравнения.
   * Fidelity оценивает США и мир, Россию не разбирает. Обновляется вручную раз в квартал
   * по свежему Quarterly Business Cycle Update.
   */
  const FIDELITY = {
    asOf: '2026-10-15',
    phase: 'overheat',   // у Fidelity — mid-cycle (середина цикла), на сайте это фаза «Рост»
    global: 'середина цикла: экспансия продолжается, но несинхронно по странам',
    us: 'середина цикла',
    note: 'Мировая активность остаётся в экспансии; высокая инфляция и цены на нефть привели к ужесточению денежной политики.',
    links: [
      ['Business Cycle Update, 4-й кв. 2026', 'https://institutional.fidelity.com/advisors/insights/topics/market-commentary/fourth-quarter-2026-quarterly-business-cycle-update'],
      ['Quarterly market update', 'https://www.fidelity.com/viewpoints/market-and-economic-insights/quarterly-market-update'],
    ],
  };

  /** Циклы экономики России — качественная справка. */
  const HISTORY = [
    { years: '1998', phase: 'reflation', text: 'Дефолт по ГКО и девальвация рубля: резкий спад и всплеск инфляции.' },
    { years: '1999–2008', phase: 'overheat', text: 'Долгий подъём на фоне роста цен на нефть и притока капитала.' },
    { years: '2008–2009', phase: 'reflation', text: 'Мировой финансовый кризис: глубокий спад ВВП, падение рынка акций.' },
    { years: '2010–2013', phase: 'recovery', text: 'Восстановление, к 2013 году — постепенное замедление роста.' },
    { years: '2014–2016', phase: 'reflation', text: 'Падение нефти и санкции: девальвация, рост инфляции и рецессия.' },
    { years: '2017–2019', phase: 'overheat', text: 'Инфляция у цели, ЦБ снижает ставку, умеренный рост экономики.' },
    { years: '2020', phase: 'reflation', text: 'Пандемия: спад и резкое смягчение денежно-кредитной политики.' },
    { years: '2021', phase: 'recovery', text: 'Быстрое восстановление и ускорение инфляции; ЦБ начинает повышать ставку.' },
    { years: '2022', phase: 'reflation', text: 'Санкционный шок: экстренное повышение ставки, затем её быстрое снижение.' },
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

  /** Сводная точка (рост, инфляция): средневзвешенное по сигналам каждой оси, g, i ∈ [-1, 1]. */
  function position(signals) {
    const axis = (k) => {
      const used = signals.filter((s) => AXES[s.id].includes(k));
      const wsum = used.reduce((a, s) => a + s.w, 0);
      return wsum ? used.reduce((a, s) => a + s[k] * s.w, 0) / wsum : 0;
    };
    return { g: axis('g'), i: axis('i') };
  }

  /* ---------------- Отрисовка ---------------- */
  /**
   * Волна делового цикла на шкале времени. Каждая фаза ведёт волну к своей опорной точке:
   * восстановление — к линии тренда снизу, рост — к пику, замедление — к тренду сверху,
   * рецессия — ко дну. Между опорными точками — плавная косинусная интерполяция.
   * История (1998–2025) — справочная разметка; последний отрезок — оценка модели по рынку.
   */
  const PHASE_END = { recovery: 0, overheat: 1, stagflation: 0, reflation: -1 };

  function waveSvg(pos, current, undetermined, headline) {
    const W = 900, H = 290, L = 34, R = 24, T = 34, B = 58;
    const now = new Date();
    const nowX = now.getFullYear() + (now.getMonth() + now.getDate() / 31) / 12;
    const periods = HISTORY.map((h) => {
      const [a, b] = h.years.split(/[–-]/).map(Number);
      return { ...h, x0: a, x1: (b || a) + 1 };
    });
    // Соседние периоды с общим годом («1999–2008» и «2008–2009») делят его пополам
    for (let k = 1; k < periods.length; k++) {
      if (periods[k].x0 < periods[k - 1].x1) { const mid = periods[k].x0 + 0.5; periods[k - 1].x1 = mid; periods[k].x0 = mid; }
    }
    const x0 = periods[0].x0, x1 = Math.ceil(nowX + 0.4);
    const sx = (x) => L + (x - x0) / (x1 - x0) * (W - L - R);
    const sy = (y) => T + (1 - (y + 1.15) / 2.3) * (H - T - B);
    const col = (k, a = 1) => `rgb(var(--c-${PHASES[k].color}) / ${a})`;

    // Текущее положение на волне: угол точки (рост, инфляция) — это фаза синусоиды
    const phi = Math.atan2(pos.i, pos.g);
    const yNow = undetermined ? 0 : Math.sin(phi);
    const rising = Math.cos(phi) > 0;

    // Опорные точки волны
    const anchors = [{ x: x0, y: 0 }];
    periods.forEach((p) => anchors.push({ x: p.x1, y: PHASE_END[p.phase] }));
    const lastHist = anchors[anchors.length - 1];
    const ease = (a, b, t) => a + (b - a) * (1 - Math.cos(Math.PI * t)) / 2;
    const segPath = (a, b, n = 28) => Array.from({ length: n + 1 }, (_, k) => {
      const t = k / n;
      return `${sx(a.x + (b.x - a.x) * t).toFixed(1)},${sy(ease(a.y, b.y, t)).toFixed(1)}`;
    });
    const histPts = [];
    for (let k = 0; k < anchors.length - 1; k++) histPts.push(...segPath(anchors[k], anchors[k + 1]).slice(k ? 1 : 0));
    const modelPts = segPath(lastHist, { x: nowX, y: yNow }, 20);

    const bands = periods.map((p) => `
      <g class="cursor-pointer" data-phase="${p.phase}">
        <rect x="${sx(p.x0).toFixed(1)}" y="${T - 14}" width="${(sx(p.x1) - sx(p.x0)).toFixed(1)}" height="${H - B - T + 14}" fill="${col(p.phase, 0.09)}"/>
        <rect x="${sx(p.x0).toFixed(1)}" y="${H - B + 4}" width="${(sx(p.x1) - sx(p.x0) - 1).toFixed(1)}" height="6" rx="2" fill="${col(p.phase, 0.85)}"/>
        <title>${p.years} · ${PHASES[p.phase].name}: ${p.text}</title>
      </g>`).join('');
    const modelBand = `<g class="cursor-pointer" data-phase="${current}">
        <rect x="${sx(lastHist.x).toFixed(1)}" y="${T - 14}" width="${(sx(nowX) - sx(lastHist.x)).toFixed(1)}" height="${H - B - T + 14}" fill="${undetermined ? 'rgb(var(--c-muted) / .08)' : col(current, 0.14)}" stroke="${undetermined ? 'rgb(var(--c-muted) / .4)' : col(current, 0.5)}" stroke-dasharray="4 3"/>
        <title>Оценка модели по текущим рыночным сигналам${undetermined ? '' : ': ' + PHASES[current].name}</title>
      </g>`;
    const years = [];
    for (let y = x0; y <= x1; y += 2) years.push(y);
    const nx = sx(nowX), ny = sy(yNow);
    const label = undetermined ? 'Сейчас: фаза не определена' : `Сейчас: ${headline || PHASES[current].name}`;
    const labelX = Math.min(nx, W - R - 4);

    return `
      <p class="sm:hidden text-[11px] text-muted mb-1">← Проведите влево, чтобы посмотреть историю с 1998 года</p>
      <div class="overflow-x-auto" data-wave-scroll><svg viewBox="0 0 ${W} ${H}" class="w-full h-auto min-w-[640px]" role="img" aria-label="Волна делового цикла с 1998 года, текущая фаза: ${undetermined ? 'не определена' : PHASES[current].name}">
        ${bands}${modelBand}
        <line x1="${L}" x2="${W - R}" y1="${sy(0)}" y2="${sy(0)}" stroke="rgb(var(--c-muted) / .55)" stroke-dasharray="4 4"/>
        <text x="${L + 4}" y="${sy(0) - 5}" font-size="11" fill="rgb(var(--c-muted))">тренд</text>
        <text x="${L + 4}" y="${sy(1) - 6}" font-size="10" fill="rgb(var(--c-muted))">пик</text>
        <text x="${L + 4}" y="${sy(-1) + 14}" font-size="10" fill="rgb(var(--c-muted))">дно</text>
        <polyline points="${histPts.join(' ')}" fill="none" stroke="rgb(var(--c-fg) / .85)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
        <polyline points="${modelPts.join(' ')}" fill="none" stroke="${undetermined ? 'rgb(var(--c-muted))' : col(current)}" stroke-width="2.4" stroke-dasharray="6 5" stroke-linecap="round"/>
        ${years.map((y) => `<text x="${sx(y).toFixed(1)}" y="${H - B + 26}" font-size="11" text-anchor="middle" fill="rgb(var(--c-muted))">${y}</text>`).join('')}
        <circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="13" fill="${undetermined ? 'rgb(var(--c-muted) / .25)' : col(current, 0.25)}" class="cycle-pulse"/>
        <circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="6.5" fill="${undetermined ? 'rgb(var(--c-muted))' : col(current)}" stroke="rgb(var(--c-surface))" stroke-width="2.5"/>
        ${undetermined ? '' : `<text x="${(nx + 11).toFixed(1)}" y="${(ny + (rising ? -9 : 15)).toFixed(1)}" font-size="13" fill="${col(current)}">${rising ? '↗' : '↘'}</text>`}
        <text x="${labelX.toFixed(1)}" y="${T - 20}" font-size="12" font-weight="600" text-anchor="end" fill="${undetermined ? 'rgb(var(--c-muted))' : col(current)}">${label}</text>
      </svg></div>
      <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
        ${ORDER.map((k) => `<span class="flex items-center gap-1.5"><span class="w-3 h-1.5 rounded-sm" style="background:${col(k)}"></span>${PHASES[k].name}</span>`).join('')}
        <span class="flex items-center gap-1.5"><span class="w-4 border-t-2 border-fg/80"></span>история (справочно)</span>
        <span class="flex items-center gap-1.5"><span class="w-4 border-t-2 border-dashed border-muted"></span>оценка модели по рынку</span>
      </div>`;
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
        <p class="mt-2 text-[11px] text-muted">Оценки по классам активов — моё обобщение описания фаз в материалах Fidelity о деловом цикле и модели «инвестиционных часов», а не их числовые данные.</p>
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
      <div class="card">
        <h3 class="card-title"><i data-lucide="activity" class="w-4 h-4 text-accent"></i>Деловой цикл России</h3>
        <p class="text-xs text-muted mt-1">Волна выше линии тренда — экономика растёт быстрее обычного, ниже — медленнее или сокращается. Нажмите на период, чтобы открыть описание фазы.</p>
        <div class="mt-3">${waveSvg(pos, current, flatG && flatI, headline)}</div>
        <div class="mt-4 p-3 rounded-lg border border-line bg-bg/50">
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <span class="font-semibold">Для сравнения: мировой цикл по Fidelity</span>
            <button type="button" class="tag ${TAG[PHASES[FIDELITY.phase].color]}" data-phase="${FIDELITY.phase}">${PHASES[FIDELITY.phase].name}</button>
            <span class="text-xs text-muted">обзор от ${U.date(FIDELITY.asOf)}</span>
          </div>
          <p class="mt-1.5 text-sm text-muted">Мир — ${FIDELITY.global}; США — ${FIDELITY.us}. ${FIDELITY.note}</p>
          <p class="mt-1.5 text-xs text-muted">Fidelity называет фазы «ранний — средний — поздний цикл — рецессия»; на сайте им соответствуют «восстановление — рост — замедление — рецессия». Россию Fidelity не оценивает, поэтому это ориентир по мировой экономике, а не по российской.
            Источник: ${FIDELITY.links.map(([t, u]) => `<a class="text-accent hover:underline" href="${u}" target="_blank" rel="noopener">${t}</a>`).join(', ')}.</p>
        </div>
      </div>

      <div class="grid gap-5 xl:grid-cols-[400px_minmax(0,1fr)]">
        <div class="card">
          <div class="text-center">
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
        <p class="text-xs text-muted mt-1">Рассчитаны по загруженным котировкам. Каждый сигнал говорит, ускоряется или замедляется рост и растёт или снижается инфляция; вместе они задают положение на волне.</p>
        <div class="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          ${marketSignals.map(signalCard).join('') || '<div class="card text-sm text-muted">Недостаточно данных для рыночных сигналов.</div>'}
          ${indexCloses ? '' : '<div class="card"><span class="skeleton h-20 w-full block"></span></div>'}
          ${macroCard()}
        </div>
      </div>

      <div class="card">
        <h3 class="card-title"><i data-lucide="history" class="w-4 h-4 text-accent"></i>Циклы экономики России</h3>
        <p class="text-xs text-muted mt-1">Справочно: моя упрощённая разметка периодов по фазам делового цикла, по общеизвестным событиям. Не официальная периодизация.</p>
        <ol class="mt-4 grid gap-x-6 gap-y-3 md:grid-cols-2">
          ${HISTORY.map((h) => `
            <li class="grid grid-cols-[86px_1fr] gap-3 items-baseline">
              <span class="font-semibold num text-sm">${h.years}</span>
              <span class="text-sm"><span class="tag ${TAG[PHASES[h.phase].color]} mr-1.5">${PHASES[h.phase].name}</span><span class="text-muted">${h.text}</span></span>
            </li>`).join('')}
        </ol>
      </div>
      <p class="text-[11px] text-muted">Модель цикла — упрощение: реальные циклы не всегда проходят фазы по порядку и зависят от внешних шоков. Текущая фаза оценивается по рыночным сигналам и вашей макро-оценке по схеме «инвестиционных часов» Merrill Lynch. Не является инвестиционной рекомендацией.</p>`;
    U.icons();
    // На узком экране график шире окна — сразу показываем правый край с отметкой «Сейчас»
    const sc = root.querySelector('[data-wave-scroll]');
    if (sc) sc.scrollLeft = sc.scrollWidth;
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
