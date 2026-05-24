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
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('updateConfigGraphEvents: does not throw when event has no id (infrastructure event)', () => {
  const animator = makeAnimator();
  // TAX_SETTLE / PERIOD_ADVANCE scheduled via sim.schedule() — no id field
  const idlessEvent = { type: 'TAX_SETTLE', data: { cc: 'US' } };
  assert.doesNotThrow(() => {
    animator.updateConfigGraphEvents(idlessEvent, {}, {}, true);
  });
});

test('updateConfigGraphEvents: throws when event.id is set but node is not in config graph', () => {
  const animator = makeAnimator();  // empty graph — no nodes
  const unknownEvent = { id: 'e_99', type: 'MONTHLY_EXPENSES' };
  assert.throws(
    () => animator.updateConfigGraphEvents(unknownEvent, {}, {}, true),
    /Config graph node not found for event id 'e_99'/,
  );
});

test('updateConfigGraphEvents: marks known event node fired and resets all nodes', () => {
  const eventNode = { fired: false, stateChanged: false, stateChanges: [] };
  const otherNode = { fired: true,  stateChanged: true,  stateChanges: ['x'] };
  const animator  = makeAnimator({ 'e_1': eventNode, 'e_2': otherNode });

  animator.updateConfigGraphEvents({ id: 'e_1', type: 'MONTHLY_EXPENSES' }, {}, {}, true);

  assert.strictEqual(eventNode.fired, true,  'target node should be marked fired');
  assert.strictEqual(otherNode.fired, false, 'other nodes should be reset to unfired');
});

test('updateConfigGraphEvents (start=false): does not throw when event has no id', () => {
  const animator = makeAnimator();
  const idlessEvent = { type: 'PERIOD_ADVANCE', data: { cc: 'US' } };
  assert.doesNotThrow(() => animator.updateConfigGraphEvents(idlessEvent, {}, {}, false));
});

test('updateConfigGraphEvents (start=false): throws when id is set but node is not in graph', () => {
  const animator = makeAnimator();
  const unknownEvent = { id: 'e_99', type: 'MONTHLY_EXPENSES' };
  assert.throws(
    () => animator.updateConfigGraphEvents(unknownEvent, {}, {}, false),
    /Config graph node not found for id 'e_99'/,
  );
});

test('updateConfigGraphEvents (start=false): updates node state when id is known', () => {
  const node     = { fired: false, stateChanged: false, stateChanges: [] };
  const animator = makeAnimator({ 'e_1': node }, [{ field: 'x', before: 0, after: 1 }]);

  animator.updateConfigGraphEvents({ id: 'e_1', type: 'MONTHLY_EXPENSES' }, {}, {}, false);

  assert.strictEqual(node.fired, true);
  assert.strictEqual(node.stateChanged, true);
  assert.strictEqual(node.stateChanges.length, 1);
});
