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
 *
 * Phase 2 (R-10…): the same restrictions through `RebalanceToTargetReducer` in both location
 * modes, the barred-holding rebalance trigger, and `StrategicAssetLocationReducer`.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { planLocatedTargets, roleCanHold, restrictMixForRole } from '../../src/finance/behavioral/allocation-location.js';
import { roleCanHoldGold, RebalanceToTargetReducer, ALLOCATION_LOCATION }
  from '../../src/finance/behavioral/rebalance-to-target-reducer.js';
import { RebalanceToTargetApplyReducer } from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
import { StrategicAssetLocationReducer } from '../../src/finance/behavioral/strategic-asset-location-reducer.js';
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

// ── Phase 2 — the reducers ───────────────────────────────────────────────────

const REB_ACCOUNTS = [{ stateKey: 'iraAccount', role: ACCOUNT_ROLES.IRA },
                      { stateKey: 'superAccount', role: ACCOUNT_ROLES.SUPER }];

/** IRA all equity; super holding `superGold` of gold and the rest equity. AU resident. */
function rebState(superGold = 20000) {
  return {
    activeRegimes: [], regimeActions: {},
    people: { p1: { residency: 'AU' } },
    currentPeriods: { US: { startMs: Date.UTC(2032, 0, 1) }, AU: { startMs: Date.UTC(2032, 0, 1) } },
    iraAccount:   { balance: 100000, role: ACCOUNT_ROLES.IRA, holdings: [
      { id: 'i0', allocation: EQUITY, marketValue: 100000, costBasis: 80000 }] },
    superAccount: { balance: 100000, role: ACCOUNT_ROLES.SUPER, holdings: [
      { id: 's0', allocation: EQUITY, marketValue: 100000 - superGold, costBasis: 70000 },
      ...(superGold > 0 ? [{ id: 's1', allocation: GOLD, marketValue: superGold, costBasis: superGold }] : [])] },
  };
}

function runReb(opts, state = rebState()) {
  const reducer = new RebalanceToTargetReducer({ accounts: REB_ACCOUNTS,
    driftBandSheltered: 0.02, driftBandTaxable: 0.02, ...opts });
  const res = reducer.reduce(state, { type: 'AU_PERIOD_ADVANCE' });
  const apply = new RebalanceToTargetApplyReducer();
  let next = res; for (const a of (res.next ?? [])) next = apply.reduce(next, a);
  const held = (k, cls) => next[k].holdings.filter(h => h.allocation === cls).reduce((s, h) => s + h.marketValue, 0);
  return { reducer, res, next, held };
}

test('R-10: restrictMixForRole — same reference when nothing barred; barred classes zeroed, rest rescaled', () => {
  const mix = { EQUITY: 0.6, BOND: 0.3, GOLD: 0.1 };
  assert.equal(restrictMixForRole(mix, ACCOUNT_ROLES.SUPER, null), mix);
  assert.equal(restrictMixForRole(mix, ACCOUNT_ROLES.IRA, NO_GOLD_IN_SUPER), mix);
  const stats = {};
  const out = restrictMixForRole(mix, ACCOUNT_ROLES.SUPER, NO_GOLD_IN_SUPER, 50000, stats);
  assert.equal(out.GOLD, 0, 'explicit zero so the drift check sees it');
  assert.ok(near(out.EQUITY, 0.6 / 0.9, 1e-9) && near(out.BOND, 0.3 / 0.9, 1e-9));
  assert.ok(near(stats.restricted, 5000));
  // All the weight barred ⇒ the first permitted class takes it.
  assert.deepEqual(restrictMixForRole({ GOLD: 1 }, ACCOUNT_ROLES.SUPER, NO_GOLD_IN_SUPER), { GOLD: 0, EQUITY: 1 });
});

test('R-11: reducer with restrictions null ⇒ identical output to a reducer without the option', () => {
  for (const locationMode of [ALLOCATION_LOCATION.LOCATED, ALLOCATION_LOCATION.PER_ACCOUNT]) {
    const opts = { targetAllocation: { EQUITY: 0.7, BOND: 0.2, GOLD: 0.1 }, locationMode };
    const a = runReb(opts).res;
    const b = runReb({ ...opts, classRestrictions: null }).res;
    assert.deepEqual(b, a, locationMode);
  }
});

