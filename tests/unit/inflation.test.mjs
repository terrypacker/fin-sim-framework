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
import { StateTaxSettleService } from '../../src/finance/tax/state/state-tax-settle-service.js';
import { UsTaxRates2025 } from '../../src/finance/tax/us/us-tax-rates-2025.js';
import { AuTaxRates2025 } from '../../src/finance/tax/au/au-tax-rates-2025.js';
import { TaxSettleService } from '../../src/finance/tax-settle-service.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const US_PERIOD_2027 = { type: 'US_PERIOD_ADVANCE', period: { startMs: Date.UTC(2027, 0, 1) } };
const AU_PERIOD_2027 = { type: 'AU_PERIOD_ADVANCE', period: { startMs: Date.UTC(2027, 6, 1) } };

function baseState(overrides = {}) {
  return {
    inflationRates:       { US: 0.03, AU: 0.03 },
    inflationAccumulator: { US: 1.0,  AU: 1.0  },
    people: {
      primary: { monthlyWage: 8_000, socialSecurityMonthly: 2_800, residency: 'US' },
      spouse:  { monthlyWage: 4_000, socialSecurityMonthly: 1_500, residency: 'US' },
    },
    monthlyExpenses: 6_000,
    ...overrides,
  };
}

function auBaseState(overrides = {}) {
  return {
    ...baseState(overrides),
    people: {
      primary: { monthlyWage: 8_000, socialSecurityMonthly: 2_800, residency: 'AU' },
      spouse:  { monthlyWage: 4_000, socialSecurityMonthly: 1_500, residency: 'AU' },
    },
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
    people: { primary: { residency: 'AU' } },
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
  const action2027 = { type: 'US_PERIOD_ADVANCE', period: { startMs: Date.UTC(2027, 0, 1) } };
  const action2028 = { type: 'US_PERIOD_ADVANCE', period: { startMs: Date.UTC(2028, 0, 1) } };
  const action2029 = { type: 'US_PERIOD_ADVANCE', period: { startMs: Date.UTC(2029, 0, 1) } };

  state = reducer.reduce(state, action2027);
  state = reducer.reduce(state, action2028);
  state = reducer.reduce(state, action2029);

  // After 3 years at 3%: 1.03^3 ≈ 1.092727
  const expected = 1.03 ** 3;
  assert.ok(Math.abs(state.inflationAccumulator.US - expected) < 1e-10);
});

// ══════════════════════════════════════════════════════════════════════════════
// INFL-6: Dedicated ATO CPI indexation series (design 57 Part 2, Item A)
// ══════════════════════════════════════════════════════════════════════════════

test('INFL-6: cpiAccumulator tracks inflationAccumulator when cpiRates is unset', () => {
  const state = baseState({ inflationRates: { US: 0.025, AU: 0.035 } });
  const next = reducer.reduce(state, AU_PERIOD_2027);
  // No cpiRates.AU ⇒ CPI falls back to the effective inflation rate ⇒ identical.
  assert.ok(Math.abs(next.cpiAccumulator.AU - next.inflationAccumulator.AU) < 1e-12);
  assert.ok(Math.abs(next.cpiAccumulator.AU - 1.035) < 1e-10);
});

test('INFL-6: cpiAccumulator compounds at a distinct cpiRates.AU', () => {
  const state = baseState({
    inflationRates: { US: 0.03, AU: 0.03 },
    cpiRates:       { AU: 0.05 },
  });
  const next = reducer.reduce(state, AU_PERIOD_2027);
  assert.ok(Math.abs(next.inflationAccumulator.AU - 1.03) < 1e-10);
  assert.ok(Math.abs(next.cpiAccumulator.AU - 1.05) < 1e-10);
  // Distinct series diverge.
  assert.ok(next.cpiAccumulator.AU > next.inflationAccumulator.AU);
});

test('INFL-6: distinct AU CPI compounds even when AU inflation is zero', () => {
  const state = baseState({
    inflationRates: { US: 0.03, AU: 0.0 },
    cpiRates:       { AU: 0.04 },
  });
  const next = reducer.reduce(state, AU_PERIOD_2027);
  assert.strictEqual(next.inflationAccumulator.AU, 1.0);
  assert.ok(Math.abs(next.cpiAccumulator.AU - 1.04) < 1e-10);
});

