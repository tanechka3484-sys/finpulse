/**
 * FinPulse — скринеры акций и облигаций.
 *
 * Акции: страна (по ISIN), отрасль (отраслевые индексы MOEX), капитализация,
 * мультипликаторы P/E, P/B, ROE, долг/EBITDA (справочник js/fundamentals.js),
 * дивидендная доходность и доходность за период.
 * Облигации: тип, валюта, отрасль эмитента, страна, рейтинг, YTM, срок,
 * купон, дюрация, частота выплат, наличие сделок сегодня.
 *
 * Состояние фильтров хранится в браузере. Модуль сам рисует панель фильтров
 * и таблицу; общие кусочки разметки (звёздочка, тикер, котировка) берёт из app.js.
 */
window.FP = window.FP || {};

FP.Screener = (() => {
  'use strict';
  const U = FP.U, F = FP.FUNDAMENTALS;
  const { $, $$ } = U;
  const PAGE = 100;

  const COUNTRIES = {
    RU: 'Россия', US: 'США', CN: 'Китай', HK: 'Гонконг', KZ: 'Казахстан', NL: 'Нидерланды', CY: 'Кипр', GB: 'Великобритания',
    JE: 'Джерси', KY: 'Каймановы о-ва', VG: 'Брит. Виргинские о-ва', DE: 'Германия', IE: 'Ирландия', LU: 'Люксембург', BY: 'Беларусь',
    AM: 'Армения', UZ: 'Узбекистан', KG: 'Киргизия', TW: 'Тайвань', KR: 'Корея', IN: 'Индия', JP: 'Япония', CH: 'Швейцария', FR: 'Франция',
  };
  const countryName = (c) => COUNTRIES[c] || c;

  /** Отрасль эмитента облигации по названию выпуска (облигационные данные MOEX отрасль не содержат). */
  const BOND_SECTORS = [
    ['Госсектор', /^ОФЗ/i],
    ['Субфедеральные', /област|республик|москва|город|край|округ|^мос|^спб|санкт-петербург|ханты|ямал/i],
    ['Банки', /банк|сбер|втб|альфа|совком|мкб|россельхоз|т-банк|тинькофф|дом\.рф|открытие|уралсиб|росбанк/i],
    ['Нефть и газ', /газпр|лукойл|роснефт|рснфт|новатэк|татнефт|транснефт|сибур|нефт/i],
    ['Металлы и добыча', /норникел|гмк|северстал|нлмк|ммк|русал|полюс|металлоинв|евраз|мечел|алроса|селигдар|уралкал/i],
    ['Телеком и IT', /мтс|ростелек|мегафон|вк\b|vk|яндекс|ozon|озон|селектел|позитив/i],
    ['Транспорт', /ржд|аэрофлот|гтлк|совкомфлот|глобалтранс|флот|авто/i],
    ['Девелопмент', /самолет|самолёт|пик|эталон|лср|брусника|джи-групп|девелоп/i],
    ['Электроэнергетика', /россет|русгидро|интер рао|фск|энерг|мосэнерго|тгк|огк/i],
    ['Лизинг и МФО', /лизинг|европлан|мфк|займер|микрофин|балтлиз|фабрика/i],
    ['Ритейл', /магнит|x5|икс 5|лента|м\.видео|детский мир|фикс прайс|вайлдберриз/i],
    ['Химия', /фосагро|акрон|еврохим|уралхим|химия/i],
  ];
  const bondSector = (b) => (b._sector ||= (BOND_SECTORS.find(([, re]) => re.test(`${b.name} ${b.issuer}`)) || ['Прочее'])[0]);

  const CAP = { all: 'Любая', small: 'до 50 млрд', mid: '50–500 млрд', large: 'от 500 млрд' };
  const capOk = (cap, v) => cap === 'all' || (v != null && (cap === 'small' ? v < 50e9 : cap === 'mid' ? v >= 50e9 && v < 500e9 : v >= 500e9));

  /** Готовые наборы фильтров. */
  const STOCK_PRESETS = {
    dividend: { label: 'Дивидендные', set: { divMin: 8 } },
    value: { label: 'Недооценённые', set: { peMax: 6, pbMax: 1 } },
    quality: { label: 'Качество', set: { roeMin: 20, ndMax: 1.5 } },
    momentum: { label: 'Растут за год', set: { r1yMin: 20 } },
    large: { label: 'Голубые фишки', set: { cap: 'large' } },
  };
  const BOND_PRESETS = {
    ofzLong: { label: 'Длинные ОФЗ', set: { type: 'ofz', yearsMin: 8 } },
    reliable: { label: 'Надёжные корп.', set: { type: 'corp', rating: 'AAA' } },
    monthly: { label: 'Ежемесячный купон', set: { freq: 30 } },
    high: { label: 'Высокая доходность', set: { ytmMin: 22 } },
    short: { label: 'Короткие до 2 лет', set: { yearsMax: 2 } },
    yuan: { label: 'Юаневые', set: { currencies: ['CNY'] } },
  };

  const STOCK_DEFAULT = { q: '', countries: [], sectors: [], cap: 'all', peMax: '', pbMax: '', roeMin: '', ndMax: '', divMin: '', r1yMin: '', sort: { key: 'marketCap', dir: -1 }, limit: PAGE };
  const BOND_DEFAULT = { q: '', type: 'all', currencies: [], sectors: [], countries: [], rating: 'all', ytmMin: '', ytmMax: '', yearsMin: '', yearsMax: '', couponMin: '', durMax: '', freq: 'all', traded: false, sort: { key: 'ytm', dir: -1 }, limit: PAGE };

  const load = (k, def) => ({ ...def, ...U.store.get(k, {}), limit: PAGE });
  const save = (k, st) => { const { limit, ...rest } = st; U.store.set(k, rest); };
  const n = (v) => (v === '' || v == null || Number.isNaN(+v) ? null : +v);

  const sorter = ({ key, dir }) => (a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;            // пустые значения — всегда в конце
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y, 'ru') : x - y) * dir;
  };

  /* ---------------- Общие кусочки панели ---------------- */
  const chips = (field, items, selected) => items.map(([v, label, cnt]) =>
    `<button type="button" class="chip ${selected.includes(v) ? 'active' : ''}" data-chip="${field}" data-v="${U.escape(v)}">${U.escape(label)}${cnt != null ? ` <span class="opacity-60">${cnt}</span>` : ''}</button>`).join('');
  const seg = (field, opts, value) => `<div class="seg" data-seg="${field}">${(Array.isArray(opts) ? opts : Object.entries(opts)).map(([v, l]) =>
    `<button type="button" data-v="${v}" class="${String(value) === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const numInput = (id, field, label, value, unit = '', step = '0.1') => `
    <label class="scr-num" for="${id}"><span>${label}</span>
      <span class="flex items-center gap-1"><input id="${id}" class="input input-num !w-20" type="number" step="${step}" inputmode="decimal" data-num="${field}" value="${U.escape(value)}" placeholder="—"><span class="text-muted text-xs w-6">${unit}</span></span>
    </label>`;
  const group = (title, body) => `<div class="scr-group"><div class="scr-label">${title}</div><div class="flex flex-wrap gap-1.5 items-center">${body}</div></div>`;
  const countBy = (rows, fn) => { const m = new Map(); rows.forEach((r) => { const k = fn(r); m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()].sort((a, b) => b[1] - a[1]); };

  /** Подключает обработчики к контейнеру скринера. */
  function wire(root, st, key, render, renderTable, presets, defaults) {
    root.addEventListener('click', (e) => {
      const c = e.target.closest('[data-chip]');
      if (c) {
        const f = c.dataset.chip, v = c.dataset.v;
        st[f] = st[f].includes(v) ? st[f].filter((x) => x !== v) : [...st[f], v];
        st.limit = PAGE; save(key, st); render(); return;
      }
      const sg = e.target.closest('[data-seg] [data-v]');
      if (sg) {
        const f = sg.closest('[data-seg]').dataset.seg, v = sg.dataset.v;
        st[f] = /^\d+$/.test(v) ? +v : v;
        st.limit = PAGE; save(key, st); render(); return;
      }
      const pr = e.target.closest('[data-preset]');
      if (pr) {
        Object.assign(st, structuredClone(defaults), { sort: st.sort }, structuredClone(presets[pr.dataset.preset].set));
        save(key, st); render(); return;
      }
      if (e.target.closest('[data-reset]')) { Object.assign(st, structuredClone(defaults)); save(key, st); render(); return; }
      if (e.target.closest('[data-more]')) { st.limit += PAGE; renderTable(); return; }
      if (e.target.closest('[data-toggle-filters]')) { root.querySelector('.scr-panel').classList.toggle('open'); return; }
      const th = e.target.closest('th[data-sort]');
      if (th) {
        const k = th.dataset.sort;
        st.sort = { key: k, dir: st.sort.key === k ? -st.sort.dir : (['name', 'ticker', 'sector', 'country', 'maturity', 'currency'].includes(k) ? 1 : -1) };
        save(key, st); renderTable();
      }
    });
    // Значение сохраняем сразу (иначе быстрый ввод в два поля теряет первое), таблицу перерисовываем с задержкой
    const redraw = U.debounce(() => renderTable(true), 150);
    const onInput = (e) => {
      const el = e.target;
      if (el.dataset.num) st[el.dataset.num] = el.value;
      else if (el.dataset.q != null) st.q = el.value;
      else if (el.dataset.check) st[el.dataset.check] = el.checked;
      else return;
      st.limit = PAGE; save(key, st); redraw();
    };
    root.addEventListener('input', onInput);
    root.addEventListener('change', (e) => { if (e.target.dataset.check) onInput(e); });
  }

  const thead = (cols, sort) => `<tr>${cols.map(([k, label, cls = '', title = '']) =>
    `<th ${k ? `data-sort="${k}"` : ''} class="${cls} ${k && sort.key === k ? `sorted ${sort.dir > 0 ? 'asc' : ''}` : ''}" ${title ? `title="${title}"` : ''}>${label}</th>`).join('')}</tr>`;

  /* ===================================================================
     Скринер акций
     =================================================================== */
  const S = { st: load('scr:stocks', STOCK_DEFAULT), rows: [], ui: null, root: null };

  function stockRows() {
    return S.rows.map((s) => {
      const r = F.ratios(s.ticker, s.price);
      return Object.assign(s, {
        pe: r.live ? r.pe : r.pe ?? s.pe ?? null, pb: r.pb, roe: r.roe, ndEbitda: r.ndEbitda, margin: r.margin, fundRef: r.ref,
        divYield: r.live && r.divYield != null ? r.divYield : s.divYield, turnover: s.price * s.volume,
      });
    });
  }

  function filterStocks(rows) {
    const st = S.st, q = st.q.trim().toLowerCase();
    const lim = { peMax: n(st.peMax), pbMax: n(st.pbMax), roeMin: n(st.roeMin), ndMax: n(st.ndMax), divMin: n(st.divMin), r1yMin: n(st.r1yMin) };
    return rows.filter((s) =>
      (!q || s.ticker.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || String(s.isin || '').toLowerCase().includes(q))
      && (!st.countries.length || st.countries.includes(s.country))
      && (!st.sectors.length || st.sectors.includes(s.sector))
      && capOk(st.cap, s.marketCap)
      && (lim.peMax == null || (s.pe != null && s.pe <= lim.peMax))
      && (lim.pbMax == null || (s.pb != null && s.pb <= lim.pbMax))
      && (lim.roeMin == null || (s.roe != null && s.roe >= lim.roeMin))
      && (lim.ndMax == null || (s.ndEbitda != null && s.ndEbitda <= lim.ndMax))
      && (lim.divMin == null || (s.divYield != null && s.divYield >= lim.divMin))
      && (lim.r1yMin == null || (s.r1y != null && s.r1y >= lim.r1yMin)));
  }

  function renderStocks() {
    const root = S.root;
    if (!root || !S.rows.length) return;
    const st = S.st, all = stockRows();
    const withFund = all.filter((s) => s.fundRef).length;
    $('.scr-panel', root).innerHTML = `
      ${group('Готовые наборы', Object.entries(STOCK_PRESETS).map(([k, p]) => `<button type="button" class="chip" data-preset="${k}">${p.label}</button>`).join(''))}
      ${group('Страна', chips('countries', countBy(all, (s) => s.country).map(([c, k]) => [c, `${c} · ${countryName(c)}`, k]), st.countries))}
      ${group('Отрасль', chips('sectors', countBy(all, (s) => s.sector).map(([c, k]) => [c, c, k]), st.sectors))}
      ${group('Капитализация', seg('cap', CAP, st.cap))}
      <div class="scr-group">
        <div class="scr-label">Фундаментальные показатели ${F.live
          ? `<span class="tag tag-up ml-1" title="${F.source()}">Т-Инвестиции</span>`
          : `<span class="tag tag-warn ml-1" title="${F.asOf}. Сверяйтесь с отчётностью компании.">≈ справочно</span>`}</div>
        <div class="scr-nums">
          ${numInput('scr-pe', 'peMax', 'P/E не выше', st.peMax)}
          ${numInput('scr-pb', 'pbMax', 'P/B не выше', st.pbMax)}
          ${numInput('scr-roe', 'roeMin', 'ROE от', st.roeMin, '%', '1')}
          ${numInput('scr-nd', 'ndMax', 'Долг/EBITDA до', st.ndMax)}
          ${numInput('scr-div', 'divMin', 'Див. доходность от', st.divMin, '%', '0.5')}
          ${numInput('scr-r1y', 'r1yMin', 'Рост за год от', st.r1yMin, '%', '1')}
        </div>
        <p class="text-[11px] text-muted mt-2">Мультипликаторы есть для ${withFund} из ${all.length} бумаг (${F.source()}). Пока задан фильтр по ним, бумаги без данных скрыты.</p>
      </div>`;
    renderStockTable();
  }

  function renderStockTable() {
    const root = S.root, st = S.st, ui = S.ui;
    const all = stockRows();
    const rows = filterStocks(all).sort(sorter(st.sort));
    $('[data-count]', root).textContent = `${rows.length} из ${all.length}`;
    const active = st.countries.length + st.sectors.length + (st.cap !== 'all') + ['peMax', 'pbMax', 'roeMin', 'ndMax', 'divMin', 'r1yMin'].filter((k) => n(st[k]) != null).length + (st.q ? 1 : 0);
    $$('[data-active]', root).forEach((el) => { el.textContent = active ? `Фильтры · ${active}` : 'Фильтры'; });
    $('[data-reset]', root).hidden = !active;
    const f1 = (v, d = 1) => (v == null ? '<span class="text-muted">—</span>' : U.price(v, d));
    const pctCell = (v) => (v == null ? '<span class="text-muted">—</span>' : `<span class="${U.trend(v)}">${U.pct(v)}</span>`);
    const table = $('#stocks-table', root);
    table.querySelector('thead').innerHTML = thead([
      ['', '', 'w-8'], ['ticker', 'Инструмент', 'text-left'], ['country', 'Страна', 'text-left hidden lg:table-cell'], ['sector', 'Отрасль', 'text-left hidden md:table-cell'],
      ['price', 'Цена'], ['changePct', 'Изм.'], ['r1y', '1 год', 'hidden sm:table-cell', 'Доходность за 12 месяцев'], ['marketCap', 'Капит.', 'hidden md:table-cell'],
      ['pe', 'P/E', '', F.source()], ['pb', 'P/B', 'hidden sm:table-cell', F.source()], ['roe', 'ROE', 'hidden lg:table-cell', F.source()],
      ['ndEbitda', 'Долг/EBITDA', 'hidden xl:table-cell', F.source()], ['divYield', 'Див.', 'hidden md:table-cell', 'Дивидендная доходность за 12 месяцев'],
    ], st.sort);
    table.querySelector('tbody').innerHTML = rows.slice(0, st.limit).map((s) => `
      <tr class="clickable ${s.ticker === ui.selected() ? 'selected' : ''}" data-row="${s.ticker}">
        <td>${ui.starBtn(s.ticker)}</td>
        <td class="!text-left">${ui.instrument(s)}</td>
        <td class="!text-left hidden lg:table-cell"><span class="tag tag-muted" title="${countryName(s.country)}">${s.country}</span></td>
        <td class="!text-left hidden md:table-cell text-muted">${U.escape(s.sector)}</td>
        <td class="font-medium">${ui.qPrice(s)}${s.currency && s.currency !== 'RUB' ? ` <span class="text-[10px] text-muted">${s.currency}</span>` : ''}</td>
        <td>${ui.qPct(s)}</td>
        <td class="hidden sm:table-cell">${pctCell(s.r1y)}</td>
        <td class="hidden md:table-cell text-muted">${U.compact(s.marketCap)}</td>
        <td>${f1(s.pe)}</td>
        <td class="hidden sm:table-cell">${f1(s.pb, 2)}</td>
        <td class="hidden lg:table-cell">${s.roe == null ? f1(null) : `<span class="${s.roe >= 20 ? 'text-up' : s.roe < 0 ? 'text-down' : ''}">${U.pct(s.roe, false)}</span>`}</td>
        <td class="hidden xl:table-cell">${f1(s.ndEbitda)}</td>
        <td class="hidden md:table-cell ${s.divYield >= 10 ? 'text-up font-medium' : ''}">${s.divYield ? U.pct(s.divYield, false) : '<span class="text-muted">—</span>'}</td>
      </tr>`).join('') || `<tr><td colspan="13" class="!text-center !py-10 text-muted">Под фильтры ничего не подходит. Ослабьте условия или нажмите «Сбросить».</td></tr>`;
    $('[data-more]', root).hidden = rows.length <= st.limit;
    $('[data-more]', root).textContent = `Показать ещё (${Math.min(PAGE, rows.length - st.limit)} из ${rows.length - st.limit})`;
    U.icons();
  }

  /* ===================================================================
     Скринер облигаций
     =================================================================== */
  const B = { st: load('scr:bonds', BOND_DEFAULT), rows: [], ui: null, root: null };
  // Массив, а не объект: у объекта числовые ключи всегда идут раньше строковых
  const FREQ = [['all', 'Любые'], ['30', 'Ежемес.'], ['91', 'Ежекв.'], ['182', 'Полугод.']];

  function filterBonds(rows) {
    const st = B.st, q = st.q.trim().toLowerCase();
    const v = { ytmMin: n(st.ytmMin), ytmMax: n(st.ytmMax), yearsMin: n(st.yearsMin), yearsMax: n(st.yearsMax), couponMin: n(st.couponMin), durMax: n(st.durMax) };
    return rows.filter((b) =>
      (!q || [b.name, b.isin, b.secid, b.issuer].some((x) => String(x || '').toLowerCase().includes(q)))
      && (st.type === 'all' || b.type === st.type)
      && (!st.currencies.length || st.currencies.includes(b.currency))
      && (!st.sectors.length || st.sectors.includes(bondSector(b)))
      && (!st.countries.length || st.countries.includes(b.country))
      && (st.rating === 'all' || b.rating === 'AAA')
      && (v.ytmMin == null || b.ytm >= v.ytmMin) && (v.ytmMax == null || b.ytm <= v.ytmMax)
      && (v.yearsMin == null || b.yearsToMaturity >= v.yearsMin) && (v.yearsMax == null || b.yearsToMaturity <= v.yearsMax)
      && (v.couponMin == null || b.coupon >= v.couponMin)
      && (v.durMax == null || (b.duration != null && b.duration <= v.durMax))
      && (st.freq === 'all' || b.couponPeriod === st.freq || (st.freq === 30 && b.couponPeriod >= 28 && b.couponPeriod <= 31) || (st.freq === 91 && b.couponPeriod >= 89 && b.couponPeriod <= 92))
      && (!st.traded || b.turnover > 0));
  }

  function renderBonds() {
    const root = B.root;
    if (!root || !B.rows.length) return;
    const st = B.st, all = B.rows;
    const countries = countBy(all, (b) => b.country);
    $('.scr-panel', root).innerHTML = `
      ${group('Готовые наборы', Object.entries(BOND_PRESETS).map(([k, p]) => `<button type="button" class="chip" data-preset="${k}">${p.label}</button>`).join(''))}
      ${group('Тип', seg('type', { all: 'Все', ofz: 'ОФЗ', corp: 'Корпоративные' }, st.type) + seg('rating', { all: 'Любой рейтинг', AAA: 'Только AAA' }, st.rating))}
      ${group('Валюта', chips('currencies', countBy(all, (b) => b.currency).map(([c, k]) => [c, c, k]), st.currencies))}
      ${group('Отрасль эмитента', chips('sectors', countBy(all, bondSector).map(([c, k]) => [c, c, k]), st.sectors))}
      ${countries.length > 1 ? group('Страна', chips('countries', countries.map(([c, k]) => [c, `${c} · ${countryName(c)}`, k]), st.countries)) : ''}
      ${group('Выплаты купона', seg('freq', FREQ, st.freq))}
      <div class="scr-group">
        <div class="scr-label">Параметры выпуска</div>
        <div class="scr-nums">
          ${numInput('scrb-ytm1', 'ytmMin', 'YTM от', st.ytmMin, '%', '0.5')}
          ${numInput('scrb-ytm2', 'ytmMax', 'YTM до', st.ytmMax, '%', '0.5')}
          ${numInput('scrb-y1', 'yearsMin', 'Срок от', st.yearsMin, 'лет', '0.5')}
          ${numInput('scrb-y2', 'yearsMax', 'Срок до', st.yearsMax, 'лет', '0.5')}
          ${numInput('scrb-cpn', 'couponMin', 'Купон от', st.couponMin, '%', '0.5')}
          ${numInput('scrb-dur', 'durMax', 'Дюрация до', st.durMax, 'лет', '0.5')}
        </div>
        <label class="mt-2 inline-flex items-center gap-2 text-xs text-muted cursor-pointer" for="scrb-traded">
          <input id="scrb-traded" type="checkbox" data-check="traded" ${st.traded ? 'checked' : ''} class="accent-[rgb(var(--c-accent))]"> Только с оборотом сегодня
        </label>
        <p class="text-[11px] text-muted mt-2">Отрасль определяется по названию эмитента. Рейтинг известен только для ОФЗ и нескольких эмитентов уровня AAA.</p>
      </div>`;
    renderBondTable();
  }

  function renderBondTable() {
    const root = B.root, st = B.st, ui = B.ui;
    const rows = filterBonds(B.rows).sort(sorter(st.sort));
    $('[data-count]', root).textContent = `${rows.length} из ${B.rows.length}`;
    const active = (st.type !== 'all') + st.currencies.length + st.sectors.length + st.countries.length + (st.rating !== 'all') + (st.freq !== 'all') + (st.traded ? 1 : 0)
      + ['ytmMin', 'ytmMax', 'yearsMin', 'yearsMax', 'couponMin', 'durMax'].filter((k) => n(st[k]) != null).length + (st.q ? 1 : 0);
    $$('[data-active]', root).forEach((el) => { el.textContent = active ? `Фильтры · ${active}` : 'Фильтры'; });
    $('[data-reset]', root).hidden = !active;
    const q = st.q.trim().toLowerCase();
    const table = $('#bonds-table', root);
    table.querySelector('thead').innerHTML = thead([
      ['name', 'Выпуск', 'text-left'], ['sector', 'Отрасль', 'text-left hidden lg:table-cell'], ['price', 'Цена, %'], ['ytm', 'YTM'], ['coupon', 'Купон'],
      ['couponPeriod', 'Период', 'hidden sm:table-cell'], ['duration', 'Дюрация', 'hidden md:table-cell'], ['maturity', 'Погашение', 'hidden md:table-cell'], ['ratingScore', 'Рейтинг'],
    ], st.sort);
    table.querySelector('tbody').innerHTML = rows.slice(0, st.limit).map((b) => `
      <tr class="clickable" data-bond="${b.isin}">
        <td class="!text-left">
          <div class="flex items-center gap-2.5">
            <span class="ticker-logo" style="background:${b.type === 'ofz' ? 'rgb(var(--c-accent))' : U.logoColor(b.issuer)}">${b.type === 'ofz' ? 'ОФЗ' : U.escape(b.name.slice(0, 3))}</span>
            <div class="min-w-0"><div class="font-semibold leading-tight">${U.highlight(b.name, q)}${b.currency !== 'RUB' ? ` <span class="tag tag-accent">${b.currency}</span>` : ''}${b.kind === 'float' ? ' <span class="tag tag-muted" title="Купон привязан к ставке">флоатер</span>' : b.kind === 'linker' ? ' <span class="tag tag-muted" title="Номинал индексируется на инфляцию">линкер</span>' : ''}</div>
            <div class="text-xs text-muted font-mono">${U.highlight(b.isin, q)}</div></div>
          </div>
        </td>
        <td class="!text-left hidden lg:table-cell text-muted">${b.sector}</td>
        <td>${U.price(b.price)}</td>
        <td class="font-semibold ${b.ytm >= 20 ? 'text-warn' : 'text-up'}">${U.pct(b.ytm, false)}</td>
        <td>${b.coupon ? U.pct(b.coupon, false) : '—'}</td>
        <td class="hidden sm:table-cell">${b.couponPeriod ? `<span class="text-muted">${ui.couponFreq[b.couponPeriod] || ''}</span> ${b.couponPeriod} дн.` : '—'}</td>
        <td class="hidden md:table-cell">${b.duration ? U.price(b.duration) + ' г.' : '—'}</td>
        <td class="hidden md:table-cell"><div>${U.date(b.maturity)}</div><div class="text-xs text-muted">через ${U.price(b.yearsToMaturity, 1)} г.</div></td>
        <td>${ui.ratingTag(b.rating, b.ratingScore)}</td>
      </tr>`).join('') || `<tr><td colspan="9" class="!text-center !py-10 text-muted">Под фильтры ничего не подходит. Ослабьте условия или нажмите «Сбросить».</td></tr>`;
    $('[data-more]', root).hidden = rows.length <= st.limit;
    $('[data-more]', root).textContent = `Показать ещё (${Math.min(PAGE, rows.length - st.limit)} из ${rows.length - st.limit})`;
  }

  /* ---------------- Публичный интерфейс ---------------- */
  return {
    initStocks(root, ui) {
      S.root = root; S.ui = ui;
      wire(root, S.st, 'scr:stocks', renderStocks, renderStockTable, STOCK_PRESETS, STOCK_DEFAULT);
      const q = $('[data-q]', root); q.value = S.st.q;
    },
    setStocks(rows) { S.rows = rows; renderStocks(); },
    /** Фильтр по отрасли из «Обзора рынка». */
    showSector(sector) { Object.assign(S.st, structuredClone(STOCK_DEFAULT), { sort: S.st.sort, sectors: [sector] }); save('scr:stocks', S.st); renderStocks(); },
    refreshStocks() { if (S.rows.length) renderStockTable(true); },
    /** Полная перерисовка (панель + таблица) — например, когда пришли мультипликаторы. */
    rerenderStocks() { renderStocks(); },

    initBonds(root, ui) {
      B.root = root; B.ui = ui;
      wire(root, B.st, 'scr:bonds', renderBonds, renderBondTable, BOND_PRESETS, BOND_DEFAULT);
      const q = $('[data-q]', root); q.value = B.st.q;
    },
    setBonds(rows) { rows.forEach((b) => { b.sector = bondSector(b); }); B.rows = rows; renderBonds(); },
  };
})();
