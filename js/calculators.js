/**
 * FinPulse — вкладка «Калькуляторы».
 *
 * Каждый калькулятор описан данными: поля формы + функция compute(values),
 * которая возвращает карточки итогов, график (SVG) и таблицу. Общий движок
 * рисует форму, пересчитывает результат при вводе и запоминает значения
 * в браузере. Калькуляторы: сложный процент, ипотека, досрочное погашение,
 * цели, рефинансирование, облигации, конвертер валют, инфляция.
 */
window.FP = window.FP || {};

FP.Calculators = (() => {
  'use strict';
  const U = FP.U;
  const { $, $$ } = U;

  /* =====================================================================
     Форматирование и финансовые формулы
     ===================================================================== */
  const rub = (v) => (v == null || !Number.isFinite(v) ? '—' : `${U.price(v, Math.abs(v) >= 1000 ? 0 : 2)} ₽`);
  const money = (v, cur = 'RUB') => (cur === 'RUB' ? rub(v) : `${U.price(v, 2)} ${cur}`);
  const pct = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${U.price(v, d)}%`);
  const months = (m) => {
    const y = Math.floor(m / 12), r = Math.round(m % 12);
    return [y ? `${y} ${U.plural(y, ['год', 'года', 'лет'])}` : '', r ? `${r} мес.` : ''].filter(Boolean).join(' ') || '0 мес.';
  };
  /** «сентября 2035» — родительный падеж получаем из полной даты без числа. */
  const monthDate = (m) => { const d = new Date(); d.setMonth(d.getMonth() + m); return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/^\d+\s/, '').replace(' г.', ''); };

  /** Аннуитетный платёж. */
  const annuity = (P, rMonthly, n) => (n <= 0 ? P : rMonthly === 0 ? P / n : P * rMonthly / (1 - Math.pow(1 + rMonthly, -n)));

  /** Помесячный график аннуитетного кредита с досрочными погашениями. */
  function amortize({ P, rate, n, extraMonthly = 0, oneTime = 0, oneTimeMonth = 0, mode = 'term' }) {
    const r = rate / 1200;
    let bal = P, pay = annuity(P, r, n), m = 0, interest = 0, paid = 0, extraPaid = 0;
    const rows = [];
    while (bal > 0.005 && m < 1200) {
      m++;
      const i = bal * r;
      let principal = Math.min(bal, pay - i);
      if (principal < 0) principal = 0;          // платёж меньше процентов — защищаемся от бесконечного цикла
      bal -= principal; interest += i; paid += principal + i;
      let extra = extraMonthly + (m === oneTimeMonth ? oneTime : 0);
      extra = Math.min(extra, bal);
      bal -= extra; extraPaid += extra; paid += extra;
      if (extra > 0 && mode === 'payment' && n - m > 0) pay = annuity(bal, r, n - m);
      rows.push({ m, payment: principal + i, interest: i, principal, extra, balance: Math.max(0, bal) });
      if (m >= n && mode === 'payment') break;
    }
    return { rows, interest, paid, extraPaid, months: m, firstPayment: annuity(P, r, n), lastPayment: rows.length ? rows[rows.length - 1].payment : 0 };
  }

  /** Свести помесячные строки по годам. */
  function byYear(rows, fields) {
    const out = [];
    rows.forEach((row) => {
      const y = Math.ceil(row.m / 12);
      if (!out[y - 1]) out[y - 1] = { year: y, ...Object.fromEntries(fields.map((f) => [f, 0])) };
      fields.forEach((f) => { out[y - 1][f] += row[f] || 0; });
      out[y - 1].balance = row.balance;
    });
    return out.filter(Boolean);
  }

  /** Корень уравнения f(x)=0 методом бисекции (для YTM). */
  function bisect(f, lo, hi, iter = 200) {
    let flo = f(lo);
    if (flo * f(hi) > 0) return null;
    for (let k = 0; k < iter; k++) {
      const mid = (lo + hi) / 2, fm = f(mid);
      if (Math.abs(fm) < 1e-9) return mid;
      if (flo * fm < 0) hi = mid; else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  /* =====================================================================
     Мини-графики (SVG, цвета из токенов темы)
     ===================================================================== */
  const C = (name, a = 1) => `rgb(var(--c-${name}) / ${a})`;
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  const axisFmt = (v) => U.compact(v).replace(' тыс.', 'т').replace(' млн', 'м').replace(' млрд', 'млрд');

  function legend(series) {
    return `<div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted">${series.map((s) =>
      `<span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm" style="background:${C(s.color)}"></span>${s.name}</span>`).join('')}</div>`;
  }

  /** Столбцы с накоплением. */
  function stackedBars(labels, series) {
    const W = 640, H = 230, L = 52, R = 8, T = 10, B = 24;
    const totals = labels.map((_, i) => series.reduce((a, s) => a + Math.max(0, s.values[i] || 0), 0));
    const max = niceMax(Math.max(...totals, 1));
    const pw = W - L - R, ph = H - T - B, bw = pw / labels.length;
    const y = (v) => T + ph - v / max * ph;
    const every = Math.ceil(labels.length / 12);
    let svg = '';
    for (let k = 0; k <= 4; k++) {
      const v = max * k / 4;
      svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${C('line')}" stroke-dasharray="${k ? '3 3' : ''}"/>
        <text x="${L - 6}" y="${y(v) + 3}" font-size="10" text-anchor="end" fill="${C('muted')}">${axisFmt(v)}</text>`;
    }
    labels.forEach((lab, i) => {
      let acc = 0;
      const x = L + i * bw + bw * 0.15, w = Math.max(1, bw * 0.7);
      series.forEach((s) => {
        const v = Math.max(0, s.values[i] || 0);
        if (v > 0) svg += `<rect x="${x.toFixed(1)}" y="${y(acc + v).toFixed(1)}" width="${w.toFixed(1)}" height="${(v / max * ph).toFixed(1)}" fill="${C(s.color, 0.85)}"><title>${lab}: ${s.name} ${rub(v)}</title></rect>`;
        acc += v;
      });
      if (i % every === 0) svg += `<text x="${(x + w / 2).toFixed(1)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="${C('muted')}">${lab}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" role="img">${svg}</svg>${legend(series)}`;
  }

  /** Линии (x — подписи, общая шкала Y). */
  function lineChart(labels, series, { fmt = axisFmt } = {}) {
    const W = 640, H = 230, L = 52, R = 8, T = 10, B = 24;
    const all = series.flatMap((s) => s.values).filter(Number.isFinite);
    const max = niceMax(Math.max(...all, 1));
    const pw = W - L - R, ph = H - T - B;
    const x = (i) => L + (labels.length > 1 ? i / (labels.length - 1) : 0.5) * pw;
    const y = (v) => T + ph - Math.max(0, v) / max * ph;
    const every = Math.ceil(labels.length / 10);
    let svg = '';
    for (let k = 0; k <= 4; k++) {
      const v = max * k / 4;
      svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${C('line')}" stroke-dasharray="${k ? '3 3' : ''}"/>
        <text x="${L - 6}" y="${y(v) + 3}" font-size="10" text-anchor="end" fill="${C('muted')}">${fmt(v)}</text>`;
    }
    labels.forEach((lab, i) => { if (i % every === 0 || i === labels.length - 1) svg += `<text x="${x(i)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="${C('muted')}">${lab}</text>`; });
    series.forEach((s) => {
      const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      if (s.fill) svg += `<polygon points="${x(0)},${y(0)} ${pts} ${x(s.values.length - 1)},${y(0)}" fill="${C(s.color, 0.12)}"/>`;
      svg += `<polyline points="${pts}" fill="none" stroke="${C(s.color)}" stroke-width="2" ${s.dash ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round"/>`;
      const last = s.values.length - 1;
      svg += `<circle cx="${x(last)}" cy="${y(s.values[last])}" r="3.5" fill="${C(s.color)}"/>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" role="img">${svg}</svg>${legend(series)}`;
  }

  /* =====================================================================
     Справочные данные
     ===================================================================== */
  /** Годовая инфляция в России, декабрь к декабрю, Росстат, %. */
  const CPI = { 2010: 8.8, 2011: 6.1, 2012: 6.6, 2013: 6.5, 2014: 11.4, 2015: 12.9, 2016: 5.4, 2017: 2.5, 2018: 4.3, 2019: 3.0, 2020: 4.9, 2021: 8.4, 2022: 11.9, 2023: 7.4, 2024: 9.5 };
  const CPI_YEARS = Object.keys(CPI).map(Number);

  let rates = null;       // { RUB: {rate:1, name}, USD: {...}, ... , _date, _source }
  let ratesLoad = null;
  let bondsGetter = () => [];

  /* =====================================================================
     Описания калькуляторов
     ===================================================================== */
  const freqOpts = [['12', 'Ежемесячно'], ['4', 'Ежеквартально'], ['1', 'Ежегодно']];

  const CALCS = {
    compound: {
      title: 'Сложный процент', icon: 'trending-up',
      desc: 'Сколько накопится с учётом капитализации процентов и регулярных пополнений.',
      fields: [
        { id: 'initial', label: 'Начальная сумма', unit: '₽', def: 100000, step: 1000 },
        { id: 'monthly', label: 'Пополнение в месяц', unit: '₽', def: 10000, step: 1000 },
        { id: 'rate', label: 'Доходность', unit: '% год.', def: 15, step: 0.1 },
        { id: 'years', label: 'Срок', unit: 'лет', def: 10, step: 1, min: 1, max: 60 },
        { id: 'freq', label: 'Капитализация', type: 'seg', options: freqOpts, def: '12' },
        { id: 'indexation', label: 'Рост пополнений в год', unit: '%', def: 0, step: 1 },
      ],
      compute(v) {
        const n = +v.freq, im = Math.pow(1 + v.rate / 100 / n, n / 12) - 1;
        let bal = v.initial, contrib = v.initial, pay = v.monthly;
        const rows = [];
        for (let m = 1; m <= v.years * 12; m++) {
          bal = bal * (1 + im) + pay; contrib += pay;
          if (m % 12 === 0) { rows.push({ year: m / 12, contrib, interest: bal - contrib, balance: bal }); pay *= 1 + v.indexation / 100; }
        }
        const last = rows[rows.length - 1] || { contrib, interest: 0, balance: bal };
        return {
          cards: [
            { label: 'Итоговая сумма', value: rub(last.balance), tone: 'accent', big: true },
            { label: 'Вложено', value: rub(last.contrib) },
            { label: 'Доход от процентов', value: rub(last.interest), tone: 'up', sub: `${pct(last.interest / last.balance * 100, 1)} итоговой суммы` },
            { label: 'Эффективная ставка', value: pct((Math.pow(1 + im, 12) - 1) * 100), sub: 'с учётом капитализации' },
          ],
          chart: stackedBars(rows.map((r) => r.year + ' г.'), [
            { name: 'Вложения', color: 'accent', values: rows.map((r) => r.contrib) },
            { name: 'Проценты', color: 'up', values: rows.map((r) => r.interest) },
          ]),
          table: { head: ['Год', 'Вложено', 'Проценты', 'Сумма'], rows: rows.map((r) => [r.year, rub(r.contrib), rub(r.interest), rub(r.balance)]) },
          note: 'Пополнения — в конце каждого месяца. Налог на процентный доход не учитывается.',
        };
      },
    },

    mortgage: {
      title: 'Ипотека', icon: 'house',
      desc: 'Платёж, переплата и график погашения ипотечного кредита.',
      fields: [
        { id: 'price', label: 'Стоимость жилья', unit: '₽', def: 12000000, step: 100000 },
        { id: 'down', label: 'Первоначальный взнос', unit: '₽', def: 3000000, step: 100000 },
        { id: 'rate', label: 'Ставка', unit: '% год.', def: 18, step: 0.1 },
        { id: 'years', label: 'Срок', unit: 'лет', def: 20, step: 1, min: 1, max: 40 },
        { id: 'type', label: 'Тип платежа', type: 'seg', options: [['annuity', 'Аннуитетный'], ['diff', 'Дифференцированный']], def: 'annuity' },
      ],
      compute(v) {
        const P = Math.max(0, v.price - v.down), n = Math.round(v.years * 12), r = v.rate / 1200;
        let rows;
        if (v.type === 'diff') {
          rows = []; let bal = P;
          for (let m = 1; m <= n; m++) { const i = bal * r, pr = P / n; bal -= pr; rows.push({ m, payment: pr + i, interest: i, principal: pr, balance: Math.max(0, bal) }); }
        } else rows = amortize({ P, rate: v.rate, n }).rows;
        const interest = rows.reduce((a, x) => a + x.interest, 0);
        const first = rows[0] ? rows[0].payment : 0, last = rows.length ? rows[rows.length - 1].payment : 0;
        const years = byYear(rows, ['payment', 'interest', 'principal']);
        return {
          cards: [
            { label: v.type === 'diff' ? 'Первый платёж' : 'Ежемесячный платёж', value: rub(first), tone: 'accent', big: true, sub: v.type === 'diff' ? `последний — ${rub(last)}` : '' },
            { label: 'Сумма кредита', value: rub(P), sub: `взнос ${pct(v.down / v.price * 100, 0)}` },
            { label: 'Переплата', value: rub(interest), tone: 'down', sub: `${pct(interest / P * 100, 0)} от суммы кредита` },
            { label: 'Рекомендуемый доход', value: rub(first / 0.5), sub: 'чтобы платёж был не больше 50% дохода' },
          ],
          chart: stackedBars(years.map((y) => y.year), [
            { name: 'Основной долг', color: 'accent', values: years.map((y) => y.principal) },
            { name: 'Проценты', color: 'warn', values: years.map((y) => y.interest) },
          ]),
          table: { head: ['Год', 'Платежи', 'Проценты', 'Основной долг', 'Остаток'], rows: years.map((y) => [y.year, rub(y.payment), rub(y.interest), rub(y.principal), rub(y.balance)]) },
          note: 'Страховка, комиссии и налоговый вычет не учитываются.',
        };
      },
    },

    prepay: {
      title: 'Досрочное погашение', icon: 'fast-forward',
      desc: 'Сколько сэкономите на процентах, если вносить деньги сверх графика.',
      fields: [
        { id: 'balance', label: 'Остаток долга', unit: '₽', def: 5000000, step: 10000 },
        { id: 'rate', label: 'Ставка', unit: '% год.', def: 16, step: 0.1 },
        { id: 'months', label: 'Осталось платить', unit: 'мес.', def: 180, step: 1, min: 1, max: 480 },
        { id: 'extra', label: 'Доплата каждый месяц', unit: '₽', def: 10000, step: 1000 },
        { id: 'oneTime', label: 'Разовый платёж', unit: '₽', def: 300000, step: 10000 },
        { id: 'oneMonth', label: 'Месяц разового платежа', unit: '№', def: 6, step: 1, min: 1 },
        { id: 'mode', label: 'Что уменьшать', type: 'seg', options: [['term', 'Срок'], ['payment', 'Платёж']], def: 'term' },
      ],
      compute(v) {
        const base = amortize({ P: v.balance, rate: v.rate, n: v.months });
        const alt = amortize({ P: v.balance, rate: v.rate, n: v.months, extraMonthly: v.extra, oneTime: v.oneTime, oneTimeMonth: v.oneMonth, mode: v.mode });
        const save = base.interest - alt.interest;
        const len = Math.max(base.rows.length, alt.rows.length);
        const step = Math.max(1, Math.round(len / 40));
        const idx = []; for (let i = 0; i < len; i += step) idx.push(i);
        if (idx[idx.length - 1] !== len - 1) idx.push(len - 1);
        const balAt = (rows, i) => (rows[i] ? rows[i].balance : 0);
        return {
          cards: [
            { label: 'Экономия на процентах', value: rub(save), tone: 'up', big: true, sub: `${pct(save / base.interest * 100, 0)} переплаты` },
            v.mode === 'term'
              ? { label: 'Новый срок', value: months(alt.months), sub: `короче на ${months(base.months - alt.months)} · до ${monthDate(alt.months)}` }
              : { label: 'Платёж в конце', value: rub(alt.rows.length ? alt.rows[alt.rows.length - 1].payment : 0), sub: `был ${rub(base.firstPayment)}` },
            { label: 'Платёж по графику', value: rub(base.firstPayment) },
            { label: 'Переплата', value: rub(alt.interest), sub: `вместо ${rub(base.interest)}` },
          ],
          chart: lineChart(idx.map((i) => `${Math.floor((i + 1) / 12)} г.`), [
            { name: 'Остаток по графику', color: 'muted', values: idx.map((i) => balAt(base.rows, i)), dash: true },
            { name: 'С досрочными платежами', color: 'accent', values: idx.map((i) => balAt(alt.rows, i)), fill: true },
          ]),
          table: {
            head: ['', 'По графику', 'С досрочным', 'Разница'],
            rows: [
              ['Срок', months(base.months), months(alt.months), months(base.months - alt.months)],
              ['Проценты', rub(base.interest), rub(alt.interest), rub(save)],
              ['Досрочные взносы', '—', rub(alt.extraPaid), ''],
              ['Всего выплат', rub(base.paid), rub(alt.paid), rub(base.paid - alt.paid)],
            ],
          },
          note: 'Аннуитетный кредит; досрочный платёж уменьшает долг в тот же месяц. При «Платёж» срок не меняется.',
        };
      },
    },

    goal: {
      title: 'Финансовая цель', icon: 'target',
      desc: 'Сколько откладывать каждый месяц, чтобы накопить нужную сумму к сроку.',
      fields: [
        { id: 'goal', label: 'Цель в сегодняшних ценах', unit: '₽', def: 3000000, step: 100000 },
        { id: 'years', label: 'Срок', unit: 'лет', def: 5, step: 1, min: 1, max: 50 },
        { id: 'initial', label: 'Уже накоплено', unit: '₽', def: 200000, step: 10000 },
        { id: 'rate', label: 'Доходность', unit: '% год.', def: 14, step: 0.5 },
        { id: 'inflation', label: 'Инфляция', unit: '% год.', def: 6, step: 0.5 },
      ],
      compute(v) {
        const n = Math.round(v.years * 12), i = Math.pow(1 + v.rate / 100, 1 / 12) - 1;
        const target = v.goal * Math.pow(1 + v.inflation / 100, v.years);
        const growth = Math.pow(1 + i, n);
        let pmt = i === 0 ? (target - v.initial) / n : (target - v.initial * growth) * i / (growth - 1);
        pmt = Math.max(0, pmt);
        const labels = [], bal = [], goalLine = [];
        let b = v.initial;
        for (let m = 0; m <= n; m++) {
          if (m > 0) b = b * (1 + i) + pmt;
          if (m % 12 === 0 || m === n) { labels.push(`${Math.round(m / 12)} г.`); bal.push(b); goalLine.push(target); }
        }
        const rows = labels.map((l, k) => [l, rub(bal[k]), pct(Math.min(100, bal[k] / target * 100), 0)]);
        return {
          cards: [
            { label: 'Откладывать в месяц', value: rub(pmt), tone: 'accent', big: true, sub: pmt === 0 ? 'накопленного уже хватит' : '' },
            { label: 'Цель к сроку', value: rub(target), sub: `с учётом инфляции ${pct(v.inflation, 1)}` },
            { label: 'Своих взносов', value: rub(v.initial + pmt * n) },
            { label: 'Доход от инвестиций', value: rub(target - v.initial - pmt * n), tone: 'up' },
          ],
          chart: lineChart(labels, [
            { name: 'Цель', color: 'warn', values: goalLine, dash: true },
            { name: 'Накопления', color: 'accent', values: bal, fill: true },
          ]),
          table: { head: ['Срок', 'Накоплено', 'Прогресс'], rows },
          note: 'Взносы в конце месяца, доходность постоянная. Реальная доходность инвестиций меняется год от года.',
        };
      },
    },

    refi: {
      title: 'Рефинансирование', icon: 'repeat',
      desc: 'Выгодно ли перекредитоваться под меньшую ставку с учётом расходов.',
      fields: [
        { id: 'balance', label: 'Остаток долга', unit: '₽', def: 2000000, step: 10000 },
        { id: 'rate', label: 'Текущая ставка', unit: '% год.', def: 24, step: 0.1 },
        { id: 'months', label: 'Осталось платить', unit: 'мес.', def: 48, step: 1, min: 1, max: 480 },
        { id: 'newRate', label: 'Новая ставка', unit: '% год.', def: 19, step: 0.1 },
        { id: 'newMonths', label: 'Новый срок', unit: 'мес.', def: 48, step: 1, min: 1, max: 480 },
        { id: 'costs', label: 'Расходы на переоформление', unit: '₽', def: 15000, step: 1000 },
      ],
      compute(v) {
        const oldPay = annuity(v.balance, v.rate / 1200, v.months), newPay = annuity(v.balance, v.newRate / 1200, v.newMonths);
        const oldTotal = oldPay * v.months, newTotal = newPay * v.newMonths + v.costs;
        const save = oldTotal - newTotal, monthSave = oldPay - newPay;
        const breakEven = monthSave > 0 ? Math.ceil(v.costs / monthSave) : null;
        const len = Math.max(v.months, v.newMonths), step = Math.max(1, Math.round(len / 40));
        const labels = [], a = [], b = [];
        for (let m = 0; m <= len; m += step) { labels.push(`${m} м.`); a.push(oldPay * Math.min(m, v.months)); b.push(v.costs + newPay * Math.min(m, v.newMonths)); }
        return {
          cards: [
            { label: save >= 0 ? 'Выгода' : 'Потери', value: rub(Math.abs(save)), tone: save >= 0 ? 'up' : 'down', big: true, sub: save >= 0 ? 'за весь срок с учётом расходов' : 'рефинансирование невыгодно' },
            { label: 'Новый платёж', value: rub(newPay), sub: `был ${rub(oldPay)} (${monthSave >= 0 ? '−' : '+'}${rub(Math.abs(monthSave))})` },
            { label: 'Расходы окупятся', value: breakEven ? `через ${months(breakEven)}` : '—', sub: breakEven ? '' : 'платёж не уменьшается' },
            { label: 'Проценты', value: rub(newTotal - v.costs - v.balance), sub: `вместо ${rub(oldTotal - v.balance)}` },
          ],
          chart: lineChart(labels, [
            { name: 'Выплаты по текущему кредиту', color: 'muted', values: a, dash: true },
            { name: 'После рефинансирования', color: 'accent', values: b },
          ]),
          table: {
            head: ['', 'Сейчас', 'После', 'Разница'],
            rows: [
              ['Ставка', pct(v.rate), pct(v.newRate), pct(v.newRate - v.rate)],
              ['Срок', months(v.months), months(v.newMonths), ''],
              ['Платёж', rub(oldPay), rub(newPay), rub(newPay - oldPay)],
              ['Всего выплат', rub(oldTotal), rub(newTotal), rub(newTotal - oldTotal)],
            ],
          },
          note: 'Если новый срок длиннее, платёж меньше, но переплата может вырасти — смотрите строку «Всего выплат».',
        };
      },
    },

    bond: {
      title: 'Облигации', icon: 'landmark',
      desc: 'Доходность к погашению (YTM), купонный доход и поток выплат по облигации.',
      prefill: true,
      fields: [
        { id: 'price', label: 'Цена', unit: '% номинала', def: 95, step: 0.1 },
        { id: 'nominal', label: 'Номинал', unit: '₽', def: 1000, step: 100 },
        { id: 'coupon', label: 'Ставка купона', unit: '% год.', def: 12, step: 0.1 },
        { id: 'freq', label: 'Выплаты купона', type: 'seg', options: [['12', 'Ежемес.'], ['4', 'Ежекв.'], ['2', 'Полугод.'], ['1', 'Ежегод.']], def: '2' },
        { id: 'years', label: 'До погашения', unit: 'лет', def: 3, step: 0.25, min: 0.1 },
        { id: 'aci', label: 'НКД при покупке', unit: '₽', def: 0, step: 1 },
        { id: 'qty', label: 'Количество', unit: 'шт.', def: 10, step: 1, min: 1 },
        { id: 'fee', label: 'Комиссия брокера', unit: '%', def: 0.05, step: 0.01 },
        { id: 'tax', label: 'НДФЛ 13%', type: 'seg', options: [['1', 'Учитывать'], ['0', 'Нет']], def: '1' },
      ],
      compute(v) {
        const f = +v.freq, tax = v.tax === '1' ? 0.13 : 0;
        const dirty = v.nominal * v.price / 100 + v.aci;
        const cost = dirty * (1 + v.fee / 100);
        const cpn = v.nominal * v.coupon / 100 / f;
        const N = Math.max(1, Math.ceil(v.years * f - 1e-9));
        const flows = [];
        for (let k = 1; k <= N; k++) {
          const t = v.years - (N - k) / f;
          // НКД, уплаченный при покупке, вычитается из налогооблагаемого первого купона
          const taxable = k === 1 ? Math.max(0, cpn - v.aci) : cpn;
          let amount = cpn - taxable * tax;
          let redemption = 0;
          if (k === N) { const gain = v.nominal - v.nominal * v.price / 100; redemption = v.nominal - Math.max(0, gain) * tax; }
          flows.push({ k, t, coupon: amount, redemption, total: amount + redemption });
        }
        const npv = (r) => flows.reduce((a, c) => a + c.total / Math.pow(1 + r, c.t), 0) - cost;
        const ytm = bisect(npv, -0.95, 10);
        const income = flows.reduce((a, c) => a + c.total, 0) - cost;
        return {
          cards: [
            { label: tax ? 'Доходность к погашению после налога' : 'Доходность к погашению (YTM)', value: ytm == null ? '—' : pct(ytm * 100), tone: 'accent', big: true, sub: 'эффективная, % годовых' },
            { label: 'Текущая доходность', value: pct(v.coupon / v.price * 100), sub: 'купон / цена' },
            { label: `Доход на ${v.qty} шт.`, value: rub(income * v.qty), tone: income >= 0 ? 'up' : 'down', sub: `вложено ${rub(cost * v.qty)}` },
            { label: 'Купон', value: rub(cpn), sub: `${N} ${U.plural(N, ['выплата', 'выплаты', 'выплат'])} до погашения` },
          ],
          chart: stackedBars(flows.map((c) => `${U.price(c.t, 1)}`), [
            { name: 'Купоны', color: 'up', values: flows.map((c) => c.coupon * v.qty) },
            { name: 'Погашение номинала', color: 'accent', values: flows.map((c) => c.redemption * v.qty) },
          ]),
          table: {
            head: ['№', 'Через, лет', 'Купон', 'Погашение', `Итого × ${v.qty}`],
            rows: flows.map((c) => [c.k, U.price(c.t, 2), rub(c.coupon), c.redemption ? rub(c.redemption) : '—', rub(c.total * v.qty)]),
          },
          note: 'Купоны не реинвестируются; ставка купона постоянная. Для флоатеров и амортизируемых облигаций расчёт приблизительный.',
        };
      },
    },

    fx: {
      title: 'Конвертер валют', icon: 'arrow-left-right',
      desc: 'Пересчёт по официальному курсу Банка России.',
      fields: [
        { id: 'amount', label: 'Сумма', unit: '', def: 1000, step: 1 },
        { id: 'from', label: 'Из валюты', type: 'currency', def: 'USD' },
        { id: 'to', label: 'В валюту', type: 'currency', def: 'RUB' },
      ],
      compute(v) {
        if (!rates) return { loading: true };
        const a = rates[v.from], b = rates[v.to];
        if (!a || !b) return { cards: [{ label: 'Нет курса', value: '—' }] };
        const cross = a.rate / b.rate, result = v.amount * cross;
        const majors = ['RUB', 'USD', 'EUR', 'CNY', 'GBP', 'JPY', 'CHF', 'TRY', 'KZT', 'AED', 'BYN', 'INR'].filter((c) => rates[c] && c !== v.from);
        return {
          cards: [
            { label: `${U.price(v.amount, 2)} ${v.from} =`, value: money(result, v.to), tone: 'accent', big: true },
            { label: 'Курс', value: `1 ${v.from} = ${U.price(cross, cross < 1 ? 4 : 2)} ${v.to}` },
            { label: 'Обратный курс', value: `1 ${v.to} = ${U.price(1 / cross, 1 / cross < 1 ? 4 : 2)} ${v.from}` },
            { label: 'Источник', value: rates._source, sub: rates._date ? `курс на ${rates._date}` : '' },
          ],
          table: {
            head: ['Валюта', 'Название', `${U.price(v.amount, 2)} ${v.from} =`],
            rows: majors.map((c) => [c, rates[c].name, money(v.amount * a.rate / rates[c].rate, c)]),
          },
          note: 'Официальный курс ЦБ устанавливается раз в день и отличается от курса обмена в банке.',
          swap: true,
        };
      },
    },

    inflation: {
      title: 'Инфляция', icon: 'flame',
      desc: 'Как инфляция меняет цену денег: по фактической инфляции Росстата или по своей ставке.',
      fields: [
        { id: 'amount', label: 'Сумма', unit: '₽', def: 100000, step: 1000 },
        { id: 'mode', label: 'Расчёт', type: 'seg', options: [['history', 'По данным Росстата'], ['custom', 'Своя ставка']], def: 'history' },
        { id: 'from', label: 'С начала года', type: 'select', options: CPI_YEARS.map((y) => [String(y), String(y)]), def: '2015', when: (v) => v.mode === 'history' },
        { id: 'to', label: 'По конец года', type: 'select', options: CPI_YEARS.map((y) => [String(y), String(y)]), def: String(CPI_YEARS[CPI_YEARS.length - 1]), when: (v) => v.mode === 'history' },
        { id: 'rate', label: 'Инфляция', unit: '% год.', def: 7, step: 0.1, when: (v) => v.mode === 'custom' },
        { id: 'years', label: 'Срок', unit: 'лет', def: 10, step: 1, min: 1, max: 50, when: (v) => v.mode === 'custom' },
        { id: 'nominal', label: 'Доходность вложений', unit: '% год.', def: 12, step: 0.5 },
      ],
      compute(v) {
        let steps;
        if (v.mode === 'history') {
          const a = Math.min(+v.from, +v.to), b = Math.max(+v.from, +v.to);
          steps = CPI_YEARS.filter((y) => y >= a && y <= b).map((y) => ({ label: String(y), rate: CPI[y] }));
        } else steps = Array.from({ length: Math.max(1, Math.round(v.years)) }, (_, k) => ({ label: `${k + 1} г.`, rate: v.rate }));
        let idx = 1;
        const rows = steps.map((s) => { idx *= 1 + s.rate / 100; return { ...s, index: idx }; });
        const total = (idx - 1) * 100, n = rows.length, avg = (Math.pow(idx, 1 / n) - 1) * 100;
        const real = ((1 + v.nominal / 100) / (1 + avg / 100) - 1) * 100;
        return {
          cards: [
            { label: 'Нужно сейчас, чтобы купить то же', value: rub(v.amount * idx), tone: 'accent', big: true, sub: `цены выросли на ${pct(total, 1)}` },
            { label: 'Покупательная способность', value: rub(v.amount / idx), tone: 'down', sub: `столько стоит ${rub(v.amount)} в ценах начала периода` },
            { label: 'Средняя инфляция', value: pct(avg), sub: `за ${n} ${U.plural(n, ['год', 'года', 'лет'])}` },
            { label: 'Реальная доходность', value: pct(real), tone: real >= 0 ? 'up' : 'down', sub: `при доходности вложений ${pct(v.nominal, 1)}` },
          ],
          chart: stackedBars(rows.map((r) => r.label), [{ name: 'Сумма с учётом инфляции', color: 'warn', values: rows.map((r) => v.amount * r.index) }]),
          table: { head: ['Год', 'Инфляция', 'Рост цен с начала', 'Эквивалент суммы'], rows: rows.map((r) => [r.label, pct(r.rate, 1), pct((r.index - 1) * 100, 1), rub(v.amount * r.index)]) },
          note: v.mode === 'history' ? 'Годовая инфляция декабрь к декабрю по данным Росстата, 2010–2024.' : 'Инфляция постоянная каждый год.',
        };
      },
    },
  };
  const ORDER = ['compound', 'mortgage', 'prepay', 'goal', 'refi', 'bond', 'fx', 'inflation'];

  /* =====================================================================
     Состояние и рендер
     ===================================================================== */
  let current = U.store.get('calc:current', 'compound');
  const values = {};
  const valuesOf = (id) => (values[id] ||= { ...Object.fromEntries(CALCS[id].fields.map((f) => [f.id, f.def])), ...U.store.get('calc:' + id, {}) });
  let root = null;

  function fieldHtml(id, f, v) {
    const fid = `calc-${id}-${f.id}`;
    if (f.when && !f.when(v)) return '';
    if (f.type === 'seg') {
      return `<div class="calc-field"><span class="calc-label">${f.label}</span>
        <div class="seg flex-wrap" data-field="${f.id}">${f.options.map(([val, l]) => `<button type="button" data-v="${val}" class="${String(v[f.id]) === val ? 'active' : ''}">${l}</button>`).join('')}</div></div>`;
    }
    if (f.type === 'select' || f.type === 'currency') {
      const opts = f.type === 'currency'
        ? (rates ? Object.keys(rates).filter((k) => !k.startsWith('_')).sort((a, b) => (a === 'RUB' ? -1 : b === 'RUB' ? 1 : a.localeCompare(b))).map((c) => [c, `${c} — ${rates[c].name}`]) : [[v[f.id], v[f.id]]])
        : f.options;
      return `<label class="calc-field" for="${fid}"><span class="calc-label">${f.label}</span>
        <select id="${fid}" class="input w-full" data-field="${f.id}">${opts.map(([val, l]) => `<option value="${val}" ${String(v[f.id]) === val ? 'selected' : ''}>${U.escape(l)}</option>`).join('')}</select></label>`;
    }
    return `<label class="calc-field" for="${fid}"><span class="calc-label">${f.label}</span>
      <span class="relative block"><input id="${fid}" class="input w-full num pr-16" type="text" inputmode="decimal" autocomplete="off" data-field="${f.id}" value="${String(v[f.id]).replace('.', ',')}">
      ${f.unit ? `<span class="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted pointer-events-none">${f.unit}</span>` : ''}</span></label>`;
  }

  function prefillHtml() {
    const bonds = bondsGetter().filter((b) => b.coupon > 0 && b.currency !== 'CNY' && b.kind !== 'float');
    if (!bonds.length) return '';
    const top = [...bonds].sort((a, b) => (b.turnover || 0) - (a.turnover || 0)).slice(0, 60).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return `<label class="calc-field sm:col-span-2" for="calc-bond-pick"><span class="calc-label">Подставить выпуск с биржи</span>
      <select id="calc-bond-pick" class="input w-full" data-pick><option value="">— выбрать облигацию —</option>${top.map((b) => `<option value="${b.isin}">${U.escape(b.name)} · YTM ${U.price(b.ytm, 1)}%</option>`).join('')}</select></label>`;
  }

  function render(id) {
    if (!root) return;
    if (id && CALCS[id]) current = id;
    U.store.set('calc:current', current);
    const c = CALCS[current], v = valuesOf(current);
    if (current === 'fx') loadRates();
    root.innerHTML = `
      <div class="calc-tabs" role="tablist" aria-label="Калькуляторы">
        ${ORDER.map((k) => `<a href="#calc/${k}" role="tab" aria-selected="${k === current}" class="calc-tab ${k === current ? 'active' : ''}"><i data-lucide="${CALCS[k].icon}" class="w-4 h-4"></i>${CALCS[k].title}</a>`).join('')}
      </div>
      <div class="grid gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">
        <form class="card self-start" id="calc-form" onsubmit="return false">
          <h2 class="text-lg font-semibold">${c.title}</h2>
          <p class="text-sm text-muted mt-1">${c.desc}</p>
          <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            ${c.prefill ? prefillHtml() : ''}
            <div class="contents" id="calc-fields">${c.fields.map((f) => fieldHtml(current, f, v)).join('')}</div>
          </div>
          <div class="mt-4 flex gap-2">
            ${current === 'fx' ? '<button type="button" class="chip" data-swap>⇄ Поменять валюты</button>' : ''}
            <button type="button" class="chip" data-reset>Сбросить</button>
          </div>
        </form>
        <div id="calc-result" class="min-w-0 space-y-5"></div>
      </div>`;
    renderResult();
    U.icons();
  }

  function renderResult() {
    const c = CALCS[current], v = valuesOf(current);
    const el = $('#calc-result', root);
    let r;
    try { r = c.compute(v); } catch (e) { console.error(e); r = { cards: [{ label: 'Ошибка расчёта', value: 'Проверьте введённые значения' }] }; }
    if (r.loading) { el.innerHTML = '<div class="card"><span class="skeleton h-24 w-full block"></span></div>'; return; }
    const toneCls = { accent: 'text-accent', up: 'text-up', down: 'text-down', warn: 'text-warn' };
    el.innerHTML = `
      <div class="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        ${(r.cards || []).map((k) => `
          <div class="card ${k.big ? 'calc-hero' : ''}">
            <div class="text-xs text-muted">${k.label}</div>
            <div class="mt-1.5 ${k.big ? 'text-2xl' : 'text-lg'} font-semibold num ${toneCls[k.tone] || ''}">${k.value}</div>
            ${k.sub ? `<div class="mt-1 text-xs text-muted">${k.sub}</div>` : ''}
          </div>`).join('')}
      </div>
      ${r.chart ? `<div class="card">${r.chart}</div>` : ''}
      ${r.table ? `<div class="card !p-0"><div class="table-wrap calc-table"><table class="data-table">
        <thead><tr>${r.table.head.map((h, i) => `<th class="${i === 0 ? 'text-left' : ''}">${h}</th>`).join('')}</tr></thead>
        <tbody>${r.table.rows.map((row) => `<tr>${row.map((cell, i) => `<td class="${i === 0 ? '!text-left font-medium' : ''}">${cell}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div></div>` : ''}
      ${r.note ? `<p class="text-xs text-muted">${r.note} Расчёт справочный.</p>` : ''}`;
  }

  /** Поля с условием показа (when) перерисовываем целиком, остальное — только результат. */
  function rerenderFields() {
    const c = CALCS[current], v = valuesOf(current);
    $('#calc-fields', root).innerHTML = c.fields.map((f) => fieldHtml(current, f, v)).join('');
  }

  const renderLater = U.debounce(() => renderResult(), 120);

  /** Значение сохраняем сразу (иначе быстрый ввод в два поля теряет первое), перерисовку числовых полей откладываем. */
  function onChange(field, raw) {
    const c = CALCS[current], v = valuesOf(current), f = c.fields.find((x) => x.id === field);
    if (!f) return;
    if (!f.type) {
      let x = U.parseNum(raw) ?? 0;
      if (f.min != null) x = Math.max(f.min, x);   // ограничения поля (например, срок не меньше года)
      if (f.max != null) x = Math.min(f.max, x);
      v[field] = x;
    } else v[field] = raw;
    U.store.set('calc:' + current, v);
    if (!f.type) { renderLater(); return; }
    if (c.fields.some((x) => x.when)) rerenderFields();   // только переключатели меняют набор полей
    renderResult();
  }

  function bind() {
    root.addEventListener('input', (e) => {
      const el = e.target;
      if (el.matches('input[data-field]')) { U.cleanNumInput(el); onChange(el.dataset.field, el.value); }
    });
    root.addEventListener('change', (e) => {
      const el = e.target;
      if (el.matches('select[data-field]')) onChange(el.dataset.field, el.value);
      if (el.matches('[data-pick]') && el.value) {
        const b = bondsGetter().find((x) => x.isin === el.value);
        if (!b) return;
        const freq = b.couponPeriod ? Math.round(365 / b.couponPeriod) : 2;
        Object.assign(valuesOf('bond'), {
          price: +b.price.toFixed(2), nominal: b.nominal || 1000, coupon: b.coupon,
          freq: String([12, 4, 2, 1].reduce((best, x) => (Math.abs(x - freq) < Math.abs(best - freq) ? x : best), 2)),
          years: +b.yearsToMaturity.toFixed(2),
        });
        U.store.set('calc:bond', valuesOf('bond'));
        rerenderFields(); renderResult();
      }
    });
    root.addEventListener('click', (e) => {
      const s = e.target.closest('[data-field] [data-v]');
      if (s) { onChange(s.closest('[data-field]').dataset.field, s.dataset.v); $$('[data-v]', s.parentElement).forEach((b) => b.classList.toggle('active', b === s)); return; }
      if (e.target.closest('[data-reset]')) { delete values[current]; U.store.set('calc:' + current, {}); render(); return; }
      if (e.target.closest('[data-swap]')) { const v = valuesOf('fx'); [v.from, v.to] = [v.to, v.from]; U.store.set('calc:fx', v); render(); }
    });
  }

  /** Курсы для конвертера: ЦБ РФ (через API) или демо-курсы. */
  function loadRates() {
    if (rates || ratesLoad) return;
    ratesLoad = FP.API.getRates().then((r) => { rates = r; if (current === 'fx') render(); })
      .catch((e) => { console.warn('[FinPulse] rates:', e); rates = { RUB: { rate: 1, name: 'Российский рубль' }, _source: 'Курсы недоступны' }; if (current === 'fx') render(); });
  }

  return {
    init(el, { getBonds } = {}) { root = el; if (getBonds) bondsGetter = getBonds; bind(); },
    render: (id) => render(id),
  };
})();
