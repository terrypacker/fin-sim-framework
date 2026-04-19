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
 * simulation-history.test.mjs
 * Tests for SimulationHistory — snapshot, replay, and branching logic.
 * Run with: node --test tests/simulation-history.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Simulation } from '../src/simulation-framework/simulation.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a simple simulation with a counter that increments on each TICK event.
 * scheduleAnnually registers two handlers for TICK (scheduling + user-registered),
 * so each TICK event yields 2 handler calls and 2 post-event snapshots.
 */
function makeCounterSim(startYear = 2025) {
  const sim = new Simulation(new Date(startYear, 0, 1), { initialState: { counter: 0 } });
  sim.reducers.register('INCREMENT', (state) => ({ ...state, counter: state.counter + 1 }));
  sim.register('TICK', () => [{ type: 'INCREMENT' }]);
  sim.scheduleAnnually({ startDate: new Date(startYear, 0, 1), type: 'TICK' });
  return sim;
}

// ─── Bug 1 regression: initial snapshot is pre-first-event ───────────────────

test('Bug 1: snapshot[0] is taken before first event fires (counter = 0)', () => {
  const sim = makeCounterSim();
  sim.stepTo(new Date(2025, 0, 1));  // one TICK

  const snap0 = sim.history.snapshots[0];
  assert.strictEqual(snap0.state.counter, 0,
    'snapshot[0] state must be pre-event (counter not yet incremented)');
});

test('Bug 1: snapshot[0] queue still contains the first event', () => {
  const sim = makeCounterSim();
  sim.stepTo(new Date(2025, 0, 1));

  const snap0 = sim.history.snapshots[0];
  assert.ok(snap0.queue.length > 0, 'snapshot[0] queue must not be empty');
  assert.ok(
    snap0.queue.some(e => e.type === 'TICK'),
    'snapshot[0] queue must contain the TICK event'
  );
});

test('Bug 1: rewindToStart + stepTo replays ALL events (event 0 not skipped)', () => {
  const sim = makeCounterSim();
  sim.stepTo(new Date(2027, 0, 1));  // 3 TICKs → counter = 3

  // Clear audit artifacts before replay
  sim.journal.journal.length = 0;
  sim.history.resetForReplay();

  sim.history.rewindToStart();
  sim.stepTo(new Date(2027, 0, 1));

  // All 3 TICKs must be replayed → 3 INCREMENT journal entries
  const entries = sim.journal.getActions('INCREMENT');
  assert.strictEqual(entries.length, 3,
    'all 3 INCREMENT actions must appear in the journal after rewind+replay');
});

test('Bug 1: after rewind+replay, state matches a fresh forward run', () => {
  const simFresh = makeCounterSim();
  simFresh.stepTo(new Date(2028, 0, 1));
  const expectedCounter = simFresh.state.counter;  // 4

  const simRewound = makeCounterSim();
  simRewound.stepTo(new Date(2028, 0, 1));
  simRewound.history.resetForReplay();
  simRewound.journal.journal.length = 0;
  simRewound.history.rewindToStart();
  simRewound.stepTo(new Date(2028, 0, 1));

  assert.strictEqual(simRewound.state.counter, expectedCounter,
    'state after rewind+replay must equal a fresh forward run');
});

// ─── Bug 3 regression: snapshot array does not grow unboundedly ───────────────

test('Bug 3: rewindToStart() trims snapshots to length 1', () => {
  const sim = makeCounterSim();
  sim.stepTo(new Date(2027, 0, 1));  // takes several snapshots

  sim.history.rewindToStart();

  assert.strictEqual(sim.history.snapshots.length, 1,
    'snapshots array must be trimmed to 1 entry after rewindToStart()');
});

test('Bug 3: rewindToStart() resets eventCounter to 0', () => {
  const sim = makeCounterSim();
  sim.stepTo(new Date(2027, 0, 1));
  assert.ok(sim.history.eventCounter > 0, 'eventCounter must be > 0 after stepping');

  sim.history.rewindToStart();

  assert.strictEqual(sim.history.eventCounter, 0,
    'eventCounter must reset to 0 after rewindToStart()');
});

test('Bug 3: rewind + replay does not double the snapshot count', () => {
  const sim = makeCounterSim();
  sim.stepTo(new Date(2027, 0, 1));

  const countAfterFirstRun = sim.history.snapshots.length;

  sim.history.resetForReplay();
  sim.journal.journal.length = 0;
  sim.history.rewindToStart();
  sim.stepTo(new Date(2027, 0, 1));

  // After rewind, snapshots = [snap0], then replay adds N more.
  // Total must equal countAfterFirstRun (1 initial + same per-event count), not 2x.
  assert.strictEqual(sim.history.snapshots.length, countAfterFirstRun,
    'snapshot count after rewind+replay must match first-run count, not double it');
});

// ─── Bug 2 regression: actionGraph and nextActionId reset on rewind ───────────

