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
 * tax-cross-border-relief.test.mjs — design 52 §4.3–4.6.
 *
 * Validates the relief flip end of the mechanics:
 *   - US per-§904-basket FTC (tax-paid, not income) with the limitation, basket
 *     isolation, and 10-year vintage draw-down/expiry.
 *   - The AU→US pool funding handoff (AuTaxSettleApplyReducer → ftcCurrent*).
 *   - The US→AU FITO handoff (UsTaxSettleHandler with/without → usTaxPaidOnUsSourceAud).
 *   - AU FITO with the with/without limit, $1,000 de-minimis, and no carryforward.
 *   - Reset asymmetry: income numerators zero at the settle; pools persist.
 *
 * Numbers are hand-computed against the 2025 US MFJ and AU resident brackets so a
 * wiring regression shows up as a concrete arithmetic mismatch.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { UsTaxRates2025 } from '../../src/finance/tax/us/us-tax-rates-2025.js';
import { AuTaxRates2025 } from '../../src/finance/tax/au/au-tax-rates-2025.js';
import { AuTaxModule2026 } from '../../src/finance/tax/au/au-tax-module-2026.js';
import { AuTaxRates2027 } from '../../src/finance/tax/au/au-tax-rates-2027.js';
import { _drawDownBasket } from '../../src/finance/tax/us/us-tax-rates-base.js';
import {
  UsTaxSettleHandler,
  UsTaxSettleApplyReducer,
  AuTaxSettleApplyReducer,
} from '../../src/finance/tax/tax-settle-classes.js';

const usPeriod2025 = { US: { startMs: Date.UTC(2025, 0, 1) } };
const rate1 = { USD_AUD: 1 };   // 1:1 FX so AUD↔USD is the identity — keeps arithmetic transparent

// ─── US FTC — per §904 basket (§4.3) ────────────────────────────────────────

test('FTC-1: credits the actual AU tax paid (not the income); residual US tax collected', () => {
  const r = new UsTaxRates2025().computeTax({
    usFilingSingle: false,
    effectiveExchangeRates: rate1,
    currentPeriods: usPeriod2025,
    usOrdinaryIncomeYTD: 50_000,        // AU passive income, also worldwide US income
    foreignPassiveIncomeYTD: 50_000,    // §904 Passive numerator
    ftcCurrentPassive: 1_200,           // AU tax actually paid on it (USD), below the §904 limit
  });
  // taxable 20k → grossTax 2,000; passive limit clamps to grossTax; credit = AU tax paid.
  assert.equal(r.grossTax, 2_000);
  assert.equal(r.credits, 1_200, 'credit = AU tax paid, not the 50k income');
  assert.equal(r.netLiability, 800, 'residual US tax collected');
  assert.equal(r.ftc.general.credit, 0);
});

test('FTC-2: §904 per-basket cap — high foreign tax on a small passive share', () => {
  const r = new UsTaxRates2025().computeTax({
    usFilingSingle: false,
    effectiveExchangeRates: rate1,
    currentPeriods: usPeriod2025,
    usOrdinaryIncomeYTD: 100_000,
    foreignPassiveIncomeYTD: 10_000,
    ftcCurrentPassive: 5_000,           // AU tax far exceeds the §904 headroom
  });
  // grossTax tax(70k)=7,923. Design 83 G1 — the numerator is Form 1116 line 7, not
  // gross: 3e=100k, 3c=30k std deduction, 3f=10k/100k=0.1, 3g=3,000, so the passive
  // basket's foreign TAXABLE income is 10,000−3,000=7,000. frac = 7k/70k = 0.1 and
  // the limit is 7,923 × 0.1 = 792.30 (it was 1,131.857 on the gross numerator).
  assert.ok(Math.abs(r.ftc.passive.apportionedDeduction - 3_000) < 0.005, 'ratable share of the std deduction');
  assert.ok(Math.abs(r.ftc.passive.numerator - 7_000) < 0.005, 'Form 1116 line 7');
  assert.ok(Math.abs(r.credits - 792.30) < 0.5, `credit ${r.credits}`);
  assert.ok(Math.abs(r.ftc.passive.carryforwardRemaining - 4_207.70) < 0.5, 'excess → passive pool');
  assert.ok(Math.abs((r.ftc.nextPoolPassive[2025] ?? 0) - 4_207.70) < 0.5, 'banked at the 2025 vintage');
  assert.equal(Object.keys(r.ftc.nextPoolGeneral).length, 0, 'General pool untouched');
});

