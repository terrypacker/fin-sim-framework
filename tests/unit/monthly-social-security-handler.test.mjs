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
 *
 * Phase 2: SS-CLAIM-* (the claim age, the factor, the stamp). Phase 3: SS-SPOUSE-* (the
 * spousal top-up in a two-person household). Phase 4: SS-SURV-* (a widow(er) is paid the
 * larger of their own and the survivor benefit).
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

// ── Design 118 phase 3: the spousal benefit ─────────────────────────────────────

const near = (a, b) => Math.abs(a - b) < 1e-9;
const paidTo = (actions, key) => payments(actions).find(a => a.personKey === key);
const at = (y, m) => new Date(Date.UTC(y, m, 28));

// Both born on the 2nd, so each age is attained on the 1st and entitlement starts that
// month. FRA 67 for both: the worker in Jul 2031, the spouse in Mar 2032.
const worker = (o) => person({ name: 'W', birthDate: '1964-07-02', socialSecurityMonthly: 3000, ...o });
const spouse = (o) => person({ name: 'S', birthDate: '1965-03-02', socialSecurityMonthly: 0, ...o });

test('SS-SPOUSE-1: no record of their own ⇒ entitled at their claim age once the worker is, on half the PIA', () => {
  const h = new MonthlySocialSecurityHandler();
  const people = { primary: worker({ ssClaimAge: 67 }), spouse: spouse({ ssClaimAge: 67 }) };
  // Mar 2032: the spouse reaches 67; the worker has been entitled since Jul 2031.
  const actions = h.call({ date: at(2032, 2), state: { people } });
  assert.deepEqual(stamps(actions).map(a => [a.personKey, a.entitledMs]),
    [['primary', Date.UTC(2031, 6, 1)], ['spouse', Date.UTC(2032, 2, 1)]]);
  const p = paidTo(actions, 'spouse');
  assert.ok(near(p.amount, 1500) && p.own === 0 && near(p.spousal, 1500));
  assert.equal(paidTo(h.call({ date: at(2032, 1), state: { people } }), 'spouse'), undefined, 'not before 67');
});

test('SS-SPOUSE-2: a worker claiming after the spouse ⇒ the spousal benefit waits, reduced from its own start', () => {
  const h = new MonthlySocialSecurityHandler();
  // Spouse claims at 62 (Mar 2027), worker at 64 (Jul 2028): 44 months before the spouse's FRA.
  const people = { primary: worker({ ssClaimAge: 64 }), spouse: spouse({ ssClaimAge: 62, socialSecurityMonthly: 600 }) };
  const before = paidTo(h.call({ date: at(2028, 5), state: { people } }), 'spouse');
  assert.ok(near(before.own, 600 * 0.70) && before.spousal === 0, 'own benefit only until the worker claims');
  const after = paidTo(h.call({ date: at(2028, 6), state: { people } }), 'spouse');
  const f = 1 - (36 * 25 / 36 + 8 * 5 / 12) / 100;
  assert.ok(near(after.own, 420) && near(after.spousal, (1500 - 600) * f), `spousal ${after.spousal}`);
  assert.ok(near(after.amount, 420 + 900 * f));
});

test('SS-SPOUSE-3: own PIA at least half the worker\'s ⇒ no top-up', () => {
  const h = new MonthlySocialSecurityHandler();
  for (const pia of [1500, 2000]) {
    const people = { primary: worker({ ssClaimAge: 67 }), spouse: spouse({ ssClaimAge: 67, socialSecurityMonthly: pia }) };
    const p = paidTo(h.call({ date: at(2033, 0), state: { people } }), 'spouse');
    assert.ok(near(p.amount, pia) && p.spousal === 0, `PIA ${pia}`);
  }
});

test('SS-SPOUSE-4: the spouse\'s own delayed credits come out of the excess (POMS RS 00615.694)', () => {
  const h = new MonthlySocialSecurityHandler();
  // Spouse claims at 70 (Mar 2035, every credit at once): own 1000 × 1.24 = 1240; excess 500.
  const people = { primary: worker({ ssClaimAge: 67 }), spouse: spouse({ ssClaimAge: 70, socialSecurityMonthly: 1000 }) };
  const p = paidTo(h.call({ date: at(2035, 2), state: { people } }), 'spouse');
  assert.ok(near(p.own, 1240) && near(p.spousal, 1000 + 500 - 1240) && near(p.amount, 1500));
});

