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
import { buildOptVariables, buildGridAxes } from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { OPT_PARAM_TYPES }        from '../../src/finance/optimization/optimization-objectives.js';
import { get }                    from '../../src/finance/monte-carlo/mc-param-paths.js';
import { applyParamBagToConfig, resolveAliasCenters } from '../../src/scenarios/scenario-param-apply.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { IntlRetirementScenario, INTL_RETIREMENT_PARAM_ALIASES }
                                  from '../../src/scenarios/intl-retirement-scenario.js';

const SIM_END = new Date(Date.UTC(2036, 0, 1));

/** The default plan, LOADED, with both houses on a planned sale. */
function loadedCfg() {
  return loadScenarioSim({ params: { 'prop.auHouseProperty.plannedSaleDate': '2030-01-15',
                                     'prop.usHouseProperty.plannedSaleDate': '2028-01-15' },
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
  // A date lever (a sale date, design 117): three years later, still inside the horizon.
  if (typeof plan === 'string' && /^\d{4}-\d{2}-\d{2}/.test(plan)) {
    return `${Number(plan.slice(0, 4)) + 3}${plan.slice(4, 10)}`;
  }
  if (typeof plan !== 'number') return undefined;
  if (v.min != null && v.max != null) return Math.abs(v.max - plan) >= Math.abs(plan - v.min) ? v.max : v.min;
  if (v.integer || (Number.isInteger(plan) && plan > 1900 && plan < 2200)) return plan + 3;
  return plan === 0 ? 0.05 : plan * 1.3;
}

test('LRS-1 a legacy-keyed lever centres on its generated successor\'s plan value', () => {
  const cfg = loadedCfg();
  const centers = resolveAliasCenters(cfg);
  // The house sale YEARS are no aliases any more: their successors hold a date, so they
  // are converted on the way in (design 117 phase 2) and no lever is keyed on them.
  assert.strictEqual(centers.auHouseSaleYear, undefined);
  assert.strictEqual(centers.usHouseSaleYear, undefined);

  const { ctx } = new IntlRetirementMcRunner({ simEnd: SIM_END, cfgTemplate: cfg })._prepare({});
  // Every lever keyed on a legacy alias whose successor has a plan value must have one too:
  // without it an MC row centres on a hardcoded default and a grid axis has no reference cell.
  const levers = [...ctx.variables, ...buildOptVariables(ctx.base, null, { cfg })];
  for (const v of levers) {
    const target = INTL_RETIREMENT_PARAM_ALIASES[v.paramKey];
    if (!target || get(ctx.base, target) === undefined) continue;
    assert.notStrictEqual(get(ctx.base, v.paramKey), undefined, `${v.paramKey} has a plan value`);
  }
  // The wage row is the person's own generated key now (design 98 W3.2 amendment), centred
  // on the plan's wage — the legacy `primaryMonthlyWage` row is retired.
  assert.equal(ctx.variables.find(v => v.paramKey === 'primaryMonthlyWage'), undefined);
  const wage = ctx.variables.find(v => v.paramKey === 'person.primary.monthlyWage');
  assert.strictEqual(wage.mean, get(ctx.base, 'person.primary.monthlyWage'),
    'the wage variable centres on the plan\'s wage, not the hardcoded default');
});

test('LRS-2 every MC variable and Opt / grid lever reaches the loaded sim', () => {
  const cfg = loadedCfg();
  const { ctx } = new IntlRetirementMcRunner({ simEnd: SIM_END, cfgTemplate: cfg })._prepare({});
  const levers = new Map();
  for (const v of [...ctx.variables, ...buildGridAxes(ctx.base, null, { cfg })]) levers.set(v.paramKey, v);

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
  assert.ok(levers.has('prop.auHouseProperty.plannedSaleDate')
    && offPlan(levers.get('prop.auHouseProperty.plannedSaleDate'),
      get(ctx.base, 'prop.auHouseProperty.plannedSaleDate')) !== undefined,
    'a sale-DATE lever is in the gate, not skipped for being a string');
  assert.deepStrictEqual(inert, [], 'a lever whose value never reaches the loaded sim is silently inert');
});

test('LRS-3 an MC grid on the AU house sale date: the column moves the result', async () => {
  const cfg  = loadedCfg();
  const grid = await new McGridRunner({
    simEnd: SIM_END, cfgTemplate: cfg, mode: GRID_MODES.DETERMINISTIC,
    axes: [{ paramKey: 'prop.auHouseProperty.plannedSaleDate', values: ['2029-01-15', '2033-07-01'] }],
  }).run();

  assert.deepStrictEqual(grid.planValues, ['2030-01-15'], 'the axis has the plan\'s value, so a reference cell');
  const [a, b] = grid.cells.map(c => c.rows[0].nw);
  assert.notStrictEqual(a, b, 'two sale dates inside the horizon must not end on the same net worth');
});

// The property's starting value is uncertain, not chosen: an MC lever (`mc: true`) but
// never an Opt one. The grid offers it anyway (design 100 §7.2, amended), so a range of
// values can be scanned against a range of sale years; the value then grows along the
// property's path to whichever year it sells in.
test('LRS-4 a grid of AU house value × sale year: every cell is its own world', async () => {
  const cfg = loadedCfg();
  const { ctx } = new IntlRetirementMcRunner({ simEnd: SIM_END, cfgTemplate: cfg })._prepare({});
  const VALUE = 'prop.auHouseProperty.value';
  const DATE  = 'prop.auHouseProperty.plannedSaleDate';
  const plan  = get(ctx.base, VALUE);
  assert.ok(plan > 0, 'the plan carries a starting value for the AU house');

  assert.ok(!buildOptVariables(ctx.base, null, { cfg }).some(v => v.paramKey === VALUE),
    'the optimizer is not offered the house value — nobody chooses it');
  const row = buildGridAxes(ctx.base, null, { cfg }).find(v => v.paramKey === VALUE);
  assert.ok(row, 'the grid offers the house value as an axis');
  assert.strictEqual(row.type, OPT_PARAM_TYPES.CONTINUOUS);
  assert.deepStrictEqual([row.min, row.max], [plan * 0.5, plan * 1.5]);

  const grid = await new McGridRunner({
    simEnd: SIM_END, cfgTemplate: cfg, mode: GRID_MODES.DETERMINISTIC,
    axes: [{ paramKey: VALUE, values: [plan * 0.8, plan] }, { paramKey: DATE, values: ['2030-01-15', '2033-01-15'] }],
  }).run();

  assert.deepStrictEqual(grid.planValues, [plan, '2030-01-15']);
  assert.ok(grid.referenceCell.exact, 'the plan cell is on the grid');
  const nw = grid.cells.map(c => c.rows[0].nw);
  assert.strictEqual(new Set(nw).size, 4, 'no two cells end on the same net worth');
  // Row-major, last axis fastest: [0.8×, 2030] [0.8×, 2033] [plan, 2030] [plan, 2033].
  assert.ok(nw[2] > nw[0] && nw[3] > nw[1], 'a dearer house ends richer, on either sale date');
});

// One property's levers read as one group in both panel modes: the sale date sits beside
// the same house's value.
test('LRS-5 a house\'s value and sale date share one group, in the batch list and the grid axes', () => {
  const cfg = loadedCfg();
  const { ctx } = new IntlRetirementMcRunner({ simEnd: SIM_END, cfgTemplate: cfg })._prepare({});
  const groupsIn = (rows) => Object.fromEntries(rows
    .filter(v => ['prop.auHouseProperty.value', 'prop.auHouseProperty.plannedSaleDate'].includes(v.paramKey))
    .map(v => [v.paramKey, v.group]));
  for (const [mode, rows] of [['batch', ctx.variables], ['grid', buildGridAxes(ctx.base, null, { cfg })]]) {
    const g = groupsIn(rows);
    assert.ok(g['prop.auHouseProperty.value'], `${mode}: the house value is offered`);
    assert.strictEqual(g['prop.auHouseProperty.plannedSaleDate'], g['prop.auHouseProperty.value'],
      `${mode}: the sale date sits in the house's own group`);
  }
});
