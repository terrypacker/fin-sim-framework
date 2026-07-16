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
 * evt-target-allocation-location.test.mjs — design 61 Phase 4 (Lever D, jurisdiction-
 * aware location).
 *
 * The whole-portfolio target is PLACED across accounts so each class sits in its
 * tax-favored home (bonds → tax-deferred, equity → Roth/taxable, gold → super and
 * never a US IRA/401k/Roth) while the AGGREGATE book still hits the target. Covers
 * the pure planner and its integration into RebalanceToTargetReducer (LOCATED default).
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { planLocatedTargets, DEFAULT_LOCATION_POLICY } from '../../src/finance/behavioral/allocation-location.js';
import { RebalanceToTargetReducer, ALLOCATION_LOCATION } from '../../src/finance/behavioral/rebalance-to-target-reducer.js';
import { RebalanceToTargetApplyReducer } from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { ALLOCATION }    from '../../src/finance/holdings/allocation.js';

const sumComp = c => Object.values(c).reduce((s, v) => s + v, 0);
const near = (a, b, e = 0.5) => Math.abs(a - b) <= e;

const ACCOUNTS = [
  { stateKey: 'iraAccount',     role: ACCOUNT_ROLES.IRA,      total: 200000 },
  { stateKey: 'rothAccount',    role: ACCOUNT_ROLES.ROTH,     total: 100000 },
  { stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK, total: 100000 },
  { stateKey: 'superAccount',   role: ACCOUNT_ROLES.SUPER,    total: 100000 },
];

// ── Pure planner ──────────────────────────────────────────────────────────────

test('LOC-1: every account composition sums to exactly its own total (value conserved)', () => {
  const plan = planLocatedTargets({ accounts: ACCOUNTS,
    portfolioTarget: { EQUITY: 0.5, BOND: 0.3, CASH: 0.1, GOLD: 0.1 } });
  for (const a of ACCOUNTS) {
    assert.ok(near(sumComp(plan.get(a.stateKey)), a.total),
      `${a.stateKey}: Σ ${sumComp(plan.get(a.stateKey))} != total ${a.total}`);
  }
});

test('LOC-2: the aggregate placement equals the portfolio target', () => {
  const target = { EQUITY: 0.5, BOND: 0.3, CASH: 0.1, GOLD: 0.1 };
  const plan = planLocatedTargets({ accounts: ACCOUNTS, portfolioTarget: target });
  const total = ACCOUNTS.reduce((s, a) => s + a.total, 0);
  const agg = {};
  for (const a of ACCOUNTS) for (const [k, v] of Object.entries(plan.get(a.stateKey))) agg[k] = (agg[k] ?? 0) + v;
  for (const cls of Object.keys(target)) {
    assert.ok(near((agg[cls] ?? 0) / total, target[cls], 0.01), `${cls}: ${(agg[cls] ?? 0) / total} != ${target[cls]}`);
  }
});

test('LOC-3: bonds prefer tax-deferred; equity prefers Roth/taxable; gold shelters in super', () => {
  const plan = planLocatedTargets({ accounts: ACCOUNTS,
    portfolioTarget: { EQUITY: 0.5, BOND: 0.3, CASH: 0.1, GOLD: 0.1 } });
  // BOND ($150k) fits entirely in the IRA (deferred) — none in the taxable brokerage.
  assert.ok((plan.get('iraAccount')[ALLOCATION.BOND] ?? 0) > 0, 'bonds in IRA');
  assert.strictEqual(plan.get('usStockAccount')[ALLOCATION.BOND] ?? 0, 0, 'no bonds in taxable brokerage');
  // GOLD ($50k) sits in super (the only gold-eligible shelter), never in IRA/Roth.
  assert.ok((plan.get('superAccount')[ALLOCATION.GOLD] ?? 0) > 0, 'gold in super');
  // Roth is all-equity (equity's top preference).
  assert.ok(near(plan.get('rothAccount')[ALLOCATION.EQUITY] ?? 0, 100000), 'roth all equity');
});

test('LOC-4: gold NEVER lands in a US IRA/401k/Roth (bullion ban)', () => {
  const plan = planLocatedTargets({ accounts: ACCOUNTS,
    portfolioTarget: { EQUITY: 0.2, BOND: 0.2, CASH: 0.1, GOLD: 0.5 } });   // heavy gold
  assert.strictEqual(plan.get('iraAccount')[ALLOCATION.GOLD] ?? 0, 0);
  assert.strictEqual(plan.get('rothAccount')[ALLOCATION.GOLD] ?? 0, 0);
});

