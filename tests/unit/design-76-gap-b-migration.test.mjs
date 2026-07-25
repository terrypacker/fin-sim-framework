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
 * design-76-gap-b-migration.test.mjs
 *
 * Design 76 Phase 3 (Gaps B and D): every AU-assessable income type reaches a
 * per-person map, and its US-source FITO removal slice is attributed identically.
 *
 * The suite is deliberately structured around the two things that can silently go
 * wrong and that a totals-based test cannot see:
 *
 *   1. Income lands on the household scalar, where computeAuTaxPerPerson divides it
 *      by headcount. Totals stay right; every person's return is wrong.
 *   2. Income is attributed per person but its US-source removal slice is not (or
 *      vice versa). Totals stay right; every FITO limit is sized off a mismatched
 *      base. Measured at +32.8% lifetime tax on the design 52 scenario.
 *
 * Fixtures are LOPSIDED on purpose — two people with equal shares cannot distinguish
 * correct attribution from the even-split fallback.
 *
 * Run with: node --test tests/unit/design-76-gap-b-migration.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { UsTaxModule2026 } from '../../src/finance/tax/us/us-tax-module-2026.js';
import { resolveBonusEarner } from '../../src/finance/account-rules/us/us-income-classes.js';

const PEOPLE = {
  primary: { id: 'primary', name: 'Terry',  residency: 'AU' },
  spouse:  { id: 'spouse',  name: 'Jeanne', residency: 'AU' },
};

const ownedBy = personId => ({ ownershipType: 'sole', ownerId: personId });

function makeState() {
  return {
    people: PEOPLE,
    // Retirement + brokerage accounts, one per person where it matters.
    iraAccount:       ownedBy('primary'),  spouseIraAccount:   ownedBy('spouse'),
    rothAccount:      ownedBy('primary'),  spouseRothAccount:  ownedBy('spouse'),
    k401Account:      ownedBy('primary'),  spouseK401Account:  ownedBy('spouse'),
    usStockAccount:   ownedBy('primary'),  spouseStockAccount: ownedBy('spouse'),
    fixedIncomeAccount: ownedBy('primary'),

    usOrdinaryIncomeYTD: 0, usCapitalGainsYTD: 0, usPenaltyYTD: 0,
    usNetInvestmentIncomeYTD: 0, usCollectibleGainsYTD: 0,
    usSsWagesYTD: 0, usSeEarningsYTD: 0, usNegativeIncomeYTD: 0,
    auOrdinaryIncomeYTD: 0, auCapitalGainsYTD: 0, auDiscountableGainsYTD: 0,
    usSourceOrdinaryUsdYTD: 0, usSourceCapGainsUsdYTD: 0,
    usSourceOrdinaryAudYTD: 0, usSourceCapGainsAudYTD: 0,
    auPersonOrdinaryIncomeYTD: {}, auPersonCapitalGainsYTD: {},
    auPersonDiscountableGainsYTD: {},
    auPersonUsSourceOrdinaryAudYTD: {}, auPersonUsSourceCapGainsAudYTD: {},
    // 1 USD = 1 AUD keeps the arithmetic legible; FX is not what these test.
    baseExchangeRates: { USD_AUD: 1, AUD_USD: 1 },
    effectiveExchangeRates: { USD_AUD: 1, AUD_USD: 1 },
  };
}

const FNS = new UsTaxModule2026().getReducerFns();
const run = (type, action, state = makeState()) => FNS.get(type)(state, action);
const nz  = map => Object.fromEntries(
  Object.entries(map ?? {}).filter(([, v]) => Math.abs(v) > 1e-9).map(([k, v]) => [k, Math.round(v * 100) / 100]));

/** Every AU household scalar this module can write. */
const HOUSEHOLD = ['auOrdinaryIncomeYTD', 'auCapitalGainsYTD', 'auDiscountableGainsYTD',
                   'usSourceOrdinaryAudYTD', 'usSourceCapGainsAudYTD'];

