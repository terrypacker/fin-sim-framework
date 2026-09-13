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
 * mc-grid-runner.test.mjs — the lever grid engine (design 100 §7).
 *
 * The claims that make a grid trustworthy, each asserted exactly (the sim is
 * bit-deterministic):
 *   - a cell at the plan's own values IS the MC tab's batch (MC mode) or the plan's
 *     single run (deterministic mode) — one engine, not a lookalike;
 *   - an axis that is also a sampled variable is taken out of sampling, stays live,
 *     and every cell remains paired;
 *   - a sharded grid is bit-identical to a serial one.
 * A short horizon and small n keep the real sims fast enough for CI.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { McGridRunner, gridCellRuns } from '../../src/finance/monte-carlo/mc-grid-runner.js';
import { GRID_MODES, nearestIndex, cellIndexOf, referenceCellOf } from '../../src/finance/monte-carlo/mc-grid.js';
import { IntlRetirementMcRunner } from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { IntlRetirementMcConfig, DEFAULT_MC_VARIABLE_CONFIGS }
                           from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { runsToRows, pairingMismatches } from '../../src/finance/monte-carlo/mc-analysis.js';
import { get }             from '../../src/finance/monte-carlo/mc-param-paths.js';
import { McWorkerPool }    from '../../src/finance/monte-carlo/parallel/mc-worker-pool.js';
import { nodeMcSpawn }     from './helpers/node-mc-spawn.mjs';

const SIM_END  = new Date(Date.UTC(2030, 0, 1));
const template = () => IntlRetirementScenario.buildDefaultConfig({ fxProcessModel: 'NONE' }, undefined, SIM_END);
// A lever that is an Opt row and NOT an MC variable, so the plan-values cell must equal
// the plain batch with nothing re-cut. It must HAVE a plan value: the first choice here
// (`rothConversionStartYear`) is null on the default plan, and the tests still passed
// with `undefined` and `NaN` as axis values. `planValue` now refuses that.
const LEVER = 'moveYear';

/** The value the batch world runs at for `key`; throws when the plan carries none. */
function planValue(key) {
  const { ctx } = new IntlRetirementMcRunner({ simEnd: SIM_END, cfgTemplate: template() })._prepare({});
  const v = get(ctx.base, key);
  assert.ok(Number.isInteger(v), `${key} has an integer plan value (got ${JSON.stringify(v)})`);
  return v;
}

const strip = (rows) => rows.map(({ cell: _cell, ...r }) => r);
const grid  = (opts) => new McGridRunner({ simEnd: SIM_END, cfgTemplate: template(), ...opts });

describe('mc-grid helpers', () => {
  test('MGR-1 nearestIndex, cellIndexOf and the reference cell', () => {
    assert.equal(nearestIndex([2030, 2032, 2034], 2032), 1);
    assert.equal(nearestIndex([2030, 2032, 2034], 2033.2), 2);
    assert.equal(nearestIndex(['A', 'B'], 'C'), null, 'an enum value off the list has no nearest');
    assert.equal(nearestIndex([1, 2], undefined), null);

    const axes = [{ values: [1, 2, 3] }, { values: ['x', 'y'] }];
    assert.equal(cellIndexOf(axes, [2, 1]), 5, 'row-major, last axis fastest');
    assert.deepEqual(referenceCellOf(axes, [2, 'y']), { index: 3, idx: [1, 1], exact: true });
    assert.deepEqual(referenceCellOf(axes, [2.4, 'z']), { index: 2, idx: [1, 0], exact: false });
  });

  test('MGR-2 the constructor refuses a grid that cannot mean anything', () => {
    assert.throws(() => grid({ axes: [] }), /one or two axes/);
    assert.throws(() => grid({ axes: [{ paramKey: LEVER, values: [] }] }), /no values/);
    assert.throws(() => grid({ axes: [{ paramKey: LEVER, values: [1] }, { paramKey: LEVER, values: [2] }] }),
      /different levers/);
    assert.throws(() => grid({ axes: [{ paramKey: LEVER, values: [1] }], mode: 'bogus' }), /unknown mode/);
  });
});

