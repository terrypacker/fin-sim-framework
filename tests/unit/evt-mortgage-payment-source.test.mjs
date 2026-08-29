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
 * A property mortgage must be able to name the cash pool it debits.
 *
 * `resolveLoanCashKey` has always honoured `loan.paymentSourceKey`, but the loan
 * entry for a MORTGAGE is rebuilt from the property record on every load by
 * `synthesizeLoanForProperty`, which did not carry the field. So the override was
 * reachable only on a standalone LoanAccount, and writing it onto a scenario's
 * `initialState` was SILENTLY INERT — two study arms that differed only in that
 * field came back byte-identical.
 *
 * That mattered most in the one case the field exists for. An offset is the loan's
 * default payment source, so P&I drains it in lockstep with the balance and the
 * drawable pool — the only thing an offset is actually worth — retires on the
 * amortisation schedule. Naming a different source is the only way to stop it.
 *
 * The absence assertion here (`paymentSourceKey` beats the offset) needs the control
 * that the detector works, so the first case pins the DEFAULT: with the field unset
 * the offset still wins over the country cash pool.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeLoanForProperty } from '../../src/finance/account-rules/loan-classes.js';
import { RealProperty }         from '../../src/finance/assets/real-property.js';

const AUD = { code: 'AUD', symbol: 'A$' };

// NOTE the signature: RealProperty(initialValue, opts). Passing one object puts the
// whole thing in `initialValue` and leaves opts empty, so every field reads back null
// and the test fails for a reason that has nothing to do with what it is testing.
const property = (extra = {}) => new RealProperty(1_200_000, {
  id: 'p1', name: 'AU House', stateKey: 'auHouseProperty', country: 'AU', currency: AUD,
  mortgageBalance: 363_000, monthlyMortgage: 2_600, mortgageMaturityYear: 2046, ...extra,
});

test('a property mortgage carries mortgagePaymentSourceKey onto its loan entry', () => {
  const loan = synthesizeLoanForProperty(property({ mortgagePaymentSourceKey: 'auSavingsAccount' }));
  assert.equal(loan.paymentSourceKey, 'auSavingsAccount');
});

test('default is null, so the offset/country-cash precedence is unchanged', () => {
  const loan = synthesizeLoanForProperty(property());
  assert.equal(loan.paymentSourceKey, null,
    'an unset field must stay null — a non-null default would override every linked offset');
});

test('the field is not dropped by a RealProperty round-trip', () => {
  const p = property({ mortgagePaymentSourceKey: 'auSavingsAccount' });
  assert.equal(p.mortgagePaymentSourceKey, 'auSavingsAccount');
  assert.equal(property().mortgagePaymentSourceKey, null);
});
