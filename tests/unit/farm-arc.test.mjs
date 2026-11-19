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
 * Design 134 step 3c (§15.3): ARC-County. The acceptance tests read FSA's published county
 * files and NASS's national prices from docs/, so the formulas cannot drift from the source.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { FarmScenario } from '../../src/scenarios/farm-scenario.js';
import { normalizeFarm, validateFarm, farmAdvisories } from '../../src/finance/farm/farm-records.js';
import {
  arcCountyRate, arcBenchmarkPrice, settleArc, nationalPrice, loanRate, arcTerms, olympicAverage,
} from '../../src/finance/farm/farm-programs.js';
import { runFarm } from '../../src/finance/farm/farm-run.js';

const ROOT = resolve(import.meta.dirname, '../..');
const close = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} ≠ ${b}`);
const CROP = { Corn: 'CORN', Soybeans: 'SOYBEANS' };

function fsaRows(file, year) {
  const lines = readFileSync(resolve(ROOT, 'docs/us-farm-programs', file), 'utf8').trim().split('\n').map(l => l.split(','));
  const h = lines.shift();
  const col = (prefix) => {
    const i = h.findIndex(x => x.startsWith(`${year} ${prefix}`));
    assert.ok(i >= 0, `column "${year} ${prefix}" in ${file}`);
    return i;
  };
  const c = {
    by: col('Bench Mark ('), bp: col('Bench Mark Price'), br: col('Benchmark Revenue'), g: col('Guarantee'),
    mx: col('Maximum'), ay: col('Actual Yield'), np: col('National'), ar: col('Actual Revenue'),
    fr: col('Formula'), pr: col('ARC-CO Payment'),
  };
  return lines.map(r => ({
    county: r[2], crop: CROP[r[4]], practice: r[6],
    ...Object.fromEntries(Object.entries(c).map(([k, i]) => [k, r[i] === '' ? null : Number(r[i])])),
  }));
}

function nassMya() {
  const dir = resolve(ROOT, 'docs/us-farm-markets');
  const file = readdirSync(dir).filter(f => /^nass-qs-corn-soy-ne-us-\d+\.tsv\.gz$/.test(f)).sort().at(-1);
  const lines = gunzipSync(readFileSync(resolve(dir, file))).toString('utf8').split('\n');
  const h = lines.shift().split('\t');
  const at = (n) => h.indexOf(n);
  const [cd, st, ag, yr, fq, rp, vl] = ['commodity_desc', 'statisticcat_desc', 'agg_level_desc', 'year',
    'freq_desc', 'reference_period_desc', 'value'].map(at);
  const out = { CORN: {}, SOYBEANS: {} };
  for (const l of lines) {
    const r = l.split('\t');
    if (r[st] !== 'PRICE RECEIVED' || r[ag] !== 'NATIONAL' || r[fq] !== 'ANNUAL' || r[rp] !== 'MARKETING YEAR') continue;
    if (out[r[cd]]) out[r[cd]][Number(r[yr])] = Number(r[vl].replaceAll(',', ''));
  }
  return out;
}

test('EVT-FARM-10: the statute reproduces every Nebraska row of FSA\'s 2025 ARC-CO file to the cent', () => {
  const rows = fsaRows('FSA-arcco-2025-data-2026-11-02-NE-corn-soy.csv', 2025);
  assert.ok(rows.length > 300, `${rows.length} rows`);
  let paid = 0;
  for (const r of rows) {
    const got = arcCountyRate({ benchmarkYield: r.by, benchmarkPrice: r.bp, actualYield: r.ay,
      nationalPrice: r.np, crop: r.crop, year: 2025 });
    const where = `${r.county} ${r.crop} ${r.practice}`;
    close(got.benchmarkRevenue, r.br, `${where} benchmark revenue`, 1e-9);
    close(got.guarantee, r.g, `${where} guarantee (90%)`, 1e-9);
    close(got.maxRate, r.mx, `${where} maximum rate (12%)`, 1e-9);
    close(got.actualRevenue, r.ar, `${where} actual revenue`, 1e-9);
    close(got.formulaRate, r.fr, `${where} formula rate`, 1e-9);
    close(got.rate, r.pr, `${where} payment rate`, 1e-9);
    if (r.pr > 0) paid++;
  }
  assert.ok(paid > 0 && paid < rows.length, 'some counties pay and some do not');
});

test('EVT-FARM-10: FSA\'s 2026 benchmarks are 90% and 12% of benchmark yield × price', () => {
  for (const r of fsaRows('FSA-arcco-2026-data-2026-01-16-NE-corn-soy.csv', 2026)) {
    const got = arcCountyRate({ benchmarkYield: r.by, benchmarkPrice: r.bp, actualYield: 0, nationalPrice: 0,
      crop: r.crop, year: 2026 });
    close(got.benchmarkRevenue, r.br, `${r.county} ${r.crop} ${r.practice}`, 1e-9);
    close(got.guarantee, r.g, `${r.county} guarantee`, 1e-9);
    close(got.maxRate, r.mx, `${r.county} maximum rate`, 1e-9);
  }
});

test('EVT-FARM-10: the benchmark price is the floored Olympic MYA, as FSA publishes it (NASS prices)', () => {
  const mya = nassMya();
  for (const [file, year] of [['FSA-arcco-2025-data-2026-11-02-NE-corn-soy.csv', 2025],
    ['FSA-arcco-2026-data-2026-01-16-NE-corn-soy.csv', 2026]]) {
    const rows = fsaRows(file, year);
    for (const crop of ['CORN', 'SOYBEANS']) {
      const published = new Set(rows.filter(r => r.crop === crop).map(r => r.bp));
      assert.equal(published.size, 1, `one national benchmark price for ${crop} ${year}`);
      const { benchmarkPrice } = arcBenchmarkPrice(mya[crop], crop, year);
      assert.equal(benchmarkPrice, [...published][0], `${crop} ${year}`);
    }
  }
  assert.equal(olympicAverage([5, 1, 3, 9, 4]), 4);
  assert.throws(() => olympicAverage([1, 2]));
});

test('EVT-FARM-10: ARC terms and loan rates follow P.L. 119-21', () => {
  assert.deepEqual(arcTerms(2024), { guarantee: 0.86, cap: 0.10, erpFactor: 0.85 });
  assert.deepEqual(arcTerms(2025), { guarantee: 0.90, cap: 0.12, erpFactor: 0.88 });
  assert.equal(loanRate('CORN', 2025), 2.20);
  assert.equal(loanRate('CORN', 2026), 2.42);
  assert.equal(loanRate('SOYBEANS', 2031), 6.82);
  assert.equal(loanRate('CORN', 2032), null);
});

/** A one-operator farm in a county with split practices; corn base 100 ac at 30% irrigated. */
function arcFarm(over = {}) {
  return {
    seasons: [{ id: 's2027', cropYear: 2027, nationalPrice: { CORN: 4.10 } }],
    operators: [{ id: 'o1', name: 'Op' }],
    fields: [
      { id: 'f1', operatorId: 'o1', tenure: 'OWN', plantedAcres: 60, irrigated: true, fsaFarm: '123' },
      { id: 'f2', operatorId: 'o1', tenure: 'OWN', plantedAcres: 40, fsaFarm: '123' },
    ],
    cropPlans: [
      { id: 'p1', fieldId: 'f1', crop: 'CORN', expectedYield: 230 },
      { id: 'p2', fieldId: 'f2', crop: 'CORN', expectedYield: 150 },
    ],
    prices: [{ id: 'pc', crop: 'CORN', date: '2027-10-01', price: 4.0 }],
    arcCounties: [
      { id: 'c-i', county: 'X', crop: 'CORN', practice: 'IRRIGATED',    benchmarkYield: 220, benchmarkPrice: 5.03 },
      { id: 'c-d', county: 'X', crop: 'CORN', practice: 'NONIRRIGATED', benchmarkYield: 130, benchmarkPrice: 5.03 },
    ],
    arcBase: [{ id: 'b1', operatorId: 'o1', fsaFarm: '123', crop: 'CORN', baseAcres: 100, county: 'X', irrigatedPct: 0.3 }],
    ...over,
  };
}

test('EVT-FARM-10: a farm\'s rate weights the county\'s practices by its irrigated percentage', () => {
  const [a] = settleArc(normalizeFarm(arcFarm()));
  // Deterministic: county yields = benchmarks, MYA = $4.10, above the loan rate.
  const irr = arcCountyRate({ benchmarkYield: 220, benchmarkPrice: 5.03, actualYield: 220, nationalPrice: 4.10, crop: 'CORN', year: 2027 });
  const dry = arcCountyRate({ benchmarkYield: 130, benchmarkPrice: 5.03, actualYield: 130, nationalPrice: 4.10, crop: 'CORN', year: 2027 });
  const G = 0.3 * irr.guarantee + 0.7 * dry.guarantee;
  const A = 0.3 * irr.actualRevenue + 0.7 * dry.actualRevenue;
  const B = 0.3 * irr.benchmarkRevenue + 0.7 * dry.benchmarkRevenue;
  close(a.rate, Math.min(G - A, 0.12 * B), 'weighted rate');
  close(a.payment, a.rate * 85, 'rate × 85% of 100 base acres');
  assert.ok(a.payment > 0);
  close(a.nationalPrice, 4.10, 'deterministic MYA');
});

test('EVT-FARM-10: the county yield follows the season\'s common shocks only, and a short county crop pays more', () => {
  const calm = settleArc(normalizeFarm(arcFarm()))[0];
  const fieldOnly = arcFarm();
  fieldOnly.cropPlans[1].yieldShock = -0.5;
  assert.equal(settleArc(normalizeFarm(fieldOnly))[0].payment, calm.payment, 'a field\'s own shock is not the county\'s');
  const drought = arcFarm();
  drought.seasons[0].yieldShock = -0.3;
  const d = settleArc(normalizeFarm(drought))[0];
  close(d.countyYield.NONIRRIGATED, 130 * 0.7, 'dryland county yield');
  assert.ok(d.payment > calm.payment);
  const capped = arcFarm();
  capped.seasons[0].yieldShock = -0.9;
  const c = settleArc(normalizeFarm(capped))[0];
  close(c.rate, 0.12 * c.benchmarkRevenue, 'capped at 12% of benchmark', 1e-6);
});

test('EVT-FARM-10: a price path moves the national price over the marketing year', () => {
  const raw = arcFarm();
  raw.seasons[0].priceVol = { CORN: 0.2 };
  raw.prices[0].shock = -1;
  const farm = normalizeFarm(raw);
  const pc = farm.prices[0];
  close(nationalPrice(farm, 'CORN'), 4.10 * pc.realized / pc.price, 'one row in force all year');
  assert.ok(settleArc(farm)[0].payment > settleArc(normalizeFarm(arcFarm()))[0].payment, 'a lower price pays more');
});

test('EVT-FARM-10: ARC posts on 1 October of the next year, line 4a, split over the FSA farm\'s plans', () => {
  const r = runFarm(FarmScenario.buildDefaultConfig({ farm: arcFarm() }));
  const posts = r.ledger.filter(p => p.category === 'PROGRAM_PAYMENT');
  assert.deepEqual(posts.map(p => [p.jobId, p.date, p.line, p.cropYear]),
    [['p1', '2028-10-01', '4a', 2027], ['p2', '2028-10-01', '4a', 2027]]);
  const [a] = settleArc(normalizeFarm(arcFarm()));
  close(posts[0].amount, a.payment * 0.6, 'by planted acres');
  close(posts[1].amount, a.payment * 0.4, 'by planted acres');
  close(r.jobCost.farm.revenue.other, a.payment, 'non-grain revenue in the crop-year view');
  assert.equal(r.cash.find(c => c.year === 2027)?.income['4a'], undefined, 'nothing in the crop year\'s cash');
  close(r.cash.find(c => c.year === 2028).income['4a'], a.payment, 'paid the next calendar year');
});

test('EVT-FARM-10: ARC records are validated', () => {
  const bad = (mut) => { const f = arcFarm(); mut(f); return validateFarm(f).join('\n'); };
  assert.deepEqual(validateFarm(arcFarm()), []);
  assert.match(bad(f => { f.arcCounties.pop(); }), /ALL, or as both IRRIGATED and NONIRRIGATED/);
  assert.match(bad(f => { f.seasons[0].nationalPrice = {}; }), /no expected national price/);
  assert.match(bad(f => { f.arcBase[0].irrigatedPct = 1.5; }), /between 0 and 1/);
  assert.match(bad(f => { f.arcCounties[0].practice = 'WET'; }), /IRRIGATED, NONIRRIGATED or ALL/);
  assert.match(bad(f => { f.arcBase.push({ ...f.arcBase[0], id: 'b2' }); }), /a second CORN enrollment/);
  assert.match(bad(f => { f.seasons[0].cropYear = 2035; }), /2019–2031/);
});

test('EVT-FARM-10: advisories: a defaulted irrigated percentage, 2025, and the payment limit', () => {
  const noPct = arcFarm();
  delete noPct.arcBase[0].irrigatedPct;
  const f = normalizeFarm(noPct);
  close(f.arcBase[0].irrigatedPct, 0.6, 'this season\'s irrigated share of the FSA farm');
  assert.ok(farmAdvisories(f).some(a => a.kind === 'ARC_IRRIGATED_PCT_DEFAULTED'));
  const y25 = arcFarm();
  y25.seasons[0].cropYear = 2025;
  y25.prices[0].date = '2025-10-01';
  assert.ok(farmAdvisories(normalizeFarm(y25)).some(a => a.kind === 'ARC_2025_HIGHER_OF'));
  const big = arcFarm();
  big.arcBase[0].baseAcres = 10_000;
  assert.ok(farmAdvisories(normalizeFarm(big)).some(a => a.kind === 'ARC_OVER_LIMIT'));
  assert.ok(!farmAdvisories(normalizeFarm(arcFarm())).some(a => a.kind.startsWith('ARC')));
});
