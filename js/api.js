/**
 * FinPulse — единая точка доступа к данным (MarketAPI).
 *
 * При старте пробует живой источник (MOEX ISS и др., см. sources/live.js).
 * Если он недоступен (нет сети, блокировка CORS/CSP), переключается на
 * демо-генератор (sources/demo.js) — UI работает одинаково, а в шапке
 * показывается, какие данные на экране.
 *
 * Принудительно включить демо: добавить ?demo к адресу страницы.
 */
window.FP = window.FP || {};

FP.API = (() => {
  'use strict';
  let src = null;

  const ready = (async () => {
    const forceDemo = /[?&]demo\b/.test(location.search);
    if (!forceDemo && FP.LiveSource) {
      try {
        await FP.LiveSource.init();
        return (src = FP.LiveSource);
      } catch (e) {
        console.warn('[FinPulse] Живые данные недоступны, включён демо-режим:', e);
      }
    }
    await FP.DemoSource.init();
    return (src = FP.DemoSource);
  })();

  const call = (name) => async (...args) => (await ready)[name](...args);

  return {
    ready,
    INTERVALS: ['1D', '1W', '1M', '1Y', 'ALL'],
    status: () => (src ? src.status() : { mode: 'loading', label: 'Подключение…', updatedAt: null }),

    getIndices: call('getIndices'),
    getStocks: call('getStocks'),
    getBonds: call('getBonds'),
    getDividends: call('getDividends'),
    getNews: call('getNews'),
    getHistory: call('getHistory'),
    getIndexHistory: call('getIndexHistory'),
    getUniverse: call('getUniverse'),
    getRates: call('getRates'),
    getMoreDividends: call('getMoreDividends'),
    getBondSchedule: call('getBondSchedule'),

    // Синхронные методы вызываются только после загрузки акций
    quote: (t) => src && src.quote(t),
    peekHistory: (t, i) => src.peekHistory(t, i),
    yearRange: (t) => src.yearRange(t),
    sparkline: (t, n) => src.sparkline(t, n),

    subscribe(fn) { ready.then((s) => s.subscribe(fn)); },
  };
})();
