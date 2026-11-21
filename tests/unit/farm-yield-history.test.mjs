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
 * farm-yield-history.test.mjs — design 134 §17.13, the historical yield years.
 *
 * Pinned: the generated table is exactly what the NASS extract gives; a county-year's two
 * shocks put back the county's own dryland and irrigated deviations under the model's β; a
 * farm draws from its own county when it names one (`farm.county` or an ARC row); a Monte Carlo path's yield is a real
 * county-year (so no path is worse than the worst on record) and replays from its params.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  parseNassCountyCornYields, yieldHistoryData, renderYieldHistoryModule, farmCounty, yieldYearPool, expandYieldYears,
  OWN_COUNTY_MIN_YEARS, POOL_MIN_YEARS,
} from '../../src/finance/farm/farm-yield-history.js';
import { FARM_YIELD_HISTORY } from '../../src/finance/farm/farm-yield-history-data.js';
import { FARM_CALIBRATION, trendDeviations } from '../../src/finance/farm/farm-calibration.js';
import { EmpiricalDistribution, createDistribution, DISTRIBUTION_TYPES } from '../../src/simulation-framework/distributions.js';
import { FarmScenario } from '../../src/scenarios/farm-scenario.js';
import { FarmMcRunner, FarmMcConfig, applyFarmPath } from '../../src/finance/farm/farm-mc.js';
import { runFarm } from '../../src/finance/farm/farm-run.js';
import { normalizeFarm, validateFarm, farmAdvisories } from '../../src/finance/farm/farm-records.js';

const ROOT = resolve(import.meta.dirname, '../..');
const YEAR = 'farm.season.s2027.yieldYear';
const quiet = async (f) => {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { return await f(); } finally { console.log = log; console.warn = warn; }
};

describe('the yield history table', () => {
  const file = resolve(ROOT, 'docs/us-farm-markets',
    readdirSync(resolve(ROOT, 'docs/us-farm-markets')).filter(f => /^nass-qs-corn-soy-ne-us-\d+\.tsv\.gz$/.test(f)).sort().at(-1));
  const yields = parseNassCountyCornYields(gunzipSync(readFileSync(file)).toString('utf8'), { from: FARM_CALIBRATION.from });

  test('the generated file is byte for byte what the script would write', () => {
    const data = yieldHistoryData(yields, { source: FARM_YIELD_HISTORY.source, from: FARM_YIELD_HISTORY.from, beta: FARM_CALIBRATION.irrigatedYieldBeta });
    const onDisk = readFileSync(resolve(ROOT, 'src/finance/farm/farm-yield-history-data.js'), 'utf8');
    assert.equal(onDisk, renderYieldHistoryModule(data), 'stale: run npm run farm:yield-history');
  });

  test('a county-year\'s shocks put back its dryland and irrigated deviations under the model\'s β', () => {
    assert.equal(FARM_YIELD_HISTORY.beta, FARM_CALIBRATION.irrigatedYieldBeta);
    const name = 'DUNDY';
    const dDry = trendDeviations(yields.get(name).dry);
    const dIrr = trendDeviations(yields.get(name).irr);
    for (const [year, Y, I] of FARM_YIELD_HISTORY.counties[name]) {
      assert.ok(Math.abs(Y - dDry.get(year)) < 1e-4, `${year} dryland`);
      assert.ok(Math.abs(FARM_YIELD_HISTORY.beta * Y + I - dIrr.get(year)) < 2e-4, `${year} irrigated`);
    }
  });

  test('joint years only, to 2018, from counties with 15 of them; no deviation below −100%', () => {
    const rows = Object.values(FARM_YIELD_HISTORY.counties).flat();
    assert.ok(Object.keys(FARM_YIELD_HISTORY.counties).length > 50);
    assert.ok(Object.values(FARM_YIELD_HISTORY.counties).every(c => c.length >= OWN_COUNTY_MIN_YEARS));
    assert.ok(rows.every(([y]) => y >= 1995 && y <= 2018));
    assert.ok(rows.every(([, Y]) => Y >= -1.0001), 'a yield cannot fall below zero');
  });
});

