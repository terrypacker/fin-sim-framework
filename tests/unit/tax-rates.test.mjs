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
 * tax-rates.test.mjs
 * Isolated unit tests for TE-1 through TE-8 (Tax Rate requirements).
 *
 * Tests are in two layers:
 *   Classification — verifies tax-module reducers correctly populate the YTD
 *                    accumulators (stage-2 action reducers in UsTaxModule /
 *                    AuTaxModule).
 *   Rates          — verifies the rates-module computeTax() math in isolation
 *                    using synthetic state objects (UsTaxRates* / AuTaxRates*).
 *
 * Run with: node --test tests/unit/tax-rates.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { UsTaxRates2025 } from '../../src/finance/tax/us/us-tax-rates-2025.js';
import { AuTaxRates2025 } from '../../src/finance/tax/au/au-tax-rates-2025.js';
import { UsTaxModule2026 } from '../../src/finance/tax/us/us-tax-module-2026.js';
import { AuTaxModule2026 } from '../../src/finance/tax/au/au-tax-module-2026.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const usRates = new UsTaxRates2025();
const auRates = new AuTaxRates2025();

/** Minimal US-only state for computeTax calls. */
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

/** Minimal AU-only state for computeTax calls. */
function auState(overrides = {}) {
  return {
    isAuResident:               true,
    auOrdinaryIncomeYTD:        0,
    auCapitalGainsYTD:          0,
    auNonResidentWithholdingYTD: 0,
    auSuperTaxYTD:              0,
    auFrankingCreditYTD:        0,
    ...overrides,
  };
}

/** Extract a named reducer fn from a tax module instance. */
function getFn(module, actionType) {
  return module.getReducerFns().get(actionType);
}

// ══════════════════════════════════════════════════════════════════════════════
// TE-1: Superannuation — AU: 15% flat tax on contribution/earnings
// ══════════════════════════════════════════════════════════════════════════════

test('TE-1: super contribution classifier sets auSuperTaxYTD at 15% flat rate', () => {
  const auModule = new AuTaxModule2026();
  const fn = getFn(auModule, 'SUPER_CONTRIBUTION_TAX');
  const s0 = { auSuperTaxYTD: 0 };
  const s1 = fn(s0, { amount: 10000 });
  assert.strictEqual(s1.auSuperTaxYTD, 1500); // 10000 * 0.15
});

test('TE-1: super earnings classifier sets auSuperTaxYTD at 15% flat rate', () => {
  const auModule = new AuTaxModule2026();
  const fn = getFn(auModule, 'SUPER_EARNINGS_TAX');
  const s0 = { auSuperTaxYTD: 0 };
  const s1 = fn(s0, { amount: 20000 });
  assert.strictEqual(s1.auSuperTaxYTD, 3000); // 20000 * 0.15
});

test('TE-1: rates module adds auSuperTaxYTD directly to AU tax result', () => {
  // auSuperTaxYTD is the pre-computed flat tax dollar amount
  const tax = auRates.computeTax(auState({ auSuperTaxYTD: 1500 }));
  assert.strictEqual(tax, 1500);
});

test('TE-1: super tax stacks on top of ordinary income tax', () => {
  // $50k ordinary income + $1500 pre-computed super tax
  const withSuper    = auRates.computeTax(auState({ auOrdinaryIncomeYTD: 50000, auSuperTaxYTD: 1500 }));
  const withoutSuper = auRates.computeTax(auState({ auOrdinaryIncomeYTD: 50000, auSuperTaxYTD: 0 }));
  assert.strictEqual(withSuper - withoutSuper, 1500);
});

// ══════════════════════════════════════════════════════════════════════════════
// TE-2: Non-Resident Withholding — AU: 15% flat rate
// ══════════════════════════════════════════════════════════════════════════════

test('TE-2: NR savings earnings classifier sets auNonResidentWithholdingYTD to gross amount', () => {
  const auModule = new AuTaxModule2026();
  const fn = getFn(auModule, 'AU_SAVINGS_EARNINGS_TAX');
  const s0 = { usOrdinaryIncomeYTD: 0, auOrdinaryIncomeYTD: 0, auNonResidentWithholdingYTD: 0, ftcYTD: 0 };
  const s1 = fn(s0, { amount: 600, isAuResident: false });
  assert.strictEqual(s1.auNonResidentWithholdingYTD, 600);
});

