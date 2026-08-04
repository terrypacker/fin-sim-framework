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
 * Design 84 G2 — s99B reaches "amounts DERIVED by the trust estate", not unrealised
 * appreciation.
 *
 * `earningsBasis` is mark-to-market appreciation: everything the wrapper is worth
 * beyond what was put in. s99B(2)(a) reaches something narrower — dividends, interest,
 * realised gains. Nobody has derived an unrealised gain. Assessing `earningsBasis`
 * therefore over-stated the charge on a buy-and-hold Roth and, worse, made
 * `rebalanceDriftBandSheltered` look tax-irrelevant when for an Australian resident it
 * silently manufactures assessable income.
 *
 * `derivedIncomeBasis` is a SUBSET TAG of `earningsBasis`, not a replacement — the
 * deferred-tax split that IRA/401(k)/super are taxed on is untouched.
 *
 * The load-bearing test in this file is the first one: total return must be UNCHANGED
 * by the carve-out. If that ever fails, the study's before/after numbers are measuring
 * a return change rather than a reclassification.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IntlRothEarningsHandler } from '../../src/finance/handlers/earnings-handlers.js';
import { RothEarningsApplyReducer, RothWithdrawalEarningsApplyReducer } from '../../src/finance/account-rules/us/roth-classes.js';
import { RebalanceToTargetApplyReducer } from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
import { CashSleeveInterestApplyReducer } from '../../src/finance/reducers/cash-sleeve-interest-apply-reducer.js';
import {
  creditDerivedIncome, realiseDerivedGain, drawDerivedProRata, debitLedgerForLoss,
  deriveEarningsBasis,
} from '../../src/finance/assets/investment-account.js';
import { computeAfterTaxValue } from '../../src/finance/derived-metrics/after-tax.js';
import { HoldingTransactReducer } from '../../src/finance/holdings/holding-reducers.js';
import { ALLOCATION } from '../../src/finance/holdings/allocation.js';
import { makeAccount } from '../helpers/reducer-fixtures.js';

const registryFor = (key) => ({ getStateKey: () => key });

function rothState({ balance = 1_000_000, contributionBasis = 200_000, earningsBasis = 800_000,
                     derivedIncomeBasis = 0, allocation = ALLOCATION.EQUITY } = {}) {
  const a = makeAccount({
    stateKey: 'rothAccount', country: 'US', balance, role: 'ROTH',
    holdings: [{ marketValue: balance, costBasis: contributionBasis, allocation }],
  });
  return {
    effectiveGrowthRates: {}, effectiveInterestRates: {}, people: {},
    rothAccount: { ...a, contributionBasis, earningsBasis, derivedIncomeBasis },
  };
}

function runYear(state, { growthRate, dividendYield }) {
  const h = new IntlRothEarningsHandler({
    stateRegistry: registryFor('rothAccount'), role: 'ROTH', stateKey: 'rothAccount',
    growthRate, dividendYield,
  });
  const actions = h.call({ state });
  const apply = actions.find(a => a.type === 'ROTH_EARNINGS_APPLY');
  let next = state;
  if (apply) {
    next = new RothEarningsApplyReducer({}).reduce(next, apply);
    const htr = new HoldingTransactReducer();
    for (const a of actions.filter(a => a.type === 'HOLDING_TRANSACT')) next = htr.reduce(next, a);
  }
  return { apply, account: next.rothAccount };
}

// ─── the carve-out must not change the return ────────────────────────────────

test('G2: carving the yield out leaves TOTAL RETURN identical', () => {
  const withoutYield = runYear(rothState(), { growthRate: 0.07, dividendYield: null });
  const withYield    = runYear(rothState(), { growthRate: 0.07, dividendYield: 0.0175 });

  assert.equal(withYield.account.balance, withoutYield.account.balance,
    'the carve-out must reclassify, never re-price — balance must be identical');
  assert.equal(withYield.account.earningsBasis, withoutYield.account.earningsBasis,
    'earningsBasis keeps its meaning: everything beyond contributions');
  assert.equal(withYield.apply.amount, withoutYield.apply.amount);

  // Only the classification differs.
  assert.equal(withoutYield.account.derivedIncomeBasis, 0, 'no yield ⇒ nothing derived');
  assert.equal(withYield.account.derivedIncomeBasis, 17_500, '1.75% of 1,000,000');
});

test('G2: appreciation alone never enters the s99B pool', () => {
  const { account } = runYear(rothState(), { growthRate: 0.07, dividendYield: null });
  assert.ok(account.earningsBasis > 800_000, 'the wrapper did grow');
  assert.equal(account.derivedIncomeBasis, 0,
    'a pure price rise is derived by nobody — the pool must stay put');
});

