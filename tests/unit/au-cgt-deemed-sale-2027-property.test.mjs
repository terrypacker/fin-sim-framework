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
 * au-cgt-deemed-sale-2027-property.test.mjs — design 132 §7 (phase 2b, real property).
 *
 *   - The 1 July 2027 advance writes a record of the deemed sale on each dwelling held
 *     across the date, and whether s112-155(1)(d) let it apply.
 *   - At the sale, the deferred gain takes the taxable fraction of the pre-2027 days and
 *     the post-2027 gain that of the later days (s112-155(2) Note 1, Subdiv 118-B).
 *   - Depreciation and improvements split at the date.
 *   - An excluded dwelling's pre-2027 base is not indexed (s960-275(1B)); Case A owners
 *     get the s115-115 discount after 2027 (s115-100(c), s114-25, s115-20).
 *
 * Run with: node --test tests/unit/au-cgt-deemed-sale-2027-property.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AuCgtDeemedSale2027Reducer, AU_DEEMED_SALE_MS } from '../../src/finance/tax/au/au-cgt-deemed-sale-2027.js';
import { auDwellingTaxableFractions, usDwellingAuTaxableFractions, deemedSaleHolds }
  from '../../src/finance/tax/au/au-cgt-2027-property.js';
import { AuHouseSaleApplyReducer } from '../../src/finance/account-rules/au/au-real-property-classes.js';
import { UsHouseSaleApplyReducer } from '../../src/finance/account-rules/us/us-real-property-classes.js';
import { AuTaxModule2027 } from '../../src/finance/tax/au/au-tax-module-2027.js';
import { AuTaxRates2027 } from '../../src/finance/tax/au/au-tax-rates-2027.js';
import { cgtDiscountFraction } from '../../src/finance/account-rules/main-residence.js';
import { makeAccount, makeServices } from '../helpers/reducer-fixtures.js';

const ms = (iso) => Date.parse(iso);
const DAY = 86_400_000;
const close = (a, b, msg) => assert.ok(Math.abs((a ?? 0) - b) < 0.02, `${msg}: got ${a}, want ${b}`);
const STAMP = new AuCgtDeemedSale2027Reducer();
const advance = { type: 'AU_PERIOD_ADVANCE', period: { startMs: AU_DEEMED_SALE_MS } };

const house = (over = {}) => ({
  kind: 'real-property', stateKey: 'auHouse', name: 'AU House', country: 'AU',
  value: 900_000, costBasis: 400_000, mortgageBalance: 0,
  acquisitionDate: '2017-07-01', isPrimaryResidence: false,
  ownershipType: 'sole', ownerId: 'p1',
  accumulatedDepreciation: 0, capitalizedImprovements: 0, ...over,
});

const world = (prop, person = {}) => ({
  people: { primary: { id: 'p1', residency: 'AU', ...person } },
  cpiRates: { AU: 0.03 },
  cpiAccumulator: { AU: 1.2 },
  auSavingsAccount: makeAccount({ stateKey: 'auSavingsAccount', currency: 'AUD',
    holdings: [{ id: 'h', marketValue: 1000, costBasis: 1000 }] }),
  auHouse: prop,
});

const stamp = (state) => STAMP.reduce(state, advance);

const sellAu = (state, { salePrice = 1_100_000, costBasis = 400_000, date = '2032-07-01' } = {}) =>
  new AuHouseSaleApplyReducer(makeServices()).reduce({ ...state, cpiAccumulator: { AU: 1.38 } }, {
    type: 'AU_HOUSE_SALE_APPLY', salePrice, costBasis, mortgageBalance: 0,
    residency: 'AU', ownershipType: 'sole', ownerId: 'p1',
    stateKey: 'auHouse', destinationKey: 'auSavingsAccount',
  }, new Date(date)).next.find(a => a.type === 'AU_HOUSE_SALE_TAX');

// ── The stamp ─────────────────────────────────────────────────────────────────

