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
 * evt-residency-cgt.test.mjs
 *
 * Design 62 §4 (Gap 1) — the AU CGT 50%-discount / indexation holding-period clock
 * restarts at the residency deemed-acquisition date (ATO "How changing residency
 * affects CGT"), not the original purchase date.
 *
 *   - EVT-62: recordResidencyChange stamps acquisitionDateByCountry.AU at the move
 *     (and leaves purchaseDate unchanged).
 *   - EVT-62: consumeHoldingsFifo excludes a lot sold <12mo from the deemed-acquisition
 *     date from the discountable-gain slice, and includes one sold ≥12mo after.
 *   - EVT-62: consumeHoldingsFifo's ≥12-month INDEXATION test keys off the deemed-
 *     acquisition date (Gap 1b), not the pre-move purchase date.
 *   - EVT-62: AuTaxRatesBase._cgtRelief discounts only auDiscountableGainsYTD, and
 *     falls back to the full gain when the field is absent (old-save safety).
 *   - EVT-62: Holding round-trips acquisitionDateByCountry through serialize/deserialize.
 *
 * Run with: node --test tests/unit/evt-residency-cgt.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AccountService }      from '../../src/finance/services/account-service.js';
import { ACCOUNT_TYPE }        from '../../src/finance/assets/account.js';
import { ALLOCATION }          from '../../src/finance/holdings/allocation.js';
import { consumeHoldingsFifo } from '../../src/finance/holdings/holdings-fifo.js';
import { Holding }             from '../../src/finance/holdings/holding.js';
import { AuTaxRates2025 }      from '../../src/finance/tax/au/au-tax-rates-2025.js';

const YEAR_MS  = 365 * 24 * 60 * 60 * 1000;
const MOVE_MS  = Date.UTC(2024, 6, 1);    // 1 Jul 2024 US→AU move (deemed acquisition)
const BUY_MS   = Date.UTC(2020, 0, 1);    // bought long before the move

/** A lot stepped up at the move (AU basis = 300k), appreciated to `saleMv` at sale. */
function steppedLot(saleMv) {
  const account = {
    type: ACCOUNT_TYPE.BROKERAGE, balance: 300_000, balanceAtResidencyChange: null,
    holdings: [{
      allocation: ALLOCATION.EQUITY, costBasis: 100_000, marketValue: 300_000,
      purchaseDate: new Date(BUY_MS), costBaseByCountry: null,
      acquisitionPriceLevel: null, acquisitionDateByCountry: null,
    }],
  };
  AccountService.prototype.recordResidencyChange.call(
    new AccountService(), account,
    { country: 'AU', stepUp: true, priceLevel: 1.20, asOfMs: MOVE_MS },
  );
  account.holdings[0].marketValue = saleMv;
  return account.holdings[0];
}

test('EVT-62: recordResidencyChange stamps the AU deemed-acquisition date, leaves purchaseDate', () => {
  const h = steppedLot(330_000);
  assert.equal(h.costBaseByCountry.AU, 300_000, 'AU basis = market value at move');
  assert.equal(h.acquisitionDateByCountry.AU, MOVE_MS, 'deemed-acquisition date = move date');
  assert.equal(new Date(h.purchaseDate).getTime(), BUY_MS, 'purchaseDate unchanged');
});

test('EVT-62: lot sold <12mo from the deemed acquisition is NOT discount-eligible', () => {
  const saleMs = MOVE_MS + 6 * YEAR_MS / 12;
  const r = consumeHoldingsFifo([steppedLot(330_000)], 330_000, { asOfMs: saleMs, country: 'AU' });
  const auGain = 330_000 - r.realizedBasisByCountry.AU;
  assert.equal(auGain, 30_000, 'AU gain from the stepped-up basis');
  assert.equal(r.realizedDiscountableGainByCountry.AU, 0, 'no discountable gain (held <12mo from move)');
});

test('EVT-62: lot sold ≥12mo from the deemed acquisition IS discount-eligible', () => {
  const saleMs = MOVE_MS + 18 * YEAR_MS / 12;
  const r = consumeHoldingsFifo([steppedLot(330_000)], 330_000, { asOfMs: saleMs, country: 'AU' });
  const auGain = 330_000 - r.realizedBasisByCountry.AU;
  assert.equal(r.realizedDiscountableGainByCountry.AU, auGain, 'full AU gain is discountable');
});

