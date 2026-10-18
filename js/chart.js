/**
 * FinPulse — обёртка над TradingView Lightweight Charts (v4).
 * Свечи или линия (area) + гистограмма объёмов + OHLC-легенда под курсором.
 */
window.FP = window.FP || {};

FP.PriceChart = class PriceChart {
  constructor(container, legendEl) {
    this.el = container;
    this.legendEl = legendEl;
    this.type = 'candles';
    this.bars = [];
    this.byTime = new Map();
    this.intraday = false;

    const LW = window.LightweightCharts;
    if (!LW) { container.innerHTML = '<p class="p-6 text-sm text-muted">Не удалось загрузить библиотеку графиков.</p>'; return; }

    this.chart = LW.createChart(container, {
      autoSize: true,
      crosshair: { mode: LW.CrosshairMode.Normal },
      rightPriceScale: { scaleMargins: { top: 0.12, bottom: 0.24 } },
      timeScale: { rightOffset: 4, barSpacing: 7, fixLeftEdge: true, lockVisibleTimeRangeOnResize: true },
      localization: { locale: 'ru-RU', priceFormatter: (p) => FP.U.price(p) },
    });

    this.volume = this.chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    this.chart.subscribeCrosshairMove((param) => {
      const bar = param && param.time != null ? this.byTime.get(param.time) : null;
      this.renderLegend(bar || this.bars[this.bars.length - 1]);
    });

    this.applyTheme();
  }

  /** Цвета из CSS-переменных текущей темы. */
  palette() {
    const css = getComputedStyle(document.documentElement);
    const rgb = (n, a = 1) => `rgba(${css.getPropertyValue('--c-' + n).trim().split(/\s+/).join(',')},${a})`;
    return {
      bg: rgb('surface'), text: rgb('muted'), grid: rgb('line', 0.45), border: rgb('line'),
      up: rgb('up'), down: rgb('down'), accent: rgb('accent'),
      upA: rgb('up', 0.45), downA: rgb('down', 0.45), accentTop: rgb('accent', 0.32), accentBottom: rgb('accent', 0.02),
      cross: rgb('muted', 0.6), label: rgb('elevated'),
    };
  }

  applyTheme() {
    if (!this.chart) return;
    const c = this.c = this.palette();
    this.chart.applyOptions({
      layout: { background: { type: 'solid', color: c.bg }, textColor: c.text, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
      crosshair: { vertLine: { color: c.cross, labelBackgroundColor: c.label }, horzLine: { color: c.cross, labelBackgroundColor: c.label } },
    });
    this.buildMainSeries();
    if (this.bars.length) this.setData(this.bars, { intraday: this.intraday, keepRange: true });
  }

  buildMainSeries() {
    const c = this.c;
    if (this.main) this.chart.removeSeries(this.main);
    const fmt = { type: 'price', precision: 2, minMove: 0.01 };
    this.main = this.type === 'candles'
      ? this.chart.addCandlestickSeries({ upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down, borderVisible: false, priceFormat: fmt })
      : this.chart.addAreaSeries({ lineColor: c.accent, topColor: c.accentTop, bottomColor: c.accentBottom, lineWidth: 2, priceFormat: fmt, crosshairMarkerRadius: 4 });
  }

  mapMain(b) { return this.type === 'candles' ? { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close } : { time: b.time, value: b.close }; }
  mapVol(b) { return { time: b.time, value: b.volume, color: b.close >= b.open ? this.c.upA : this.c.downA }; }

  setData(bars, { intraday = false, keepRange = false } = {}) {
    if (!this.chart) return;
    this.bars = bars;
    this.intraday = intraday;
    this.byTime = new Map(bars.map((b) => [b.time, b]));
    this.chart.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });
    this.main.setData(bars.map((b) => this.mapMain(b)));
    this.volume.setData(bars.map((b) => this.mapVol(b)));
    if (!keepRange) this.chart.timeScale().fitContent();
    this.renderLegend(bars[bars.length - 1]);
  }

  setType(type) {
    if (type === this.type || !this.chart) return;
    this.type = type;
    this.buildMainSeries();
    this.setData(this.bars, { intraday: this.intraday, keepRange: true });
  }

  /** Обновление последнего бара на тике (данные — общий объект из API). */
  updateLast(bar) {
    if (!this.chart || !bar) return;
    this.main.update(this.mapMain(bar));
    this.volume.update(this.mapVol(bar));
    this.renderLegend(bar);
  }

  renderLegend(b) {
    if (!this.legendEl || !b) return;
    const U = FP.U;
    const chg = b.close - b.open, cls = U.trend(chg);
    const t = new Date(b.time * 1000);
    const when = this.intraday
      ? t.toLocaleString('ru-RU', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
      : t.toLocaleDateString('ru-RU', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
    this.legendEl.innerHTML = `
      <span class="mr-2">${when}</span>
      O <span class="${cls}">${U.price(b.open)}</span>
      H <span class="${cls}">${U.price(b.high)}</span>
      L <span class="${cls}">${U.price(b.low)}</span>
      C <span class="${cls}">${U.price(b.close)}</span>
      <span class="${cls}">${U.pct(chg / b.open * 100)}</span>
      <span class="ml-2">Vol ${U.compact(b.volume)}</span>`;
  }
};
