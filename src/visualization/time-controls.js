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
    // Stack of fractional positions (0–1) visited by stepForward(),
    // so stepBack() can return to exactly the previous event's position.
    this._stepHistory = [];
  }

  stepForward() {
    const next = this.scenario.sim.queue.peek();
    if (!next || next.date > this.scenario.simEnd) return null;
    const pct = Math.min(1,
        (next.date.getTime() - this.scenario.simStart.getTime()) /
        (this.scenario.simEnd.getTime() - this.scenario.simStart.getTime())
    );
    this._stepHistory.push(pct);
    this.timeSlider.value = Math.round(pct * 100);
    return this.stepTo(pct);
  }

  /**
   * Step back to exactly where the previous stepForward() landed.
   * If no stepForward() history exists (e.g. arrived here via play or the
   * slider), scans the snapshot array to find the previous event's date.
   */
  stepBack() {
    if (this._stepHistory.length > 0) {
      this._stepHistory.pop();  // discard current position
      const prev = this._stepHistory[this._stepHistory.length - 1] ?? 0;
      this.timeSlider.value = Math.round(prev * 100);
      return this._doRewindTo(prev);
    }

    // No step-forward history — find the previous event date from snapshots.
    const currentDate = this.scenario.sim.currentDate;
    const snapshots   = this.scenario.sim.history.snapshots;
    let prevDate = null;
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (snapshots[i].date < currentDate) {
        prevDate = snapshots[i].date;
        break;
      }
    }

    const pct = prevDate
      ? Math.max(0, (prevDate.getTime() - this.scenario.simStart.getTime()) /
          (this.scenario.simEnd.getTime() - this.scenario.simStart.getTime()))
      : 0;

    this.timeSlider.value = Math.round(pct * 100);
    return this._doRewindTo(pct);
  }

  /** Called by the app when playback starts so step-back uses snapshot scanning. */
  clearStepHistory() {
    this._stepHistory = [];
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
    // Manual slider/timeline rewind clears the stepForward history since the
    // user is now navigating freely, not stepping event-by-event.
    this._stepHistory = [];
    return this._doRewindTo(pct);
  }

  _doRewindTo(pct) {
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
