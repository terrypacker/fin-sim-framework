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
 * evt-bond-maturity-date.test.mjs — issue #799: a bond redeems ON its maturity date.
 *
 * Before the fix the only trigger was the period advance, so a 15 Jan maturity paid on the
 * next 1 Jul (two-country plan) or the next 1 Jan (single-country), indexing and paying
 * coupon all the while. These run the full International Retirement sim.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { loadScenarioSim } from '../helpers/scenario-harness.js';
import { nextBondMaturityWakeMs, BondMaturityHandler } from '../../src/finance/economic-regimes/bond-maturity-reducer.js';

const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

function seedBond(cfg, holding) {
  const acct = (cfg.accounts ?? []).find(a => a.role === 'us-stock');
  assert.ok(acct, 'expected a us-stock brokerage account');
  acct.holdings = [holding];
  acct.initialValue = holding.marketValue;
  acct.balance      = holding.marketValue;
  return acct.stateKey;
}

function run(holding, stepTo, params = {}) {
  let key;
  const { sim } = loadScenarioSim({
    params:    { residencyState: 'NE', monthlyExpenses: 0, inflationAdjust: false, ...params },
    mutateCfg: cfg => { key = seedBond(cfg, holding); },
    stepTo,
  });
  return { sim, acct: sim.state[key] ?? sim.state.usStockAccount };
}

const TIPS = {
  id: 'tips', allocation: 'BOND', marketValue: 50_000, costBasis: 50_000, faceValue: 50_000,
  rateKey: 'FIXED_INCOME_US', duration: 2, couponRate: 0.01, inflationLinked: true,
  maturityDate: D(2027, 1, 15), purchaseDate: D(2025, 1, 15),
};

test('BMD-1: a 15 Jan TIPS is still a bond on 14 Jan and cash on 15 Jan', () => {
  const before = run(TIPS, D(2027, 1, 14)).acct.holdings.find(h => h.id === 'tips');
  assert.equal(before.allocation, 'BOND');

  const after = run(TIPS, D(2027, 1, 16)).acct.holdings.find(h => h.id === 'tips');
  assert.equal(after.allocation, 'CASH', 'redeemed on the maturity date, not at the 1 Jul advance');
  assert.equal(new Date(after.purchaseDate).getTime(), D(2027, 1, 15).getTime(),
    'the cash lot is dated on the maturity date');
});

test('BMD-2: no indexation or coupon accrues after maturity', () => {
  // Accretion and coupons only read BOND lots, so the lot leaving BOND on 15 Jan is what
  // stops them. Before #799 it stayed an indexing TIPS until 1 Jul.
  const mid = run(TIPS, D(2027, 6, 29)).acct.holdings.find(h => h.id === 'tips');
  assert.equal(mid.allocation, 'CASH');
  assert.equal(mid.inflationLinked, false);
  assert.equal(mid.couponRate, null);
  assert.equal(mid.maturityDate, null);
});

test('BMD-3: a rolling rung keeps its grid and rolls on its own date', () => {
  const rung = { ...TIPS, id: 'rung', inflationLinked: false, rollAtMaturity: true, rollTermYears: 2 };
  const after = run(rung, D(2027, 1, 16)).acct.holdings.find(h => h.id === 'rung');
  assert.equal(after.allocation, 'BOND');
  assert.equal(new Date(after.purchaseDate).getTime(), D(2027, 1, 15).getTime());
  const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
  assert.equal(new Date(after.maturityDate).getTime(), D(2027, 1, 15).getTime() + 2 * YEAR_MS);
});

test('BMD-4: the wake targets the next maturity, a roll, or the first of next month', () => {
  const h = (id, mat, extra = {}) => ({ id, allocation: 'BOND', marketValue: 1, maturityDate: mat, ...extra });
  const now = D(2027, 1, 10).getTime();
  // A maturity inside the month wins over the month fallback.
  assert.equal(nextBondMaturityWakeMs({ a: { holdings: [h('x', D(2027, 1, 15))] } }, now), D(2027, 1, 15).getTime());
  // Nothing held ⇒ poll on the first of next month, so a later purchase is found.
  assert.equal(nextBondMaturityWakeMs({}, now), D(2027, 2, 1).getTime());
  // A rung maturing NOW that rolls ⇒ its re-issued maturity is a candidate, not a past date.
  const nowRoll = D(2027, 1, 15).getTime();
  const r = nextBondMaturityWakeMs({ a: { holdings: [h('r', D(2027, 1, 15), { rollAtMaturity: true, rollTermYears: 0.01 })] } }, nowRoll);
  assert.ok(r > nowRoll && r < D(2027, 2, 1).getTime());
});

test('BMD-5: the handler always schedules exactly one next wake and applies only on a maturity', () => {
  const scheduled = [];
  const sim = { schedule: e => scheduled.push(e), simEnd: D(2040, 1, 1) };
  const out = new BondMaturityHandler().call({ sim, state: {}, date: D(2027, 1, 10) });
  assert.deepEqual(out, []);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].type, 'BOND_MATURITY');
});

test('BMD-6: a maturity that is not a UTC midnight wakes on the next midnight, not the same day', () => {
  // Ladder terms are 365.25-day years, so a rung can mature at 06:00. The queue floors dates
  // to midnight; a wake at 06:00 would re-fire on the same day forever.
  const now = D(2027, 1, 15).getTime();
  const mat = now + 6 * 3600_000;
  const next = nextBondMaturityWakeMs({ a: { holdings: [{ id: 'x', allocation: 'BOND', marketValue: 1, maturityDate: new Date(mat) }] } }, now);
  assert.equal(next, D(2027, 1, 16).getTime());
});
