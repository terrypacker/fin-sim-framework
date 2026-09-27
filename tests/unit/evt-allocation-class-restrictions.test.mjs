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
 * evt-allocation-class-restrictions.test.mjs — design 115 phase 1.
 *
 * `restrictions` (the opt-in `allocationClassRestrictions` map, class → roles the class may
 * NEVER occupy) is HARD in the LOCATED planner: no pass — preference, spillover, reconcile,
 * the §23 relaxation or the conservation fill — may put a restricted class in a barred role.
 * A class weight the permitted accounts cannot hold is capped and redistributed, and every
 * account's composition still sums to its own total.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { planLocatedTargets, roleCanHold } from '../../src/finance/behavioral/allocation-location.js';
import { roleCanHoldGold } from '../../src/finance/behavioral/rebalance-to-target-reducer.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { ALLOCATION }    from '../../src/finance/holdings/allocation.js';

const { GOLD, BOND, EQUITY, CASH } = ALLOCATION;
const sumComp = c => Object.values(c).reduce((s, v) => s + v, 0);
const near = (a, b, e = 0.5) => Math.abs(a - b) <= e;
const classIn = (plan, key, cls) => plan.get(key)?.[cls] ?? 0;
const aggregate = (plan, cls) => [...plan.values()].reduce((s, c) => s + (c[cls] ?? 0), 0);

const MIXED = [
  { stateKey: 'iraAccount',     role: ACCOUNT_ROLES.IRA,      total: 200000 },
  { stateKey: 'rothAccount',    role: ACCOUNT_ROLES.ROTH,     total: 100000 },
  { stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK, total: 100000 },
  { stateKey: 'superAccount',   role: ACCOUNT_ROLES.SUPER,    total: 100000 },
];
const TARGET = { EQUITY: 0.5, BOND: 0.3, CASH: 0.1, GOLD: 0.1 };
const NO_GOLD_IN_SUPER = { GOLD: [ACCOUNT_ROLES.SUPER] };

function assertConserved(accounts, plan) {
  for (const a of accounts) {
    assert.ok(near(sumComp(plan.get(a.stateKey)), a.total),
      `${a.stateKey}: Σ ${sumComp(plan.get(a.stateKey))} != total ${a.total}`);
  }
}

test('R-1: roleCanHold — null, unnamed class, and an explicit empty list all permit', () => {
  assert.equal(roleCanHold(GOLD, ACCOUNT_ROLES.SUPER), true);
  assert.equal(roleCanHold(GOLD, ACCOUNT_ROLES.SUPER, { BOND: [ACCOUNT_ROLES.SUPER] }), true);
  assert.equal(roleCanHold(GOLD, ACCOUNT_ROLES.SUPER, { GOLD: [] }), true, 'empty list = considered, allowed');
  assert.equal(roleCanHold(GOLD, ACCOUNT_ROLES.SUPER, NO_GOLD_IN_SUPER), false);
  assert.equal(roleCanHold(GOLD, ACCOUNT_ROLES.IRA, NO_GOLD_IN_SUPER), true, 'only the named role is barred');
  // The legacy name is the GOLD case, and is still total without restrictions.
  assert.equal(roleCanHoldGold(ACCOUNT_ROLES.SUPER), true);
  assert.equal(roleCanHoldGold(ACCOUNT_ROLES.SUPER, NO_GOLD_IN_SUPER), false);
});

test('R-2: no restrictions (null, {} or an empty list) ⇒ the plan is identical to today', () => {
  for (const residency of ['US', 'AU']) {
    const base = planLocatedTargets({ accounts: MIXED, portfolioTarget: TARGET, residency });
    for (const restrictions of [null, {}, { GOLD: [] }]) {
      const plan = planLocatedTargets({ accounts: MIXED, portfolioTarget: TARGET, residency, restrictions });
      assert.deepEqual(Object.fromEntries(plan), Object.fromEntries(base),
        `${residency} ${JSON.stringify(restrictions)}`);
    }
  }
});

