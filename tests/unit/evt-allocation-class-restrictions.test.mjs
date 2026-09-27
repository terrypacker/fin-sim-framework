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
 * modes and the barred-holding rebalance trigger. (R-15, the StrategicAssetLocation guard, went
 * with that strategy's retirement — design 115 §12.)
 *
 * Phase 3 (R-16…): the `allocationClassRestrictions` param — normalization, the advisory
 * problems (incl. the US-citizen super warning), the registry wiring into both strategies,
 * and the EFFECT on a real loaded scenario.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { planLocatedTargets, roleCanHold, restrictMixForRole, normalizeClassRestrictions,
         collectClassRestrictionProblems } from '../../src/finance/behavioral/allocation-location.js';
import { BEHAVIORAL_STRATEGY_REGISTRY } from '../../src/finance/behavioral/behavioral-strategy-registry.js';
import { isParamVisible } from '../../src/finance/param-schema-utils.js';
import { loadScenarioSim } from '../helpers/scenario-harness.js';
import { roleCanHoldGold, RebalanceToTargetReducer, ALLOCATION_LOCATION }
  from '../../src/finance/behavioral/rebalance-to-target-reducer.js';
import { RebalanceToTargetApplyReducer } from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
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

// ── Phase 3 — the param ──────────────────────────────────────────────────────

test('R-16: normalizeClassRestrictions — keeps known classes/roles; null when nothing is barred', () => {
  assert.equal(normalizeClassRestrictions(null), null);
  assert.equal(normalizeClassRestrictions({}), null);
  assert.equal(normalizeClassRestrictions({ GOLD: [] }), null, 'an acknowledgement compiles to unrestricted');
  assert.equal(normalizeClassRestrictions(['GOLD']), null);
  assert.deepEqual(normalizeClassRestrictions({ GOLD: ['super', 'super', 'sprr'], OTHER: ['ira'], BOND: 'ira' }),
    { GOLD: ['super'] });
});

const PEOPLE = [{ id: 'primary', name: 'P', citizen: ['US'] }, { id: 'spouse', name: 'S', citizen: ['AU'] }];
const codes = (probs) => probs.map(p => p.code).sort();

test('R-17: problems — malformed entries are reported, never thrown, and all are advisory', () => {
  const accounts = [{ name: 'IRA', role: ACCOUNT_ROLES.IRA, ownerId: 'primary' }];
  const probs = collectClassRestrictionProblems({ OTHER: ['ira'], GOLD: 'super', BOND: ['nope'] }, accounts, PEOPLE);
  assert.deepEqual(codes(probs), ['shape', 'unknown-class', 'unknown-role']);
  assert.ok(probs.every(p => p.severity === 'warn'));
  assert.deepEqual(codes(collectClassRestrictionProblems('GOLD', accounts, PEOPLE)), ['shape']);
});

test('R-18: problems — a role barred from everything, and a class barred from every account', () => {
  const accounts = [{ name: 'IRA', role: ACCOUNT_ROLES.IRA }, { name: 'Super', role: ACCOUNT_ROLES.SUPER }];
  const all = [ACCOUNT_ROLES.SUPER];
  assert.ok(codes(collectClassRestrictionProblems({ GOLD: all, BOND: all, EQUITY: all, CASH: all }, accounts, []))
    .includes('role-barred-everywhere'));
  assert.ok(codes(collectClassRestrictionProblems({ GOLD: [ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.SUPER] }, accounts, []))
    .includes('class-barred-everywhere'));
});

test('R-19: the US-citizen super warning — owner-aware, and silenced by ANY GOLD key', () => {
  const primarySuper = { name: 'Super (P)', role: ACCOUNT_ROLES.SUPER, ownerId: 'primary' };
  const spouseSuper  = { name: 'Super (S)', role: ACCOUNT_ROLES.SUPER, ownerId: 'spouse' };
  const fired = (raw, accounts) => collectClassRestrictionProblems(raw, accounts, PEOPLE)
    .filter(p => p.code === 'us-citizen-super-gold').map(p => p.message);

  assert.equal(fired(null, [primarySuper]).length, 1);
  assert.match(fired(null, [primarySuper])[0], /Super \(P\)/);
  assert.equal(fired(null, [spouseSuper]).length, 0, 'an AU-citizen owner is not warned');
  assert.equal(fired({ GOLD: ['super'] }, [primarySuper]).length, 0, 'restricted');
  assert.equal(fired({ GOLD: [] }, [primarySuper]).length, 0, 'explicitly allowed');
  assert.equal(fired({ BOND: ['super'] }, [primarySuper]).length, 1, 'another class does not answer it');
  // Named owners and a joint account (everyone owns it) both count.
  assert.equal(fired(null, [{ ...spouseSuper, owners: [{ personId: 'primary', ownershipPct: 100 }] }]).length, 1);
  assert.equal(fired(null, [{ name: 'J', role: ACCOUNT_ROLES.SUPER, ownershipType: 'joint', ownerId: 'spouse' }]).length, 1);
});

test('R-20: schema — the param is visible under TARGET_ALLOCATION, and only then', () => {
  const meta = BEHAVIORAL_STRATEGY_REGISTRY.TARGET_ALLOCATION.paramSchema()
    .find(m => m.key === 'allocationClassRestrictions');
  assert.ok(meta, 'declared');
  assert.equal(meta.defaultValue, null);
  const visible = (strategies) => isParamVisible(meta, k => (k === 'behavioralStrategies' ? strategies : undefined));
  assert.equal(visible(['TARGET_ALLOCATION']), true);
  assert.equal(visible(['PANIC_SELL']), false);
});

test('R-21: registry — TARGET_ALLOCATION compiles the normalized map; each warning prints once per process', () => {
  const accounts = [{ name: 'R21 Super', stateKey: 'superAccount', role: ACCOUNT_ROLES.SUPER, ownerId: 'primary' },
                    { name: 'R21 IRA',   stateKey: 'iraAccount',   role: ACCOUNT_ROLES.IRA,   ownerId: 'primary' }];
  const ctx = (restrictions) => ({ accounts, people: PEOPLE, parameters: {
    behavioralStrategies: ['TARGET_ALLOCATION'],
    rebalanceTargetAllocation: { EQUITY: 0.9, BOND: 0, CASH: 0, GOLD: 0.1 },
    allocationClassRestrictions: restrictions } });

  const warns = []; const orig = console.warn; console.warn = (m) => warns.push(String(m));
  try {
    const [reb] = BEHAVIORAL_STRATEGY_REGISTRY.TARGET_ALLOCATION.reducers(ctx({ GOLD: ['super', 'bogus'] }));
    // A second compile (an MC iteration, say) must not print it again.
    BEHAVIORAL_STRATEGY_REGISTRY.TARGET_ALLOCATION.reducers(ctx({ GOLD: ['super', 'bogus'] }));
    assert.deepEqual(reb.classRestrictions, { GOLD: ['super'] });
    assert.equal(warns.filter(w => w.includes('"bogus"')).length, 1, 'printed once');

    const [free] = BEHAVIORAL_STRATEGY_REGISTRY.TARGET_ALLOCATION.reducers(ctx(null));
    assert.equal(free.classRestrictions, null);
    assert.equal(warns.filter(w => w.includes('R21 Super is owned by a US citizen')).length, 1);
  } finally { console.warn = orig; }
});

test('R-22: EFFECT on the loaded International Retirement plan — no gold in super once AU-resident', () => {
  // The reference plan moves to AU in 2031, after which super is gold's FIRST choice. The
  // param must reach the compiled reducer through a real load, not just sit in the bag.
  const goldBy = (params) => {
    const { sim } = loadScenarioSim({ params: { behavioralStrategies: ['TARGET_ALLOCATION'],
      rebalanceTargetAllocation: { EQUITY: 0.6, BOND: 0.3, CASH: 0, GOLD: 0.1 }, ...params },
      stepTo: '2035-01-15', telemetry: 'off' });
    const out = {};
    for (const [k, v] of Object.entries(sim.state)) {
      if (!v?.role || !Array.isArray(v.holdings)) continue;
      out[v.role] = (out[v.role] ?? 0) + v.holdings.filter(h => h.allocation === GOLD)
        .reduce((s, h) => s + h.marketValue, 0);
    }
    return out;
  };
  const orig = console.warn; console.warn = () => {};
  try {
    const free = goldBy({});
    assert.ok((free.super ?? 0) > 1000, `precondition: unrestricted, super holds gold (${free.super})`);
    const barred = goldBy({ allocationClassRestrictions: { GOLD: ['super'] } });
    assert.equal(barred.super ?? 0, 0);
    const book = (g) => Object.values(g).reduce((s, v) => s + v, 0);
    assert.ok(book(barred) > 0.5 * book(free), 'the gold moved elsewhere rather than vanishing');
  } finally { console.warn = orig; }
});
