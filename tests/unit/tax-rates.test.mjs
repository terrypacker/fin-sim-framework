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
import { UsTaxRates2026 } from '../../src/finance/tax/us/us-tax-rates-2026.js';
import { AuTaxRates2025 } from '../../src/finance/tax/au/au-tax-rates-2025.js';
import { AuTaxRates2026 } from '../../src/finance/tax/au/au-tax-rates-2026.js';
import { AuTaxRates2027 } from '../../src/finance/tax/au/au-tax-rates-2027.js';
import { UsTaxModule2026 } from '../../src/finance/tax/us/us-tax-module-2026.js';
import { AuTaxModule2026 } from '../../src/finance/tax/au/au-tax-module-2026.js';
import { AuTaxModule2027 } from '../../src/finance/tax/au/au-tax-module-2027.js';
import { TaxSettleService } from '../../src/finance/tax-settle-service.js';

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

/** Minimal AU-only state for computeTax calls. Defaults to AU resident. */
function auState(overrides = {}) {
  return {
    people: { primary: { residency: 'AU' } },
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
  const { netLiability } = auRates.computeTax(auState({ auSuperTaxYTD: 1500 }));
  assert.strictEqual(netLiability, 1500);
});

test('TE-1: super tax stacks on top of ordinary income tax', () => {
  // $50k ordinary income + $1500 pre-computed super tax
  const withSuper    = auRates.computeTax(auState({ auOrdinaryIncomeYTD: 50000, auSuperTaxYTD: 1500 })).netLiability;
  const withoutSuper = auRates.computeTax(auState({ auOrdinaryIncomeYTD: 50000, auSuperTaxYTD: 0 })).netLiability;
  assert.strictEqual(withSuper - withoutSuper, 1500);
});

// ══════════════════════════════════════════════════════════════════════════════
// TE-2: Non-Resident Withholding — AU: 15% flat rate
// ══════════════════════════════════════════════════════════════════════════════

test('TE-2: NR savings earnings classifier books gross interest to the interest withholding bucket', () => {
  // Design 73 Gap 2: interest is withheld at its own Art 11(2) rate (10%), so it
  // books to the typed accumulator, not the undifferentiated 15% pool.
  const auModule = new AuTaxModule2026();
  const fn = getFn(auModule, 'AU_SAVINGS_EARNINGS_TAX');
  const s0 = { usOrdinaryIncomeYTD: 0, auOrdinaryIncomeYTD: 0, auNrWithholdingInterestYTD: 0, ftcYTD: 0 };
  const s1 = fn(s0, { amount: 600, residency: null });
  assert.strictEqual(s1.auNrWithholdingInterestYTD, 600);
});

test('TE-2: rates module applies 15% to auNonResidentWithholdingYTD', () => {
  const { netLiability } = auRates.computeTax(auState({
    people: { primary: { residency: 'US' } },
    auNonResidentWithholdingYTD: 10000,
  }));
  assert.strictEqual(netLiability, 1500); // 10000 * 0.15
});

test('TE-2: NR withholding rate is exactly 15%', () => {
  const tax1000 = auRates.computeTax(auState({ people: { primary: { residency: 'US' } }, auNonResidentWithholdingYTD: 1000 })).netLiability;
  const tax5000 = auRates.computeTax(auState({ people: { primary: { residency: 'US' } }, auNonResidentWithholdingYTD: 5000 })).netLiability;
  assert.strictEqual(tax1000, 150);
  assert.strictEqual(tax5000, 750);
});

// ══════════════════════════════════════════════════════════════════════════════
// TE-2b: Per-type NR withholding rates (design 73 Gap 2)
// ══════════════════════════════════════════════════════════════════════════════

test('TE-2b: interest and unfranked dividends are withheld at DIFFERENT rates in the same year', () => {
  // The defect this guards: one constant named for the whole bucket (0.15, the
  // Art 10(2) *dividend* cap) was applied to every withholding type, over-taxing
  // interest by half again. If the rates are ever re-pooled, equal bases would
  // produce equal tax and this fails.
  const nr = extra => auState({ people: { primary: { residency: 'US' } }, ...extra });

  const interestOnly = auRates.computeTax(nr({ auNrWithholdingInterestYTD: 10000 })).netLiability;
  const dividendOnly = auRates.computeTax(nr({ auNrWithholdingUnfrankedDividendYTD: 10000 })).netLiability;

  assert.strictEqual(interestOnly, 1000);  // Art 11(2) — 10%
  assert.strictEqual(dividendOnly, 1500);  // Art 10(2) — 15%
  assert.notStrictEqual(interestOnly, dividendOnly);

  // Both in one year: each base is taxed at its own rate, not at a blended one.
  const both = auRates.computeTax(nr({
    auNrWithholdingInterestYTD:          10000,
    auNrWithholdingUnfrankedDividendYTD: 10000,
  }));
  assert.strictEqual(both.netLiability, 2500);
  // ...and the income line still reports the full base across every type.
  assert.strictEqual(both.inputs.nonResidentWithholding, 20000);
});

test('TE-2b: each withholding line states the rate it actually applied', () => {
  // The CSV is self-checking only if `rate × income = tax` holds on the row. A
  // pooled band could not satisfy that once the pool mixes rates.
  const detail = auRates.computeTax(auState({
    people: { primary: { residency: 'US' } },
    auNrWithholdingInterestYTD:          8000,
    auNrWithholdingUnfrankedDividendYTD: 4000,
  }));

  for (const line of detail.nrWithholdingLines) {
    assert.ok(line.flat, `"${line.label}" should carry a flat band`);
    assert.ok(Math.abs(line.flat.rate * line.flat.income - line.amount) < 1e-9,
      `"${line.label}": ${line.flat.rate} × ${line.flat.income} != ${line.amount}`);
  }
  // The label names the same rate the band applied — they are built together.
  const interest = detail.nrWithholdingLines.find(l => /Interest/.test(l.label));
  assert.match(interest.label, /10%/);
  assert.strictEqual(interest.flat.rate, 0.10);
});

