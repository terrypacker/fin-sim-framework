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
 * generated-key-param-paths.test.mjs — design 98 W0.
 *
 * A generated per-record param key (`acct.<stateKey>.<field>`, `raAsset.<stateKey>.<field>`,
 * …) is ONE flat key in `cfg.parameters`, not three levels of nesting. `mc-param-paths`
 * parsed it as a path and `set()` never creates intermediate nodes, so every write of a
 * generated key was a silent no-op and every read returned undefined. The optimizer applies
 * candidates through `set()` (`OptimizationProblem._applyCandidate`), so the Opt rows keyed
 * on generated keys — both savings-account cash floors and the inherited-RA fill ceiling /
 * lump year — were listed, toggleable, cost CEM budget when enabled, and moved nothing.
 *
 * The end-to-end tests are the working detector: each one was run against the unfixed
 * `set()` and produced byte-identical results for both candidates. The fixture controls
 * prove the fixture itself is active, so a pass means "the lever reaches the sim", not
 * "the scenario never exercises the lever".
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { get, set }                 from '../../src/finance/monte-carlo/mc-param-paths.js';
import { isGeneratedParamKey }      from '../../src/scenarios/params/scenario-param-generator.js';
import { OptimizationProblem }      from '../../src/finance/optimization/optimization-problem.js';
import { OPT_PARAM_TYPES }          from '../../src/finance/optimization/optimization-objectives.js';
import { buildOptVariables }        from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { IntlRetirementMcConfig, CENTER_SOURCES }
  from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { DISTRIBUTION_TYPES }       from '../../src/simulation-framework/distributions.js';
import { IntlRetirementScenario }   from '../../src/scenarios/intl-retirement-scenario.js';

const MIN_BAL = 'acct.usSavingsAccount.minimumBalance';

// ── get / set on a flat generated key ────────────────────────────────────────────

test('W0-1: get reads a generated key as one flat key', () => {
  assert.strictEqual(get({ [MIN_BAL]: 25_000 }, MIN_BAL), 25_000);
  assert.strictEqual(get({}, MIN_BAL), undefined);
});

test('W0-2: set writes a generated key flat, creating it when absent', () => {
  const present = { [MIN_BAL]: 1 };
  set(present, MIN_BAL, 5);
  assert.deepStrictEqual(present, { [MIN_BAL]: 5 });

  // An optimizer candidate key need not already be in the base bag.
  const absent = { monthlyExpenses: 4000 };
  set(absent, 'raAsset.inheritedIraAccount.fillCeiling', 120_000);
  assert.deepStrictEqual(absent, { monthlyExpenses: 4000, 'raAsset.inheritedIraAccount.fillCeiling': 120_000 });
});

test('W0-3: an own flat key wins over a nested walk, for any key', () => {
  const obj = { 'a.b': 1, a: { b: 2 } };
  assert.strictEqual(get(obj, 'a.b'), 1);
  set(obj, 'a.b', 3);
  assert.deepStrictEqual(obj, { 'a.b': 3, a: { b: 2 } });
});

test('W0-4: nested paths are unchanged — non-generated keys still never create nodes', () => {
  const people = { people: { primary: { lifeExpectancy: 90 } } };
  set(people, 'people.primary.lifeExpectancy', 85);
  assert.strictEqual(get(people, 'people.primary.lifeExpectancy'), 85);

  const bands = { spendingExpenseBands: [{ monthlyAmount: 7000 }, { monthlyAmount: 6000 }] };
  set(bands, 'spendingExpenseBands[1].monthlyAmount', 6500);
  assert.strictEqual(bands.spendingExpenseBands[1].monthlyAmount, 6500);

  const missing = { a: {} };
  set(missing, 'a.b.c', 42);
  assert.deepStrictEqual(missing, { a: {} });

  const flatWeight = {};
  set(flatWeight, 'drawdownWeight::roth-ira', 0.4);    // design 58: `::` was never a separator
  assert.deepStrictEqual(flatWeight, { 'drawdownWeight::roth-ira': 0.4 });
});

test('W0-5: a generated-prefix path whose parent IS a nested object still walks', () => {
  // State-path addressing (chart / state panel) shares these helpers; a nested object that
  // happens to sit under a generated-looking root must keep resolving as nested.
  const state = { acct: { holdings: [{ id: 'a', marketValue: 1 }] } };
  assert.strictEqual(get(state, 'acct.holdings[id=a].marketValue'), 1);
  set(state, 'acct.holdings[id=a].marketValue', 7);
  assert.strictEqual(state.acct.holdings[0].marketValue, 7);
  assert.ok(!('acct.holdings[id=a].marketValue' in state), 'no stray flat key');
});

