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

test('LOC-3: bonds prefer tax-deferred; equity prefers Roth/taxable; gold shelters', () => {
  const plan = planLocatedTargets({ accounts: ACCOUNTS,
    portfolioTarget: { EQUITY: 0.5, BOND: 0.3, CASH: 0.1, GOLD: 0.1 } });
  // BOND ($150k) fits entirely in the IRA (deferred) — none in the taxable brokerage.
  assert.ok((plan.get('iraAccount')[ALLOCATION.BOND] ?? 0) > 0, 'bonds in IRA');
  assert.strictEqual(plan.get('usStockAccount')[ALLOCATION.BOND] ?? 0, 0, 'no bonds in taxable brokerage');
  // GOLD ($50k) is SHELTERED, never left in the taxable brokerage. Which shelter depends
  // on residency (§12.2 Q4) — the default here is US, whose 28% collectibles rate makes
  // any tax-advantaged account preferable, so it lands in the IRA rather than super.
  assert.strictEqual(plan.get('usStockAccount')[ALLOCATION.GOLD] ?? 0, 0, 'gold not left in taxable');
  const sheltered = ['iraAccount', 'rothAccount', 'superAccount']
    .reduce((s, k) => s + (plan.get(k)[ALLOCATION.GOLD] ?? 0), 0);
  assert.ok(near(sheltered, 50000), 'the whole gold sleeve is sheltered');
  // Roth is all-equity (equity's top preference).
  assert.ok(near(plan.get('rothAccount')[ALLOCATION.EQUITY] ?? 0, 100000), 'roth all equity');
});

test('LOC-3b: gold\'s preferred home follows RESIDENCY (design 61 §12.2 Q4)', () => {
  const target = { EQUITY: 0.5, BOND: 0.3, CASH: 0.1, GOLD: 0.1 };   // $50k gold
  const goldIn = (plan, key) => plan.get(key)[ALLOCATION.GOLD] ?? 0;

  // US resident: a taxable gold sale is 28% collectibles, so shelter it — IRA first.
  const us = planLocatedTargets({ accounts: ACCOUNTS, portfolioTarget: target, residency: 'US' });
  assert.ok(near(goldIn(us, 'iraAccount'), 50000), 'US resident shelters gold in the IRA');
  assert.strictEqual(goldIn(us, 'superAccount'), 0);

  // AU resident: bullion is ordinary CPI-indexed AU CGT, and super shelters it best.
  const au = planLocatedTargets({ accounts: ACCOUNTS, portfolioTarget: target, residency: 'AU' });
  assert.ok(near(goldIn(au, 'superAccount'), 50000), 'AU resident shelters gold in super');
  assert.strictEqual(goldIn(au, 'iraAccount'), 0);

  // Both conserve every account's own total — location never moves value between accounts.
  for (const plan of [us, au]) {
    for (const a of ACCOUNTS) assert.ok(near(sumComp(plan.get(a.stateKey)), a.total));
  }
});

test('LOC-3c: an explicit policy override still wins, per class', () => {
  // The residency default must not silently override a scenario's authored preference.
  const plan = planLocatedTargets({
    accounts: ACCOUNTS, residency: 'US',
    portfolioTarget: { EQUITY: 0.5, BOND: 0.3, CASH: 0.1, GOLD: 0.1 },
    policy: { [ALLOCATION.GOLD]: [ACCOUNT_ROLES.US_STOCK] },
  });
  assert.ok(near(plan.get('usStockAccount')[ALLOCATION.GOLD] ?? 0, 50000),
    'the override pins gold to the taxable brokerage');
});

test('LOC-4: gold MAY land in a US IRA/401k/Roth (bullion ban reversed)', () => {
  // Inverse of the original LOC-4. Design 61 §12 OQ4a, reversed 2026-07-29: §408(m)
  // restricts *physical* bullion, not a gold ETF, which every IRA/401k/Roth can hold.
  // A gold target larger than the gold-preferred shelters must now spill into them
  // rather than be capped away.
  const plan = planLocatedTargets({ accounts: ACCOUNTS,
    portfolioTarget: { EQUITY: 0.2, BOND: 0.2, CASH: 0.1, GOLD: 0.5 } });   // heavy gold

  const book     = ACCOUNTS.reduce((s, a) => s + a.total, 0);
  const placed   = ACCOUNTS.reduce((s, a) => s + (plan.get(a.stateKey)[ALLOCATION.GOLD] ?? 0), 0);
  assert.ok(near(placed, 0.5 * book),
    `the full 50% gold target is placed, not capped: ${placed} vs ${0.5 * book}`);

  const inUsRetirement = ['iraAccount', 'rothAccount']
    .reduce((s, k) => s + (plan.get(k)[ALLOCATION.GOLD] ?? 0), 0);
  assert.ok(inUsRetirement > 0, 'gold is no longer excluded from US retirement accounts');
  for (const a of ACCOUNTS) assert.ok(near(sumComp(plan.get(a.stateKey)), a.total), 'still conserved');
});

