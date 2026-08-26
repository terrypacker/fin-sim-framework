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
 * evt-self-employment.test.mjs — design 69.
 * Self-employment income (US SECA + AU sole-trader) driven by a per-person
 * `selfEmployed` flag next to monthlyWage.
 *
 * Layers:
 *   Classification — SE_INCOME_US_TAX feeds usSeEarningsYTD (the SECA base) as well
 *                    as usOrdinaryIncomeYTD; US wages/bonus feed usSsWagesYTD (the
 *                    Social-Security wage-base filler); AU SE income never feeds the
 *                    US SECA base (totalization).
 *   Rates          — computeTax() applies SECA (12.4% SS capped at the wage base and
 *                    coordinated with SS wages + 2.9% uncapped Medicare on 92.35% of
 *                    net earnings), the 0.9% Additional Medicare surtax, and the
 *                    ½-SE-tax AGI deduction; SECA is outside the FTC.
 *   Routing        — PayrollHandler routes a self-employed person's monthlyWage
 *                    through the SE apply path (US or AU by wageCurrency).
 *   Model          — the selfEmployed flag survives a serialization round-trip.
 *
 * Run with: node --test tests/unit/evt-self-employment.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { UsTaxRates2025 }  from '../../src/finance/tax/us/us-tax-rates-2025.js';
import { UsTaxModule2026 } from '../../src/finance/tax/us/us-tax-module-2026.js';
import { AuTaxModule2026 } from '../../src/finance/tax/au/au-tax-module-2026.js';
import { PayrollHandler, PAYROLL_STAGE } from '../../src/finance/handlers/payroll-handler.js';
import { Person } from '../../src/finance/person.js';
import { PersonBuilder } from '../../src/finance/builders/person-builder.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';

const usRates = new UsTaxRates2025();

const WAGE_BASE      = 176_100;   // UsTaxRates2025._ficaWageBase (2025)
const NET_FACTOR     = 0.9235;
const SS_RATE        = 0.124;
const MED_RATE       = 0.029;
const ADDL_MED_RATE  = 0.009;

function usState(overrides = {}) {
  return {
    usOrdinaryIncomeYTD:      0,
    usNegativeIncomeYTD:      0,
    usCapitalGainsYTD:        0,
    usCollectibleGainsYTD:    0,
    usNetInvestmentIncomeYTD: 0,
    usPenaltyYTD:             0,
    usSeEarningsYTD:          0,
    usSsWagesYTD:             0,
    ...overrides,
  };
}

const getFn = (module, actionType) => module.getReducerFns().get(actionType);

// ══════════════════════════════════════════════════════════════════════════════
// SE-classification: accumulators feed correctly
// ══════════════════════════════════════════════════════════════════════════════

test('SE-classify: SE_INCOME_US_TAX feeds usSeEarningsYTD AND usOrdinaryIncomeYTD', () => {
  const m = new UsTaxModule2026();
  const next = getFn(m, 'SE_INCOME_US_TAX')(usState(), { amount: 80_000, residency: 'US' });
  assert.equal(next.usSeEarningsYTD, 80_000, 'SECA base');
  assert.equal(next.usOrdinaryIncomeYTD, 80_000, 'ordinary income');
});

test('SE-classify: US wages and bonus feed usSsWagesYTD (SS wage-base filler)', () => {
  const m = new UsTaxModule2026();
  const w = getFn(m, 'WAGES_INCOME_TAX')(usState(), { amount: 120_000, residency: 'US' });
  assert.equal(w.usSsWagesYTD, 120_000);
  const b = getFn(m, 'BONUS_TAX')(usState(), { amount: 15_000, residency: 'US' });
  assert.equal(b.usSsWagesYTD, 15_000);
});

test('SE-classify: SE income does NOT feed the SS wage-base filler (SE is not W-2 wages)', () => {
  const m = new UsTaxModule2026();
  const next = getFn(m, 'SE_INCOME_US_TAX')(usState(), { amount: 50_000, residency: 'US' });
  assert.equal(next.usSsWagesYTD ?? 0, 0);
});

test('SE-classify (SE-8): AU self-employment income is ordinary income, never SECA', () => {
  const m = new AuTaxModule2026();
  const s0 = { ...usState(), auOrdinaryIncomeYTD: 0, currentPeriods: { AU: { startMs: Date.UTC(2025, 0, 1) } } };
  const next = getFn(m, 'AU_SE_INCOME_TAX')(s0, { amount: 90_000, residency: 'AU', personKey: null });
  assert.equal(next.auOrdinaryIncomeYTD, 90_000, 'AU ordinary income');
  assert.equal(next.usSeEarningsYTD ?? 0, 0, 'no US SECA base');
});

