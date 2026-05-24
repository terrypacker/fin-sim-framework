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
 * inflation.test.mjs
 * Unit tests for INFL-1 through INFL-5 (Inflation requirements).
 *
 * Tests cover:
 *   INFL-1 — Country-Based Rate Setting: per-country rates stored in state.inflationRates
 *   INFL-2 — Social Security Income: increases at US inflation rate on US PERIOD_ADVANCE
 *   INFL-3 — Salary: increases at country inflation rate (US wage → US rate)
 *   INFL-4 — Expenses: increase at country-of-residence rate; US advance ignored when AU resident
 *   INFL-5 — Tax Rates: bracket thresholds and deductions scale with state.inflationAccumulator
 *
 * Run with: node --test tests/unit/inflation.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { InflationAdjustReducer } from '../../src/finance/reducers/inflation-adjust-reducer.js';
import {
  InflationAdjustedUsTaxRates,
  InflationAdjustedAuTaxRates,
} from '../../src/finance/tax/inflation-adjusted-tax-rates.js';
import { UsTaxRates2025 } from '../../src/finance/tax/us/us-tax-rates-2025.js';
import { AuTaxRates2025 } from '../../src/finance/tax/au/au-tax-rates-2025.js';
import { TaxSettleService } from '../../src/finance/tax-settle-service.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const US_PERIOD_2027 = { type: 'PERIOD_ADVANCE', cc: 'US', period: { startMs: Date.UTC(2027, 0, 1) } };
const AU_PERIOD_2027 = { type: 'PERIOD_ADVANCE', cc: 'AU', period: { startMs: Date.UTC(2027, 6, 1) } };

function baseState(overrides = {}) {
  return {
    inflationRates:       { US: 0.03, AU: 0.03 },
    inflationAccumulator: { US: 1.0,  AU: 1.0  },
    people: {
      primary: { monthlyWage: 8_000, socialSecurityMonthly: 2_800 },
      spouse:  { monthlyWage: 4_000, socialSecurityMonthly: 1_500 },
    },
    isAuResident:   false,
    monthlyExpenses: 6_000,
    ...overrides,
  };
}

function usState(overrides = {}) {
  return {
    usOrdinaryIncomeYTD:   0,
    usNegativeIncomeYTD:   0,
    usCapitalGainsYTD:     0,
    usCollectibleGainsYTD: 0,
    usPenaltyYTD:          0,
    ftcYTD:                0,
    ...overrides,
  };
}

function auState(overrides = {}) {
  return {
    isAuResident:                true,
    auOrdinaryIncomeYTD:         0,
    auCapitalGainsYTD:           0,
    auNonResidentWithholdingYTD: 0,
    auSuperTaxYTD:               0,
    auFrankingCreditYTD:         0,
    ...overrides,
  };
}

const reducer = new InflationAdjustReducer();

// ══════════════════════════════════════════════════════════════════════════════
// INFL-1: Country-Based Rate Setting
// ══════════════════════════════════════════════════════════════════════════════

test('INFL-1: US inflation rate stored independently from AU rate', () => {
  const state = baseState({ inflationRates: { US: 0.025, AU: 0.035 } });
  const next = reducer.reduce(state, US_PERIOD_2027);
  // US accumulator advances by US rate, AU unchanged
  assert.ok(Math.abs(next.inflationAccumulator.US - 1.025) < 1e-10);
  assert.strictEqual(next.inflationAccumulator.AU, 1.0);
});

test('INFL-1: AU inflation rate advances the AU accumulator independently', () => {
  const state = baseState({ inflationRates: { US: 0.025, AU: 0.035 } });
  const next = reducer.reduce(state, AU_PERIOD_2027);
  assert.strictEqual(next.inflationAccumulator.US, 1.0);
  assert.ok(Math.abs(next.inflationAccumulator.AU - 1.035) < 1e-10);
});

test('INFL-1: zero inflation rate leaves accumulator unchanged', () => {
  const state = baseState({ inflationRates: { US: 0.0, AU: 0.0 } });
  const nextUs = reducer.reduce(state, US_PERIOD_2027);
  const nextAu = reducer.reduce(state, AU_PERIOD_2027);
  assert.strictEqual(nextUs.inflationAccumulator.US, 1.0);
  assert.strictEqual(nextAu.inflationAccumulator.AU, 1.0);
});