test('TE-2: rates module applies 15% to auNonResidentWithholdingYTD', () => {
  const tax = auRates.computeTax(auState({
    isAuResident:               false,
    auNonResidentWithholdingYTD: 10000,
  }));
  assert.strictEqual(tax, 1500); // 10000 * 0.15
});

test('TE-2: NR withholding rate is exactly 15%', () => {
  const tax1000 = auRates.computeTax(auState({ isAuResident: false, auNonResidentWithholdingYTD: 1000 }));
  const tax5000 = auRates.computeTax(auState({ isAuResident: false, auNonResidentWithholdingYTD: 5000 }));
  assert.strictEqual(tax1000, 150);
  assert.strictEqual(tax5000, 750);
});

// ══════════════════════════════════════════════════════════════════════════════
// TE-3: Ordinary Income — US: brackets minus standard deduction; AU: brackets
// ══════════════════════════════════════════════════════════════════════════════

test('TE-3: US ordinary income below standard deduction produces zero tax', () => {
  // MFJ standard deduction 2025 = $30,000
  const tax = usRates.computeTax(usState({ usOrdinaryIncomeYTD: 20000 }));
  assert.strictEqual(tax, 0);
});

test('TE-3: US ordinary income applies marginal brackets after standard deduction', () => {
  // Taxable income: 100000 - 30000 = 70000
  // [0, 23850] @ 10% = 2385 | [23850, 70000] @ 12% = 46150 * 0.12 = 5538 → total 7923
  const tax = usRates.computeTax(usState({ usOrdinaryIncomeYTD: 100000 }));
  assert.strictEqual(tax, 7923);
});

test('TE-3: US negative income (pre-tax deductions) reduces taxable base', () => {
  // 401k contribution reduces taxable income: 100000 - 20000 - 30000 = 50000
  // [0, 23850] @ 10% = 2385 | [23850, 50000] @ 12% = 26150 * 0.12 = 3138 → 5523
  const tax = usRates.computeTax(usState({ usOrdinaryIncomeYTD: 100000, usNegativeIncomeYTD: 20000 }));
  assert.strictEqual(tax, 5523);
});

test('TE-3: AU ordinary income zero below tax-free threshold', () => {
  // Tax-free threshold = $18,200
  const tax = auRates.computeTax(auState({ auOrdinaryIncomeYTD: 15000 }));
  assert.strictEqual(tax, 0);
});

test('TE-3: AU ordinary income uses progressive brackets with Medicare levy', () => {
  // Income $50,000:
  //   [18200, 45000] @ 19% = 26800 * 0.19 = 5092
  //   [45000, 50000] @ 30% = 5000 * 0.30  = 1500  → baseTax = 6592
  // Medicare: 50000 > 32500 upper threshold → 50000 * 0.02 = 1000
  // Total = 7592
  const tax = auRates.computeTax(auState({ auOrdinaryIncomeYTD: 50000 }));
  assert.strictEqual(tax, 7592);
});

// ══════════════════════════════════════════════════════════════════════════════
// TE-4: Long-Term Capital Gains — US: LTCG brackets; AU: brackets + 50% discount
// ══════════════════════════════════════════════════════════════════════════════

test('TE-4: US LTCG uses preferred rate brackets (0%/15%/20%), not ordinary income brackets', () => {
  // $200k CG: [0, 96700] @ 0% = 0 | [96700, 200000] @ 15% = 103300 * 0.15 = 15495
  const tax = usRates.computeTax(usState({ usCapitalGainsYTD: 200000 }));
  assert.strictEqual(tax, 15495);
});

test('TE-4: US LTCG up to $96,700 is taxed at 0%', () => {
  const tax = usRates.computeTax(usState({ usCapitalGainsYTD: 50000 }));
  assert.strictEqual(tax, 0);
});

test('TE-4: AU capital gains for resident apply 50% CGT discount', () => {
  // $100k CG → discounted income = $50k
  // [18200, 45000] @ 19% = 5092 | [45000, 50000] @ 30% = 1500 → baseTax = 6592
  // Medicare: 50000 > 32500 → 50000 * 0.02 = 1000  → total = 7592
  const tax = auRates.computeTax(auState({ auCapitalGainsYTD: 100000 }));
  assert.strictEqual(tax, 7592);
});

