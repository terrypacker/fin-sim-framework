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

import { IntlRetirementMcConfig, CENTER_SOURCES, variablesMissingCenter }
  from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { buildOptVariables }      from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { OPT_PARAM_TYPES }        from '../../src/finance/optimization/optimization-objectives.js';
import { DISTRIBUTION_TYPES }     from '../../src/simulation-framework/distributions.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioParamGenerator } from '../../src/scenarios/params/scenario-param-generator.js';
import { resolveRecordCenters }   from '../../src/scenarios/scenario-param-apply.js';
import { perturbParams }          from '../../src/finance/monte-carlo/parallel/mc-worker-core.js';
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

// W3-3 (a pinned account growthRate surfaces its generated row) is retired with the
// field: design 99 P2 generates no per-account growth rate. That also settles design 98
// §7 Q1 (null-centered per-account rows) — there are none left to center.

test('W3-4: a quantity with a legacy alias appears once, under its generated key', () => {
  const { cfg, base } = reference();
  const vars = mcVars({ ...base, primaryMonthlyWage: 9_000, 'person.primary.monthlyWage': 9_000 }, { cfg });
  // The legacy row is retired (design 98 W3.2 amendment); fromVariableConfigs maps a saved one.
  assert.equal(byKey(vars, 'primaryMonthlyWage'), undefined);
  assert.equal(vars.filter(v => v.paramKey === 'person.primary.monthlyWage').length, 1);
});

// W3-5 was "hidden entries never appear" — the rule design 98 W3.2 withdrew on 2026-09-26:
// the curated legacy balance rows it protected named the reference plan's accounts only.
test('W3-5: a hidden entry is harvested with a center, and never without one', () => {
  const { cfg, base } = reference();
  const generated = ScenarioParamGenerator.generate(cfg);
  const hidden = generated.filter(e => e.hidden && e.mc && e.defaultValue);
  assert.ok(hidden.length > 0, 'the reference plan has holdings-bearing accounts');

  // Without its center in the base (the loaded cfg's own params never carry it)…
  const none = mcVars(base, { cfg }).filter(v => hidden.some(e => e.key === v.paramKey));
  assert.deepEqual(none.map(v => v.paramKey), [], 'no synthesized center (rule 3)');

  // …and with it: every one, once.
  const withHidden = { ...base, ...Object.fromEntries(hidden.map(e => [e.key, e.defaultValue])) };
  const rows = mcVars(withHidden, { cfg }).filter(v => hidden.some(e => e.key === v.paramKey));
  assert.deepEqual(rows.map(v => v.paramKey).sort(), hidden.map(e => e.key).sort());
  assert.ok(rows.every(v => v.harvested && !v.enabled));
});

test('W3-6: every harvested row on the reference plan is scenario-centred, never default', () => {
  const { cfg, base } = reference();
  const harvested = mcVars(base, { cfg }).filter(v => v.harvested);
  assert.ok(harvested.length > 0);
  for (const v of harvested) {
    assert.notEqual(v.centerSource, CENTER_SOURCES.DEFAULT, `${v.paramKey} centred on a default`);
  }
});

