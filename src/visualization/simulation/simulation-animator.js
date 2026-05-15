/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { $ }                       from '../ui-utils.js';
import { SIMULATION_BUS_MESSAGES } from '../../simulation-framework/bus-messages.js';

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
const PLAYBACK_THROTTLE_MS = 1000;

export class SimulationAnimator {

  /**
   * @param {{
   *   scenario:        object,
   *   timeControls:   import('../time-controls.js').TimeControls,
   *   statePanelView: import('./state-panel-view.js').StatePanelView,
   *   chartView:      import('../visualization/chart-view.js').ChartView,
   * }}
   */
  constructor({ scenario, timeControls, statePanelView, chartView, graphRenderer, accountsPresenter }) {
    this._scenario          = scenario;
    this._timeControls      = timeControls;
    this._statePanelView    = statePanelView;
    this._chartView         = chartView;
    this._graphRenderer     = graphRenderer ?? null;
    this._accountsPresenter = accountsPresenter ?? null;

    this.playing = false;
    this._dashCardsdirty = false;

    this._lastOutOfFundsDate = null;
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
    this._graphRenderer?.setRenderThrottle(PLAYBACK_THROTTLE_MS);
    this._statePanelView?.setRenderThrottle(PLAYBACK_THROTTLE_MS);
    this._chartView?.setRenderThrottle(PLAYBACK_THROTTLE_MS);
    this._accountsPresenter?.setRenderThrottle(PLAYBACK_THROTTLE_MS);
    this.animate();
  }

  stopPlaying() {
    this.playing = false;
    $('playPause').textContent = '▶';
    this._graphRenderer?.setRenderThrottle(0);
    this._statePanelView?.setRenderThrottle(0);
    this._chartView?.setRenderThrottle(0);
    this._accountsPresenter?.setRenderThrottle(0);
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
      const name = hit.node?.name ?? hit.nodeId ?? '?';
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

  // ── Failure banner ────────────────────────────────────────────────────────

  _updateFailureState(stateSnapshot) {
    const oofDate = stateSnapshot?.outOfFundsDate ?? null;

    if (oofDate !== this._lastOutOfFundsDate) {
      const banner   = $('failureBanner');
      const dateSpan = $('failureBannerDate');

      if (oofDate && !this._lastOutOfFundsDate) {
        if (banner)   banner.style.display = '';
        if (dateSpan) dateSpan.textContent = this._statePanelView.fmtVal(oofDate);
        this._chartView?.addAnnotation('out_of_funds', {
          label:    'OUT OF FUNDS',
          date:     oofDate,
          color:    '#f87171',
          position: 'start',
        });
      } else if (!oofDate && this._lastOutOfFundsDate) {
        if (banner) banner.style.display = 'none';
        this._chartView?.removeAnnotation('out_of_funds');
      }

      this._lastOutOfFundsDate = oofDate;
    }

    if (oofDate) {
      const defSpan    = $('failureBannerDeficit');
      const monthsSpan = $('failureBannerMonths');
      if (defSpan)    defSpan.textContent    = '$' + Math.round(stateSnapshot.cumulativeDeficit ?? 0).toLocaleString();
      if (monthsSpan) monthsSpan.textContent = stateSnapshot.deficitMonths ?? 0;
    }
  }

  // ── Bus subscriptions ─────────────────────────────────────────────────────

  /** Subscribe to all simulation bus messages. Call once after scenario.buildSim(). */
  wireSimBus(bus) {

    bus.subscribe(SIMULATION_BUS_MESSAGES.EVENT_OCCURRENCE_START, ({ date, payload, stateSnapshot }) => {
      this._timeControls.onDateChanged(new Date(date));
      this.updateDashCards(date);
    });

    bus.subscribe(SIMULATION_BUS_MESSAGES.BREAKPOINT_HIT, (msg) => {
      this.showBreakpointPaused(msg);
    });

    //Once after each event
    bus.subscribe(SIMULATION_BUS_MESSAGES.EVENT_OCCURRENCE_END, ({ date, payload, stateSnapshot }) => {
      const metrics = stateSnapshot.metrics ? { ...stateSnapshot.metrics } : {};
      this._chartView.addSnapshot(date, metrics);
      this._statePanelView.updateStatePanel(date, stateSnapshot);
      this.updateDashCards(date);
      this._updateFailureState(stateSnapshot);
    })
  }
}