function assertNothingOnHousehold(state, label) {
  for (const f of HOUSEHOLD) {
    assert.strictEqual(state[f] ?? 0, 0,
      `${label}: ${f} must stay 0 — anything here is split by headcount at settle`);
  }
}

// ── Ordinary income, attributed by the account it came from ──────────────────

const ORDINARY_BY_ACCOUNT = [
  ['IRA_WITHDRAWAL_EARNINGS_TAX',          { amount: 10000, penaltyAmount: 0 }, 'spouseIraAccount'],
  ['IRA_RMD_TAX',                          { amount: 10000 },                   'spouseIraAccount'],
  ['IRA_ROLLOVER_WITHDRAWAL_TAX',          { amount: 10000 },                   'spouseIraAccount'],
  ['K401_RMD_TAX',                         { amount: 10000 },                   'spouseK401Account'],
  ['ROTH_WITHDRAWAL_EARNINGS_TAX',         { amount: 10000, penaltyAmount: 0 }, 'spouseRothAccount'],
  ['ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX',{ amount: 10000, penaltyAmount: 0 }, 'spouseRothAccount'],
  ['FIXED_INCOME_EARNINGS_TAX',            { amount: 10000 },                   'fixedIncomeAccount'],
  ['STOCK_DIVIDEND_TAX',                   { amount: 10000 },                   'spouseStockAccount'],
];

describe('design 76 P3 — ordinary income follows the account owner', () => {
  for (const [type, payload, stateKey] of ORDINARY_BY_ACCOUNT) {
    const expectOwner = stateKey.startsWith('spouse') ? 'spouse' : 'primary';
    test(`${type} attributes to ${expectOwner}`, () => {
      const next = run(type, { ...payload, residency: 'AU', stateKey });
      assert.deepEqual(nz(next.auPersonOrdinaryIncomeYTD), { [expectOwner]: 10000 },
        'assessable income must land wholly on the account owner');
      assertNothingOnHousehold(next, type);
    });
  }

  test('an unattributable action still books to the household scalar, not an even split', () => {
    // The fallback must remain visible-but-unattributed so P5 can catch it, rather
    // than quietly producing a plausible 50/50 that looks like a real answer.
    const next = run('IRA_RMD_TAX', { amount: 10000, residency: 'AU', stateKey: 'noSuchAccount' },
      { ...makeState(), iraAccount: undefined });
    assert.deepEqual(nz(next.auPersonOrdinaryIncomeYTD), {});
    assert.strictEqual(next.auOrdinaryIncomeYTD, 10000);
  });
});

// ── Person-derived income ─────────────────────────────────────────────────────

describe('design 76 P3 — person-derived income follows the person', () => {
  test('SS_INCOME_TAX attributes the whole benefit to its recipient', () => {
    // The two people have different entitlements, so an even split is always wrong.
    const next = run('SS_INCOME_TAX', { amount: 24000, residency: 'AU', personKey: 'spouse' });
    assert.deepEqual(nz(next.auPersonOrdinaryIncomeYTD), { spouse: 24000 });
    assertNothingOnHousehold(next, 'SS_INCOME_TAX');
  });

  test('two benefits accrue separately rather than pooling', () => {
    let s = makeState();
    s = run('SS_INCOME_TAX', { amount: 24000, residency: 'AU', personKey: 'primary' }, s);
    s = run('SS_INCOME_TAX', { amount: 12000, residency: 'AU', personKey: 'spouse'  }, s);
    assert.deepEqual(nz(s.auPersonOrdinaryIncomeYTD), { primary: 24000, spouse: 12000 });
  });

  test('WAGES_INCOME_TAX attributes to the earner', () => {
    const next = run('WAGES_INCOME_TAX', { amount: 50000, residency: 'AU', personKey: 'spouse' });
    assert.deepEqual(nz(next.auPersonOrdinaryIncomeYTD), { spouse: 50000 });
  });
});

