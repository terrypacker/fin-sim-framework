/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * simulation-animator.test.mjs
 *
 * Unit tests for SimulationAnimator.updateConfigGraphEvents / _renderNodeFired.
 *
 * Regression test for the "infrastructure events have no id" bug:
 * PERIOD_ADVANCE and TAX_SETTLE events are scheduled directly via sim.schedule()
 * (no service layer, no config-graph node).  When they fire, the animator must
 * not crash attempting to access a null node.
 *
 * Run with: node --test tests/unit/simulation-animator.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { SimulationAnimator } from '../../src/apps/simulation-animator.js';
import {EventBus} from "../../src/simulation-framework/event-bus.js";

// ─── Minimal stubs ────────────────────────────────────────────────────────────

function makeConfigGraph(knownNodes = {}) {
  return {
    getNode(id) { return knownNodes[id] ?? null; },
    applyToAllNodes(fn) { Object.values(knownNodes).forEach(fn); },
    render() {},
  };
}

function makeStatePanelView(diff = []) {
  return { diffStates() { return diff; } };
}

function makeAnimator(knownNodes = {}, diff = []) {
  return new SimulationAnimator({
    configGraph:    makeConfigGraph(knownNodes),
    scenario:       null,
    timeControls:   { onDateChanged() {}, stepTo() {} },
    statePanelView: makeStatePanelView(diff),
    chartView:      null,
    actionService:  null,
    bus: new EventBus()
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────
