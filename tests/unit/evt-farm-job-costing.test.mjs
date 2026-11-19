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
 * Design 134 phase 1 — deterministic farm job costing.
 *
 * A hand-built farm small enough that every expected number below is worked from the records,
 * not read back from a run: one operator, an owned irrigated field and a rented dry one, both
 * corn, one forward contract paid in January, one planned sale out of storage.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { FarmScenario }   from '../../src/scenarios/farm-scenario.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { validateFarm, normalizeFarm, priceOn, farmAdvisories } from '../../src/finance/farm/farm-records.js';
import { runFarm }        from '../../src/finance/farm/farm-run.js';
import { categoryLine, SCHEDULE_F_LINES, SCHEDULE_F_LINE_ORDER } from '../../src/finance/farm/schedule-f.js';

const MS_PER_MONTH = (365.25 / 12) * 86_400_000;
const months = (from, to) => (Date.parse(to) - Date.parse(from)) / MS_PER_MONTH;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`);

function tinyFarm(over = {}) {
  return {
    seasons: [{ id: 's2027', cropYear: 2027 }],
    operators: [{ id: 'o1', name: 'Op One' }],
    fields: [
      { id: 'f-own', operatorId: 'o1', tenure: 'OWN', plantedAcres: 100, irrigated: true, propertyTax: 2_000 },
      { id: 'f-rent', operatorId: 'o1', tenure: 'CASH_RENT', rentedAcres: 50, plantedAcres: 40, rentPerAcre: 200 },
    ],
    products: [
      { id: 'seed', name: 'Seed', category: 'SEED', unit: 'unit', unitPrice: 100, discountPct: 0.1 },
      { id: 'urea', name: 'Urea', category: 'NITROGEN', unit: 'lb', unitPrice: 0.5 },
    ],
    operations: [{ id: 'comb', name: 'Combine', customRatePerAcre: 30 }],
    cropPlans: [
      { id: 'pl-own', fieldId: 'f-own', crop: 'CORN', expectedYield: 200,
        insurancePremiumPerAcre: 10, irrigationElectricity: 1_000 },
      { id: 'pl-rent', fieldId: 'f-rent', crop: 'CORN', expectedYield: 150 },
    ],
    prescriptions: [
      { id: 'rx1', planId: 'pl-own', productId: 'seed', ratePerAcre: 0.4 },
      { id: 'rx2', planId: 'pl-own', productId: 'urea', ratePerAcre: 150 },
      { id: 'rx3', planId: 'pl-own', operationId: 'comb' },
      { id: 'rx4', planId: 'pl-rent', productId: 'seed', ratePerAcre: 0.4, share: 0.5 },
      { id: 'rx5', planId: 'pl-rent', operationId: 'comb' },
    ],
    machinery: [{ id: 'm1', operatorId: 'o1', amount: 7_000 }],
    overhead: [
      { id: 'oh-int', operatorId: 'o1', category: 'INTEREST_MORTGAGE', amount: 3_000, basis: 'OWNED_ACRES' },
      { id: 'oh-ins', operatorId: 'o1', category: 'INSURANCE', amount: 1_400, basis: 'ACRES' },
    ],
    prices: [
      { id: 'p1', crop: 'CORN', date: '2027-10-01', price: 4.0 },
      { id: 'p2', crop: 'CORN', date: '2028-02-01', price: 5.0 },
    ],
    contracts: [
      { id: 'k1', operatorId: 'o1', crop: 'CORN', bushels: 10_000, price: 4.5,
        deliveryDate: '2027-10-25', paymentDate: '2028-01-05' },
    ],
    storage: [{ id: 'st', operatorId: 'o1', crop: 'CORN', costPerBuMonth: 0.05 }],
    sales: [{ id: 's1', operatorId: 'o1', crop: 'CORN', share: 1, saleDate: '2028-02-15' }],
    carryOut: [{ id: 'co', operatorId: 'o1', category: 'SEED', amount: 20_000 }],
    ...over,
  };
}

const run = (farm, opts) => runFarm(FarmScenario.buildDefaultConfig({ farm }), opts);
const posts = (ledger, pred) => ledger.filter(pred);

// ─── the spike: a scenario with no household ─────────────────────────────────────

test('EVT-FARM-1: a FarmScenario with no persons or accounts loads, compiles and runs', () => {
  const r = run(tinyFarm());
  assert.equal(r.cfg.persons.length, 0);
  assert.equal(r.cfg.accounts.length, 0);
  assert.ok(r.sim.state.farm, 'state.farm is seeded');
  assert.deepEqual(Object.keys(r.sim.state.farm.receivables), [], 'every receivable is paid by the end');
  assert.ok(r.ledger.length > 0);
  assert.equal(r.cfg.simStart, '2026-01-01', 'the window opens the year before (the prepay)');
  assert.equal(r.cfg.simEnd, '2029-01-01', 'and closes after the deferred sales');
});

test('EVT-FARM-1: the journal carries every ledger field the reports read', () => {
  const { ledger } = run(tinyFarm());
  for (const p of ledger) {
    for (const k of ['operatorId', 'jobId', 'cropYear', 'category', 'kind', 'amount']) {
      assert.ok(p[k] != null, `posting ${p.sourceId} lost ${k}`);
    }
  }
});

// ─── validation ──────────────────────────────────────────────────────────────────

test('EVT-FARM-2: invalid records are named, and a load with them throws', () => {
  assert.deepEqual(validateFarm(tinyFarm()), []);
  const bad = tinyFarm();
  bad.cropPlans[0].fieldId = 'nope';
  assert.match(validateFarm(bad).join('\n'), /fieldId "nope" is not in farm\.fields/);
  assert.throws(() => run(bad), /farm records are invalid/);

  const two = tinyFarm({ seasons: [{ id: 'a', cropYear: 2027 }, { id: 'b', cropYear: 2028 }] });
  assert.match(validateFarm(two).join('\n'), /exactly one season/);

  const early = tinyFarm();
  early.sales[0].saleDate = '2027-09-01';
  assert.match(validateFarm(early).join('\n'), /before the CORN harvest/);

  const cat = tinyFarm();
  cat.products[0].category = 'MAGIC';
  assert.match(validateFarm(cat).join('\n'), /unknown category "MAGIC"/);

  const over = tinyFarm();
  over.sales.push({ id: 's2', operatorId: 'o1', crop: 'CORN', share: 0.5, saleDate: '2028-03-01' });
  assert.match(validateFarm(over).join('\n'), /more than all of it/);

  const dryIrr = tinyFarm();
  dryIrr.cropPlans[1].irrigationElectricity = 500;
  assert.match(validateFarm(dryIrr).join('\n'), /irrigation electricity on dry field/);
});

test('EVT-FARM-2: normalizeFarm fills defaults without touching the authored records', () => {
  const raw = tinyFarm();
  const before = JSON.stringify(raw);
  const f = normalizeFarm(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(f.fields[0].seasonId, 's2027');
  assert.equal(f.contracts[0].cropYear, 2027);
  assert.equal(f.season.calendar.prepayDate, '2026-12-15');
  assert.equal(priceOn(f.prices, 'CORN', '2027-12-31'), 4.0);
  assert.equal(priceOn(f.prices, 'CORN', '2028-02-01'), 5.0);
  assert.equal(priceOn(f.prices, 'CORN', '2020-01-01'), 4.0, 'before the first row → the first row');
});

// ─── cost flows ──────────────────────────────────────────────────────────────────

test('EVT-FARM-3: cash rent splits spring and fall on RENTED acres', () => {
  const { ledger } = run(tinyFarm());
  const rent = posts(ledger, p => p.category === 'LAND_RENT');
  assert.deepEqual(rent.map(p => [p.date, p.amount, p.jobId]), [
    ['2027-03-01', 5_000, 'pl-rent'],
    ['2027-11-01', 5_000, 'pl-rent'],
  ], '50 rented acres × $200, not 40 planted');
  assert.equal(rent[0].line, '24b');
});

test('EVT-FARM-3: a product line is acres × share × rate × price × (1 − discount), prepaid by category', () => {
  const { ledger } = run(tinyFarm());
  const seedOwn = ledger.find(p => p.sourceId === 'rx1');
  close(seedOwn.amount, 100 * 0.4 * 100 * 0.9, 'own seed');
  assert.equal(seedOwn.date, '2026-12-15', 'seed is prepaid the December before');
  assert.equal(seedOwn.line, '26');
  close(ledger.find(p => p.sourceId === 'rx4').amount, 40 * 0.5 * 0.4 * 100 * 0.9, 'half the rented field');
  close(ledger.find(p => p.sourceId === 'rx2').amount, 100 * 150 * 0.5, 'urea');
  assert.equal(ledger.find(p => p.sourceId === 'rx2').line, '17');
});

test('EVT-FARM-3: custom-rate machine work is costing only: never cash, no Schedule F line', () => {
  const { ledger } = run(tinyFarm());
  const comb = posts(ledger, p => p.category === 'CUSTOM_RATE');
  assert.deepEqual(comb.map(p => [p.jobId, p.amount, p.cash, p.line]), [
    ['pl-own', 3_000, false, null],
    ['pl-rent', 1_200, false, null],
  ]);
  assert.equal(categoryLine('CUSTOM_RATE'), null);
});

test('EVT-FARM-3: every category declares a Schedule F line, and the line order covers them all', () => {
  assert.throws(() => categoryLine('NOPE'), /Unknown farm category/);
  assert.deepEqual([...SCHEDULE_F_LINE_ORDER].sort(), Object.keys(SCHEDULE_F_LINES).sort());
});

// ─── grain ───────────────────────────────────────────────────────────────────────

test('EVT-FARM-4: harvest fills the pool; a contract and a planned sale empty it, paid on their dates', () => {
  const { ledger, sim } = run(tinyFarm());
  const pool = sim.state.farm.pools['o1|CORN|2027'];
  assert.equal(pool.harvested, 100 * 200 + 40 * 150);
  assert.equal(pool.bushels, 0);

  const grain = posts(ledger, p => p.category === 'GRAIN_SALES');
  assert.deepEqual(grain.map(p => [p.date, p.amount, p.receivableId]), [
    ['2028-01-05', 10_000 * 4.5, 'contract:k1'],
    // the unpriced 16,000 bu, at the table's price on the sale date
    ['2028-02-15', 16_000 * 5.0, 'sale:s1'],
  ]);
});

test('EVT-FARM-4: storage is bushels × rate × months held, charged when the grain leaves', () => {
  const { ledger } = run(tinyFarm());
  const st = posts(ledger, p => p.category === 'STORAGE');
  assert.deepEqual(st.map(p => p.date), ['2027-10-25', '2028-02-15']);
  close(st[0].amount, 10_000 * 0.05 * months('2027-10-20', '2027-10-25'), 'contract storage');
  close(st[1].amount, 16_000 * 0.05 * months('2027-10-20', '2028-02-15'), 'sale storage');
  assert.equal(st[0].line, '27');
});

test('EVT-FARM-4: a short crop delivers what it has and settles the rest at the market', () => {
  const farm = tinyFarm();
  farm.cropPlans[0].expectedYield = 30;            // 3,000 bu
  farm.cropPlans[1].expectedYield = 30;            // 1,200 bu
  farm.contracts[0].buyoutPerBu = 0.1;
  const { ledger, sim } = run(farm);
  const grain = posts(ledger, p => p.category === 'GRAIN_SALES');
  // 4,200 delivered at $4.50; 5,800 short at (4.50 − 4.00 market) less the $0.10 buyout
  assert.equal(grain.length, 1, 'nothing is left unpriced, so the planned sale sells nothing');
  close(grain[0].amount, 4_200 * 4.5 + 5_800 * (4.5 - 4.0 - 0.1), 'settled contract');
  const move = sim.journal.journal.find(e => e.action.type === 'FARM_GRAIN_MOVE' && e.action.data.kind === 'DELIVER');
  assert.equal(move.action.data.shortBushels, 5_800);
});

test('EVT-FARM-4: carry-in grain is its own crop year, and stays out of this season\'s job cost', () => {
  const farm = tinyFarm({
    carryIn: [{ id: 'ci', operatorId: 'o1', crop: 'CORN', bushels: 1_000 }],
    otherIncome: [{ id: 'arc', operatorId: 'o1', category: 'PROGRAM_PAYMENT', amount: 900,
      paymentDate: '2027-10-15', cropYear: 2026 }],
  });
  farm.sales.push({ id: 's-old', operatorId: 'o1', crop: 'CORN', cropYear: 2026, share: 1, saleDate: '2027-02-01' });
  const r = run(farm);
  const old = r.ledger.find(p => p.receivableId === 'sale:s-old');
  assert.equal(old.cropYear, 2026);
  close(old.amount, 1_000 * 4.0, 'sold at the first price row');
  const base = run(tinyFarm());
  close(r.jobCost.farm.revenue.total, base.jobCost.farm.revenue.total, 'carry-in revenue is not this season\'s');
  const y2027 = r.cash.find(x => x.year === 2027);
  close(y2027.income['2'], 4_000, 'but it is in the 2027 Schedule F');
  close(y2027.income['4a'], 900, 'and so is last crop\'s ARC payment');
});

// ─── reports ─────────────────────────────────────────────────────────────────────

test('EVT-FARM-5: job cost allocates overhead by its basis and grain by expected bushels', () => {
  const { jobCost } = run(tinyFarm());
  const own = jobCost.plans.find(r => r.planId === 'pl-own');
  const rent = jobCost.plans.find(r => r.planId === 'pl-rent');
  close(own.overhead.INTEREST_MORTGAGE, 3_000, 'owned-acre interest all on the owned field');
  assert.equal(rent.overhead.INTEREST_MORTGAGE, undefined);
  close(own.overhead.INSURANCE, 1_400 * 100 / 140, 'insurance by planted acres');
  close(rent.overhead.INSURANCE, 1_400 * 40 / 140, 'insurance by planted acres');
  const grain = 45_000 + 80_000;
  close(own.revenue.grain, grain * 20_000 / 26_000, 'own revenue share');
  close(rent.revenue.grain, grain * 6_000 / 26_000, 'rent revenue share');
  close(own.machinery.custom, 3_000, 'custom basis');
  close(own.machinery.actual, 7_000 * 100 / 140, 'actual basis by acres');
  close(own.machinery.margin, 3_000 - 5_000, 'margin = custom − actual');
  close(jobCost.farm.net, own.net + rent.net, 'farm = sum of plans');
});

test('EVT-FARM-5: the job cost excludes the carry-out prepay, which is next season\'s', () => {
  const { jobCost } = run(tinyFarm());
  assert.equal(jobCost.farm.cost.SEED, 3_600 + 720, 'only this season\'s seed, not the $20,000 carry-out');
});

test('EVT-FARM-5: breakevens follow design 134 §5.4', () => {
  const { jobCost } = run(tinyFarm());
  const own = jobCost.plans.find(r => r.planId === 'pl-own');
  close(own.breakevenPrice, own.totalCost / 20_000, 'breakeven price');
  // contracted: the pool's 10,000 bu × own's 20/26 share, at $4.50
  const kBu = 10_000 * 20_000 / 26_000;
  close(own.contractedBushels, kBu, 'contracted bushels');
  close(own.breakevenUnpricedPrice, (own.totalCost - kBu * 4.5) / (20_000 - kBu), 'unpriced breakeven');
  // the unpriced bushels' expected price is the planned sale's price, $5.00
  close(own.breakevenYield, (kBu + (own.totalCost - kBu * 4.5) / 5.0) / 100, 'breakeven yield');
});

test('EVT-FARM-5: the machinery basis decides the net, and the margin is reported either way', () => {
  const custom = run(tinyFarm()).jobCost.plans.find(r => r.planId === 'pl-own');
  const actual = run(tinyFarm(), { machineryBasis: 'ACTUAL' }).jobCost.plans.find(r => r.planId === 'pl-own');
  close(custom.net - actual.net, 5_000 - 3_000, 'nets differ by the margin');
  close(custom.machinery.margin, actual.machinery.margin, 'same margin on both bases');
});

test('EVT-FARM-5: the cash report is a calendar-year Schedule F, partial outside the crop year', () => {
  const { cash } = run(tinyFarm());
  assert.deepEqual(cash.map(r => [r.year, r.partial]), [[2026, true], [2027, false], [2028, true]]);
  const y26 = cash[0];
  close(y26.totalExpenses, 3_600 + 720 + 7_500, 'the prepay lands in 2026');
  assert.equal(y26.section464.assessed, false);
  const y27 = cash[1];
  assert.equal(y27.grossIncome, 0, 'both payments are deferred into 2028');
  close(y27.expense['24b'], 10_000, 'rent');
  close(y27.expense.MIXED_MACHINERY, 7_000, 'machinery on its mixed line');
  assert.equal(y27.expense['13'], undefined, 'custom-rate costing is not a cash expense');
  const y28 = cash[2];
  close(y28.income['2'], 125_000, 'grain sales in the year paid');
});

test('EVT-FARM-5: §464(d) defers prepaid supplies above 50% of the other expenses', () => {
  const { cash } = run(tinyFarm());
  const s = cash.find(r => r.year === 2027).section464;
  // 2027 other expenses: rent 10,000 + tax 2,000 + premium 1,000 + electricity 1,000
  //   + machinery 7,000 + interest 3,000 + insurance 1,400 + storage on the contract
  const storage = 10_000 * 0.05 * months('2027-10-20', '2027-10-25');
  close(s.otherExpenses, 25_400 + storage, 'other expenses');
  close(s.prepaid, 20_000, 'the carry-out seed');
  assert.equal(s.applies, true);
  close(s.deferred, 20_000 - 0.5 * (25_400 + storage), 'excess');
  const y27 = cash.find(r => r.year === 2027);
  close(y27.net, y27.netBefore464 + s.deferred, 'the deferral raises the year\'s net');
});

test('EVT-FARM-5: §464(d) does not apply to a qualified farm-related taxpayer', () => {
  const farm = tinyFarm();
  Object.assign(farm.operators[0], { farmRelated: true, prior3PrepaidSupplies: 10, prior3FarmExpenses: 100 });
  const s = run(farm).cash.find(r => r.year === 2027).section464;
  assert.equal(s.applies, false);
  assert.equal(s.deferred, 0);
  assert.match(s.reason, /qualified farm-related/);
});

// ─── persistence ─────────────────────────────────────────────────────────────────

test('EVT-FARM-6: cfg.farm survives a save and reload, and the reload runs the same ledger', () => {
  const cfg = FarmScenario.buildDefaultConfig({ farm: tinyFarm() });
  const saved = JSON.parse(JSON.stringify(ScenarioSerializer.serializeScenario({
    ...cfg, simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd), scenarioId: 'us-farm',
  })));
  assert.deepEqual(saved.farm, cfg.farm);
  const a = runFarm(cfg).ledger;
  const b = runFarm(saved).ledger;
  assert.deepEqual(b, a);
});

test('EVT-FARM-6: the demo farm validates and runs', () => {
  const r = runFarm(FarmScenario.buildDefaultConfig());
  assert.deepEqual(validateFarm(r.cfg.farm), []);
  assert.ok(r.jobCost.plans.length >= 4);
  assert.deepEqual(r.jobCost.unallocated, {});
  assert.deepEqual(r.jobCost.advisories, [], 'the demo farm seeds every annual plan');
});

// ─── FarmLedgerReducer postconditions (design 37 §6) ─────────────────────────────

import { FarmLedgerReducer } from '../../src/finance/farm/farm-classes.js';

const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const seed = () => deepFreeze({
  farm: {
    pools: { 'o1|CORN|2027': { operatorId: 'o1', crop: 'CORN', cropYear: 2027, bushels: 100, harvested: 100, enteredMs: 0 } },
    receivables: { 'sale:s1': { operatorId: 'o1', amount: 50 } },
    cash: { o1: 10 },
    contracted: {},
  },
});
const D = new Date('2027-11-01T00:00:00.000Z');

test('EVT-FARM-7: FarmLedgerReducer is pure and deterministic (I1, I2)', () => {
  const r = new FarmLedgerReducer();
  const s = seed();
  const before = JSON.stringify(s);
  const act = { type: 'FARM_GRAIN_MOVE', pool: 'o1|CORN|2027', bushels: 40, operatorId: 'o1', crop: 'CORN', cropYear: 2027 };
  const a = r.reduce(s, act, D);
  const b = r.reduce(s, act, D);
  assert.equal(JSON.stringify(s), before, 'input untouched');
  assert.deepEqual(a, b);
  assert.equal(a.farm.pools['o1|CORN|2027'].bushels, 140);
  assert.equal(a.farm.pools['o1|CORN|2027'].harvested, 140);
  close(a.farm.pools['o1|CORN|2027'].enteredMs, D.getTime() * 40 / 140, 'bushel-weighted entry date');
});

test('EVT-FARM-7: a pool never goes negative, and a paid receivable closes (I4)', () => {
  const r = new FarmLedgerReducer();
  const out = r.reduce(seed(), { type: 'FARM_GRAIN_MOVE', pool: 'o1|CORN|2027', bushels: -150 }, D);
  assert.equal(out.farm.pools['o1|CORN|2027'].bushels, 0);
  const paid = r.reduce(seed(), { type: 'FARM_LEDGER_POST', operatorId: 'o1', kind: 'REVENUE', cash: true,
    amount: 50, receivableId: 'sale:s1' }, D);
  assert.deepEqual(paid.farm.receivables, {});
  assert.equal(paid.farm.cash.o1, 60);
  const cost = r.reduce(seed(), { type: 'FARM_LEDGER_POST', operatorId: 'o1', kind: 'COST', cash: true, amount: 4 }, D);
  assert.equal(cost.farm.cash.o1, 6);
  const costing = r.reduce(seed(), { type: 'FARM_LEDGER_POST', operatorId: 'o1', kind: 'COST', cash: false, amount: 4 }, D);
  assert.equal(costing.farm.cash.o1, 10, 'a costing charge moves no cash');
});

test('EVT-FARM-7: an unknown pool starts empty; an unknown action is a no-op (I7)', () => {
  const r = new FarmLedgerReducer();
  const out = r.reduce(seed(), { type: 'FARM_GRAIN_MOVE', pool: 'o2|SOYBEANS|2027', bushels: 10,
    operatorId: 'o2', crop: 'SOYBEANS', cropYear: 2027 }, D);
  assert.equal(out.farm.pools['o2|SOYBEANS|2027'].bushels, 10);
  const same = r.reduce(seed(), { type: 'SOMETHING_ELSE' }, D);
  assert.deepEqual({ ...same, next: undefined }, { ...seed(), next: undefined });
});

// ─── generated levers (design 55 / 98) ───────────────────────────────────────────

import { ScenarioParamGenerator, decodeGeneratedParamKey } from '../../src/scenarios/params/scenario-param-generator.js';

test('EVT-FARM-8: farm records generate farm.<kind>.<id>.<field> levers, gated by what is read', () => {
  const keys = ScenarioParamGenerator.generate({ farm: tinyFarm() }).map(e => e.key);
  for (const k of ['farm.field.f-rent.rentPerAcre', 'farm.product.seed.unitPrice',
    'farm.operation.comb.customRatePerAcre', 'farm.plan.pl-own.expectedYield',
    'farm.plan.pl-own.irrigationElectricity', 'farm.machinery.m1.amount',
    'farm.price.p1.price', 'farm.storage.st.costPerBuMonth', 'farm.sale.s1.share',
    'farm.carryOut.co.amount']) {
    assert.ok(keys.includes(k), `missing ${k}`);
  }
  assert.ok(!keys.includes('farm.field.f-own.rentPerAcre'), 'an owned field pays no rent: no lever');
  assert.ok(!keys.includes('farm.plan.pl-rent.irrigationElectricity'), 'a dry plan pumps nothing');
  assert.ok(!keys.includes('farm.sale.s1.price'), 'a sale at the table price has no price of its own');
  assert.ok(!keys.some(k => k.startsWith('farm.contract')), 'contracts are fixed (Q8b)');
  assert.deepEqual(decodeGeneratedParamKey('farm.product.seed.unitPrice'),
    { type: 'farm', id: 'product.seed', field: 'unitPrice' });
});

test('EVT-FARM-8: a flat-bag override of a farm lever reaches the record and moves the ledger', () => {
  const cfg = FarmScenario.buildDefaultConfig({ farm: tinyFarm() });
  cfg.parameters = { 'farm.field.f-rent.rentPerAcre': 250, 'farm.plan.pl-own.expectedYield': 210 };
  const r = runFarm(cfg);
  const rent = r.ledger.filter(p => p.category === 'LAND_RENT').reduce((s, p) => s + p.amount, 0);
  assert.equal(rent, 50 * 250);
  assert.equal(r.sim.state.farm.pools['o1|CORN|2027'].harvested, 100 * 210 + 40 * 150);
});

test('EVT-FARM-5: a FIELDS overhead allocates by acres over its named fields only', () => {
  const farm = tinyFarm();
  farm.overhead[0] = { id: 'oh-int', operatorId: 'o1', category: 'INTEREST_MORTGAGE', amount: 3_000,
    basis: 'FIELDS', fieldIds: ['f-rent'] };
  const { jobCost } = run(farm);
  close(jobCost.plans.find(r => r.planId === 'pl-rent').overhead.INTEREST_MORTGAGE, 3_000, 'all on the named field');
  assert.equal(jobCost.plans.find(r => r.planId === 'pl-own').overhead.INTEREST_MORTGAGE, undefined);
  const bad = tinyFarm();
  bad.overhead[0] = { ...farm.overhead[0], fieldIds: ['nope'] };
  assert.match(validateFarm(bad).join('\n'), /not in farm\.fields/);
  const noList = tinyFarm();
  noList.overhead[0] = { ...farm.overhead[0], fieldIds: undefined };
  assert.match(validateFarm(noList).join('\n'), /fieldIds goes with basis FIELDS/);
});

test('EVT-FARM-5: a crop plan for an annual crop with no seed cost is an advisory, never an error', () => {
  const noSeed = tinyFarm();
  noSeed.prescriptions = noSeed.prescriptions.filter(r => r.id !== 'rx4');
  assert.deepEqual(validateFarm(noSeed), [], 'it still loads');
  const { jobCost } = run(noSeed);
  assert.deepEqual(jobCost.advisories.map(a => [a.kind, a.planId]), [['NO_SEED', 'pl-rent']]);
  assert.deepEqual(run(tinyFarm()).jobCost.advisories, [], 'both plans seeded');
  // A zero-rate seed line is no seed; a perennial crop needs none.
  const zero = tinyFarm();
  zero.prescriptions.find(r => r.id === 'rx4').ratePerAcre = 0;
  assert.deepEqual(farmAdvisories(normalizeFarm(zero)).map(a => a.planId), ['pl-rent']);
  const hay = tinyFarm();
  hay.prescriptions = hay.prescriptions.filter(r => r.id !== 'rx4');
  hay.cropPlans.find(p => p.id === 'pl-rent').crop = 'ALFALFA';
  assert.deepEqual(farmAdvisories(normalizeFarm(hay)), []);
});
