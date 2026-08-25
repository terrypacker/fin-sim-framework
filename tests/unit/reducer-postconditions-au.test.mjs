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
 * Group C — AU reducers (savings / super / brokerage / income / real property).
 * Design 37 §6 / §8.3.
 *
 *  - Contribution / withdrawal (savings, super): cash-pool transaction() on both
 *      sides → I3 (both), I5 (fee 0). Service-backed (no I1, §7.3).
 *  - AU stock withdrawal (sale): FIFO-consume holdings, credit AU cash → I3/I5.
 *  - AU dividends (franked/unfranked × resident/NR) + earnings: scalar balance/basis;
 *      §4.4 is event-level (handler emits computeHoldingsDividends/Growth actions —
 *      earnings-holdings-sync.test.mjs). Here: scalar contract + I1.
 *  - AU SE income / house sale: exogenous credit to AU cash pool → I3 on cash.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertBalanceInvariant, assertNonNegative, assertConserved } from '../helpers/reducer-postconditions.js';
import { makeAccount, makeServices } from '../helpers/reducer-fixtures.js';

import {
  AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer, AuSavingsEarningsApplyReducer,
} from '../../src/finance/account-rules/au/au-savings-classes.js';
import {
  SuperContributionApplyReducer, SuperSacrificeApplyReducer,
  SuperNonConcessionalApplyReducer, AuSuperCapsAccumulateReducer,
  SuperWithdrawalContribApplyReducer,
  SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer,
} from '../../src/finance/account-rules/au/au-super-classes.js';
import {
  AuDividendFrankedResidentApplyReducer, AuDividendFrankedNonResidentApplyReducer,
  AuDividendUnfrankedResidentApplyReducer, AuDividendUnfrankedNonResidentApplyReducer,
  AuStockEarningsApplyReducer, AuStockWithdrawalApplyReducer,
} from '../../src/finance/account-rules/au/au-brokerage-classes.js';
import { AuSeIncomeApplyReducer, AuWagesIncomeApplyReducer } from '../../src/finance/account-rules/au/au-income-classes.js';
import { AuHouseSaleApplyReducer } from '../../src/finance/account-rules/au/au-real-property-classes.js';

const DATE = new Date('2030-06-15');

function acct(stateKey, balance, currency = 'AUD', extra = {}) {
  return { ...makeAccount({ stateKey, currency, holdings: [{ id: `${stateKey}-h`, marketValue: balance, costBasis: balance }] }), ...extra };
}
function runAcct(reducer, state, action, { conserve, fee = 0 } = {}) {
  const prev = structuredClone(state);
  const next = reducer.reduce(state, action, DATE);
  assertBalanceInvariant(next);
  assertNonNegative(next);
  if (conserve) assertConserved(prev, next, conserve[0], conserve[1], { fee });
  return { prev, next };
}

// ─── AU savings ───────────────────────────────────────────────────────────────

test('AuSavingsContribution: checking → auSavings, synced + conserved (I3/I5)', () => {
  const state = { checkingAccount: acct('checkingAccount', 20000), auSavingsAccount: acct('auSavingsAccount', 30000) };
  const { next } = runAcct(new AuSavingsContributionApplyReducer(makeServices()), state,
    { type: 'AU_SAVINGS_CONTRIBUTION_APPLY', amount: 5000 }, { conserve: ['checkingAccount', 'auSavingsAccount'], fee: 0 });
  assert.equal(next.checkingAccount.balance, 15000);
  assert.equal(next.auSavingsAccount.balance, 35000);
});

test('AuSavingsWithdrawal: auSavings → checking, synced + conserved (I3/I5)', () => {
  const state = { checkingAccount: acct('checkingAccount', 5000), auSavingsAccount: acct('auSavingsAccount', 30000) };
  const { next } = runAcct(new AuSavingsWithdrawalApplyReducer(makeServices()), state,
    { type: 'AU_SAVINGS_WITHDRAWAL_APPLY', amount: 5000 }, { conserve: ['auSavingsAccount', 'checkingAccount'], fee: 0 });
  assert.equal(next.auSavingsAccount.balance, 25000);
  assert.equal(next.checkingAccount.balance, 10000);
});