test('INFL-6: cpiAccumulator compounds across multiple AU advances', () => {
  let state = baseState({ inflationRates: { US: 0.03, AU: 0.03 }, cpiRates: { AU: 0.05 } });
  state = reducer.reduce(state, { type: 'AU_PERIOD_ADVANCE', period: { startMs: Date.UTC(2032, 6, 1) } });
  state = reducer.reduce(state, { type: 'AU_PERIOD_ADVANCE', period: { startMs: Date.UTC(2033, 6, 1) } });
  assert.ok(Math.abs(state.cpiAccumulator.AU - 1.05 ** 2) < 1e-10);
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
    state = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE', period: { startMs: Date.UTC(yr, 0, 1) } });
  }
  const expected = 8_000 * 1.05 ** 5;
  assert.ok(Math.abs(state.people.primary.monthlyWage - expected) < 0.01);
});

// ══════════════════════════════════════════════════════════════════════════════
// INFL-4: Expenses — increases at country-of-residence rate
// ══════════════════════════════════════════════════════════════════════════════

test('INFL-4: expenses inflate at US rate when US resident on US PERIOD_ADVANCE', () => {
  const state = baseState();
  const next = reducer.reduce(state, US_PERIOD_2027);
  assert.ok(Math.abs(next.monthlyExpenses - 6_000 * 1.03) < 0.01);
});

test('INFL-4: expenses inflate at the residence (AU) rate on the US advance when AU resident', () => {
  // Transition-skip fix: expenses ride the annual US advance (which always fires)
  // at the *residence* country's rate, so a mid-year US→AU move can't drop a year's
  // increment at the US(Jan)→AU(Jul) period handoff.
  const state = auBaseState({ inflationRates: { US: 0.03, AU: 0.04 } });
  const next = reducer.reduce(state, US_PERIOD_2027);
  assert.ok(Math.abs(next.monthlyExpenses - 6_000 * 1.04) < 0.01); // residence (AU) rate
});

test('INFL-4: AU PERIOD_ADVANCE no longer adjusts expenses (they ride the US advance)', () => {
  const state = auBaseState({ inflationRates: { US: 0.03, AU: 0.04 } });
  const next = reducer.reduce(state, AU_PERIOD_2027);
  assert.strictEqual(next.monthlyExpenses, 6_000); // unchanged on the AU advance
});

test('INFL-4: AU PERIOD_ADVANCE does NOT adjust expenses when US resident', () => {
  const state = baseState();
  const next = reducer.reduce(state, AU_PERIOD_2027);
  assert.strictEqual(next.monthlyExpenses, 6_000);
});

test('INFL-4: expenses compound across a US→AU residency switch without dropping a year', () => {
  let state = baseState({ inflationRates: { US: 0.03, AU: 0.04 } });

  // Two US-resident years at the US rate (driven by the annual US advance).
  state = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE', period: { startMs: Date.UTC(2027, 0, 1) } });
  state = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE', period: { startMs: Date.UTC(2028, 0, 1) } });

  // Switch to AU residency (flip all people to AU)
  state = {
    ...state,
    people: Object.fromEntries(
      Object.entries(state.people).map(([k, p]) => [k, { ...p, residency: 'AU' }])
    ),
  };

  // Two AU-resident years at the AU rate — still driven by the US advance, so the
  // transition year is not skipped (the bug this fix targets).
  state = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE', period: { startMs: Date.UTC(2029, 0, 1) } });
  state = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE', period: { startMs: Date.UTC(2030, 0, 1) } });

  const expected = 6_000 * 1.03 ** 2 * 1.04 ** 2;
  assert.ok(Math.abs(state.monthlyExpenses - expected) < 0.01);
});

