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
 * lever-reaches-loaded-sim.test.mjs — every MC variable and every Opt / grid lever must
 * reach the sim of a LOADED plan.
 *
 * Found on an MC grid: rows `moveYear`, columns `auHouseSaleYear`, and every cell in a row
 * was identical. The Opt row is keyed on the legacy `auHouseSaleYear`, a loaded cfg
 * carries the quantity only under the generated `prop.auHouseProperty.plannedSaleYear`,
 * and that key — sitting in the lever base at the plan value — won downstream. The MC
 * wage variables were inert the same way, and centred on hardcoded defaults because the
 * base had no legacy key to read.
 *
 * It passed every existing test because those build from `buildDefaultConfig()`, whose
 * flat bag carries the LEGACY keys. Only a loaded plan (the workbench's) has the
 * generated ones. So this gate runs on a loaded cfg, through the MC worker's own path.
 */

import { test }      from 'node:test';
import assert        from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { loadScenarioSim }        from '../helpers/scenario-harness.js';
import { IntlRetirementMcRunner } from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { McGridRunner }           from '../../src/finance/monte-carlo/mc-grid-runner.js';
import { GRID_MODES }             from '../../src/finance/monte-carlo/mc-grid.js';
import { gridCellParams }         from '../../src/finance/monte-carlo/parallel/mc-worker-core.js';
import { buildOptVariables }      from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { get }                    from '../../src/finance/monte-carlo/mc-param-paths.js';
import { applyParamBagToConfig, resolveAliasCenters } from '../../src/scenarios/scenario-param-apply.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { IntlRetirementScenario, INTL_RETIREMENT_PARAM_ALIASES }
                                  from '../../src/scenarios/intl-retirement-scenario.js';

const SIM_END = new Date(Date.UTC(2036, 0, 1));

/** The default plan, LOADED, with both houses on a planned sale. */
function loadedCfg() {
  return loadScenarioSim({ params: { auHouseSaleYear: 2030, usHouseSaleYear: 2028 },
                           simEnd: SIM_END, telemetry: 'off' }).cfg;
}

const hash = (o) => createHash('sha1').update(JSON.stringify(o)).digest('hex');

/** Load one grid cell exactly as an MC worker does; fingerprint the loaded cfg and state. */
function loadCell(ctx, overrides) {
  const gctx = { ...ctx, variables: ctx.variables.map(v => ({ ...v, enabled: false })),
                 cells: [{ overrides }] };
  const params   = gridCellParams(gctx, 0, 0);
  const registry = new ServiceRegistry();
  const scenario = new IntlRetirementScenario({ context: registry.simulationContext, params,
                                                simStart: ctx.simStart, simEnd: ctx.simEnd });
  scenario.buildSim({ seed: 1, telemetry: 'off' });
  const cfg = structuredClone(ctx.cfgTemplate);
  applyParamBagToConfig(cfg, params);
  new ScenarioLoader().load(cfg, registry);
  const { params: _typed, initialState: _init, ...records } = cfg;
  return hash([records, scenario.sim.state]);
}

/** A value off the plan for lever `v`, or undefined when none can be chosen. */
function offPlan(v, plan) {
  if (v.values?.length) return v.values.find(x => JSON.stringify(x) !== JSON.stringify(plan));
  if (typeof plan === 'boolean') return !plan;
  if (typeof plan !== 'number') return undefined;
  if (v.min != null && v.max != null) return Math.abs(v.max - plan) >= Math.abs(plan - v.min) ? v.max : v.min;
  if (v.integer || (Number.isInteger(plan) && plan > 1900 && plan < 2200)) return plan + 3;
  return plan === 0 ? 0.05 : plan * 1.3;
}

test('LRS-1 a legacy-keyed lever centres on its generated successor\'s plan value', () => {
  const cfg = loadedCfg();
  const centers = resolveAliasCenters(cfg);
  assert.strictEqual(centers.auHouseSaleYear, 2030);
  assert.strictEqual(centers.usHouseSaleYear, 2028);

  const { ctx } = new IntlRetirementMcRunner({ simEnd: SIM_END, cfgTemplate: cfg })._prepare({});
  // Every lever keyed on a legacy alias whose successor has a plan value must have one too:
  // without it an MC row centres on a hardcoded default and a grid axis has no reference cell.
  const levers = [...ctx.variables, ...buildOptVariables(ctx.base, null, { cfg })];
  for (const v of levers) {
    const target = INTL_RETIREMENT_PARAM_ALIASES[v.paramKey];
    if (!target || get(ctx.base, target) === undefined) continue;
    assert.notStrictEqual(get(ctx.base, v.paramKey), undefined, `${v.paramKey} has a plan value`);
  }
  const wage = ctx.variables.find(v => v.paramKey === 'primaryMonthlyWage');
  assert.strictEqual(wage.mean, get(ctx.base, 'person.primary.monthlyWage'),
    'the wage variable centres on the plan\'s wage, not the hardcoded default');
});

test('LRS-2 every MC variable and Opt lever reaches the loaded sim', () => {
  const cfg = loadedCfg();
  const { ctx } = new IntlRetirementMcRunner({ simEnd: SIM_END, cfgTemplate: cfg })._prepare({});
  const levers = new Map();
  for (const v of [...ctx.variables, ...buildOptVariables(ctx.base, null, { cfg })]) levers.set(v.paramKey, v);

  const plan = loadCell(ctx, {});
  assert.strictEqual(loadCell(ctx, {}), plan, 'the plan cell loads deterministically');

  const inert = [];
  let tested = 0;
  for (const [key, v] of levers) {
    const value = offPlan(v, get(ctx.base, key));
    if (value === undefined) continue;
    tested++;
    if (loadCell(ctx, { [key]: value }) === plan) inert.push(`${key} → ${JSON.stringify(value)}`);
  }
  assert.ok(tested > 50, `the gate exercised the lever list (tested ${tested})`);
  assert.deepStrictEqual(inert, [], 'a lever whose value never reaches the loaded sim is silently inert');
});

test('LRS-3 an MC grid on the AU house sale year: the column moves the result', async () => {
  const cfg  = loadedCfg();
  const grid = await new McGridRunner({
    simEnd: SIM_END, cfgTemplate: cfg, mode: GRID_MODES.DETERMINISTIC,
    axes: [{ paramKey: 'auHouseSaleYear', values: [2029, 2033] }],
  }).run();

  assert.deepStrictEqual(grid.planValues, [2030], 'the axis has the plan\'s value, so a reference cell');
  const [a, b] = grid.cells.map(c => c.rows[0].nw);
  assert.notStrictEqual(a, b, 'two sale years inside the horizon must not end on the same net worth');
});