test('AuSavingsEarnings: scalar balance increment, input not mutated (I1)', () => {
  const state = { auSavingsAccount: acct('auSavingsAccount', 30000) };
  const next = new AuSavingsEarningsApplyReducer({}).reduce(state, { type: 'AU_SAVINGS_EARNINGS_APPLY', amount: 120, residency: 'AU' });
  assert.equal(next.auSavingsAccount.balance, 30120);
  assert.equal(state.auSavingsAccount.balance, 30000, 'I1');
});

// ─── AU super ─────────────────────────────────────────────────────────────────

test('SuperContribution: auCash → super (+basis), synced + conserved net of fund tax (I3/I5)', () => {
  const state = { auSavingsAccount: acct('auSavingsAccount', 20000), superAccount: acct('superAccount', 50000, 'AUD', { contributionBasis: 50000, earningsBasis: 0 }) };
  // Design 77 §5.2 — 6,000 leaves AU cash, the fund takes 900 (15%) of Div 295
  // contributions tax on receipt, and 5,100 lands in the member's balance. `fee` is
  // the helper's channel for exactly this: intended, declared leakage rather than a
  // silent conservation break.
  const { next } = runAcct(new SuperContributionApplyReducer(makeServices()), state,
    { type: 'SUPER_CONTRIBUTION_APPLY', amount: 6000 }, { conserve: ['auSavingsAccount', 'superAccount'], fee: 900 });
  assert.equal(next.superAccount.balance, 55100);
  // Basis takes the same net figure, so balance === contributionBasis + earningsBasis
  // survives the withholding.
  assert.equal(next.superAccount.contributionBasis, 55100);
});

/**
 * Design 95 §9.1 phase 6b — the three member streams differ on exactly two axes, and
 * these two tests pin both. Salary sacrifice: no cash debit, 15% to the fund.
 * Non-concessional: cash debit, and NOTHING to the fund.
 *
 * They are written against the same opening state and the same \$6,000 so the pair
 * reads as a contrast rather than as two unrelated assertions — the whole difference
 * between the streams is visible in the two `fee` arguments and the two closing
 * balances.
 */
test('SuperSacrifice: no cash debit, fund still takes Div 295 (I3/I5)', () => {
  const state = { auSavingsAccount: acct('auSavingsAccount', 20000), superAccount: acct('superAccount', 50000, 'AUD', { contributionBasis: 50000, earningsBasis: 0 }) };
  const { next } = runAcct(new SuperSacrificeApplyReducer(makeServices()), state,
    { type: 'SUPER_SACRIFICE_APPLY', amount: 6000, personKey: 'primary' },
    { conserve: ['auSavingsAccount', 'superAccount'], fee: -5100 });
  // The wage was reduced at source by PayrollHandler, so no AU cash moves here.
  // Debiting would take the sacrifice twice: once by never being paid it, once again
  // on the way into the fund.
  assert.equal(next.auSavingsAccount.balance, 20000, 'sacrifice never touches the member\'s cash');
  assert.equal(next.superAccount.balance, 55100, 'Div 295 still applies: 6,000 less 900');
  assert.equal(next.superAccount.contributionBasis, 55100);
});

test('SuperNonConcessional: cash debit, and the fund takes nothing (I3/I5)', () => {
  const state = { auSavingsAccount: acct('auSavingsAccount', 20000), superAccount: acct('superAccount', 50000, 'AUD', { contributionBasis: 50000, earningsBasis: 0 }) };
  const { next } = runAcct(new SuperNonConcessionalApplyReducer(makeServices()), state,
    { type: 'SUPER_NON_CONCESSIONAL_APPLY', amount: 6000, personKey: 'primary' },
    { conserve: ['auSavingsAccount', 'superAccount'], fee: 0 });
  assert.equal(next.auSavingsAccount.balance, 14000);
  // IN FULL — no 15% shave. Money already taxed at the member's marginal rate is not
  // taxed again on the way in, which is the single fact that stops this riding on
  // SuperContributionApplyReducer.
  assert.equal(next.superAccount.balance, 56000);
  assert.equal(next.superAccount.contributionBasis, 56000);
});

/**
 * Design 95 phase 7 — the caps accumulator. It moves no money, so the postcondition
 * that matters is a different one: every stream that consumes a cap must reach the
 * right running total, and a contribution that cannot say whose it is must reach
 * none of them.
 */