test('DS-P1: the stamp records the deemed sale on an AU resident\'s dwelling', () => {
  const rec = stamp(world(house())).auHouse.auDeemedSale2027;
  assert.deepEqual(rec, { applied: true, value: 900_000, priceLevel: 1.2,
                          accumulatedDepreciation: 0, capitalizedImprovements: 0 });
});

test('DS-P1b: s112-155(1)(d) — foreign after 8 May 2012 while holding ⇒ not deemed sold', () => {
  // Resident since 2020, dwelling bought 2017: foreign for part of the holding (s115-105).
  assert.equal(stamp(world(house(), { residencySinceMs: ms('2020-01-01') })).auHouse.auDeemedSale2027.reason,
    's115-105-applies');
  // Resident since before both the purchase and 8 May 2012: passes.
  assert.equal(stamp(world(house(), { residencySinceMs: ms('2010-01-01') })).auHouse.auDeemedSale2027.applied, true);
  // Resident since the purchase: passes.
  assert.equal(stamp(world(house(), { residencySinceMs: ms('2017-07-01') })).auHouse.auDeemedSale2027.applied, true);
  // A US resident at the date.
  assert.equal(stamp(world(house(), { residency: 'US' })).auHouse.auDeemedSale2027.reason, 'not-au-resident');
});

test('DS-P1c: no record for a dwelling bought after the date, one with no value, or a US one never stepped up', () => {
  assert.equal(stamp(world(house({ acquisitionDate: '2027-07-01' }))).auHouse.auDeemedSale2027, undefined);
  assert.equal(stamp(world(house({ value: 0 }))).auHouse.auDeemedSale2027, undefined);
  assert.equal(stamp(world(house({ country: 'US' }))).auHouse.auDeemedSale2027, undefined);
});

test('DS-P1d: the sale re-tests (d) — residency restarted after 2027 undoes the deemed sale', () => {
  const s = stamp(world(house()));
  assert.ok(deemedSaleHolds(s, s.auHouse));
  const broken = { ...s, people: { primary: { ...s.people.primary, residencySinceMs: ms('2030-01-01') } } };
  assert.equal(deemedSaleHolds(broken, broken.auHouse), null);
  const left = { ...s, people: { primary: { ...s.people.primary, residency: 'US' } } };
  assert.equal(deemedSaleHolds(left, left.auHouse), null);
});

// ── The main-residence split ─────────────────────────────────────────────────

test('DS-P2: the exempt days are counted into the window they fall in', () => {
  // Occupied 2017–2022, rented after. 1826 of the 3652 pre-2027 days are exempt.
  const prop = house({ isPrimaryResidence: true, mainResidenceUntil: '2022-07-01' });
  const f = auDwellingTaxableFractions(prop, { acquisitionMs: ms('2017-07-01'), saleMs: ms('2032-07-01') });
  close(f.pre, 0.5, 'pre-2027');
  close(f.post, 1, 'post-2027: never occupied');
  assert.deepEqual(auDwellingTaxableFractions(house({ isPrimaryResidence: true }),
    { acquisitionMs: ms('2017-07-01'), saleMs: ms('2032-07-01') }), { pre: 0, post: 0 }, 'throughout');
});

test('DS-P2b: the US dwelling\'s six rented years are not granted again at the reacquisition', () => {
  const prop = { isPrimaryResidence: true, rentalEnabled: true, monthlyRent: 2000 };
  const acq = ms('2020-01-01'), sale = ms('2032-07-01');
  const f = usDwellingAuTaxableFractions(prop, { acquisitionMs: acq, saleMs: sale });
  const exemptEnd = acq + 6 * 365 * DAY;
  close(f.pre, (AU_DEEMED_SALE_MS - exemptEnd) / (AU_DEEMED_SALE_MS - acq), 'pre');
  assert.equal(f.post, 1, 'the six years ran out before the date');
});

// ── The sale ─────────────────────────────────────────────────────────────────

