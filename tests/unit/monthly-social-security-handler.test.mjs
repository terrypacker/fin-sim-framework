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
 * monthly-social-security-handler.test.mjs
 *
 * Design 118 phase 1 (was design 116 D6): Social Security starts at the claiming age
 * whether or not the person is still working. `retirementDate` no longer gates it.
 *
 *   SS-WORK-1: a person past the claiming age with a future retirementDate is paid
 *   SS-WORK-2: a person below the claiming age is not paid, retired or not
 *   SS-WORK-3: each person is gated on their own age, in one household
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MonthlySocialSecurityHandler } from '../../src/finance/handlers/monthly-social-security-handler.js';

const payments = (actions) => actions.filter(a => a.type === 'SS_INCOME_APPLY');

function person(overrides) {
  return { name: 'P', birthDate: '1960-03-15', socialSecurityMonthly: 3000,
           retirementDate: null, residency: 'US', ...overrides };
}

test('SS-WORK-1: past the claiming age and still working ⇒ the benefit is paid', () => {
  const h = new MonthlySocialSecurityHandler();
  const state = { people: { primary: person({ retirementDate: '2030-01-01' }) } };
  const actions = h.call({ date: new Date(Date.UTC(2028, 0, 1)), state });   // age 67, works to 70
  const paid = payments(actions);
  assert.equal(paid.length, 1);
  assert.equal(paid[0].amount, 3000);
  assert.equal(paid[0].personKey, 'primary');
});

test('SS-WORK-2: below the claiming age ⇒ nothing is paid, retired or not', () => {
  const h = new MonthlySocialSecurityHandler();
  const date = new Date(Date.UTC(2027, 0, 1));                               // age 66
  for (const retirementDate of [null, '2020-01-01', '2035-01-01']) {
    const state = { people: { primary: person({ retirementDate }) } };
    assert.equal(payments(h.call({ date, state })).length, 0, `retirementDate ${retirementDate}`);
  }
});

test('SS-WORK-3: each person is gated on their own age, not on work', () => {
  const h = new MonthlySocialSecurityHandler();
  const state = { people: {
    primary: person({ retirementDate: '2040-01-01' }),                       // 67, still working
    spouse:  person({ birthDate: '1965-06-01', retirementDate: '2020-01-01' }), // 62, retired
  } };
  const paid = payments(h.call({ date: new Date(Date.UTC(2028, 0, 1)), state }));
  assert.deepEqual(paid.map(a => a.personKey), ['primary']);
});
