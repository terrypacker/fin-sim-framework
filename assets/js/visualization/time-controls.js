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
  constructor({scenario, timelineView, graphView, chartView, timeLabel, timeSlider, stepCallback}) {
    this.scenario = scenario;
    this.timelineView = timelineView;
    this.graphView = graphView;
    this.chartView = chartView;
    this.timeLabel = timeLabel;
    this.timeSlider = timeSlider;
    this.stepCallback = stepCallback;
    this._dateChangedRaf = null;
  }

  stepTo(pct) {
    const targetTime = new Date(
        this.scenario.simStart.getTime() +
        pct * (this.scenario.simEnd.getTime() - this.scenario.simStart.getTime())
    );
    this.scenario.sim.stepTo(targetTime);
    this.timelineView?.update();
    this.timeLabel.textContent = targetTime.toDateString();
    this.stepCallback(targetTime, this.scenario.sim.state);
    return targetTime;
  }

  rewindTo(pct) {
    this.graphView?.resetGraph();
    this.chartView?.resetHistory();
    // Journal entries are not part of the snapshot; clear them so replay
    // doesn't accumulate duplicates on top of the original run.
    this.scenario.sim.journal.journal.length = 0;
    this.timelineView?.reset();
    this.scenario.sim.rewindToStart();
    const t = this.stepTo(pct);  // stepTo calls timelineView.update()
    return t;
  }

  // Throttled: graphView fires this on every DEBUG_ACTION node; we only need the
  // slider/label updated once per animation frame.

  onDateChanged(date) {
    if (this._dateChangedRaf) return;
    this._dateChangedRaf = requestAnimationFrame(() => {
      this._dateChangedRaf = null;
      const pct = (date.getTime() - this.scenario.simStart.getTime()) /
          (this.scenario.simEnd.getTime() - this.scenario.simStart.getTime());
      this.timeSlider.value = Math.round(pct * 100);
      this.timeLabel.textContent = date.toDateString();
      this.stepCallback(date, this.scenario.sim.state);
    });
  }

}