test('W0-6: no sweep variable that is a nested path uses a generated namespace', () => {
  // The flat-key rule is only safe if a nested sweep path never starts with a generated
  // prefix. Pin it across every contributor that emits nested paths.
  const simStart = new Date(Date.UTC(2026, 0, 1));
  const simEnd   = new Date(Date.UTC(2034, 0, 1));
  const params = {
    ...IntlRetirementScenario.buildDefaultConfig({}, simStart, simEnd).parameters,
    shocks:                 [{ severity: 0.3, startDate: '2030-01-01' }],
    spendingStrategy:       ['EXPLICIT_BANDS'],
    spendingExpenseBands:   [{ startAge: 65, monthlyAmount: 7000 }],
    rothConversionSchedule: [{ year: 2027, incomeTarget: 100_000 }],
  };
  const keys = [
    ...new IntlRetirementMcConfig().buildVariables(params).map(v => v.paramKey),
    ...buildOptVariables(params).map(v => v.paramKey),
  ];
  const nested = keys.filter(k => k.includes('[') || k.startsWith('people.'));
  assert.ok(nested.length >= 4, `expected nested contributor rows, got ${nested.join(', ')}`);
  for (const k of nested) assert.ok(!isGeneratedParamKey(k), `nested path in a generated namespace: ${k}`);
  for (const k of keys.filter(isGeneratedParamKey)) assert.ok(!k.includes('['), `generated key with an index: ${k}`);
});

// ── MC: a generated-key row centers on the scenario ────────────────────────────

test('W0-7: an MC row keyed on a generated key resolves its center from the scenario', () => {
  class OneRow extends IntlRetirementMcConfig {
    static contributors = [() => [{
      paramKey: MIN_BAL, type: DISTRIBUTION_TYPES.NORMAL, mean: 1, stdDev: 1, group: 'Test', enabled: false,
    }]];
  }
  const [row] = new OneRow().buildVariables({ [MIN_BAL]: 25_000 });
  assert.strictEqual(row.mean, 25_000);
  assert.strictEqual(row.centerSource, CENTER_SOURCES.SCENARIO);
});

// ── Opt: generated-key candidates reach the simulation ─────────────────────────

const SIM = {
  simStart: new Date(Date.UTC(2026, 0, 1)),
  simEnd:   new Date(Date.UTC(2034, 0, 1)),
};

/** One isolated optimizer rollout of the reference plan with `candidate` applied. */
function rollout(candidate, baseParams = {}) {
  const variables = Object.keys(candidate).map(paramKey =>
    ({ paramKey, type: OPT_PARAM_TYPES.INTEGER, min: 0, max: 10_000_000, step: 1 }));
  return new OptimizationProblem({ variables, baseParams, ...SIM }).evaluate(candidate).result;
}

test('W0-8: _applyCandidate writes a generated key into the candidate params', () => {
  const problem = new OptimizationProblem(SIM);
  const params  = problem._applyCandidate({ monthlyExpenses: 4000 }, { [MIN_BAL]: 50_000 });
  assert.strictEqual(params[MIN_BAL], 50_000);
});

test('W0-9: acct.usSavingsAccount.minimumBalance moves the optimizer rollout', () => {
  const low  = rollout({ [MIN_BAL]: 0 });
  const high = rollout({ [MIN_BAL]: 400_000 });
  assert.notDeepStrictEqual(high, low, 'a 400k cash floor must change the run');
});

test('W0-10: raAsset.<sk>.fillCeiling moves the optimizer rollout', () => {
  // The reference plan's example bequest is inert until its year is set. Setting it through
  // baseParams (spread flat into the base, not written by set()) arms the inherited IRA.
  const armed = { 'bequest.estateBequest.inheritanceYear': 2027 };
  const CEIL  = 'raAsset.inheritedIraAccount.fillCeiling';

  // Fixture control: the bequest really is armed, or the ceiling has nothing to act on.
  assert.notDeepStrictEqual(rollout({}, armed), rollout({}),
    'setting the inheritance year must change the run');

  const low  = rollout({ [CEIL]: 40_000 },  armed);
  const high = rollout({ [CEIL]: 400_000 }, armed);
  assert.notDeepStrictEqual(high, low, 'the inherited-IRA fill ceiling must change the run');
});
