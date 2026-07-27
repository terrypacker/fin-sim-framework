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
 * Golden coverage gate.
 *
 * Runs every golden spec, collects the action types that actually fired, and
 * asserts golden-coverage-manifest.js is an exact partition of the action-type
 * universe (everything wired into a golden's compiled config, plus everything
 * observed firing). A new action type therefore lands in neither list and fails
 * this test until it is either covered by a golden or waived on purpose.
 *
 * This is the structural answer to "we keep adding features and not adding them
 * to the golden": the single pre-existing golden had drifted to firing 45 of the
 * 147 action types wired into its own config, and nothing anywhere made that
 * visible. It mirrors reducer-coverage-gate.test.mjs, which does the same job for
 * reducer classes (design 37 §8.5) — that one asks "does this reducer have a
 * test?", this one asks "does any end-to-end run ever reach it?".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GOLDEN_SPECS } from '../helpers/golden-specs.js';
import { getGoldenRun } from '../helpers/golden-harness.js';
import { COVERED, KNOWN_GAPS, ALL_MANIFEST_ACTION_TYPES }
  from '../helpers/golden-coverage-manifest.js';

const fired = new Set();
const wired = new Set();
for (const spec of GOLDEN_SPECS) {
  const run = getGoldenRun(spec);
  for (const t of run.firedActionTypes) fired.add(t);
  for (const t of run.wiredActionTypes) wired.add(t);
}
const universe = new Set([...wired, ...fired]);

const REGOLD_HINT =
  '\n\nTo refresh both lists from the current goldens:\n'
  + '  node -e "..." — or move the entry by hand, which is preferred, because\n'
  + 'a line moving from KNOWN_GAPS to COVERED should be a deliberate claim that a\n'
  + 'golden now exercises it end to end.';

test('golden coverage: the manifest has no duplicate or overlapping entries', () => {
  const dupes = ALL_MANIFEST_ACTION_TYPES.filter(
    (t, i) => ALL_MANIFEST_ACTION_TYPES.indexOf(t) !== i);
  assert.deepEqual([...new Set(dupes)], [],
    'action type listed twice in golden-coverage-manifest.js');
});

test('golden coverage: COVERED lists exactly what the goldens fire', () => {
  const coveredSet = new Set(COVERED);

  const claimedButDead = COVERED.filter(t => !fired.has(t)).sort();
  assert.deepEqual(claimedButDead, [],
    'COVERED claims these action types but no golden fires them.\n'
    + 'Either a golden stopped reaching them (a real coverage regression — find out\n'
    + 'why before editing this list) or they were listed optimistically:\n'
    + `  ${claimedButDead.join('\n  ')}${REGOLD_HINT}`);

  const firedButUnlisted = [...fired].filter(t => !coveredSet.has(t)).sort();
  assert.deepEqual(firedButUnlisted, [],
    'these action types now fire in a golden but are not in COVERED.\n'
    + 'If you just added a golden, move each line out of KNOWN_GAPS into COVERED:\n'
    + `  ${firedButUnlisted.join('\n  ')}`);
});

test('golden coverage: every wired action type is COVERED or an explicit KNOWN_GAP', () => {
  const unaccounted = [...universe].filter(
    t => !ALL_MANIFEST_ACTION_TYPES.includes(t)).sort();
  assert.deepEqual(unaccounted, [],
    'these action types are wired into a golden but appear in neither COVERED nor\n'
    + 'KNOWN_GAPS. A new feature must make a choice: cover it with a golden, or waive\n'
    + 'it in KNOWN_GAPS with a note saying which golden would clear it.\n'
    + `  ${unaccounted.join('\n  ')}`);
});

test('golden coverage: KNOWN_GAPS holds nothing already covered or long gone', () => {
  const stale = KNOWN_GAPS.filter(t => fired.has(t)).sort();
  assert.deepEqual(stale, [],
    'these are waived in KNOWN_GAPS but a golden now fires them — move them to\n'
    + `COVERED, which is the ratchet tightening:\n  ${stale.join('\n  ')}`);

  const vanished = KNOWN_GAPS.filter(t => !universe.has(t)).sort();
  assert.deepEqual(vanished, [],
    'these are waived in KNOWN_GAPS but are no longer wired into any golden — the\n'
    + 'action type was probably renamed or deleted, so drop the line:\n'
    + `  ${vanished.join('\n  ')}`);
});

/**
 * Not an assertion about correctness — a visible number, so coverage cannot decay
 * without someone noticing. Fails only if it goes BACKWARDS past the recorded
 * floor, which is the ratchet: adding a feature without a golden pushes the
 * percentage down, and that is meant to be an explicit decision.
 */
const COVERAGE_FLOOR = 45; // action types fired by the golden set, 2026-08-07

test(`golden coverage: at least ${COVERAGE_FLOOR} action types are exercised end to end`, () => {
  const pct = ((100 * fired.size) / universe.size).toFixed(0);
  assert.ok(
    fired.size >= COVERAGE_FLOOR,
    `golden coverage fell to ${fired.size}/${universe.size} (${pct}%), below the `
    + `recorded floor of ${COVERAGE_FLOOR}. A golden has stopped reaching something `
    + `it used to reach — investigate before lowering this number.`);
});
