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
 * `mainResidenceFrom` is a stored date, and since design 117 phase 6 its lever is the date
 * itself: `prop.<sk>.mainResidenceFrom`, a Date row filed in Cross Border beside moveDate.
 * The Opt row steps in months, because the US §121 2-of-5 test is a cliff at 730 days and
 * a whole-year grid strides over it.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { loadScenarioSim }        from '../helpers/scenario-harness.js';
import { IntlRetirementMcRunner } from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { buildOptVariables, buildGridAxes } from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { OPT_PARAM_TYPES }        from '../../src/finance/optimization/optimization-objectives.js';
import { DISTRIBUTION_TYPES }     from '../../src/simulation-framework/distributions.js';
import { applyParamBagToConfig }  from '../../src/scenarios/scenario-param-apply.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioParamGenerator } from '../../src/scenarios/params/scenario-param-generator.js';
import { roundRecordField }       from '../../src/scenarios/params/record-field-rounding.js';

const KEY     = 'prop.auHouseProperty.mainResidenceFrom';
const MOVE_IN = '2029-05-26';
const SIM_END = new Date(Date.UTC(2036, 0, 1));

/** The default plan, LOADED, with the AU house bought in 2026 and moved into later. */
function loadedCfg() {
  return loadScenarioSim({
    params: { 'prop.auHouseProperty.plannedSaleDate': '2032-01-15' }, simEnd: SIM_END, telemetry: 'off',
    mutateCfg: (cfg) => {
      const au = cfg.realProperties.find(r => r.stateKey === 'auHouseProperty');
      Object.assign(au, { isPrimaryResidence: false, acquisitionDate: '2026-01-01',
                          mainResidenceFrom: MOVE_IN });
    },
  }).cfg;
}

test('MRF-1 the cascade writes the move-in date as its day', () => {
  assert.strictEqual(roundRecordField('mainResidenceFrom', MOVE_IN), MOVE_IN);
  assert.strictEqual(roundRecordField('mainResidenceFrom', '2030-07-01T00:00:00.000Z'), '2030-07-01');
  assert.strictEqual(roundRecordField('mainResidenceFrom', null), null);
});

test('MRF-2 the generated param is a Date in Cross Border, seeded from the record', () => {
  const cfg = { realProperties: [
    { stateKey: 'auHouseProperty', name: 'AU House', country: 'AU', mainResidenceFrom: MOVE_IN },
    { stateKey: 'usHouseProperty', name: 'US House', country: 'US' },
  ] };
  const byKey = new Map(ScenarioParamGenerator.generate(cfg).map(e => [e.key, e]));
  const au = byKey.get(KEY);
  assert.strictEqual(au.type, 'Date');
  assert.strictEqual(au.group, 'Cross Border');
  assert.strictEqual(au.defaultValue, MOVE_IN);
  assert.strictEqual(au.fractionalYear, undefined);
  assert.deepStrictEqual(au.node, { type: 'realProperty', stateKey: 'auHouseProperty', field: 'mainResidenceFrom' });
  assert.ok(byKey.get('prop.usHouseProperty.mainResidenceFrom').defaultValue == null,
    'no move-in date → no centre');
  assert.ok(!byKey.has('prop.auHouseProperty.mainResidenceFromYear'), 'the proxy key is retired');
  assert.strictEqual(byKey.get('prop.auHouseProperty.value').group, 'AU · AU House',
    'the rest of the house keeps its own group');
});

test('MRF-3 the MC list, the grid and the optimizer offer a date row beside moveDate', () => {
  const cfg = loadedCfg();
  const { ctx } = new IntlRetirementMcRunner({ simEnd: SIM_END, cfgTemplate: cfg })._prepare({});

  const mc = ctx.variables.find(v => v.paramKey === KEY);
  assert.ok(mc, 'the MC batch list offers the move-in date');
  assert.strictEqual(mc.group, 'Cross Border');
  assert.strictEqual(mc.group, ctx.variables.find(v => v.paramKey === 'moveDate').group,
    'in the same section as the move date');
  assert.deepStrictEqual([mc.type, mc.min, mc.max],
    [DISTRIBUTION_TYPES.UNIFORM_DATE, '2027-05-26', '2031-05-26']);

  for (const [name, rows] of [['grid', buildGridAxes(ctx.base, null, { cfg })],
                              ['opt',  buildOptVariables(ctx.base, null, { cfg })]]) {
    const row = rows.find(v => v.paramKey === KEY);
    assert.ok(row, `${name}: offered`);
    assert.strictEqual(row.group, 'Cross Border', `${name}: in Cross Border`);
    assert.strictEqual(rows.find(v => v.paramKey === 'moveDate').group, row.group,
      `${name}: beside the move date, as in the batch list`);
    assert.deepStrictEqual([row.type, row.min, row.max, row.step],
      [OPT_PARAM_TYPES.DATE, '2027-05-26', '2031-05-26', 1], `${name}: ±2 years in months`);
    assert.strictEqual(row.anchor, undefined, `${name}: any day of the year`);
  }
});

test('MRF-4 a lever value reaches the loaded record — a legacy fractional key too', () => {
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
  assert.strictEqual(load({ [KEY]: MOVE_IN }), MOVE_IN);
  assert.strictEqual(load({ [KEY]: '2030-07-15' }), '2030-07-15');
  assert.strictEqual(load({ 'prop.auHouseProperty.mainResidenceFromYear': 2030.5 }), '2030-07-01',
    'an old run\'s recorded proxy still moves the date');
});
