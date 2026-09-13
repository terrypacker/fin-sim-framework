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
 * main-residence-from-lever.test.mjs — the move-in date as a sweepable lever.
 *
 * `mainResidenceFrom` is a stored date; the lever is `prop.<sk>.mainResidenceFromYear`, a
 * FRACTIONAL year, filed in Cross Border beside moveYear. Fractional because the US §121
 * 2-of-5 test is a cliff at 730 days and a whole-year grid strides over it.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { loadScenarioSim }        from '../helpers/scenario-harness.js';
import { IntlRetirementMcRunner } from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { buildOptVariables, buildGridAxes } from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { OPT_PARAM_TYPES }        from '../../src/finance/optimization/optimization-objectives.js';
import { applyParamBagToConfig }  from '../../src/scenarios/scenario-param-apply.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioParamGenerator } from '../../src/scenarios/params/scenario-param-generator.js';
import { dateToFractionalYear, fractionalYearToIsoDate, recordFieldPatch }
                                  from '../../src/scenarios/params/record-field-rounding.js';

const KEY     = 'prop.auHouseProperty.mainResidenceFromYear';
const MOVE_IN = '2029-05-26';
const SIM_END = new Date(Date.UTC(2036, 0, 1));

/** The default plan, LOADED, with the AU house bought in 2026 and moved into later. */
function loadedCfg() {
  return loadScenarioSim({
    params: { auHouseSaleYear: 2032 }, simEnd: SIM_END, telemetry: 'off',
    mutateCfg: (cfg) => {
      const au = cfg.realProperties.find(r => r.stateKey === 'auHouseProperty');
      Object.assign(au, { isPrimaryResidence: false, acquisitionDate: '2026-01-01',
                          mainResidenceFrom: MOVE_IN });
    },
  }).cfg;
}

test('MRF-1 a fractional year is month-based and round-trips a date exactly', () => {
  assert.strictEqual(dateToFractionalYear('2031-07-01'), 2031.5);
  assert.strictEqual(dateToFractionalYear('2031-01-01T00:00:00.000Z'), 2031);
  assert.strictEqual(fractionalYearToIsoDate(2031.5), '2031-07-01');
  assert.strictEqual(fractionalYearToIsoDate(2031.25), '2031-04-01');
  for (const iso of ['2029-05-26', '2028-02-29', '2030-12-31', '2031-01-01', '2032-11-15']) {
    assert.strictEqual(fractionalYearToIsoDate(dateToFractionalYear(iso)), iso, iso);
  }
  assert.strictEqual(dateToFractionalYear(null), null);
  assert.strictEqual(dateToFractionalYear('not a date'), null);
});

test('MRF-2 the cascade writes the date, and is a no-op at the plan value or null', () => {
  const rec = { mainResidenceFrom: MOVE_IN };
  assert.deepStrictEqual(recordFieldPatch(rec, 'mainResidenceFromYear', dateToFractionalYear(MOVE_IN)), {},
    'the plan value leaves the authored date string untouched');
  assert.deepStrictEqual(recordFieldPatch(rec, 'mainResidenceFromYear', null), {},
    'a null lever never clears a move-in date');
  assert.deepStrictEqual(recordFieldPatch(rec, 'mainResidenceFromYear', 2030.5),
    { mainResidenceFrom: '2030-07-01' });
  assert.deepStrictEqual(recordFieldPatch(rec, 'plannedSaleYear', 2030.4), { plannedSaleYear: 2030 },
    'an ordinary field still rounds');
});

test('MRF-3 the generated param lives in Cross Border, seeded from the date', () => {
  const cfg = { realProperties: [
    { stateKey: 'auHouseProperty', name: 'AU House', country: 'AU', mainResidenceFrom: MOVE_IN },
    { stateKey: 'usHouseProperty', name: 'US House', country: 'US' },
  ] };
  const byKey = new Map(ScenarioParamGenerator.generate(cfg).map(e => [e.key, e]));
  const au = byKey.get(KEY);
  assert.strictEqual(au.group, 'Cross Border');
  assert.strictEqual(au.defaultValue, dateToFractionalYear(MOVE_IN));
  assert.strictEqual(au.fractionalYear, true);
  assert.deepStrictEqual(au.node, { type: 'realProperty', stateKey: 'auHouseProperty', field: 'mainResidenceFromYear' });
  assert.strictEqual(byKey.get('prop.usHouseProperty.mainResidenceFromYear').defaultValue, null,
    'no move-in date → no centre');
  assert.strictEqual(byKey.get('prop.auHouseProperty.value').group, 'AU · AU House',
    'the rest of the house keeps its own group');
});

test('MRF-4 the MC list, the grid and the optimizer offer it beside moveYear, fractional', () => {
  const cfg = loadedCfg();
  const { ctx } = new IntlRetirementMcRunner({ simEnd: SIM_END, cfgTemplate: cfg })._prepare({});
  const plan = dateToFractionalYear(MOVE_IN);

  const mc = ctx.variables.find(v => v.paramKey === KEY);
  assert.ok(mc, 'the MC batch list offers the move-in date');
  assert.strictEqual(mc.group, ctx.variables.find(v => v.paramKey === 'moveYear').group,
    'in the same section as the move year');
  assert.strictEqual(mc.group, 'Cross Border');
  assert.strictEqual(mc.mean, plan);
  assert.ok(!mc.integer, 'an MC draw keeps its fraction');

  for (const [name, rows] of [['grid', buildGridAxes(ctx.base, null, { cfg })],
                              ['opt',  buildOptVariables(ctx.base, null, { cfg })]]) {
    const row = rows.find(v => v.paramKey === KEY);
    assert.ok(row, `${name}: offered`);
    assert.strictEqual(row.group, 'Cross Border', `${name}: in Cross Border`);
    assert.strictEqual(rows.find(v => v.paramKey === 'moveYear').group, row.group,
      `${name}: beside the move year, as in the batch list`);
    assert.strictEqual(row.type, OPT_PARAM_TYPES.CONTINUOUS, `${name}: not whole years`);
    assert.strictEqual(row.step, 0.5);
  }
});

test('MRF-5 a lever value reaches the loaded record; the plan value leaves it alone', () => {
  const template = loadedCfg();
  // As an MC worker loads a cell (lever-reaches-loaded-sim `loadCell`): build, then load.
  const load = (bag) => {
    const registry = new ServiceRegistry();
    new IntlRetirementScenario({ context: registry.simulationContext, params: bag,
                                 simStart: new Date(template.simStart), simEnd: SIM_END })
      .buildSim({ seed: 1, telemetry: 'off' });
    const cfg = structuredClone(template);
    applyParamBagToConfig(cfg, bag);
    new ScenarioLoader().load(cfg, registry);
    return cfg.realProperties.find(r => r.stateKey === 'auHouseProperty').mainResidenceFrom;
  };
  assert.strictEqual(load({}), MOVE_IN);
  assert.strictEqual(load({ [KEY]: dateToFractionalYear(MOVE_IN) }), MOVE_IN);
  assert.strictEqual(load({ [KEY]: 2030.5 }), '2030-07-01');
});