test('AuSuperCapsAccumulate: each stream feeds the total it consumes (I1)', () => {
  const r = new AuSuperCapsAccumulateReducer();
  const key = 'primary';
  let state = { auSuperCapsByPerson: { [key]: {} } };

  const feed = [
    { type: 'SUPER_CONTRIBUTION_APPLY',     amount: 1_200, personKey: key, employerFunded: true },
    { type: 'SUPER_SACRIFICE_APPLY',        amount:   500, personKey: key },
    { type: 'SUPER_CONTRIBUTION_APPLY',     amount:   400, personKey: key, deductible: true },
    { type: 'SUPER_NON_CONCESSIONAL_APPLY', amount: 1_000, personKey: key },
    { type: 'AU_QUALIFYING_EARNINGS_APPLY', amount: 10_000, personKey: key },
  ];
  for (const a of feed) state = r.reduce(state, a);
  const rec = state.auSuperCapsByPerson[key];

  // All three concessional streams share ONE pool — that is what Div 291 rations.
  assert.equal(rec.concessionalYTD, 2_100, 'SG + sacrifice + deductible');
  // …and the SG also has its own, because `superGuaranteeAnnualCap` is a cap on the
  // EMPLOYER's contribution and must not be eaten by the member's own streams.
  assert.equal(rec.sgYTD, 1_200);
  assert.equal(rec.nonConcessionalYTD, 1_000, 'a separate pool, Div 292\'s');
  assert.equal(rec.qualifyingEarningsYTD, 10_000);
});

test('AuSuperCapsAccumulate: a contribution with no personKey is ignored, not guessed', () => {
  // The standalone SuperContributionHandler (EVT-20, hand-authored) emits one. The
  // caps are per-INDIVIDUAL, so attributing it to somebody would ration one member's
  // cap against another's money.
  const r = new AuSuperCapsAccumulateReducer();
  const state = { auSuperCapsByPerson: { primary: { concessionalYTD: 5_000 } } };
  const next = r.reduce(state, { type: 'SUPER_CONTRIBUTION_APPLY', amount: 9_999 });
  assert.equal(next.auSuperCapsByPerson.primary.concessionalYTD, 5_000, 'untouched');
});

for (const [label, Reducer, type] of [
  ['SuperWithdrawalContrib', SuperWithdrawalContribApplyReducer, 'SUPER_WITHDRAWAL_CONTRIB_APPLY'],
  ['SuperWithdrawalEarnings', SuperWithdrawalEarningsApplyReducer, 'SUPER_WITHDRAWAL_EARNINGS_APPLY'],
]) {
  test(`${label}: credits auCash, debits super, synced + conserved (I3/I5)`, () => {
    const state = { auSavingsAccount: acct('auSavingsAccount', 5000), superAccount: acct('superAccount', 50000, 'AUD', { contributionBasis: 30000, earningsBasis: 20000 }) };
    const { next } = runAcct(new Reducer(makeServices()), state, { type, amount: 8000, blocked: false },
      { conserve: ['superAccount', 'auSavingsAccount'], fee: 0 });
    assert.equal(next.superAccount.balance, 42000);
    assert.equal(next.auSavingsAccount.balance, 13000);
  });

  test(`${label}: blocked withdrawal moves no money (only sets flag)`, () => {
    const state = { auSavingsAccount: acct('auSavingsAccount', 5000), superAccount: acct('superAccount', 50000, 'AUD', { contributionBasis: 30000, earningsBasis: 20000 }) };
    const { next } = runAcct(new Reducer(makeServices()), state, { type, amount: 8000, blocked: true });
    assert.equal(next.superAccount.balance, 50000);
    assert.equal(next.auSavingsAccount.balance, 5000);
    assert.equal(next.superWithdrawalBlocked, true);
  });
}

test('SuperEarnings: scalar balance + earningsBasis, input not mutated (I1)', () => {
  const state = { superAccount: acct('superAccount', 50000, 'AUD', { earningsBasis: 0 }) };
  const next = new SuperEarningsApplyReducer({}).reduce(state, { type: 'SUPER_EARNINGS_APPLY', amount: 3000, stateKey: 'superAccount', taxRate: 0.15 });
  assert.equal(next.superAccount.balance, 53000);
  assert.equal(next.superAccount.earningsBasis, 3000);
  assert.equal(state.superAccount.balance, 50000, 'I1');
});