test('FTC-3: basket isolation — excess General tax does not shelter Passive US tax', () => {
  const r = new UsTaxRates2025().computeTax({
    usFilingSingle: false,
    effectiveExchangeRates: rate1,
    currentPeriods: usPeriod2025,
    usOrdinaryIncomeYTD: 100_000,
    foreignGeneralIncomeYTD: 60_000,
    foreignPassiveIncomeYTD: 10_000,
    ftcCurrentGeneral: 50_000,          // huge General excess
    ftcCurrentPassive: 500,             // small Passive tax, below its own limit
  });
  // Passive credit is capped at its own avail (500), NOT topped up by the General excess.
  assert.equal(r.ftc.passive.credit, 500, 'General excess must not spill into Passive');
  // Design 83 G1 — general line 7 = 60,000 − 30,000×(60k/100k) = 42,000, so
  // frac = 42k/70k = 0.6 and the limit is 7,923 × 0.6 = 4,753.80 (was 6,791.14).
  assert.ok(Math.abs(r.ftc.general.credit - 4_753.80) < 0.5, 'General credit at its §904 limit');
  // The whole point of the apportionment: two baskets over one taxpayer's income
  // can no longer claim more than 100% of it between them.
  assert.ok(r.ftc.general.frac + r.ftc.passive.frac <= 1 + 1e-9,
    `fractions sum to ${r.ftc.general.frac + r.ftc.passive.frac}`);
});

// ─── §904 limitation base and invariants — design 83 G1/G2 ──────────────────

test('FTC-G2: the §72(t) penalty is tax owed but NOT part of the §904 limitation base', () => {
  const base = {
    usFilingSingle: false,
    effectiveExchangeRates: rate1,
    currentPeriods: usPeriod2025,
    usOrdinaryIncomeYTD: 100_000,
    foreignPassiveIncomeYTD: 10_000,
    ftcCurrentPassive: 5_000,          // far more AU tax than the limit can absorb
  };
  const clean     = new UsTaxRates2025().computeTax(base);
  const penalised = new UsTaxRates2025().computeTax({ ...base, usPenaltyYTD: 20_000 });

  // Form 1116 line 20 takes Form 1040 line 16 + Schedule 2 line 1z. The §72(t)
  // additional tax is a §26(b)(2) tax reported in Schedule 2 PART II, so it must
  // not enlarge the limitation — the credit is identical with and without it.
  assert.equal(penalised.regularTax, clean.regularTax, 'regular tax is penalty-free');
  assert.equal(penalised.ftc.limitationBase, clean.regularTax, 'the base IS the regular tax');
  assert.equal(penalised.ftc.passive.limit, clean.ftc.passive.limit, 'the §904 limit does not move');
  assert.equal(penalised.credits, clean.credits, 'nor does the credit');

  // It is still real tax: it rides in grossTax, and lands in netLiability AFTER
  // the credit rather than being sheltered by it.
  assert.equal(penalised.grossTax - clean.grossTax, 20_000);
  assert.equal(penalised.netLiability - clean.netLiability, 20_000);
  // Footing survives: gross − credits = net.
  assert.ok(Math.abs(penalised.grossTax - penalised.credits - penalised.netLiability) < 0.005);
});

test('FTC-G1: the §904 fractions cannot sum past 1 even when all income is foreign', () => {
  // The failure design 83 was opened on: a 5.157 limitation fraction, from gross
  // numerators divided by a denominator net of the standard deduction.
  const r = new UsTaxRates2025().computeTax({
    usFilingSingle: false,
    effectiveExchangeRates: rate1,
    currentPeriods: usPeriod2025,
    usOrdinaryIncomeYTD: 100_000,
    foreignGeneralIncomeYTD: 40_000,
    foreignPassiveIncomeYTD: 60_000,     // general + passive = 100% of gross income
    ftcCurrentGeneral: 9_000,
    ftcCurrentPassive: 9_000,
  });
  const sum = r.ftc.general.frac + r.ftc.passive.frac;
  assert.ok(Math.abs(sum - 1) < 1e-9, `all-foreign income ⇒ fractions sum to exactly 1, got ${sum}`);
  // …and the identity that makes it hold: denominator = 3e − 3c − FEIE.
  assert.ok(Math.abs(r.ftc.totalTaxable
    - (r.ftc.grossIncomeAllSources - r.ftc.unrelatedDeductions)) < 0.005);
  // Neither basket may claim more room than the whole return has.
  for (const b of [r.ftc.general, r.ftc.passive]) {
    assert.ok(b.numerator <= r.ftc.totalTaxable + 0.005);
  }
  // And the credit can never exceed the tax it is credited against.
  assert.ok(r.credits <= r.ftc.limitationBase + 0.005);
});

