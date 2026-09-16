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
 * evt-dividend-reinvest-election.test.mjs — design 106 phase 1.
 *
 * A DRIP election is made per BROKER, so it belongs to the account, not to the plan.
 * `dividendReinvest` stays as the household DEFAULT; `account.reinvestDividends`
 * (tri-state, null = inherit) overrides it for one account.
 *
 * The election is read from the runtime STATE entry, not captured when the handler is
 * built, because a loaded scenario restores its handlers from JSON without re-running
 * the toolset — the design-58 trap where a lever works on a compiled plan and is inert
 * on a loaded one. DRIP-3/3b are therefore run through the full load path rather than
 * against a hand-built handler.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { DividendScheduledHandler }   from '../../src/finance/handlers/dividend-scheduled-handler.js';
import { BondCouponScheduledHandler } from '../../src/finance/handlers/bond-coupon-handler.js';
import { ACCOUNT_ROLES, DIVIDEND_ELECTION_ROLES } from '../../src/finance/state/account-roles.js';
import { BrokerageAccount }           from '../../src/finance/assets/investment-account.js';
import { ScenarioSerializer }         from '../../src/scenarios/scenario-serializer.js';
import { ScenarioParamGenerator }     from '../../src/scenarios/params/scenario-param-generator.js';
import { loadScenarioSim }            from '../helpers/scenario-harness.js';

const STATE_KEY = 'usStockAccount';
const registry  = {
  getStateKey: () => STATE_KEY,
  getAccount:  (state) => state[STATE_KEY],
};

const stateWith = (election) => ({
  [STATE_KEY]: {
    balance: 100000, ownerId: null,
    ...(election === undefined ? {} : { reinvestDividends: election }),
  },
  people: {},
});

const typesFrom = (actions) => actions.map(a => a.type);

// ── DRIP-1: the dividend branch ──────────────────────────────────────────────

test('DRIP-1: the account election overrides the household default, both ways', () => {
  const household = (reinvest) => new DividendScheduledHandler({
    stateRegistry: registry, role: ACCOUNT_ROLES.US_STOCK, dividendRate: 0.04, reinvest,
  });

  // Household default OFF, this broker reinvests.
  assert.ok(typesFrom(household(false).call({ data: {}, state: stateWith(true) }))
    .includes('STOCK_DIVIDEND_APPLY'), 'election true beats a false default');

  // Household default ON, this broker pays cash — the case a plain truthiness test
  // would get wrong, because `false` is an election and not an absent one.
  assert.ok(typesFrom(household(true).call({ data: {}, state: stateWith(false) }))
    .includes('STOCK_DIVIDEND_CASH_APPLY'), 'election false beats a true default');
});

test('DRIP-1b: an account with no election inherits the household default', () => {
  const h = new DividendScheduledHandler({
    stateRegistry: registry, role: ACCOUNT_ROLES.US_STOCK, dividendRate: 0.04, reinvest: true,
  });
  // Both spellings of "no opinion": the field absent (every scenario saved before the
  // field existed) and the field explicitly null (the editor's "Default").
  assert.ok(typesFrom(h.call({ data: {}, state: stateWith(undefined) })).includes('STOCK_DIVIDEND_APPLY'),
    'absent ⇒ inherit');
  assert.ok(typesFrom(h.call({ data: {}, state: stateWith(null) })).includes('STOCK_DIVIDEND_APPLY'),
    'null ⇒ inherit');
});

test('DRIP-1c: a one-off event\'s own data.reinvest still outranks the account election', () => {
  const h = new DividendScheduledHandler({
    stateRegistry: registry, role: ACCOUNT_ROLES.US_STOCK, dividendRate: 0.04, reinvest: false,
  });
  assert.ok(typesFrom(h.call({ data: { reinvest: false }, state: stateWith(true) }))
    .includes('STOCK_DIVIDEND_CASH_APPLY'), 'data.reinvest wins');
});

// ── DRIP-2: the coupon branch takes the same election ────────────────────────

test('DRIP-2: one broker, one election — the account\'s bond coupons follow its dividends', () => {
  const bondState = (election) => ({
    [STATE_KEY]: {
      balance: 100000, ownerId: null, reinvestDividends: election,
      holdings: [{ id: 'b1', allocation: 'BOND', marketValue: 100000, costBasis: 100000, couponRate: 0.05 }],
    },
    people: {},
  });
  const h = (reinvest) => new BondCouponScheduledHandler({
    stateRegistry: registry, role: ACCOUNT_ROLES.US_STOCK, couponRate: 0.05, reinvest,
  });
  const date = new Date('2030-12-31');

  assert.ok(typesFrom(h(false).call({ data: {}, state: bondState(true), date }))
    .includes('BOND_COUPON_APPLY'), 'election true beats a false default');
  assert.ok(typesFrom(h(true).call({ data: {}, state: bondState(false), date }))
    .includes('BOND_COUPON_CASH_APPLY'), 'election false beats a true default');
});

// ── DRIP-3: end to end, through the loader ──────────────────────────────────