// ─── AU brokerage ─────────────────────────────────────────────────────────────

for (const [label, Reducer, type] of [
  ['AuDividendFrankedResident', AuDividendFrankedResidentApplyReducer, 'AU_DIVIDEND_FRANKED_RESIDENT_APPLY'],
  ['AuDividendFrankedNonResident', AuDividendFrankedNonResidentApplyReducer, 'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY'],
  ['AuDividendUnfrankedResident', AuDividendUnfrankedResidentApplyReducer, 'AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY'],
  ['AuDividendUnfrankedNonResident', AuDividendUnfrankedNonResidentApplyReducer, 'AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY'],
]) {
  test(`${label}: scalar balance increment, input not mutated (I1; §4.4 event-level)`, () => {
    const state = { auStockAccount: acct('auStockAccount', 40000, 'AUD') };
    const next = new Reducer({}).reduce(state, { type, amount: 700 });
    // Brokerage basis is no longer tracked (design 53 P1).
    assert.equal(next.auStockAccount.balance, 40700);
    assert.equal(state.auStockAccount.balance, 40000, 'I1');
  });

  // The seed account above has no contribution/earnings ledger — correctly, since a
  // brokerage carries basis per-lot on Holding.costBasis (design 53 §2), and
  // ScenarioLoader skips brokerage roles when deriving that ledger. A reducer that
  // nonetheless does `sa.contributionBasis + amount` therefore writes NaN, which is
  // sticky (nothing recomputes it) and survives a save, because ScenarioSerializer's
  // `?? 0` guard only catches null/undefined. EVT-27 did exactly this and the
  // balance-only assertion above could not see it — the reference scenario carried
  // NaN in auStockAccount for 24 years.
  test(`${label}: writes no non-finite field onto a brokerage with no basis ledger`, () => {
    const state = { auStockAccount: acct('auStockAccount', 40000, 'AUD') };
    const next = new Reducer({}).reduce(state, { type, amount: 700 });
    const bad = Object.entries(next.auStockAccount)
      .filter(([, v]) => typeof v === 'number' && !Number.isFinite(v))
      .map(([k, v]) => `${k}=${v}`);
    assert.deepEqual(bad, [], `non-finite field(s) written: ${bad.join(', ')}`);
  });
}

test('AuStockEarnings: scalar balance increment, input not mutated (I1)', () => {
  const state = { auStockAccount: acct('auStockAccount', 40000, 'AUD') };
  const next = new AuStockEarningsApplyReducer({}).reduce(state, { type: 'AU_STOCK_EARNINGS_APPLY', amount: 3500 });
  assert.equal(next.auStockAccount.balance, 43500);
  assert.equal(state.auStockAccount.balance, 40000, 'I1');
});

test('AuStockWithdrawal: FIFO-consume holdings, credit AU cash by salePrice, synced + conserved (I3/I5)', () => {
  const state = {
    auSavingsAccount: acct('auSavingsAccount', 5000),
    auStockAccount: acct('auStockAccount', 50000, 'AUD', { contributionBasis: 30000, earningsBasis: 20000 }),
  };
  const { next } = runAcct(new AuStockWithdrawalApplyReducer(makeServices()), state,
    { type: 'AU_STOCK_WITHDRAWAL_APPLY', salePrice: 10000, residency: 'AU' },
    { conserve: ['auStockAccount', 'auSavingsAccount'], fee: 0 });
  assert.equal(next.auStockAccount.balance, 40000);
  assert.equal(next.auSavingsAccount.balance, 15000);
});

// ─── F3 residue: the AU event path's disposal clock ───────────────────────────
//
// The mirror of the US sibling in reducer-postconditions-us-brokerage.test.mjs. This
// reducer took `asOfMs` from `currentPeriods.AU.startMs`, so an AU disposal in January
// had its Division 115 ≥12-month gate and its §1222 long/short split measured to the
// preceding 1 July — the whole first half of the financial year discarded. Written out
// rather than left to the US test's symmetry: the two are one-line siblings, and this
// codebase has been bitten before by an emitter that looked identical and was not
// (design/inconsistencies §4.11).

