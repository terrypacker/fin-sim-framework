/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

export class ChartView {
  /**
   * @param {object}   opts
   * @param {object}   opts.canvas
   * @param {Date}     opts.simStart
   * @param {Date}     opts.simEnd
   * @param {Array}    [opts.series] - [{key, color, label}] — defaults to checking + savings
   */
  constructor({ canvas, simStart, simEnd, series }) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');
    this.simStart = simStart;
    this.simEnd   = simEnd;
    this.series   = series ?? [];
    this.history  = []; // [{date, ...seriesKeys}]
    this.running  = false;
  }

  /**
   * Push an item onto the chart
   * @param type - type of message
   * @param date - date of data
   * @param data - object of data
   */
  addSnapshot(type, date, data) {
    console.log(`type: ${type} --> ${data}`);
    this.history.push({ date: new Date(date), data });
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
  }
}
