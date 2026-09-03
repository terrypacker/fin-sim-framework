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
 * wash-sale-filing-composition.test.mjs — design 94 §8.1o.
 *
 * §8.1n gave `washPendingLosses` its second writer and tested it as far as the RESOLVER:
 * reducer → `resolveWashSales` → "$80,000 disallowed". That is one link short of the claim
 * the section actually makes, which is about money. Between the resolver and the taxpayer sit
 * three more pieces, each with its own suite and none of them wired to the others by a test:
 *
 *   the classifier   — `STOCK_WITHDRAWAL_TAX` must book the rebalancer's SIGNED loss into
 *                      `usCapitalGainsYTD`, or there is no loss on the return to take back;
 *   the settle       — must schedule the April filing AND snapshot the return's inputs, both
 *                      gated on the same `washPendingLosses` the rebalancer just wrote;
 *   the filing       — must recompute the year with the loss removed and assess the delta.
 *
 * So these tests run the whole chain over one state object and assert on the balance due and
 * the §1212(b) pools. They are the working-detector control for §8.1n: break any link and the
 * assessed delta goes to zero while every existing suite stays green.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { RebalanceToTargetApplyReducer } from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
import { UsTaxModule2026 }        from '../../src/finance/tax/us/us-tax-module-2026.js';
import { UsTaxSettleHandler, UsTaxSettleApplyReducer, PENDING_RETURN_KEY }
  from '../../src/finance/tax/tax-settle-classes.js';
import { UsTaxFileHandler, UsTaxFileApplyReducer } from '../../src/finance/tax/us/tax-file-classes.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { ALLOCATION }    from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS }     from '../../src/finance/economic-regimes/rate-keys.js';

const APPLY  = new RebalanceToTargetApplyReducer();
const US_SEC = 'sec-auto-EQUITY_US';
const AU_SEC = 'sec-auto-EQUITY_AU';
// The rebalance runs 1 January 2033, so the loss belongs to the 2033 return, filed April 2034.
const SALE   = new Date(Date.UTC(2033, 0, 1));
const YEAR   = 2033;

/** A unitised lot. `pricePerUnit` is load-bearing — see §8.1n on `consumeHoldings`. */
const lot = (id, mv, basis, units, securityId = US_SEC, purchase = '2029-01-01') => ({
  id, allocation: ALLOCATION.EQUITY, marketValue: mv, costBasis: basis, units,
  securityId, pricePerUnit: +(mv / units).toFixed(8), rateKey: RATE_KEYS.EQUITY_US,
  costBaseByCountry: null, purchaseDate: new Date(purchase), acquisitionDateByCountry: null,
});

const acct = (stateKey, role, holdings, country = 'US') => ({
  stateKey, role, type: 'brokerage', country, currency: { code: 'USD' },
  balance: +holdings.reduce((s, h) => s + h.marketValue, 0).toFixed(2), holdings,
});

/**
 * The book: a taxable US brokerage holding an equity lot 40% under water, and a wrapper
 * holding the SAME identity group bought the day of the rebalance.
 *
 * `wrapper` chooses the arm: an IRA is Rev. Rul. 2008-5's fact pattern, an AU super fund
 * holding the other market's security is the reference plan's — see §8.1n on why the
 * reference plan measures zero and why that is a property of the plan, not of the rule.
 */
const book = (wrapper = 'ira') => ({
  activeRegimes: [], regimeActions: {},
  people: { p1: { residency: 'US' } },
  usPersonHousehold: true,
  usFilingStatus: 'married-joint',
  currentPeriods: { US: { startMs: Date.UTC(YEAR, 0, 1) }, AU: { startMs: Date.UTC(YEAR, 0, 1) } },
  securities: null,
  washPendingLosses: [],
  usOrdinaryIncomeYTD: 200_000,
  usCapitalGainsYTD: 0,
  usShortTermCapitalGainsYTD: 0,
  brokerage: acct('brokerage', ACCOUNT_ROLES.US_STOCK, [lot('eq', 120_000, 200_000, 1_200)]),
  ...(wrapper === 'ira'
    ? { ira: acct('ira', ACCOUNT_ROLES.IRA, [lot('ira-eq', 200_000, 200_000, 2_000, US_SEC, '2033-01-01')]) }
    : { super: acct('super', ACCOUNT_ROLES.SUPER, [lot('su-eq', 200_000, 200_000, 2_000, AU_SEC, '2033-01-01')], 'AU') }),
});

/** Sell the whole equity sleeve into cash — the taxable leg of a design-61 relocation. */
const rebalanceOut = (state) => APPLY.reduce(state, {
  type: 'REBALANCE_TO_TARGET_APPLY', stateKey: 'brokerage', role: ACCOUNT_ROLES.US_STOCK,
  taxable: true, country: 'US',
  legs: [{ allocation: ALLOCATION.EQUITY, delta: -120_000 },
         { allocation: ALLOCATION.CASH,   delta:  120_000 }],
}, SALE);

const classify = (state, actions) => {
  const fns = new UsTaxModule2026().getReducerFns();
  return actions.reduce((s, a) => (fns.get(a.type) ? fns.get(a.type)(s, a) : s), state);
};

/**
 * Everything from the rebalance up to (but not including) the April filing:
 * sell → classify the chained tax action → 31-December settle → apply. Returns the state the
 * following April sees, with the run's period already advanced past the filed year the way a
 * real run's 1-January advance moves it.
 */