test('R-12: LOCATED, AU resident — gold held in super is sold and relocated; the book keeps its gold', () => {
  const target = { EQUITY: 0.7, BOND: 0.2, GOLD: 0.1 };
  const free = runReb({ targetAllocation: target });
  assert.ok(free.held('superAccount', GOLD) > 0, 'precondition: unrestricted AU plan keeps gold in super');

  const { held, reducer } = runReb({ targetAllocation: target, classRestrictions: NO_GOLD_IN_SUPER });
  assert.equal(held('superAccount', GOLD), 0);
  assert.ok(near(held('iraAccount', GOLD), 20000, 1), `IRA gold ${held('iraAccount', GOLD)}`);
  assert.equal(reducer._restrictedDollars, 0, 'the IRA had room — nothing redistributed');
});

test('R-13: PER_ACCOUNT — super drops gold and rescales; the IRA keeps the full mix', () => {
  const { held, reducer, res } = runReb({ targetAllocation: { EQUITY: 0.7, BOND: 0.2, GOLD: 0.1 },
    locationMode: ALLOCATION_LOCATION.PER_ACCOUNT, classRestrictions: NO_GOLD_IN_SUPER });
  assert.equal(held('superAccount', GOLD), 0);
  assert.ok(near(held('iraAccount', GOLD), 10000, 1));
  assert.equal(res.superAccount.targetComposition.GOLD, 0);
  assert.ok(near(reducer._restrictedDollars, 10000), `restricted ${reducer._restrictedDollars}`);
});

test('R-14: a barred class held INSIDE the drift band still forces the rebalance', () => {
  // Super holds 1% gold against a 1% gold target: within the 2% band, so unrestricted it
  // is left alone. Restricted, the gold must go.
  const opts = { targetAllocation: { EQUITY: 0.99, GOLD: 0.01 }, locationMode: ALLOCATION_LOCATION.PER_ACCOUNT };
  const state = () => {
    const s = rebState(1000);
    s.iraAccount.holdings = [{ id: 'i0', allocation: EQUITY, marketValue: 99000, costBasis: 80000 },
                             { id: 'i1', allocation: GOLD,   marketValue: 1000,  costBasis: 1000 }];
    return s;
  };
  const free = runReb(opts, state());
  assert.equal((free.res.next ?? []).length, 0, 'precondition: inside the band, no rebalance');
  const { held } = runReb({ ...opts, classRestrictions: NO_GOLD_IN_SUPER }, state());
  assert.equal(held('superAccount', GOLD), 0);
  assert.ok(near(held('iraAccount', GOLD), 1000, 1), 'the unrestricted IRA is untouched');
});

test('R-15: StrategicAssetLocation never grows a barred class in the receiving account', () => {
  // IRA equity is mislocated (policy wants EQUITY in super); super's only holding is gold,
  // so the "best available" fallback picks it and the apply would GROW super's gold.
  const state = {
    iraAccount:   { balance: 50000, holdings: [{ id: 'i0', allocation: EQUITY, marketValue: 50000, costBasis: 50000 }] },
    superAccount: { balance: 30000, holdings: [{ id: 's0', allocation: GOLD,   marketValue: 30000, costBasis: 30000 }] },
  };
  const taxAdvantaged = [{ stateKey: 'iraAccount', role: ACCOUNT_ROLES.IRA },
                         { stateKey: 'superAccount', role: ACCOUNT_ROLES.SUPER }];
  const assetLocationPolicy = { EQUITY: [ACCOUNT_ROLES.SUPER] };

  const free = new StrategicAssetLocationReducer({ taxAdvantaged, assetLocationPolicy })._computeMoves(state);
  assert.equal(free.length, 1, 'precondition: unrestricted, the move grows super\'s gold');
  assert.equal(free[0].toHoldingId, 's0');

  const moves = new StrategicAssetLocationReducer({ taxAdvantaged, assetLocationPolicy,
    classRestrictions: NO_GOLD_IN_SUPER })._computeMoves(state);
  assert.equal(moves.length, 0);
});