test('FTC-G1: the ½-SE-tax and pre-tax-contribution deductions are apportioned too', () => {
  // Form 1116 line 3b — "any other deductions that don't definitely relate to any
  // specific type of income (for example, deductions shown on Schedule 1 (Form
  // 1040), Part II, Adjustments to Income)". Apportioning the standard deduction
  // alone would leave these unallocated and the fractions could still overshoot.
  const r = new UsTaxRates2025().computeTax({
    usFilingSingle: false,
    effectiveExchangeRates: rate1,
    currentPeriods: usPeriod2025,
    usOrdinaryIncomeYTD: 100_000,
    usNegativeIncomeYTD: 10_000,          // deductible IRA / 401k contribution
    foreignPassiveIncomeYTD: 100_000,     // every dollar is foreign
    ftcCurrentPassive: 50_000,
  });
  assert.ok(Math.abs(r.ftc.unrelatedDeductions - 40_000) < 0.005,
    '30,000 standard deduction + 10,000 of adjustments');
  assert.ok(Math.abs(r.ftc.passive.apportionedDeduction - 40_000) < 0.005,
    'all income is foreign, so the whole of 3c is apportioned to the one basket');
  assert.ok(Math.abs(r.ftc.passive.frac - 1) < 1e-9);
});

// ─── FTC vintage draw-down / aging (§4.3) ────────────────────────────────────

test('draw-down: current-year foreign tax is consumed before carryover vintages', () => {
  const { nextPool, currentYearUsed, carryoverUsed } = _drawDownBasket(500, { 2020: 1_000 }, 800, 2025);
  assert.equal(currentYearUsed, 500, 'all of the current-year tax used first');
  assert.equal(carryoverUsed, 300, 'then 300 drawn from the vintage');
  assert.deepEqual(nextPool, { 2020: 700 });
});

test('draw-down: carryover vintages are drawn oldest → newest', () => {
  const { nextPool } = _drawDownBasket(0, { 2020: 1_000, 2023: 1_000 }, 1_200, 2025);
  assert.deepEqual(nextPool, { 2023: 800 }, '2020 drained first, then 200 from 2023');
});

test('draw-down: unused current-year tax opens a new vintage keyed by the settle year', () => {
  const { nextPool } = _drawDownBasket(1_000, {}, 300, 2025);
  assert.deepEqual(nextPool, { 2025: 700 });
});

test('draw-down: vintages older than 10 years expire', () => {
  const { nextPool } = _drawDownBasket(0, { 2014: 1_000, 2020: 500 }, 0, 2025);
  assert.deepEqual(nextPool, { 2020: 500 }, '2025−2014=11 > 10 → expired; 2020 kept');
});

// ─── AU→US pool funding (§4.4) ───────────────────────────────────────────────

test('funding: AU settle apportions the AU tax to baskets in USD', () => {
  const out = new AuTaxSettleApplyReducer().reduce(
    { effectiveExchangeRates: rate1, foreignGeneralIncomeYTD: 0, foreignPassiveIncomeYTD: 50_000, auSuperTaxYTD: 2_000 },
    { type: 'AU_TAX_SETTLE_APPLY', tax: 10_000 },   // post-FITO AU net liability (AUD)
  );
  // Design 77 §5.3 — `tax` no longer contains the Div 295 super fund tax at all
  // (it left the member's liability), so the reducer must NOT subtract auSuperTaxYTD
  // a second time. It is present in state here precisely to catch that: a residual
  // `− superTax` would produce 8,000 and understate the creditable base.
  assert.equal(out.ftcCurrentPassive, 10_000);
  assert.equal(out.ftcCurrentGeneral, 0);
});

test('funding: super fund tax is NOT creditable and never enters the §904 baskets', () => {
  // The member had no personal AU liability at all this year — only the fund paid
  // tax. Nothing is creditable: §901 credits the person on whom the foreign law
  // imposes liability (Treas. Reg. §1.901-2(f)), and that is the fund's trustee.
  const out = new AuTaxSettleApplyReducer().reduce(
    { effectiveExchangeRates: rate1, foreignGeneralIncomeYTD: 0, foreignPassiveIncomeYTD: 50_000, auSuperTaxYTD: 9_000 },
    { type: 'AU_TAX_SETTLE_APPLY', tax: 0, fundTax: 9_000 },
  );
  assert.equal(out.ftcCurrentPassive, 0);
  assert.equal(out.ftcCurrentGeneral, 0);
});