// ══════════════════════════════════════════════════════════════════════════════
// SE-rates: SECA in computeTax()
// ══════════════════════════════════════════════════════════════════════════════

test('SE-1: SECA basic — 12.4% SS + 2.9% Medicare on 92.35% of net earnings, half deducted', () => {
  const gross  = 100_000;
  const detail = usRates.computeTax(usState({
    usOrdinaryIncomeYTD: gross, usSeEarningsYTD: gross, usFilingSingle: true,
  }));
  const seNet   = gross * NET_FACTOR;
  const expected = seNet * SS_RATE + seNet * MED_RATE;
  assert.ok(Math.abs(detail.selfEmploymentTax - expected) < 1e-6, 'SECA amount');
  assert.equal(detail.seNetEarnings, seNet);
  assert.ok(Math.abs(detail.selfEmploymentTaxDeduction - expected / 2) < 1e-6, 'half deductible');
  assert.equal(detail.additionalMedicareTax, 0, 'below the surtax threshold');
});

test('SE-2: wage-base coordination — W-2 wages at the base zero out the SE SS portion', () => {
  const detail = usRates.computeTax(usState({
    usOrdinaryIncomeYTD: WAGE_BASE + 50_000,
    usSsWagesYTD:        WAGE_BASE,   // base already fully filled by wages
    usSeEarningsYTD:     50_000,
    usFilingSingle:      true,
  }));
  const seNet = 50_000 * NET_FACTOR;
  // SS portion = 0 (no base left); only Medicare 2.9% remains.
  assert.ok(Math.abs(detail.selfEmploymentTax - seNet * MED_RATE) < 1e-6);
});

test('SE-3: partial coordination — SE SS applies only to the remaining wage base', () => {
  const wages = 150_000;
  const detail = usRates.computeTax(usState({
    usOrdinaryIncomeYTD: wages + 50_000,
    usSsWagesYTD:        wages,
    usSeEarningsYTD:     50_000,
    usFilingSingle:      true,
  }));
  const seNet     = 50_000 * NET_FACTOR;
  const baseLeft  = WAGE_BASE - wages;             // 26,100
  const expected  = Math.min(seNet, baseLeft) * SS_RATE + seNet * MED_RATE;
  assert.ok(Math.abs(detail.selfEmploymentTax - expected) < 1e-6);
});

test('SE-4: Additional Medicare 0.9% over the MFJ threshold, none below', () => {
  // Combined earned = 200k wages + 92,350 net SE = 292,350; excess over 250k = 42,350.
  const over = usRates.computeTax(usState({
    usOrdinaryIncomeYTD: 300_000,
    usSsWagesYTD:        200_000,
    usSeEarningsYTD:     100_000,
    usFilingSingle:      false,
  }));
  const earned = 200_000 + 100_000 * NET_FACTOR;
  assert.ok(Math.abs(over.additionalMedicareTax - (earned - 250_000) * ADDL_MED_RATE) < 1e-6);

  const under = usRates.computeTax(usState({
    usOrdinaryIncomeYTD: 100_000, usSeEarningsYTD: 100_000, usFilingSingle: false,
  }));
  assert.equal(under.additionalMedicareTax, 0);
});

test('SE-5: the ½-SE-tax deduction lowers AGI (and thus ordinary income tax)', () => {
  const gross = 120_000;
  const se  = usRates.computeTax(usState({ usOrdinaryIncomeYTD: gross, usSeEarningsYTD: gross, usFilingSingle: true }));
  const wage = usRates.computeTax(usState({ usOrdinaryIncomeYTD: gross, usFilingSingle: true }));
  assert.ok(Math.abs(se.adjustedGrossIncome - (gross - se.selfEmploymentTaxDeduction)) < 1e-6, 'AGI reduced by ½ SE tax');
  assert.ok(se.adjustedGrossIncome < wage.adjustedGrossIncome, 'lower AGI than the wage case');
  assert.ok(se.ordinaryTax < wage.ordinaryTax, 'lower income tax on the deducted AGI');
});

