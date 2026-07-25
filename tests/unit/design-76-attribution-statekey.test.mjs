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
 * design-76-attribution-statekey.test.mjs
 *
 * Design 76 Phase 1 (Gap C): AU income must be attributed to the account that
 * actually produced it, resolved from the action's `stateKey`, not from a
 * hardcoded canonical state key.
 *
 * Why these tests use explicit `owners[]` arrays rather than `ownershipType: 'sole'`:
 * Gap A (`ownershipType` dropped by `_accountToStatePlain` on the way into runtime
 * state) is still open at P1, so the `sole` branch of `ownershipFractions` cannot
 * fire end-to-end yet. `owners[]` is the FIRST resolution branch and works today,
 * which lets P1's plumbing be proven now and keeps these tests as the regression
 * guard for when Gap A lands in P2.
 *
 * Fixtures are deliberately LOPSIDED (100/0 ownership). Two people with equal
 * shares cannot distinguish correct attribution from the even-split fallback —
 * which is exactly how this class of bug survived for so long.
 *
 * Run with: node --test tests/unit/design-76-attribution-statekey.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AuTaxModule2026 } from '../../src/finance/tax/au/au-tax-module-2026.js';
import { resolveAttributionAsset } from '../../src/finance/ownership-utils.js';

const PEOPLE = {
  primary: { id: 'primary', name: 'Terry' },
  spouse:  { id: 'spouse',  name: 'Jeanne' },
};

/** An account owned 100% by one person, via the `owners[]` branch. */
const ownedBy = personId => ({ owners: [{ personId, ownershipPct: 100 }] });

/**
 * Minimal AU-tax state: two accounts per role, each solely owned by a different
 * person, plus the empty per-person maps and the scalars the reducers read.
 */
function makeState() {
  return {
    people: PEOPLE,
    // Canonical keys → Terry; the "spouse*" siblings → Jeanne.
    auSavingsAccount:       ownedBy('primary'),
    spouseAuSavingsAccount: ownedBy('spouse'),
    superAccount:           ownedBy('primary'),
    spouseSuperAccount:     ownedBy('spouse'),
    auStockAccount:         ownedBy('primary'),
    spouseAuStockAccount:   ownedBy('spouse'),

    auPersonOrdinaryIncomeYTD:           {},
    auPersonSuperTaxYTD:                 {},
    auPersonFrankingCreditYTD:           {},
    auPersonCapitalGainsYTD:             {},
    auPersonDiscountableGainsYTD:        {},
    auPersonNrWithholdingInterestYTD:    {},

    auOrdinaryIncomeYTD: 0,
    usOrdinaryIncomeYTD: 0,
    usCapitalGainsYTD:   0,
    auSuperTaxYTD:       0,
    auFrankingCreditYTD: 0,
    baseExchangeRates: { AUD_USD: 0.65, USD_AUD: 1 / 0.65 },
  };
}

const FNS = new AuTaxModule2026().getReducerFns();
const run = (type, action, state = makeState()) => FNS.get(type)(state, action);

/** Round map values so float noise doesn't obscure the assertion. */
const rounded = map => Object.fromEntries(
  Object.entries(map).filter(([, v]) => Math.abs(v) > 1e-9).map(([k, v]) => [k, Math.round(v * 100) / 100]));

describe('design 76 P1 — resolveAttributionAsset', () => {
  test('a stamped stateKey wins over the canonical key', () => {
    const state = makeState();
    assert.equal(
      resolveAttributionAsset(state, { stateKey: 'spouseSuperAccount' }, 'superAccount'),
      state.spouseSuperAccount);
  });

  test('no stamped key falls back to the canonical account (legacy dispatchers)', () => {
    const state = makeState();
    assert.equal(resolveAttributionAsset(state, {}, 'superAccount'), state.superAccount);
    assert.equal(resolveAttributionAsset(state, undefined, 'superAccount'), state.superAccount);
  });

  test('a stamped key that no longer resolves falls back rather than returning undefined', () => {
    // The absent-but-non-null trap: an account deleted or re-flagged mid-run leaves
    // a stamped key pointing at nothing. Must not crash the attribution path.
    const state = makeState();
    assert.equal(
      resolveAttributionAsset(state, { stateKey: 'deletedAccount' }, 'superAccount'),
      state.superAccount);
  });

  test('neither key resolvable ⇒ null, never undefined', () => {
    assert.equal(resolveAttributionAsset({}, { stateKey: 'nope' }, 'alsoNope'), null);
  });
});

