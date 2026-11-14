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
 * au-cgt-deemed-sale-2027.test.mjs — design 132, ITAA 1997 Subdiv 112-E.
 *
 * A lot an AU resident holds across 1 July 2027 is taken to be sold at market value just
 * before that date and reacquired (s112-155). At the real disposal:
 *   - the gain to 30 June 2027 is a DEFERRED gain (s112-160, s102-6(5)): 50% discount if
 *     held 12 months from the ORIGINAL acquisition (s115-100(aa), s112-160(3)(c)), no
 *     indexation, no 30% minimum tax (s119-5(2));
 *   - the gain after 1 July 2027 takes the new regime: indexed from July 2027
 *     (s110-36(1A) Note 4), 30% minimum tax;
 *   - capital losses reduce the deferred gain first (s102-5(1) Step 1(a)).
 *
 * Run with: node --test tests/unit/au-cgt-deemed-sale-2027.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AuCgtDeemedSale2027Reducer, AU_DEEMED_SALE_MS, AU_PRE2027_KEY }
  from '../../src/finance/tax/au/au-cgt-deemed-sale-2027.js';
import { consumeHoldings } from '../../src/finance/holdings/holdings-fifo.js';
import { deferredGainFields } from '../../src/finance/tax/au/au-cgt-2027-constants.js';
import { AuTaxModule2027 } from '../../src/finance/tax/au/au-tax-module-2027.js';
import { AuTaxRates2027 } from '../../src/finance/tax/au/au-tax-rates-2027.js';
import { applyBracketsDetailed } from '../../src/finance/tax/bracket-schedule.js';
import { ALLOCATION } from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS } from '../../src/finance/economic-regimes/rate-keys.js';

const close = (a, b, msg) => assert.ok(Math.abs((a ?? 0) - b) < 0.02, `${msg}: got ${a}, want ${b}`);

const lot = (over = {}) => ({
  id: 'lot-1', allocation: ALLOCATION.EQUITY, rateKey: RATE_KEYS.EQUITY_AU,
  marketValue: 150_000, costBasis: 100_000, purchaseDate: new Date(Date.UTC(2020, 0, 1)),
  costBaseByCountry: null, acquisitionDateByCountry: null, acquisitionPriceLevel: 0.9, ...over,
});

const stampState = (residency, holdings) => ({
  people: { primary: { residency } },
  cpiAccumulator: { AU: 1.2 },
  auStockAccount: { type: 'brokerage', ownershipType: 'sole', ownerId: 'primary', balance: 0, holdings },
});

const STAMP = new AuCgtDeemedSale2027Reducer();
const advance = (startMs) => ({ type: 'AU_PERIOD_ADVANCE', period: { startMs } });

// ── The stamp (s112-155(2)–(3)) ────────────────────────────────────────────────

test('DS-1: 1 July 2027 stamps an AU resident\'s pre-2027 lot at market value, keeping the old base', () => {
  const cash = lot({ id: 'cash', allocation: ALLOCATION.CASH, marketValue: 5_000, costBasis: 5_000 });
  const out = STAMP.reduce(stampState('AU', [lot(), cash]), advance(AU_DEEMED_SALE_MS));
  const [h, c] = out.auStockAccount.holdings;
  assert.equal(h.costBaseByCountry[AU_PRE2027_KEY], 100_000, 'the deferred gain\'s base');
  assert.equal(h.costBaseByCountry.AU, 150_000, 'the deemed reacquisition cost = market value');
  assert.equal(h.acquisitionPriceLevel, 1.2, 'indexation starts at July 2027');
  assert.equal(+h.purchaseDate, Date.UTC(2020, 0, 1), 'the 12-month tests keep the original date');
  assert.equal(h.costBasis, 100_000, 'the US basis is untouched');
  assert.equal(c.costBaseByCountry, null, 'cash has no gain to defer');
});

