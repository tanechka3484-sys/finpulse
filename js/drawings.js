/**
 * FinPulse — инструменты рисования на графике (в стиле TradingView).
 *
 * Lightweight Charts не умеет рисовать, поэтому поверх графика лежит
 * собственный canvas. Каждая точка рисунка хранится в координатах
 * «время + цена», поэтому рисунок остаётся на месте при прокрутке,
 * масштабировании и смене интервала (1D…ALL). Рисунки сохраняются
 * в браузере отдельно для каждой бумаги.
 *
 * Инструменты: трендовая линия, луч, горизонтальная и вертикальная линии,
 * параллельный канал, прямоугольник, уровни Фибоначчи, линейка (измерение),
 * текст. Плюс магнит (привязка к OHLC), отмена (Ctrl+Z), скрытие и удаление.
 */
window.FP = window.FP || {};

FP.ChartDrawings = class ChartDrawings {
  /** Сколько точек ставит каждый инструмент. */
  static TOOLS = {
    trend: { points: 2, label: 'Трендовая линия', icon: 'trending-up', key: 'T' },
    ray: { points: 2, label: 'Луч', icon: 'move-up-right', key: 'R' },
    hline: { points: 1, label: 'Горизонтальная линия', icon: 'minus', key: 'H' },
    vline: { points: 1, label: 'Вертикальная линия', icon: 'separator-vertical', key: 'V' },
    channel: { points: 3, label: 'Параллельный канал', icon: 'spline', key: 'C' },
    rect: { points: 2, label: 'Прямоугольник', icon: 'rectangle-horizontal', key: 'B' },
    fib: { points: 2, label: 'Коррекция Фибоначчи', icon: null, text: 'Fib', key: 'F' },
    measure: { points: 2, label: 'Линейка: изменение цены и время', icon: 'ruler', key: 'M' },
    text: { points: 1, label: 'Текст', icon: 'type', key: 'X' },
  };
  static FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  static COLORS = ['accent', 'up', 'down', 'warn', 'fg'];

  constructor(priceChart, wrap, toolbar) {
    this.pc = priceChart;
    this.wrap = wrap;
    this.toolbar = toolbar;
    this.items = [];
    this.tool = null;          // активный инструмент или null (курсор)
    this.draft = null;         // рисунок в процессе постановки
    this.selected = null;
    this.drag = null;
    this.magnet = FP.U.store.get('draw:magnet', true);
    this.hidden = false;
    this.history = [];
    this.key = null;
    if (!priceChart.chart) return;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'absolute inset-0 z-[5] pointer-events-none';
    wrap.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.textInput = document.createElement('input');
    this.textInput.type = 'text';
    this.textInput.id = 'draw-text-input';
    this.textInput.className = 'input absolute z-30 hidden w-48';
    this.textInput.placeholder = 'Текст и Enter';
    wrap.appendChild(this.textInput);

    this.selBar = document.createElement('div');
    this.selBar.className = 'draw-selbar hidden';
    wrap.appendChild(this.selBar);

    this.renderToolbar();
    this.bindPointer();
    this.bindKeys();
    this.bindTextInput();
    new ResizeObserver(() => this.resize()).observe(wrap);
    this.resize();
    this.loop();
  }

  /* ================= Геометрия: время/цена ↔ пиксели ================= */
  get chart() { return this.pc.chart; }
  get series() { return this.pc.main; }
  get bars() { return this.pc.bars || []; }
  paneW() { return this.chart.timeScale().width(); }
  paneH() { return this.wrap.clientHeight - this.chart.timeScale().height(); }

  /** Средний шаг между барами (для точек правее последнего бара). */
  step() {
    const b = this.bars;
    return b.length > 1 ? (b[b.length - 1].time - b[0].time) / (b.length - 1) : 86400;
  }
  timeToLogical(t) {
    const b = this.bars, n = b.length;
    if (!n) return 0;
    if (t <= b[0].time) return (t - b[0].time) / this.step();
    if (t >= b[n - 1].time) return n - 1 + (t - b[n - 1].time) / this.step();
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (b[m].time <= t) lo = m; else hi = m; }
    return lo + (t - b[lo].time) / (b[hi].time - b[lo].time);
  }
  logicalToTime(l) {
    const b = this.bars, n = b.length;
    if (!n) return 0;
    if (l <= 0) return b[0].time + l * this.step();
    if (l >= n - 1) return b[n - 1].time + (l - (n - 1)) * this.step();
    const i = Math.floor(l), f = l - i;
    return b[i].time + f * (b[i + 1].time - b[i].time);
  }
  x(t) { const c = this.chart.timeScale().logicalToCoordinate(this.timeToLogical(t)); return c == null ? null : c; }
  y(p) { const c = this.series.priceToCoordinate(p); return c == null ? null : c; }
  toPoint(px, py) {
    const ts = this.chart.timeScale();
    let l = ts.coordinateToLogical(px);
    if (l == null) return null;
    l = Math.round(l);   // как в TradingView: точки встают на бары
    let p = this.series.coordinateToPrice(py);
    if (p == null) return null;
    if (this.magnet) {
      const bar = this.bars[l];
      if (bar) {
        const near = [bar.open, bar.high, bar.low, bar.close]
          .map((v) => ({ v, d: Math.abs(this.y(v) - py) })).sort((a, b) => a.d - b.d)[0];
        if (near.d < 14) p = near.v;
      }
    }
    return { t: this.logicalToTime(l), p };
  }
  xy(pt) { return [this.x(pt.t), this.y(pt.p)]; }

  /* ================= Цвета ================= */
  color(name, a = 1) {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--c-' + name).trim().split(/\s+/).join(',');
    return `rgba(${v},${a})`;
  }

  /* ================= Отрисовка ================= */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  /** Перерисовка, только если сдвинулась шкала, данные или рисунки. */
  loop() {
    const tick = () => {
      if (this.bars.length && this.series) {
        const r = this.chart.timeScale().getVisibleLogicalRange();
        const p0 = this.bars[this.bars.length - 1].close;
        const sig = [r && r.from, r && r.to, this.y(p0), this.y(p0 * 1.1), this.wrap.clientWidth, this.wrap.clientHeight, this.bars.length, this.bars[0].time, this.pc.type].join('|');
        if (sig !== this.sig || this.dirty) { this.sig = sig; this.dirty = false; this.draw(); }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  draw() {
    const ctx = this.ctx, W = this.wrap.clientWidth, H = this.wrap.clientHeight;
    ctx.clearRect(0, 0, W, H);
    this.positionSelBar();
    if (this.hidden || !this.bars.length) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, this.paneW(), this.paneH()); ctx.clip();
    for (const d of this.items) this.drawItem(d, d === this.selected);
    if (this.draft) this.drawItem(this.draft, true);
    ctx.restore();
  }

  line(ax, ay, bx, by, color, width = 1.5, dash = []) {
    const c = this.ctx;
    c.beginPath(); c.setLineDash(dash); c.strokeStyle = color; c.lineWidth = width;
    c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke(); c.setLineDash([]);
  }
  label(text, x, y, { color, bg, align = 'left', base = 'middle', pad = 4 } = {}) {
    const c = this.ctx;
    c.font = '600 11px Inter, system-ui, sans-serif';
    const w = c.measureText(text).width;
    let lx = align === 'right' ? x - w - pad * 2 : align === 'center' ? x - w / 2 - pad : x;
    const ly = base === 'top' ? y : base === 'bottom' ? y - 18 : y - 9;
    if (bg) { c.fillStyle = bg; this.roundRect(lx, ly, w + pad * 2, 18, 4); c.fill(); }
    c.fillStyle = color; c.textBaseline = 'middle'; c.fillText(text, lx + pad, ly + 9);
    return { x: lx, y: ly, w: w + pad * 2, h: 18 };
  }
  roundRect(x, y, w, h, r) {
    const c = this.ctx;
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  handle(x, y, color) {
    const c = this.ctx;
    c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2);
    c.fillStyle = this.color('surface'); c.fill(); c.lineWidth = 2; c.strokeStyle = color; c.stroke();
  }

  /** Точки канала: базовая линия p0→p1 и параллельная, смещённая по цене до p2. */
  channelOffset(d) {
    const [a, b, c] = d.pts;
    if (!c) return 0;
    const k = (this.timeToLogical(c.t) - this.timeToLogical(a.t)) / ((this.timeToLogical(b.t) - this.timeToLogical(a.t)) || 1);
    return c.p - (a.p + (b.p - a.p) * k);
  }

  drawItem(d, sel) {
    const U = FP.U, c = this.ctx;
    const col = this.color(d.color), w = d.width || 1.5;
    const W = this.paneW(), H = this.paneH();
    const pts = d.pts.map((p) => this.xy(p));
    if (pts.some(([x, y]) => x == null || y == null)) return;
    const [[x1, y1], [x2, y2] = []] = pts;

    switch (d.type) {
      case 'trend': this.line(x1, y1, x2, y2, col, w); break;
      case 'ray': {
        const dx = x2 - x1, dy = y2 - y1;
        const k = dx === 0 ? 0 : ((dx > 0 ? W : 0) - x1) / dx;
        this.line(x1, y1, dx === 0 ? x2 : x1 + dx * k, dx === 0 ? (dy > 0 ? H : 0) : y1 + dy * k, col, w);
        break;
      }
      case 'hline':
        this.line(0, y1, W, y1, col, w);
        this.label(U.price(d.pts[0].p), W - 2, y1, { color: '#fff', bg: col, align: 'right' });
        break;
      case 'vline': {
        this.line(x1, 0, x1, H, col, w);
        const dt = new Date(d.pts[0].t * 1000);
        const txt = this.pc.intraday
          ? dt.toLocaleString('ru-RU', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
          : dt.toLocaleDateString('ru-RU', { timeZone: 'UTC', day: '2-digit', month: 'short', year: '2-digit' });
        if (x1 >= 0 && x1 <= W) this.label(txt, x1, H - 4, { color: '#fff', bg: col, align: 'center', base: 'bottom' });
        break;
      }
      case 'rect':
        c.fillStyle = this.color(d.color, 0.12); c.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        c.strokeStyle = col; c.lineWidth = w; c.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        break;
      case 'channel': {
        this.line(x1, y1, x2, y2, col, w);
        if (pts[2]) {
          const off = this.channelOffset(d);
          const ya = this.y(d.pts[0].p + off), yb = this.y(d.pts[1].p + off);
          const ym1 = this.y(d.pts[0].p + off / 2), ym2 = this.y(d.pts[1].p + off / 2);
          c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.lineTo(x2, yb); c.lineTo(x1, ya); c.closePath();
          c.fillStyle = this.color(d.color, 0.08); c.fill();
          this.line(x1, ya, x2, yb, col, w);
          this.line(x1, ym1, x2, ym2, this.color(d.color, 0.6), 1, [4, 4]);
          pts[2] = [pts[2][0], this.y(d.pts[2].p)];
        }
        break;
      }
      case 'fib': {
        const a = d.pts[0].p, b = d.pts[1].p;
        const left = Math.min(x1, x2), right = Math.max(x1, x2);
        const lv = ChartDrawings.FIB.map((f) => ({ f, price: b + (a - b) * f }));
        lv.forEach((L, i) => {
          const y = this.y(L.price);
          if (i < lv.length - 1) {
            const yn = this.y(lv[i + 1].price);
            c.fillStyle = this.color(d.color, 0.04 + (i % 2) * 0.05);
            c.fillRect(left, Math.min(y, yn), right - left, Math.abs(yn - y));
          }
          this.line(left, y, right, y, L.f === 0.5 || L.f === 0.618 ? col : this.color(d.color, 0.75), L.f === 0.618 ? 1.8 : 1);
          this.label(`${L.f} (${U.price(L.price)})`, left + 4, y - 9, { color: col });
        });
        this.line(x1, y1, x2, y2, this.color(d.color, 0.5), 1, [4, 4]);
        break;
      }
      case 'measure': {
        const dp = d.pts[1].p - d.pts[0].p, pct = dp / d.pts[0].p * 100;
        const bars = Math.round(this.timeToLogical(d.pts[1].t) - this.timeToLogical(d.pts[0].t));
        const tone = dp >= 0 ? 'up' : 'down';
        c.fillStyle = this.color(tone, 0.14);
        c.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        this.line(x1, y1, x2, y2, this.color(tone), 1.2, [4, 3]);
        const txt = `${U.signed(dp)} (${U.pct(pct)}) · ${Math.abs(bars)} ${U.plural(Math.abs(bars), ['бар', 'бара', 'баров'])}`;
        this.label(txt, (x1 + x2) / 2, dp >= 0 ? Math.min(y1, y2) - 4 : Math.max(y1, y2) + 4,
          { color: '#fff', bg: this.color(tone, 0.95), align: 'center', base: dp >= 0 ? 'bottom' : 'top' });
        break;
      }
      case 'text': {
        c.font = '600 13px Inter, system-ui, sans-serif';
        c.fillStyle = col; c.textBaseline = 'middle';
        c.fillText(d.text || 'Текст', x1 + 6, y1);
        const w2 = c.measureText(d.text || 'Текст').width;
        d._box = { x: x1, y: y1 - 10, w: w2 + 12, h: 20 };
        c.beginPath(); c.arc(x1, y1, 2.5, 0, Math.PI * 2); c.fill();
        if (sel) { c.strokeStyle = this.color(d.color, 0.6); c.lineWidth = 1; c.setLineDash([3, 3]); c.strokeRect(d._box.x, d._box.y, d._box.w, d._box.h); c.setLineDash([]); }
        break;
      }
    }
    if (sel && d.type !== 'text') pts.forEach(([x, y]) => this.handle(x, y, col));
  }

  /* ================= Попадание курсора ================= */
  static distSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }

  /** Что под курсором: { item, handle } или null. */
  hit(px, py) {
    if (this.hidden) return null;
    const TOL = 7;
    for (let k = this.items.length - 1; k >= 0; k--) {
      const d = this.items[k];
      const pts = d.pts.map((p) => this.xy(p));
      if (pts.some(([x, y]) => x == null || y == null)) continue;
      if (d === this.selected) {
        const hIdx = pts.findIndex(([x, y]) => Math.hypot(px - x, py - y) <= 8);
        if (hIdx >= 0) return { item: d, handle: hIdx };
      }
      const [[x1, y1], [x2, y2] = []] = pts;
      const S = ChartDrawings.distSeg;
      let ok = false;
      switch (d.type) {
        case 'trend': ok = S(px, py, x1, y1, x2, y2) < TOL; break;
        case 'ray': {
          const dx = x2 - x1, k = dx === 0 ? 0 : ((dx > 0 ? this.paneW() : 0) - x1) / dx;
          ok = S(px, py, x1, y1, x1 + dx * k, y1 + (y2 - y1) * k) < TOL; break;
        }
        case 'hline': ok = Math.abs(py - y1) < TOL; break;
        case 'vline': ok = Math.abs(px - x1) < TOL; break;
        case 'rect': case 'measure': case 'fib':
          ok = px >= Math.min(x1, x2) - TOL && px <= Math.max(x1, x2) + TOL && py >= Math.min(y1, y2) - TOL && py <= Math.max(y1, y2) + TOL;
          if (d.type === 'fib') {
            const ys = ChartDrawings.FIB.map((f) => this.y(d.pts[1].p + (d.pts[0].p - d.pts[1].p) * f));
            ok = px >= Math.min(x1, x2) - TOL && px <= Math.max(x1, x2) + TOL && py >= Math.min(...ys) - TOL && py <= Math.max(...ys) + TOL;
          }
          break;
        case 'channel': {
          const off = this.channelOffset(d);
          const ya = this.y(d.pts[0].p + off), yb = this.y(d.pts[1].p + off);
          ok = S(px, py, x1, y1, x2, y2) < TOL || S(px, py, x1, ya, x2, yb) < TOL;
          break;
        }
        case 'text': { const b = d._box; ok = b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h; break; }
      }
      if (ok) return { item: d, handle: null };
    }
    return null;
  }

  /* ================= Мышь и касания ================= */
  local(e) { const r = this.wrap.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  inPane(x, y) { return x >= 0 && y >= 0 && x <= this.paneW() && y <= this.paneH(); }

  /** Пока рисуем или тащим — график не должен скроллиться. */
  lockChart(lock) {
    this.chart.applyOptions({ handleScroll: !lock, handleScale: !lock });
    this.wrap.style.touchAction = lock ? 'none' : '';
  }

  bindPointer() {
    const block = (e) => { if (this.capturing) { e.stopPropagation(); } };
    ['mousedown', 'touchstart'].forEach((t) => this.wrap.addEventListener(t, block, { capture: true }));

    this.wrap.addEventListener('pointerdown', (e) => {
      if (e.target === this.textInput || this.selBar.contains(e.target)) return;
      const [x, y] = this.local(e);
      if (!this.inPane(x, y) || !this.bars.length) return;

      // Ставим точки активного инструмента
      if (this.tool) {
        this.capture(e);
        const pt = this.toPoint(x, y);
        if (!pt) return;
        if (!this.draft) {
          const T = ChartDrawings.TOOLS[this.tool];
          this.draft = { id: Date.now().toString(36), type: this.tool, color: this.lastColor || 'accent', width: 1.5, pts: [pt] };
          if (T.points === 1) { this.finishDraft(); return; }
          this.draft.pts.push({ ...pt });
          this.downAt = [x, y];
        } else {
          this.draft.pts[this.draft.pts.length - 1] = pt;
          this.addDraftPoint();
        }
        this.dirty = true;
        return;
      }

      // Курсор: выбор, перенос точки или всего рисунка
      const h = this.hit(x, y);
      if (!h) { if (this.selected) { this.select(null); } return; }
      this.capture(e);
      this.select(h.item);
      this.pushHistory();
      this.drag = { item: h.item, handle: h.handle, start: this.toPointRaw(x, y), orig: h.item.pts.map((p) => ({ ...p })) };
    }, { capture: true });

    this.wrap.addEventListener('pointermove', (e) => {
      const [x, y] = this.local(e);
      if (this.draft) {
        const pt = this.toPoint(x, y);
        if (pt) { this.draft.pts[this.draft.pts.length - 1] = pt; this.dirty = true; }
        return;
      }
      if (this.drag) {
        const { item, handle, start, orig } = this.drag;
        const now = this.toPointRaw(x, y);
        if (!now || !start) return;
        if (handle != null) {
          const pt = this.toPoint(x, y);
          if (pt) item.pts[handle] = item.type === 'hline' ? { ...orig[handle], p: pt.p } : pt;
        } else {
          const dl = Math.round(this.timeToLogical(now.t) - this.timeToLogical(start.t)), dp = now.p - start.p;
          item.pts = orig.map((p) => ({ t: this.logicalToTime(Math.round(this.timeToLogical(p.t)) + dl), p: p.p + dp }));
        }
        this.dirty = true;
        return;
      }
      if (!this.tool) {
        const h = this.inPane(x, y) ? this.hit(x, y) : null;
        this.wrap.style.cursor = h ? (h.handle != null ? 'grab' : 'move') : '';
      }
    });

    const up = (e) => {
      const [x, y] = this.local(e);
      if (this.draft && this.downAt && this.draft.pts.length === 2) {
        // Протяжка мышью тоже ставит вторую точку
        if (Math.hypot(x - this.downAt[0], y - this.downAt[1]) > 6) this.addDraftPoint();
        this.downAt = null;
      }
      if (this.drag) { this.drag = null; this.save(); }
      if (!this.draft) this.release();
    };
    this.wrap.addEventListener('pointerup', up);
    this.wrap.addEventListener('pointercancel', up);

    this.wrap.addEventListener('dblclick', (e) => {
      const [x, y] = this.local(e);
      const h = this.hit(x, y);
      if (h && h.item.type === 'text') { e.stopPropagation(); this.editText(h.item); }
    }, { capture: true });
  }

  toPointRaw(x, y) {
    const l = this.chart.timeScale().coordinateToLogical(x), p = this.series.coordinateToPrice(y);
    return l == null || p == null ? null : { t: this.logicalToTime(l), p };
  }
  capture(e) {
    this.capturing = true;
    this.lockChart(true);
    e.stopPropagation(); e.preventDefault();
    try { this.wrap.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }
  release() {
    this.capturing = false;
    if (!this.tool) this.lockChart(false);
  }

  addDraftPoint() {
    const T = ChartDrawings.TOOLS[this.draft.type];
    if (this.draft.pts.length >= T.points) { this.finishDraft(); return; }
    this.draft.pts.push({ ...this.draft.pts[this.draft.pts.length - 1] });
  }

  finishDraft() {
    const d = this.draft;
    this.draft = null;
    this.pushHistory();
    this.items.push(d);
    this.select(d);
    if (!this.lockTool) this.setTool(null);
    if (d.type === 'text') this.editText(d, true);
    this.save();
  }

  /* ================= Текст ================= */
  editText(d, isNew = false) {
    const [x, y] = this.xy(d.pts[0]);
    const inp = this.textInput;
    inp.value = d.text || '';
    inp.style.left = Math.min(Math.max(0, x), this.paneW() - 200) + 'px';
    inp.style.top = Math.max(0, y - 16) + 'px';
    inp.classList.remove('hidden');
    this.editing = { d, isNew };
    setTimeout(() => inp.focus(), 0);
  }
  bindTextInput() {
    const commit = () => {
      if (!this.editing) return;
      const { d, isNew } = this.editing;
      const v = this.textInput.value.trim();
      this.editing = null;
      this.textInput.classList.add('hidden');
      if (v) d.text = v;
      else if (isNew || !d.text) this.items = this.items.filter((x) => x !== d);
      if (this.selected && !this.items.includes(this.selected)) this.select(null);
      this.save(); this.dirty = true;
    };
    this.textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); this.textInput.value = ''; commit(); }
      e.stopPropagation();
    });
    this.textInput.addEventListener('blur', commit);
  }

  /* ================= Клавиатура ================= */
  bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      if (!this.wrap.offsetParent) return; // вкладка с графиком скрыта
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); return; }
      if (e.key === 'Escape') {
        if (this.draft) { this.draft = null; this.dirty = true; }
        if (this.tool) this.setTool(null); else this.select(null);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { e.preventDefault(); this.remove(this.selected); return; }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const tool = Object.entries(ChartDrawings.TOOLS).find(([, T]) => e.code === 'Key' + T.key);
        if (tool) { e.preventDefault(); this.setTool(tool[0]); }
      }
    });
  }

  /* ================= Панель инструментов ================= */
  renderToolbar() {
    const btn = (id, title, inner, extra = '') => `<button type="button" class="draw-btn" data-draw="${id}" title="${title}" aria-label="${title}" ${extra}>${inner}</button>`;
    const icon = (name) => `<i data-lucide="${name}" class="w-4 h-4"></i>`;
    const T = ChartDrawings.TOOLS;
    this.toolbar.innerHTML = [
      btn('cursor', 'Курсор (Esc)', icon('mouse-pointer-2')),
      '<span class="draw-sep"></span>',
      ...Object.entries(T).map(([k, t]) => btn(k, `${t.label} (Alt+${t.key})`, t.icon ? icon(t.icon) : `<span class="text-[10px] font-bold">${t.text}</span>`)),
      '<span class="draw-sep"></span>',
      btn('magnet', 'Магнит: привязка к ценам OHLC', icon('magnet')),
      btn('lock', 'Не сбрасывать инструмент после рисования', icon('lock')),
      btn('hide', 'Скрыть рисунки', icon('eye')),
      btn('undo', 'Отменить (Ctrl+Z)', icon('undo-2')),
      btn('clear', 'Удалить все рисунки на этой бумаге', icon('trash-2')),
    ].join('');
    this.toolbar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-draw]');
      if (!b) return;
      const id = b.dataset.draw;
      if (id === 'cursor') this.setTool(null);
      else if (ChartDrawings.TOOLS[id]) this.setTool(this.tool === id ? null : id);
      else if (id === 'magnet') { this.magnet = !this.magnet; FP.U.store.set('draw:magnet', this.magnet); }
      else if (id === 'lock') this.lockTool = !this.lockTool;
      else if (id === 'hide') { this.hidden = !this.hidden; this.select(null); this.dirty = true; }
      else if (id === 'undo') this.undo();
      else if (id === 'clear') this.confirmClear(b);
      this.syncToolbar();
    });
    this.syncToolbar();
  }

  /** Подтверждение очистки прямо в кнопке: первый клик — «Точно?», второй — удалить. */
  confirmClear(b) {
    if (!this.items.length) return;
    if (b.dataset.confirm) {
      delete b.dataset.confirm; b.classList.remove('danger');
      this.pushHistory(); this.items = []; this.select(null); this.save(); this.dirty = true;
      FP.U.$('#toast').innerHTML = '<div class="toast">Рисунки удалены · Ctrl+Z — вернуть</div>';
      setTimeout(() => { FP.U.$('#toast').innerHTML = ''; }, 2200);
      return;
    }
    b.dataset.confirm = '1'; b.classList.add('danger'); b.title = 'Нажмите ещё раз, чтобы удалить все рисунки';
    setTimeout(() => { delete b.dataset.confirm; b.classList.remove('danger'); b.title = 'Удалить все рисунки на этой бумаге'; }, 2500);
  }

  syncToolbar() {
    FP.U.$$('[data-draw]', this.toolbar).forEach((b) => {
      const id = b.dataset.draw;
      const on = id === 'cursor' ? !this.tool : id === 'magnet' ? this.magnet : id === 'lock' ? this.lockTool : id === 'hide' ? this.hidden : this.tool === id;
      b.classList.toggle('active', !!on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  setTool(tool) {
    this.tool = tool;
    this.draft = null;
    if (tool) { this.hidden = false; this.select(null); }
    this.lockChart(!!tool);
    this.wrap.style.cursor = tool ? 'crosshair' : '';
    this.syncToolbar();
    this.dirty = true;
  }

  /* ================= Выделенный рисунок: цвет, толщина, удаление ================= */
  select(d) {
    this.selected = d;
    this.dirty = true;
    if (!d) { this.selBar.classList.add('hidden'); return; }
    const sw = ChartDrawings.COLORS.map((c) => `<button type="button" data-color="${c}" class="draw-swatch ${d.color === c ? 'active' : ''}" style="background:rgb(var(--c-${c}))" aria-label="Цвет"></button>`).join('');
    const widths = [1, 1.5, 3].map((w) => `<button type="button" data-width="${w}" class="draw-w ${d.width === w ? 'active' : ''}" aria-label="Толщина ${w}"><span style="height:${w}px"></span></button>`).join('');
    this.selBar.innerHTML = `${sw}<span class="draw-sep-h"></span>${widths}<span class="draw-sep-h"></span>
      ${d.type === 'text' ? '<button type="button" data-act="edit" class="draw-w" title="Изменить текст"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>' : ''}
      <button type="button" data-act="del" class="draw-w text-down" title="Удалить (Delete)"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>`;
    this.selBar.classList.remove('hidden');
    if (!this.selBar.dataset.bound) {
      this.selBar.dataset.bound = '1';
      this.selBar.addEventListener('pointerdown', (e) => e.stopPropagation());
      this.selBar.addEventListener('click', (e) => {
        const s = this.selected;
        if (!s) return;
        const c = e.target.closest('[data-color]'), w = e.target.closest('[data-width]'), a = e.target.closest('[data-act]');
        if (c) { this.pushHistory(); s.color = this.lastColor = c.dataset.color; }
        if (w) { this.pushHistory(); s.width = +w.dataset.width; }
        if (a && a.dataset.act === 'del') { this.remove(s); return; }
        if (a && a.dataset.act === 'edit') { this.editText(s); return; }
        this.save(); this.select(s);
      });
    }
    FP.U.icons();
  }
  positionSelBar() {
    if (!this.selected || this.selBar.classList.contains('hidden')) return;
    this.selBar.style.left = '50%';
    this.selBar.style.top = '34px';
  }
  remove(d) {
    this.pushHistory();
    this.items = this.items.filter((x) => x !== d);
    this.select(null); this.save(); this.dirty = true;
  }

  /* ================= История и хранение ================= */
  snapshot() { return JSON.stringify(this.items.map(({ _box, ...d }) => d)); }
  pushHistory() { this.history.push(this.snapshot()); if (this.history.length > 50) this.history.shift(); }
  undo() {
    if (!this.history.length) return;
    this.items = JSON.parse(this.history.pop());
    this.select(null); this.save(); this.dirty = true;
  }
  save() { if (this.key) FP.U.store.set('drawings:' + this.key, JSON.parse(this.snapshot())); }

  /** Переключение бумаги: у каждой свой набор рисунков. */
  setKey(key) {
    if (key === this.key) return;
    this.key = key;
    this.items = FP.U.store.get('drawings:' + key, []);
    this.history = [];
    this.draft = null;
    this.select(null);
    this.dirty = true;
  }
  redraw() { this.dirty = true; }
};