// ── Capital gains, including the discountable slice ───────────────────────────

describe('design 76 P3 — capital gains and their discountable slice stay together', () => {
  test('STOCK_WITHDRAWAL_TAX attributes gain and discountable slice to the same owner', () => {
    const next = run('STOCK_WITHDRAWAL_TAX', {
      gain: 20000, auGain: 20000, auDiscountableGain: 12000,
      residency: 'AU', stateKey: 'spouseStockAccount',
    });
    assert.deepEqual(nz(next.auPersonCapitalGainsYTD),      { spouse: 20000 });
    assert.deepEqual(nz(next.auPersonDiscountableGainsYTD), { spouse: 12000 });
    assertNothingOnHousehold(next, 'STOCK_WITHDRAWAL_TAX');
  });

  test('COMPANY_SALE_TAX attributes to the equity holder stamped on the action', () => {
    const next = run('COMPANY_SALE_TAX', {
      gain: 500000, auGain: 300000, residency: 'AU',
      ownershipType: 'sole', ownerId: 'spouse',
    });
    assert.deepEqual(nz(next.auPersonCapitalGainsYTD), { spouse: 300000 });
  });

  test('US_HOUSE_SALE_TAX splits by an explicit owners[] breakdown', () => {
    const next = run('US_HOUSE_SALE_TAX', {
      gain: 100000, auGain: 100000, auDiscountableGain: 100000, residency: 'AU',
      owners: [{ personId: 'primary', ownershipPct: 70 }, { personId: 'spouse', ownershipPct: 30 }],
    });
    assert.deepEqual(nz(next.auPersonCapitalGainsYTD), { primary: 70000, spouse: 30000 });
  });

  test('COLLECTIBLE_SALE_TAX attributes to the collectible owner', () => {
    const next = run('COLLECTIBLE_SALE_TAX', {
      gain: 20000, residency: 'AU', ownershipType: 'sole', ownerId: 'spouse',
    });
    assert.deepEqual(nz(next.auPersonCapitalGainsYTD), { spouse: 20000 });
  });
});

// ── Gap D: the removal set must move with the income ──────────────────────────

describe('design 76 P3 — the US-source removal set tracks the income exactly', () => {
  test('ordinary income and its removal slice land on the SAME person', () => {
    const next = run('IRA_RMD_TAX', { amount: 10000, residency: 'AU', stateKey: 'spouseIraAccount' });
    assert.deepEqual(nz(next.auPersonOrdinaryIncomeYTD),      { spouse: 10000 });
    assert.deepEqual(nz(next.auPersonUsSourceOrdinaryAudYTD), { spouse: 10000 },
      'a mismatched removal set sizes the FITO limit off the wrong base (+32.8% measured)');
  });

  test('capital gains and their removal slice land on the SAME person', () => {
    const next = run('STOCK_WITHDRAWAL_TAX', {
      gain: 20000, auGain: 20000, auDiscountableGain: 20000,
      residency: 'AU', stateKey: 'spouseStockAccount',
    });
    assert.deepEqual(nz(next.auPersonCapitalGainsYTD),        { spouse: 20000 });
    assert.deepEqual(nz(next.auPersonUsSourceCapGainsAudYTD), { spouse: 20000 });
  });

  test('BOND_COUPON_TAX books the FULL coupon to AU but only the federal slice as US-source', () => {
    // AU grants no US-Treasury exemption, so it assesses the whole coupon, while the
    // removal set tracks only what the US actually taxed. The two amounts differ and
    // must not be conflated.
    const next = run('BOND_COUPON_TAX', {
      amount: 10000, federalTaxableAmount: 6000, stateTaxableAmount: 0,
      residency: 'AU', stateKey: 'spouseStockAccount',
    });
    assert.deepEqual(nz(next.auPersonOrdinaryIncomeYTD),      { spouse: 10000 });
    assert.deepEqual(nz(next.auPersonUsSourceOrdinaryAudYTD), { spouse: 6000 });
  });

  test('a Roth distribution feeds NO removal set — the US taxed none of it', () => {
    // s99B makes the earnings AU-assessable, but the US levies nothing, so there is
    // no US tax for FITO to relieve and nothing to remove.
    const next = run('ROTH_WITHDRAWAL_EARNINGS_TAX',
      { amount: 10000, penaltyAmount: 0, residency: 'AU', stateKey: 'spouseRothAccount' });
    assert.deepEqual(nz(next.auPersonOrdinaryIncomeYTD),      { spouse: 10000 });
    assert.deepEqual(nz(next.auPersonUsSourceOrdinaryAudYTD), {});
  });
});