test('SS-SPOUSE-5: the top-up ends with the worker; a household of one has none', () => {
  const h = new MonthlySocialSecurityHandler();
  const stamped = spouse({ ssClaimAge: 67, socialSecurityMonthly: 600, ssEntitledMs: Date.UTC(2032, 2, 1) });
  const p = paidTo(h.call({ date: at(2033, 0), state: { people: { spouse: stamped } } }), 'spouse');
  assert.ok(near(p.amount, 600) && p.spousal === 0);
  const none = spouse({ ssClaimAge: 67 });
  assert.equal(payments(h.call({ date: at(2033, 0), state: { people: { spouse: none } } })).length, 0);
});

test('SS-SPOUSE-6: the worker\'s own claim factor never touches the spousal amount', () => {
  const h = new MonthlySocialSecurityHandler();
  for (const age of [62, 70]) {
    const people = { primary: worker({ ssClaimAge: age }), spouse: spouse({ ssClaimAge: 67 }) };
    const p = paidTo(h.call({ date: at(2035, 6), state: { people } }), 'spouse');
    assert.ok(near(p.spousal, 1500), `worker at ${age}: ${p.spousal}`);
  }
});

// ── Design 118 phase 4: the survivor benefit ────────────────────────────────────

// A widow(er) born 2 Mar 1965: 60 in Mar 2025, 62 in Mar 2027, survivor and own FRA 67 in
// Mar 2032 (404.409), 70 in Mar 2035. Their spouse's PIA was 3000.
const widow = (o) => spouse({ ssSurvivorPia: 3000, ssSurvivorRatio: 1, ssSurvivorRibLimCap: null,
  ssSurvivorFromMs: Date.UTC(2032, 2, 1), ...o });

test('SS-SURV-1: widowed with a smaller own benefit ⇒ the survivor benefit, paid as the excess over own', () => {
  const h = new MonthlySocialSecurityHandler();
  const w = widow({ socialSecurityMonthly: 1000, ssClaimAge: 62, ssEntitledMs: Date.UTC(2027, 2, 1),
    ssSurvivorFromMs: Date.UTC(2030, 0, 1) });
  const p = paidTo(h.call({ date: at(2030, 0), state: { people: { spouse: w } } }), 'spouse');
  // From Jan 2030, 26 months before survivor FRA; 84 months from 60 to it.
  const surv = 3000 * (1 - 0.285 * 26 / 84);
  assert.ok(near(p.own, 700) && near(p.survivor, surv - 700) && near(p.amount, surv), `paid ${p.amount}`);
  assert.equal(p.spousal, 0);
});

test('SS-SURV-2: no record of their own ⇒ paid the survivor benefit alone, never stamped', () => {
  const h = new MonthlySocialSecurityHandler();
  const w = widow({ ssClaimAge: 67 });
  assert.equal(payments(h.call({ date: at(2032, 1), state: { people: { spouse: w } } })).length, 0);
  const actions = h.call({ date: at(2032, 2), state: { people: { spouse: w } } });
  assert.equal(stamps(actions).length, 0);
  const p = paidTo(actions, 'spouse');
  assert.ok(near(p.amount, 3000) && p.own === 0 && near(p.survivor, 3000));
});

test('SS-SURV-3: deferring the own claim to 70 does not defer the survivor benefit past survivor FRA (D10)', () => {
  const h = new MonthlySocialSecurityHandler();
  const w = widow({ socialSecurityMonthly: 2600, ssClaimAge: 70 });
  const before = paidTo(h.call({ date: at(2033, 5), state: { people: { spouse: w } } }), 'spouse');
  assert.ok(near(before.amount, 3000) && before.own === 0, 'survivor only, unreduced, before 70');
  // At 70 the own benefit (2600 × 1.24 = 3224) passes the survivor's: no survivor part.
  const after = paidTo(h.call({ date: at(2035, 2), state: { people: { spouse: w } } }), 'spouse');
  assert.ok(near(after.own, 3224) && after.survivor === 0 && near(after.amount, 3224));
});

test('SS-SURV-4: the early-claim cap and inherited credits reach the payment', () => {
  const h = new MonthlySocialSecurityHandler();
  const capped = widow({ ssSurvivorRibLimCap: 0.825 });
  assert.ok(near(paidTo(h.call({ date: at(2033, 0), state: { people: { spouse: capped } } }), 'spouse').amount, 2475));
  const credited = widow({ ssSurvivorRatio: 1.24 });
  assert.ok(near(paidTo(h.call({ date: at(2033, 0), state: { people: { spouse: credited } } }), 'spouse').amount, 3720));
});