test('DS-1b: no stamp on another year, for a US resident, or for a lot bought on or after the date', () => {
  const s = stampState('AU', [lot()]);
  assert.equal(STAMP.reduce(s, advance(Date.UTC(2028, 6, 1))).auStockAccount.holdings[0].costBaseByCountry, null);
  const us = stampState('US', [lot()]);
  assert.equal(STAMP.reduce(us, advance(AU_DEEMED_SALE_MS)).auStockAccount.holdings[0].costBaseByCountry, null,
    'a US resident on 30 June 2027 is reached by s855-45 at the move instead');
  const late = stampState('AU', [lot({ purchaseDate: new Date(AU_DEEMED_SALE_MS) })]);
  assert.equal(STAMP.reduce(late, advance(AU_DEEMED_SALE_MS)).auStockAccount.holdings[0].costBaseByCountry, null);
});

// ── The disposal: deferred + post-2027 (s112-160, s110-36(1A)) ─────────────────

const stamped = (over = {}) => lot({
  marketValue: 200_000,
  costBaseByCountry: { [AU_PRE2027_KEY]: 100_000, AU: 150_000 },
  acquisitionPriceLevel: 1.2, ...over,
});
const sell = (holdings, amount, asOfMs, level = 1.32) => consumeHoldings(holdings, amount, {
  indexation: { level, asOfMs, country: 'AU' }, terms: { asOfMs, countries: ['US', 'AU'] },
});

test('DS-2: a partial sale splits into the deferred gain and the indexed post-2027 gain', () => {
  // Sell 40% of a lot worth 200k: AU base 150k (30 June 2027), pre-2027 base 100k.
  const r = sell([stamped()], 80_000, Date.UTC(2029, 0, 1));
  assert.deepEqual(deferredGainFields(r), { auDeferredGain: 20_000, auDeferredDiscountableGain: 20_000 },
    '0.4 × (150k − 100k), held 9 years ⇒ discount-eligible');
  close(80_000 - r.realizedBasisByCountry.AU, 20_000, 'post-2027 nominal = 80k − 0.4 × 150k');
  close(80_000 - r.realizedIndexedBasisByCountry.AU, 14_000, 'post-2027 real = 80k − 60k × 1.32/1.2');
  assert.equal(r.realizedBasisByCountry[AU_PRE2027_KEY], undefined, 'the pre-2027 base is not a country');
  const rest = r.newHoldings[0];
  assert.equal(rest.costBaseByCountry[AU_PRE2027_KEY], 60_000, 'the remainder keeps its share of the deferral');
  assert.equal(rest.costBaseByCountry.AU, 90_000);
});

test('DS-2b: the deferred gain\'s 12-month test runs from the ORIGINAL acquisition to the sale', () => {
  // Bought 1 May 2027, sold 1 Jan 2028: eight months, so no discount on the deferred gain.
  const r = sell([stamped({ purchaseDate: new Date(Date.UTC(2027, 4, 1)) })], 80_000, Date.UTC(2028, 0, 1));
  assert.deepEqual(deferredGainFields(r), { auDeferredGain: 20_000, auDeferredDiscountableGain: 0 });
});

test('DS-2c: an unstamped lot reports no deferred fields (every other disposal is unchanged)', () => {
  const r = sell([lot()], 30_000, Date.UTC(2029, 0, 1));
  assert.deepEqual(deferredGainFields(r), {});
  assert.equal('deferredGainByCountry' in r, false);
});

// ── Booking and the return ─────────────────────────────────────────────────────

test('DS-3: the AU share-sale classifier books the deferred gain per person', () => {
  const fn = new AuTaxModule2027().getReducerFns().get('AU_STOCK_WITHDRAWAL_TAX');
  const s = {
    people: { primary: { residency: 'AU' } },
    auCapitalGainsYTD: 0, auRealCapitalGainsYTD: 0, auDiscountableGainsYTD: 0,
    auStockAccount: { ownershipType: 'sole', ownerId: 'primary' },
  };
  const out = fn(s, { type: 'AU_STOCK_WITHDRAWAL_TAX', residency: 'AU', stateKey: 'auStockAccount',
    gain: 40_000, auGain: 20_000, auIndexedGain: 14_000, auDiscountableGain: 20_000,
    auDeferredGain: 20_000, auDeferredDiscountableGain: 20_000 });
  assert.equal(out.auPersonDeferredCapitalGainsYTD.primary, 20_000);
  assert.equal(out.auPersonDeferredDiscountableGainsYTD.primary, 20_000);
  assert.equal(out.auPersonRealCapitalGainsYTD.primary, 14_000, 'the real bucket holds only the post-2027 gain');
});