test('DS-P3: a stamped dwelling splits into a deferred gain and an indexed post-2027 gain', () => {
  const prop = house({ isPrimaryResidence: true, mainResidenceUntil: '2022-07-01' });
  const tax = sellAu(stamp(world(prop)));
  assert.equal(tax.auDeemedSaleReason, 'applied');
  close(tax.auDeferredGain, 250_000, '(900k − 400k) × half the pre-2027 days');
  close(tax.auDeferredDiscountableGain, 250_000, 'held 12 months from 2017');
  assert.equal(tax.auTaxableFraction, 1, 'the post-2027 days were all rented');
  close(tax.auIndexedGain, 1_100_000 - 900_000 * (1.38 / 1.2), 'from the 2027 value, indexed from 2027');
  close(tax.auShortTermGain + tax.auLongTermGain, 200_000, 'nominal post-2027 gain');
  assert.equal(tax.gain, 700_000, 'the US gain is unchanged');
});

test('DS-P3b: depreciation and improvements split at the date', () => {
  const s = stamp(world(house({ accumulatedDepreciation: 20_000 })));
  s.auHouse = { ...s.auHouse, accumulatedDepreciation: 30_000, capitalizedImprovements: 50_000 };
  // The handler passes costBasis = authored 400k + improvements 50k.
  const tax = sellAu(s, { costBasis: 450_000 });
  close(tax.auDeferredGain, 900_000 - (450_000 - 50_000 - 20_000), 'pre base is net of the pre-2027 depreciation only');
  close(tax.auShortTermGain + tax.auLongTermGain, 1_100_000 - (900_000 + 50_000 - 10_000), 'post base: later changes only');
});

test('DS-P4: an excluded dwelling is not indexed for its pre-2027 cost (s960-275(1B))', () => {
  const s = stamp(world(house(), { residencySinceMs: ms('2020-01-01') }));
  const tax = sellAu(s);
  assert.equal(tax.auDeemedSaleReason, 's115-105-applies');
  assert.equal(tax.auDeferredGain, undefined);
  close(tax.auIndexedGain, 700_000, 'nominal gain: no back-cast from 2017');
});

test('DS-P4b: a dwelling never examined (scenario starts after the date) keeps the back-cast', () => {
  const tax = sellAu(world(house()));
  assert.equal(tax.auDeemedSaleReason, undefined);
  assert.ok(tax.auIndexedGain < 700_000);
});

test('DS-P5: the US dwelling\'s step-up base yields the deferred gain', () => {
  const us = {
    kind: 'real-property', stateKey: 'usHouse', country: 'US', value: 600_000, costBasis: 200_000,
    mortgageBalance: 0, acquisitionDate: '2015-01-01', isPrimaryResidence: false,
    ownershipType: 'sole', ownerId: 'p1', accumulatedDepreciation: 0, capitalizedImprovements: 0,
    costBaseByCountry: { AU: 300_000 }, acquisitionDateByCountry: { AU: ms('2020-01-01') },
    acquisitionPriceLevel: 1.0,
  };
  const s = stamp({ ...world(house()), usHouse: us, people: { primary: { id: 'p1', residency: 'AU', residencySinceMs: ms('2020-01-01') } } });
  assert.equal(s.usHouse.auDeemedSale2027.applied, true);
  const tax = new UsHouseSaleApplyReducer(makeServices()).reduce({ ...s, cpiAccumulator: { AU: 1.38 } }, {
    type: 'US_HOUSE_SALE_APPLY', salePrice: 800_000, costBasis: 200_000, mortgageBalance: 0,
    residency: 'AU', stateKey: 'usHouse', destinationKey: 'auSavingsAccount',
  }, new Date('2032-07-01')).next.find(a => a.type === 'US_HOUSE_SALE_TAX');
  close(tax.auDeferredGain, 300_000, '600k value − 300k step-up');
  close(tax.auGain, 200_000, 'post-2027 from the 2027 value');
  close(tax.auIndexedGain, 800_000 - 600_000 * (1.38 / 1.2), 'indexed from the 2027 level');
});

// ── Case A: the s115-115 discount after 2027 ─────────────────────────────────