describe('design 76 P1 — super tax follows the member, not the household', () => {
  test('SUPER_EARNINGS_TAX attributes to the stamped account owner', () => {
    const next = run('SUPER_EARNINGS_TAX',
      { amount: 10000, stateKey: 'spouseSuperAccount', taxRate: 0.15 });
    // 100% to Jeanne — not 50/50, and not 100% to Terry via the canonical key.
    assert.deepEqual(rounded(next.auPersonSuperTaxYTD), { spouse: 1500 });
  });

  test('SUPER_CONTRIBUTION_TAX attributes to the stamped account owner', () => {
    const next = run('SUPER_CONTRIBUTION_TAX',
      { amount: 10000, stateKey: 'spouseSuperAccount' });
    assert.deepEqual(rounded(next.auPersonSuperTaxYTD), { spouse: 1500 });
  });

  test('two members are taxed on their OWN balances, not an even split', () => {
    // The reported symptom: $48k and $321k of super produced identical tax.
    let state = makeState();
    state = run('SUPER_EARNINGS_TAX', { amount: 4800,  stateKey: 'superAccount',       taxRate: 0.15 }, state);
    state = run('SUPER_EARNINGS_TAX', { amount: 32100, stateKey: 'spouseSuperAccount', taxRate: 0.15 }, state);
    assert.deepEqual(rounded(state.auPersonSuperTaxYTD), { primary: 720, spouse: 4815 });
  });

  test('an unstamped action still lands on the canonical account (back-compat)', () => {
    const next = run('SUPER_CONTRIBUTION_TAX', { amount: 10000 });
    assert.deepEqual(rounded(next.auPersonSuperTaxYTD), { primary: 1500 });
  });
});

describe('design 76 P1 — AU savings interest follows the account', () => {
  test('resident interest attributes to the stamped account owner', () => {
    const next = run('AU_SAVINGS_EARNINGS_TAX',
      { amount: 5000, residency: 'AU', stateKey: 'spouseAuSavingsAccount' });
    assert.deepEqual(rounded(next.auPersonOrdinaryIncomeYTD), { spouse: 5000 });
  });

  test('non-resident withholding attributes to the stamped account owner', () => {
    const next = run('AU_SAVINGS_EARNINGS_TAX',
      { amount: 5000, residency: 'US', stateKey: 'spouseAuSavingsAccount' });
    assert.deepEqual(rounded(next.auPersonNrWithholdingInterestYTD), { spouse: 5000 });
  });

  test('two savings accounts split by balance, not by headcount', () => {
    // Terry $50k @ 4% and Jeanne $119k @ 4% — the reference scenario's shape.
    let state = makeState();
    state = run('AU_SAVINGS_EARNINGS_TAX', { amount: 2000, residency: 'AU', stateKey: 'auSavingsAccount'       }, state);
    state = run('AU_SAVINGS_EARNINGS_TAX', { amount: 4760, residency: 'AU', stateKey: 'spouseAuSavingsAccount' }, state);
    assert.deepEqual(rounded(state.auPersonOrdinaryIncomeYTD), { primary: 2000, spouse: 4760 });
  });
});

describe('design 76 P1 — AU brokerage income follows the account', () => {
  test('franked dividend credit attributes to the stamped account owner', () => {
    const next = run('AU_DIVIDEND_FRANKED_RESIDENT_TAX',
      { amount: 3000, stateKey: 'spouseAuStockAccount' });
    assert.deepEqual(rounded(next.auPersonFrankingCreditYTD), { spouse: 3000 });
  });

  test('unfranked dividend attributes to the stamped account owner', () => {
    const next = run('AU_DIVIDEND_UNFRANKED_RESIDENT_TAX',
      { amount: 3000, stateKey: 'spouseAuStockAccount' });
    assert.deepEqual(rounded(next.auPersonOrdinaryIncomeYTD), { spouse: 3000 });
  });

  test('capital gain and its discountable slice attribute to the same owner', () => {
    const next = run('AU_STOCK_WITHDRAWAL_TAX', {
      gain: 20000, auGain: 20000, auDiscountableGain: 12000,
      residency: 'AU', stateKey: 'spouseAuStockAccount',
    });
    assert.deepEqual(rounded(next.auPersonCapitalGainsYTD),      { spouse: 20000 });
    assert.deepEqual(rounded(next.auPersonDiscountableGainsYTD), { spouse: 12000 });
  });
});

describe('design 76 P1 — jointly held assets still split by ownership share', () => {
  test('a 50/50 joint account splits evenly — by SHARE, not by headcount', () => {
    const state = makeState();
    state.jointSavingsAccount = {
      owners: [
        { personId: 'primary', ownershipPct: 50 },
        { personId: 'spouse',  ownershipPct: 50 },
      ],
    };
    const next = run('AU_SAVINGS_EARNINGS_TAX',
      { amount: 4000, residency: 'AU', stateKey: 'jointSavingsAccount' }, state);
    assert.deepEqual(rounded(next.auPersonOrdinaryIncomeYTD), { primary: 2000, spouse: 2000 });
  });

  test('an unequal tenants-in-common split follows the percentages', () => {
    const state = makeState();
    state.tenantsInCommonAccount = {
      owners: [
        { personId: 'primary', ownershipPct: 75 },
        { personId: 'spouse',  ownershipPct: 25 },
      ],
    };
    const next = run('AU_SAVINGS_EARNINGS_TAX',
      { amount: 4000, residency: 'AU', stateKey: 'tenantsInCommonAccount' }, state);
    assert.deepEqual(rounded(next.auPersonOrdinaryIncomeYTD), { primary: 3000, spouse: 1000 });
  });
});