test('TE-2b: a foreign resident\'s TAP gain is taxed at marginal rates, not a 15% final tax', () => {
  // Design 73 Gap 2 step 3. A gain on Taxable Australian Property is assessable
  // income of a foreign resident (s855-10), taxed on the NR bracket schedule —
  // 30% from the first dollar, no tax-free threshold, no Medicare levy [R3].
  // The pooled 15% final tax roughly halved it.
  const detail = auRates.computeTax(auState({
    people: { primary: { residency: 'US' } },
    auCapitalGainsYTD: 100_000,
  }));

  assert.strictEqual(detail.assessableIncome, 100_000);
  assert.strictEqual(detail.baseTax, 30_000);        // 100k × 30%, not 15k
  assert.strictEqual(detail.medicareLevy, 0);        // no Medicare levy for a foreign resident
  assert.strictEqual(detail.cgtDiscount, 0);         // and no discount on this path
  assert.strictEqual(detail.netLiability, 30_000);
});

test('TE-2b: the NR bracket path is fed at all — line 5 of the AU return', () => {
  // The defect was not that the bracket path computed the wrong number: it was
  // that no feeder ever wrote auOrdinaryIncomeYTD or auCapitalGainsYTD while
  // non-resident, so "Tax on Income (Non-Resident Brackets)" read 0.00 in every
  // non-resident year of a 44-year export while income was diverted into a flat
  // withholding bucket. Guard that the path is reachable from both accumulators.
  const nrOrdinary = auRates.computeTax(auState({
    people: { primary: { residency: 'US' } }, auOrdinaryIncomeYTD: 50_000,
  }));
  assert.strictEqual(nrOrdinary.baseTax, 15_000);    // 50k × 30%

  const nrGain = auRates.computeTax(auState({
    people: { primary: { residency: 'US' } }, auCapitalGainsYTD: 50_000,
  }));
  assert.strictEqual(nrGain.baseTax, 15_000);

  // They stack on one bracket run rather than being taxed separately.
  const both = auRates.computeTax(auState({
    people: { primary: { residency: 'US' } },
    auOrdinaryIncomeYTD: 100_000, auCapitalGainsYTD: 100_000,
  }));
  // 135,000 × 30% + 55,000 × 37% + 10,000 × 45% = 40,500 + 20,350 + 4,500
  assert.strictEqual(both.baseTax, 65_350);
});

