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
 * state-tax-rates.test.mjs — US state income tax rate modules + StateTaxSettleService
 * (design 34 Phase 1). Verifies bracket math, state-specific treatment (SS exempt,
 * HI pension exclusion + 7.25% capital-gains alternative, SD zero), the LB 754
 * year-over-year rate cut, and residency-based resolution.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { NeStateTaxRates2024 }   from '../../src/finance/tax/state/ne/ne-state-tax-rates-2024.js';
import { NeStateTaxRates2025 }   from '../../src/finance/tax/state/ne/ne-state-tax-rates-2025.js';
import { HiStateTaxRates2024 }   from '../../src/finance/tax/state/hi/hi-state-tax-rates-2024.js';
import { SdStateTaxRates2024 }   from '../../src/finance/tax/state/sd/sd-state-tax-rates-2024.js';
import { StateTaxSettleService } from '../../src/finance/tax/state/state-tax-settle-service.js';
import { StateTaxDocumentReporter } from '../../src/finance/tax/state/state-tax-document.js';

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);

// ── Nebraska ──────────────────────────────────────────────────────────────────

test('NE 2024: MFJ ordinary income via marginal brackets, SS exempt', () => {
  const m = new NeStateTaxRates2024();
  // taxable = 100k − 15k std = 85k.
  // 7390·.0246 + 36920·.0351 + 27050·.0501 + 13640·.0584 = 3629.467
  const r = m.computeTax({ stateOrdinaryIncomeYTD: 100_000 });
  near(r.netLiability, 3629.467);

  // Social Security is exempt → adding gross SS must not change the tax.
  const withSs = m.computeTax({ stateOrdinaryIncomeYTD: 100_000, stateSsIncomeYTD: 50_000 });
  near(withSs.netLiability, r.netLiability);
});

test('NE taxes capital gains as ordinary income', () => {
  const m = new NeStateTaxRates2024();
  const base = m.computeTax({ stateOrdinaryIncomeYTD: 100_000 }).netLiability;
  const withCg = m.computeTax({ stateOrdinaryIncomeYTD: 100_000, stateCapitalGainsYTD: 20_000 }).netLiability;
  assert.ok(withCg > base, 'CG should increase NE tax');
  near(withCg, 4797.467); // top bracket extends to 105k taxable
});

test('NE 2025: LB 754 cuts the top rate 5.84% → 5.20% (lower tax, same income)', () => {
  const i = { stateOrdinaryIncomeYTD: 100_000 };
  const t2024 = new NeStateTaxRates2024().computeTax(i).netLiability;
  const t2025 = new NeStateTaxRates2025().computeTax(i).netLiability;
  assert.ok(t2025 < t2024, `2025 (${t2025}) should be below 2024 (${t2024})`);
  near(t2025, 3542.171);
});

// ── Hawaii ────────────────────────────────────────────────────────────────────

test('HI 2024: pension fully excluded, SS exempt', () => {
  const m = new HiStateTaxRates2024();
  assert.equal(m.computeTax({ statePensionIncomeYTD: 40_000 }).netLiability, 0);
  assert.equal(m.computeTax({ stateSsIncomeYTD: 60_000 }).netLiability, 0);
});

test('HI 2024: capital gains taxed at the 7.25% alternative, not as ordinary', () => {
  const m = new HiStateTaxRates2024();
  const r = m.computeTax({ stateCapitalGainsYTD: 100_000 });
  near(r.capitalGainsTax, 7_250);
  near(r.netLiability, 7_250);
});

test('HI 2024: ordinary income uses the progressive brackets', () => {
  const m = new HiStateTaxRates2024();
  // Act 46 doubled the standard deduction in 2024 itself: MFJ $4,400 → $8,800.
  // taxable = 10k − 8.8k std = 1.2k → 1200·.014 = 16.8
  assert.equal(m._stdDeduction_mfj, 8_800);
  assert.equal(m._stdDeduction_single, 4_400);
  near(m.computeTax({ stateOrdinaryIncomeYTD: 10_000 }).netLiability, 16.8);
});

// ── Hawaii Act 46 phase-in ────────────────────────────────────────────────────
//
// Act 46 (SLH 2024) steps the brackets in 2025/2027/2029 and the standard
// deduction in 2024/2026/2028/2030/2031. Only the 2024 module existed, so every
// later year filed on the 2023 bracket ladder and the pre-Act-46 deduction.
// Expected liabilities below are the DOTAX Announcement 2024-03 cumulative
// "$X plus Y% of excess over Z" figures, recomputed exactly (the published base
// amounts are rounded to the dollar).

/** HI liability for MFJ ordinary income in a given tax year, via the settle service. */
function hiTax(year, ordinary) {
  return new StateTaxSettleService().computeStateTax({
    people: { primary: { residency: 'US', residencyState: 'HI' } },
    stateOrdinaryIncomeYTD: ordinary,
    currentPeriods: { US: { startMs: Date.UTC(year, 0, 1) } },
  });
}

test('HI Act 46: standard deduction steps 8,800 → 16,000 → 18,000 → 20,000 → 24,000', () => {
  const dedFor = y => 200_000 - hiTax(y, 200_000).taxableIncome;
  assert.equal(dedFor(2025), 8_800);
  assert.equal(dedFor(2026), 16_000);   // the reported bug
  assert.equal(dedFor(2027), 16_000);
  assert.equal(dedFor(2028), 18_000);
  assert.equal(dedFor(2029), 18_000);
  assert.equal(dedFor(2030), 20_000);
  assert.equal(dedFor(2031), 24_000);
});

