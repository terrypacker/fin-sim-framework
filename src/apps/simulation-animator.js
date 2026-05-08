/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { $ }                       from '../visualization/ui-utils.js';
import { SIMULATION_BUS_MESSAGES } from '../simulation-framework/bus-messages.js';

/**
 * SimulationAnimator — owns playback, config-graph highlighting, breakpoints,
 * and dashboard cards.
 *
 * Created fresh each buildScenario() so it binds to the new scenario/bus.
 *
 * Constructor:
 *   { configGraph, scenario, timeControls, statePanelView, graphView, chartView }
 *
 * Public API:
 *   startPlaying()          — begin animation loop
 *   stopPlaying()           — stop animation loop
 *   syncBreakpoints()       — sync breakpoint node IDs → sim control
 *   clearBreakpointStatus() — reset status row to RUNNING/STOPPED
 *   showBreakpointPaused(hit) — display breakpoint-pause status
 *   updateDashCards(date)   — update the four execution-count cards
 *   wireSimBus(bus)         — subscribe to all SIMULATION_BUS_MESSAGES
 */
export class SimulationAnimator {

  /**
   * @param {{
   *   scenario:        object,
   *   timeControls:   import('../visualization/time-controls.js').TimeControls,
   *   statePanelView: import('./state-panel-view.js').StatePanelView,
   *   chartView:      import('../visualization/chart-view.js').ChartView,
   * }}
   */
  constructor({ scenario, timeControls, statePanelView, chartView }) {
    this._scenario       = scenario;
    this._timeControls   = timeControls;
    this._statePanelView = statePanelView;
    this._chartView      = chartView;

    this.playing = false;
    this._dashCardsdirty = false;
  }

  // ── Playback ──────────────────────────────────────────────────────────────

  animate() {
    if (!this.playing) return;

    const slider = $('timeSlider');
    slider.value = Math.min(100, +slider.value + 1);
    this._timeControls.stepTo(+slider.value / 100);

    if (this._scenario?.sim?.control?.paused) {
      this.stopPlaying();
      this.showBreakpointPaused(this._scenario.sim.control.breakpointHit);
      return;
    }

    if (+slider.value < 100) {
      requestAnimationFrame(() => this.animate());
    } else {
      this.stopPlaying();
    }
  }

  startPlaying() {
    const ctrl = this._scenario?.sim?.control;
    if (ctrl?.paused) {
      if (!ctrl.pendingExecution) ctrl.resuming = true;
      ctrl.paused         = false;
      ctrl.breakpointHit  = null;
    }
    this.playing = true;
    this._timeControls.clearStepHistory();
    $('playPause').textContent = '⏸';
    this.clearBreakpointStatus();
    this.animate();
  }

  stopPlaying() {
    this.playing = false;
    $('playPause').textContent = '▶';
    if (!this._scenario?.sim?.control?.paused) {
      this.clearBreakpointStatus();
    }
  }

  // ── Breakpoints ───────────────────────────────────────────────────────────

  /** Sync breakpointed node IDs from the config graph into sim control. */
  toggleBreakpoint(node) {
    if (!this._scenario?.sim) return;
    if(!node) {
      this._scenario.sim.clearAllBreakpoints();
    }else {
      this._scenario.sim.toggleNodeBreakpoint(node);
    }
  }

  clearBreakpointStatus() {
    const dot   = $('statusDot');
    const label = $('simStatus');
    if (dot)   dot.className    = this.playing ? 'status-dot running' : 'status-dot stopped';
    if (label) label.textContent = this.playing ? 'RUNNING' : 'STOPPED';
    this._scenario.sim.clearAllBreakpoints();
  }

  showBreakpointPaused(hit) {
    const dot   = $('statusDot');
    const label = $('simStatus');
    if (dot) dot.className = 'status-dot breakpoint';
    if (label && hit) {
      const name = hit.node?.name ?? '?';
      label.textContent = `PAUSED @ ${name} [${hit.stage}]`;
    } else if (label) {
      label.textContent = 'PAUSED';
    }
  }

  // ── Dashboard cards ───────────────────────────────────────────────────────

  _scheduleDashCardFrame(date) {
    if (this._dashCardFrameScheduled) return;
    this._dashCardFrameScheduled = true;
    requestAnimationFrame(() => {
      this._dashCardFrameScheduled = false;

      if (!this._dashCardsdirty) return;

      this._dashCardsdirty = false;
      this._updateDashCards(date);
    });
  }

  updateDashCards(date) {
    if(this._dashCardsdirty) return;
    this._dashCardsdirty = true;
    this._scheduleDashCardFrame(date);
  }

  _updateDashCards(date) {
    const sim = this._scenario?.sim;
    $('cardCurrentDate').innerText       = this._statePanelView.fmtVal(date);
    $('cardEventExecutions').innerText   = sim?.eventExecutions   ?? 0;
    $('cardHandlerExecutions').innerText = sim?.handlerExecutions ?? 0;
    $('cardActionExecutions').innerText  = sim?.actionExecutions  ?? 0;
    $('cardReducerExecutions').innerText = sim?.reducerExecutions ?? 0;
  }

  // ── Bus subscriptions ─────────────────────────────────────────────────────

  /** Subscribe to all simulation bus messages. Call once after scenario.buildSim(). */
  wireSimBus(bus) {

    bus.subscribe(SIMULATION_BUS_MESSAGES.EVENT_OCCURRENCE_START, ({ date, payload, stateSnapshot }) => {
      this._timeControls.onDateChanged(new Date(date));
      this.updateDashCards(date);
    });

    bus.subscribe(SIMULATION_BUS_MESSAGES.NODE_DATA_CHANGED, msg => {
      const { reason } = msg.meta || {};
      if(reason === 'breakpoint') {
        const { breakpointContext } = msg.data || {};
        this.showBreakpointPaused(breakpointContext);
      }
    });

    //Once after each event
    bus.subscribe(SIMULATION_BUS_MESSAGES.EVENT_OCCURRENCE_END, ({ date, payload, stateSnapshot }) => {
      const metrics = stateSnapshot.metrics ? { ...stateSnapshot.metrics } : {};
      this._chartView.addSnapshot(date, metrics);
      this._statePanelView.updateStatePanel(date, stateSnapshot);
      this.updateDashCards(date);
    })
  }
}