test('Bug 2: resetForReplay() replaces actionGraph with a fresh instance', () => {
  const sim = makeCounterSim();
  sim.stepTo(new Date(2025, 0, 1));

  const originalGraph = sim.actionGraph;
  sim.history.resetForReplay();

  assert.notStrictEqual(sim.actionGraph, originalGraph,
    'actionGraph must be a new instance after resetForReplay()');
  assert.strictEqual(sim.actionGraph.actionGraph.size, 0,
    'new actionGraph must be empty');
});

test('Bug 2: resetForReplay() resets nextActionId to 0', () => {
  const sim = makeCounterSim();
  sim.stepTo(new Date(2025, 0, 1));
  assert.ok(sim.nextActionId > 0, 'nextActionId must be > 0 after stepping');

  sim.history.resetForReplay();

  assert.strictEqual(sim.nextActionId, 0,
    'nextActionId must reset to 0 after resetForReplay()');
});

test('Bug 2: after resetForReplay + replay, action node IDs start from 0', () => {
  const sim = makeCounterSim();
  sim.stepTo(new Date(2025, 0, 1));

  sim.history.resetForReplay();
  sim.journal.journal.length = 0;
  sim.history.rewindToStart();
  sim.stepTo(new Date(2025, 0, 1));

  const nodes = [...sim.actionGraph.actionGraph.values()];
  assert.ok(nodes.length > 0, 'action graph must have nodes after replay');
  const minId = Math.min(...nodes.map(n => n.id));
  assert.strictEqual(minId, 0,
    'first action node ID after replay must be 0');
});

// ─── RNG reproducibility across rewind ───────────────────────────────────────

test('RNG: after rewind+replay, same random sequence is produced', () => {
  const collected1 = [];
  const collected2 = [];

  const sim1 = new Simulation(new Date(2025, 0, 1), { initialState: { vals: [] } });
  sim1.reducers.register('RECORD', (state) => ({ ...state, vals: [...state.vals, sim1.rng()] }));
  sim1.register('TICK', () => [{ type: 'RECORD' }]);
  sim1.scheduleAnnually({ startDate: new Date(2025, 0, 1), type: 'TICK' });

  sim1.stepTo(new Date(2027, 0, 1));
  collected1.push(...sim1.state.vals);

  sim1.history.resetForReplay();
  sim1.journal.journal.length = 0;
  sim1.history.rewindToStart();
  sim1.stepTo(new Date(2027, 0, 1));
  collected2.push(...sim1.state.vals);

  assert.deepStrictEqual(collected2, collected1,
    'RNG sequence after rewind+replay must match the first run');
});

// ─── findSnapshotIndex ────────────────────────────────────────────────────────

test('findSnapshotIndex: returns 0 when target is before all snapshots', () => {
  const sim = makeCounterSim();
  sim.stepTo(new Date(2027, 0, 1));

  // A date before the simulation start
  const idx = sim.history.findSnapshotIndex(new Date(2020, 0, 1));
  assert.strictEqual(idx, 0);
});

test('findSnapshotIndex: returns last index when target is after all snapshots', () => {
  const sim = makeCounterSim();
  sim.stepTo(new Date(2027, 0, 1));

  const lastIdx = sim.history.snapshots.length - 1;
  const idx = sim.history.findSnapshotIndex(new Date(2099, 0, 1));
  assert.strictEqual(idx, lastIdx);
});

test('findSnapshotIndex: returns the last snapshot with date <= target', () => {
  const sim = makeCounterSim();
  sim.stepTo(new Date(2027, 0, 1));

  // All snapshots at 2025-01-01 should be returned (the last one with that date)
  const snapsAt2025 = sim.history.snapshots
    .map((s, i) => ({ i, d: s.date.getTime() }))
    .filter(s => s.d === new Date(2025, 0, 1).getTime());

  if (snapsAt2025.length > 0) {
    const lastAt2025 = snapsAt2025[snapsAt2025.length - 1].i;
    const idx = sim.history.findSnapshotIndex(new Date(2025, 0, 1));
    assert.strictEqual(idx, lastAt2025,
      'should return the last snapshot at exactly that date');
  }
});

// ─── Backward-compat accessors ────────────────────────────────────────────────

test('sim.snapshots delegates to sim.history.snapshots', () => {
  const sim = makeCounterSim();
  sim.stepTo(new Date(2025, 0, 1));

  assert.strictEqual(sim.snapshots, sim.history.snapshots);
});

test('sim.snapshotCursor delegates to sim.history.snapshotCursor', () => {
  const sim = makeCounterSim();
  sim.stepTo(new Date(2025, 0, 1));

  assert.strictEqual(sim.snapshotCursor, sim.history.snapshotCursor);
});

test('sim.eventCounter delegates to sim.history.eventCounter', () => {
  const sim = makeCounterSim();
  sim.stepTo(new Date(2025, 0, 1));

  assert.strictEqual(sim.eventCounter, sim.history.eventCounter);
});