const houseTax = (over = {}) => ({
  type: 'AU_HOUSE_SALE_TAX', residency: 'AU', ownershipType: 'sole', ownerId: 'p1',
  gain: 700_000, auShortTermGain: 0, auLongTermGain: 700_000, auIndexedGain: 700_000,
  auTaxableFraction: 1, acquisitionMs: ms('2017-07-01'), saleMs: ms('2032-07-01'),
  auDeemedSaleReason: 'not-au-resident', ...over,
});

test('DS-P6: Case A — an owner foreign after 1 July 2027 gets the s115-115 percentage', () => {
  const fn = new AuTaxModule2027().getReducerFns().get('AU_HOUSE_SALE_TAX');
  const s = { people: { primary: { id: 'p1', residency: 'AU', residencySinceMs: ms('2030-01-01') } },
              auCapitalGainsYTD: 0, usCapitalGainsYTD: 0, usOrdinaryIncomeYTD: 0 };
  const out = fn(s, houseTax());
  const pct = cgtDiscountFraction({ acquisitionMs: ms('2017-07-01'), saleMs: ms('2032-07-01'),
    residencySinceMs: ms('2030-01-01'), residencyAtSale: 'AU' }).fraction;
  close(out.auPersonPost2027DiscountBaseYTD.primary, 700_000, 'base');
  close(out.auPersonPost2027DiscountAllowanceYTD.primary, 700_000 * pct, 'allowance');
  assert.ok(pct > 0 && pct < 0.5);
});

test('DS-P6b: Case B (foreign period ended before 2027), the deemed sale, and pre-2027 sales book nothing', () => {
  const fn = new AuTaxModule2027().getReducerFns().get('AU_HOUSE_SALE_TAX');
  const s = (since) => ({ people: { primary: { id: 'p1', residency: 'AU', residencySinceMs: since } },
                          auCapitalGainsYTD: 0, usCapitalGainsYTD: 0, usOrdinaryIncomeYTD: 0 });
  assert.equal(fn(s(ms('2020-01-01')), houseTax({ auDeemedSaleReason: 's115-105-applies' })).auPersonPost2027DiscountBaseYTD, undefined);
  assert.equal(fn(s(ms('2030-01-01')), houseTax({ auDeemedSaleReason: 'applied' })).auPersonPost2027DiscountBaseYTD, undefined);
  assert.equal(fn(s(ms('2030-01-01')), houseTax({ auDeemedSaleReason: undefined })).auPersonPost2027DiscountBaseYTD, undefined);
});

const ret = (over) => new AuTaxRates2027().computeTax({
  people: { primary: { residency: 'AU' } },
  auOrdinaryIncomeYTD: 0, auNonResidentWithholdingYTD: 0, auSuperTaxYTD: 0, auFrankingCreditYTD: 0,
  ...over,
});

test('DS-P7: the allowance comes off the real gain and the minimum-tax base', () => {
  const t = ret({ auCapitalGainsYTD: 100_000, auRealCapitalGainsYTD: 100_000,
                  auPost2027DiscountBaseYTD: 100_000, auPost2027DiscountAllowanceYTD: 10_000 });
  close(t.discountedCapitalGains, 90_000, 'gain less the s115-115 allowance');
});

test('DS-P7b: losses reach the Case A base last, and the allowance scales with what is left', () => {
  const r = new AuTaxRates2027();
  const out = r._applyCapitalLosses({ auCapitalGainsYTD: 120_000, auRealCapitalGainsYTD: 120_000,
    auPost2027DiscountBaseYTD: 100_000, auPost2027DiscountAllowanceYTD: 10_000, auCapitalLossPool: 80_000 });
  close(out.total, 40_000, 'post-2027 gain after the prior-year pool');
  close(out.post2027DiscountBase, 40_000, 'the 20k other gain went first');
  close(out.post2027DiscountAllowance, 4_000, 'scaled 0.4');
  assert.equal(out.deferred, undefined, 'no deferred keys without a deferred gain');
});
