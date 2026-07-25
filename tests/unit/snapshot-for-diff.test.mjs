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
 * snapshot-for-diff.test.mjs — design 78 §5.5.
 *
 * `_processReducers` diffs each untracked reducer against a `snapshotForDiff`
 * (a TWO-LEVEL copy) rather than a `deepClone`. That is sound only while no
 * reducer mutates state more than one level deep in place — an EMPIRICAL
 * property of the current reducers, not something the type system enforces.
 *
 * If it is ever violated the failure is silent and nasty: the diff simply omits
 * the deeper change, the journal still looks well-formed, and the design 16 drill
 * reports quietly under-foot. Nothing else in the suite would notice.
 *
 * So this runs a real scenario with both snapshot strategies live and asserts the
 * resulting diffs are identical, field for field. `scripts/dev/diff-mutation-tracker.mjs`
 * is the same check over a full 44-year run; this is the CI-sized version.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { loadScenarioSim } from '../helpers/scenario-harness.js';
import { Simulation }      from '../../src/simulation-framework/simulation.js';
import { deepClone, diffStates, snapshotForDiff } from '../../src/simulation-framework/state-utils.js';
import { FieldReducer, AccountTransactionReducer } from '../../src/simulation-framework/reducers.js';

/** Strip the emitted-actions key exactly as _processReducers does before assigning. */
function stripNext(v) {
  if (v && typeof v === 'object' && 'next' in v) {
    const { next: _drop, ...clean } = v;
    return clean;
  }
  return v;
}

const fieldsOf = diff => (diff ?? []).map(d => `${d.field}=${JSON.stringify(d.after ?? null)}`).sort();

test('SNAP-1: a two-level snapshot yields the same diff as a deep clone, for every untracked reducer', () => {
  const divergences = [];
  let untrackedRuns = 0;

  const orig = Simulation.prototype._processReducers;
  Simulation.prototype._processReducers = function (action, startIdx, reducers, ...rest) {
    const wrapped = reducers.map((rw) => {
      const r = rw.reducer;
      // Only the clone path matters — tracked reducers never take a snapshot.
      if (r instanceof FieldReducer || r instanceof AccountTransactionReducer) return rw;
      return { ...rw, fn: (state, act, date) => {
        const deep    = deepClone(state);
        const shallow = snapshotForDiff(state);
        const res     = rw.fn(state, act, date);
        const after   = stripNext((res && res.state) ? res.state : (res || state));
        untrackedRuns++;
        const a = fieldsOf(diffStates(deep, after));
        const b = fieldsOf(diffStates(shallow, after));
        if (a.join('|') !== b.join('|')) {
          divergences.push({
            reducer: r?.constructor?.name ?? 'plain-fn',
            onlyInDeep:    a.filter(x => !b.includes(x)),
            onlyInShallow: b.filter(x => !a.includes(x)),
          });
        }
        return res;
      } };
    });
    return orig.call(this, action, startIdx, wrapped, ...rest);
  };

  try {
    loadScenarioSim({
      simStart: '2026-01-01', simEnd: '2032-01-01', stepTo: '2032-01-01', telemetry: 'full',
    });
  } finally {
    Simulation.prototype._processReducers = orig;
  }

  assert.ok(untrackedRuns > 500,
    `expected the scenario to exercise the clone path heavily; saw ${untrackedRuns} runs`);

  if (divergences.length) {
    const sample = divergences.slice(0, 3).map(d =>
      `${d.reducer}: missed ${JSON.stringify(d.onlyInDeep)} extra ${JSON.stringify(d.onlyInShallow)}`).join('\n  ');
    assert.fail(
      `snapshotForDiff lost ${divergences.length} of ${untrackedRuns} diffs — a reducer now mutates ` +
      `state more than one level deep in place, so the journal is silently incomplete.\n  ${sample}\n` +
      `Either make that reducer copy-on-write, or deepen snapshotForDiff. See design 78 §5.5.`);
  }
});

test('SNAP-2: snapshotForDiff preserves one-level in-place writes but is not a deep clone', () => {
  const state = {
    acct:   { balance: 100, holdings: [{ marketValue: 5 }] },
    scalar: 7,
    arr:    [1, 2],
  };
  const snap = state.acct;
  const copy = snapshotForDiff(state);

  // Level 1 is copied: an in-place field write does not reach the snapshot.
  state.acct.balance = 200;
  assert.equal(copy.acct.balance, 100, 'a one-level in-place write must not be visible in the snapshot');
  assert.notEqual(copy.acct, snap, 'top-level objects must be fresh copies');

  // Level 2+ is shared by reference — this is the documented limit, not a bug.
  assert.equal(copy.acct.holdings, snap.holdings,
    'deeper values are shared by reference; reducers must be copy-on-write below level 1');

  // Arrays and primitives round-trip.
  assert.deepEqual(copy.arr, [1, 2]);
  assert.notEqual(copy.arr, state.arr, 'top-level arrays are copied too');
  assert.equal(copy.scalar, 7);
});