test('LOC-5: gold above the eligible shelter capacity is capped + redistributed (Σ conserved)', () => {
  // Only super (100k) is gold-eligible among these two; a 60% gold target ($120k) exceeds it.
  const accts = [
    { stateKey: 'iraAccount',   role: ACCOUNT_ROLES.IRA,   total: 100000 },  // gold-ineligible
    { stateKey: 'superAccount', role: ACCOUNT_ROLES.SUPER, total: 100000 },  // gold-eligible
  ];
  const plan = planLocatedTargets({ accounts: accts, portfolioTarget: { EQUITY: 0.2, BOND: 0.2, GOLD: 0.6 } });
  const goldTotal = accts.reduce((s, a) => s + (plan.get(a.stateKey)[ALLOCATION.GOLD] ?? 0), 0);
  assert.ok(goldTotal <= 100000 + 0.5, `gold capped at super capacity: ${goldTotal}`);
  assert.strictEqual(plan.get('iraAccount')[ALLOCATION.GOLD] ?? 0, 0, 'no gold in the IRA');
  for (const a of accts) assert.ok(near(sumComp(plan.get(a.stateKey)), a.total), 'still conserved');
});

test('LOC-6: a single account holds the full portfolio target (location is a no-op)', () => {
  const plan = planLocatedTargets({ accounts: [{ stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK, total: 100000 }],
    portfolioTarget: { EQUITY: 0.6, BOND: 0.4 } });
  const comp = plan.get('usStockAccount');
  assert.ok(near(comp[ALLOCATION.EQUITY], 60000) && near(comp[ALLOCATION.BOND], 40000));
});

// ── Reducer integration (LOCATED is the default) ──────────────────────────────

function multiAcctState() {
  return {
    activeRegimes: [], regimeActions: {},
    people: { p1: { residency: 'US' } },
    currentPeriods: { US: { startMs: Date.UTC(2030, 0, 1) }, AU: { startMs: Date.UTC(2030, 0, 1) } },
    iraAccount:     { balance: 200000, role: ACCOUNT_ROLES.IRA, holdings: [
      { id: 'i0', allocation: ALLOCATION.EQUITY, marketValue: 200000, costBasis: 150000 }] },
    usStockAccount: { balance: 100000, role: ACCOUNT_ROLES.US_STOCK, holdings: [
      { id: 'u0', allocation: ALLOCATION.EQUITY, marketValue: 100000, costBasis: 60000 }] },
  };
}

test('LOC-7: LOCATED default — IRA concentrates bonds, taxable stays equity; value conserved', () => {
  const apply = new RebalanceToTargetApplyReducer();
  const reducer = new RebalanceToTargetReducer({
    accounts: [{ stateKey: 'iraAccount', role: ACCOUNT_ROLES.IRA },
               { stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK }],
    targetAllocation: { EQUITY: 0.5, BOND: 0.5 }, driftBandSheltered: 0.02, driftBandTaxable: 0.02,
  });
  const state = multiAcctState();
  const res = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
  let next = state; for (const a of (res.next ?? [])) next = apply.reduce(next, a);

  const bondOf = k => (next[k].holdings.find(h => h.allocation === ALLOCATION.BOND)?.marketValue ?? 0);
  // Portfolio is $300k, target 50/50 ⇒ $150k bonds. All of it locates into the IRA (deferred);
  // the taxable brokerage holds none.
  assert.ok(bondOf('iraAccount') > bondOf('usStockAccount'), 'IRA holds more bonds than the taxable acct');
  assert.strictEqual(bondOf('usStockAccount'), 0, 'taxable acct holds no bonds');
  // Value conserved per account.
  assert.ok(near(next.iraAccount.holdings.reduce((s, h) => s + h.marketValue, 0), 200000));
  assert.ok(near(next.usStockAccount.holdings.reduce((s, h) => s + h.marketValue, 0), 100000));
  // Aggregate bonds ≈ $150k (the portfolio target).
  assert.ok(near(bondOf('iraAccount') + bondOf('usStockAccount'), 150000, 1), 'aggregate bonds hit target');
});

test('LOC-8: PER_ACCOUNT mode drives every account to the uniform mix', () => {
  const apply = new RebalanceToTargetApplyReducer();
  const reducer = new RebalanceToTargetReducer({
    accounts: [{ stateKey: 'iraAccount', role: ACCOUNT_ROLES.IRA },
               { stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK }],
    targetAllocation: { EQUITY: 0.5, BOND: 0.5 }, driftBandSheltered: 0.02, driftBandTaxable: 0.02,
    locationMode: ALLOCATION_LOCATION.PER_ACCOUNT,
  });
  const state = multiAcctState();
  const res = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
  let next = state; for (const a of (res.next ?? [])) next = apply.reduce(next, a);
  const bondFrac = k => (next[k].holdings.find(h => h.allocation === ALLOCATION.BOND)?.marketValue ?? 0)
    / next[k].holdings.reduce((s, h) => s + h.marketValue, 0);
  // Both accounts individually reach ~50% bonds.
  assert.ok(near(bondFrac('iraAccount'), 0.5, 0.02), `IRA bond frac ${bondFrac('iraAccount')}`);
  assert.ok(near(bondFrac('usStockAccount'), 0.5, 0.02), `taxable bond frac ${bondFrac('usStockAccount')}`);
});