test('INFL-4: a mid-year US→AU move drops no expense increment (regression)', () => {
  // Before the fix, the post-move US advance was skipped (residence already AU)
  // while the AU period had not completed a cycle, losing one year's inflation
  // permanently. Now every annual US advance inflates at the residence rate.
  const rates = { US: 0.03, AU: 0.03 };
  const advance = (s, y) => reducer.reduce(s, { type: 'US_PERIOD_ADVANCE', period: { startMs: Date.UTC(y, 0, 1) } });
  // No move: three US advances.
  let stay = baseState({ inflationRates: rates });
  for (const y of [2027, 2028, 2029]) stay = advance(stay, y);
  // Move: AU residency from the second advance on; same three advances.
  let move = baseState({ inflationRates: rates });
  move = advance(move, 2027);
  move = { ...move, people: Object.fromEntries(Object.entries(move.people).map(([k, p]) => [k, { ...p, residency: 'AU' }])) };
  move = advance(move, 2028);
  move = advance(move, 2029);
  // Equal rates → identical expenses; no dropped step at the residency change.
  assert.ok(Math.abs(move.monthlyExpenses - stay.monthlyExpenses) < 0.01);
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

// ══════════════════════════════════════════════════════════════════════════════
// INFL-6: Published tables are anchored at their OWN year, not at sim start
//
// A rates module carries the authority's own indexation up to its year. Indexing
// it from sim start therefore double-counts every year in between. Three separate
// symptoms of the one anchor bug, all fixed by `bracketIndexationFactor`:
//
//   (a) AU registers tables through FY2027-28 while an AU period commonly starts
//       at FY2025-26, so the two legislated future tables were inflated on top of
//       their own indexation — and, worse, the offset never washed out: every
//       later year rode a 2027 table pre-inflated by the sim's first two years.
//   (b) US tables were only coincidentally right (the newest, 2026, IS the sim's
//       usual first year); a run starting in 2025 double-indexed the 2026 table.
//   (c) US state tables got no wrap at all, so a 40-year run applied fixed nominal
//       thresholds to nominal income — bracket creep as a pure artefact.
// ══════════════════════════════════════════════════════════════════════════════

/** Bracket-index history for a run at a constant `rate` starting in `startYear`. */
function levelsFrom(startYear, endYear, rate = 0.03) {
  const out = {};
  let level = 1.0;
  for (let y = startYear; y <= endYear; y++) { out[y] = level; level *= 1 + rate; }
  return out;
}

test('INFL-6a: the reducer records the price level under the period year it belongs to', () => {
  const reducer = new InflationAdjustReducer();
  // First advance self-seeds the sim's first year at 1.0 from the pre-advance
  // accumulator, so no separate seeding site is needed.
  const after2027 = reducer.reduce(
    { ...baseState(), currentPeriods: { US: { startMs: Date.UTC(2027, 0, 1) } } },
    US_PERIOD_2027,
  );
  assert.equal(after2027.bracketIndexAccumulatorByYear.US[2026], 1.0);
  assert.ok(Math.abs(after2027.bracketIndexAccumulatorByYear.US[2027] - 1.03) < 1e-12);

  const after2028 = reducer.reduce(
    { ...after2027, currentPeriods: { US: { startMs: Date.UTC(2028, 0, 1) } } },
    { type: 'US_PERIOD_ADVANCE', period: { startMs: Date.UTC(2028, 0, 1) } },
  );
  assert.equal(after2028.bracketIndexAccumulatorByYear.US[2026], 1.0, 'earlier years are not rewritten');
  assert.ok(Math.abs(after2028.bracketIndexAccumulatorByYear.US[2028] - 1.03 ** 2) < 1e-12);
});

test('INFL-6a: AU records the FINANCIAL-year start year, matching currentPeriods.AU', () => {
  const reducer = new InflationAdjustReducer();
  const after = reducer.reduce(
    { ...auBaseState(), currentPeriods: { AU: { startMs: Date.UTC(2027, 6, 1) } } },
    AU_PERIOD_2027,
  );
  assert.equal(after.bracketIndexAccumulatorByYear.AU[2026], 1.0, 'FY2026-27 keyed by its start year');
  assert.ok(Math.abs(after.bracketIndexAccumulatorByYear.AU[2027] - 1.03) < 1e-12);
});

test('INFL-6a: AU FY2026-27 and FY2027-28 use their STATUTORY thresholds, not inflated ones', () => {
  const service = new TaxSettleService();
  const levels  = { AU: levelsFrom(2025, 2035) };   // AU sim starts FY2025-26
  for (const fy of [2025, 2026, 2027]) {
    const module = service._getModule('AU', {
      currentPeriods:             { AU: { startMs: Date.UTC(fy, 6, 1) } },
      bracketIndexAccumulator:       { AU: levels.AU[fy] },
      bracketIndexAccumulatorByYear: levels,
    });
    const statutory = service.ratesForYear('AU', fy);
    assert.equal(module.year, fy, `FY${fy} selects its own table`);
    assert.deepEqual(module._brackets, statutory._brackets,
      `FY${fy}-${String(fy + 1).slice(2)} is legislated — its thresholds must be used as published`);
    assert.equal(module._medicareLevy.lowerThreshold, statutory._medicareLevy.lowerThreshold);
  }
});

test('INFL-6a: AU indexes from the 2027 table\'s OWN year once past the published horizon', () => {
  const service = new TaxSettleService();
  const levels  = { AU: levelsFrom(2025, 2035) };
  const top2027 = service.ratesForYear('AU', 2027)._brackets.at(-1)[0];

  const at2029 = service._getModule('AU', {
    currentPeriods:             { AU: { startMs: Date.UTC(2029, 6, 1) } },
    bracketIndexAccumulator:       { AU: levels.AU[2029] },
    bracketIndexAccumulatorByYear: levels,
  });
  // Two years past FY2027-28, not four past the sim's first year.
  assert.ok(Math.abs(at2029._brackets.at(-1)[0] - top2027 * 1.03 ** 2) < 0.01,
    `expected ${(top2027 * 1.03 ** 2).toFixed(0)}, got ${at2029._brackets.at(-1)[0].toFixed(0)}`);
});

test('INFL-6b: a US run starting in 2025 does not double-index the 2026 table', () => {
  const service = new TaxSettleService();
  const levels  = { US: levelsFrom(2025, 2035) };   // US sim starts in 2025
  const module  = service._getModule('US', {
    currentPeriods:             { US: { startMs: Date.UTC(2026, 0, 1) } },
    bracketIndexAccumulator:       { US: levels.US[2026] },   // 1.03 — a year has elapsed
    bracketIndexAccumulatorByYear: levels,
  });
  const statutory = service.ratesForYear('US', 2026);
  assert.equal(module.year, 2026);
  assert.deepEqual(module._brackets_mfj, statutory._brackets_mfj,
    'Rev. Proc. 2025-32 already indexed these; the sim must not index them again');
  assert.equal(module._stdDeduction_mfj, statutory._stdDeduction_mfj);
});

test('INFL-6: no recorded history degrades to the old sim-start anchor rather than breaking', () => {
  const service = new TaxSettleService();
  const module  = service._getModule('US', {
    currentPeriods:       { US: { startMs: Date.UTC(2030, 0, 1) } },
    inflationAccumulator: { US: 1.03 ** 4 },
    // No bracket series at all — an old snapshot, which must fall back to the
    // inflation accumulator rather than silently un-indexing every table.
  });
  const statutory = service.ratesForYear('US', 2030);
  assert.ok(Math.abs(module._stdDeduction_mfj - statutory._stdDeduction_mfj * 1.03 ** 4) < 0.01);
});

// ══════════════════════════════════════════════════════════════════════════════
// INFL-7: Bracket indexation is CPI + a per-series SPREAD
//
// Projecting a table past its published horizon means assuming how thresholds move,
// and outside US §1(f) that assumption is not law — neither the AU federal brackets
// nor Hawaii's or Nebraska's are statutorily indexed. The spread makes the
// assumption editable; expressed as a spread rather than an absolute rate so 0 means
// "track CPI" and the projection follows whatever inflation path the run takes.
// ══════════════════════════════════════════════════════════════════════════════

/** Advance `cc` one year to `year`, returning the new state. */
function advanceYear(state, cc, year) {
  const period = { startMs: cc === 'AU' ? Date.UTC(year, 6, 1) : Date.UTC(year, 0, 1) };
  return new InflationAdjustReducer().reduce(
    { ...state, currentPeriods: { ...state.currentPeriods, [cc]: period } },
    { type: `${cc}_PERIOD_ADVANCE`, period },
  );
}

test('INFL-7: an unset spread is exactly CPI — the three series track the accumulator', () => {
  let s = { ...baseState(), currentPeriods: { US: { startMs: Date.UTC(2026, 0, 1) } } };
  for (const y of [2027, 2028, 2029]) s = advanceYear(s, 'US', y);
  assert.ok(Math.abs(s.bracketIndexAccumulator.US       - s.inflationAccumulator.US) < 1e-12);
  assert.ok(Math.abs(s.bracketIndexAccumulator.US_STATE - s.inflationAccumulator.US) < 1e-12);
});

test('INFL-7: the spread is ADDED to the realised rate, not substituted for it', () => {
  let s = {
    ...baseState(),
    currentPeriods:      { US: { startMs: Date.UTC(2026, 0, 1) } },
    bracketIndexSpreads: { US: 0.01 },     // brackets outpace CPI by a point
  };
  s = advanceYear(s, 'US', 2027);
  assert.ok(Math.abs(s.bracketIndexAccumulator.US - 1.04) < 1e-12, 'CPI 3% + spread 1%');
  assert.ok(Math.abs(s.inflationAccumulator.US   - 1.03) < 1e-12, 'wages still ride plain CPI');
  // A spread on one series must not leak into another.
  assert.ok(Math.abs(s.bracketIndexAccumulator.US_STATE - 1.03) < 1e-12);
});

test('INFL-7: the spread follows the REALISED rate, so regimes carry through', () => {
  // A regime year at 6% rather than the configured 3%: the bracket series must ride
  // 6% + spread, which is the whole reason this is a spread and not a fixed rate.
  let s = {
    ...baseState(),
    currentPeriods:          { US: { startMs: Date.UTC(2026, 0, 1) } },
    effectiveInflationRates: { US: 0.06 },
    bracketIndexSpreads:     { US: 0.01 },
  };
  s = advanceYear(s, 'US', 2027);
  assert.ok(Math.abs(s.bracketIndexAccumulator.US - 1.07) < 1e-12);
});

test('INFL-7: a spread of −CPI freezes the brackets (the AU/HI/NE statutory outcome)', () => {
  const service = new TaxSettleService();
  let s = {
    ...auBaseState(),
    currentPeriods:      { AU: { startMs: Date.UTC(2025, 6, 1) } },
    bracketIndexSpreads: { AU: -0.03 },   // exactly cancels the 3% inflation rate
  };
  for (const y of [2026, 2027, 2028, 2029, 2030]) s = advanceYear(s, 'AU', y);
  assert.ok(Math.abs(s.bracketIndexAccumulator.AU - 1.0) < 1e-12, 'the series never moves');
  assert.ok(s.inflationAccumulator.AU > 1.15, 'while wages and prices carry on');

  const module = service._getModule('AU', s);
  assert.deepEqual(module._brackets, service.ratesForYear('AU', 2027)._brackets,
    'a frozen series leaves the FY2027-28 table at its nominal thresholds forever');
});

test('INFL-7: a frozen bracket series really does raise tax on constant REAL income', () => {
  const service = new TaxSettleService();
  const realIncome = 120_000;
  const taxRateIn = (spread, years) => {
    let s = {
      ...auBaseState(),
      currentPeriods:      { AU: { startMs: Date.UTC(2025, 6, 1) } },
      bracketIndexSpreads: { AU: spread },
    };
    for (let i = 1; i <= years; i++) s = advanceYear(s, 'AU', 2025 + i);
    const nominal = realIncome * s.inflationAccumulator.AU;
    const module  = service._getModule('AU', s);
    return module.computeTax(auState({ auOrdinaryIncomeYTD: nominal })).netLiability / nominal;
  };
  const indexed = taxRateIn(0,     12);
  const frozen  = taxRateIn(-0.03, 12);
  assert.ok(frozen > indexed + 0.01,
    `bracket creep should bite: frozen ${frozen.toFixed(4)} vs indexed ${indexed.toFixed(4)}`);
});

test('INFL-7: the US_STATE series is independent of the federal one', () => {
  const fed   = new TaxSettleService();
  const state = new StateTaxSettleService();
  let s = {
    ...baseState({ people: { p1: { residency: 'US', residencyState: 'HI',
                                   monthlyWage: 0, socialSecurityMonthly: 0 } } }),
    currentPeriods:      { US: { startMs: Date.UTC(2026, 0, 1) } },
    // Federal keeps pace; the states freeze — the realistic asymmetry, since §1(f)
    // indexes federal brackets and neither HI nor NE indexes anything.
    bracketIndexSpreads: { US: 0, US_STATE: -0.03 },
  };
  for (let y = 2027; y <= 2040; y++) s = advanceYear(s, 'US', y);

  assert.ok(Math.abs(s.bracketIndexAccumulator.US_STATE - 1.0) < 1e-12);
  assert.ok(s.bracketIndexAccumulator.US > 1.5);

  assert.equal(state._getModule('HI', s), state._modules.HI_2031,
    'a frozen state series leaves the terminal HI table entirely unwrapped');
  assert.ok(fed._getModule('US', s)._stdDeduction_mfj
              > fed.ratesForYear('US', 2026)._stdDeduction_mfj * 1.4,
    'while the federal table keeps indexing');
});

test('INFL-7: a zero-CPI run still advances a series carrying a positive spread', () => {
  // The early-return guard tests every series, not just the wage rate: a run with no
  // inflation but a positive bracket spread must not be silently frozen.
  const s = advanceYear({
    ...baseState({ inflationRates: { US: 0, AU: 0 } }),
    cpiRates:            { US: 0 },
    currentPeriods:      { US: { startMs: Date.UTC(2026, 0, 1) } },
    bracketIndexSpreads: { US: 0.02 },
  }, 'US', 2027);
  assert.ok(Math.abs(s.bracketIndexAccumulator.US - 1.02) < 1e-12);
});

test('INFL-7: the three params reach state and drive real tax through a compiled scenario', async () => {
  const { loadScenarioSim } = await import('../helpers/scenario-harness.js');

  const runTo = (params) => loadScenarioSim({
    params, simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2045, 0, 1)),
    stepTo: new Date(Date.UTC(2044, 11, 31)), telemetry: 'none',
  }).sim.state;

  // Defaults: every spread present and zero, and the bracket series tracking CPI.
  const base = runTo({});
  assert.deepEqual(base.bracketIndexSpreads,
    { US: 0, US_FICA: 0, US_FEIE: 0, US_STATE: 0, AU: 0 },
    'all three toolsets must survive the compiler merge, not clobber each other');
  assert.ok(Math.abs(base.bracketIndexAccumulator.US - base.inflationAccumulator.US) < 1e-9);

  // Frozen brackets everywhere: more tax on the same plan, and the series stay flat.
  const frozen = runTo({
    usFederalBracketIndexSpread: -0.03,
    usStateBracketIndexSpread:   -0.03,
    auBracketIndexSpread:        -0.03,
  });
  assert.deepEqual(frozen.bracketIndexSpreads,
    { US: -0.03, US_FICA: 0, US_FEIE: 0, US_STATE: -0.03, AU: -0.03 },
    'freezing the brackets must NOT drag the FICA base or the FEIE cap along');
  assert.ok(Math.abs(frozen.bracketIndexAccumulator.US - 1.0) < 1e-9);
  assert.ok(Math.abs(frozen.bracketIndexAccumulator.AU - 1.0) < 1e-9);
  assert.ok(frozen.cumulativeTaxesPaid > base.cumulativeTaxesPaid,
    `bracket creep must cost money: frozen ${frozen.cumulativeTaxesPaid.toFixed(0)} `
    + `vs indexed ${base.cumulativeTaxesPaid.toFixed(0)}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// INFL-8: FICA wage base and FEIE cap ride their OWN series
//
// Both used to ride the bracket factor, which was invisible while that factor was
// simply CPI and became wrong the moment brackets got a projection of their own.
// They are indexed by different mechanisms in law — the §3121(a)(1) base by the SSA
// average wage index, the §911 cap by chained CPI under a separate act of Congress —
// so a scenario modelling bracket creep must be able to leave both alone.
// ══════════════════════════════════════════════════════════════════════════════

/** Run `years` US advances from 2026 with the given spreads, returning end state. */
function usRun(bracketIndexSpreads, years = 14) {
  let s = { ...baseState(), currentPeriods: { US: { startMs: Date.UTC(2026, 0, 1) } },
            bracketIndexSpreads };
  for (let y = 2027; y <= 2026 + years; y++) s = advanceYear(s, 'US', y);
  return s;
}

test('INFL-8: freezing the brackets leaves the FICA base and FEIE cap indexing', () => {
  const service   = new TaxSettleService();
  const statutory = service.ratesForYear('US', 2026);
  const module    = service._getModule('US', usRun({ US: -0.03 }));   // brackets frozen only

  assert.deepEqual(module._brackets_mfj, statutory._brackets_mfj, 'brackets held nominal');
  assert.equal(module._stdDeduction_mfj, statutory._stdDeduction_mfj);
  assert.ok(module._ficaWageBase > statutory._ficaWageBase * 1.4,
    'the wage base is a separate act of Congress and must keep moving');
  assert.ok(module._feieCap      > statutory._feieCap      * 1.4,
    'so is the FEIE cap');
});

test('INFL-8: a FICA spread moves the wage base and nothing else', () => {
  const service   = new TaxSettleService();
  const statutory = service.ratesForYear('US', 2026);
  const plain     = service._getModule('US', usRun({}));
  // +0.5% for real wage growth: the SSA average wage index runs above CPI.
  const withAwi   = service._getModule('US', usRun({ US_FICA: 0.005 }));

  assert.ok(withAwi._ficaWageBase > plain._ficaWageBase * 1.05);
  assert.deepEqual(withAwi._brackets_mfj, plain._brackets_mfj, 'brackets untouched');
  assert.equal(withAwi._feieCap,          plain._feieCap,      'FEIE cap untouched');
  assert.ok(plain._ficaWageBase > statutory._ficaWageBase, 'and CPI alone still indexes it');
});

test('INFL-8: a FEIE spread moves the exclusion cap and nothing else', () => {
  const service = new TaxSettleService();
  const plain   = service._getModule('US', usRun({}));
  const frozen  = service._getModule('US', usRun({ US_FEIE: -0.03 }));

  assert.equal(frozen._feieCap, service.ratesForYear('US', 2026)._feieCap, 'cap held nominal');
  assert.deepEqual(frozen._brackets_mfj, plain._brackets_mfj);
  assert.equal(frozen._ficaWageBase,     plain._ficaWageBase);
});

test('INFL-8: the wrapper still accepts a scalar factor for all three figures', () => {
  const base   = new UsTaxRates2025();
  const scalar = new InflationAdjustedUsTaxRates(base, 1.1);
  assert.ok(Math.abs(scalar._ficaWageBase - base._ficaWageBase * 1.1) < 0.01);
  assert.ok(Math.abs(scalar._feieCap      - base._feieCap      * 1.1) < 0.01);
  assert.ok(Math.abs(scalar._stdDeduction_mfj - base._stdDeduction_mfj * 1.1) < 0.01);
});

test('INFL-8: payroll withholding and the annual charge use the SAME projected base', async () => {
  // The invariant fica-rates.js's header exists to protect. Before the split, the
  // settle indexed `_ficaWageBase` while `ficaWageBase(taxYear)` clamped flat at the
  // last SSA announcement, so from 2027 on a high earner was withheld on a smaller
  // base than they were charged on — a balance due every year that reads as rounding.
  const { ficaOnWage, LAST_PUBLISHED_FICA_YEAR, FICA_SS_RATE }
    = await import('../../src/finance/tax/us/fica-rates.js');
  const { bracketIndexationFactor, BRACKET_INDEX_SERIES }
    = await import('../../src/finance/tax/inflation-adjusted-tax-rates.js');
  const service = new TaxSettleService();

  for (const spread of [0, 0.005, -0.03]) {
    const s      = usRun(spread === 0 ? {} : { US_FICA: spread });
    const module = service._getModule('US', s);
    const factor = bracketIndexationFactor(s, BRACKET_INDEX_SERIES.US_FICA,
                                           LAST_PUBLISHED_FICA_YEAR);
    // Withhold on a wage that comfortably exceeds the base, in one lump.
    const withheldSs = ficaOnWage(10_000_000, 0, 2040, factor).ss;
    assert.ok(Math.abs(withheldSs - module._ficaWageBase * FICA_SS_RATE) < 0.02,
      `spread ${spread}: withheld on ${(withheldSs / FICA_SS_RATE).toFixed(0)} `
      + `but charged on ${module._ficaWageBase.toFixed(0)}`);
  }
});

test('INFL-8: published SSA years are still transcribed exactly', async () => {
  const { ficaWageBase, FICA_WAGE_BASE_BY_YEAR }
    = await import('../../src/finance/tax/us/fica-rates.js');
  for (const [year, base] of Object.entries(FICA_WAGE_BASE_BY_YEAR)) {
    assert.equal(ficaWageBase(Number(year)), base, `SSA published ${year}; do not project it`);
  }
});