test('R-3: AU residency — gold\'s FIRST choice is super, and the restriction keeps it out', () => {
  const free = planLocatedTargets({ accounts: MIXED, portfolioTarget: TARGET, residency: 'AU' });
  assert.ok(classIn(free, 'superAccount', GOLD) > 0, 'precondition: unrestricted AU plan puts gold in super');

  const stats = {};
  const plan = planLocatedTargets({ accounts: MIXED, portfolioTarget: TARGET, residency: 'AU',
    restrictions: NO_GOLD_IN_SUPER, stats });
  assert.equal(classIn(plan, 'superAccount', GOLD), 0);
  const book = MIXED.reduce((s, a) => s + a.total, 0);
  assert.ok(near(aggregate(plan, GOLD), TARGET.GOLD * book), 'the book still holds the full gold target');
  assert.equal(stats.restricted ?? 0, 0, 'nothing had to be redistributed');
  assertConserved(MIXED, plan);
});

test('R-4: US residency — gold that would SPILL into super is capped and redistributed instead', () => {
  const accts = [
    { stateKey: 'iraAccount',   role: ACCOUNT_ROLES.IRA,   total: 10000 },
    { stateKey: 'superAccount', role: ACCOUNT_ROLES.SUPER, total: 190000 },
  ];
  const target = { EQUITY: 0.3, BOND: 0.2, GOLD: 0.5 };
  const free = planLocatedTargets({ accounts: accts, portfolioTarget: target, residency: 'US' });
  assert.ok(classIn(free, 'superAccount', GOLD) > 0, 'precondition: gold spills into super');

  const stats = {};
  const plan = planLocatedTargets({ accounts: accts, portfolioTarget: target, residency: 'US',
    restrictions: NO_GOLD_IN_SUPER, stats });
  assert.equal(classIn(plan, 'superAccount', GOLD), 0);
  assert.ok(near(aggregate(plan, GOLD), 10000), 'gold capped at the IRA, the only permitted home');
  assert.ok(near(stats.restricted, 90000), `restricted = ${stats.restricted}`);
  // The 90k excess spreads pro rata over EQUITY:BOND = 3:2.
  assert.ok(near(aggregate(plan, EQUITY), 60000 + 54000), `equity ${aggregate(plan, EQUITY)}`);
  assert.ok(near(aggregate(plan, BOND),   40000 + 36000), `bond ${aggregate(plan, BOND)}`);
  assertConserved(accts, plan);
});

test('R-5: a class barred from EVERY present role is zeroed, not stranded', () => {
  const accts = [
    { stateKey: 'superAccount',   role: ACCOUNT_ROLES.SUPER,    total: 100000 },
    { stateKey: 'auStockAccount', role: ACCOUNT_ROLES.AU_STOCK, total: 100000 },
  ];
  const stats = {};
  const plan = planLocatedTargets({ accounts: accts, portfolioTarget: TARGET, residency: 'AU',
    restrictions: { GOLD: [ACCOUNT_ROLES.SUPER, ACCOUNT_ROLES.AU_STOCK] }, stats });
  assert.equal(aggregate(plan, GOLD), 0);
  assert.ok(near(stats.restricted, 20000));
  assertConserved(accts, plan);
});

test('R-6: the §23 relaxation pass may bend eligibility but never a restriction', () => {
  // Eligibility permits super NOTHING but GOLD — infeasible, so rule 3 relaxes it. The
  // relaxed dollars must land in a class super may hold, never GOLD.
  const accts = [
    { stateKey: 'iraAccount',   role: ACCOUNT_ROLES.IRA,   total: 100000 },
    { stateKey: 'superAccount', role: ACCOUNT_ROLES.SUPER, total: 100000 },
  ];
  const eligibility = new Map([['superAccount', new Set([GOLD])]]);
  const plan = planLocatedTargets({ accounts: accts, portfolioTarget: TARGET, residency: 'AU',
    eligibility, restrictions: NO_GOLD_IN_SUPER, stats: {} });
  assert.equal(classIn(plan, 'superAccount', GOLD), 0);
  assertConserved(accts, plan);
});

