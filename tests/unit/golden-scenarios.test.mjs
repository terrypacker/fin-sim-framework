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
import { getGoldenRun, diffAgainstFixture, writeFixture, readFixture, findNonFinite,
         findOutOfSync, REGOLD }
  from '../helpers/golden-harness.js';
import { isWaivedDesync, allWaivedDesyncs, KNOWN_DESYNCS }
  from '../helpers/golden-invariant-waivers.js';

for (const spec of GOLDEN_SPECS) {
  // Runs even under REGOLD: a NaN must never be baked into a fixture, where JSON
  // would silently record it as `null` and make it permanent.
  test(`golden '${spec.name}': final state holds no NaN or Infinity`, () => {
    const bad = findNonFinite(getGoldenRun(spec).state);
    assert.deepEqual(bad, [], `non-finite value(s) in final state:\n  ${bad.join('\n  ')}`);
  });
}

for (const spec of GOLDEN_SPECS) {
  // Also runs under REGOLD, and for the same reason as the NaN check above: a fixture
  // records values, so a balance that has parted company with the assets behind it is
  // baked in as just another number and re-golds forever. The fixtures pin VALUES;
  // this is the only thing pinning a RELATIONSHIP between them (design 25 §4.4).
  test(`golden '${spec.name}': every account's balance equals Σ its holdings (§4.4)`, () => {
    const found   = findOutOfSync(getGoldenRun(spec).state);
    const unwaived = found.filter(f => !isWaivedDesync(spec.name, f.stateKey));
    assert.deepEqual(unwaived.map(f => f.line), [],
      `balance has come adrift from holdings:\n  ${unwaived.map(f => f.line).join('\n  ')}\n\n`
      + 'Either the reducer that moved the money forgot to move the lots (or vice versa),\n'
      + 'or this is a known defect — in which case add it to tests/helpers/\n'
      + 'golden-invariant-waivers.js with what it is worth and what owns it.');
  });
}

test('§4.4 waivers: every waived account is still out of sync', () => {
  // The other half of the gate. A waiver is a defect somebody wrote down, so a fix that
  // lands without deleting its line leaves the list quietly claiming a bug that is gone —
  // and the next real one hides behind it.
  const stale = [];
  for (const { golden, stateKey } of allWaivedDesyncs()) {
    const spec = GOLDEN_SPECS.find(s => s.name === golden);
    if (!spec) { stale.push(`${golden}:${stateKey} — no such golden`); continue; }
    if (!findOutOfSync(getGoldenRun(spec).state).some(f => f.stateKey === stateKey)) {
      stale.push(`${golden}:${stateKey} — now in sync; delete the waiver`);
    }
  }
  assert.deepEqual(stale, [], `stale §4.4 waiver(s):\n  ${stale.join('\n  ')}`);
});

test('§4.4 waivers: each one says what it is worth and what owns it', () => {
  for (const [golden, accounts] of Object.entries(KNOWN_DESYNCS)) {
    for (const [stateKey, note] of Object.entries(accounts)) {
      assert.ok(note?.length > 40,
        `waiver ${golden}:${stateKey} needs a note naming the defect and its size`);
    }
  }
});

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
