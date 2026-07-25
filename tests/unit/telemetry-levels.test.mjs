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
 * telemetry-levels.test.mjs — design 78 §4 / §7.
 *
 * The contract under test: **telemetry suppresses observation, never
 * computation**. Which observation artefacts a run produces is a caller's
 * choice; what the run *computes* is not.
 *
 * The regression this guards is specific and was live before design 78:
 * `_derivedMetrics` sat inside `if (!this.silent)`, so every silent run left
 * `state.metrics.netWorth` at **0** — not absent, zero. A batch caller reading
 * that field got a plausible-looking number that was silently wrong, and the
 * only reason Monte Carlo and the optimizer escaped was that both happened to
 * recompute net worth from standalone helpers instead of reading the field.
 * A zero is not a crash, so nothing failed loudly. Hence this test.
 */

import { test }             from 'node:test';
import assert               from 'node:assert/strict';
import { loadScenarioSim }  from '../helpers/scenario-harness.js';
import { TELEMETRY_LEVELS } from '../../src/simulation-framework/simulation.js';

const SIM_START = '2026-01-01';
const SIM_END   = '2036-01-01';

/** Run the standard scenario at one telemetry level and reduce it to comparables. */
function runAt(telemetry, extra = {}) {
  const { sim } = loadScenarioSim({
    simStart: SIM_START, simEnd: SIM_END, stepTo: SIM_END, telemetry, ...extra,
  });
  const s = sim.state;
  return {
    sim,
    netWorth:       s.metrics?.netWorth,
    netLiquidity:   s.metrics?.netLiquidity,
    scenarioFailed: s.scenarioFailed ?? false,
    deficit:        s.cumulativeDeficit ?? 0,
    // Whole-state fingerprint: catches any divergence, not just the headline metrics.
    fingerprint:    JSON.stringify(s),
    journalEntries: sim.journal.journal.length,
    snapshots:      sim.history.snapshots.length,
  };
}

const LEVELS = Object.keys(TELEMETRY_LEVELS);

test('TELEMETRY-1: every level computes identical state and metrics', () => {
  const base = runAt('full');
  assert.ok(base.netWorth > 0, 'baseline netWorth should be a real number');

  for (const level of LEVELS.filter(l => l !== 'full')) {
    const got = runAt(level);
    assert.equal(got.netWorth, base.netWorth,
      `${level}: netWorth must match 'full' — a 0 here means derived metrics were skipped`);
    assert.equal(got.netLiquidity, base.netLiquidity, `${level}: netLiquidity must match 'full'`);
    assert.equal(got.scenarioFailed, base.scenarioFailed, `${level}: scenarioFailed must match`);
    assert.equal(got.deficit, base.deficit, `${level}: cumulativeDeficit must match`);
    assert.equal(got.fingerprint, base.fingerprint, `${level}: full state must be identical to 'full'`);
  }
});

test('TELEMETRY-2: derived metrics are computed even at the cheapest level', () => {
  // The specific regression: silent runs used to leave this at 0.
  const off = runAt('off');
  assert.ok(Number.isFinite(off.netWorth), 'netWorth must be a finite number at telemetry off');
  assert.notEqual(off.netWorth, 0, 'netWorth must not be 0 at telemetry off (the pre-78 trap)');
  assert.ok(Number.isFinite(off.netLiquidity), 'netLiquidity must be computed at telemetry off');
});

test('TELEMETRY-3: each level produces exactly the artefacts it promises', () => {
  for (const level of LEVELS) {
    const { journal, snapshots } = TELEMETRY_LEVELS[level];
    const got = runAt(level);
    assert.equal(got.journalEntries > 0, journal,
      `${level}: journal entries ${journal ? 'expected' : 'must be absent'}`);
    assert.equal(got.snapshots > 0, snapshots,
      `${level}: history snapshots ${snapshots ? 'expected' : 'must be absent'}`);
  }
});

test('TELEMETRY-4: sampler collects a series without full-state snapshots', () => {
  // Design 78 §4.5 — what Monte Carlo now relies on instead of history snapshots.
  const sampler = (state, date) => ({ date: new Date(date), nw: state.metrics?.netWorth ?? 0 });

  const sampled = runAt('off', { sampler });
  assert.equal(sampled.snapshots, 0, 'sampler must not require history snapshots');
  assert.ok(sampled.sim.samples.length > 0, 'sampler should have collected records');

  // Samples are taken at the snapshot cadence, so a run WITH snapshots must
  // produce the same number of sample points at the same dates.
  const withSnaps = runAt('metrics', { sampler });
  assert.equal(sampled.sim.samples.length, withSnaps.sim.samples.length,
    'sample count must not depend on whether snapshots are also being taken');
  assert.deepEqual(
    sampled.sim.samples.map(s => s.date.toISOString()),
    withSnaps.sim.samples.map(s => s.date.toISOString()),
    'sample dates must align with the history-snapshot cadence');
  // `stepTo` takes one extra snapshot at simStart, before the first event fires,
  // so that rewindToStart() can replay everything. The sampler is driven off the
  // event counter and so has no equivalent — hence the slice(1). Everything after
  // that initial snapshot must line up exactly, which is what makes a
  // sampler-built series interchangeable with a snapshot-built one (§4.5).
  const snapDates = withSnaps.sim.history.snapshots.map(s => s.date.toISOString());
  assert.equal(withSnaps.sim.samples.length, snapDates.length - 1,
    'exactly one more snapshot than samples: the initial simStart snapshot');
  assert.deepEqual(
    withSnaps.sim.samples.map(s => s.date.toISOString()),
    snapDates.slice(1),
    'a sample must be taken at exactly the moments a snapshot would have been');
});

test('TELEMETRY-5: explicit opts still override the level', () => {
  // Back-compat: callers predating the levels set the switches directly.
  const { sim } = loadScenarioSim({
    simStart: SIM_START, simEnd: SIM_END, stepTo: SIM_END, telemetry: 'off',
  });
  assert.equal(sim.silent, true, "telemetry 'off' implies silent");
  assert.equal(sim.journal.enabled, false, "telemetry 'off' implies journal off");
  assert.equal(sim.history.enableSnapshots, false, "telemetry 'off' implies snapshots off");
});