test('INFL-1: accumulator compounds across multiple years', () => {
  let state = baseState({ inflationRates: { US: 0.03, AU: 0.03 } });
  const action2027 = { type: 'PERIOD_ADVANCE', cc: 'US', period: { startMs: Date.UTC(2027, 0, 1) } };
  const action2028 = { type: 'PERIOD_ADVANCE', cc: 'US', period: { startMs: Date.UTC(2028, 0, 1) } };
  const action2029 = { type: 'PERIOD_ADVANCE', cc: 'US', period: { startMs: Date.UTC(2029, 0, 1) } };

  state = reducer.reduce(state, action2027);
  state = reducer.reduce(state, action2028);
  state = reducer.reduce(state, action2029);

  // After 3 years at 3%: 1.03^3 ≈ 1.092727
  const expected = 1.03 ** 3;
  assert.ok(Math.abs(state.inflationAccumulator.US - expected) < 1e-10);
});

// ══════════════════════════════════════════════════════════════════════════════
// INFL-2: Social Security Income — increases at US inflation rate
// ══════════════════════════════════════════════════════════════════════════════

test('INFL-2: primary socialSecurityMonthly inflates at US rate on US PERIOD_ADVANCE', () => {
  const state = baseState();
  const next = reducer.reduce(state, US_PERIOD_2027);
  assert.ok(Math.abs(next.people.primary.socialSecurityMonthly - 2_800 * 1.03) < 0.01);
});

test('INFL-2: spouse socialSecurityMonthly inflates at US rate on US PERIOD_ADVANCE', () => {
  const state = baseState();
  const next = reducer.reduce(state, US_PERIOD_2027);
  assert.ok(Math.abs(next.people.spouse.socialSecurityMonthly - 1_500 * 1.03) < 0.01);
});

test('INFL-2: socialSecurityMonthly does NOT change on AU PERIOD_ADVANCE', () => {
  const state = baseState();
  const next = reducer.reduce(state, AU_PERIOD_2027);
  // SS is a USD/US benefit — only adjusts on US period advance
  assert.strictEqual(next.people.primary.socialSecurityMonthly, 2_800);
  assert.strictEqual(next.people.spouse.socialSecurityMonthly,  1_500);
});

test('INFL-2: SS compounds correctly over two US period advances', () => {
  let state = baseState();
  state = reducer.reduce(state, { ...US_PERIOD_2027, period: { startMs: Date.UTC(2027, 0, 1) } });
  state = reducer.reduce(state, { ...US_PERIOD_2027, period: { startMs: Date.UTC(2028, 0, 1) } });
  const expected = 2_800 * 1.03 * 1.03;
  assert.ok(Math.abs(state.people.primary.socialSecurityMonthly - expected) < 0.01);
});

// ══════════════════════════════════════════════════════════════════════════════
// INFL-3: Salary — increases at country inflation rate
// ══════════════════════════════════════════════════════════════════════════════

test('INFL-3: primary monthlyWage inflates at US rate on US PERIOD_ADVANCE', () => {
  const state = baseState();
  const next = reducer.reduce(state, US_PERIOD_2027);
  assert.ok(Math.abs(next.people.primary.monthlyWage - 8_000 * 1.03) < 0.01);
});

test('INFL-3: spouse monthlyWage inflates at US rate on US PERIOD_ADVANCE', () => {
  const state = baseState();
  const next = reducer.reduce(state, US_PERIOD_2027);
  assert.ok(Math.abs(next.people.spouse.monthlyWage - 4_000 * 1.03) < 0.01);
});

test('INFL-3: monthlyWage does NOT change on AU PERIOD_ADVANCE (USD wages)', () => {
  const state = baseState();
  const next = reducer.reduce(state, AU_PERIOD_2027);
  assert.strictEqual(next.people.primary.monthlyWage, 8_000);
  assert.strictEqual(next.people.spouse.monthlyWage,  4_000);
});

test('INFL-3: wage compounding matches (1 + rate)^n over multiple US advances', () => {
  let state = baseState({ inflationRates: { US: 0.05, AU: 0.03 } });
  for (let yr = 2027; yr <= 2031; yr++) {
    state = reducer.reduce(state, { type: 'PERIOD_ADVANCE', cc: 'US', period: { startMs: Date.UTC(yr, 0, 1) } });
  }
  const expected = 8_000 * 1.05 ** 5;
  assert.ok(Math.abs(state.people.primary.monthlyWage - expected) < 0.01);
});