test('TE-2b: franked dividends carry a zero withholding rate (statutory exemption)', () => {
  // No feeder books franked dividends today. The entry exists so that if one
  // lands it cannot silently inherit a non-zero default: under the imputation
  // system franked dividends are exempt from AU dividend withholding by statute.
  assert.strictEqual(auRates._nrWithholdingRates.frankedDividend, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// TE-3: Ordinary Income — US: brackets minus standard deduction; AU: brackets
// ══════════════════════════════════════════════════════════════════════════════

test('TE-3: US ordinary income below standard deduction produces zero tax', () => {
  // MFJ standard deduction 2025 = $30,000
  const { netLiability } = usRates.computeTax(usState({ usOrdinaryIncomeYTD: 20000 }));
  assert.strictEqual(netLiability, 0);
});

test('TE-3: US ordinary income applies marginal brackets after standard deduction', () => {
  // Taxable income: 100000 - 30000 = 70000
  // [0, 23850] @ 10% = 2385 | [23850, 70000] @ 12% = 46150 * 0.12 = 5538 → total 7923
  const { netLiability } = usRates.computeTax(usState({ usOrdinaryIncomeYTD: 100000 }));
  assert.strictEqual(netLiability, 7923);
});

test('TE-3: US negative income (pre-tax deductions) reduces taxable base', () => {
  // 401k contribution reduces taxable income: 100000 - 20000 - 30000 = 50000
  // [0, 23850] @ 10% = 2385 | [23850, 50000] @ 12% = 26150 * 0.12 = 3138 → 5523
  const { netLiability } = usRates.computeTax(usState({ usOrdinaryIncomeYTD: 100000, usNegativeIncomeYTD: 20000 }));
  assert.strictEqual(netLiability, 5523);
});

test('TE-3: AU ordinary income zero below tax-free threshold', () => {
  // Tax-free threshold = $18,200
  const { netLiability } = auRates.computeTax(auState({ auOrdinaryIncomeYTD: 15000 }));
  assert.strictEqual(netLiability, 0);
});

test('TE-3: AU ordinary income uses progressive brackets with Medicare levy', () => {
  // Income $50,000 (Stage 3 schedule — ATO's published base at $45,000 is $4,288):
  //   [18200, 45000] @ 16% = 26800 * 0.16 = 4288
  //   [45000, 50000] @ 30% = 5000 * 0.30  = 1500  → baseTax = 5788
  // Medicare: 50000 > 32500 upper threshold → 50000 * 0.02 = 1000
  // Total = 6788
  const { netLiability } = auRates.computeTax(auState({ auOrdinaryIncomeYTD: 50000 }));
  assert.strictEqual(netLiability, 6788);
});

// ══════════════════════════════════════════════════════════════════════════════
// TE-4: Long-Term Capital Gains — US: LTCG brackets; AU: brackets + 50% discount
// ══════════════════════════════════════════════════════════════════════════════

test('TE-4: US LTCG uses preferred rate brackets (0%/15%/20%), not ordinary income brackets', () => {
  // $200k CG: [0, 96700] @ 0% = 0 | [96700, 200000] @ 15% = 103300 * 0.15 = 15495
  const { netLiability } = usRates.computeTax(usState({ usCapitalGainsYTD: 200000 }));
  assert.strictEqual(netLiability, 15495);
});

test('TE-4: US LTCG up to $96,700 is taxed at 0%', () => {
  const { netLiability } = usRates.computeTax(usState({ usCapitalGainsYTD: 50000 }));
  assert.strictEqual(netLiability, 0);
});

test('TE-4: AU capital gains for resident apply 50% CGT discount', () => {
  // $100k CG → discounted income = $50k
  // [18200, 45000] @ 16% = 4288 | [45000, 50000] @ 30% = 1500 → baseTax = 5788
  // Medicare: 50000 > 32500 → 50000 * 0.02 = 1000  → total = 6788
  const { netLiability } = auRates.computeTax(auState({ auCapitalGainsYTD: 100000 }));
  assert.strictEqual(netLiability, 6788);
});

test('TE-4: AU CGT discount is exactly 50% (half the gain is taxable)', () => {
  const taxWithDiscount    = auRates.computeTax(auState({ auCapitalGainsYTD: 100000 })).netLiability;
  const taxWithoutDiscount = auRates.computeTax(auState({ auOrdinaryIncomeYTD: 50000 })).netLiability;
  // $100k CG with 50% discount should equal $50k ordinary income (same bracket math)
  assert.strictEqual(taxWithDiscount, taxWithoutDiscount);
});

// ══════════════════════════════════════════════════════════════════════════════
// TE-4b: LTCG bracket stacking — gains must sit on top of ordinary income
//         (IRC §1(h)), not be taxed from $0.
// ══════════════════════════════════════════════════════════════════════════════

test('TE-4b: MFJ LTCG stacked on $200k ordinary income — no 0% bracket available', () => {
  // Taxable ordinary: $200k - $30k std ded = $170k, already past the 0% LTCG
  // ceiling ($96,700). The $100k gain sits entirely in the 15% band:
  //   _applyBrackets(170k + 100k) = _applyBrackets(270k)
  //     [0, 96700] @ 0% = 0 | [96700, 270000] @ 15% = 173300 * 0.15 = 25995
  //   _applyBrackets(170k)
  //     [0, 96700] @ 0% = 0 | [96700, 170000] @ 15% = 73300 * 0.15 = 10995
  //   capitalGainsTax = 25995 - 10995 = 15000
  const { capitalGainsTax, netLiability } = usRates.computeTax(
    usState({ usOrdinaryIncomeYTD: 200_000, usCapitalGainsYTD: 100_000 }),
  );
  assert.strictEqual(capitalGainsTax, 15_000);
  // Ordinary tax: 23850*0.10 + (96950-23850)*0.12 + (170000-96950)*0.22 = 27228.
  // NIIT (IRC §1411): MAGI = 200k ordinary + 100k gains = 300k; excess over the
  // $250k MFJ threshold = 50k; NII = 100k gains → 3.8% × min(100k, 50k) = 1900.
  assert.strictEqual(netLiability, 27_228 + 15_000 + 1_900);
});

test('TE-4b: MFJ LTCG fully in 0% bracket when ordinary income is low', () => {
  // Taxable ordinary: $50k - $30k = $20k; gain $40k → total $60k < $96,700
  // Both _applyBrackets calls return 0 → capitalGainsTax = 0
  const { capitalGainsTax } = usRates.computeTax(
    usState({ usOrdinaryIncomeYTD: 50_000, usCapitalGainsYTD: 40_000 }),
  );
  assert.strictEqual(capitalGainsTax, 0);
});

test('TE-4b: MFJ LTCG spanning 15% and 20% brackets', () => {
  // Taxable ordinary: $200k - $30k = $170k; gain $650k → total $820k
  //   _applyBrackets(820k):
  //     [0, 96700] @ 0% = 0
  //     [96700, 600050] @ 15% = 503350 * 0.15 = 75502.50
  //     [600050, 820000] @ 20% = 219950 * 0.20 = 43990
  //     total = 119492.50
  //   _applyBrackets(170k) = 10995 (from previous test)
  //   capitalGainsTax = 119492.50 - 10995 = 108497.50
  const { capitalGainsTax } = usRates.computeTax(
    usState({ usOrdinaryIncomeYTD: 200_000, usCapitalGainsYTD: 650_000 }),
  );
  assert.strictEqual(capitalGainsTax, 108_497.50);
});

test('TE-4b: single filer LTCG also stacks on ordinary income', () => {
  // Taxable ordinary: $100k - $15k = $85k; gain $50k → total $135k
  // Single LTCG brackets: 0% @ 0, 15% @ 48350, 20% @ 533400
  //   _applyBrackets(135k, single_ltcg):
  //     [0, 48350] @ 0% = 0
  //     [48350, 135000] @ 15% = 86650 * 0.15 = 12997.50
  //   _applyBrackets(85k, single_ltcg):
  //     [0, 48350] @ 0% = 0
  //     [48350, 85000] @ 15% = 36650 * 0.15 = 5497.50
  //   capitalGainsTax = 12997.50 - 5497.50 = 7500
  const { capitalGainsTax } = usRates.computeTax(
    usState({ usOrdinaryIncomeYTD: 100_000, usCapitalGainsYTD: 50_000, usFilingSingle: true }),
  );
  assert.strictEqual(capitalGainsTax, 7_500);
});

test('TE-4b: stacking with FEIE — gains sit above FEIE-reduced ordinary income', () => {
  // FEIE excludes $80k of foreign earned income from taxable ordinary.
  // Without FEIE: taxable ord = ($200k - $30k) = $170k
  // With FEIE:    taxable ord = ($170k - $80k) = $90k
  // Gain $100k → total $190k
  //   _applyBrackets(190k, ltcg_mfj):
  //     [0, 96700] @ 0% = 0
  //     [96700, 190000] @ 15% = 93300 * 0.15 = 13995
  //   _applyBrackets(90k, ltcg_mfj) = 0  (90k < 96700)
  //   capitalGainsTax = 13995
  const { capitalGainsTax } = usRates.computeTax(
    usState({
      usOrdinaryIncomeYTD: 200_000,
      usCapitalGainsYTD:   100_000,
      usFeieElected:       true,
      people:              { primary: { residency: 'AU' } },
      auPersonEarnedIncomeYTD: { primary: 80_000 },
      effectiveExchangeRates:  { USD_AUD: 1 },
    }),
  );
  assert.strictEqual(capitalGainsTax, 13_995);
});

test('TE-4b: zero ordinary income stacking matches pre-fix zero-ordinary behavior', () => {
  // When there is no ordinary income, stacking is a no-op (stack on $0 = direct).
  // This verifies the fix does not regress the simple case.
  const { capitalGainsTax } = usRates.computeTax(
    usState({ usCapitalGainsYTD: 200_000 }),
  );
  assert.strictEqual(capitalGainsTax, 15_495);
});

// ══════════════════════════════════════════════════════════════════════════════
// TE-5: Non-Resident Tax Rates — AU: different brackets, NO 50% CGT discount
// ══════════════════════════════════════════════════════════════════════════════

test('TE-5: AU NR uses the flat first foreign-resident bracket from $0 (no tax-free threshold)', () => {
  // $50k income: no tax-free threshold → 50000 * 0.30 = 15000.
  // Stage 3 (1 Jul 2024) cut this rate 32.5% → 30%; the module had kept 32.5%
  // while already using the widened $135k ceiling.
  const { netLiability } = auRates.computeTax(auState({ people: { primary: { residency: 'US' } }, auOrdinaryIncomeYTD: 50000 }));
  assert.strictEqual(netLiability, 15000);
});

test('TE-5: AU NR capital gains are NOT discounted (full gain taxed via NR brackets)', () => {
  // $100k CG, non-resident: no 50% discount → full 100000 * 0.30 = 30000
  const taxNR       = auRates.computeTax(auState({ people: { primary: { residency: 'US' } },  auCapitalGainsYTD: 100000 })).netLiability;
  const taxResident = auRates.computeTax(auState({ people: { primary: { residency: 'AU' } }, auCapitalGainsYTD: 100000 })).netLiability;
  assert.strictEqual(taxNR, 30000);
  assert.ok(taxNR > taxResident, 'NR rate should exceed resident (discounted) rate');
});

test('TE-5: AU NR brackets differ from resident brackets at same income', () => {
  const taxResident = auRates.computeTax(auState({ people: { primary: { residency: 'AU' } }, auOrdinaryIncomeYTD: 50000 })).netLiability;
  const taxNR       = auRates.computeTax(auState({ people: { primary: { residency: 'US' } },  auOrdinaryIncomeYTD: 50000 })).netLiability;
  // Resident 6788 (bracket + Medicare) vs NR 15000 (flat 30%)
  assert.ok(taxNR > taxResident, 'NR brackets produce higher tax on the same income');
});

// ══════════════════════════════════════════════════════════════════════════════
// TE-6: Franking Credit — AU: offsets ordinary tax (30% corporate tax already paid)
// ══════════════════════════════════════════════════════════════════════════════

test('TE-6: franking credit offsets AU ordinary income tax', () => {
  // $100k ordinary income:
  //   [18200, 45000] @ 16% = 4288 | [45000, 100000] @ 30% = 16500 → baseTax = 20788
  //   Medicare: 100000 * 0.02 = 2000
  //   franking offset: min(10000, 20788) = 10000
  //   net = (20788 - 10000) + 2000 = 12788
  const { netLiability } = auRates.computeTax(auState({ auOrdinaryIncomeYTD: 100000, auFrankingCreditYTD: 10000 }));
  assert.strictEqual(netLiability, 12788);
});

test('TE-6: franking credit is capped at base tax (cannot reduce Medicare levy)', () => {
  // $30k income: baseTax = [18200, 30000] @ 16% = 1888
  // Medicare phase-in: (30000 - 26000) * 0.10 = 400
  // Oversized franking credit: min(100000, 2242) = 2242 offsets all base tax
  // Net = (2242 - 2242) + 400 = 400
  const { netLiability } = auRates.computeTax(auState({ auOrdinaryIncomeYTD: 30000, auFrankingCreditYTD: 100000 }));
  assert.strictEqual(netLiability, 400);
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
  const s1 = fn(s0, { gain: 10000, residency: null });
  assert.strictEqual(s1.usCollectibleGainsYTD, 10000);
});

test('TE-7: US rates module applies 28% to collectible gains', () => {
  // $10k collectible gain → 10000 * 0.28 = 2800
  const { netLiability } = usRates.computeTax(usState({ usCollectibleGainsYTD: 10000 }));
  assert.strictEqual(Math.round(netLiability * 100) / 100, 2800);
});

test('TE-7: US collectible rate is distinct from LTCG rate (28% vs 15%)', () => {
  const collectibleTax = usRates.computeTax(usState({ usCollectibleGainsYTD: 100000 })).netLiability;
  const ltcgTax        = usRates.computeTax(usState({ usCapitalGainsYTD:      100000 })).netLiability;
  // 100k collectibles: 28000 | 100k LTCG: [0,96700] @ 0% + [96700,100000] @ 15% = 495
  assert.strictEqual(Math.round(collectibleTax * 100) / 100, 28000);
  assert.ok(collectibleTax > ltcgTax, 'collectible 28% rate exceeds LTCG 0%/15% on same amount');
});

test('TE-7: AU collectible gains use capital gains treatment (50% CGT discount)', () => {
  // AU treats collectibles as capital gains — auCapitalGainsYTD is the vehicle
  // $100k AU CG → discounted $50k → same as TE-4 resident test → 6788
  const { netLiability } = auRates.computeTax(auState({ auCapitalGainsYTD: 100000 }));
  assert.strictEqual(netLiability, 6788);
});

// ══════════════════════════════════════════════════════════════════════════════
// TE-8: Social Security Income — US: 85% taxable; AU: full ordinary income
// ══════════════════════════════════════════════════════════════════════════════

test('TE-8: SS income classifier applies 85% rule to US ordinary income', () => {
  const usModule = new UsTaxModule2026();
  const fn = getFn(usModule, 'SS_INCOME_TAX');
  const s0 = { usOrdinaryIncomeYTD: 0, auOrdinaryIncomeYTD: 0, ftcYTD: 0 };
  const s1 = fn(s0, { amount: 100000, residency: null });
  assert.strictEqual(s1.usOrdinaryIncomeYTD, 85000); // 100000 * 0.85
});

test('TE-8: SS income classifier adds full amount to AU ordinary income for AU residents', () => {
  const usModule = new UsTaxModule2026();
  const fn = getFn(usModule, 'SS_INCOME_TAX');
  const s0 = { usOrdinaryIncomeYTD: 0, auOrdinaryIncomeYTD: 0, ftcYTD: 0 };
  const s1 = fn(s0, { amount: 100000, residency: 'AU' });
  assert.strictEqual(s1.usOrdinaryIncomeYTD, 85000);  // 85% for US
  assert.strictEqual(s1.auOrdinaryIncomeYTD, 100000); // 100% for AU ordinary income
});

test('TE-8: US rates module taxes SS income at ordinary brackets on the 85% taxable portion', () => {
  // $100k SS → taxable US income = $85k; std deduction = $30k; taxable = $55k
  // [0, 23850] @ 10% = 2385 | [23850, 55000] @ 12% = 31150 * 0.12 = 3738 → 6123
  const { netLiability } = usRates.computeTax(usState({ usOrdinaryIncomeYTD: 85000 }));
  assert.strictEqual(netLiability, 6123);
});

test('TE-8: only 85% of SS benefit flows to US taxable income (not 100%)', () => {
  const usModule = new UsTaxModule2026();
  const fn = getFn(usModule, 'SS_INCOME_TAX');
  const s0 = { usOrdinaryIncomeYTD: 0, auOrdinaryIncomeYTD: 0, ftcYTD: 0 };
  const s1 = fn(s0, { amount: 1000, residency: null });
  // Verify it's not 100% (full $1000) or 0% (exempt)
  assert.strictEqual(s1.usOrdinaryIncomeYTD, 850);
  assert.notEqual(s1.usOrdinaryIncomeYTD, 1000);
});

// ══════════════════════════════════════════════════════════════════════════════
// Per-person AU wages tracking
// ══════════════════════════════════════════════════════════════════════════════

test('WAGES_INCOME_TAX with personKey updates auPersonOrdinaryIncomeYTD, not auOrdinaryIncomeYTD', () => {
  const usModule = new UsTaxModule2026();
  const fn = getFn(usModule, 'WAGES_INCOME_TAX');
  const s0 = {
    usOrdinaryIncomeYTD: 0,
    auOrdinaryIncomeYTD: 0,
    auPersonOrdinaryIncomeYTD: { primary: 0, spouse: 0 },
    ftcYTD: 0,
  };
  const s1 = fn(s0, { amount: 8000, residency: 'AU', personKey: 'primary' });
  assert.strictEqual(s1.usOrdinaryIncomeYTD, 8000);
  assert.strictEqual(s1.auPersonOrdinaryIncomeYTD.primary, 8000);
  assert.strictEqual(s1.auPersonOrdinaryIncomeYTD.spouse, 0);
  assert.strictEqual(s1.auOrdinaryIncomeYTD, 0);  // not updated when personKey present
  assert.ok(s1.usSourceOrdinaryUsdYTD > 0);
});

test('WAGES_INCOME_TAX without personKey still updates auOrdinaryIncomeYTD (backward compat)', () => {
  const usModule = new UsTaxModule2026();
  const fn = getFn(usModule, 'WAGES_INCOME_TAX');
  const s0 = { usOrdinaryIncomeYTD: 0, auOrdinaryIncomeYTD: 0, ftcYTD: 0 };
  const s1 = fn(s0, { amount: 5000, residency: 'AU' });
  assert.strictEqual(s1.auOrdinaryIncomeYTD, 5000);
});

test('WAGES_INCOME_TAX accumulates per person across multiple calls', () => {
  const usModule = new UsTaxModule2026();
  const fn = getFn(usModule, 'WAGES_INCOME_TAX');
  const s0 = {
    usOrdinaryIncomeYTD: 0,
    auOrdinaryIncomeYTD: 0,
    auPersonOrdinaryIncomeYTD: { primary: 0, spouse: 0 },
    ftcYTD: 0,
  };
  const s1 = fn(s0, { amount: 6000, residency: 'AU', personKey: 'primary' });
  const s2 = fn(s1, { amount: 4000, residency: 'AU', personKey: 'spouse' });
  const s3 = fn(s2, { amount: 6000, residency: 'AU', personKey: 'primary' });
  assert.strictEqual(s3.auPersonOrdinaryIncomeYTD.primary, 12000);
  assert.strictEqual(s3.auPersonOrdinaryIncomeYTD.spouse, 4000);
  assert.strictEqual(s3.auOrdinaryIncomeYTD, 0);
});

test('computeAuTaxPerPerson computes separate tax for each AU resident', () => {
  const service = new TaxSettleService();
  const state = {
    people: {
      primary: { name: 'Alice', residency: 'AU' },
      spouse:  { name: 'Bob',   residency: 'AU' },
    },
    auPersonOrdinaryIncomeYTD: { primary: 90000, spouse: 40000 },
    auOrdinaryIncomeYTD:         0,
    auCapitalGainsYTD:           0,
    auNonResidentWithholdingYTD: 0,
    auSuperTaxYTD:               0,
    auFrankingCreditYTD:         0,
    inflationAccumulator:        { AU: 1.0 },
    currentPeriods:              { AU: { startMs: Date.UTC(2025, 6, 1) } },
  };

  const results = service.computeAuTaxPerPerson(state);
  assert.strictEqual(results.length, 2);

  const alice = results.find(r => r.personKey === 'primary');
  const bob   = results.find(r => r.personKey === 'spouse');

  assert.ok(alice, 'primary result missing');
  assert.ok(bob,   'spouse result missing');
  assert.strictEqual(alice.personName, 'Alice');
  assert.strictEqual(bob.personName,   'Bob');
  // Alice earns more so pays more tax
  assert.ok(alice.taxDetail.netLiability > bob.taxDetail.netLiability,
    `Alice ($${alice.taxDetail.netLiability}) should pay more tax than Bob ($${bob.taxDetail.netLiability})`);
});

test('computeAuTaxPerPerson splits shared passive income equally', () => {
  // Design 76 P5 escalated an unattributed household scalar to a throw in dev/test.
  // This case deliberately exercises that legacy shared-pool split — still the
  // production fallback, and still correct in TOTAL — so it opts out of the
  // escalation rather than being rewritten to per-person maps, which would stop it
  // testing the thing it exists to test.
  const _prevStrict = process.env.AU_ATTRIBUTION_STRICT;
  process.env.AU_ATTRIBUTION_STRICT = 'off';
  try {

    const service = new TaxSettleService();
    const state = {
      people: {
        primary: { name: 'Alice', residency: 'AU' },
        spouse:  { name: 'Bob',   residency: 'AU' },
      },
      auPersonOrdinaryIncomeYTD: { primary: 0, spouse: 0 },
      auOrdinaryIncomeYTD:         20000,  // shared passive income
      auCapitalGainsYTD:           0,
      auNonResidentWithholdingYTD: 0,
      auSuperTaxYTD:               0,
      auFrankingCreditYTD:         0,
      inflationAccumulator:        { AU: 1.0 },
      currentPeriods:              { AU: { startMs: Date.UTC(2025, 6, 1) } },
    };

    const results = service.computeAuTaxPerPerson(state);
    const alice = results.find(r => r.personKey === 'primary');
    const bob   = results.find(r => r.personKey === 'spouse');

    // Each should see $10k AU income (shared $20k / 2 residents)
    assert.strictEqual(alice.taxDetail.inputs.ordinaryIncome, 10000);
    assert.strictEqual(bob.taxDetail.inputs.ordinaryIncome,   10000);
  } finally {
    if (_prevStrict === undefined) delete process.env.AU_ATTRIBUTION_STRICT;
    else process.env.AU_ATTRIBUTION_STRICT = _prevStrict;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Filing Status: Single vs Married Filing Jointly
// ══════════════════════════════════════════════════════════════════════════════

test('US single filer standard deduction is $15,000 (not $30,000 MFJ)', () => {
  // $20k income: MFJ std deduction = $30k → zero tax; single std deduction = $15k → taxable $5k
  const mfjTax    = usRates.computeTax(usState({ usOrdinaryIncomeYTD: 20_000 })).netLiability;
  const singleTax = usRates.computeTax(usState({ usOrdinaryIncomeYTD: 20_000, usFilingSingle: true })).netLiability;
  assert.strictEqual(mfjTax, 0, 'MFJ: $20k is below $30k std deduction');
  assert.ok(singleTax > 0, 'Single: $20k exceeds $15k std deduction → taxable');
});

test('US single filer: $50k income computes correct tax', () => {
  // AGI = $50k, std deduction = $15k, taxable = $35k
  // [0, 11925] @ 10% = 1192.50 | [11925, 35000] @ 12% = 23075 × 0.12 = 2769 → 3961.50
  const { netLiability } = usRates.computeTax(usState({ usOrdinaryIncomeYTD: 50_000, usFilingSingle: true }));
  assert.strictEqual(netLiability, 3961.5);
});

test('US MFJ filer: $50k income computes correct tax (unchanged)', () => {
  // AGI = $50k, std deduction = $30k, taxable = $20k
  // [0, 20000] @ 10% = 2000
  const { netLiability } = usRates.computeTax(usState({ usOrdinaryIncomeYTD: 50_000 }));
  assert.strictEqual(netLiability, 2000);
});

test('US computeTax returns filingStatus: "Single" when usFilingSingle is true', () => {
  const result = usRates.computeTax(usState({ usFilingSingle: true }));
  assert.strictEqual(result.filingStatus, 'Single');
});

test('US computeTax returns filingStatus: "Married Filing Jointly" when usFilingSingle is falsy', () => {
  const noFlag = usRates.computeTax(usState({}));
  const explicit = usRates.computeTax(usState({ usFilingSingle: false }));
  assert.strictEqual(noFlag.filingStatus,    'Married Filing Jointly');
  assert.strictEqual(explicit.filingStatus,  'Married Filing Jointly');
});

test('US single filer standardDeduction in result inputs is $15,000', () => {
  const result = usRates.computeTax(usState({ usFilingSingle: true }));
  assert.strictEqual(result.inputs.standardDeduction, 15_000);
});

test('US MFJ standardDeduction in result inputs is $30,000', () => {
  const result = usRates.computeTax(usState({}));
  assert.strictEqual(result.inputs.standardDeduction, 30_000);
});

test('US single filer LTCG 0% bracket threshold is $48,350 (not $96,700 MFJ)', () => {
  // $60k CG: MFJ → 0% (below $96,700); Single → taxed at 15% above $48,350
  const mfjTax    = usRates.computeTax(usState({ usCapitalGainsYTD: 60_000 })).netLiability;
  const singleTax = usRates.computeTax(usState({ usCapitalGainsYTD: 60_000, usFilingSingle: true })).netLiability;
  assert.strictEqual(mfjTax, 0, 'MFJ: $60k CG is below $96,700 0% threshold');
  assert.ok(singleTax > 0, 'Single: $60k CG exceeds $48,350 0% threshold');
});

// ══════════════════════════════════════════════════════════════════════════════
// AU-2026: FY2026-27 — $18,201–$45,000 band cut 16% → 15%; CGT discount unchanged
//   (design 57 Phase 1)
// ══════════════════════════════════════════════════════════════════════════════

const auRates2026 = new AuTaxRates2026();

test('AU-2026: FY2026-27 lowest band is 15% (down from FY2025-26 19% in-code)', () => {
  // $30k ordinary income: [18200, 30000] @ 15% = 11800 * 0.15 = 1770 base tax
  //   + Medicare phase-in (30000 - 26000) * 0.10 = 400 → netLiability 2170
  const { netLiability } = auRates2026.computeTax(auState({ auOrdinaryIncomeYTD: 30_000 }));
  assert.strictEqual(netLiability, 2170);
});

test('AU-2026: 15% band lowers tax vs the 19% carried in AuTaxRates2025', () => {
  const tax2026 = auRates2026.computeTax(auState({ auOrdinaryIncomeYTD: 30_000 })).netLiability;
  const tax2025 = auRates.computeTax(auState({ auOrdinaryIncomeYTD: 30_000 })).netLiability;
  assert.ok(tax2026 < tax2025, `FY2026-27 (${tax2026}) should be below FY2025-26 (${tax2025})`);
});

test('AU-2026: 50% CGT discount still applies (resident)', () => {
  // $100k capital gains, resident: netTaxableGain = 50000
  //   [18200, 45000] @ 15% = 26800 * 0.15 = 4020 | [45000, 50000] @ 30% = 1500 → baseTax 5520
  //   Medicare 50000 * 0.02 = 1000 → netLiability 6520
  const result = auRates2026.computeTax(auState({ auCapitalGainsYTD: 100_000 }));
  assert.strictEqual(result.netLiability, 6520);
  assert.strictEqual(result.cgtDiscount, 50_000, 'discount reduction is 50% of the gain');
  assert.strictEqual(result.discountedCapitalGains, 50_000, 'net taxable gain is 50% of the gain');
});

test('AU-2026: CGT-discounted gain taxed like equal ordinary income', () => {
  const taxWithDiscount    = auRates2026.computeTax(auState({ auCapitalGainsYTD: 100_000 })).netLiability;
  const taxWithoutDiscount = auRates2026.computeTax(auState({ auOrdinaryIncomeYTD: 50_000 })).netLiability;
  assert.strictEqual(taxWithDiscount, taxWithoutDiscount);
});

test('AU-2026: TaxSettleService selects FY2026-27 module for a July-2026 period', () => {
  const svc   = new TaxSettleService();
  const state = auState({
    auOrdinaryIncomeYTD: 30_000,
    currentPeriods: { AU: { startMs: Date.UTC(2026, 6, 1) } },
  });
  const result = svc.computeAuTax(state);
  assert.strictEqual(result.taxYear, 2026);
  assert.strictEqual(result.netLiability, 2170); // 15% band (1770) + Medicare phase-in (400)
});

// ══════════════════════════════════════════════════════════════════════════════
// AU-2027: FY2027-28 CGT reform — 50% discount removed + 30% minimum tax;
//   band 15% → 14% (design 57 Phase 2, un-indexed gains)
// ══════════════════════════════════════════════════════════════════════════════

const auRates2027 = new AuTaxRates2027();

test('AU-2027: 50% CGT discount removed — full gain assessable', () => {
  const result = auRates2027.computeTax(auState({ auCapitalGainsYTD: 100_000 }));
  assert.strictEqual(result.cgtDiscount, 0, 'no discount reduction');
  assert.strictEqual(result.discountedCapitalGains, 100_000, 'full gain is taxable');
});

test('AU-2027: 30% minimum tax tops up a gain taxed below 30% at the margin', () => {
  // $100k gain, no other income. Marginal bracket tax:
  //   [18200,45000] @ 14% = 3752 | [45000,100000] @ 30% = 16500 → taxOnGain 20252
  //   30% floor = 30000 → top-up 9748. Medicare 100000 * 0.02 = 2000.
  //   netLiability = 20252 + 2000 + 9748 = 32000
  const result = auRates2027.computeTax(auState({ auCapitalGainsYTD: 100_000 }));
  assert.strictEqual(result.cgtMinimumTaxTopUp, 9748);
  assert.strictEqual(result.netLiability, 32000);
  assert.ok(
    result.lineItems.some(li => li.label === 'CGT Minimum Tax Top-up (30%)' && li.amount === 9748),
    'min-tax top-up line item present',
  );
});

test('AU-2027: small gain with no other income is taxed at exactly 30%', () => {
  // $10k gain below the tax-free threshold → 0 bracket tax → full 30% top-up
  const result = auRates2027.computeTax(auState({ auCapitalGainsYTD: 10_000 }));
  assert.strictEqual(result.cgtMinimumTaxTopUp, 3000);
  assert.strictEqual(result.netLiability, 3000);
});

test('AU-2027: no top-up when the gain is already taxed at ≥30% at the margin', () => {
  // $200k ordinary income puts the gain in the 45% bracket → marginal tax > 30%
  const result = auRates2027.computeTax(auState({ auOrdinaryIncomeYTD: 200_000, auCapitalGainsYTD: 100_000 }));
  assert.strictEqual(result.cgtMinimumTaxTopUp, 0, '45% marginal already exceeds the 30% floor');
});

test('AU-2027: reform makes a resident gain cost more than the FY2026-27 discounted gain', () => {
  const tax2027 = auRates2027.computeTax(auState({ auCapitalGainsYTD: 100_000 })).netLiability;
  const tax2026 = auRates2026.computeTax(auState({ auCapitalGainsYTD: 100_000 })).netLiability;
  assert.ok(tax2027 > tax2026, `FY2027-28 (${tax2027}) should exceed FY2026-27 (${tax2026})`);
});

test('AU-2027: lowest band is 14% (down from FY2026-27 15%)', () => {
  const tax2027 = auRates2027.computeTax(auState({ auOrdinaryIncomeYTD: 30_000 })).netLiability;
  const tax2026 = auRates2026.computeTax(auState({ auOrdinaryIncomeYTD: 30_000 })).netLiability;
  assert.ok(tax2027 < tax2026, `FY2027-28 (${tax2027}) should be below FY2026-27 (${tax2026})`);
});

test('AU-2027: non-resident still gets no discount (unchanged) and no min-tax floor', () => {
  // Non-residents already had no discount; the reform machinery must not add a floor for them.
  const result = auRates2027.computeTax(auState({ people: { primary: { residency: 'US' } }, auCapitalGainsYTD: 100_000 }));
  assert.strictEqual(result.isResident, false);
  assert.strictEqual(result.cgtMinimumTaxTopUp, undefined, 'non-resident path has no top-up field');
});

test('AU-2027: TaxSettleService selects FY2027-28 module for a July-2027 period', () => {
  const svc   = new TaxSettleService();
  const state = auState({
    auOrdinaryIncomeYTD: 30_000,
    currentPeriods: { AU: { startMs: Date.UTC(2027, 6, 1) } },
  });
  const result = svc.computeAuTax(state);
  assert.strictEqual(result.taxYear, 2027);
  // [18200,30000] @ 14% = 1652 + Medicare phase-in 400 = 2052
  assert.strictEqual(result.netLiability, 2052);
});

// ══════════════════════════════════════════════════════════════════════════════
// AU-2027 indexation — AuTaxModule2027 routes the indexed gain into
//   auRealCapitalGainsYTD, which AuTaxRates2027 taxes (design 57 Phase 3)
// ══════════════════════════════════════════════════════════════════════════════

test('AU-2027 classify: resident stock sale records indexed gain into the real bucket', () => {
  const fn = getFn(new AuTaxModule2027(), 'AU_STOCK_WITHDRAWAL_TAX');
  const s0 = { usCapitalGainsYTD: 0, auCapitalGainsYTD: 0, auRealCapitalGainsYTD: 0, ftcYTD: 0 };
  const s1 = fn(s0, { gain: 100_000, auGain: 100_000, auIndexedGain: 70_000, residency: 'AU' });
  assert.strictEqual(s1.auCapitalGainsYTD, 100_000, 'gross gain still tracked');
  assert.strictEqual(s1.auRealCapitalGainsYTD, 70_000, 'indexed gain routed to real bucket');
});

test('AU-2027 classify: non-resident stock sale writes no real bucket', () => {
  const fn = getFn(new AuTaxModule2027(), 'AU_STOCK_WITHDRAWAL_TAX');
  const s0 = { usCapitalGainsYTD: 0, auCapitalGainsYTD: 0, auRealCapitalGainsYTD: 0, auNonResidentWithholdingYTD: 0, ftcYTD: 0 };
  const s1 = fn(s0, { gain: 100_000, auGain: 100_000, auIndexedGain: 70_000, residency: 'US' });
  assert.strictEqual(s1.auRealCapitalGainsYTD, 0, 'non-resident: no real-gain bucket');
});

test('AU-2027 rates: indexation reduces the assessed gain and the tax', () => {
  // Real (indexed) gain 70k vs gross 100k. baseTax(70000) = 3752 + 25000*0.30 = 11252;
  //   30% floor on 70k = 21000 → top-up 9748; Medicare 70000*0.02 = 1400 → 22400.
  const result = auRates2027.computeTax(auState({ auCapitalGainsYTD: 100_000, auRealCapitalGainsYTD: 70_000 }));
  assert.strictEqual(result.discountedCapitalGains, 70_000, 'taxable gain is the indexed gain');
  assert.strictEqual(result.cgtDiscount, 30_000, 'indexation relief = gross − indexed');
  assert.strictEqual(result.cgtMinimumTaxTopUp, 9748);
  assert.strictEqual(result.netLiability, 22400);
  const unindexed = auRates2027.computeTax(auState({ auCapitalGainsYTD: 100_000 })).netLiability;
  assert.ok(result.netLiability < unindexed, `indexed (${result.netLiability}) < un-indexed (${unindexed})`);
});

// ─── US 2026 (IRS Rev. Proc. 2025-32 — permanent OBBBA schedule) ──────────────
//
// Before this module existed, US years ≥ 2026 fell back to the 2025 module,
// which the inflation wrapper leaves untouched in the accumulator's base year —
// so a 2026 return was filed on 2025 brackets and the $30,000 standard
// deduction. The OBBBA schedule is not a CPI step from 2025, so it has to be
// stated statutorily rather than derived.

test('US-2026: MFJ brackets, LTCG breakpoints and standard deduction are the statutory 2026 figures', () => {
  const r = new UsTaxRates2026();
  assert.strictEqual(r.year, 2026);
  assert.deepStrictEqual(r._brackets_mfj.map(([t]) => t),
    [0, 24_800, 100_800, 211_400, 403_550, 512_450, 768_700]);
  assert.deepStrictEqual(r._ltcg_mfj, [[0, 0.00], [98_900, 0.15], [613_700, 0.20]]);
  assert.strictEqual(r._stdDeduction_mfj, 32_200);
  assert.deepStrictEqual(r._brackets_single.map(([t]) => t),
    [0, 12_400, 50_400, 105_700, 201_775, 256_225, 640_600]);
  assert.deepStrictEqual(r._ltcg_single, [[0, 0.00], [49_450, 0.15], [545_500, 0.20]]);
  assert.strictEqual(r._stdDeduction_single, 16_100);
  assert.strictEqual(r._ficaWageBase, 184_500);
  assert.strictEqual(r._feieCap, 132_900);
});

test('US-2026: TaxSettleService selects the 2026 module for a 2026 period', () => {
  const svc   = new TaxSettleService();
  const state = usState({
    usOrdinaryIncomeYTD: 200_000,
    currentPeriods: { US: { startMs: Date.UTC(2026, 0, 1) } },
  });
  const result = svc.computeUsTax(state);
  assert.strictEqual(result.taxYear, 2026);
  assert.strictEqual(result.inputs.standardDeduction, 32_200);
  // 200k gross − 32.2k std = 167,800 taxable; 10/12/22% bands of the 2026 table.
  assert.strictEqual(result.taxableIncome, 167_800);
  const expected = 24_800 * 0.10
    + (100_800 - 24_800) * 0.12
    + (167_800 - 100_800) * 0.22;
  assert.ok(Math.abs(result.ordinaryTax - expected) < 0.01,
    `ordinary tax ${result.ordinaryTax} ≠ ${expected}`);
});

test('US-2026: LTCG stacks on ordinary income against the 2026 breakpoints', () => {
  const r = new UsTaxRates2026();
  // Ordinary taxable 50k; a 60k gain straddles the 98,900 0%→15% breakpoint.
  const result = r.computeTax(usState({ usOrdinaryIncomeYTD: 82_200, usCapitalGainsYTD: 60_000 }));
  assert.strictEqual(result.taxableIncome, 50_000);
  const expected = (98_900 - 50_000) * 0.00 + (110_000 - 98_900) * 0.15;
  assert.ok(Math.abs(result.capitalGainsTax - expected) < 0.01,
    `LTCG tax ${result.capitalGainsTax} ≠ ${expected}`);
});
