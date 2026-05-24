/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent }                   from '../components/base-component.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../simulation-framework/bus-messages.js';

/**
 * PlaybackProgressComponent — owns the time-slider and time-label updates.
 *
 * Subscribes to EXECUTION_BEGIN(EVENT) via busQueue so rapid events during
 * fast playback collapse into one RAF frame (or one setTimeout frame when
 * throttled). Also accepts direct update(date) calls from TimeControls for
 * synchronous step / rewind / reset operations.
 *
 * Inherits setRenderThrottle() from BaseComponent so SimulationAnimator can
 * throttle it during fast playback.
 */
export class PlaybackProgressComponent extends BaseComponent {

  constructor({ scenario, timeSlider, timeLabel, formatDate }) {
    super();
    this._scenario       = scenario;
    this._timeSlider     = timeSlider;
    this._timeLabel      = timeLabel;
    this._formatDate     = formatDate ?? (d => d.toDateString());
    this._pendingDate    = null;
    this._drainBeginMsgs = () => [];
  }

  /**
   * Subscribe to the simulation bus.
   * Call once per scenario after scenario.buildSim().
   */
  wireSimBus(simBus) {
    this._drainBeginMsgs = this.busQueue(
      simBus,
      `EXECUTION_${EXECUTION_PHASES.BEGIN}`,
      () => this.render(),
      { kind: EXECUTION_KINDS.EVENT }
    );
  }

  /**
   * Direct update for step / rewind / reset operations outside the bus path.
   * Called by TimeControls.onDateChanged().
   */
  update(date) {
    this._pendingDate = date;
    this.render();
  }

  render() {
    this.scheduleRender(() => this._doRender());
  }

  _doRender() {
    const msgs = this._drainBeginMsgs();
    if (msgs.length) {
      this._pendingDate = new Date(msgs[msgs.length - 1].date);
    }
    if (!this._pendingDate) return;

    const d   = this._pendingDate;
    const pct = (d.getTime() - this._scenario.simStart.getTime()) /
                (this._scenario.simEnd.getTime() - this._scenario.simStart.getTime());
    this._timeSlider.value      = Math.round(pct * 100);
    this._timeLabel.textContent = this._formatDate(d);
  }
}