/**
 * Did this action type fire at all during the run? Presence only — `getActions` returns
 * one entry per REDUCER, so its length double-counts a multi-reducer action and must
 * never be summed here.
 */
const fired = (sim, type) => (sim.journal?.getActions?.(type)?.length ?? 0) > 0;

const RUN = { simStart: '2026-01-01', simEnd: '2028-01-01', stepTo: '2028-01-01' };

// The household default is spelled `stockDividendReinvest` at the SCENARIO level and
// forwarded to the toolset's `dividendReinvest` (intl-retirement-scenario.js). Passing
// the toolset spelling here would be silently ignored — the two-param-store trap.


test('DRIP-3: an account electing reinvest beats a household default of cash, through the full load path', () => {
  const { sim } = loadScenarioSim({
    ...RUN,
    params: { stockDividendReinvest: false },
    mutateCfg: (cfg) => {
      const acct = (cfg.accounts ?? []).find(a => a.role === ACCOUNT_ROLES.US_STOCK);
      assert.ok(acct, 'the reference plan has a us-stock account');
      acct.reinvestDividends = true;
    },
  });
  assert.ok(fired(sim, 'STOCK_DIVIDEND_APPLY'), 'the elected account reinvested');
  assert.ok(!fired(sim, 'STOCK_DIVIDEND_CASH_APPLY'), 'and nothing paid cash');
});

test('DRIP-3b: an account electing cash beats a household default of reinvest', () => {
  const { sim } = loadScenarioSim({
    ...RUN,
    params: { stockDividendReinvest: true },
    mutateCfg: (cfg) => {
      const acct = (cfg.accounts ?? []).find(a => a.role === ACCOUNT_ROLES.US_STOCK);
      acct.reinvestDividends = false;
    },
  });
  assert.ok(fired(sim, 'STOCK_DIVIDEND_CASH_APPLY'), 'the elected account paid cash');
  assert.ok(!fired(sim, 'STOCK_DIVIDEND_APPLY'), 'and nothing reinvested');
});

test('DRIP-3c: an unelected plan is unchanged — the default still decides', () => {
  const cash = loadScenarioSim({ ...RUN, params: { stockDividendReinvest: false } }).sim;
  assert.ok(fired(cash, 'STOCK_DIVIDEND_CASH_APPLY') && !fired(cash, 'STOCK_DIVIDEND_APPLY'));
  const drip = loadScenarioSim({ ...RUN, params: { stockDividendReinvest: true } }).sim;
  assert.ok(fired(drip, 'STOCK_DIVIDEND_APPLY') && !fired(drip, 'STOCK_DIVIDEND_CASH_APPLY'));
});

// ── DRIP-6: the AU franked cash branch (phase 1b) ───────────────────────────

/**
 * Sum an action type's `amount` across the run, counting each ACTION once.
 *
 * Two traps, both of which return a plausible wrong number rather than an error: the
 * payload lives at `entry.action.data`, not on the entry; and `getActions` yields one
 * entry per REDUCER, so an action two reducers handle is counted twice unless the
 * dedupe below drops it on `instanceId`.
 */
function sumAmount(sim, type) {
  const seen = new Set();
  let total = 0;
  for (const e of (sim.journal?.getActions?.(type) ?? [])) {
    const id = e?.action?.instanceId;
    if (id != null && seen.has(id)) continue;
    if (id != null) seen.add(id);
    total += e?.action?.data?.amount ?? 0;
  }
  return +total.toFixed(2);
}

test('DRIP-6: an AU account electing cash pays out instead of reinvesting', () => {
  const { sim } = loadScenarioSim({
    ...RUN,
    mutateCfg: (cfg) => {
      const acct = (cfg.accounts ?? []).find(a => a.role === ACCOUNT_ROLES.AU_STOCK);
      assert.ok(acct, 'the reference plan has an au-stock account');
      acct.reinvestDividends = false;
    },
  });
  // The reference plan is US-resident over this window, so it is the NON-resident
  // branch that fires (s128B(3)(ga)).
  assert.ok(fired(sim, 'AU_DIVIDEND_FRANKED_NONRESIDENT_CASH_APPLY'), 'paid out as cash');
  assert.ok(!fired(sim, 'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY'), 'and nothing reinvested');
});

test('DRIP-6b: an unelected AU account still reinvests — the historic default', () => {
  const { sim } = loadScenarioSim({ ...RUN });
  assert.ok(fired(sim, 'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY'));
  assert.ok(!fired(sim, 'AU_DIVIDEND_FRANKED_NONRESIDENT_CASH_APPLY'),
    'before phase 1b there was no cash branch at all; an unelected plan must not find one now');
});