test('HI Act 46: each bracket step matches the DOTAX schedule at 200k ordinary', () => {
  // 2025 schedule, taxable 191,200: base at 96,000 = 5,078.40, + 7.6% of 95,200.
  near(hiTax(2025, 200_000).netLiability, 5_078.4 + 0.076 * 95_200);
  // 2026 keeps the 2025 brackets; only the deduction moved (taxable 184,000).
  near(hiTax(2026, 200_000).netLiability, 5_078.4 + 0.076 * 88_000);
  // 2027 schedule, taxable 184,000: base at 96,000 = 4,406.40, + 7.2% of 88,000.
  near(hiTax(2027, 200_000).netLiability, 4_406.4 + 0.072 * 88_000);
  // 2029 schedule, taxable 182,000: base at 96,000 = 3,700.80, + 6.8% of 86,000.
  near(hiTax(2029, 200_000).netLiability, 3_700.8 + 0.068 * 86_000);
});

test('HI Act 46: the phase-in is monotonically cheaper on the same income', () => {
  const years = [2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031];
  const taxes = years.map(y => hiTax(y, 200_000).netLiability);
  for (let i = 1; i < taxes.length; i++) {
    assert.ok(taxes[i] < taxes[i - 1],
      `${years[i]} (${taxes[i].toFixed(2)}) should be below ${years[i - 1]} (${taxes[i - 1].toFixed(2)})`);
  }
});

test('HI Act 46: 2031 is terminal — later years file on the same table', () => {
  const t2031 = hiTax(2031, 200_000).netLiability;
  near(hiTax(2040, 200_000).netLiability, t2031);
  assert.equal(hiTax(2040, 200_000).taxYear, 2040, 'reported year is the actual year');
});

test('HI Act 46: the 7.25% capital-gains alternative survives every step', () => {
  for (const y of [2025, 2027, 2029, 2031]) {
    const r = new StateTaxSettleService().computeStateTax({
      people: { primary: { residency: 'US', residencyState: 'HI' } },
      stateCapitalGainsYTD: 100_000,
      currentPeriods: { US: { startMs: Date.UTC(y, 0, 1) } },
    });
    near(r.capitalGainsTax, 7_250, 0.01);
  }
});

// ── South Dakota (no income tax) ──────────────────────────────────────────────

test('SD: zero liability for any input', () => {
  const m = new SdStateTaxRates2024();
  assert.equal(m.hasIncomeTax, false);
  assert.equal(m.computeTax({ stateOrdinaryIncomeYTD: 200_000, stateCapitalGainsYTD: 100_000, statePensionIncomeYTD: 50_000 }).netLiability, 0);
});

// ── StateTaxSettleService resolution ──────────────────────────────────────────

function stateWith({ residencyState, residency = 'US', year = 2024, ...ytd }) {
  return {
    people: { p1: { residency, residencyState } },
    currentPeriods: { US: { startMs: Date.UTC(year, 0, 1) } },
    ...ytd,
  };
}

test('settle service resolves the active state from the primary person + US year', () => {
  const svc = new StateTaxSettleService();
  const r = svc.computeStateTax(stateWith({ residencyState: 'NE', year: 2024, stateOrdinaryIncomeYTD: 100_000 }));
  assert.equal(r.stateCode, 'NE');
  assert.equal(r.taxYear, 2024);
  near(r.netLiability, 3629.467);
});

test('settle service applies highest-year-≤ fallback (2026 → NE 2025 rates)', () => {
  const svc = new StateTaxSettleService();
  const r = svc.computeStateTax(stateWith({ residencyState: 'NE', year: 2026, stateOrdinaryIncomeYTD: 100_000 }));
  near(r.netLiability, 3542.171); // 2025 module (LB 754 cut) carried forward to 2026
});

// ── StateTaxDocumentReporter ──────────────────────────────────────────────────

test('document reporter renders a state return from the settlement taxDetail', () => {
  const taxDetail = new NeStateTaxRates2024().computeTax({ stateOrdinaryIncomeYTD: 100_000 });
  taxDetail.taxYear = 2024;
  const entry = { date: new Date(Date.UTC(2024, 11, 31)), action: { type: 'STATE_TAX_SETTLE_APPLY', data: { taxDetail } } };

  const doc = new StateTaxDocumentReporter().generate(entry);
  assert.equal(doc.state, 'NE');
  assert.equal(doc.title, 'NE State Income Tax — 2024');
  assert.ok(doc.sections[0].lineItems.length > 0);
  near(doc.summary.netLiability, 3629.467);
});

test('document reporter returns null when there is no state taxDetail', () => {
  const reporter = new StateTaxDocumentReporter();
  assert.equal(reporter.generate({ action: { type: 'STATE_TAX_SETTLE_APPLY', data: {} } }), null);
  assert.equal(reporter.generate({ action: { type: 'STATE_TAX_SETTLE_APPLY', data: { taxDetail: { stateCode: null } } } }), null);
});

test('settle service returns zero when no state configured or primary is abroad', () => {
  const svc = new StateTaxSettleService();
  assert.equal(svc.computeStateTax(stateWith({ residencyState: null, stateOrdinaryIncomeYTD: 100_000 })).netLiability, 0);
  // AU resident with a state still set → no US state tax.
  assert.equal(svc.computeStateTax(stateWith({ residencyState: 'NE', residency: 'AU', stateOrdinaryIncomeYTD: 100_000 })).netLiability, 0);
  // SD configured → zero.
  assert.equal(svc.computeStateTax(stateWith({ residencyState: 'SD', stateOrdinaryIncomeYTD: 100_000 })).netLiability, 0);
});
