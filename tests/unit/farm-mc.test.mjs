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
import { FarmMcRunner, FarmMcConfig, summarizeFarmMetrics, isFarmIncomeMetric, withPriceVol }
  from '../../src/finance/farm/farm-mc.js';
import { farmPathMetrics } from '../../src/finance/farm/farm-mc-scenario.js';
import { normalizeFarm, priceOn, validateFarm } from '../../src/finance/farm/farm-records.js';
import { FARM_CALIBRATION } from '../../src/finance/farm/farm-calibration.js';
import { mcScenarioFor, perturbParams } from '../../src/finance/monte-carlo/parallel/mc-worker-core.js';
import { applyParamBagToConfig } from '../../src/scenarios/scenario-param-apply.js';
import { McWorkerPool } from '../../src/finance/monte-carlo/parallel/mc-worker-pool.js';
import { nodeMcSpawn }  from './helpers/node-mc-spawn.mjs';

const cfg = () => FarmScenario.buildDefaultConfig();
const RENT = 'farm.field.b-river.rentPerAcre';
const YIELD = 'farm.plan.p-a-home-irr.yieldShock';
const FARM_YIELD = 'farm.season.s2027.yieldShock';

/** A catalog with the given rows switched on, at their harvested spreads. */
function withEnabled(...keys) {
  const c = new FarmMcConfig();
  for (const k of keys) c.applyOverride(k, { enabled: true, ...(/yieldShock$/.test(k) ? { stdDev: 0.1 } : {}) });
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

// The mechanics tests pin a UNIT shape (every field takes the whole shock, both crops alike, no
// price link), so they test the arithmetic, not the calibration; §13.8's tests test that.
const UNIT_SHAPE = { irrigatedYieldBeta: 1, yieldShockScale: { CORN: 1, SOYBEANS: 1 }, priceYieldBeta: { CORN: 0, SOYBEANS: 0 } };

describe('realized yield (design 134 §13.3, step 2b)', () => {
  const withShocks = (season, plans = {}, beta) => {
    const c = cfg();
    Object.assign(c.farm.seasons[0], UNIT_SHAPE, { yieldShock: season, ...(beta != null ? { irrigatedYieldBeta: beta } : {}) });
    for (const p of c.farm.cropPlans) if (plans[p.id] != null) p.yieldShock = plans[p.id];
    return c;
  };
  const plan = (r, id) => r.jobCost.plans.find(p => p.planId === id);

  test('a yield shock moves the harvest and the net, never the plan or its breakevens', () => {
    const det = runFarm(cfg());
    const short = runFarm(withShocks(-0.2));
    for (const id of ['p-a-home-dry', 'p-a-home-irr', 'p-a-west', 'p-b-river']) {
      const d = plan(det, id), s = plan(short, id);
      assert.strictEqual(s.expectedBushels, d.expectedBushels);
      assert.ok(Math.abs(s.harvestedBushels - 0.8 * d.harvestedBushels) < 1e-6);
      // The breakevens divide by the PLAN's bushels. Their cost side is what the season
      // spent, which a short crop changes only through storage (fewer bushels held).
      assert.strictEqual(s.breakevenPrice, (s.totalCost - s.revenue.other) / s.expectedBushels);
      assert.strictEqual(s.directCost - s.storage, d.directCost - d.storage);
    }
    assert.ok(short.jobCost.farm.net < det.jobCost.farm.net);
  });

  test('irrigated fields take β of the farm-wide shock; dry fields take all of it', () => {
    const r = runFarm(withShocks(-0.2, {}, 0.25));
    assert.ok(Math.abs(plan(r, 'p-a-home-irr').realizedYield - 230 * 0.95) < 1e-9);
    assert.ok(Math.abs(plan(r, 'p-a-home-dry').realizedYield - 50 * 0.8) < 1e-9);
  });

  test('a field shock is the field\'s own, and pool revenue follows the harvested bushels', () => {
    const det = runFarm(cfg());
    const r = runFarm(withShocks(0, { 'p-a-west': -0.5 }));
    assert.strictEqual(plan(r, 'p-a-home-dry').harvestedBushels, plan(det, 'p-a-home-dry').harvestedBushels);
    // opA's two soybean fields share one pool: the short field's share of its revenue falls.
    const share = (x) => plan(x, 'p-a-west').revenue.grain
      / (plan(x, 'p-a-west').revenue.grain + plan(x, 'p-a-home-dry').revenue.grain);
    assert.ok(share(r) < share(det));
  });

  test('a yield shock can not take a harvest below zero', () => {
    const r = runFarm(withShocks(-3));
    for (const p of r.jobCost.plans.filter(x => x.planId)) assert.strictEqual(p.harvestedBushels, 0);
  });

  test('the yield rows are the catalog\'s: off, centred on 0, the farm-wide ones calibrated', () => {
    const { ctx } = new FarmMcRunner({ cfgTemplate: cfg() })._prepare();
    const rows = ctx.variables.filter(v => /\.(yieldShock|irrigatedYieldShock)$/.test(v.paramKey));
    assert.strictEqual(rows.length, 6, 'the season\'s two and every crop plan\'s');
    const sd = Object.fromEntries(rows.map(v => [v.paramKey, v.stdDev]));
    assert.strictEqual(sd[FARM_YIELD], FARM_CALIBRATION.yieldShockSd);
    assert.strictEqual(sd['farm.season.s2027.irrigatedYieldShock'], FARM_CALIBRATION.irrigatedYieldShockSd);
    assert.strictEqual(sd[YIELD], 0, 'a field\'s own spread needs its yield history (Q26)');
    for (const v of rows) {
      assert.strictEqual(v.enabled, false);
      assert.strictEqual(v.mean, 0);
      assert.ok(!v.harvested, 'not the harvest\'s generic spread');
    }
    assert.ok(!ctx.variables.some(v => v.paramKey.endsWith('.expectedYield')), 'the plan yield is not sampled');
  });

  test('switched on at zero spread, a yield row leaves every path the deterministic run', async () => {
    const c = new FarmMcConfig();
    c.applyOverride(FARM_YIELD, { enabled: true, stdDev: 0 });
    const det = runFarm(cfg());
    const { runs } = await new FarmMcRunner({ n: 2, cfgTemplate: cfg(), mcConfig: c }).run();
    for (const r of runs) assert.strictEqual(r.metrics['farm.net.custom'], det.jobCost.farm.net);
  });

  test('a sampled farm-wide shock moves every field together', async () => {
    const { runs } = await new FarmMcRunner({ n: 4, cfgTemplate: cfg(), mcConfig: withEnabled(FARM_YIELD) }).run();
    const low = runs.reduce((a, b) => (a.params[FARM_YIELD] < b.params[FARM_YIELD] ? a : b));
    const high = runs.reduce((a, b) => (a.params[FARM_YIELD] > b.params[FARM_YIELD] ? a : b));
    // Dry fields: a good year is more bushels, and their price falls by less than they gain.
    for (const id of ['p-a-home-dry', 'p-a-west']) {
      assert.ok(low.metrics[`plan.${id}.revenue`] < high.metrics[`plan.${id}.revenue`], id);
    }
    // An irrigated field gains only β of the bushels and takes the whole price fall: a good
    // dryland year costs it revenue. The natural hedge, the other way round.
    assert.ok(low.metrics['plan.p-b-river.revenue'] > high.metrics['plan.p-b-river.revenue']);
  });
});

describe('price paths (design 134 §13.5, step 2c)', () => {
  const farmWith = (season = {}, shocks = {}) => {
    const c = cfg();
    Object.assign(c.farm.seasons[0], season);
    for (const p of c.farm.prices) if (shocks[p.id] != null) p.shock = shocks[p.id];
    return c;
  };
  const prices = (c) => normalizeFarm(c.farm).prices;
  const row = (c, id) => prices(c).find(p => p.id === id);

  test('at zero volatility and zero link the realized path is the table', () => {
    for (const p of prices(farmWith({}, { 'pc-harvest': 2, 'pc-winter': -1 }))) assert.strictEqual(p.realized, p.price);
  });

  test('a shock moves its row and every later row of the crop, not the other crop', () => {
    const c = farmWith({ priceVol: { CORN: 0.2 } }, { 'pc-harvest': 1 });
    const h = row(c, 'pc-harvest'), w = row(c, 'pc-winter'), sp = row(c, 'pc-spring');
    // Plan date 1 Jan 2027 → 1 Oct 2027.
    const dt = (Date.parse('2027-10-01') - Date.parse('2027-01-01')) / (365.25 * 86_400_000);
    assert.ok(Math.abs(h.realized - 4.10 * Math.exp(0.2 * Math.sqrt(dt) - 0.02 * dt)) < 1e-12);
    // A later row inherits the move (less its own drift), so the path is one path.
    assert.ok(w.realized / w.price > 1 && sp.realized / sp.price > 1);
    assert.ok(w.realized / w.price < h.realized / h.price);
    for (const p of prices(c).filter(x => x.crop === 'SOYBEANS')) assert.strictEqual(p.realized, p.price);
    // A row on or before the plan date is already known.
    assert.strictEqual(row(c, 'pc-carry').realized, row(c, 'pc-carry').price);
  });

  test('the drift keeps the mean of a realized price at the table', () => {
    // E[exp(σ√t·z − ½σ²t)] = 1: average over a symmetric normal quadrature.
    const zs = [-2.651961, -1.673552, -0.816288, 0, 0.816288, 1.673552, 2.651961];
    const ws = [0.000971781, 0.054515583, 0.425607252, 0.810264618, 0.425607252, 0.054515583, 0.000971781];
    // Gauss–Hermite nodes x for weight e^(−x²); a standard normal draw is √2·x.
    const mean = zs.reduce((s, x, i) => s + ws[i] * row(farmWith({ priceVol: { CORN: 0.3 } }, { 'pc-harvest': Math.SQRT2 * x }), 'pc-harvest').realized, 0)
      / Math.sqrt(Math.PI);
    assert.ok(Math.abs(mean / 4.10 - 1) < 1e-5, `mean ${mean}`);
  });

  test('a short farm crop raises the price from harvest on, by the yield–price link', () => {
    const c = farmWith({ ...UNIT_SHAPE, yieldShock: -0.2, priceYieldBeta: { CORN: 0.5 } });
    assert.ok(Math.abs(row(c, 'pc-harvest').realized - 4.10 * Math.exp(0.1)) < 1e-12);
    assert.ok(Math.abs(row(c, 'pc-winter').realized - 4.35 * Math.exp(0.1)) < 1e-12, 'taken once, then carried');
    assert.strictEqual(row(c, 'pc-carry').realized, 4.30);
  });

  test('sales are paid on the realized path; the breakevens keep the planned price', () => {
    const det = runFarm(cfg());
    const up = runFarm(farmWith({ priceVol: { CORN: 0.2, SOYBEANS: 0.2 } }, { 'pc-harvest': 1.5, 'ps-harvest': 1.5 }));
    const plan = (r, id) => r.jobCost.plans.find(p => p.planId === id);
    assert.ok(up.jobCost.farm.revenue.total > det.jobCost.farm.revenue.total);
    for (const id of ['p-a-home-irr', 'p-b-river', 'p-a-west']) {
      assert.strictEqual(plan(up, id).expectedPrice, plan(det, id).expectedPrice);
    }
  });

  test('a contract shortfall settles at the realized market price', () => {
    // A near-total crop failure with a dear market: opB delivers what it has and buys out the rest.
    const c = farmWith({ ...UNIT_SHAPE, yieldShock: -0.95, priceYieldBeta: { CORN: 1 } });
    const r = runFarm(c);
    const k = r.ledger.find(p => p.receivableId === 'contract:k-b-corn' && p.kind === 'REVENUE');
    const market = priceOn(normalizeFarm(c.farm).prices, 'CORN', '2027-10-25', 'realized');
    const harvested = 146 * 225 * Math.max(0, 1 - 0.95);
    const expected = harvested * 4.35 + (12_000 - harvested) * (4.35 - market);
    assert.ok(market > 4.35, 'the market is above the contract');
    assert.ok(Math.abs(k.amount - expected) < 1e-6, `${k.amount} vs ${expected}`);
  });

  test('the catalog offers one standard-normal shock per price row, and no raw price rows', () => {
    const { ctx } = new FarmMcRunner({ cfgTemplate: cfg() })._prepare();
    const rows = ctx.variables.filter(v => v.paramKey.startsWith('farm.price.'));
    assert.strictEqual(rows.length, cfg().farm.prices.length);
    for (const v of rows) {
      assert.ok(v.paramKey.endsWith('.shock'));
      assert.strictEqual(v.stdDev, 1);
      assert.strictEqual(v.enabled, false);
    }
  });

  test('sampled shocks under a volatility vary the paths and replay from their params', async () => {
    const c = farmWith({ priceVol: { CORN: 0.25 } });
    const m = new FarmMcConfig();
    for (const p of c.farm.prices.filter(x => x.crop === 'CORN')) m.applyOverride(`farm.price.${p.id}.shock`, { enabled: true });
    const { runs, summary } = await new FarmMcRunner({ n: 3, cfgTemplate: c, mcConfig: m }).run();
    assert.deepStrictEqual(summary.provenance.priceVolFilled, {}, 'corn has its own vol');
    assert.strictEqual(new Set(runs.map(r => r.metrics['crop.CORN.revenue'])).size, 3);
    assert.strictEqual(new Set(runs.map(r => r.metrics['crop.SOYBEANS.revenue'])).size, 1, 'soybean prices are not sampled');
    const replay = runFarm(applyParamBagToConfig(farmWith({ priceVol: { CORN: 0.25 } }), runs[1].params));
    assert.strictEqual(replay.jobCost.farm.net, runs[1].metrics['farm.net.custom']);
  });
});

describe('multipliers and contracted share (design 134 §13.6, step 2d)', () => {
  const withSeason = (fields, edit) => {
    const c = cfg();
    Object.assign(c.farm.seasons[0], fields);
    edit?.(c.farm);
    return c;
  };
  const sumCat = (r, cat) => r.ledger.filter(p => p.category === cat && p.cropYear === 2027).reduce((s, p) => s + p.amount, 0);

  test('each multiplier scales exactly its cost family', () => {
    const det = runFarm(cfg());
    const r = runFarm(withSeason({ rentMultiplier: 1.1, nitrogenMultiplier: 1.3, customRateMultiplier: 0.9,
      machineryMultiplier: 1.2, irrigationMultiplier: 1.5 }));
    for (const [cat, k] of [['LAND_RENT', 1.1], ['NITROGEN', 1.3], ['CUSTOM_RATE', 0.9],
      ['MACHINERY', 1.2], ['IRRIGATION_ELECTRICITY', 1.5]]) {
      assert.ok(Math.abs(sumCat(r, cat) - k * sumCat(det, cat)) < 1e-6, cat);
    }
    for (const cat of ['SEED', 'HERBICIDE', 'PROPERTY_TAX', 'CROP_INSURANCE']) assert.strictEqual(sumCat(r, cat), sumCat(det, cat));
  });

  test('the interest multiplier moves only a variable-rate interest row', () => {
    const det = runFarm(cfg());
    const fixed = runFarm(withSeason({ interestMultiplier: 1.5 }));
    assert.strictEqual(sumCat(fixed, 'INTEREST_MORTGAGE'), sumCat(det, 'INTEREST_MORTGAGE'));
    const variable = runFarm(withSeason({ interestMultiplier: 1.5 }, f => { f.overhead.find(o => o.id === 'oh-a-int').variableRate = true; }));
    assert.ok(Math.abs(sumCat(variable, 'INTEREST_MORTGAGE') - 1.5 * sumCat(det, 'INTEREST_MORTGAGE')) < 1e-6);
  });

  test('variableRate on a non-interest row is a load error', () => {
    const c = withSeason({}, f => { f.overhead.find(o => o.id === 'oh-a-ins').variableRate = true; });
    assert.ok(validateFarm(c.farm).some(e => /variableRate goes on an interest row/.test(e)));
  });

  test('a contract sized as a share of the expected crop', () => {
    const c = withSeason({}, f => {
      const k = f.contracts.find(x => x.id === 'k-b-corn');
      delete k.bushels; k.shareOfExpected = 0.5;
    });
    const k = normalizeFarm(c.farm).contracts.find(x => x.id === 'k-b-corn');
    assert.strictEqual(k.bushels, 0.5 * 146 * 225);
    // A short crop below the contracted share leaves a shortfall, settled at the market.
    // The river field is irrigated: its own common shock takes it below the contracted half.
    const short = withSeason({ irrigatedYieldShock: -0.6 }, f => {
      const kk = f.contracts.find(x => x.id === 'k-b-corn');
      delete kk.bushels; kk.shareOfExpected = 0.5;
    });
    const r = runFarm(short);
    const moves = r.sim.journal.journal.filter(e => e.action?.type === 'FARM_GRAIN_MOVE' && (e.action.data ?? e.action).sourceId === 'k-b-corn');
    assert.ok(moves.some(e => (e.action.data ?? e.action).shortBushels > 0));
  });

  test('a share contract for an earlier crop is refused', () => {
    const c = withSeason({}, f => { const k = f.contracts.find(x => x.id === 'k-a-old'); k.shareOfExpected = 0.5; });
    assert.ok(validateFarm(c.farm).some(e => /shareOfExpected sizes this season's crop only/.test(e)));
  });

  test('levers exist only for what the farm has, and the catalog owns their spreads', () => {
    const { ctx } = new FarmMcRunner({ cfgTemplate: cfg() })._prepare();
    const keys = ctx.variables.map(v => v.paramKey);
    assert.ok(keys.includes('farm.season.s2027.nitrogenMultiplier'));
    assert.ok(!keys.includes('farm.season.s2027.limeMultiplier'), 'the demo buys no lime');
    assert.ok(!keys.includes('farm.season.s2027.interestMultiplier'), 'no variable-rate interest');
    for (const v of ctx.variables.filter(x => /Multiplier$/.test(x.paramKey))) {
      assert.strictEqual(v.mean, 1); assert.strictEqual(v.stdDev, 0); assert.ok(!v.harvested);
    }
  });

  test('a sampled category multiplier reaches the products and replays', async () => {
    const m = new FarmMcConfig();
    m.applyOverride('farm.season.s2027.nitrogenMultiplier', { enabled: true, stdDev: 0.2 });
    const { runs } = await new FarmMcRunner({ n: 3, cfgTemplate: cfg(), mcConfig: m }).run();
    assert.strictEqual(new Set(runs.map(r => r.metrics['farm.net.custom'])).size, 3);
    const replay = runFarm(applyParamBagToConfig(cfg(), runs[0].params));
    assert.strictEqual(replay.jobCost.farm.net, runs[0].metrics['farm.net.custom']);
  });
});

describe('calibrated shape (design 134 §13.8, step 2e)', () => {
  const season = (fields) => { const c = cfg(); Object.assign(c.farm.seasons[0], fields); return c; };
  const plan = (r, id) => r.jobCost.plans.find(p => p.planId === id);

  test('blank shape fields take the calibration, and it is a no-op at zero shocks', () => {
    const s = normalizeFarm(cfg().farm).season;
    assert.strictEqual(s.irrigatedYieldBeta, FARM_CALIBRATION.irrigatedYieldBeta);
    assert.deepStrictEqual(s.yieldShockScale, { ...FARM_CALIBRATION.yieldShockScale });
    assert.deepStrictEqual(s.priceYieldBeta, { ...FARM_CALIBRATION.priceYieldBeta });
    assert.deepStrictEqual(s.priceVol, {}, 'the vol is never defaulted into a record');
    for (const p of normalizeFarm(cfg().farm).prices) assert.strictEqual(p.realized, p.price);
  });

  test('the dryland shock: k·Y on dry fields, k·β·Y on irrigated ones', () => {
    const r = runFarm(season({ yieldShock: -0.2 }));
    const { irrigatedYieldBeta: b, yieldShockScale: k } = FARM_CALIBRATION;
    assert.ok(Math.abs(plan(r, 'p-a-home-dry').realizedYield - 50 * (1 - 0.2 * k.SOYBEANS)) < 1e-9);
    assert.ok(Math.abs(plan(r, 'p-a-home-irr').realizedYield - 230 * (1 - 0.2 * b)) < 1e-9);
  });

  test('the irrigated shock moves irrigated fields only', () => {
    const det = runFarm(cfg());
    const r = runFarm(season({ irrigatedYieldShock: -0.1 }));
    assert.ok(Math.abs(plan(r, 'p-a-home-irr').realizedYield - 230 * 0.9) < 1e-9);
    assert.strictEqual(plan(r, 'p-a-home-dry').realizedYield, plan(det, 'p-a-home-dry').realizedYield);
    assert.strictEqual(plan(r, 'p-a-west').realizedYield, plan(det, 'p-a-west').realizedYield);
  });

  test('the price link reads the crop\'s own scaled shock', () => {
    const c = season({ yieldShock: -0.2 });
    const h = normalizeFarm(c.farm).prices.find(p => p.id === 'ps-harvest');
    const { priceYieldBeta: b, yieldShockScale: k } = FARM_CALIBRATION;
    assert.ok(Math.abs(h.realized - h.price * Math.exp(b.SOYBEANS * k.SOYBEANS * 0.2)) < 1e-12);
  });

  test('a sampled crop with no vol of its own gets the calibrated one, and replays with it', async () => {
    const m = new FarmMcConfig();
    for (const p of cfg().farm.prices) m.applyOverride(`farm.price.${p.id}.shock`, { enabled: true });
    const { runs, summary } = await new FarmMcRunner({ n: 3, cfgTemplate: cfg(), mcConfig: m }).run();
    assert.deepStrictEqual(summary.provenance.priceVolFilled, { ...FARM_CALIBRATION.priceVol });
    assert.strictEqual(new Set(runs.map(r => r.metrics['crop.SOYBEANS.revenue'])).size, 3);
    const replay = runFarm(applyParamBagToConfig(withPriceVol(cfg(), summary.provenance.priceVolFilled), runs[2].params));
    assert.strictEqual(replay.jobCost.farm.net, runs[2].metrics['farm.net.custom']);
  });

  test('a batch that samples no price leaves the vol blank', async () => {
    const { summary } = await new FarmMcRunner({ n: 1, cfgTemplate: cfg(), mcConfig: withEnabled(FARM_YIELD) }).run();
    assert.deepStrictEqual(summary.provenance.priceVolFilled, {});
  });

  test('the irrigated levers exist only on a farm with an irrigated field', () => {
    const c = cfg();
    for (const f of c.farm.fields) f.irrigated = false;
    for (const p of c.farm.cropPlans) delete p.irrigationElectricity;
    const { ctx } = new FarmMcRunner({ cfgTemplate: c })._prepare();
    assert.ok(!ctx.variables.some(v => /irrigatedYieldShock$/.test(v.paramKey)));
  });
});
