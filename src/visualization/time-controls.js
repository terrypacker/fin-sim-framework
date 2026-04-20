/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

export class TimeControls {
  constructor({scenario, timelineView, graphView, chartView, timeLabel, timeSlider, formatDate}) {
    this.scenario = scenario;
    this.timelineView = timelineView;
    this.graphView = graphView;
    this.chartView = chartView;
    this.timeLabel = timeLabel;
    this.timeSlider = timeSlider;
    this.formatDate = formatDate ?? (d => d.toDateString());
    this._dateChangedRaf = null;
  }

  stepForward() {
    const next = this.scenario.sim.queue.peek();
    if (!next || next.date > this.scenario.simEnd) return null;
    const pct = (next.date.getTime() - this.scenario.simStart.getTime()) /
        (this.scenario.simEnd.getTime() - this.scenario.simStart.getTime());
    return this.stepTo(Math.min(1, pct));
  }

  stepTo(pct) {
    const targetTime = new Date(
        this.scenario.simStart.getTime() +
        pct * (this.scenario.simEnd.getTime() - this.scenario.simStart.getTime())
    );
    this.scenario.sim.stepTo(targetTime);
    this.timelineView?.update();
    this.timeLabel.textContent = this.formatDate(targetTime);
    return targetTime;
  }

  rewindTo(pct) {
    this.graphView?.resetGraph();
    this.chartView?.resetHistory();
    // Journal entries are not part of the snapshot; clear them so replay
    // doesn't accumulate duplicates on top of the original run.
    this.scenario.sim.journal.journal.length = 0;
    // Reset the action graph and ID counter so replay produces clean nodes.
    this.scenario.sim.history.resetForReplay();
    this.timelineView?.reset();
    this.scenario.sim.rewindToStart();
    const t = this.stepTo(pct);  // stepTo calls timelineView.update()
    return t;
  }

  /**
   * Call on every message sent over the bus to track time in the slider.
   *
   * Throttled: graphView fires this on every DEBUG_ACTION node; we only need the
   *   slider/label updated once per animation frame.
   * @param date
   */
  onDateChanged(date) {
    this._pendingDate = date;          // always track the latest date
    if (this._dateChangedRaf) return;
    this._dateChangedRaf = requestAnimationFrame(() => {
      this._dateChangedRaf = null;
      const d = this._pendingDate;    // use the most-recent date, not the first
      const pct = (d.getTime() - this.scenario.simStart.getTime()) /
          (this.scenario.simEnd.getTime() - this.scenario.simStart.getTime());
      this.timeSlider.value = Math.round(pct * 100);
      this.timeLabel.textContent = this.formatDate(d);
    });
  }

}