test('DRIP-6c: the election moves the MONEY without moving the TAX', () => {
  // The whole claim of §4a. A dividend is derived when it is paid; where it is banked
  // afterwards is not a tax fact, so the assessable amount must be identical.
  const taxOf = (reinvest) => {
    const { sim } = loadScenarioSim({
      ...RUN,
      mutateCfg: (cfg) => {
        (cfg.accounts ?? []).find(a => a.role === ACCOUNT_ROLES.AU_STOCK).reinvestDividends = reinvest;
      },
    });
    return sumAmount(sim, 'AU_DIVIDEND_FRANKED_NONRESIDENT_TAX');
  };
  const reinvested = taxOf(true);
  assert.ok(reinvested > 0, 'the run pays a franked dividend at all');
  // Equal to the cent in the FIRST year; over a multi-year run the reinvested arm
  // compounds a larger book and so pays a larger dividend next year, which is the
  // economics working rather than the tax differing. Assert on year one alone.
  const firstYear = (reinvest) => {
    const { sim } = loadScenarioSim({
      simStart: '2026-01-01', simEnd: '2027-01-01', stepTo: '2027-01-01',
      mutateCfg: (cfg) => {
        (cfg.accounts ?? []).find(a => a.role === ACCOUNT_ROLES.AU_STOCK).reinvestDividends = reinvest;
      },
    });
    return sumAmount(sim, 'AU_DIVIDEND_FRANKED_NONRESIDENT_TAX');
  };
  assert.equal(firstYear(false), firstYear(true),
    'the same dividend is assessed the same, wherever the cash lands');
});

test('DRIP-6d: the cash lands in the AU pool, and the brokerage keeps its lots', () => {
  const arm = (reinvest) => loadScenarioSim({
    simStart: '2026-01-01', simEnd: '2027-01-01', stepTo: '2027-01-01',
    mutateCfg: (cfg) => {
      (cfg.accounts ?? []).find(a => a.role === ACCOUNT_ROLES.AU_STOCK).reinvestDividends = reinvest;
    },
  }).sim.state;

  const cash = arm(false), drip = arm(true);
  assert.ok(cash.auSavingsAccount.balance > drip.auSavingsAccount.balance,
    'the cash arm banks the dividend');
  assert.ok(drip.auStockAccount.balance > cash.auStockAccount.balance,
    'and the reinvest arm keeps it in the brokerage');
});

// ── DRIP-4: serialization is deviation-only ─────────────────────────────────

test('DRIP-4: the election round-trips, and an unelected account writes no key', () => {
  const plain = ScenarioSerializer._serializeAccount(new BrokerageAccount(1000, {}));
  assert.ok(!('reinvestDividends' in plain), 'no opinion ⇒ absent, so saved scenarios are byte-identical');
  assert.equal(ScenarioSerializer._makeAccount({ ...plain, __type: 'BrokerageAccount' }).reinvestDividends, null,
    'and an account saved before the field existed loads as "no opinion"');

  for (const elected of [true, false]) {
    const d = ScenarioSerializer._serializeAccount(new BrokerageAccount(1000, { reinvestDividends: elected }));
    assert.equal(d.reinvestDividends, elected, `${elected} is emitted`);
    // `false` is an election ("this broker pays me the cash"), not an absent one — a
    // truthiness gate on either side of the round trip would silently drop it.
    const back = ScenarioSerializer._makeAccount({ ...d, __type: 'BrokerageAccount' });
    assert.equal(back.reinvestDividends, elected, `${elected} survives the round trip`);
  }
});

// ── DRIP-5: the generated param exists only where the election is live ──────

test('DRIP-5: a `reinvestDividends` param is generated for the broker roles and no others', () => {
  const cfg = {
    accounts: [
      { stateKey: 'usStockAccount',  name: 'US Brokerage', type: 'brokerage', role: ACCOUNT_ROLES.US_STOCK },
      { stateKey: 'auStockAccount',  name: 'AU Brokerage', type: 'brokerage', role: ACCOUNT_ROLES.AU_STOCK },
      { stateKey: 'fixedIncomeAccount', name: 'Fixed Income', type: 'brokerage', role: ACCOUNT_ROLES.FIXED_INCOME },
      { stateKey: 'iraAccount',      name: 'IRA', type: 'ira', role: ACCOUNT_ROLES.IRA },
    ],
  };
  const keys = ScenarioParamGenerator.generate(cfg)
    .filter(p => p.key.endsWith('.reinvestDividends'))
    .map(p => p.key);

  // us-stock since phase 1; au-stock since phase 1b built the franked cash branch.
  // fixed-income and the wrappers are absent: a param that routes nothing is worse than
  // no param, because it reads as a lever and sweeps as one.
  assert.deepEqual(keys.sort(), [
    'acct.auStockAccount.reinvestDividends',
    'acct.usStockAccount.reinvestDividends',
  ]);

  const entry = ScenarioParamGenerator.generate(cfg).find(p => p.key === keys[0]);
  assert.equal(entry.type, 'Boolean');
  assert.equal(entry.opt, true,  'a household choice — sweepable');
  assert.equal(entry.mc,  false, 'nothing about it is uncertain');
  assert.equal(entry.defaultValue, undefined,
    'seeded from the record, which has no election');
});

test('DRIP-5b: the wrappers are deliberately absent from the election roles', () => {
  for (const role of [ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.ROTH, ACCOUNT_ROLES.K401, ACCOUNT_ROLES.SUPER]) {
    assert.ok(!DIVIDEND_ELECTION_ROLES.has(role),
      `${role} never separates a dividend from its price return — there is no branch to elect`);
  }
});