test('F3: the AU event-path 12-month test ends at the sale, not at the AU period start', () => {
  const state = {
    auSavingsAccount: acct('auSavingsAccount', 5_000),
    auStockAccount:   makeAccount({ stateKey: 'auStockAccount', currency: 'AUD',
      holdings: [{ id: 'lot-1', marketValue: 150_000, costBasis: 100_000,
                   purchaseDate: new Date(Date.UTC(2030, 8, 1)) }] }),   // bought 1 Sep 2030
    currentPeriods: { US: { startMs: Date.UTC(2032, 0, 1) }, AU: { startMs: Date.UTC(2031, 6, 1) } },
  };
  const next = new AuStockWithdrawalApplyReducer(makeServices()).reduce(state,
    { type: 'AU_STOCK_WITHDRAWAL_APPLY', salePrice: 30_000, residency: 'AU' },
    new Date(Date.UTC(2032, 0, 1)));                                     // sold 1 Jan 2032

  const tax = (next.next ?? []).find(a => a.type === 'AU_STOCK_WITHDRAWAL_TAX');
  assert.ok(tax, 'the sale emits an AU_STOCK_WITHDRAWAL_TAX');
  // 30,000 of a 150,000 lot ⇒ basis share 100,000 × 1/5 = 20,000, gain 10,000.
  assert.equal(tax.auGain, 10_000);
  assert.equal(tax.auDiscountableGain, 10_000, 'sixteen months qualifies under Division 115');
  assert.equal(tax.usLongTermGain, 10_000, 'and is long-term under §1222(3)');
});

test('F3 control: an AU lot genuinely inside twelve months stays short-term', () => {
  const state = {
    auSavingsAccount: acct('auSavingsAccount', 5_000),
    auStockAccount:   makeAccount({ stateKey: 'auStockAccount', currency: 'AUD',
      holdings: [{ id: 'lot-1', marketValue: 150_000, costBasis: 100_000,
                   purchaseDate: new Date(Date.UTC(2031, 8, 1)) }] }),   // bought 1 Sep 2031
    currentPeriods: { US: { startMs: Date.UTC(2032, 0, 1) }, AU: { startMs: Date.UTC(2031, 6, 1) } },
  };
  const next = new AuStockWithdrawalApplyReducer(makeServices()).reduce(state,
    { type: 'AU_STOCK_WITHDRAWAL_APPLY', salePrice: 30_000, residency: 'AU' },
    new Date(Date.UTC(2032, 0, 1)));

  const tax = (next.next ?? []).find(a => a.type === 'AU_STOCK_WITHDRAWAL_TAX');
  assert.equal(tax.auDiscountableGain, 0, 'four months is short of Division 115');
  assert.equal(tax.usShortTermGain, 10_000, 'and short-term under §1222(1)');
});

// ─── AU income + real property ────────────────────────────────────────────────

test('AuSeIncome: credits AU cash pool, keeps §4.4 on cash (I3)', () => {
  const state = { auSavingsAccount: acct('auSavingsAccount', 10000) };
  const { next } = runAcct(new AuSeIncomeApplyReducer(makeServices()), state, { type: 'SE_INCOME_AU_APPLY', amount: 4000, residency: 'AU' });
  assert.equal(next.auSavingsAccount.balance, 14000);
});

test('AuWagesIncome: credits AU cash pool with native AUD (I3)', () => {
  const state = { auSavingsAccount: acct('auSavingsAccount', 10000) };
  const { next } = runAcct(new AuWagesIncomeApplyReducer(makeServices()), state, { type: 'AU_WAGES_INCOME_APPLY', amount: 2000, residency: 'US', personKey: 'spouse' });
  assert.equal(next.auSavingsAccount.balance, 12000);
});

test('AuHouseSale: credits net proceeds to AU cash, zeroes property (I3)', () => {
  const state = {
    auSavingsAccount: acct('auSavingsAccount', 1000),
    auHouse: { value: 800000, mortgageBalance: 200000 },
  };
  const { next } = runAcct(new AuHouseSaleApplyReducer(makeServices()), state, {
    type: 'AU_HOUSE_SALE_APPLY', salePrice: 900000, costBasis: 500000, mortgageBalance: 200000,
    residency: 'AU', stateKey: 'auHouse', destinationKey: 'auSavingsAccount',
  });
  assert.equal(next.auSavingsAccount.balance, 701000); // 900000 - 200000 mortgage + 1000
  assert.equal(next.auHouse.value, 0);
  assert.equal(next.auHouse.mortgageBalance, 0);
});
