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
 * rental-levers.test.mjs — a real property's Monthly Rent and Occupancy are generated
 * params (`prop.<sk>.monthlyRent` / `occupancyRate`), linked to the record like the
 * property's value and appreciation rate, and sweepable by MC and the optimizer.
 *
 * Only while the property is a rental: with `rentalEnabled` off neither field is read, so
 * a lever would move nothing. The effect is tested on a LOADED plan through the MC grid,
 * not just the presence of a row (lever-reaches-loaded-sim.test.mjs has the history).
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { ScenarioParamGenerator }     from '../../src/scenarios/params/scenario-param-generator.js';
import { loadScenarioSim }            from '../helpers/scenario-harness.js';
import { IntlRetirementMcRunner }     from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { McGridRunner }               from '../../src/finance/monte-carlo/mc-grid-runner.js';
import { GRID_MODES }                 from '../../src/finance/monte-carlo/mc-grid.js';
import { buildOptVariables }          from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { get }                        from '../../src/finance/monte-carlo/mc-param-paths.js';
import { computeRentalMonth }         from '../../src/finance/account-rules/rental-income-classes.js';

const SIM_END = new Date(Date.UTC(2032, 0, 1));
const RENT = 'prop.auHouseProperty.monthlyRent';
const OCC  = 'prop.auHouseProperty.occupancyRate';

const prop = (extra) => ({ stateKey: 'h', name: 'H', country: 'AU', value: 800000,
                           appreciationRate: 0.03, plannedSaleDate: null, ...extra });

test('RL-1 the rent levers are generated, linked and seeded only for a rental', () => {
  const keysOf = (p) => ScenarioParamGenerator.generate({ realProperties: [p] }).map(e => e.key);
  assert.ok(!keysOf(prop({ monthlyRent: 3000 })).includes('prop.h.monthlyRent'),
    'not a rental: no rent lever');

  const out = ScenarioParamGenerator.generate({ realProperties: [
    prop({ rentalEnabled: true, monthlyRent: 3000, occupancyRate: 0.9 })] });
  const rent = out.find(e => e.key === 'prop.h.monthlyRent');
  const occ  = out.find(e => e.key === 'prop.h.occupancyRate');
  assert.deepStrictEqual(rent.node, { type: 'realProperty', stateKey: 'h', field: 'monthlyRent' });
  assert.deepStrictEqual(occ.node,  { type: 'realProperty', stateKey: 'h', field: 'occupancyRate' });
  assert.strictEqual(rent.defaultValue, 3000);
  assert.strictEqual(occ.defaultValue, 0.9);
  assert.deepStrictEqual([rent.mc, rent.opt, occ.mc, occ.opt], ['amount', 'amount', 'rate', 'rate']);
});

test('RL-2 occupancy outside [0, 1] is clamped — a rate sweep around 0.95 draws above 1', () => {
  const base = { monthlyRent: 1000, rentalExpenseRatio: 0 };
  const at = (occ) => computeRentalMonth({ ...base, occupancyRate: occ }, { value: 1 }, 'AU').netCash;
  assert.strictEqual(at(1.2), at(1));
  assert.strictEqual(at(-0.1), at(0));
});

function rentalCfg() {
  return loadScenarioSim({
    params: { 'prop.auHouseProperty.plannedSaleDate': '2031-01-15' }, simEnd: SIM_END, telemetry: 'off',
    mutateCfg: (cfg) => {
      const h = cfg.realProperties.find(p => p.stateKey === 'auHouseProperty');
      Object.assign(h, { rentalEnabled: true, monthlyRent: 3000, occupancyRate: 0.9 });
    },
  }).cfg;
}

test('RL-3 on a loaded plan both levers are MC variables and Opt levers, centred on the record', () => {
  const cfg = rentalCfg();
  const { ctx } = new IntlRetirementMcRunner({ simEnd: SIM_END, cfgTemplate: cfg })._prepare({});
  assert.strictEqual(get(ctx.base, RENT), 3000);
  assert.strictEqual(get(ctx.base, OCC), 0.9);
  for (const key of [RENT, OCC]) {
    assert.ok(ctx.variables.some(v => v.paramKey === key), `${key} is an MC variable`);
    assert.ok(buildOptVariables(ctx.base, null, { cfg }).some(v => v.paramKey === key),
      `${key} is an Opt lever`);
  }
});

test('RL-4 a grid on rent × occupancy: every cell ends on its own net worth', async () => {
  const cfg  = rentalCfg();
  const grid = await new McGridRunner({
    simEnd: SIM_END, cfgTemplate: cfg, mode: GRID_MODES.DETERMINISTIC,
    axes: [{ paramKey: RENT, values: [2000, 3000] }, { paramKey: OCC, values: [0.5, 0.9] }],
  }).run();
  assert.deepStrictEqual(grid.planValues, [3000, 0.9]);
  const nw = grid.cells.map(c => c.rows[0].nw);
  assert.strictEqual(new Set(nw).size, 4, 'no two cells end on the same net worth');
  // Row-major, last axis fastest: [2000, .5] [2000, .9] [3000, .5] [3000, .9].
  assert.ok(nw[1] > nw[0] && nw[3] > nw[2], 'higher occupancy ends richer');
  assert.ok(nw[2] > nw[0] && nw[3] > nw[1], 'higher rent ends richer');
});