test('funding: mixed baskets split by AU-source income share', () => {
  const out = new AuTaxSettleApplyReducer().reduce(
    { effectiveExchangeRates: rate1, foreignGeneralIncomeYTD: 25_000, foreignPassiveIncomeYTD: 25_000, auSuperTaxYTD: 0 },
    { type: 'AU_TAX_SETTLE_APPLY', tax: 8_000 },
  );
  assert.equal(out.ftcCurrentGeneral, 4_000);
  assert.equal(out.ftcCurrentPassive, 4_000);
});

// ─── US→AU FITO funding (§4.6) ───────────────────────────────────────────────

test('FITO funding: US settle measures the marginal US tax on US-source income (AUD)', () => {
  const [apply] = new UsTaxSettleHandler().call({ state: {
    usFilingSingle: false,
    effectiveExchangeRates: rate1,
    currentPeriods: usPeriod2025,
    people: { primary: { residency: 'AU' } },
    usOrdinaryIncomeYTD: 100_000,
    usSourceOrdinaryUsdYTD: 40_000,   // US-source slice booked while AU-resident
  } });
  // tax(70k)=7,923 with; without the 40k → tax(30k)=3,123; marginal = 4,800.
  assert.ok(Math.abs(apply.usTaxPaidOnUsSourceAud - 4_800) < 0.5, `handoff ${apply.usTaxPaidOnUsSourceAud}`);
});

test('FITO-G5: the Art. 22(2) figure is measured BEFORE the credit for Australian tax', () => {
  // Art. 22(4): "The credit so allowed against United States tax shall not reduce that
  // portion of the United States tax that is creditable against Australian tax in
  // accordance with paragraph (2)." So piling Australian tax into the §904 pools must
  // not shrink what Australia is told the US charged on US-source income — which is
  // exactly what a post-credit `netLiability` differential did (design 83 §13.1).
  const base = {
    usFilingSingle: false,
    effectiveExchangeRates: rate1,
    currentPeriods: usPeriod2025,
    people: { primary: { residency: 'AU' } },
    usOrdinaryIncomeYTD: 100_000,
    usSourceOrdinaryUsdYTD: 40_000,
    usSourceGeneralUsdYTD:  40_000,   // re-sourced under Art. 27(1)(c), general basket
  };
  const [noAuTax] = new UsTaxSettleHandler().call({ state: base });
  // Far more Australian tax than the general basket can absorb, so the credit is
  // limitation-bound and takes as much of the liability as §904 permits.
  const [credited] = new UsTaxSettleHandler().call({
    state: { ...base, ftcCurrentGeneral: 50_000 },
  });

  assert.ok(noAuTax.usTaxPaidOnUsSourceAud > 0, 'sanity: there is a figure to erode');
  assert.strictEqual(credited.usTaxPaidOnUsSourceAud, noAuTax.usTaxPaidOnUsSourceAud,
    'the Art. 22(4) credit must not erode the Art. 22(2) base — pre-G5 this fell with it');
  // The credit really did bite, so the old post-credit differential had a smaller
  // liability to measure. Without this the test could pass on a state where the
  // credit never bound at all and nothing was being tested.
  assert.ok(credited.taxDetail.netLiability < noAuTax.taxDetail.netLiability * 0.7,
    `credit did not bind: ${credited.taxDetail.netLiability} vs ${noAuTax.taxDetail.netLiability}`);
});

