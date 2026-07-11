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
  // grossTax tax(70k)=7,923; passive frac 10k/70k → limit = 7923*10/70 = 1,131.857.
  assert.ok(Math.abs(r.credits - 1_131.857) < 0.5, `credit ${r.credits}`);
  assert.ok(Math.abs(r.ftc.passive.carryforwardRemaining - 3_868.143) < 0.5, 'excess → passive pool');
  assert.ok(Math.abs((r.ftc.nextPoolPassive[2025] ?? 0) - 3_868.143) < 0.5, 'banked at the 2025 vintage');
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
  assert.ok(Math.abs(r.ftc.general.credit - 6_791.14) < 0.5, 'General credit at its §904 limit');
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

test('funding: AU settle apportions the AU tax (less super) to baskets in USD', () => {
  const out = new AuTaxSettleApplyReducer().reduce(
    { effectiveExchangeRates: rate1, foreignGeneralIncomeYTD: 0, foreignPassiveIncomeYTD: 50_000, auSuperTaxYTD: 2_000 },
    { type: 'AU_TAX_SETTLE_APPLY', tax: 12_000 },   // post-FITO AU net liability (AUD)
  );
  // auCreditable = 12,000 − 2,000 super = 10,000; all-passive share → all Passive.
  assert.equal(out.ftcCurrentPassive, 10_000);
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
  // pre-FITO 23,592 (baseTax 21,592 + medicare 2,000); without-US-source 4,942 → limit 18,650.
  assert.ok(Math.abs(withFito.fitoLimit - 18_650) < 0.5, `limit ${withFito.fitoLimit}`);
  assert.equal(withFito.fito, 15_000, 'US tax fully credited (below the limit)');
  assert.equal(withFito.fitoDeMinimis, false);
  assert.ok(Math.abs((noRelief.netLiability - withFito.netLiability) - 15_000) < 0.5, 'AU tax falls by the US tax paid');
});

test('FITO: excess over the limit is lost (no carryforward)', () => {
  const r = new AuTaxRates2025().computeTax(auFitoState(20_000));
  assert.ok(Math.abs(r.fito - 18_650) < 0.5, 'offset capped at the limit; the 1,350 excess is lost');
});

test('FITO-2: A$1,000 de-minimis offsets in full and skips the limit calc', () => {
  const r = new AuTaxRates2025().computeTax(auFitoState(800));
  assert.equal(r.fito, 800);
  assert.equal(r.fitoDeMinimis, true);
  assert.equal(r.fitoLimit, null, 'limit calc skipped');
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