// ══════════════════════════════════════════════════════════════════════════════
// INFL-4: Expenses — increases at country-of-residence rate
// ══════════════════════════════════════════════════════════════════════════════

test('INFL-4: expenses inflate at US rate when US resident on US PERIOD_ADVANCE', () => {
  const state = baseState({ isAuResident: false });
  const next = reducer.reduce(state, US_PERIOD_2027);
  assert.ok(Math.abs(next.monthlyExpenses - 6_000 * 1.03) < 0.01);
});

test('INFL-4: expenses NOT adjusted on US PERIOD_ADVANCE when AU resident', () => {
  const state = baseState({ isAuResident: true });
  const next = reducer.reduce(state, US_PERIOD_2027);
  // Residence is AU so only AU advance should adjust AUD expenses
  assert.strictEqual(next.monthlyExpenses, 6_000);
});

test('INFL-4: expenses inflate at AU rate when AU resident on AU PERIOD_ADVANCE', () => {
  const state = baseState({ isAuResident: true, inflationRates: { US: 0.03, AU: 0.04 } });
  const next = reducer.reduce(state, AU_PERIOD_2027);
  assert.ok(Math.abs(next.monthlyExpenses - 6_000 * 1.04) < 0.01);
});

test('INFL-4: AU PERIOD_ADVANCE does NOT adjust expenses when US resident', () => {
  const state = baseState({ isAuResident: false });
  const next = reducer.reduce(state, AU_PERIOD_2027);
  assert.strictEqual(next.monthlyExpenses, 6_000);
});

test('INFL-4: expenses compound after residency switch from US to AU', () => {
  let state = baseState({ isAuResident: false, inflationRates: { US: 0.03, AU: 0.04 } });

  // Two US-based years (2027, 2028)
  state = reducer.reduce(state, { type: 'PERIOD_ADVANCE', cc: 'US', period: { startMs: Date.UTC(2027, 0, 1) } });
  state = reducer.reduce(state, { type: 'PERIOD_ADVANCE', cc: 'US', period: { startMs: Date.UTC(2028, 0, 1) } });

  // Switch to AU residency
  state = { ...state, isAuResident: true };

  // Two AU-based years (2028, 2029 fiscal)
  state = reducer.reduce(state, { type: 'PERIOD_ADVANCE', cc: 'AU', period: { startMs: Date.UTC(2028, 6, 1) } });
  state = reducer.reduce(state, { type: 'PERIOD_ADVANCE', cc: 'AU', period: { startMs: Date.UTC(2029, 6, 1) } });

  const expected = 6_000 * 1.03 ** 2 * 1.04 ** 2;
  assert.ok(Math.abs(state.monthlyExpenses - expected) < 0.01);
});

// ══════════════════════════════════════════════════════════════════════════════
// INFL-5: Tax Rates — brackets/rates increase with inflation
// ══════════════════════════════════════════════════════════════════════════════

test('INFL-5: InflationAdjustedUsTaxRates scales bracket thresholds by factor', () => {
  const base     = new UsTaxRates2025();
  const inflated = new InflationAdjustedUsTaxRates(base, 1.03);

  // 12% bracket started at $23,850; after 3% it should be 23,850 * 1.03
  const baseLo12     = base._brackets_mfj[1][0];      // 23_850
  const inflatedLo12 = inflated._brackets_mfj[1][0];
  assert.ok(Math.abs(inflatedLo12 - baseLo12 * 1.03) < 0.01);
});

test('INFL-5: InflationAdjustedUsTaxRates scales standard deduction', () => {
  const base     = new UsTaxRates2025();
  const inflated = new InflationAdjustedUsTaxRates(base, 1.03);
  assert.ok(Math.abs(inflated._stdDeduction_mfj - base._stdDeduction_mfj * 1.03) < 0.01);
});

test('INFL-5: InflationAdjustedUsTaxRates bracket rates are unchanged', () => {
  const base     = new UsTaxRates2025();
  const inflated = new InflationAdjustedUsTaxRates(base, 1.06);
  for (let i = 0; i < base._brackets_mfj.length; i++) {
    assert.strictEqual(inflated._brackets_mfj[i][1], base._brackets_mfj[i][1]);
  }
});

