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
 * allocation-mix-totality.test.mjs — design 61 §12.2 Q3.
 *
 * A target mix must name EVERY allocation explicitly. A partial mix is indistinguishable
 * from deliberate zeros, and the difference decides whether a class is *held* or
 * *liquidated*: a glidepath baked before GOLD existed carried only EQUITY/BOND/CASH, so
 * when gold was later added every anchor silently targeted it at 0% and the next rebalance
 * sold it off, with no warning anywhere.
 *
 * The split that makes this work:
 *   - `assertTotalMix`  guards AUTHORED input — a missing key is a mistake, so throw.
 *   - `totalizeMix`     serves DERIVED mixes — backfilling 0 is the intended meaning.
 *
 * The load-bearing case is the MPC harvest: its anchors are partial BY CONSTRUCTION
 * (`synthesizeTargetAllocation` narrows to the classes actually held), so without
 * totalizing the output the tooling would emit glidepaths its own validator rejects.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ALLOCATION, ALLOCATION_VALUES, totalizeMix, assertTotalMix, isTotalMix }
  from '../../src/finance/holdings/allocation.js';
import { synthesizeTargetAllocation, ALLOC_WEIGHT_CLASSES, allocWeightKey, ALLOCATION_PRESETS }
  from '../../src/scenarios/intl-retirement-scenario.js';
import { interpolateGlidepath, resolveRegimeTarget, assertAuthoredMixes, collectAuthoredMixProblems }
  from '../../src/finance/behavioral/rebalance-to-target-reducer.js';

const sum = m => Object.values(m).reduce((s, v) => s + v, 0);

// ── totalizeMix / isTotalMix ────────────────────────────────────────────────

test('totalizeMix: backfills every absent allocation with an explicit 0', () => {
  const total = totalizeMix({ EQUITY: 0.6, BOND: 0.4 });
  assert.deepEqual(Object.keys(total).sort(), [...ALLOCATION_VALUES].sort());
  assert.equal(total[ALLOCATION.GOLD], 0);
  assert.equal(total[ALLOCATION.CASH], 0);
  assert.equal(sum(total), 1);
});

test('totalizeMix: preserves existing weights and tolerates junk input', () => {
  assert.equal(totalizeMix({ GOLD: 0.15 })[ALLOCATION.GOLD], 0.15);
  for (const junk of [null, undefined, {}]) {
    const t = totalizeMix(junk);
    assert.ok(isTotalMix(t), 'always returns a total map');
    assert.equal(sum(t), 0);
  }
});

test('isTotalMix: only true when every allocation is a finite number', () => {
  assert.ok(isTotalMix({ EQUITY: 1, BOND: 0, CASH: 0, GOLD: 0 }));
  assert.ok(!isTotalMix({ EQUITY: 1, BOND: 0, CASH: 0 }));
  assert.ok(!isTotalMix({ EQUITY: 1, BOND: 0, CASH: 0, GOLD: NaN }));
  assert.ok(!isTotalMix(null));
});

// ── assertTotalMix ──────────────────────────────────────────────────────────

test('assertTotalMix: accepts a valid total mix and returns it unchanged', () => {
  const mix = { EQUITY: 0.76, BOND: 0.12, CASH: 0, GOLD: 0.12 };
  assert.equal(assertTotalMix(mix, 'test'), mix);
  for (const preset of Object.values(ALLOCATION_PRESETS)) {
    assert.equal(assertTotalMix(preset, 'preset'), preset, 'every built-in preset is total');
  }
});

test('assertTotalMix: rejects a missing key, and says to write 0 explicitly', () => {
  assert.throws(() => assertTotalMix({ EQUITY: 1, BOND: 0, CASH: 0 }, 'anchor'),
    /anchor: a target mix must name EVERY allocation explicitly — missing GOLD/);
});

test('assertTotalMix: rejects a non-unit sum rather than rescaling it', () => {
  // The authoring bug this exists to catch: `_normalize` used to rescale silently, so
  // 0.75/0.25/0/0.25 (sum 1.25) executed as 0.6/0.2/0/0.2 — 75% equity authored, 60% run.
  assert.throws(() => assertTotalMix({ EQUITY: 0.75, BOND: 0.25, CASH: 0, GOLD: 0.25 }, 'anchor'),
    /must sum to 1, got 1\.250000/);
  assert.throws(() => assertTotalMix({ EQUITY: 0.5, BOND: 0.2, CASH: 0, GOLD: 0 }, 'anchor'),
    /must sum to 1, got 0\.700000/);
});

test('assertTotalMix: rejects unknown classes, negatives, and non-objects', () => {
  assert.throws(() => assertTotalMix({ EQUITY: 1, BOND: 0, CASH: 0, GOLD: 0, SILVER: 0 }, 'x'),
    /unknown allocation "SILVER"/);
  assert.throws(() => assertTotalMix({ EQUITY: 1.2, BOND: -0.2, CASH: 0, GOLD: 0 }, 'x'),
    /negative weight for BOND/);
  assert.throws(() => assertTotalMix(null, 'x'), /expected an allocation weight map/);
  assert.throws(() => assertTotalMix([1, 0, 0, 0], 'x'), /expected an allocation weight map/);
});