describe('a farm\'s pool of years', () => {
  test('a farm naming a county NASS has draws that county; otherwise every county', () => {
    const cfg = FarmScenario.buildDefaultConfig();
    assert.equal(farmCounty(cfg.farm), null, 'the demo county is "Demo"');
    const all = yieldYearPool(cfg.farm);
    assert.equal(all.rows.length, Object.values(FARM_YIELD_HISTORY.counties).filter(c => c.length >= POOL_MIN_YEARS).flat().length);
    for (const r of cfg.farm.arcCounties) r.county = 'Dundy';
    const own = yieldYearPool(cfg.farm);
    assert.equal(own.county, 'DUNDY');
    assert.equal(own.rows.length, FARM_YIELD_HISTORY.counties.DUNDY.length);
    assert.ok(own.rows.every(r => r.county === 'DUNDY'));
  });

  test('a county short of the pool\'s minimum is its own farm\'s pool but not every county\'s (Wayne: split ends 2013)', () => {
    const wayne = FARM_YIELD_HISTORY.counties.WAYNE;
    assert.equal(wayne.length, 19);
    assert.ok(wayne.length >= OWN_COUNTY_MIN_YEARS && wayne.length < POOL_MIN_YEARS);
    assert.deepEqual(wayne.find(r => r[0] === 2012).slice(0, 2), [2012, -0.7369]);
    const own = yieldYearPool({ county: 'Wayne', fields: [] });
    assert.equal(own.county, 'WAYNE');
    assert.equal(own.rows.length, 19);
    const all = yieldYearPool({ fields: [] });
    assert.ok(all.rows.every(r => r.county !== 'WAYNE'));
    assert.equal(all.rows.length, Object.values(FARM_YIELD_HISTORY.counties).filter(c => c.length >= POOL_MIN_YEARS).flat().length);
  });

  test('farm.county names the county, however it is written, ahead of the ARC rows', () => {
    for (const n of ['Wayne', 'wayne', 'Wayne County', 'Wayne County NE', 'Wayne, Nebraska', ' WAYNE ']) {
      assert.equal(farmCounty({ county: n }), 'WAYNE', n);
    }
    assert.equal(farmCounty({ county: 'Wayne', arcCounties: [{ county: 'Dundy' }] }), 'WAYNE');
    assert.equal(farmCounty({ county: 'Atlantis', arcCounties: [{ county: 'Dundy' }] }), 'DUNDY');
    assert.equal(farmCounty({ county: 'Atlantis' }), null);
  });

  test('the county is a farm record: normalized, validated, and advised on when NASS lacks it', () => {
    const cfg = FarmScenario.buildDefaultConfig();
    assert.equal(normalizeFarm(cfg.farm).county, null);
    assert.equal(normalizeFarm({ ...cfg.farm, county: '  Wayne ' }).county, 'Wayne');
    assert.deepEqual(validateFarm({ ...cfg.farm, county: 'Wayne' }), []);
    assert.ok(validateFarm({ ...cfg.farm, county: 7 }).some(e => /farm\.county/.test(e)));
    const kinds = (c) => farmAdvisories(normalizeFarm({ ...cfg.farm, county: c })).map(a => a.kind);
    assert.ok(!kinds('Wayne').includes('COUNTY_NO_YIELD_HISTORY'));
    assert.ok(kinds('Atlantis').includes('COUNTY_NO_YIELD_HISTORY'));
    const { ctx } = new FarmMcRunner({ cfgTemplate: FarmScenario.buildDefaultConfig({ farm: { ...cfg.farm, county: 'Wayne' } }) })._prepare();
    const row = ctx.variables.find(v => v.paramKey === YEAR);
    assert.equal(row.label, 'Historical yield year (Wayne County)');
    assert.equal(row.values.length, 19);
  });

  test('no irrigated field, no irrigated shock', () => {
    const cfg = FarmScenario.buildDefaultConfig();
    assert.ok(yieldYearPool(cfg.farm).rows.every(r => r.irrigatedYieldShock != null));
    for (const f of cfg.farm.fields) f.irrigated = false;
    assert.ok(yieldYearPool(cfg.farm).rows.every(r => r.irrigatedYieldShock == null));
  });

  test('a drawn year expands into the season\'s two shocks and keeps a label', () => {
    const p = expandYieldYears({ [YEAR]: { county: 'DUNDY', year: 2002, yieldShock: -0.86, irrigatedYieldShock: 0.01 }, other: 1 });
    assert.deepEqual(p, { [YEAR]: '2002 · DUNDY', 'farm.season.s2027.yieldShock': -0.86, 'farm.season.s2027.irrigatedYieldShock': 0.01, other: 1 });
    const dry = expandYieldYears({ [YEAR]: { county: 'X', year: 2000, yieldShock: 0.1, irrigatedYieldShock: null } });
    assert.ok(!('farm.season.s2027.irrigatedYieldShock' in dry));
    assert.deepEqual(expandYieldYears({ [YEAR]: '2002 · DUNDY' }), { [YEAR]: '2002 · DUNDY' }, 'an expanded bag is left alone');
  });

  test('the empirical distribution draws each value, one uniform per draw', () => {
    const d = createDistribution({ type: DISTRIBUTION_TYPES.EMPIRICAL, values: ['a', 'b', 'c'] });
    assert.ok(d instanceof EmpiricalDistribution);
    assert.equal(d.sample(() => 0), 'a');
    assert.equal(d.sample(() => 0.5), 'b');
    assert.equal(d.sample(() => 0.999999), 'c');
    assert.throws(() => new EmpiricalDistribution({ values: [] }), /non-empty/);
  });
});

