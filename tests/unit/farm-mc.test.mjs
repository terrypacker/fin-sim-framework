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
 * farm-mc.test.mjs — Monte Carlo on a farm season (design 134 phase 2).
 *
 * The farm runs on the scenario-agnostic MC path (`McRunner` + the `us-farm` descriptor), so
 * the claims here are the ones the retirement batch already makes, restated for a second
 * scenario: a path with nothing sampled IS the deterministic run; a sampled farm lever reaches
 * the loaded records; a path replays from its params alone; and a worker pool gives the
 * serial batch bit for bit.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { FarmScenario } from '../../src/scenarios/farm-scenario.js';
import { runFarm }      from '../../src/finance/farm/farm-run.js';
import { FarmMcRunner, FarmMcConfig, summarizeFarmMetrics, isFarmIncomeMetric }
  from '../../src/finance/farm/farm-mc.js';
import { farmPathMetrics } from '../../src/finance/farm/farm-mc-scenario.js';
import { mcScenarioFor, perturbParams } from '../../src/finance/monte-carlo/parallel/mc-worker-core.js';
import { applyParamBagToConfig } from '../../src/scenarios/scenario-param-apply.js';
import { McWorkerPool } from '../../src/finance/monte-carlo/parallel/mc-worker-pool.js';
import { nodeMcSpawn }  from './helpers/node-mc-spawn.mjs';

const cfg = () => FarmScenario.buildDefaultConfig();
const RENT = 'farm.field.b-river.rentPerAcre';
const YIELD = 'farm.plan.p-a-home-irr.expectedYield';

/** A catalog with the given rows switched on, at their harvested spreads. */
function withEnabled(...keys) {
  const c = new FarmMcConfig();
  for (const k of keys) c.applyOverride(k, { enabled: true });
  return c;
}

describe('farm Monte Carlo (design 134 phase 2)', () => {
  test('the catalog harvests the farm levers, all off, centred on their records', () => {
    const { ctx } = new FarmMcRunner({ cfgTemplate: cfg() })._prepare();
    const rent = ctx.variables.find(v => v.paramKey === RENT);
    assert.ok(rent, 'the rented field has a rent row');
    assert.strictEqual(rent.mean, 300);
    assert.strictEqual(rent.centerSource, 'scenario');
    assert.ok(ctx.variables.every(v => v.enabled === false), 'nothing is sampled by default');
    assert.ok(ctx.variables.every(v => v.paramKey.startsWith('farm.')));
    // An owned field pays no rent, so it has no rent row (the template's `appliesTo`).
    assert.ok(!ctx.variables.some(v => v.paramKey === 'farm.field.a-home-irr.rentPerAcre'));
  });

  test('with nothing sampled, every path is the deterministic run', async () => {
    const det = runFarm(cfg());
    const detActual = runFarm(cfg(), { machineryBasis: 'ACTUAL' });
    const { runs, summary } = await new FarmMcRunner({ n: 3, cfgTemplate: cfg() }).run();
    assert.strictEqual(runs.length, 3);
    assert.strictEqual(summary.erroredRuns.length, 0);
    for (const r of runs) {
      assert.strictEqual(r.metrics['farm.net.custom'], det.jobCost.farm.net);
      assert.strictEqual(r.metrics['farm.net.actual'], detActual.jobCost.farm.net);
      for (const row of det.cash.filter(x => !x.partial)) {
        assert.strictEqual(r.metrics[`operator.${row.operatorId}.scheduleF`], row.net);
      }
      for (const p of det.jobCost.plans.filter(x => x.planId)) {
        assert.strictEqual(r.metrics[`plan.${p.planId}.net.custom`], p.net);
        assert.strictEqual(r.metrics[`plan.${p.planId}.breakevenPrice.custom`], p.breakevenPrice);
      }
    }
  });

  test('a sampled rent reaches the loaded field, and a path replays from its params', async () => {
    const { runs } = await new FarmMcRunner({ n: 4, cfgTemplate: cfg(), mcConfig: withEnabled(RENT) }).run();
    const rents = runs.map(r => r.params[RENT]);
    assert.strictEqual(new Set(rents).size, 4, 'each path draws its own rent');
    const nets = runs.map(r => r.metrics['farm.net.custom']);
    assert.strictEqual(new Set(nets).size, 4, 'and the rent moves the farm net');
    // Higher rent, lower net, path by path.
    const byRent = runs.map(r => [r.params[RENT], r.metrics['plan.p-b-river.net.custom']]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < byRent.length; i++) assert.ok(byRent[i][1] < byRent[i - 1][1]);
    // Replay: the path's params applied to the template by hand give the path's numbers.
    const r = runs[2];
    const replay = runFarm(applyParamBagToConfig(cfg(), r.params));
    assert.strictEqual(replay.jobCost.farm.net, r.metrics['farm.net.custom']);
    assert.strictEqual(replay.jobCost.plans.find(p => p.planId === 'p-b-river').net,
      r.metrics['plan.p-b-river.net.custom']);
  });

  test('a sampled yield moves the harvest and the plan net', async () => {
    const { runs } = await new FarmMcRunner({ n: 4, cfgTemplate: cfg(), mcConfig: withEnabled(YIELD) }).run();
    const nets = runs.map(r => r.metrics['plan.p-a-home-irr.net.custom']);
    assert.strictEqual(new Set(nets).size, 4);
  });

  test('a farm path writes no retirement process switches into its params', () => {
    const { ctx } = new FarmMcRunner({ cfgTemplate: cfg(), mcConfig: withEnabled(RENT) })._prepare();
    const p = perturbParams(ctx.base, 0, ctx.variables, 'us-farm');
    for (const k of ['equityReturnStochastic', 'inflationStochastic', 'primeRateModel']) {
      assert.ok(!(k in p), `${k} is a retirement switch`);
    }
    // The retirement default still writes them (a context without a kind is a retirement one).
    assert.strictEqual(perturbParams({}, 0, [])['equityReturnStochastic'], true);
  });

  test('an unknown scenario kind is refused, not run as a retirement', () => {
    assert.throws(() => mcScenarioFor('no-such-scenario'), /no scenario descriptor/);
  });

  test('a worker pool gives the serial batch bit for bit', async () => {
    const mk = (opts) => new FarmMcRunner({ n: 5, cfgTemplate: cfg(), mcConfig: withEnabled(RENT, YIELD), ...opts });
    const serial = await mk().run();
    const pool = new McWorkerPool({ size: 2, spawn: nodeMcSpawn() });
    let par;
    try { par = await mk({ workerPool: pool }).run(); } finally { pool.terminate(); }
    assert.deepStrictEqual(par.runs, serial.runs);
    assert.deepStrictEqual(par.summary, serial.summary);
  });
});

