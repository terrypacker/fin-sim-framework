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
   *   configGraph:    import('../visualization/config-graph.js').ConfigGraph,
   *   scenario:       object,
   *   timeControls:   import('../visualization/time-controls.js').TimeControls,
   *   statePanelView: import('./state-panel-view.js').StatePanelView,
   *   graphView?:     import('../visualization/graph-view.js').GraphView,
   *   chartView:      import('../visualization/chart-view.js').ChartView,
   * }}
   */
  constructor({ configGraph, scenario, timeControls, statePanelView, graphView, chartView }) {
    this._configGraph    = configGraph;
    this._scenario       = scenario;
    this._timeControls   = timeControls;
    this._statePanelView = statePanelView;
    this._graphView      = graphView ?? null;
    this._chartView      = chartView;

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
  syncBreakpoints() {
    if (!this._scenario?.sim) return;
    const ids = new Set(
      this._configGraph.nodes
        .filter(n => n.breakpoint)
        .map(n => n.id)
    );
    this._scenario.sim.control.breakpointNodeIds = ids;
  }

  clearBreakpointStatus() {
    const dot   = $('statusDot');
    const label = $('simStatus');
    if (dot)   dot.className    = this.playing ? 'status-dot running' : 'status-dot stopped';
    if (label) label.textContent = this.playing ? 'RUNNING' : 'STOPPED';
    this._configGraph.applyToAllNodes(n => n.flashing = false);
  }

  showBreakpointPaused(hit) {
    const dot   = $('statusDot');
    const label = $('simStatus');
    if (dot) dot.className = 'status-dot breakpoint';
    if (label && hit) {
      const name =
        hit.node?.name    ??
        hit.event?.type   ??
        hit.handler?.name ??
        hit.action?.type  ??
        hit.reducer?.name ??
        '?';
      label.textContent = `PAUSED @ ${name} [${hit.stage}]`;
    } else if (label) {
      label.textContent = 'PAUSED';
    }

    if      (hit?.event)   this._configGraph.flashNode(hit.event.id);
    else if (hit?.action)  this._configGraph.flashNode(hit.action.id);
    else if (hit?.handler) this._configGraph.flashNode(hit.handler.id);
    else if (hit?.reducer) this._configGraph.flashNode(hit.reducer.id);
    this._configGraph.render();
  }

  // ── Config graph highlighting ─────────────────────────────────────────────

  updateConfigGraphEvents(event, stateBefore, stateAfter, start = true) {
    if (start) {
      this._configGraph.applyToAllNodes(n => {
        n.fired        = false;
        n.stateChanged = false;
        n.stateChanges = [];
      }, false);
      const eventNode = this._configGraph.getNode(event.id);
      eventNode.fired = true;
      this._configGraph.render();
    } else {
      this._renderNodeFired(event.id, stateBefore, stateAfter);
    }
  }

  updateConfigGraphHandlers(handler, stateBefore, stateAfter) {
    this._renderNodeFired(handler.id, stateBefore, stateAfter);
  }

  updateConfigGraphActions(action, stateBefore, stateAfter) {
    this._renderNodeFired(action.id, stateBefore, stateAfter);
  }

  updateConfigGraphReducers(reducer, stateBefore, stateAfter) {
    this._renderNodeFired(reducer.id, stateBefore, stateAfter);
  }

  _renderNodeFired(id, stateBefore, stateAfter) {
    const diff = this._statePanelView.diffStates(stateBefore, stateAfter);
    const node = this._configGraph.getNode(id);
    node.fired = true;
    if (diff.length > 0) {
      node.stateChanged = true;
      node.stateChanges = diff;
    } else {
      node.stateChanged = false;
      node.stateChanges = [];
    }
    this._configGraph.render();
  }

  // ── Dashboard cards ───────────────────────────────────────────────────────

  updateDashCards(date) {
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
      this.updateConfigGraphEvents(payload.event, payload.stateBefore, stateSnapshot, true);
    });

    bus.subscribe(SIMULATION_BUS_MESSAGES.HANDLED_EVENT, ({ date, payload, stateSnapshot }) => {
      this.updateDashCards(date);
      this.updateConfigGraphHandlers(payload.handler, payload.stateBefore, stateSnapshot);
    });

    bus.subscribe(SIMULATION_BUS_MESSAGES.ACTION_RESULT, ({ date, payload, stateSnapshot }) => {
      this._statePanelView.updateStatePanel(date, stateSnapshot);
      this.updateDashCards(date);
      this.updateConfigGraphActions(payload.action, payload.stateBefore, stateSnapshot);
    });

    bus.subscribe(SIMULATION_BUS_MESSAGES.REDUCER_RESULT, ({ date, payload, stateSnapshot }) => {
      if (this._graphView) this._graphView.updateView(payload);
      const type    = payload.action.type;
      const metrics = stateSnapshot.metrics ? { ...stateSnapshot.metrics } : {};
      this._chartView.addSnapshot(type, date, metrics);
      this._statePanelView.updateStatePanel(date, stateSnapshot);
      this.updateDashCards(date);
      this.updateConfigGraphReducers(payload.reducer, payload.stateBefore, stateSnapshot);
    });
  }
}