test('EVT-62: a lot never stepped up falls back to the purchase date for the 12mo test', () => {
  // No costBaseByCountry / acquisitionDateByCountry ⇒ uses purchaseDate (2020) ⇒ ≥12mo.
  const lot = { allocation: ALLOCATION.EQUITY, costBasis: 100_000, marketValue: 150_000, purchaseDate: new Date(BUY_MS) };
  const r = consumeHoldingsFifo([lot], 150_000, { asOfMs: MOVE_MS, country: 'AU' });
  // No costBaseByCountry ⇒ AU is absent from realizedBasisByCountry (caller falls back
  // to realizedBasis). The discountable tally still uses the costBasis fallback + the
  // purchaseDate (2020) for the ≥12mo test.
  assert.equal(r.realizedBasis, 100_000, 'realized basis = costBasis fallback');
  assert.equal(r.realizedDiscountableGainByCountry.AU, 50_000, 'discountable via purchaseDate fallback');
});

test('EVT-62 (Gap 1b): the indexation 12mo test keys off the deemed-acquisition date', () => {
  // Sold 6mo after the move but 4.5y after purchase. With a CPI level above the
  // stamped acquisition level, indexation would only apply if held ≥12mo. Because
  // the clock runs from the MOVE (held 6mo), the indexed basis must equal the raw
  // AU basis (factor 1) — no indexation relief.
  const saleMs = MOVE_MS + 6 * YEAR_MS / 12;
  const r = consumeHoldingsFifo([steppedLot(330_000)], 330_000, { level: 2.0, asOfMs: saleMs, country: 'AU' });
  assert.equal(r.realizedIndexedBasisByCountry.AU, r.realizedBasisByCountry.AU,
    'no indexation for a lot held <12mo from the deemed acquisition');
});

test('EVT-62: _cgtRelief discounts only the eligible slice, full-gain fallback when absent', () => {
  const rates = new AuTaxRates2025();
  // Field present, eligible slice 0 ⇒ no discount.
  const gated = rates._cgtRelief({ auDiscountableGainsYTD: 0 }, 30_000);
  assert.equal(gated.reliefAmount, 0, 'no discount when eligible slice is 0');
  assert.equal(gated.netTaxableGain, 30_000, 'full gain assessable');
  // Field present, fully eligible ⇒ full 50% discount.
  const full = rates._cgtRelief({ auDiscountableGainsYTD: 30_000 }, 30_000);
  assert.equal(full.reliefAmount, 15_000, '50% discount on the eligible slice');
  // Field absent ⇒ legacy behavior (discount the whole gain).
  const legacy = rates._cgtRelief({}, 30_000);
  assert.equal(legacy.reliefAmount, 15_000, 'fallback discounts the full gain');
  // Eligible slice capped at the total gain (never over-relieves).
  const capped = rates._cgtRelief({ auDiscountableGainsYTD: 99_999 }, 30_000);
  assert.equal(capped.reliefAmount, 15_000, 'discount base capped at the total gain');
});

test('EVT-62: end-to-end tax — the gate recovers the over-relief on a <12mo sale', () => {
  const rates = new AuTaxRates2025();
  const people = { p1: { residency: 'AU' } };
  const gated = rates.computeTax({ people, auOrdinaryIncomeYTD: 40_000, auCapitalGainsYTD: 30_000, auDiscountableGainsYTD: 0 });
  const legacy = rates.computeTax({ people, auOrdinaryIncomeYTD: 40_000, auCapitalGainsYTD: 30_000 });
  assert.equal(gated.cgtDiscount, 0, 'no discount on the <12mo gain');
  assert.ok(gated.netLiability > legacy.netLiability, 'gated tax exceeds the (wrong) discounted tax');
});

test('EVT-62: Holding round-trips acquisitionDateByCountry', () => {
  const h = new Holding({ allocation: ALLOCATION.EQUITY, marketValue: 100, costBasis: 50, acquisitionDateByCountry: { AU: MOVE_MS } });
  const back = Holding.fromJSON(JSON.parse(JSON.stringify(h.toJSON())));
  assert.deepEqual(back.acquisitionDateByCountry, { AU: MOVE_MS });
});