const ret = (over) => new AuTaxRates2027().computeTax({
  people: { primary: { residency: 'AU' } },
  auOrdinaryIncomeYTD: 0, auNonResidentWithholdingYTD: 0, auSuperTaxYTD: 0, auFrankingCreditYTD: 0,
  ...over,
});

test('DS-4: the deferred gain is halved and kept out of the 30% minimum tax', () => {
  const t = ret({ auCapitalGainsYTD: 20_000, auRealCapitalGainsYTD: 14_000,
                  auDeferredCapitalGainsYTD: 20_000, auDeferredDiscountableGainsYTD: 20_000 });
  close(t.discountedCapitalGains, 14_000 + 10_000, 'real post-2027 gain + 50% of the deferred gain');
  // s119-10(2): 30% of the minimum tax capital gain (14k) less the tax it adds.
  const tax = ti => applyBracketsDetailed(ti, new AuTaxRates2027()._brackets).tax;
  close(t.cgtMinimumTaxTopUp, Math.max(0, 0.30 * 14_000 - (tax(24_000) - tax(10_000))), 'floor on the 14k only');
  // Against the whole-gain rule design 57 Item B applied: 34k real (14k + 20k), all floored.
  const old = ret({ auCapitalGainsYTD: 40_000, auRealCapitalGainsYTD: 34_000 });
  assert.ok(t.netLiability < old.netLiability, `deferred treatment is lighter: ${t.netLiability} vs ${old.netLiability}`);
});

test('DS-5: capital losses reduce the deferred gain first (s102-5(1) Step 1(a))', () => {
  // A 30k post-2027 loss and a 100k deferred gain: the loss comes off the deferred gain,
  // leaving 70k deferred (35k after the discount) and nothing for the minimum tax.
  const t = ret({ auCapitalGainsYTD: -30_000, auRealCapitalGainsYTD: -30_000,
                  auDeferredCapitalGainsYTD: 100_000, auDeferredDiscountableGainsYTD: 100_000 });
  close(t.discountedCapitalGains, 35_000, 'half of 70k');
  close(t.cgtMinimumTaxTopUp, 0, 'no minimum tax capital gain remains');
});

test('DS-5b: a year with no deferred gain is assessed exactly as before', () => {
  const s = { auCapitalGainsYTD: 50_000, auRealCapitalGainsYTD: 45_000, auCapitalLossPool: 5_000 };
  const r = new AuTaxRates2027();
  assert.deepEqual(r._applyCapitalLosses(s), Object.getPrototypeOf(AuTaxRates2027.prototype)._applyCapitalLosses.call(r, s));
});

test('DS-6: a ladder merge of a stamped and an unstamped rung does not hand the unstamped base to the deferral', async () => {
  const { compactLots, LOT_POLICIES } = await import('../../src/finance/holdings/holding-utils.js');
  const rung = (id, over) => ({ id, allocation: ALLOCATION.BOND, rateKey: RATE_KEYS.BOND_US ?? 'BOND',
    marketValue: 50_000, costBasis: 40_000, purchaseDate: new Date(Date.UTC(2020, 0, 1)), ...over });
  const merged = compactLots([
    rung('ladder-a', { costBaseByCountry: { [AU_PRE2027_KEY]: 40_000, AU: 48_000 } }),
    rung('ladder-b', { costBaseByCountry: { AU: 45_000 }, purchaseDate: new Date(Date.UTC(2028, 0, 1)) }),
  ], { asOfMs: Date.UTC(2032, 0, 1), policy: LOT_POLICIES.LADDER });
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].costBaseByCountry, { [AU_PRE2027_KEY]: 85_000, AU: 93_000 },
    'deferred gain stays 48k − 40k = 8k');
});
