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
 * Nebraska's community-college credit (Neb. Rev. Stat. 77-6706(4), design 134 step 4f): a
 * refundable income tax credit of 100% of the community-college property tax paid in the year.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { NeStateTaxRates2025 } from '../../src/finance/tax/state/ne/ne-state-tax-rates-2025.js';
import { HiStateTaxRates2024 } from '../../src/finance/tax/state/hi/hi-state-tax-rates-2024.js';
import { InflationAdjustedStateTaxRates } from '../../src/finance/tax/state/inflation-adjusted-state-tax-rates.js';
import { StateTaxSettleApplyReducer, StateTaxRefundCreditReducer } from '../../src/finance/tax/state/state-tax-settle-classes.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { makeAccount, makeServices } from '../helpers/reducer-fixtures.js';
import { assertBalanceInvariant } from '../helpers/reducer-postconditions.js';
import { GOLDEN_SPECS } from '../helpers/golden-specs.js';
import { runGolden } from '../helpers/golden-harness.js';

const NE = new NeStateTaxRates2025();
const base = { stateOrdinaryIncomeYTD: 60_000, usFilingSingle: true };

describe('Nebraska community-college credit (design 134 step 4f)', () => {
  test('Nebraska refunds 100% from 2024, a projected year keeps it, other states give none', () => {
    assert.strictEqual(NE._communityCollegeCreditRate, 1);
    assert.strictEqual(new InflationAdjustedStateTaxRates(NE, 1.2)._communityCollegeCreditRate, 1);
    assert.strictEqual(new HiStateTaxRates2024()._communityCollegeCreditRate, 0);
  });

  test('the credit comes off the liability, and can take it below zero', () => {
    const without = NE.computeTax(base);
    const withCc = NE.computeTax({ ...base, stateCommunityCollegeTaxYTD: 680 });
    assert.strictEqual(withCc.communityCollegeCredit, 680);
    assert.ok(Math.abs(without.netLiability - withCc.netLiability - 680) < 1e-9);
    const refund = NE.computeTax({ stateOrdinaryIncomeYTD: 0, usFilingSingle: true, stateCommunityCollegeTaxYTD: 680 });
    assert.strictEqual(refund.netLiability, -680);
    assert.ok(refund.lineItems.some(l => /Community College Tax Credit/.test(l.label) && l.amount === -680));
  });

  test('a negative settle chains a refund and resets the credit bucket', () => {
    const r = new StateTaxSettleApplyReducer();
    const out = r.reduce({ stateOrdinaryIncomeYTD: 0, stateCommunityCollegeTaxYTD: 680 }, { type: 'STATE_TAX_SETTLE_APPLY', tax: -680 });
    assert.strictEqual(out.stateCommunityCollegeTaxYTD, 0);
    assert.deepStrictEqual(out.next, [{ type: 'STATE_TAX_REFUND_CREDIT', amount: 680 }]);
    // A plan with nothing creditable gains no key.
    assert.ok(!('stateCommunityCollegeTaxYTD' in r.reduce({ stateOrdinaryIncomeYTD: 5 }, { type: 'STATE_TAX_SETTLE_APPLY', tax: 100 })));
  });

  test('the refund credits the US cash account (I3)', () => {
    const services = makeServices({ stateKeyByRole: { [ACCOUNT_ROLES.US_SAVINGS]: 'usSavingsAccount' } });
    const acct = makeAccount({ stateKey: 'usSavingsAccount', holdings: [{ id: 'c', marketValue: 1_000, costBasis: 1_000 }] });
    const next = new StateTaxRefundCreditReducer(services).reduce({ usSavingsAccount: acct },
      { type: 'STATE_TAX_REFUND_CREDIT', amount: 680 }, new Date('2027-12-31'));
    assertBalanceInvariant(next);
    assert.strictEqual(next.usSavingsAccount.balance, 1_680);
  });

  test('in a household run the farm row\'s community-college tax is credited each year (golden us-farm-operator)', () => {
    const { sim } = runGolden(GOLDEN_SPECS.find(s => s.name === 'us-farm-operator'));
    const credit = new Map();
    for (const e of sim.journal.journal) {
      if (e.action?.type !== 'STATE_TAX_SETTLE_APPLY') continue;
      const y = new Date(e.date).getUTCFullYear();
      if (!credit.has(y)) credit.set(y, (e.action.data ?? e.action).taxDetail.communityCollegeCredit);
    }
    assert.strictEqual(credit.get(2026), 0);
    assert.strictEqual(credit.get(2027), 680);
    assert.ok(Math.abs(credit.get(2028) - 680 * 1.03) < 1e-9, 'indexed with the row');
  });
});
