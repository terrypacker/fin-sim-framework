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
 * Design 107 §6–§8 — paying tax in instalments.
 *
 * The arithmetic is statutory and the sources are on disk, so these tests quote the provision
 * each figure comes from rather than the number this engine happened to produce first:
 * `docs/us-tax/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.txt` and
 * `docs/au-tax/TAA-1953/C2026C00393VOL02.txt`.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  instalmentIncrement, usRequiredAnnualPayment, auGdpAdjustedNotionalTax, US_DE_MINIMIS_TAX,
  UsTaxInstalmentHandler, AuTaxInstalmentHandler,
  UsTaxInstalmentDebitReducer, AuTaxRefundCreditReducer,
} from '../../src/finance/tax/tax-instalment-classes.js';

// ─── §6654(d)(1) — the required annual payment ───────────────────────────────────

test('INST-1: the prior-year safe harbour is 100%, and 110% above $150k AGI', () => {
  // §6654(d)(1)(B)(ii) and (C)(i). The test is AGI on the PRIOR return, not taxable income.
  assert.equal(usRequiredAnnualPayment({ tax: 40_000, agi: 150_000 }), 40_000);
  assert.equal(usRequiredAnnualPayment({ tax: 40_000, agi: 150_001 }), 44_000);
});

test('INST-2: under the §6654(e)(1) de minimis nothing is raised at all', () => {
  assert.equal(usRequiredAnnualPayment({ tax: US_DE_MINIMIS_TAX, agi: 500_000 }), 0);
  assert.ok(usRequiredAnnualPayment({ tax: US_DE_MINIMIS_TAX + 1, agi: 0 }) > 0);
  // No basis at all — the first year of a run, or of US filing. Not a failure: the balance
  // simply falls due at the settle, which is what happens to a new filer.
  assert.equal(usRequiredAnnualPayment(undefined), 0);
  assert.equal(usRequiredAnnualPayment({}), 0);
});

test('INST-3: the four instalments are cumulative 25/50/75/100, and self-correcting', () => {
  // §6654(d)(1)(A) as a level 25%; s 45-400(2) states the same as a cumulative table whose
  // n-th row is reduced by what was already paid. Expressed cumulatively they coincide.
  assert.equal(instalmentIncrement(40_000, 1, 0),      10_000);
  assert.equal(instalmentIncrement(40_000, 2, 10_000), 10_000);
  assert.equal(instalmentIncrement(40_000, 3, 20_000), 10_000);
  assert.equal(instalmentIncrement(40_000, 4, 30_000), 10_000);
  // A quarter that was skipped for want of cash is made up by the next one, rather than
  // being lost — the cumulative form is what buys that.
  assert.equal(instalmentIncrement(40_000, 2, 0), 20_000);
  // And an earlier OVER-payment reduces the next to zero rather than refunding mid-year.
  assert.equal(instalmentIncrement(40_000, 2, 35_000), 0);
});

// ─── s 45-405 — the GDP uplift ───────────────────────────────────────────────────

test('INST-4: the GDP adjustment lifts the base, and a negative one reads as zero', () => {
  assert.equal(auGdpAdjustedNotionalTax(10_000, 0.05), 10_500);
  // s 45-405(3)(b): "if the percentage worked out using the formula is negative — 0%".
  assert.equal(auGdpAdjustedNotionalTax(10_000, -0.03), 10_000);
  assert.equal(auGdpAdjustedNotionalTax(10_000, undefined), 10_000);
});

// ─── the handlers ────────────────────────────────────────────────────────────────

test('INST-5: the US handler sizes its quarter from the basis and what is already paid', () => {
  const state = { taxBasis: { US: { tax: 40_000, agi: 200_000 } }, taxInstalmentsPaid: { US: 11_000 } };
  // 110% of 40k = 44k; half of that is 22k; 11k already paid ⇒ 11k due.
  const [a] = new UsTaxInstalmentHandler({ quarter: 2 }).call({ state });
  assert.equal(a.type, 'US_TAX_INSTALMENT_DEBIT');
  assert.equal(a.amount, 11_000);
  assert.equal(a.quarter, 2);
});

test('INST-6: the AU handler sums LIVING members and never resurrects a dead key', () => {
  const state = {
    people: { primary: {} },                       // spouse has died
    taxBasis: { AU: { primary: { instalmentBase: 100_000 }, spouse: { instalmentBase: 80_000 } } },
    taxInstalmentsPaid: { AU: 0 },
    auNotionalTaxRate: 0.25, auGdpUplift: 0.05,
  };
  // primary alone: 100k × 0.25 = 25k notional, × 1.05 = 26,250; first quarter is 25%.
  const [a] = new AuTaxInstalmentHandler({ quarter: 1 }).call({ state });
  assert.equal(a.amount, 6562.5,
    'the dead spouse contributes nothing — design 68 Gap 5 drops the key, never zeroes it');
});

test('INST-7: nothing is raised when there is nothing to raise', () => {
  assert.deepEqual(new UsTaxInstalmentHandler({ quarter: 1 }).call({ state: {} }), []);
  assert.deepEqual(new AuTaxInstalmentHandler({ quarter: 1 }).call({ state: {} }), []);
});

// ─── the debit chains rather than moving money itself ────────────────────────────

test('INST-8: the instalment records itself and delegates the CASH to the tax payment path', () => {
  // Re-emitting the ordinary payment debit is the point: that reducer funds a shortfall
  // through replenishSavings, taxes the sale, handles the cross-border escalation and stamps
  // the §988 disposition. A second debit path would produce a believable untaxed number.
  const r = new UsTaxInstalmentDebitReducer();
  const out = r.reduce({ taxInstalmentsPaid: { US: 1_000 } }, { type: 'US_TAX_INSTALMENT_DEBIT', amount: 2_500 });
  assert.equal(out.taxInstalmentsPaid.US, 3_500, 'accumulated, because the settle credits it');
  assert.deepEqual(out.next, [{ type: 'US_TAX_PAYMENT_DEBIT', amount: 2_500 }]);
});

test('INST-9: a refund credits the country cash account, and an absent one is not an insolvency', () => {
  const account = { balance: 1_000, currency: { code: 'AUD' } };
  const calls = [];
  const services = {
    accountService: { transaction: (a, amt) => { calls.push(amt); a.balance += amt; } },
    stateRegistry:  { getStateKey: () => 'auSavingsAccount' },
  };
  const r = new AuTaxRefundCreditReducer(services);
  r.reduce({ auSavingsAccount: account }, { type: 'AU_TAX_REFUND_CREDIT', amount: 900 }, new Date());
  assert.deepEqual(calls, [900]);

  // Nowhere to land is a configuration gap, not money owed — dropped, never invented elsewhere.
  const r2 = new AuTaxRefundCreditReducer({ accountService: services.accountService,
                                            stateRegistry: { getStateKey: () => 'missingAccount' } });
  assert.doesNotThrow(() => r2.reduce({}, { type: 'AU_TAX_REFUND_CREDIT', amount: 900 }, new Date()));
});
