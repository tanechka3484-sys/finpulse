/**
 * FinPulse — моковые данные.
 *
 * Структуры повторяют то, что обычно отдают рыночные API, чтобы
 * подключение реального источника свелось к маппингу полей в api.js:
 *
 *   stocks    ~ MOEX ISS  /iss/engines/stock/markets/shares/boards/TQBR/securities.json
 *               (SECID, SHORTNAME, LAST, LASTTOPREVPRICE, VOLTODAY, ISSUECAPITALIZATION)
 *               либо FMP /api/v3/quote/{symbol}
 *   bonds     ~ MOEX ISS  /iss/engines/stock/markets/bonds/securities.json
 *               (SECID, ISIN, PREVPRICE, YIELD, COUPONPERCENT, COUPONPERIOD, MATDATE, DURATION)
 *   dividends ~ MOEX ISS  /iss/securities/{SECID}/dividends.json  или FMP /stock_dividend_calendar
 *   news      ~ любой новостной API (Alpha Vantage NEWS_SENTIMENT и т.п.)
 *
 * Все цифры — демонстрационные. Даты событий задаются смещением
 * от текущего дня, поэтому календарь всегда выглядит «живым».
 */
window.FP = window.FP || {};

FP.MOCK = (() => {
  'use strict';
  const D = FP.U.daysFromToday;
  const MIN = 60 * 1000;
  const now = Date.now();

  /** Индексы, валюты, сырьё и крипта для бегущей строки. */
  const indices = [
    { symbol: 'IMOEX', name: 'Индекс МосБиржи', value: 2845.32, changePct: 0.84, kind: 'index' },
    { symbol: 'RTSI', name: 'Индекс РТС', value: 1012.47, changePct: 0.61, kind: 'index' },
    { symbol: 'SPX', name: 'S&P 500', value: 6652.18, changePct: -0.32, kind: 'index' },
    { symbol: 'NDX', name: 'NASDAQ 100', value: 24410.6, changePct: -0.58, kind: 'index' },
    { symbol: 'USD/RUB', name: 'Доллар США', value: 81.46, changePct: -0.27, kind: 'fx' },
    { symbol: 'EUR/RUB', name: 'Евро', value: 94.72, changePct: 0.12, kind: 'fx' },
    { symbol: 'CNY/RUB', name: 'Юань', value: 11.38, changePct: -0.09, kind: 'fx' },
    { symbol: 'BRENT', name: 'Нефть Brent', value: 66.34, changePct: 1.42, kind: 'commodity' },
    { symbol: 'GOLD', name: 'Золото', value: 4208.5, changePct: 0.36, kind: 'commodity' },
    { symbol: 'BTC/USD', name: 'Bitcoin', value: 108450, changePct: 2.17, kind: 'crypto' },
    { symbol: 'ETH/USD', name: 'Ethereum', value: 3962.4, changePct: 1.64, kind: 'crypto' },
  ];

  /**
   * Акции. price/changePct — текущая котировка; volume — объём в штуках за день;
   * volatility — дневная волатильность (используется генератором истории).
   */
  const stocks = [
    { ticker: 'SBER', name: 'Сбербанк', isin: 'RU0009029540', sector: 'Финансы', price: 312.45, changePct: 1.24, volume: 45_200_000, marketCap: 6.74e12, pe: 4.3, eps: 72.6, divYield: 11.2, beta: 1.05, lot: 10, volatility: 0.016 },
    { ticker: 'T', name: 'Т-Технологии', isin: 'RU000A107UL4', sector: 'Финансы', price: 3185.0, changePct: -0.85, volume: 1_240_000, marketCap: 0.85e12, pe: 7.9, eps: 403.1, divYield: 2.9, beta: 1.32, lot: 1, volatility: 0.021 },
    { ticker: 'MOEX', name: 'Московская Биржа', isin: 'RU000A0JR4A1', sector: 'Финансы', price: 198.62, changePct: 0.42, volume: 9_100_000, marketCap: 0.45e12, pe: 5.6, eps: 35.5, divYield: 8.8, beta: 0.82, lot: 10, volatility: 0.015 },
    { ticker: 'GAZP', name: 'Газпром', isin: 'RU0007661625', sector: 'Энергетика', price: 128.94, changePct: -2.15, volume: 61_500_000, marketCap: 3.05e12, pe: 3.1, eps: 41.6, divYield: 0, beta: 1.12, lot: 10, volatility: 0.019 },
    { ticker: 'LKOH', name: 'Лукойл', isin: 'RU0009024277', sector: 'Энергетика', price: 6940.5, changePct: 0.65, volume: 920_000, marketCap: 4.81e12, pe: 5.2, eps: 1334.7, divYield: 13.1, beta: 0.91, lot: 1, volatility: 0.014 },
    { ticker: 'ROSN', name: 'Роснефть', isin: 'RU000A0J2Q06', sector: 'Энергетика', price: 452.3, changePct: -1.1, volume: 6_200_000, marketCap: 4.79e12, pe: 5.1, eps: 88.7, divYield: 9.8, beta: 0.97, lot: 1, volatility: 0.016 },
    { ticker: 'NVTK', name: 'Новатэк', isin: 'RU000A0DKVS5', sector: 'Энергетика', price: 1124.2, changePct: 2.8, volume: 2_150_000, marketCap: 3.41e12, pe: 6.4, eps: 175.7, divYield: 7.5, beta: 1.08, lot: 1, volatility: 0.02 },
    { ticker: 'YDEX', name: 'Яндекс', isin: 'RU000A107T19', sector: 'IT', price: 4210.0, changePct: 3.45, volume: 1_830_000, marketCap: 1.6e12, pe: 14.8, eps: 284.5, divYield: 1.9, beta: 1.41, lot: 1, volatility: 0.022 },
    { ticker: 'HEAD', name: 'Хэдхантер', isin: 'RU000A107662', sector: 'IT', price: 3560.0, changePct: -0.3, volume: 310_000, marketCap: 0.18e12, pe: 9.1, eps: 391.2, divYield: 15.2, beta: 1.18, lot: 1, volatility: 0.019 },
    { ticker: 'POSI', name: 'Positive Technologies', isin: 'RU000A103X66', sector: 'IT', price: 1215.4, changePct: -3.2, volume: 905_000, marketCap: 0.087e12, pe: 18.4, eps: 66.1, divYield: 4.1, beta: 1.55, lot: 1, volatility: 0.025 },
    { ticker: 'MGNT', name: 'Магнит', isin: 'RU000A0JKQU8', sector: 'Ритейл', price: 4880.0, changePct: 0.9, volume: 452_000, marketCap: 0.5e12, pe: 6.1, eps: 800.0, divYield: 8.6, beta: 0.88, lot: 1, volatility: 0.017 },
    { ticker: 'X5', name: 'Корпоративный центр ИКС 5', isin: 'RU000A108X38', sector: 'Ритейл', price: 3020.0, changePct: -0.6, volume: 705_000, marketCap: 0.82e12, pe: 7.3, eps: 413.7, divYield: 12.0, beta: 0.79, lot: 1, volatility: 0.016 },
    { ticker: 'OZON', name: 'Озон', isin: 'RU000A10CW95', sector: 'Ритейл', price: 4150.0, changePct: 1.85, volume: 1_120_000, marketCap: 0.89e12, pe: null, eps: -12.4, divYield: 0, beta: 1.47, lot: 1, volatility: 0.023 },
  ];

  /**
   * Облигации. price — % от номинала, ytm — доходность к погашению (% год.),
   * coupon — ставка купона (% год.), couponPeriod — дней между выплатами,
   * duration — дюрация Маколея (лет). ISIN — демонстрационные.
   */
  const bonds = [
    { isin: 'RU000A0ZYUA9', secid: 'SU26207RMFS9', name: 'ОФЗ 26207', issuer: 'Минфин России', type: 'ofz', price: 98.21, ytm: 15.62, coupon: 8.15, couponPeriod: 182, maturity: '2027-02-03', duration: 0.29, rating: 'AAA', nominal: 1000 },
    { isin: 'RU000A103BR0', secid: 'SU26241RMFS0', name: 'ОФЗ 26241', issuer: 'Минфин России', type: 'ofz', price: 85.34, ytm: 14.41, coupon: 9.5, couponPeriod: 182, maturity: '2032-11-17', duration: 4.62, rating: 'AAA', nominal: 1000 },
    { isin: 'RU000A108EH4', secid: 'SU26245RMFS9', name: 'ОФЗ 26245', issuer: 'Минфин России', type: 'ofz', price: 94.12, ytm: 14.28, coupon: 12.0, couponPeriod: 182, maturity: '2035-09-26', duration: 5.84, rating: 'AAA', nominal: 1000 },
    { isin: 'RU000A101QE0', secid: 'SU26240RMFS2', name: 'ОФЗ 26240', issuer: 'Минфин России', type: 'ofz', price: 66.48, ytm: 14.66, coupon: 7.0, couponPeriod: 182, maturity: '2036-07-30', duration: 6.12, rating: 'AAA', nominal: 1000 },
    { isin: 'RU000A106E90', secid: 'SU26243RMFS4', name: 'ОФЗ 26243', issuer: 'Минфин России', type: 'ofz', price: 72.41, ytm: 14.87, coupon: 9.8, couponPeriod: 182, maturity: '2038-05-19', duration: 6.81, rating: 'AAA', nominal: 1000 },
    { isin: 'RU000A1038V6', secid: 'SU26238RMFS4', name: 'ОФЗ 26238', issuer: 'Минфин России', type: 'ofz', price: 61.2, ytm: 14.62, coupon: 7.1, couponPeriod: 182, maturity: '2041-05-15', duration: 7.94, rating: 'AAA', nominal: 1000 },
    { isin: 'RU000A10A7K1', secid: 'RU000A10A7K1', name: 'Сбербанк 002Р-07', issuer: 'ПАО Сбербанк', type: 'corp', price: 99.84, ytm: 18.12, coupon: 17.5, couponPeriod: 30, maturity: '2028-03-15', duration: 1.31, rating: 'AAA', nominal: 1000 },
    { isin: 'RU000A10B2L5', secid: 'RU000A10B2L5', name: 'Газпром Капитал БО-001Р-08', issuer: 'ООО «Газпром капитал»', type: 'corp', price: 101.2, ytm: 17.24, coupon: 16.8, couponPeriod: 91, maturity: '2029-06-01', duration: 2.21, rating: 'AAA', nominal: 1000 },
    { isin: 'RU000A10C1R2', secid: 'RU000A10C1R2', name: 'РЖД 001Р-32R', issuer: 'ОАО «РЖД»', type: 'corp', price: 97.52, ytm: 17.03, coupon: 15.9, couponPeriod: 91, maturity: '2030-04-10', duration: 2.94, rating: 'AAA', nominal: 1000 },
    { isin: 'RU000A10A3Z4', secid: 'RU000A10A3Z4', name: 'МТС 002Р-05', issuer: 'ПАО «МТС»', type: 'corp', price: 99.1, ytm: 19.41, coupon: 18.2, couponPeriod: 30, maturity: '2027-12-08', duration: 1.02, rating: 'AA+', nominal: 1000 },
    { isin: 'RU000A10AB34', secid: 'RU000A10AB34', name: 'Самолёт БО-П13', issuer: 'ГК «Самолёт»', type: 'corp', price: 94.25, ytm: 26.31, coupon: 21.5, couponPeriod: 30, maturity: '2028-01-12', duration: 1.08, rating: 'A', nominal: 1000 },
    { isin: 'RU000A107K81', secid: 'RU000A107K81', name: 'Сегежа 003P-02R', issuer: 'ПАО «Сегежа Групп»', type: 'corp', price: 82.4, ytm: 38.52, coupon: 20.0, couponPeriod: 30, maturity: '2027-07-21', duration: 0.69, rating: 'BBB-', nominal: 1000 },
  ];

  /**
   * Дивиденды. exDate — дата отсечки (закрытия реестра), paymentDate — ориентир по выплате,
   * status: 'approved' (одобрено СД/собранием акционеров) | 'recommended' (рекомендовано СД).
   */
  const dividends = [
    { ticker: 'X5', amount: 368.0, currency: 'RUB', period: '9 мес. 2026', exDate: D(6), paymentDate: D(20), status: 'approved' },
    { ticker: 'T', amount: 92.0, currency: 'RUB', period: '3 кв. 2026', exDate: D(13), paymentDate: D(27), status: 'approved' },
    { ticker: 'NVTK', amount: 51.8, currency: 'RUB', period: '1П 2026', exDate: D(22), paymentDate: D(36), status: 'recommended' },
    { ticker: 'HEAD', amount: 233.0, currency: 'RUB', period: '1П 2026', exDate: D(31), paymentDate: D(45), status: 'recommended' },
    { ticker: 'LKOH', amount: 541.0, currency: 'RUB', period: '9 мес. 2026', exDate: D(48), paymentDate: D(68), status: 'recommended' },
    { ticker: 'MGNT', amount: 214.1, currency: 'RUB', period: '9 мес. 2026', exDate: D(57), paymentDate: D(71), status: 'recommended' },
    { ticker: 'ROSN', amount: 11.56, currency: 'RUB', period: '9 мес. 2026', exDate: D(74), paymentDate: D(88), status: 'recommended' },
    { ticker: 'POSI', amount: 49.85, currency: 'RUB', period: '2026', exDate: D(-12), paymentDate: D(2), status: 'approved' },
    { ticker: 'ROSN', amount: 14.68, currency: 'RUB', period: '1П 2026', exDate: D(-38), paymentDate: D(-24), status: 'approved' },
    { ticker: 'LKOH', amount: 514.0, currency: 'RUB', period: '2025 (финальный)', exDate: D(-104), paymentDate: D(-80), status: 'approved' },
    { ticker: 'SBER', amount: 34.84, currency: 'RUB', period: '2025', exDate: D(-97), paymentDate: D(-90), status: 'approved' },
    { ticker: 'MOEX', amount: 26.11, currency: 'RUB', period: '2025', exDate: D(-118), paymentDate: D(-104), status: 'approved' },
    { ticker: 'MGNT', amount: 412.96, currency: 'RUB', period: '2025', exDate: D(-86), paymentDate: D(-72), status: 'approved' },
  ];

  /**
   * Новости. tags: stocks | bonds | macro; impact: positive | negative | neutral.
   * publishedAt — unix ms; tickers — связанные бумаги (кликабельны).
   */
  const news = [
    { id: 'n1', title: 'Сбербанк увеличил чистую прибыль по РПБУ за 9 месяцев на 7% г/г', summary: 'Рост комиссионных доходов и стабильная стоимость риска поддержали результат. Аналитики сохраняют ожидания по выплате 50% прибыли по МСФО в виде дивидендов.', source: 'Интерфакс', publishedAt: now - 14 * MIN, tags: ['stocks'], impact: 'positive', tickers: ['SBER'] },
    { id: 'n2', title: 'ЦБ сохранил ключевую ставку и смягчил риторику', summary: 'Регулятор отметил замедление текущей инфляции и допустил возможность снижения ставки на ближайших заседаниях. Доходности длинных ОФЗ снизились на 10–15 б.п.', source: 'Банк России', publishedAt: now - 42 * MIN, tags: ['macro', 'bonds'], impact: 'positive', tickers: [] },
    { id: 'n3', title: 'Газпром: экспорт в дальнее зарубежье снизился по итогам квартала', summary: 'Поставки остаются ниже прошлогоднего уровня; рынок закладывает отсутствие дивидендов за текущий год. Бумаги — в числе аутсайдеров сессии.', source: 'РБК', publishedAt: now - 75 * MIN, tags: ['stocks'], impact: 'negative', tickers: ['GAZP'] },
    { id: 'n4', title: 'Минфин разместил ОФЗ 26245 на 85 млрд рублей', summary: 'Спрос на аукционе превысил предложение в 1,6 раза, средневзвешенная доходность составила 14,3% годовых. Премия к вторичному рынку минимальна.', source: 'Минфин России', publishedAt: now - 2.2 * 60 * MIN, tags: ['bonds'], impact: 'neutral', tickers: [] },
    { id: 'n5', title: 'Яндекс повысил прогноз роста выручки на 2026 год', summary: 'Компания ожидает увеличения выручки более чем на 30% и рост скорректированной EBITDA. Сегменты рекламы и электронной коммерции ускорились.', source: 'Ведомости', publishedAt: now - 3.1 * 60 * MIN, tags: ['stocks'], impact: 'positive', tickers: ['YDEX'] },
    { id: 'n6', title: 'Инфляция в РФ за неделю составила 0,08%', summary: 'Годовая инфляция продолжает замедляться. Основной вклад внесли плодоовощная продукция и услуги транспорта.', source: 'Росстат', publishedAt: now - 5 * 60 * MIN, tags: ['macro'], impact: 'neutral', tickers: [] },
    { id: 'n7', title: 'Рейтинговое агентство понизило прогноз по «Сегеже» до негативного', summary: 'Высокая долговая нагрузка и слабая конъюнктура на рынке лесопродукции давят на кредитные метрики. Доходность выпусков превысила 38%.', source: 'Эксперт РА', publishedAt: now - 6.5 * 60 * MIN, tags: ['bonds'], impact: 'negative', tickers: [] },
    { id: 'n8', title: 'Совет директоров Новатэка рекомендовал дивиденды за 1П', summary: 'Рекомендованный размер — 51,8 ₽ на акцию, что соответствует доходности около 4,6% за полугодие. Отсечка запланирована через три недели.', source: 'Smart-Lab', publishedAt: now - 8 * 60 * MIN, tags: ['stocks'], impact: 'positive', tickers: ['NVTK'] },
    { id: 'n9', title: 'Нефть Brent превысила $66 за баррель на фоне сокращения запасов', summary: 'Коммерческие запасы нефти в США снизились сильнее прогнозов. Поддержку котировкам нефтяников оказывает ослабление рубля.', source: 'Reuters', publishedAt: now - 10 * 60 * MIN, tags: ['macro'], impact: 'positive', tickers: ['LKOH', 'ROSN'] },
    { id: 'n10', title: 'Positive Technologies снизила прогноз отгрузок на год', summary: 'Менеджмент ожидает отгрузки у нижней границы ранее озвученного диапазона из-за переноса сделок крупных заказчиков на следующий год.', source: 'Коммерсантъ', publishedAt: now - 20 * 60 * MIN, tags: ['stocks'], impact: 'negative', tickers: ['POSI'] },
    { id: 'n11', title: 'X5 утвердила дивиденды за 9 месяцев — 368 ₽ на акцию', summary: 'Последний день для покупки под дивиденды — за день до отсечки. Доходность выплаты превышает 12%.', source: 'Интерфакс', publishedAt: now - 26 * 60 * MIN, tags: ['stocks'], impact: 'positive', tickers: ['X5'] },
    { id: 'n12', title: 'Индекс МосБиржи вернулся выше 2800 пунктов', summary: 'Рост поддержали бумаги финансового сектора и IT. Обороты торгов остаются ниже среднегодовых значений.', source: 'MOEX', publishedAt: now - 30 * 60 * MIN, tags: ['macro', 'stocks'], impact: 'positive', tickers: ['MOEX', 'SBER', 'YDEX'] },
  ];

  return { indices, stocks, bonds, dividends, news };
})();
