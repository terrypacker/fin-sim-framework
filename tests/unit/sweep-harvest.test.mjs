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
 * sweep-harvest.test.mjs — design 98 W3: the MC and Opt variable lists harvest
 * every flagged schema entry the curated overlay does not already offer.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { IntlRetirementMcConfig, CENTER_SOURCES }
  from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { buildOptVariables }      from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { OPT_PARAM_TYPES }        from '../../src/finance/optimization/optimization-objectives.js';
import { DISTRIBUTION_TYPES }     from '../../src/simulation-framework/distributions.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioParamGenerator } from '../../src/scenarios/params/scenario-param-generator.js';
import { paramSchemaDefaults, scenarioParamValues }
  from '../../src/finance/param-schema-utils.js';

const mcVars  = (params, opts) => new IntlRetirementMcConfig().buildVariables(params, opts);
const byKey   = (vars, k) => vars.find(v => v.paramKey === k);

/** The reference plan as the MC runner sees it: schema defaults under the template's params. */
function reference() {
  const cfg = IntlRetirementScenario.buildDefaultConfig({},
    new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2041, 0, 1)));
  const base = { ...paramSchemaDefaults(IntlRetirementScenario.buildFullParamSchema()),
    ...scenarioParamValues(cfg) };
  return { cfg, base };
}

test('W3-1: a flagged scalar with no overlay row is harvested disabled, centred on the scenario value', () => {
  const row = byKey(mcVars({ goldGrowthRate: 0.06 }), 'goldGrowthRate');
  assert.ok(row, 'goldGrowthRate (mc: true, not curated) should be harvested');
  assert.equal(row.harvested, true);
  assert.equal(row.enabled, false);
  assert.equal(row.type, DISTRIBUTION_TYPES.NORMAL);
  assert.equal(row.mean, 0.06);
  assert.ok(Math.abs(row.stdDev - 0.012) < 1e-12, 'rate kind: sd = max(0.005, 20% of |center|)');
  assert.equal(row.centerSource, CENTER_SOURCES.SCENARIO);
  assert.equal(row.label, 'Gold Growth Rate', 'identity from the schema');
});

test('W3-2: an absent or null value is not harvested — no synthesized centers', () => {
  assert.equal(byKey(mcVars({}), 'goldGrowthRate'), undefined);
  assert.equal(byKey(mcVars({ goldGrowthRate: null }), 'goldGrowthRate'), undefined);
});

test('W3-3: a pinned account growthRate surfaces its generated row; unpinned it does not', () => {
  const { cfg, base } = reference();
  const key = ScenarioParamGenerator.generate(cfg).map(e => e.key)
    .find(k => /^acct\..+\.growthRate$/.test(k));
  assert.ok(key, 'the reference plan generates at least one acct.*.growthRate');
  assert.equal(byKey(mcVars(base, { cfg }), key), undefined, 'null = inherit the role rate: no row');
  const row = byKey(mcVars({ ...base, [key]: 0.08 }, { cfg }), key);
  assert.ok(row, `${key} appears once the account is pinned`);
  assert.equal(row.mean, 0.08);
  assert.equal(row.centerSource, CENTER_SOURCES.SCENARIO);
});

test('W3-4: an alias-covered generated key does not appear twice', () => {
  const { cfg, base } = reference();
  const vars = mcVars({ ...base, usHouseSaleYear: 2035,
    'prop.usHouseProperty.plannedSaleYear': 2035 }, { cfg });
  assert.ok(byKey(vars, 'usHouseSaleYear'), 'the legacy row stays for saved configs');
  assert.equal(byKey(vars, 'prop.usHouseProperty.plannedSaleYear'), undefined);
});

test('W3-5: hidden entries never appear', () => {
  const { cfg, base } = reference();
  const generated = ScenarioParamGenerator.generate(cfg);
  const hidden = new Set(generated.filter(e => e.hidden).map(e => e.key));
  assert.ok(hidden.size > 0);
  const withHidden = { ...base, ...Object.fromEntries(generated.map(e => [e.key, e.defaultValue])) };
  const leaked = mcVars(withHidden, { cfg }).filter(v => v.harvested && hidden.has(v.paramKey));
  assert.deepEqual(leaked.map(v => v.paramKey), []);
});

test('W3-6: every harvested row on the reference plan is scenario-centred, never default', () => {
  const { cfg, base } = reference();
  const harvested = mcVars(base, { cfg }).filter(v => v.harvested);
  assert.ok(harvested.length > 0);
  for (const v of harvested) {
    assert.notEqual(v.centerSource, CENTER_SOURCES.DEFAULT, `${v.paramKey} centred on a default`);
  }
});

test('W3-7: year rows (stateMoveYear, moveYear) are harvested with integer: true, only when set', () => {
  const vars = mcVars({ stateMoveYear: 2031, moveYear: 2030 });
  for (const k of ['stateMoveYear', 'moveYear']) {
    const row = byKey(vars, k);
    assert.ok(row, `${k} should be an MC row`);
    assert.equal(row.integer, true);
    assert.equal(row.stdDev, 1.5);
  }
  assert.equal(byKey(mcVars({}), 'stateMoveYear'), undefined, 'an unset move has no row');
  const { cfg, base } = reference();
  for (const v of mcVars(base, { cfg }).filter(r => r.sweepKind === 'year')) {
    assert.equal(v.integer, true, `${v.paramKey} is a year row without integer: true`);
  }
});

test('W3-8: Opt harvests rates as a ±0.02 range and Booleans as a two-value enum', () => {
  const vars = buildOptVariables({ discretionarySharePct: 0.3, dividendReinvest: false });
  const share = byKey(vars, 'discretionarySharePct');
  assert.ok(share?.harvested);
  assert.deepEqual([share.type, share.min, share.max, share.step],
    [OPT_PARAM_TYPES.CONTINUOUS, 0.28, 0.32, 0.005]);
  const reinvest = byKey(vars, 'dividendReinvest');
  assert.ok(reinvest?.harvested);
  assert.deepEqual([reinvest.type, reinvest.values], [OPT_PARAM_TYPES.ENUM, [false, true]]);
  // opt: false entries (W2) are never harvested.
  assert.equal(byKey(buildOptVariables({ goldGrowthRate: 0.05 }), 'goldGrowthRate'), undefined);
});