test('TE-4: AU CGT discount is exactly 50% (half the gain is taxable)', () => {
  const taxWithDiscount    = auRates.computeTax(auState({ auCapitalGainsYTD: 100000 }));
  const taxWithoutDiscount = auRates.computeTax(auState({ auOrdinaryIncomeYTD: 50000 }));
  // $100k CG with 50% discount should equal $50k ordinary income (same bracket math)
  assert.strictEqual(taxWithDiscount, taxWithoutDiscount);
});

// ══════════════════════════════════════════════════════════════════════════════
// TE-5: Non-Resident Tax Rates — AU: different brackets, NO 50% CGT discount
// ══════════════════════════════════════════════════════════════════════════════

test('TE-5: AU NR uses flat 32.5% bracket starting from $0 (no tax-free threshold)', () => {
  // $50k income: no tax-free threshold → 50000 * 0.325 = 16250
  const tax = auRates.computeTax(auState({ isAuResident: false, auOrdinaryIncomeYTD: 50000 }));
  assert.strictEqual(tax, 16250);
});

test('TE-5: AU NR capital gains are NOT discounted (full gain taxed via NR brackets)', () => {
  // $100k CG, non-resident: no 50% discount → full 100000 * 0.325 = 32500
  const taxNR       = auRates.computeTax(auState({ isAuResident: false, auCapitalGainsYTD: 100000 }));
  const taxResident = auRates.computeTax(auState({ isAuResident: true,  auCapitalGainsYTD: 100000 }));
  assert.strictEqual(taxNR, 32500);
  assert.ok(taxNR > taxResident, 'NR rate should exceed resident (discounted) rate');
});

test('TE-5: AU NR brackets differ from resident brackets at same income', () => {
  const taxResident = auRates.computeTax(auState({ isAuResident: true,  auOrdinaryIncomeYTD: 50000 }));
  const taxNR       = auRates.computeTax(auState({ isAuResident: false, auOrdinaryIncomeYTD: 50000 }));
  // Resident 7592 (bracket + Medicare) vs NR 16250 (flat 32.5%)
  assert.ok(taxNR > taxResident, 'NR brackets produce higher tax on the same income');
});

// ══════════════════════════════════════════════════════════════════════════════
// TE-6: Franking Credit — AU: offsets ordinary tax (30% corporate tax already paid)
// ══════════════════════════════════════════════════════════════════════════════

test('TE-6: franking credit offsets AU ordinary income tax', () => {
  // $100k ordinary income:
  //   [18200, 45000] @ 19% = 5092 | [45000, 100000] @ 30% = 16500 → baseTax = 21592
  //   Medicare: 100000 * 0.02 = 2000
  //   franking offset: min(10000, 21592) = 10000
  //   net = (21592 - 10000) + 2000 = 13592
  const tax = auRates.computeTax(auState({ auOrdinaryIncomeYTD: 100000, auFrankingCreditYTD: 10000 }));
  assert.strictEqual(tax, 13592);
});

test('TE-6: franking credit is capped at base tax (cannot reduce Medicare levy)', () => {
  // $30k income: baseTax = [18200, 30000] @ 19% = 2242
  // Medicare phase-in: (30000 - 26000) * 0.10 = 400
  // Oversized franking credit: min(100000, 2242) = 2242 offsets all base tax
  // Net = (2242 - 2242) + 400 = 400
  const tax = auRates.computeTax(auState({ auOrdinaryIncomeYTD: 30000, auFrankingCreditYTD: 100000 }));
  assert.strictEqual(tax, 400);
});

test('TE-6: franking credit classifier populates auFrankingCreditYTD', () => {
  const auModule = new AuTaxModule2026();
  const fn = getFn(auModule, 'AU_DIVIDEND_FRANKED_RESIDENT_TAX');
  const s0 = { usOrdinaryIncomeYTD: 0, auFrankingCreditYTD: 0, ftcYTD: 0 };
  const s1 = fn(s0, { amount: 5000 });
  assert.strictEqual(s1.auFrankingCreditYTD, 5000);
  assert.strictEqual(s1.usOrdinaryIncomeYTD, 5000); // also US ordinary income
});

// ══════════════════════════════════════════════════════════════════════════════
// TE-7: Collectibles — US: 28% flat rate; AU: ordinary capital gains treatment
// ══════════════════════════════════════════════════════════════════════════════