test('W3-7: the moves are date rows on their anchor day, only when set; any year row is integer', () => {
  const vars = mcVars({ stateMoveDate: '2031-01-01', moveDate: '2030-07-01' });
  for (const [k, anchor, min, max] of [['stateMoveDate', '01-01', '2029-01-01', '2033-01-01'],
                                       ['moveDate', '07-01', '2028-07-01', '2032-07-01']]) {
    const row = byKey(vars, k);
    assert.ok(row, `${k} should be an MC row`);
    assert.deepEqual([row.type, row.anchor, row.min, row.max], [DISTRIBUTION_TYPES.UNIFORM_DATE, anchor, min, max]);
  }
  assert.equal(byKey(mcVars({}), 'stateMoveDate'), undefined, 'an unset move has no row');
  const opt = buildOptVariables({ moveDate: '2030-07-01' });
  assert.deepEqual(['type', 'anchor', 'step'].map(k => byKey(opt, 'moveDate')[k]),
    [OPT_PARAM_TYPES.DATE, '07-01', 1], 'the Opt row steps whole years on 1 Jul');
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

// ── Unset years (design 98 W3.2 rule 3 amendment) ──────────────────────────────
//
// A sale date left blank means the sale does not happen. It is still offered — as an
// UNSET row — because "and if we did sell, when?" is a question both engines can ask.

/** A plan with one house that has no planned sale, and one that does. */
function unsetPlan() {
  const cfg = {
    simStart: '2026-01-01T00:00:00.000Z', simEnd: '2060-01-01T00:00:00.000Z',
    realProperties: [
      { stateKey: 'cabin', name: 'Cabin', country: 'US', value: 400_000, plannedSaleDate: null },
      { stateKey: 'flat',  name: 'Flat',  country: 'AU', value: 600_000, plannedSaleDate: '2035-01-15' },
    ],
  };
  return { cfg, base: { ...resolveRecordCenters(cfg) } };
}

test('W3-8: a blank sale date is an UNSET MC row — disabled, no center, tagged', () => {
  const { cfg, base } = unsetPlan();
  const vars = mcVars(base, { cfg });
  const cabin = byKey(vars, 'prop.cabin.plannedSaleDate');
  assert.ok(cabin, 'the blank sale date is offered');
  assert.equal(cabin.unset, true);
  assert.equal(cabin.enabled, false);
  assert.equal(cabin.mean, undefined, 'no synthesized center');
  assert.equal(cabin.type, DISTRIBUTION_TYPES.NORMAL_DATE, 'a date spread, waiting for a mean date');
  assert.equal(cabin.centerSource, CENTER_SOURCES.UNSET);
  // The set one is an ordinary date row around its own day.
  const flat = byKey(vars, 'prop.flat.plannedSaleDate');
  assert.equal(flat.unset, undefined);
  assert.deepEqual([flat.type, flat.min, flat.max],
    [DISTRIBUTION_TYPES.UNIFORM_DATE, '2033-01-15', '2037-01-15']);
});

test('W3-9: an unset Opt row searches the plan window', () => {
  const { cfg, base } = unsetPlan();
  const cabin = byKey(buildOptVariables(base, null, { cfg }), 'prop.cabin.plannedSaleDate');
  assert.deepEqual([cabin.unset, cabin.type, cabin.min, cabin.max, cabin.step],
    [true, OPT_PARAM_TYPES.DATE, '2026-01-01', '2060-01-01', 1]);
});

test('W3-10: only a `sweepUnset` null is offered — a null meaning "use the default" is not', () => {
  const { cfg, base } = unsetPlan();
  const generated = ScenarioParamGenerator.generate(cfg);
  assert.ok(generated.find(e => e.key === 'prop.cabin.plannedSaleDate').sweepUnset);
  // A blank move-in date is a null year without the flag: still no row (design 83 G7).
  const withBlankMoveIn = { ...base, 'prop.cabin.mainResidenceFromYear': null };
  assert.equal(byKey(mcVars(withBlankMoveIn, { cfg }), 'prop.cabin.mainResidenceFromYear'), undefined);
  // And the flag does not open the harvest to a key whose value is simply ABSENT.
  const absent = { ...base };
  delete absent['prop.cabin.plannedSaleDate'];
  assert.equal(byKey(mcVars(absent, { cfg }), 'prop.cabin.plannedSaleDate'), undefined);
});

test('W3-11: a disabled unset row writes nothing; an enabled one without a mean is refused', () => {
  const { cfg, base } = unsetPlan();
  const cabin = byKey(mcVars(base, { cfg }), 'prop.cabin.plannedSaleDate');
  // Base holds the null → untouched. Base without the key → still nothing written.
  assert.strictEqual(perturbParams(base, 0, [cabin])['prop.cabin.plannedSaleDate'], null);
  assert.ok(!('prop.cabin.plannedSaleDate' in perturbParams({}, 0, [cabin])));

  assert.deepEqual(variablesMissingCenter([{ ...cabin, enabled: true }]).map(v => v.paramKey),
    ['prop.cabin.plannedSaleDate']);
  // With a typed mean date it samples days around it (σ 548 days ≈ 1.5 years).
  const typed = { ...cabin, enabled: true, mean: '2040-03-01' };
  assert.deepEqual(variablesMissingCenter([typed]), []);
  const d = perturbParams(base, 0, [typed])['prop.cabin.plannedSaleDate'];
  assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Math.abs(Date.parse(d) - Date.parse('2040-03-01')) < 10 * 365 * 86_400_000, `sampled ${d}`);
});

test('W3-12: a saved legacy wage / sale-year setting moves to the generated key it aliased', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({ 'prop.usHouseProperty.plannedSaleDate': '2035-01-15' });
  const base = { ...resolveRecordCenters(cfg) };
  const mc = IntlRetirementMcConfig.fromVariableConfigs([
    { paramKey: 'usHouseSaleYear',    enabled: true, type: DISTRIBUTION_TYPES.NORMAL, mean: 2036, stdDev: 1 },
    { paramKey: 'primaryMonthlyWage', enabled: true, type: DISTRIBUTION_TYPES.NORMAL, mean: 9000, stdDev: 100 },
  ]);
  const vars = mc.buildVariables(base, { cfg });
  // A saved sale-YEAR row becomes a sale-DATE row of the same shape (design 117 D10).
  const sale = byKey(vars, 'prop.usHouseProperty.plannedSaleDate');
  assert.deepEqual([sale?.type, sale?.mean, sale?.stdDev, sale?.enabled],
    [DISTRIBUTION_TYPES.NORMAL_DATE, '2036-01-15', 365, true]);
  assert.equal(byKey(vars, 'person.primary.monthlyWage')?.mean, 9000);
  assert.equal(byKey(vars, 'usHouseSaleYear'), undefined);
  assert.equal(byKey(vars, 'primaryMonthlyWage'), undefined);
});
