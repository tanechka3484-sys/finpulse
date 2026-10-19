/**
 * FinPulse — справочник фундаментальных показателей.
 *
 * В открытых API без ключа (MOEX ISS, ЦБ) отчётности компаний нет, поэтому
 * здесь лежат ОРИЕНТИРОВОЧНЫЕ значения по МСФО за 2024 год для основных бумаг.
 * Они нужны, чтобы скринер мог фильтровать по мультипликаторам, и помечаются
 * на сайте как «≈ справочно». Перед решениями сверяйтесь с отчётностью компании.
 *
 * Поля (на акцию — в рублях):
 *   eps        — прибыль на акцию
 *   bvps       — балансовая стоимость (капитал) на акцию
 *   ndEbitda   — чистый долг / EBITDA (отрицательный — чистая денежная позиция; null — для банков не считается)
 *   margin     — рентабельность по чистой прибыли, %
 *
 * Из этих полей и живой цены считаются P/E = цена / EPS, P/B = цена / BVPS, ROE = EPS / BVPS.
 * Чтобы обновить данные или добавить бумагу — допишите строку в DATA.
 */
window.FP = window.FP || {};

FP.FUNDAMENTALS = {
  asOf: 'МСФО 2024, ориентировочно',
  DATA: {
    SBER: { eps: 72.6, bvps: 340, ndEbitda: null, margin: null },
    T: { eps: 403, bvps: 1800, ndEbitda: null, margin: null },
    MOEX: { eps: 35.5, bvps: 114, ndEbitda: null, margin: 57 },
    GAZP: { eps: 51, bvps: 675, ndEbitda: 2.1, margin: 11 },
    LKOH: { eps: 1300, bvps: 9500, ndEbitda: -0.1, margin: 10 },
    ROSN: { eps: 102, bvps: 905, ndEbitda: 1.3, margin: 11 },
    NVTK: { eps: 171, bvps: 950, ndEbitda: 0.2, margin: 36 },
    YDEX: { eps: 284, bvps: 770, ndEbitda: 0.5, margin: 4 },
    HEAD: { eps: 391, bvps: 400, ndEbitda: -1, margin: 40 },
    POSI: { eps: 66, bvps: 210, ndEbitda: 0.6, margin: 20 },
    MGNT: { eps: 800, bvps: 2800, ndEbitda: 1.8, margin: 2.5 },
    X5: { eps: 413, bvps: 890, ndEbitda: 1.0, margin: 2.8 },
    OZON: { eps: -12, bvps: null, ndEbitda: null, margin: -5 },
  },

  /** Мультипликаторы для бумаги при текущей цене (или null-поля, если данных нет). */
  ratios(ticker, price) {
    const f = this.DATA[ticker];
    if (!f) return { pe: null, pb: null, roe: null, ndEbitda: null, margin: null, ref: false };
    return {
      pe: f.eps > 0 && price ? price / f.eps : null,
      pb: f.bvps > 0 && price ? price / f.bvps : null,
      roe: f.bvps > 0 ? f.eps / f.bvps * 100 : null,
      ndEbitda: f.ndEbitda,
      margin: f.margin,
      ref: true,
    };
  },
};