test('TE-7: US collectible sale classifier populates usCollectibleGainsYTD', () => {
  const usModule = new UsTaxModule2026();
  const fn = getFn(usModule, 'COLLECTIBLE_SALE_TAX');
  const s0 = { usCollectibleGainsYTD: 0, auCapitalGainsYTD: 0, ftcYTD: 0 };
  const s1 = fn(s0, { gain: 10000, isAuResident: false });
  assert.strictEqual(s1.usCollectibleGainsYTD, 10000);
});

test('TE-7: US rates module applies 28% to collectible gains', () => {
  // $10k collectible gain → 10000 * 0.28 = 2800
  const tax = usRates.computeTax(usState({ usCollectibleGainsYTD: 10000 }));
  assert.strictEqual(Math.round(tax * 100) / 100, 2800);
});

test('TE-7: US collectible rate is distinct from LTCG rate (28% vs 15%)', () => {
  const collectibleTax = usRates.computeTax(usState({ usCollectibleGainsYTD: 100000 }));
  const ltcgTax        = usRates.computeTax(usState({ usCapitalGainsYTD:      100000 }));
  // 100k collectibles: 28000 | 100k LTCG: [0,96700] @ 0% + [96700,100000] @ 15% = 495
  assert.strictEqual(Math.round(collectibleTax * 100) / 100, 28000);
  assert.ok(collectibleTax > ltcgTax, 'collectible 28% rate exceeds LTCG 0%/15% on same amount');
});

test('TE-7: AU collectible gains use capital gains treatment (50% CGT discount)', () => {
  // AU treats collectibles as capital gains — auCapitalGainsYTD is the vehicle
  // $100k AU CG → discounted $50k → same as TE-4 resident test → 7592
  const tax = auRates.computeTax(auState({ auCapitalGainsYTD: 100000 }));
  assert.strictEqual(tax, 7592);
});

// ══════════════════════════════════════════════════════════════════════════════
// TE-8: Social Security Income — US: 85% taxable; AU: full ordinary income
// ══════════════════════════════════════════════════════════════════════════════

test('TE-8: SS income classifier applies 85% rule to US ordinary income', () => {
  const usModule = new UsTaxModule2026();
  const fn = getFn(usModule, 'SS_INCOME_TAX');
  const s0 = { usOrdinaryIncomeYTD: 0, auOrdinaryIncomeYTD: 0, ftcYTD: 0 };
  const s1 = fn(s0, { amount: 100000, isAuResident: false });
  assert.strictEqual(s1.usOrdinaryIncomeYTD, 85000); // 100000 * 0.85
});

test('TE-8: SS income classifier adds full amount to AU ordinary income for AU residents', () => {
  const usModule = new UsTaxModule2026();
  const fn = getFn(usModule, 'SS_INCOME_TAX');
  const s0 = { usOrdinaryIncomeYTD: 0, auOrdinaryIncomeYTD: 0, ftcYTD: 0 };
  const s1 = fn(s0, { amount: 100000, isAuResident: true });
  assert.strictEqual(s1.usOrdinaryIncomeYTD, 85000);  // 85% for US
  assert.strictEqual(s1.auOrdinaryIncomeYTD, 100000); // 100% for AU ordinary income
});

test('TE-8: US rates module taxes SS income at ordinary brackets on the 85% taxable portion', () => {
  // $100k SS → taxable US income = $85k; std deduction = $30k; taxable = $55k
  // [0, 23850] @ 10% = 2385 | [23850, 55000] @ 12% = 31150 * 0.12 = 3738 → 6123
  const tax = usRates.computeTax(usState({ usOrdinaryIncomeYTD: 85000 }));
  assert.strictEqual(tax, 6123);
});

test('TE-8: only 85% of SS benefit flows to US taxable income (not 100%)', () => {
  const usModule = new UsTaxModule2026();
  const fn = getFn(usModule, 'SS_INCOME_TAX');
  const s0 = { usOrdinaryIncomeYTD: 0, auOrdinaryIncomeYTD: 0, ftcYTD: 0 };
  const s1 = fn(s0, { amount: 1000, isAuResident: false });
  // Verify it's not 100% (full $1000) or 0% (exempt)
  assert.strictEqual(s1.usOrdinaryIncomeYTD, 850);
  assert.notEqual(s1.usOrdinaryIncomeYTD, 1000);
});