test('FITO-G10: Art. 10/11 cap the dividend and interest slices of the Art. 22(2) figure', () => {
  // Same 40k of US-source income, but now it is all dividends and interest. The
  // citizen's marginal rate on it is 12% (4,800 / 40,000); the treaty lets Australia
  // credit only 15% of gross dividends + 10% of gross interest.
  const base = {
    usFilingSingle: false,
    effectiveExchangeRates: rate1,
    currentPeriods: usPeriod2025,
    people: { primary: { residency: 'AU' } },
    usOrdinaryIncomeYTD: 100_000,
    usSourceOrdinaryUsdYTD: 40_000,
  };
  const [uncapped] = new UsTaxSettleHandler().call({ state: base });

  // 30k interest (ceiling 3,000) + 10k dividends (ceiling 1,500) = 4,500 < 4,800.
  const [capped] = new UsTaxSettleHandler().call({ state: {
    ...base,
    usSourceInterestUsdYTD:  30_000,
    usSourceDividendsUsdYTD: 10_000,
  } });
  assert.ok(Math.abs(capped.usTaxPaidOnUsSourceAud - 4_500) < 0.5,
    `treaty ceiling should bind at 4,500, got ${capped.usTaxPaidOnUsSourceAud}`);
  assert.ok(capped.usTaxPaidOnUsSourceAud < uncapped.usTaxPaidOnUsSourceAud,
    'the excess over the treaty rate is US tax imposed by reason of citizenship, which Art. 22(2) excludes');
});

test('FITO-G10: the cap is a ceiling, not a substitution', () => {
  // A tiny amount of US-source interest inside a low-income year: the actual US tax
  // on it is under 10% of gross, and Australia may credit only what was PAID.
  const [apply] = new UsTaxSettleHandler().call({ state: {
    usFilingSingle: false,
    effectiveExchangeRates: rate1,
    currentPeriods: usPeriod2025,
    people: { primary: { residency: 'AU' } },
    usOrdinaryIncomeYTD: 32_000,      // barely over the 30k standard deduction
    usSourceOrdinaryUsdYTD: 2_000,
    usSourceInterestUsdYTD: 2_000,    // ceiling would be 200
  } });
  // Taxable is 2,000, all in the 10% bracket ⇒ 200 with, 0 without ⇒ marginal 200,
  // which happens to equal the ceiling here; the point is it is never MORE than paid.
  assert.ok(apply.usTaxPaidOnUsSourceAud <= 200 + 0.5,
    `credit ${apply.usTaxPaidOnUsSourceAud} exceeds both the tax paid and the ceiling`);
});

test('G6: a super withdrawal creates GENERAL basket limitation room', () => {
  // Design 83 G6. Australian super is tax-free after 60, so there is no AU tax on the
  // super itself — but Pub 514 sources investment earnings on pension contributions to
  // the location of the pension trust, so the distribution is foreign-source general
  // income and generates limitation room that AU tax from OTHER sources can fill.
  const fn = new AuTaxModule2026().getReducerFns().get('SUPER_WITHDRAWAL_EARNINGS_TAX');
  const next = fn(
    { usOrdinaryIncomeYTD: 0, foreignGeneralIncomeYTD: 0, effectiveExchangeRates: rate1 },
    { type: 'SUPER_WITHDRAWAL_EARNINGS_TAX', amount: 50_000 });
  assert.equal(next.usOrdinaryIncomeYTD, 50_000, 'still US ordinary income');
  assert.equal(next.foreignGeneralIncomeYTD, 50_000,
    'and now general-basket room — before G6 it raised the §904 denominator and no numerator');
  assert.equal(next.foreignPassiveIncomeYTD ?? 0, 0,
    'a pension is absent from Pub 514’s passive list; general is the residual category');
});

// ─── AU FITO (§4.5) ──────────────────────────────────────────────────────────

const auFitoState = (usTaxPaidAud) => ({
  people: { primary: { residency: 'AU' } },
  auOrdinaryIncomeYTD: 100_000,      // 60k US-source IRA + 40k AU passive
  usSourceOrdinaryAudYTD: 60_000,
  usTaxPaidOnUsSourceAud: usTaxPaidAud,
});

test('FITO-1: AU tax drops by the US tax paid, capped by the with/without limit', () => {
  const noRelief = new AuTaxRates2025().computeTax(auFitoState(0));
  const withFito = new AuTaxRates2025().computeTax(auFitoState(15_000));
  // pre-FITO 22,788 (baseTax 20,788 + medicare 2,000); without-US-source 4,288 → limit 18,500.
  assert.ok(Math.abs(withFito.fitoLimit - 18_500) < 0.5, `limit ${withFito.fitoLimit}`);
  assert.equal(withFito.fito, 15_000, 'US tax fully credited (below the limit)');
  assert.equal(withFito.fitoDeMinimis, false);
  assert.ok(Math.abs((noRelief.netLiability - withFito.netLiability) - 15_000) < 0.5, 'AU tax falls by the US tax paid');
});