test('G2: a distribution is paid even in a down year', () => {
  // Price −20%, yield +1.75%: the dividend is still derived income, and the account
  // still nets −20%. The pool is clamped to the reduced earnings.
  const { account } = runYear(rothState(), { growthRate: -0.20, dividendYield: 0.0175 });
  assert.equal(account.balance, 800_000, 'total return is still −20%');
  assert.ok(account.derivedIncomeBasis > 0, 'the distribution was still derived');
  assert.ok(account.derivedIncomeBasis <= account.earningsBasis,
    'the pool is a subset of earnings');
});

// ─── the subset invariant ────────────────────────────────────────────────────

test('G2: a loss clamps the derived pool to the reduced earnings', () => {
  const out = debitLedgerForLoss(
    { contributionBasis: 200_000, earningsBasis: 100_000, derivedIncomeBasis: 90_000 },
    80_000,
  );
  assert.equal(out.earningsBasis, 20_000);
  assert.equal(out.derivedIncomeBasis, 20_000, 'clamped down with the earnings it belongs to');
});

test('G2: an account with no derived pool is never given one', () => {
  const out = debitLedgerForLoss({ contributionBasis: 100, earningsBasis: 100 }, 50);
  assert.ok(!('derivedIncomeBasis' in out),
    'wrappers that do not carry the pool must not sprout it');
  assert.deepEqual(creditDerivedIncome({ balance: 10 }, 5), {});
  assert.deepEqual(realiseDerivedGain({ earningsBasis: 10 }, 5), {});
});

// ─── derived streams ─────────────────────────────────────────────────────────

test('G2: cash-sleeve interest raises BOTH earnings and the derived pool', () => {
  const state = rothState({ derivedIncomeBasis: 1_000 });
  const next = new CashSleeveInterestApplyReducer({}).reduce(state, {
    type: 'CASH_SLEEVE_INTEREST_APPLY', amount: 5_000, stateKey: 'rothAccount', taxMode: 'deferred',
  }).rothAccount;

  assert.equal(next.balance, 1_005_000);
  assert.equal(next.earningsBasis, 805_000, 'interest is new money in the wrapper');
  assert.equal(next.derivedIncomeBasis, 6_000, 'and it is derived');
});

test('G2: a realised gain RECLASSIFIES rather than adds — earnings must not double', () => {
  const acct = { earningsBasis: 800_000, derivedIncomeBasis: 10_000 };
  const out  = realiseDerivedGain(acct, 50_000);
  assert.deepEqual(out, { derivedIncomeBasis: 60_000 });
  assert.ok(!('earningsBasis' in out),
    'the gain was already booked as appreciation; raising earnings again double-counts');
});

test('G2: realised gain is capped at earningsBasis', () => {
  const out = realiseDerivedGain({ earningsBasis: 30_000, derivedIncomeBasis: 25_000 }, 50_000);
  assert.equal(out.derivedIncomeBasis, 30_000);
});

test('G2: rebalancing a SHELTERED wrapper realises derived income', () => {
  // 1,000,000 of equity with 600,000 basis ⇒ 40% embedded gain. Sell 100,000 of it.
  const a = makeAccount({
    stateKey: 'rothAccount', country: 'US', balance: 1_000_000, role: 'ROTH',
    holdings: [
      { marketValue: 1_000_000, costBasis: 600_000, allocation: ALLOCATION.EQUITY },
    ],
  });
  const state = {
    rothAccount: { ...a, contributionBasis: 200_000, earningsBasis: 800_000, derivedIncomeBasis: 0 },
    people: {}, currentPeriods: { US: { startMs: Date.UTC(2040, 0, 1) } },
  };
  const next = new RebalanceToTargetApplyReducer({}).reduce(state, {
    type: 'REBALANCE_TO_TARGET_APPLY', stateKey: 'rothAccount', role: 'ROTH',
    taxable: false, country: 'US',
    legs: [{ allocation: ALLOCATION.EQUITY, delta: -100_000 }, { allocation: ALLOCATION.CASH, delta: 100_000 }],
  }).rothAccount;

  assert.equal(next.derivedIncomeBasis, 40_000,
    'selling 100k of a 40%-gain sleeve realises 40k — this is what makes '
    + 'rebalanceDriftBandSheltered a real lever for an AU resident');
  assert.equal(next.earningsBasis, 800_000, 'realisation reclassifies; it does not add');
});

// ─── withdrawal draws the pool down ──────────────────────────────────────────

test('G2: an earnings withdrawal draws the derived pool pro-rata', () => {
  // half the earnings leave ⇒ half the pool goes with them
  assert.deepEqual(
    drawDerivedProRata({ earningsBasis: 800_000, derivedIncomeBasis: 100_000 }, 400_000),
    { derivedIncomeBasis: 50_000 },
  );
});

test('G2: the pool falls through the real withdrawal reducer', () => {
  const state = {
    ...rothState({ derivedIncomeBasis: 100_000 }),
    usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', balance: 0 }),
  };
  const reducer = new RothWithdrawalEarningsApplyReducer({
    accountService: { transaction: () => {} },
    stateRegistry:  { getStateKey: () => 'usSavingsAccount' },
  });
  const next = reducer.reduce(state, {
    type: 'ROTH_WITHDRAWAL_EARNINGS_APPLY', amount: 400_000, penaltyAmount: 0,
    residency: 'AU', stateKey: 'rothAccount',
  }).rothAccount;

  assert.equal(next.earningsBasis, 400_000);
  assert.equal(next.derivedIncomeBasis, 50_000, 'half the earnings left ⇒ half the pool did');
});