test('INFL-5: inflated US brackets yield lower tax on same nominal income', () => {
  const base     = new UsTaxRates2025();
  const inflated = new InflationAdjustedUsTaxRates(base, 1.03);
  const income   = 100_000;
  const baseTax     = base.computeTax(usState({ usOrdinaryIncomeYTD: income })).netLiability;
  const inflatedTax = inflated.computeTax(usState({ usOrdinaryIncomeYTD: income })).netLiability;
  // Higher brackets → same income taxed at lower marginal rates → less tax owed
  assert.ok(inflatedTax < baseTax, `inflated ${inflatedTax} should be < base ${baseTax}`);
});

test('INFL-5: InflationAdjustedAuTaxRates scales bracket thresholds by factor', () => {
  const base     = new AuTaxRates2025();
  const inflated = new InflationAdjustedAuTaxRates(base, 1.04);
  // Resident first bracket threshold ($18,200 tax-free) should scale
  assert.ok(Math.abs(inflated._brackets[1][0] - base._brackets[1][0] * 1.04) < 0.01);
});

test('INFL-5: InflationAdjustedAuTaxRates scales Medicare levy threshold', () => {
  const base     = new AuTaxRates2025();
  const inflated = new InflationAdjustedAuTaxRates(base, 1.04);
  assert.ok(
    Math.abs(inflated._medicareLevy.lowerThreshold - base._medicareLevy.lowerThreshold * 1.04) < 0.01,
  );
  assert.strictEqual(inflated._medicareLevy.rate,        base._medicareLevy.rate);
  assert.strictEqual(inflated._medicareLevy.phaseInRate, base._medicareLevy.phaseInRate);
});

test('INFL-5: inflated AU brackets yield lower tax on same nominal income', () => {
  const base     = new AuTaxRates2025();
  const inflated = new InflationAdjustedAuTaxRates(base, 1.04);
  const state    = auState({ auOrdinaryIncomeYTD: 80_000 });
  const baseTax     = base.computeTax(state).netLiability;
  const inflatedTax = inflated.computeTax(state).netLiability;
  assert.ok(inflatedTax < baseTax, `inflated ${inflatedTax} should be < base ${baseTax}`);
});

test('INFL-5: TaxSettleService returns uninflated tax when accumulator is 1.0', () => {
  const service = new TaxSettleService();
  const state = {
    currentPeriods:       { US: { startMs: Date.UTC(2025, 0, 1) } },
    inflationAccumulator: { US: 1.0 },
    ...usState({ usOrdinaryIncomeYTD: 200_000 }),
  };
  const base   = new UsTaxRates2025();
  const direct = base.computeTax(usState({ usOrdinaryIncomeYTD: 200_000 })).netLiability;
  assert.ok(Math.abs(service.computeUsTax(state).netLiability - direct) < 0.01);
});

test('INFL-5: TaxSettleService applies inflation-adjusted brackets when accumulator > 1', () => {
  const service = new TaxSettleService();
  const incomeState = usState({ usOrdinaryIncomeYTD: 200_000 });
  const noInflation = {
    currentPeriods:       { US: { startMs: Date.UTC(2025, 0, 1) } },
    inflationAccumulator: { US: 1.0 },
    ...incomeState,
  };
  const withInflation = {
    ...noInflation,
    inflationAccumulator: { US: 1.03 ** 3 },  // 3 years of 3% inflation
  };
  const taxBase     = service.computeUsTax(noInflation).netLiability;
  const taxInflated = service.computeUsTax(withInflation).netLiability;
  assert.ok(taxInflated < taxBase,
    `inflated tax ${taxInflated.toFixed(2)} should be < base tax ${taxBase.toFixed(2)}`);
});

test('INFL-5: TaxSettleService applies AU inflation-adjusted brackets when AU accumulator > 1', () => {
  const service = new TaxSettleService();
  const incomeState = auState({ auOrdinaryIncomeYTD: 100_000 });
  const noInflation = {
    currentPeriods:       { AU: { startMs: Date.UTC(2025, 6, 1) } },
    inflationAccumulator: { AU: 1.0 },
    ...incomeState,
  };
  const withInflation = {
    ...noInflation,
    inflationAccumulator: { AU: 1.04 ** 3 },
  };
  const taxBase     = service.computeAuTax(noInflation).netLiability;
  const taxInflated = service.computeAuTax(withInflation).netLiability;
  assert.ok(taxInflated < taxBase,
    `AU inflated tax ${taxInflated.toFixed(2)} should be < base ${taxBase.toFixed(2)}`);
});
