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
 * Design 134 phase 3 (§15): crop insurance settlement. The worked example is the Coarse Grains
 * Crop Provisions' own (§12(b), docs/us-farm-programs/CFR-7-457.113-…-2026-01-01.txt).
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { FarmScenario } from '../../src/scenarios/farm-scenario.js';
import { normalizeFarm, validateFarm, farmAdvisories } from '../../src/finance/farm/farm-records.js';
import { settleInsurance, harvestPrice } from '../../src/finance/farm/farm-programs.js';
import { runFarm } from '../../src/finance/farm/farm-run.js';

const close = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} ≠ ${b}`);

/**
 * The §12(b) example: 50 acres of corn, a 115 bu production guarantee (an approved yield of
 * 143.75 at 80% coverage), projected price $4.75, harvest price $4.68, 5,000 bushels to count
 * (a 125 bu plan 20% short).
 */
function exampleFarm({ plan = 'RP', harvest = 4.68, fields } = {}) {
  return {
    seasons: [{ id: 's2027', cropYear: 2027, projectedPrice: { CORN: 4.75 } }],
    operators: [{ id: 'o1', name: 'Op' }],
    fields: fields ?? [{ id: 'f1', operatorId: 'o1', tenure: 'OWN', plantedAcres: 50 }],
    cropPlans: (fields ?? [{ id: 'f1' }]).map((f, i) => ({
      id: `p${i + 1}`, fieldId: f.id, crop: 'CORN', expectedYield: 125, aphYield: 143.75,
      yieldShock: f.yieldShock ?? -0.2,
    })),
    prices: [{ id: 'pc', crop: 'CORN', date: '2027-10-01', price: 4.20 }],
    insurance: [{ id: 'ins', operatorId: 'o1', crop: 'CORN', plan, coverageLevel: 0.8 }],
    _harvest: harvest,
  };
}

/** Normalize, then set the realized cash path so the harvest price comes out at `_harvest`. */
function settled(raw) {
  const farm = normalizeFarm(raw);
  for (const p of farm.prices) p.realized = p.price * (raw._harvest / 4.75);
  return { farm, units: settleInsurance(farm) };
}

test('EVT-FARM-9: the Coarse Grains §12(b) example settles to the cent, RP and YP', () => {
  const rp = settled(exampleFarm({ plan: 'RP' })).units;
  assert.equal(rp.length, 1);
  close(rp[0].harvestPrice, 4.68, 'harvest price');
  close(rp[0].guarantee, 27_312.50, 'RP guarantee: 50 × 115 × max($4.75, $4.68)');
  close(rp[0].valueToCount, 23_400.00, 'RP value: 5,000 bu × $4.68');
  close(rp[0].indemnity, 3_912.50, 'RP indemnity');
  const yp = settled(exampleFarm({ plan: 'YP' })).units;
  close(yp[0].valueToCount, 23_750.00, 'YP value: 5,000 bu × $4.75');
  close(yp[0].indemnity, 3_562.50, 'YP indemnity');
});

test('EVT-FARM-9: a harvest price above projected raises the RP guarantee, but not under the exclusion', () => {
  const up = 5.50;
  const rp = settled(exampleFarm({ plan: 'RP', harvest: up })).units[0];
  close(rp.guarantee, 50 * 115 * up, 'RP guarantee at the harvest price');
  close(rp.indemnity, 50 * 115 * up - 5_000 * up, 'RP pays the yield loss at the harvest price');
  const hpe = settled(exampleFarm({ plan: 'RP_HPE', harvest: up })).units[0];
  close(hpe.guarantee, 50 * 115 * 4.75, 'HPE guarantee stays at the projected price');
  close(hpe.indemnity, Math.max(0, 50 * 115 * 4.75 - 5_000 * up), 'HPE indemnity');
  assert.equal(hpe.indemnity, 0, 'the dearer crop covers the HPE guarantee');
});

test('EVT-FARM-9: an enterprise unit offsets fields; field units do not; the indemnity follows the short field', () => {
  const fields = [
    { id: 'short', operatorId: 'o1', tenure: 'OWN', plantedAcres: 50, yieldShock: -0.4 },
    { id: 'long',  operatorId: 'o1', tenure: 'OWN', plantedAcres: 50, yieldShock: 0.3 },
  ];
  const ent = settled(exampleFarm({ fields })).units;
  assert.equal(ent.length, 1, 'one enterprise unit');
  // short: 50 × 75 bu = 3,750 bu; long: 50 × 162.5 = 8,125 bu; guarantee 2 × 5,750 bu.
  close(ent[0].indemnity, Math.max(0, 2 * 50 * 115 * 4.75 - (3_750 + 8_125) * 4.68), 'enterprise');
  assert.equal(ent[0].indemnity, 0, 'the long field covers the short one');

  const raw = exampleFarm({ fields });
  raw.insurance[0].unit = 'FIELD';
  const byField = settled(raw).units;
  assert.equal(byField.length, 2);
  const s = byField.find(u => u.unit === 'field:short');
  close(s.indemnity, 50 * 115 * 4.75 - 3_750 * 4.68, 'the short field is paid alone');
  assert.equal(byField.find(u => u.unit === 'field:long').indemnity, 0);
  assert.deepEqual(s.byPlan.map(x => x.planId), ['p1']);
});

test('EVT-FARM-9: ENTERPRISE_BY_PRACTICE keeps irrigated and dry apart', () => {
  const fields = [
    { id: 'irr', operatorId: 'o1', tenure: 'OWN', plantedAcres: 50, irrigated: true, yieldShock: 0.1 },
    { id: 'dry', operatorId: 'o1', tenure: 'OWN', plantedAcres: 50, yieldShock: -0.4 },
  ];
  const raw = exampleFarm({ fields });
  raw.insurance[0].unit = 'ENTERPRISE_BY_PRACTICE';
  const units = settled(raw).units;
  assert.deepEqual(units.map(u => u.unit).sort(), ['dry', 'irrigated']);
  assert.ok(units.find(u => u.unit === 'dry').indemnity > 0);
});

test('EVT-FARM-9: the indemnity posts as Schedule F line 6a revenue on its payment date', () => {
  const raw = exampleFarm();
  delete raw._harvest;
  const r = runFarm(FarmScenario.buildDefaultConfig({ farm: raw }));
  const posts = r.ledger.filter(p => p.category === 'CROP_INSURANCE_PROCEEDS');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].line, '6a');
  assert.equal(posts[0].kind, 'REVENUE');
  assert.equal(posts[0].date, '2027-12-15');
  // A deterministic price path: the harvest price is the projected price.
  close(harvestPrice(normalizeFarm(raw), 'CORN'), 4.75, 'harvest = projected');
  close(posts[0].amount, 50 * 115 * 4.75 - 5_000 * 4.75, 'indemnity at the projected price');
  close(r.jobCost.plans[0].revenue.other, posts[0].amount, 'non-grain revenue on the plan');
  const cash = r.cash.find(c => c.year === 2027 && c.operatorId === 'o1');
  close(cash.income['6a'], posts[0].amount, 'cash report line 6a');
});

test('EVT-FARM-9: a price path moves the harvest price by its realized ÷ expected ratio', () => {
  const raw = exampleFarm();
  delete raw._harvest;
  raw.seasons[0].priceVol = { CORN: 0.2 };
  raw.prices[0].shock = 1;
  const farm = normalizeFarm(raw);
  const pc = farm.prices[0];
  close(harvestPrice(farm, 'CORN'), 4.75 * pc.realized / pc.price, 'moved with the path');
  assert.ok(harvestPrice(farm, 'CORN') > 4.75);
});

test('EVT-FARM-9: insurance records are validated', () => {
  const bad = (mut) => { const r = exampleFarm(); delete r._harvest; mut(r); return validateFarm(r).join('\n'); };
  assert.match(bad(r => { r.insurance[0].coverageLevel = 0.9; }), /between 0.5 and 0.85/);
  assert.match(bad(r => { r.insurance[0].plan = 'CAT'; }), /RP, RP_HPE or YP/);
  assert.match(bad(r => { r.insurance[0].unit = 'BASIC'; }), /ENTERPRISE/);
  assert.match(bad(r => { r.seasons[0].projectedPrice = {}; }), /no projected price/);
  assert.match(bad(r => { r.insurance.push({ ...r.insurance[0], id: 'ins2' }); }), /a second policy/);
  assert.match(bad(r => { r.insurance[0].crop = 'ALFALFA'; }), /not under the Coarse Grains/);
  const ok = exampleFarm(); delete ok._harvest;
  assert.deepEqual(validateFarm(ok), []);
});

test('EVT-FARM-9: an insured plan without an approved yield is an advisory', () => {
  const raw = exampleFarm(); delete raw._harvest;
  delete raw.cropPlans[0].aphYield;
  raw.prescriptions = [];
  const kinds = farmAdvisories(normalizeFarm(raw)).map(a => a.kind);
  assert.ok(kinds.includes('APH_DEFAULTED'));
  raw.insurance = [];
  assert.ok(!farmAdvisories(normalizeFarm(raw)).map(a => a.kind).includes('APH_DEFAULTED'), 'uninsured: no advisory');
});

test('EVT-FARM-9: the demo farm is insured and a planned season pays nothing; a drought pays', () => {
  const plain = runFarm(FarmScenario.buildDefaultConfig());
  assert.equal(plain.ledger.filter(p => p.category === 'CROP_INSURANCE_PROCEEDS').length, 0);
  assert.deepEqual(plain.jobCost.advisories, []);
  const cfg = FarmScenario.buildDefaultConfig();
  cfg.farm.seasons[0].yieldShock = -0.5;
  cfg.farm.seasons[0].irrigatedYieldShock = -0.3;
  const dry = runFarm(cfg);
  const paid = dry.ledger.filter(p => p.category === 'CROP_INSURANCE_PROCEEDS').reduce((s, p) => s + p.amount, 0);
  assert.ok(paid > 0, 'a drought claims');
});

// ─── step 3d: §451(f) and the Schedule F lines (design 134 §15.4) ────────────────────

/** The §12(b) farm with its corn sold in December and paid in January: the deferral habit. */
function deferringFarm({ elect = true, paidNextYear = true } = {}) {
  const raw = exampleFarm();
  delete raw._harvest;
  raw.operators[0].defer451f = elect;
  raw.sales = [{ id: 's1', operatorId: 'o1', crop: 'CORN', share: 1, saleDate: '2027-12-20',
    paymentDate: paidNextYear ? '2028-01-10' : '2027-12-28' }];
  return raw;
}

test('EVT-FARM-11: §451(f) moves an electing operator\'s proceeds to next year\'s line 6d', () => {
  const r = runFarm(FarmScenario.buildDefaultConfig({ farm: deferringFarm() }));
  const indemnity = 50 * 115 * 4.75 - 5_000 * 4.75;
  const y = r.cash.find(c => c.year === 2027);
  const next = r.cash.find(c => c.year === 2028);
  close(y.income['6a'], indemnity, '6a: received in 2027');
  close(y.income['6b'], 0, '6b: none taxable in 2027');
  close(next.income['6d'], indemnity, '6d: included in 2028');
  assert.equal(y.section451f.elected, true);
  assert.match(y.section451f.reason, /line 6d/);
  close(y.grossIncome, 0, 'line 9 leaves out 6a');
  close(next.grossIncome, indemnity + (next.income['2'] ?? 0), 'line 9 adds 6d');
});

test('EVT-FARM-11: no deferral without the normal practice, or without the election', () => {
  const noHabit = runFarm(FarmScenario.buildDefaultConfig({ farm: deferringFarm({ paidNextYear: false }) }));
  const y = noHabit.cash.find(c => c.year === 2027);
  close(y.income['6b'], y.income['6a'], 'all taxable when received');
  assert.equal(y.section451f.deferred, 0);
  assert.match(y.section451f.reason, /not the normal practice/);
  const notElected = runFarm(FarmScenario.buildDefaultConfig({ farm: deferringFarm({ elect: false }) }));
  const n = notElected.cash.find(c => c.year === 2027);
  close(n.income['6b'], n.income['6a'], 'not elected: taxable in 2027');
  assert.equal(notElected.cash.find(c => c.year === 2028)?.income['6d'], undefined);
  close(n.grossIncome, n.income['6b'], 'line 9 counts 6b, not 6a as well');
});

test('EVT-FARM-11: program payments carry a taxable 4b, and line 9 counts them once', () => {
  const r = runFarm(FarmScenario.buildDefaultConfig());
  for (const row of r.cash) {
    if (row.income['4a'] == null) continue;
    assert.equal(row.income['4b'], row.income['4a']);
    const taxable = Object.entries(row.income).filter(([l]) => !['4a', '6a'].includes(l)).reduce((s, [, v]) => s + v, 0);
    close(row.grossIncome, taxable, `${row.operatorId} ${row.year} gross income`);
  }
});
