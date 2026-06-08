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
 * mortality-filing-status.test.mjs
 *
 * Tests for design/27 Step 19 — filing-status change on widowhood.
 *
 * The mechanism:
 *   UsPeriodAdvanceReducer.reduce() (fires at Jan 1 each year) sets
 *   state.usFilingSingle = true when state.deceased is non-empty.
 *   UsTaxRatesBase.computeTax() reads state.usFilingSingle to select
 *   single vs MFJ brackets and standard deduction.
 *
 *  FS-1: Period advance with no deaths keeps usFilingSingle=false
 *  FS-2: Period advance after a death sets usFilingSingle=true
 *  FS-3: usFilingSingle=false even when deceased is undefined (non-mortality scenarios)
 *  FS-4: Filing status switches on Jan 1 of the year AFTER death, not year-of-death
 *  FS-5: Single filing uses a lower standard deduction than MFJ → higher tax on same income
 *  FS-6: filingStatus label in computeTax output matches usFilingSingle flag
 */

import { test }  from 'node:test';
import assert     from 'node:assert/strict';

import { UsPeriodAdvanceReducer } from '../../src/finance/tax/period-advance-classes.js';
import { UsTaxRates2025 }         from '../../src/finance/tax/us/us-tax-rates-2025.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const DUMMY_PERIOD = { year: 2046, startMs: 0, endMs: 1 };
const ADVANCE_ACTION = { type: 'US_PERIOD_ADVANCE', period: DUMMY_PERIOD };

function makeReducer() {
  return new UsPeriodAdvanceReducer();
}

function applyAdvance(state) {
  const r = makeReducer();
  // newState returns an object with { state, emittedActions } — pull state out
  const result = r.reduce(state, ADVANCE_ACTION);
  return result.state ?? result; // handle both wrapped and raw return shapes
}

function stateAfter(state) {
  const out = applyAdvance(state);
  // UsPeriodAdvanceReducer.reduce calls this.newState which returns { state, ... }
  // Depending on base class implementation it may be the state directly
  return out;
}

// ── FS-1 ──────────────────────────────────────────────────────────────────────

test('FS-1: period advance with no deaths keeps usFilingSingle=false', () => {
  const state = { deceased: {}, currentPeriods: {} };
  const next  = stateAfter(state);
  assert.strictEqual(next.usFilingSingle, false, 'no deaths → MFJ');
});

// ── FS-2 ──────────────────────────────────────────────────────────────────────

test('FS-2: period advance after a death sets usFilingSingle=true', () => {
  const state = {
    deceased:       { spouse: { date: new Date('2045-06-01'), taxJurisdiction: 'US' } },
    currentPeriods: {},
  };
  const next = stateAfter(state);
  assert.strictEqual(next.usFilingSingle, true, 'death recorded → single filing');
});

// ── FS-3 ──────────────────────────────────────────────────────────────────────

test('FS-3: usFilingSingle=false when state.deceased is undefined (non-mortality scenario)', () => {
  const state = { currentPeriods: {} }; // no deceased field at all
  const next  = stateAfter(state);
  assert.strictEqual(next.usFilingSingle, false, 'undefined deceased → default MFJ');
});

// ── FS-4 ──────────────────────────────────────────────────────────────────────

test('FS-4: filing status flips on Jan 1 of the year after death, not year-of-death', () => {
  // Year-of-death: deceased is still empty when Jan 1 of that year fires
  // (PERSON_DIED events happen mid-year).  After the death the deceased map
  // is non-empty; the *next* Jan 1 advance sets usFilingSingle.

  // Simulate Jan 1 of year-of-death: deceased is still empty
  const stateYearOfDeath = { deceased: {}, currentPeriods: {} };
  const nextYearOfDeath  = stateAfter(stateYearOfDeath);
  assert.strictEqual(nextYearOfDeath.usFilingSingle, false, 'year-of-death Jan 1: still MFJ');

  // Simulate Jan 1 of year-after-death: deceased now populated
  const stateYearAfter = {
    deceased:       { spouse: { date: new Date('2045-08-15'), taxJurisdiction: 'US' } },
    currentPeriods: {},
  };
  const nextYearAfter = stateAfter(stateYearAfter);
  assert.strictEqual(nextYearAfter.usFilingSingle, true, 'year-after-death Jan 1: switches to single');
});

// ── FS-5 ──────────────────────────────────────────────────────────────────────

test('FS-5: single filing produces higher tax than MFJ on the same income', () => {
  const rates = new UsTaxRates2025();

  const baseState = {
    usOrdinaryIncomeYTD:   120_000,
    usNegativeIncomeYTD:   0,
    usCapitalGainsYTD:     0,
    usCollectibleGainsYTD: 0,
    usPenaltyYTD:          0,
    ftcYTD:                0,
  };

  const mfjResult    = rates.computeTax({ ...baseState, usFilingSingle: false });
  const singleResult = rates.computeTax({ ...baseState, usFilingSingle: true  });

  assert.ok(
    singleResult.netLiability > mfjResult.netLiability,
    `Single (${singleResult.netLiability.toFixed(0)}) should exceed MFJ (${mfjResult.netLiability.toFixed(0)}) at $120k income`,
  );
});

// ── FS-6 ──────────────────────────────────────────────────────────────────────

test('FS-6: filingStatus label in computeTax output matches usFilingSingle flag', () => {
  const rates = new UsTaxRates2025();
  const base  = {
    usOrdinaryIncomeYTD: 80_000, usNegativeIncomeYTD: 0,
    usCapitalGainsYTD: 0, usPenaltyYTD: 0, ftcYTD: 0,
  };

  const mfjR    = rates.computeTax({ ...base, usFilingSingle: false });
  const singleR = rates.computeTax({ ...base, usFilingSingle: true  });

  assert.strictEqual(mfjR.filingStatus,    'Married Filing Jointly', 'MFJ label');
  assert.strictEqual(singleR.filingStatus, 'Single',                  'Single label');
});