test('R-7: several classes restricted and jointly infeasible ⇒ over-place a PERMITTED class', () => {
  // Super may hold only EQUITY/CASH, but the mix has just 10% of those. The per-class caps
  // hold (gold 90k, bond 90k both fit the IRA alone) yet together they need 180k of IRA.
  const accts = [
    { stateKey: 'iraAccount',   role: ACCOUNT_ROLES.IRA,   total: 100000 },
    { stateKey: 'superAccount', role: ACCOUNT_ROLES.SUPER, total: 100000 },
  ];
  const stats = {};
  const plan = planLocatedTargets({ accounts: accts, portfolioTarget: { EQUITY: 0.1, BOND: 0.45, GOLD: 0.45 },
    residency: 'AU', restrictions: { GOLD: [ACCOUNT_ROLES.SUPER], BOND: [ACCOUNT_ROLES.SUPER] }, stats });
  assert.equal(classIn(plan, 'superAccount', GOLD), 0);
  assert.equal(classIn(plan, 'superAccount', BOND), 0);
  assert.ok(near(stats.overPlaced, 80000), `overPlaced = ${stats.overPlaced}`);
  assertConserved(accts, plan);
});

test('R-8: a role barred from every class is planned unrestricted (value outranks a malformed map)', () => {
  const accts = [
    { stateKey: 'iraAccount',   role: ACCOUNT_ROLES.IRA,   total: 100000 },
    { stateKey: 'superAccount', role: ACCOUNT_ROLES.SUPER, total: 100000 },
  ];
  const all = [ACCOUNT_ROLES.SUPER];
  const plan = planLocatedTargets({ accounts: accts, portfolioTarget: TARGET, residency: 'AU',
    restrictions: { GOLD: all, BOND: all, EQUITY: all, CASH: all } });
  assertConserved(accts, plan);
});

test('R-9: property — random books, mixes and restriction sets never violate a restriction', () => {
  // Also: the over-place fallback fires ONLY when no valid placement exists — some set of
  // accounts is larger than all the class dollars they may hold (Hall's condition fails).
  // A gap the repair search could have closed must never reach it.
  // Seeded LCG so a failure reproduces.
  let seed = 115;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const ROLES   = [ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.K401, ACCOUNT_ROLES.ROTH,
                   ACCOUNT_ROLES.US_STOCK, ACCOUNT_ROLES.AU_STOCK, ACCOUNT_ROLES.SUPER];
  const CLASSES = [GOLD, BOND, EQUITY, CASH];

  for (let i = 0; i < 400; i++) {
    const accts = ROLES.filter(() => rnd() < 0.7)
      .map((role, k) => ({ stateKey: `a${k}`, role, total: Math.round(1000 + rnd() * 200000) }));
    if (accts.length === 0) continue;
    const raw = CLASSES.map(() => rnd());
    const sum = raw.reduce((s, v) => s + v, 0);
    const target = Object.fromEntries(CLASSES.map((c, k) => [c, raw[k] / sum]));
    const restrictions = {};
    for (const c of CLASSES) {
      if (rnd() < 0.5) restrictions[c] = ROLES.filter(() => rnd() < 0.4);
    }
    const residency = rnd() < 0.5 ? 'US' : 'AU';
    const stats = {};
    const plan = planLocatedTargets({ accounts: accts, portfolioTarget: target, residency, restrictions, stats });
    if ((stats.overPlaced ?? 0) > 0.01) {
      const book = accts.reduce((s, a) => s + a.total, 0);
      let shortfall = 0;
      for (let m = 1; m < (1 << accts.length); m++) {
        const set = accts.filter((_, k) => (m >> k) & 1);
        const need = set.reduce((s, a) => s + a.total, 0);
        const avail = CLASSES.filter(c => set.some(a => roleCanHold(c, a.role, restrictions)))
          .reduce((s, c) => s + target[c] * book, 0);
        shortfall = Math.max(shortfall, need - avail);
      }
      assert.ok(shortfall > 0.01, `case ${i}: over-placed ${stats.overPlaced} but a valid placement exists`);
    }

    for (const a of accts) {
      const comp = plan.get(a.stateKey);
      const holdsNothing = CLASSES.every(c => !roleCanHold(c, a.role, restrictions));
      if (!holdsNothing) {
        for (const c of CLASSES) {
          if (!roleCanHold(c, a.role, restrictions)) {
            assert.equal(comp[c] ?? 0, 0, `case ${i}: ${c} in barred ${a.role} ${JSON.stringify(restrictions)}`);
          }
        }
      }
      assert.ok(near(sumComp(comp), a.total, 0.02), `case ${i}: ${a.stateKey} Σ ${sumComp(comp)} != ${a.total}`);
    }
  }
});