describe('farm MC summary', () => {
  test('percentiles, and a loss probability on the incomes only', () => {
    const runs = [-10, 0, 10, 20, 30].map(x => ({
      metrics: { 'farm.net.custom': x, 'crop.CORN.breakevenPrice.custom': x === 0 ? null : 4 + x / 100 },
    }));
    const s = summarizeFarmMetrics(runs);
    assert.strictEqual(s['farm.net.custom'].p50, 10);
    assert.strictEqual(s['farm.net.custom'].lossProbability, 0.2);
    assert.strictEqual(s['farm.net.custom'].min, -10);
    assert.strictEqual(s['crop.CORN.breakevenPrice.custom'].n, 4, 'a null breakeven is left out');
    assert.ok(!('lossProbability' in s['crop.CORN.breakevenPrice.custom']));
  });

  test('which metrics are incomes', () => {
    assert.ok(isFarmIncomeMetric('farm.net.actual'));
    assert.ok(isFarmIncomeMetric('operator.opA.scheduleF'));
    assert.ok(!isFarmIncomeMetric('plan.p1.netPerAcre.custom'));
    assert.ok(!isFarmIncomeMetric('crop.CORN.breakevenYield.custom'));
  });

  test('path metrics cover every plan, operator and crop under both bases', () => {
    const r = runFarm(cfg());
    const m = farmPathMetrics(r.cfg, r.sim);
    for (const p of r.farm.cropPlans) for (const b of ['custom', 'actual']) assert.ok(`plan.${p.id}.net.${b}` in m);
    for (const o of r.farm.operators) assert.ok(`operator.${o.id}.scheduleF` in m);
    assert.ok('crop.SOYBEANS.breakevenYield.actual' in m);
    // A mixed-crop group has no price breakeven.
    assert.strictEqual(m['farm.breakevenPrice.custom'], null);
  });
});