describe('the historical year in a farm batch', () => {
  test('the catalog offers it off, ahead of the shocks it replaces', () => {
    const { ctx } = new FarmMcRunner({ cfgTemplate: FarmScenario.buildDefaultConfig() })._prepare();
    const i = ctx.variables.findIndex(v => v.paramKey === YEAR);
    assert.ok(i >= 0 && ctx.variables[i].enabled === false && ctx.variables[i].bootstrap);
    assert.deepEqual(ctx.variables[i].replaces, ['farm.season.s2027.yieldShock', 'farm.season.s2027.irrigatedYieldShock']);
    assert.ok(ctx.variables.findIndex(v => v.paramKey === 'farm.season.s2027.yieldShock') > i);
  });

  test('every path\'s yield is a real county-year, none below the worst on record, and it replays', async () => {
    const mc = new FarmMcConfig();
    mc.applyOverride(YEAR, { enabled: true, centerDirty: false });
    const { runs, summary } = await quiet(() => new FarmMcRunner({ n: 40, cfgTemplate: FarmScenario.buildDefaultConfig(), mcConfig: mc, parallel: false }).run());
    assert.equal(summary.erroredRuns.length, 0);
    const worst = Math.min(...Object.values(FARM_YIELD_HISTORY.counties).flat().map(r => r[1]));
    for (const r of runs) {
      const [year, county] = r.params[YEAR].split(' · ');
      const row = FARM_YIELD_HISTORY.counties[county].find(x => x[0] === Number(year));
      assert.ok(row, r.params[YEAR]);
      assert.equal(r.params['farm.season.s2027.yieldShock'], row[1]);
      assert.equal(r.params['farm.season.s2027.irrigatedYieldShock'], row[2]);
      assert.ok(r.params['farm.season.s2027.yieldShock'] >= worst);
    }
    assert.ok(new Set(runs.map(r => r.params[YEAR])).size > 30, 'paths draw different years');
    const live = FarmScenario.buildDefaultConfig();
    applyFarmPath(live, runs[7], summary.provenance.priceVolFilled);
    const replay = await quiet(() => runFarm(live));
    assert.strictEqual(replay.jobCost.farm.net, runs[7].metrics['farm.net.custom']);
  });
});