function throughSettle(wrapper) {
  const sold       = rebalanceOut(book(wrapper));
  const rebalanced = classify(sold, sold.next ?? []);
  const scheduled  = [];
  const settle     = new UsTaxSettleHandler().call({
    sim: { schedule: e => scheduled.push(e) }, state: rebalanced,
  });
  const settled = new UsTaxSettleApplyReducer()
    .reduce(rebalanced, settle.find(a => a.type === 'US_TAX_SETTLE_APPLY'));
  return {
    rebalanced, scheduled, settled: {
      ...settled,
      currentPeriods: { ...settled.currentPeriods, US: { startMs: Date.UTC(YEAR + 1, 0, 1) } },
    },
  };
}

const file = (state) => {
  const [action] = new UsTaxFileHandler().call({ state });
  const next     = new UsTaxFileApplyReducer().reduce(state, action);
  return { action, next, chained: next.next ?? [] };
};

describe('reducer → classifier → settle → April filing (§8.1o)', () => {
  test('the rebalancer\'s loss reaches the return, and the filing takes it back as CASH', () => {
    const { rebalanced, scheduled, settled } = throughSettle('ira');

    // 1. the ledger entry §8.1n added, and the loss itself, both exist.
    assert.equal(rebalanced.washPendingLosses.length, 1);
    assert.equal(rebalanced.usCapitalGainsYTD, -80_000,
      'the SIGNED §1222 split must reach the accumulator — `gain` alone is clamped at 0');

    // 2. the settle schedules the amendment and snapshots what the return saw.
    const filing = scheduled.find(e => e.type === 'TAX_FILE_US');
    assert.equal(filing?.date.toISOString().slice(0, 10), `${YEAR + 1}-04-15`);
    assert.equal(settled[PENDING_RETURN_KEY].usCapitalGainsYTD, -80_000);

    // 3. the filing disallows the whole loss and assesses a balance due.
    const { action, next, chained } = file(settled);
    assert.equal(action.taxYear, YEAR);
    assert.equal(action.disallowed, 80_000);
    assert.ok(action.delta > 0, `a destroyed $80,000 loss must raise the bill, got ${action.delta}`);

    // 4. …which is paid. This is the assertion §8.1n's suite could not make.
    assert.deepEqual(chained.map(a => a.type), ['US_TAX_PAYMENT_DEBIT']);
    assert.equal(chained[0].amount, action.delta);

    // 5. and the carryforward the settle banked is gone with it: §1211(b) let $3,000 of the
    //    loss reach ordinary income and §1212(b) carried the other $77,000, and the
    //    disallowance takes back both. The cash delta is the tax on the $3,000 only —
    //    the rest of the money moves as a pool that is no longer there next year.
    assert.equal(settled.usLongTermCapitalLossCarryforward, 77_000);
    assert.equal(next.usLongTermCapitalLossCarryforward, 0);
    assert.ok(action.delta < 3_000, 'only the §1211(b) allowance was deducted, so only it is clawed back');
    assert.equal(next.washSaleLedger[0].filedYear, YEAR);
  });

  test('a year with GAINS pays the full rate on the disallowance', () => {
    // The same wash, in a year the loss was actually absorbing gains: no §1211(b) cap, so
    // the entire $80,000 becomes taxable long-term gain and the delta is real money.
    const { settled } = throughSettle('ira');
    const withGains = {
      ...settled,
      [PENDING_RETURN_KEY]: { ...settled[PENDING_RETURN_KEY], usCapitalGainsYTD: 20_000 },
    };
    const { action } = file(withGains);
    assert.equal(action.disallowed, 80_000);
    assert.ok(action.delta > 8_000 && action.delta < 24_000,
      `$80,000 of restored long-term gain at a 0/15/20% rate, got ${action.delta}`);
  });

  test('CONTROL — the reference plan\'s own shape files with a zero delta and no payment', () => {
    // Cross-market relocation into a super fund: an entry is written, nothing matches it,
    // no tax moves. Pinned so "this plan measures zero" cannot quietly become "the rule
    // does nothing".
    const { rebalanced, settled } = throughSettle('super');
    assert.equal(rebalanced.washPendingLosses.length, 1);

    const { action, next, chained } = file(settled);
    assert.equal(action.disallowed, 0);
    assert.equal(action.delta, 0);
    assert.deepEqual(chained, []);
    assert.ok(!(PENDING_RETURN_KEY in next), 'still filed — or next April re-files this year');
    assert.equal(next.usLongTermCapitalLossCarryforward, 77_000, 'the loss stands');
  });

  test('no wash pending ⇒ no filing is scheduled and no snapshot is taken', () => {
    // The gate both the scheduler and the snapshot read. A plan that realizes no washable
    // loss gains no state key and no extra event — which is what keeps the goldens still.
    const scheduled = [];
    const clean     = { ...book('ira'), washPendingLosses: [] };
    const settle    = new UsTaxSettleHandler().call({ sim: { schedule: e => scheduled.push(e) }, state: clean });
    const settled   = new UsTaxSettleApplyReducer()
      .reduce(clean, settle.find(a => a.type === 'US_TAX_SETTLE_APPLY'));
    assert.deepEqual(scheduled, []);
    assert.ok(!(PENDING_RETURN_KEY in settled));
  });
});