describe('McGridRunner (design 100 §7)', () => {
  test('MGR-3 an MC cell at the plan\'s values is the MC batch, exactly', async () => {
    const plan = planValue(LEVER);
    const plain = await new IntlRetirementMcRunner({ n: 3, simEnd: SIM_END, cfgTemplate: template() }).run();
    const g = await grid({ n: 3, axes: [{ paramKey: LEVER, values: [plan, plan + 2] }] }).run();

    assert.deepEqual(g.referenceCell, { index: 0, idx: [0], exact: true });
    assert.deepEqual(g.removedFromSampling, []);
    assert.deepStrictEqual(strip(g.cells[0].rows), runsToRows(plain.runs));
    assert.deepStrictEqual(g.cells[0].summary.pairing.sampled, plain.summary.pairing.sampled);

    // The Runs panel's rebuilt params are the params the path ran with, exactly — which
    // is what makes Replay on a grid path reproduce it.
    const cellRuns = gridCellRuns(g, 0);
    assert.deepStrictEqual(cellRuns.map(r => r.seed), plain.runs.map(r => r.seed));
    assert.deepStrictEqual(cellRuns.map(r => r.params), plain.runs.map(r => r.params));

    // Design 100 §10.5: the fields a cell ranks on are on every grid row, and they are the
    // batch's numbers (the deepStrictEqual above already holds them equal).
    for (const k of ['netLiq', 'taxPaid', 'deficit', 'deficitMonths', 'troughRealDrawdown', 'minRealNetLiq']) {
      assert.ok(g.cells[0].rows.every(r => Number.isFinite(r[k])), `${k} is on every grid row`);
    }
    assert.deepStrictEqual(cellRuns.map(r => r.finalNetLiquidity), plain.runs.map(r => r.finalNetLiquidity));
  });

  test('MGR-4 a deterministic cell at the plan\'s values is the single run, exactly', async () => {
    const plan   = planValue(LEVER);
    const allOff = IntlRetirementMcConfig.fromVariableConfigs(
      DEFAULT_MC_VARIABLE_CONFIGS.map(v => ({ ...v, enabled: false })));
    const single = await new IntlRetirementMcRunner({ n: 1, simEnd: SIM_END, cfgTemplate: template(), mcConfig: allOff })
      .run({ mcSequenceRisk: false });

    const g = await grid({ n: 50, mode: GRID_MODES.DETERMINISTIC, axes: [{ paramKey: LEVER, values: [plan, plan + 2] }] }).run();

    assert.equal(g.n, 1, 'a deterministic cell is one path whatever n says');
    assert.ok(g.cells.every(c => c.rows.length === 1));
    assert.deepStrictEqual(strip(g.cells[0].rows), runsToRows(single.runs));
    assert.deepEqual(g.cells[0].summary.pairing.sampled, [], 'nothing is sampled');
    assert.equal(g.cells[0].summary.pairing.mcSequenceRisk, false);
  });

  test('MGR-5 an axis that is a sampled variable leaves sampling, stays live, and cells stay paired', async () => {
    const key = 'inflationRate';
    assert.ok(DEFAULT_MC_VARIABLE_CONFIGS.some(v => v.paramKey === key && v.enabled), `${key} is sampled by default`);

    const g = await grid({ n: 2, axes: [{ paramKey: key, values: [0.01, 0.08] }] }).run();

    assert.deepEqual(g.removedFromSampling, [key]);
    assert.ok(!g.cells[0].summary.pairing.sampled.some(s => s.key === key));
    assert.deepEqual(pairingMismatches(g.cells[0].summary.pairing, g.cells[1].summary.pairing), []);
    assert.notEqual(g.cells[0].rows[0].nw, g.cells[1].rows[0].nw, 'the axis moves the result — it is not inert');
  });

  test('MGR-6 a sharded 2-D grid is bit-identical to the serial one, cells in row-major order', async () => {
    const plan = planValue(LEVER);
    const axes = [{ paramKey: LEVER, values: [plan, plan + 1] }, { paramKey: 'inflationRate', values: [0.02, 0.04] }];

    const serial = await grid({ n: 2, axes }).run();
    const pool = new McWorkerPool({ size: 3, spawn: nodeMcSpawn() });
    let par;
    try {
      par = await grid({ n: 2, axes, workerPool: pool }).run();
    } finally {
      pool.terminate();
    }

    assert.deepStrictEqual(par, serial);
    assert.deepEqual(serial.cells.map(c => c.values),
      [[plan, 0.02], [plan, 0.04], [plan + 1, 0.02], [plan + 1, 0.04]]);
  });
});