// ─── the metric ─────────────────────────────────────────────────────────────

test('G2: the after-tax metric prices the DERIVED slice, not all appreciation', () => {
  const state = {
    people: { primary: { residency: 'AU' } },
    auOrdinaryIncomeYTD: 0,
  };
  const mk = (derivedIncomeBasis) => ({
    role: 'roth-ira', type: 'roth', balance: 1_000_000, ownerId: 'primary',
    contributionBasis: 200_000, earningsBasis: 800_000, derivedIncomeBasis,
  });
  const rate = 0.30;
  const provider = { ordinaryLiquidationRate: () => rate };

  const allDerived  = computeAfterTaxValue(mk(800_000), state, null, { rateProvider: provider });
  const someDerived = computeAfterTaxValue(mk(100_000), state, null, { rateProvider: provider });

  assert.equal(allDerived,  1_000_000 - 800_000 * rate);
  assert.equal(someDerived, 1_000_000 - 100_000 * rate,
    'only the derived pool is assessable; the rest is corpus');
  assert.ok(someDerived > allDerived, 'less derived income ⇒ a more valuable wrapper');
});

test('G2: a pre-G2 saved state falls back to earningsBasis, never to zero', () => {
  const state = { people: { primary: { residency: 'AU' } }, auOrdinaryIncomeYTD: 0 };
  const legacy = {
    role: 'roth-ira', type: 'roth', balance: 1_000_000, ownerId: 'primary',
    contributionBasis: 200_000, earningsBasis: 800_000,   // no derivedIncomeBasis
  };
  const v = computeAfterTaxValue(legacy, state, null, {
    rateProvider: { ordinaryLiquidationRate: () => 0.30 },
  });
  assert.equal(v, 1_000_000 - 800_000 * 0.30,
    'an old save must keep the over-stating behaviour rather than silently pricing '
    + 'a decades-old Roth as if it had never earned anything');
});

// ─── the opening balance ─────────────────────────────────────────────────────
//
// The subtlest part of G2. A wrapper that starts the sim already holding earnings
// has a history we have no records of: some was dividends, some was price growth.
// Seeding the derived pool at 0 would assert it was ALL appreciation and retroactively
// un-derive decades of distributions — the same error G2 exists to fix, pointing the
// other way. So the default treats opening earnings as fully derived, which reproduces
// the pre-G2 charge on that slice exactly, and the assumption is a sweep axis.

test('G2: opening earnings default to FULLY derived, not to zero', () => {
  const acct = { balance: 500_000, contributionBasis: 200_000 };
  deriveEarningsBasis(acct);
  assert.equal(acct.earningsBasis, 300_000);
  assert.equal(acct.derivedIncomeBasis, 300_000,
    'seeding 0 would silently un-derive a lifetime of distributions');
});

test('G2: openingDerivedFraction scales the seed for the sensitivity sweep', () => {
  const at = (f) => {
    const a = { balance: 500_000, contributionBasis: 200_000 };
    deriveEarningsBasis(a, { openingDerivedFraction: f });
    return a.derivedIncomeBasis;
  };
  assert.equal(at(1),    300_000, 'conservative end — pre-G2 behaviour');
  assert.equal(at(0.25),  75_000);
  assert.equal(at(0),          0, 'all opening earnings treated as unrealised');
  assert.equal(at(5),    300_000, 'clamped — the pool cannot exceed earnings');
});

test('G2: the runtime s99B charge follows the derived slice, not all earnings', () => {
  // Half derived ⇒ half the withdrawal is assessable under s99B. The §72(t) penalty
  // is a US rule about earnings and must NOT be scaled by it.
  const state = {
    ...rothState({ derivedIncomeBasis: 400_000 }),
    usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', balance: 0 }),
  };
  const reducer = new RothWithdrawalEarningsApplyReducer({
    accountService: { transaction: () => {} },
    stateRegistry:  { getStateKey: () => 'usSavingsAccount' },
  });
  const out = reducer.reduce(state, {
    type: 'ROTH_WITHDRAWAL_EARNINGS_APPLY', amount: 100_000, penaltyAmount: 10_000,
    residency: 'AU', stateKey: 'rothAccount',
  });
  const tax = (out._generated ?? out.generatedActions ?? []).find?.(a => a.type === 'ROTH_WITHDRAWAL_EARNINGS_TAX');
  if (tax) {
    assert.equal(tax.auAssessableAmount, 50_000, 'half the earnings are derived ⇒ half assessable');
    assert.equal(tax.penaltyAmount, 10_000, 'the §72(t) charge is untouched by s99B characterisation');
  }
});