test('assertTotalMix: tolerates float noise within epsilon', () => {
  // Stick-breaking rounds to 6dp, so an exact 1.0 is not always reachable.
  assert.doesNotThrow(() => assertTotalMix({ EQUITY: 0.333333, BOND: 0.333333, CASH: 0.333334, GOLD: 0 }, 'x'));
});

// ── the MPC harvest path: partial search, total output ──────────────────────

test('synthesizeTargetAllocation: emits a TOTAL mix even when the search is narrowed', () => {
  // This is what makes an MPC-harvested glidepath anchor valid and re-runnable. The
  // search stays narrow (a class the plan does not hold is a wasted dimension) but the
  // OUTPUT names every allocation.
  const params = { [allocWeightKey(ALLOCATION.EQUITY)]: 0.6, [allocWeightKey(ALLOCATION.BOND)]: 0.5 };

  const narrowed = synthesizeTargetAllocation(params, new Set([ALLOCATION.EQUITY, ALLOCATION.BOND]));
  assert.ok(isTotalMix(narrowed), 'a 2-class search still yields a 4-class mix');
  assert.equal(narrowed[ALLOCATION.GOLD], 0);
  assert.equal(narrowed[ALLOCATION.CASH], 0);
  assert.doesNotThrow(() => assertTotalMix(narrowed, 'harvested anchor'),
    'and it passes the authored-mix validator');

  const full = synthesizeTargetAllocation(params, new Set(ALLOC_WEIGHT_CLASSES));
  assert.ok(isTotalMix(full));
  assert.doesNotThrow(() => assertTotalMix(full, 'full search'));
});

test('synthesizeTargetAllocation: the narrowed search keeps its own weights intact', () => {
  // Totalizing must not disturb the searched dimensions — only add explicit zeros.
  const params = { [allocWeightKey(ALLOCATION.EQUITY)]: 0.6, [allocWeightKey(ALLOCATION.BOND)]: 0.5 };
  const narrowed = synthesizeTargetAllocation(params, new Set([ALLOCATION.EQUITY, ALLOCATION.BOND]));
  assert.ok(Math.abs(narrowed[ALLOCATION.EQUITY] - 0.6) < 1e-6);
  assert.ok(Math.abs(narrowed[ALLOCATION.BOND] - 0.4) < 1e-6, 'BOND is the residual of the narrowed stick');
});

test('synthesizeTargetAllocation: an empty class set stays empty (callers check length)', () => {
  assert.deepEqual(synthesizeTargetAllocation({}, new Set()), {});
});

// ── the schedule resolvers stay total ───────────────────────────────────────

test('interpolateGlidepath: a blend of two total anchors is total and sums to 1', () => {
  const anchors = [
    { age: 50, weights: { EQUITY: 0.80, BOND: 0.10, CASH: 0, GOLD: 0.10 } },
    { age: 70, weights: { EQUITY: 0.40, BOND: 0.50, CASH: 0.10, GOLD: 0 } },
  ];
  for (const age of [40, 50, 60, 70, 80]) {
    const mix = interpolateGlidepath(anchors, age, null);
    assert.ok(isTotalMix(mix), `age ${age} yields a total mix`);
    assert.ok(Math.abs(sum(mix) - 1) < 1e-6, `age ${age} sums to 1`);
  }
  // Midpoint interpolates each class independently.
  const mid = interpolateGlidepath(anchors, 60, null);
  assert.ok(Math.abs(mid[ALLOCATION.GOLD] - 0.05) < 1e-6);
});

test('resolveRegimeTarget: returns the tag\'s mix, still total', () => {
  const map = {
    NORMAL:          { EQUITY: 0.6, BOND: 0.4, CASH: 0, GOLD: 0 },
    ECONOMIC_STRESS: { EQUITY: 0.3, BOND: 0.3, CASH: 0.2, GOLD: 0.2 },
  };
  const stressed = resolveRegimeTarget(map, [{ tags: ['ECONOMIC_STRESS'] }], null);
  assert.ok(isTotalMix(stressed));
  assert.ok(Math.abs(stressed[ALLOCATION.GOLD] - 0.2) < 1e-6);
  assert.ok(isTotalMix(resolveRegimeTarget(map, [], null)), 'NORMAL fallback stays total');
});

// ── assertAuthoredMixes: the compile-time gate ──────────────────────────────

test('assertAuthoredMixes: passes a fully-authored parameter bag', () => {
  assert.doesNotThrow(() => assertAuthoredMixes({
    rebalanceTargetAllocation: { EQUITY: 0.6, BOND: 0.4, CASH: 0, GOLD: 0 },
    allocationGlidepath: [
      { age: 47, weights: { EQUITY: 0.76, BOND: 0.12, CASH: 0, GOLD: 0.12 } },
      { age: 89, weights: { EQUITY: 0,    BOND: 1,    CASH: 0, GOLD: 0 } },
    ],
    allocationRegimeTargets: { NORMAL: { EQUITY: 0.6, BOND: 0.4, CASH: 0, GOLD: 0 } },
  }));
});

