/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { $ }                  from '../ui-utils.js';
import { DashCardsComponent } from './dash-cards-component.js';

/**
 * SimulationAnimator — owns playback, config-graph highlighting, and breakpoints.
 *
 * Created fresh each buildScenario() so it binds to the new scenario/bus.
 * Each sub-component (DashCards, TimeControls, StatePanelView, ChartPresenter,
 * GraphRenderer) receives the simBus via wireSimBus() and manages its own
 * subscriptions, render scheduling, and failure-banner display.
 *
 * Public API:
 *   startPlaying()            — begin animation loop
 *   stopPlaying()             — stop animation loop
 *   toggleBreakpoint(node)    — toggle breakpoint on a config-graph node
 *   clearBreakpointStatus()   — reset status row to RUNNING/STOPPED
 *   showBreakpointPaused(hit) — display breakpoint-pause status
 *   updateDashCards(date)     — trigger an immediate dash-card refresh
 *   wireSimBus(bus)           — wire all sub-components to the simulation bus
 */
const PLAYBACK_THROTTLE_MS = 1000;

export class SimulationAnimator {

  constructor({ scenario, timeControls, statePanelView, chartView, graphRenderer, accountsPresenter }) {
    this._scenario          = scenario;
    this._timeControls      = timeControls;
    this._statePanelView    = statePanelView;
    this._chartView         = chartView;
    this._graphRenderer     = graphRenderer ?? null;
    this._accountsPresenter = accountsPresenter ?? null;
    this._dashCards         = null;   // created in wireSimBus

    this.playing = false;
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
    this._dashCards?.setRenderThrottle(PLAYBACK_THROTTLE_MS);
    this.animate();
  }

  stopPlaying() {
    this.playing = false;
    $('playPause').textContent = '▶';
    this._graphRenderer?.setRenderThrottle(0);
    this._statePanelView?.setRenderThrottle(0);
    this._chartView?.setRenderThrottle(0);
    this._accountsPresenter?.setRenderThrottle(0);
    this._dashCards?.setRenderThrottle(0);
    if (!this._scenario?.sim?.control?.paused) {
      this.clearBreakpointStatus();
    }
  }

  // ── Breakpoints ───────────────────────────────────────────────────────────

  toggleBreakpoint(node) {
    if (!this._scenario?.sim) return;
    if (!node) {
      this._scenario.sim.clearAllBreakpoints();
    } else {
      this._scenario.sim.toggleNodeBreakpoint(node);
    }
  }

  clearBreakpointStatus() {
    const dot   = $('statusDot');
    const label = $('simStatus');
    if (dot)   dot.className     = this.playing ? 'status-dot running' : 'status-dot stopped';
    if (label) label.textContent = this.playing ? 'RUNNING' : 'STOPPED';
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

  /** Trigger an immediate dash-card refresh (initial load, reset). */
  updateDashCards(date) {
    this._dashCards?.update(date);
  }

  // ── Bus wiring ────────────────────────────────────────────────────────────

  /**
   * Wire all sub-components to the simulation bus.
   * Call once after scenario.buildSim().
   */
  wireSimBus(bus) {
    this._graphRenderer?.wireSimBus(bus);
    this._chartView?.wireSimBus(bus);
    this._statePanelView?.wireSimBus(bus, { chartPresenter: this._chartView });
    this._timeControls?.wireSimBus(bus);

    this._dashCards = new DashCardsComponent({
      formatDate: (d) => this._statePanelView?.fmtVal(d) ?? d?.toDateString?.() ?? '',
    });
    this._dashCards.wireSimBus(bus, this._scenario?.sim);

    bus.subscribe('BREAKPOINT_HIT', (msg) => {
      this.showBreakpointPaused(msg);
    });
  }
}
