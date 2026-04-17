/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

export class BalanceChartView {
  constructor({ canvas, simStart, simEnd }) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');
    this.simStart = simStart;
    this.simEnd   = simEnd;
    this.history  = []; // [{date, checking, savings}]
    this.pad      = { top: 30, right: 20, bottom: 55, left: 90 };
    this.running  = false;
  }

  addSnapshot(date, checking, savings) {
    this.history.push({ date: new Date(date), checking, savings });
  }

  resetHistory() {
    this.history = [];
  }

  startViz() {
    this.running = true;
    this._loop();
  }

  stopViz() {
    this.running = false;
  }

  _loop() {
    if (!this.running) return;
    this.draw();
    requestAnimationFrame(() => this._loop());
  }

  draw() {
    const { ctx, canvas, pad } = this;
    const W = canvas.width;
    const H = canvas.height;
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top  - pad.bottom;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);

    if (this.history.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '14px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Step the simulation forward to see balance history', W / 2, H / 2);
      return;
    }

    // ── Compute domains ────────────────────────────────────────────────────────
    const dates   = this.history.map(d => d.date.getTime());
    const minDate = Math.min(...dates);
    const maxDate = Math.max(...dates);

    const allVals = this.history.flatMap(d => [d.checking, d.savings]);
    const minVal  = Math.min(0, ...allVals);
    const rawMax  = Math.max(...allVals);
    const maxVal  = rawMax * 1.1 || 10000;

    const xScale = t => pad.left + ((t - minDate) / (maxDate - minDate || 1)) * plotW;
    const yScale = v => pad.top  + plotH - ((v - minVal) / (maxVal - minVal)) * plotH;

    // ── Grid & Y-axis labels ───────────────────────────────────────────────────
    const gridCount = 5;
    ctx.lineWidth   = 1;
    ctx.font        = '10px monospace';
    ctx.textAlign   = 'right';

    for (let i = 0; i <= gridCount; i++) {
      const v = minVal + ((maxVal - minVal) * (gridCount - i)) / gridCount;
      const y = pad.top + (plotH * i) / gridCount;

      ctx.strokeStyle = '#1e293b';
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();

      ctx.fillStyle = '#64748b';
      ctx.fillText('$' + Math.round(v).toLocaleString(), pad.left - 6, y + 4);
    }

    // ── Axis borders ──────────────────────────────────────────────────────────
    ctx.strokeStyle = '#334155';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.lineTo(pad.left + plotW, pad.top + plotH);
    ctx.stroke();

    // ── X-axis year labels ────────────────────────────────────────────────────
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    const yearsShown = new Set();
    for (const { date } of this.history) {
      const yr = date.getFullYear();
      if (!yearsShown.has(yr)) {
        yearsShown.add(yr);
        const t = new Date(yr, 0, 1).getTime();
        if (t >= minDate && t <= maxDate) {
          const x = xScale(t);
          ctx.fillText(String(yr), x, pad.top + plotH + 18);
        }
      }
    }

    // ── Draw series lines ─────────────────────────────────────────────────────
    const drawLine = (key, color, label) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      let first = true;
      for (const d of this.history) {
        const x = xScale(d.date.getTime());
        const y = yScale(d[key]);
        if (first) { ctx.moveTo(x, y); first = false; }
        else        ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Last-value label at right edge
      const last = this.history[this.history.length - 1];
      if (last) {
        const lx = xScale(last.date.getTime()) + 4;
        const ly = yScale(last[key]);
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.font      = '10px monospace';
        ctx.fillText('$' + Math.round(last[key]).toLocaleString(), lx, ly + 4);
      }
    };

    drawLine('checking', '#60a5fa', 'Checking');
    drawLine('savings',  '#34d399', 'Savings');

    // ── Legend ────────────────────────────────────────────────────────────────
    ctx.font      = '11px monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#60a5fa';
    ctx.fillText('— Checking', pad.left + 10, pad.top + 16);
    ctx.fillStyle = '#34d399';
    ctx.fillText('— Savings',  pad.left + 120, pad.top + 16);
  }
}