test('SE-6: SECA and the surtax are outside the FTC and added on top of net liability', () => {
  const detail = usRates.computeTax(usState({
    usOrdinaryIncomeYTD:     300_000,
    usSeEarningsYTD:         100_000,
    usSsWagesYTD:            200_000,
    usFilingSingle:          false,
    foreignGeneralIncomeYTD: 300_000,   // ample foreign tax to credit against Chapter-1
    ftcCurrentGeneral:       200_000,
    ftcPoolGeneral:          {},
    ftcPoolPassive:          {},
    currentPeriods:          { US: { startMs: Date.UTC(2025, 0, 1) } },
  }));
  const chapter1 = detail.ordinaryTax + detail.capitalGainsTax + detail.collectiblesTax + detail.penaltyTax;
  assert.ok(detail.selfEmploymentTax > 0);
  // Employee FICA (design 95 phase 4) joins the identity: this state carries
  // \$200,000 of W-2 wages alongside the SE income, so Chapter 21 is charged too.
  // It is a Chapter-21 tax on the same footing as SECA — outside the §904
  // limitation base and never reached by the credit.
  assert.ok(detail.ficaTax > 0, 'control: wages in this state do attract FICA');
  assert.equal(detail.grossTax,
    chapter1 + detail.niitTax + detail.selfEmploymentTax + detail.additionalMedicareTax
    + detail.ficaTax);
  const surtaxes = detail.selfEmploymentTax + detail.additionalMedicareTax + detail.niitTax
    + detail.ficaTax;
  assert.ok(detail.netLiability >= surtaxes - 1e-6, 'FTC never reaches SECA/FICA/surtax');
});

test('SE-10: no SE income → SECA fields are zero (default golden path is inert)', () => {
  const detail = usRates.computeTax(usState({ usOrdinaryIncomeYTD: 90_000, usFilingSingle: false }));
  assert.equal(detail.selfEmploymentTax, 0);
  assert.equal(detail.additionalMedicareTax, 0);
  assert.equal(detail.selfEmploymentTaxDeduction, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// SE-routing: PayrollHandler routes self-employed people through the SE path
// (design 95 phase 6 — was MonthlyWagesHandler, retired once the pipeline owned this)
// ══════════════════════════════════════════════════════════════════════════════

function wagesState(person) {
  return { people: { p1: { name: 'P', ...person } } };
}
const findType = (actions, type) => actions.find(a => a?.type === type);

test('SE-7: self-employed USD person → SE_INCOME_US_APPLY (not wages), credits transaction account', () => {
  const h = new PayrollHandler({ stage: PAYROLL_STAGE.INCOME });
  const actions = h.call({ date: new Date(Date.UTC(2030, 0, 1)),
    state: wagesState({ monthlyWage: 8_000, wageCurrency: 'USD', residency: 'US', selfEmployed: true }) });
  const se = findType(actions, 'SE_INCOME_US_APPLY');
  assert.ok(se, 'emits SE_INCOME_US_APPLY');
  assert.equal(se.amount, 8_000);
  assert.equal(se.personKey, 'p1');
  assert.equal(se.targetKey, 'usSavingsAccount');
  assert.equal(findType(actions, 'WAGES_INCOME_APPLY'), undefined, 'no wages action');
});

test('SE-8b: self-employed AUD person → SE_INCOME_AU_APPLY (not AU wages)', () => {
  const h = new PayrollHandler({ stage: PAYROLL_STAGE.INCOME });
  const actions = h.call({ date: new Date(Date.UTC(2030, 0, 1)),
    state: wagesState({ monthlyWage: 6_000, wageCurrency: 'AUD', residency: 'AU', selfEmployed: true }) });
  assert.ok(findType(actions, 'SE_INCOME_AU_APPLY'), 'emits SE_INCOME_AU_APPLY');
  assert.equal(findType(actions, 'AU_WAGES_INCOME_APPLY'), undefined, 'no AU wages action');
});

test('SE-routing: a non-self-employed person still routes through the wages path', () => {
  const h = new PayrollHandler({ stage: PAYROLL_STAGE.INCOME });
  const actions = h.call({ date: new Date(Date.UTC(2030, 0, 1)),
    state: wagesState({ monthlyWage: 8_000, wageCurrency: 'USD', residency: 'US', selfEmployed: false }) });
  assert.ok(findType(actions, 'WAGES_INCOME_APPLY'), 'emits wages');
  assert.equal(findType(actions, 'SE_INCOME_US_APPLY'), undefined, 'no SE action');
});

// ══════════════════════════════════════════════════════════════════════════════
// SE-model: the flag threads through the builder and survives serialization
// ══════════════════════════════════════════════════════════════════════════════

test('SE-model: PersonBuilder and Person carry selfEmployed', () => {
  const p = PersonBuilder.person().name('Sole').monthlyWage(9_000).selfEmployed(true).build();
  assert.equal(p.selfEmployed, true);
  assert.equal(new Person(null, new Date(), {}).selfEmployed, false, 'defaults to false');
});

test('SE-9: selfEmployed survives a serialization round-trip', () => {
  const p = new Person('per-1', new Date(Date.UTC(1980, 0, 1)), { name: 'Sole', monthlyWage: 9_000, selfEmployed: true });
  const restored = ScenarioSerializer._makePerson(ScenarioSerializer._serializePerson(p));
  assert.equal(restored.selfEmployed, true);
});
