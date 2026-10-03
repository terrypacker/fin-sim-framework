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

// ── Design 118 phase 2: the claim age, the factor and the stamp ──────────────────

const stamps = (actions) => actions.filter(a => a.type === 'SS_ENTITLEMENT_APPLY');

test('SS-CLAIM-1: an early claim is paid from the entitlement month at the reduced factor, and stamped', () => {
  const h = new MonthlySocialSecurityHandler();
  // Born 2 Jul 1964: attains 62 on 1 Jul 2026, so entitled in July 2026 at 70% (FRA 67).
  const p = person({ birthDate: '1964-07-02', ssClaimAge: 62, ssEntitledMs: null });
  assert.equal(payments(h.call({ date: new Date(Date.UTC(2026, 5, 30)), state: { people: { primary: p } } })).length, 0);
  const actions = h.call({ date: new Date(Date.UTC(2026, 6, 31)), state: { people: { primary: p } } });
  assert.deepEqual(stamps(actions).map(a => [a.personKey, a.entitledMs]), [['primary', Date.UTC(2026, 6, 1)]]);
  assert.ok(Math.abs(payments(actions)[0].amount - 3000 * 0.70) < 1e-9);
});

test('SS-CLAIM-2: once stamped, the stamp decides — a later claim-age change does not re-time it', () => {
  const h = new MonthlySocialSecurityHandler();
  const p = person({ birthDate: '1964-07-02', ssClaimAge: 70, ssEntitledMs: Date.UTC(2026, 6, 1) });
  const actions = h.call({ date: new Date(Date.UTC(2027, 0, 31)), state: { people: { primary: p } } });
  assert.equal(stamps(actions).length, 0, 'never re-stamped');
  assert.ok(Math.abs(payments(actions)[0].amount - 3000 * 0.70) < 1e-9);
});

test('SS-CLAIM-3: someone already collecting at sim start is stamped with their past claim month', () => {
  const h = new MonthlySocialSecurityHandler();
  // Born 2 Jul 1958 (FRA 66y8m, so Mar 2025), claimed at 62: entitled Jul 2020, 56 months early.
  const p = person({ birthDate: '1958-07-02', ssClaimAge: 62, ssEntitledMs: null });
  const actions = h.call({ date: new Date(Date.UTC(2026, 0, 31)), state: { people: { primary: p } } });
  assert.equal(stamps(actions)[0].entitledMs, Date.UTC(2020, 6, 1));
  const factor = 1 - (36 * 5 / 9 + 20 * 5 / 12) / 100;
  assert.ok(Math.abs(payments(actions)[0].amount - 3000 * factor) < 1e-9);
});
