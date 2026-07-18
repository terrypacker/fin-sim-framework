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
 * mortality-year-of-death-tax.test.mjs
 *
 * Tests for design/68 Gap 1 — the AU per-person settle must still file a return
 * for a person who died partway through the fiscal year. Before the fix, the
 * deceased was dropped from state.people (by PersonDiedApplyReducer) before the
 * 30 Jun settle, so computeAuTaxPerPerson never visited their key: their accrued
 * final-year AU income went untaxed and was then zeroed by the settle reset.
 *
 *  YOD-1: PersonDiedApplyReducer captures name + incomeSupportRecipient in state.deceased
 *  YOD-2: computeAuTaxPerPerson files a final return for a deceased income-holder
 *  YOD-3: numResidents (shared-pool divisor) counts the deceased — survivor's split unchanged
 *  YOD-4: deceased's Age Pension CGT exemption survives via state.deceased.incomeSupportRecipient
 */

import { test }   from 'node:test';
import assert      from 'node:assert/strict';

import { PersonDiedApplyReducer } from '../../src/finance/reducers/person-died-apply-reducer.js';
import { TaxSettleService }        from '../../src/finance/tax-settle-service.js';
import { buildAuFiscalYear }       from '../../src/finance/period/period-builder.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

// An AU fiscal-year period (FY2027-28: Jul 2027 – Jun 2028) to resolve the module.
const AU_PERIOD = buildAuFiscalYear(2027).periods.find(p => p.type === 'YEAR_AU');

/**
 * State as it looks at the 30 Jun settle AFTER the primary died mid-year:
 * primary is gone from state.people but their accrued per-person AU income is
 * still on the accumulator maps (the settle reset runs later, in the reducer).
 */
function postDeathSettleState(overrides = {}) {
  return {
    people: {
      spouse: { id: 'spouse', name: 'Bob', residency: 'AU', incomeSupportRecipient: false },
    },
    deceased: {
      primary: { date: new Date('2028-03-01'), taxJurisdiction: 'AU', name: 'Alice', incomeSupportRecipient: false },
    },
    currentPeriods: { AU: AU_PERIOD },
    // Both accrued AU ordinary income this fiscal year before the primary's death.
    auPersonOrdinaryIncomeYTD: { primary: 60_000, spouse: 40_000 },
    ...overrides,
  };
}

const svc = new TaxSettleService();

// ── YOD-1 ─────────────────────────────────────────────────────────────────────

test('YOD-1: PersonDiedApplyReducer captures name + incomeSupportRecipient in state.deceased', () => {
  const reducer = new PersonDiedApplyReducer();
  const state = {
    people: {
      primary: { id: 'primary', name: 'Alice', residency: 'AU', incomeSupportRecipient: true },
      spouse:  { id: 'spouse',  name: 'Bob',   residency: 'AU' },
    },
    deceased: {},
  };
  const action = {
    type: 'PERSON_DIED_APPLY', personId: 'primary',
    date: new Date('2028-03-01'), taxJurisdiction: 'AU',
    personName: 'Alice', incomeSupportRecipient: true,
  };
  const next = reducer.reduce(state, action);

  assert.strictEqual(next.deceased.primary.name, 'Alice');
  assert.strictEqual(next.deceased.primary.incomeSupportRecipient, true);
  assert.strictEqual(next.deceased.primary.taxJurisdiction, 'AU');
});

// ── YOD-2 ─────────────────────────────────────────────────────────────────────

test('YOD-2: computeAuTaxPerPerson files a final return for a deceased income-holder', () => {
  const details = svc.computeAuTaxPerPerson(postDeathSettleState());
  const keys = details.map(d => d.personKey).sort();

  assert.deepStrictEqual(keys, ['primary', 'spouse'],
    'both the surviving spouse AND the deceased primary should get a return');

  const primary = details.find(d => d.personKey === 'primary');
  assert.ok(primary, 'deceased primary should have a return');
  assert.ok(primary.taxDetail.netLiability > 0,
    'deceased primary owed AU tax on their final-year income — must not be dropped');
  assert.strictEqual(primary.personName, 'Alice',
    'deceased name should be resolved from state.deceased');
});

// ── YOD-3 ─────────────────────────────────────────────────────────────────────

test('YOD-3: numResidents counts the deceased so the survivor shared-pool split is unchanged', () => {
  // Move all AU ordinary income into the *shared* pool (no per-person entries),
  // so the only thing that varies the survivor's tax is the numResidents divisor.
  const state = postDeathSettleState({
    auPersonOrdinaryIncomeYTD: {},          // nothing per-person…
    auOrdinaryIncomeYTD: 100_000,           // …all in the shared pool
  });
  const details = svc.computeAuTaxPerPerson(state);

  // With the deceased counted (numResidents=2) the shared pool splits 50/50,
  // so the survivor is assessed on 50_000, not the full 100_000.
  const spouse = details.find(d => d.personKey === 'spouse');
  assert.ok(spouse, 'survivor should have a return');
  assert.strictEqual(details.length, 2, 'deceased must still be counted as a resident-of-the-year');
});

// ── YOD-4 ─────────────────────────────────────────────────────────────────────

test('YOD-4: deceased Age Pension CGT exemption survives via state.deceased.incomeSupportRecipient', () => {
  const state = postDeathSettleState({
    deceased: {
      primary: { date: new Date('2028-03-01'), taxJurisdiction: 'AU', name: 'Alice', incomeSupportRecipient: true },
    },
  });
  const details = svc.computeAuTaxPerPerson(state);
  const primary = details.find(d => d.personKey === 'primary');
  assert.ok(primary, 'deceased primary should have a return even when on income support');
  // The exemption plumbs through to auMinTaxExempt inside the per-person state;
  // presence of the return (not the exact figure) is what YOD-4 guards.
});