// ── Non-residents are untouched ───────────────────────────────────────────────

describe('design 76 P3 — a non-resident books nothing to Australia', () => {
  for (const [type, payload, stateKey] of ORDINARY_BY_ACCOUNT) {
    test(`${type} while US-resident leaves every AU bucket empty`, () => {
      const next = run(type, { ...payload, residency: 'US', stateKey });
      assert.deepEqual(nz(next.auPersonOrdinaryIncomeYTD), {});
      assertNothingOnHousehold(next, type);
    });
  }
});

// ── Bonus attribution (design 76 P5, closing the last unattributed path) ──────

describe('design 76 P5 — a bonus is assessed to the person who earned it', () => {
  const AT = new Date(Date.UTC(2030, 0, 15));
  const people = (primary, spouse) => ({
    people: {
      primary: { id: 'primary', name: 'Terry',  ...primary },
      spouse:  { id: 'spouse',  name: 'Jeanne', ...spouse  },
    },
  });

  test('an explicit data.personId always wins', () => {
    const st = people({ monthlyWage: 20000 }, { monthlyWage: 2000 });
    assert.strictEqual(resolveBonusEarner(st, { personId: 'spouse' }, AT), 'spouse');
  });

  test('the sole person still working gets it', () => {
    // Terry has retired, Jeanne has not — unambiguous, no warning, no guess.
    const st = people(
      { monthlyWage: 20000, retirementDate: new Date(Date.UTC(2027, 0, 1)) },
      { monthlyWage: 2000 });
    assert.strictEqual(resolveBonusEarner(st, {}, AT), 'spouse');
  });

  test('both still working ⇒ the higher earner, deterministically', () => {
    const st = people({ monthlyWage: 20000 }, { monthlyWage: 2000 });
    assert.strictEqual(resolveBonusEarner(st, {}, AT), 'primary');
    // Same inputs, same answer — no coin flip.
    assert.strictEqual(resolveBonusEarner(st, {}, AT), 'primary');
  });

  test('both retired ⇒ still resolves, to the higher lifetime earner', () => {
    // A bonus after both retirements is odd but must not go unattributed: with the
    // household scalars now an error path, an unresolved bonus would be dropped.
    const ret = new Date(Date.UTC(2027, 0, 1));
    const st = people({ monthlyWage: 20000, retirementDate: ret },
                      { monthlyWage: 2000,  retirementDate: ret });
    assert.strictEqual(resolveBonusEarner(st, {}, AT), 'primary');
  });

  test('an unknown personId falls through to inference rather than vanishing', () => {
    const st = people({ monthlyWage: 20000 }, { monthlyWage: 2000 });
    assert.strictEqual(resolveBonusEarner(st, { personId: 'ghost' }, AT), 'primary');
  });

  test('BONUS_TAX books the whole bonus to the stamped earner', () => {
    const next = run('BONUS_TAX', { amount: 50000, residency: 'AU', personKey: 'spouse' });
    assert.deepEqual(nz(next.auPersonOrdinaryIncomeYTD), { spouse: 50000 });
    assertNothingOnHousehold(next, 'BONUS_TAX');
  });
});