test('LOC-5: the gold capacity cap is now INERT — every account is gold-eligible', () => {
  // Was: "gold above the eligible shelter capacity is capped + redistributed". With the
  // bullion guard reversed, `goldCap` equals the whole book, so a normalized target can
  // never exceed it and the redistribution branch in allocation-location.js is
  // unreachable. It is retained as the seam for a future eligibility rule (see
  // roleCanHoldGold); this test pins that it currently does nothing.
  const accts = [
    { stateKey: 'iraAccount',   role: ACCOUNT_ROLES.IRA,   total: 100000 },
    { stateKey: 'superAccount', role: ACCOUNT_ROLES.SUPER, total: 100000 },
  ];
  const plan = planLocatedTargets({ accounts: accts, portfolioTarget: { EQUITY: 0.2, BOND: 0.2, GOLD: 0.6 } });

  const goldTotal = accts.reduce((s, a) => s + (plan.get(a.stateKey)[ALLOCATION.GOLD] ?? 0), 0);
  assert.ok(near(goldTotal, 120000), `the full 60% ($120k) is placed, uncapped: ${goldTotal}`);
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

// ── Design 97 §23 — the placement eligibility seam ────────────────────────────
//
// `eligibility` is HARD where the role policy is soft. The three tests below pin the
// three rules that make it usable: inert when absent, honoured when the book can afford
// it, and RELAXED (never value-destroying) when it cannot — with the violation counted
// rather than hidden, because a silently partial constraint is the failure mode.

test('LOC-9: eligibility absent ⇒ byte-identical to no eligibility at all', () => {
  const target = { EQUITY: 0.5, BOND: 0.3, CASH: 0.1, GOLD: 0.1 };
  const base = planLocatedTargets({ accounts: ACCOUNTS, portfolioTarget: target });
  for (const eligibility of [null, undefined, new Map()]) {
    const plan = planLocatedTargets({ accounts: ACCOUNTS, portfolioTarget: target, eligibility });
    for (const a of ACCOUNTS) {
      assert.deepEqual(plan.get(a.stateKey), base.get(a.stateKey),
        `${a.stateKey}: eligibility ${JSON.stringify(eligibility)} changed an unconstrained plan`);
    }
  }
});

test('LOC-10: a permitted set the book can afford is honoured exactly, and costs nothing elsewhere', () => {
  // 10% bonds against a 500k book is 50k, and the three non-Roth accounts hold 400k —
  // so excluding BOND from the Roth is comfortably feasible.
  const target = { EQUITY: 0.8, BOND: 0.1, CASH: 0.1, GOLD: 0 };
  const stats = {};
  const plan = planLocatedTargets({
    accounts: ACCOUNTS, portfolioTarget: target, stats,
    eligibility: new Map([['rothAccount', new Set([ALLOCATION.EQUITY, ALLOCATION.CASH])]]),
  });
  assert.equal(plan.get('rothAccount')[ALLOCATION.BOND] ?? 0, 0, 'a forbidden class was placed anyway');
  assert.ok(!stats.relaxed, `feasible constraint reported ${stats.relaxed} relaxed`);
  for (const a of ACCOUNTS) {
    assert.ok(near(sumComp(plan.get(a.stateKey)), a.total), `${a.stateKey}: value not conserved`);
  }
});

test('LOC-11: an INFEASIBLE permitted set relaxes rather than stranding value, and says so', () => {
  // 90% bonds against a 500k book is 450k; everything but the Roth holds 400k. 50k of
  // bonds has nowhere legal to go, so the Roth must take it — value conservation outranks
  // the exclusion (§23 rule 3) and `stats.relaxed` is the confession.
  const stats = {};
  const plan = planLocatedTargets({
    accounts: ACCOUNTS, portfolioTarget: { EQUITY: 0.1, BOND: 0.9, CASH: 0, GOLD: 0 }, stats,
    eligibility: new Map([['rothAccount', new Set([ALLOCATION.EQUITY])]]),
  });
  for (const a of ACCOUNTS) {
    assert.ok(near(sumComp(plan.get(a.stateKey)), a.total),
      `${a.stateKey}: Σ ${sumComp(plan.get(a.stateKey))} != ${a.total} — the exclusion destroyed value`);
  }
  assert.ok(stats.relaxed > 0, 'an infeasible exclusion was honoured silently');
  assert.ok(near(stats.relaxed, plan.get('rothAccount')[ALLOCATION.BOND] ?? 0),
    'relaxed dollars do not match the forbidden dollars actually placed');
});

test('LOC-12: an account permitted NOTHING is a real statement, not an absent one', () => {
  // The empty Set must not read as "unconstrained" — that is the difference between
  // "this account holds nothing" and a typo, and they cannot look alike.
  const stats = {};
  const plan = planLocatedTargets({
    accounts: ACCOUNTS, portfolioTarget: { EQUITY: 0.5, BOND: 0.5, CASH: 0, GOLD: 0 }, stats,
    eligibility: new Map([['rothAccount', new Set()]]),
  });
  // Nothing may legally sit there, so every dollar in it is relaxed — and it is still full,
  // because the account's own total is not negotiable.
  assert.ok(near(sumComp(plan.get('rothAccount')), 100000), 'value not conserved in a nothing-permitted account');
  assert.ok(near(stats.relaxed, 100000), `expected the whole account relaxed, got ${stats.relaxed}`);
});