test('assertAuthoredMixes: ignores absent params (nothing authored, nothing to check)', () => {
  assert.doesNotThrow(() => assertAuthoredMixes({}));
  assert.doesNotThrow(() => assertAuthoredMixes({ rebalanceTargetAllocation: null,
    allocationGlidepath: null, allocationRegimeTargets: null }));
});

test('assertAuthoredMixes: names the offending anchor by index and age', () => {
  assert.throws(() => assertAuthoredMixes({ allocationGlidepath: [
    { age: 47, weights: { EQUITY: 0.76, BOND: 0.12, CASH: 0, GOLD: 0.12 } },
    { age: 53, weights: { EQUITY: 1,    BOND: 0,    CASH: 0 } },
  ] }), /allocationGlidepath\[1\] \(age 53\)/);
});

test('assertAuthoredMixes: rejects a malformed anchor shape', () => {
  assert.throws(() => assertAuthoredMixes({ allocationGlidepath: [{ weights: { EQUITY: 1, BOND: 0, CASH: 0, GOLD: 0 } }] }),
    /"age" must be a number/);
  assert.throws(() => assertAuthoredMixes({ allocationGlidepath: [null] }),
    /expected \{ age, weights \}/);
  assert.throws(() => assertAuthoredMixes({ allocationRegimeTargets: [] }),
    /expected a \{ regimeTag: mix \} map/);
});

// ─── collectAuthoredMixProblems ───────────────────────────────────────────────
//
// The reporting sibling of `assertAuthoredMixes`, used by the authoring UI to refuse a
// Rebuild and by the boot-time recovery overlay to find the bad value. It has to agree
// with the compiler to the letter — the tests below pin that agreement, because a UI
// that disagreed would either block a valid scenario or wave a broken one through.

test('collectAuthoredMixProblems: reports nothing for a valid bag', () => {
  assert.deepEqual(collectAuthoredMixProblems({
    rebalanceTargetAllocation: { EQUITY: 0.6, BOND: 0.4, CASH: 0, GOLD: 0 },
    allocationGlidepath: [{ age: 47, weights: { EQUITY: 0.76, BOND: 0.12, CASH: 0, GOLD: 0.12 } }],
    allocationRegimeTargets: { NORMAL: { EQUITY: 0.6, BOND: 0.4, CASH: 0, GOLD: 0 } },
  }), []);
  assert.deepEqual(collectAuthoredMixProblems({}), []);
});

test('collectAuthoredMixProblems: keys each problem to its param and index', () => {
  const problems = collectAuthoredMixProblems({ allocationGlidepath: [
    { age: 47, weights: { EQUITY: 0.77, BOND: 0.12, CASH: 0, GOLD: 0.12 } },
    { age: 53, weights: { EQUITY: 1,    BOND: 0,    CASH: 0, GOLD: 0 } },
    { age: 89, weights: { EQUITY: 0,    BOND: 0.9,  CASH: 0, GOLD: 0 } },
  ] });
  assert.equal(problems.length, 2);
  assert.deepEqual(problems.map(p => [p.param, p.index]),
    [['allocationGlidepath', 0], ['allocationGlidepath', 2]]);
  assert.match(problems[0].message, /allocationGlidepath\[0\] \(age 47\).*got 1\.010000/s);
});

test('collectAuthoredMixProblems: reports EVERY bad param, not just the first', () => {
  const problems = collectAuthoredMixProblems({
    rebalanceTargetAllocation: { EQUITY: 0.9, BOND: 0.2, CASH: 0, GOLD: 0 },
    allocationGlidepath: [{ age: 47, weights: { EQUITY: 0.5, BOND: 0.2, CASH: 0, GOLD: 0 } }],
    allocationRegimeTargets: { PANIC_SELL_TRIGGER: { EQUITY: 0, BOND: 0, CASH: 0, GOLD: 0 } },
  });
  assert.deepEqual(problems.map(p => p.param),
    ['rebalanceTargetAllocation', 'allocationGlidepath', 'allocationRegimeTargets']);
});

test('collectAuthoredMixProblems: assertAuthoredMixes throws exactly its first message', () => {
  const bag = { allocationGlidepath: [
    { age: 47, weights: { EQUITY: 0.77, BOND: 0.12, CASH: 0, GOLD: 0.12 } },
  ] };
  const [first] = collectAuthoredMixProblems(bag);
  assert.throws(() => assertAuthoredMixes(bag), (e) => e.message === first.message);
});

test('collectAuthoredMixProblems: malformed shapes are reported, not thrown', () => {
  assert.deepEqual(
    collectAuthoredMixProblems({ allocationGlidepath: [null] }).map(p => [p.param, p.index]),
    [['allocationGlidepath', 0]]);
  assert.deepEqual(
    collectAuthoredMixProblems({ allocationRegimeTargets: [] }).map(p => p.param),
    ['allocationRegimeTargets']);
});