test('FITO: excess over the limit is lost (no carryforward)', () => {
  const r = new AuTaxRates2025().computeTax(auFitoState(20_000));
  assert.ok(Math.abs(r.fito - 18_500) < 0.5, 'offset capped at the limit; the 1,500 excess is lost');
});

test('FITO-2: A$1,000 de-minimis offsets in full and skips the limit calc', () => {
  const r = new AuTaxRates2025().computeTax(auFitoState(800));
  assert.equal(r.fito, 800);
  assert.equal(r.fitoDeMinimis, true);
  assert.equal(r.fitoLimit, null, 'limit calc skipped');
});

// ─── FY2027 FITO "without" pass reduces the REAL bucket (design 57 Part 2, D) ──

// FY2027 assesses auRealCapitalGainsYTD (indexed), not the gross auCapitalGainsYTD.
// A resident whose capital gain is entirely US-source: the FITO "without US-source"
// pass must strip the gain from the REAL bucket too, or the CG slice of the FITO
// limit collapses to ~0 and the US tax paid on that gain goes uncredited.
const auFito2027RealState = (usTaxPaidAud) => ({
  people: { primary: { residency: 'AU' } },
  auOrdinaryIncomeYTD: 0,
  auCapitalGainsYTD:      100_000,   // gross
  auRealCapitalGainsYTD:  100_000,   // real (indexed) — what FY2027 assesses
  usSourceCapGainsAudYTD:     100_000,  // all US-source (gross slice)
  usSourceRealCapGainsAudYTD: 100_000,  // all US-source (real slice, design 57 Part 2 D)
  usTaxPaidOnUsSourceAud: usTaxPaidAud,
});

test('FITO-D: FY2027 with/without limit tracks the REAL (indexed) US-source gain', () => {
  const r = new AuTaxRates2027().computeTax(auFito2027RealState(50_000));
  // "with" pre-FITO: baseTax(100k)=20,252 + medicare 2,000 + 30% min-tax top-up
  //   (30,000 − 20,252)=9,748 ⇒ 32,000. "without": real bucket → 0 ⇒ pre-FITO 0.
  // So the whole 32,000 is the CG slice of the limit; the 50k US tax is capped there.
  assert.ok(Math.abs(r.fitoLimit - 32_000) < 1, `limit ${r.fitoLimit}`);
  assert.ok(Math.abs(r.fito - 32_000) < 1, `fito ${r.fito}`);
});

test('FITO-D: without the real-bucket reduction the CG slice would collapse to ~0', () => {
  // Same state but WITHOUT the usSourceRealCapGainsAudYTD signal: the "without" pass
  // can only strip the gross bucket (unread by FY2027), so the real bucket is
  // unchanged and the limit's CG slice is ~0 — the design-57 Part-2-D bug.
  const buggy = { ...auFito2027RealState(50_000), usSourceRealCapGainsAudYTD: 0 };
  const r = new AuTaxRates2027().computeTax(buggy);
  assert.ok(r.fitoLimit < 1, `limit should collapse without the real signal, got ${r.fitoLimit}`);
  assert.ok(r.fito < 1, `fito ${r.fito}`);
});

// ─── Reset asymmetry (§4.3 / §5) ─────────────────────────────────────────────

test('FTC-5: income numerators zero at the US settle; pools persist + handoff written', () => {
  const out = new UsTaxSettleApplyReducer().reduce(
    {
      foreignGeneralIncomeYTD: 3_000, foreignPassiveIncomeYTD: 5_000,
      usSourceOrdinaryUsdYTD: 1_000, ftcCurrentPassive: 200,
      ftcPoolPassive: { 2024: 100 }, ftcPoolGeneral: {},
    },
    {
      type: 'US_TAX_SETTLE_APPLY', tax: 0,
      taxDetail: { ftc: { nextPoolPassive: { 2024: 100, 2025: 80 }, nextPoolGeneral: {} } },
      usTaxPaidOnUsSourceAud: 999,
    },
  );
  assert.equal(out.foreignGeneralIncomeYTD, 0, 'numerator reset');
  assert.equal(out.foreignPassiveIncomeYTD, 0);
  assert.equal(out.usSourceOrdinaryUsdYTD, 0);
  assert.equal(out.ftcCurrentPassive, 0, 'current-year foreign tax reset (banked into the pool)');
  assert.deepEqual(out.ftcPoolPassive, { 2024: 100, 2025: 80 }, 'pool persists + carries the banked vintage');
  assert.equal(out.usTaxPaidOnUsSourceAud, 999, 'FITO handoff written (not reset)');
});
