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
 * golden-scenarios.test.mjs — full end-state lock-in for every golden spec.
 *
 * Each golden in GOLDEN_SPECS runs to its simEnd and its ENTIRE final state is
 * compared, field by field, against a committed fixture in tests/fixtures/.
 * A failure prints the specific fields that moved.
 *
 * Regold deliberately, never reflexively:
 *
 *     REGOLD=1 node --test tests/unit/golden-scenarios.test.mjs
 *     git diff tests/fixtures/          # read every line before committing
 *
 * A fixture diff is evidence about a code change, not a chore. The nine sub-1%
 * moves logged in cross-border-relief-scenario.test.mjs were all real behavioral
 * changes that the old ±1% golden could not see; several turned out to be bugs
 * only because they were measured by hand. This test does that measuring.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { GOLDEN_SPECS }  from '../helpers/golden-specs.js';
import { getGoldenRun, diffAgainstFixture, writeFixture, readFixture, findNonFinite, REGOLD }
  from '../helpers/golden-harness.js';

for (const spec of GOLDEN_SPECS) {
  // Runs even under REGOLD: a NaN must never be baked into a fixture, where JSON
  // would silently record it as `null` and make it permanent.
  test(`golden '${spec.name}': final state holds no NaN or Infinity`, () => {
    const bad = findNonFinite(getGoldenRun(spec).state);
    assert.deepEqual(bad, [], `non-finite value(s) in final state:\n  ${bad.join('\n  ')}`);
  });
}

for (const spec of GOLDEN_SPECS) {
  test(`golden '${spec.name}': end state matches fixture`, () => {
    const { snapshot } = getGoldenRun(spec);

    if (REGOLD) {
      writeFixture(spec.name, snapshot);
      return; // regold mode records; it does not assert
    }

    assert.notEqual(
      readFixture(spec.name), null,
      `no fixture for golden '${spec.name}'. Create it with:\n`
      + `  REGOLD=1 node --test tests/unit/golden-scenarios.test.mjs`);

    const diff = diffAgainstFixture(spec.name, snapshot);
    assert.equal(diff, '', `\n${diff}\n`);
  });
}

test('golden specs are well-formed and uniquely named', () => {
  const names = GOLDEN_SPECS.map(s => s.name);
  assert.equal(new Set(names).size, names.length, 'duplicate golden spec name');
  for (const s of GOLDEN_SPECS) {
    assert.ok(s.description?.length > 40,
      `golden '${s.name}' needs a description saying which designs it protects`);
    assert.ok(s.simEnd > s.simStart, `golden '${s.name}' has a non-positive span`);
  }
});
