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
 * evt-au-cgt-property-indexation.test.mjs
 *
 * Design 57 §6.3, for REAL PROPERTY — the half of the reform property never got.
 *
 * The FY2027 regime is a trade: Division 115's 50% discount goes away and a 30%
 * minimum-tax floor arrives, and cost-base indexation is what pays for both. Brokerage
 * lots, bullion and company equity all took the indexed half; a dwelling booked its RAW
 * gain into `auRealCapitalGainsYTD`, so it paid the penalty and collected none of the
 * relief. Design 57 §10 called that "property indexation deferred to §6.4" — meaning the
 * Phase-4 deemed-reset work would deliver it — and Part 2 Item B then deleted the deemed
 * reset without revisiting property. The comment outlived the plan by two phases.
 *
 * The back-cast branch is the part worth reading twice. Item B taxes the WHOLE gain of an
 * asset held across 1 July 2027, on the stated rationale that indexation "already relieves
 * the inflationary part of the whole holding period". A dwelling the plan already owned at
 * t0 has a real acquisition date but no stamped price level — the accumulator is 1.0 at sim
 * start and knows nothing of the years before it — so without the back-cast that rationale
 * is false for exactly the assets it was written about.
 *
 * Run with: node --test tests/unit/evt-au-cgt-property-indexation.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { auIndexedCostBase, auCpiLevel, auCpiRate, YEAR_MS } from '../../src/finance/holdings/holding-period.js';
import { AuHouseSaleApplyReducer } from '../../src/finance/account-rules/au/au-real-property-classes.js';
import { UsHouseSaleApplyReducer } from '../../src/finance/account-rules/us/us-real-property-classes.js';
import { PropertyPurchaseApplyReducer } from '../../src/finance/account-rules/property-purchase.js';
import { AuTaxModule2027 } from '../../src/finance/tax/au/au-tax-module-2027.js';
import { makeAccount, makeServices } from '../helpers/reducer-fixtures.js';

const ms = (iso) => new Date(iso).getTime();
const getFn = (module, actionType) => module.getReducerFns().get(actionType);

// ─── The shared factor (holding-period.js) ───────────────────────────────────

test('INDEX: a stamped acquisition level indexes by the plain CPI ratio', () => {
  const basis = auIndexedCostBase({
    auBasis: 100_000, acquisitionPriceLevel: 1.0, currentPriceLevel: 1.25,
    auAcquisitionMs: ms('2028-01-01'), saleMs: ms('2033-01-01'), cpiRate: 0.03,
  });
  // The stamped level wins outright — the back-cast rate is not consulted.
  assert.equal(basis, 125_000);
});

test('INDEX: no stamped level back-casts the CPI rate over the holding period', () => {
  const basis = auIndexedCostBase({
    auBasis: 100_000, acquisitionPriceLevel: null, currentPriceLevel: 1.25,
    auAcquisitionMs: ms('2016-07-01'), saleMs: ms('2032-01-15'), cpiRate: 0.03,
  });
  const years = (ms('2032-01-15') - ms('2016-07-01')) / YEAR_MS;
  assert.ok(Math.abs(basis - 100_000 * 1.03 ** years) < 0.01);
  // And it is materially larger than the sim-start-relative answer would be: that is
  // the whole point — the pre-run decade of inflation is real and is being taxed.
  assert.ok(basis > 125_000);
});

test('INDEX: held under 12 months ⇒ no indexation (Div 115 clock)', () => {
  const basis = auIndexedCostBase({
    auBasis: 100_000, acquisitionPriceLevel: 1.0, currentPriceLevel: 1.25,
    auAcquisitionMs: ms('2032-06-01'), saleMs: ms('2033-01-01'), cpiRate: 0.03,
  });
  assert.equal(basis, 100_000);
});

test('INDEX: never ratchets the basis DOWN (s960-275 cannot create a loss)', () => {
  // Deflation, or a level stamped above the current one, must not shrink the basis.
  const basis = auIndexedCostBase({
    auBasis: 100_000, acquisitionPriceLevel: 1.40, currentPriceLevel: 1.10,
    auAcquisitionMs: ms('2028-01-01'), saleMs: ms('2033-01-01'), cpiRate: 0.03,
  });
  assert.equal(basis, 100_000);
});

test('INDEX: nothing to index from — no level, no date — leaves the basis alone', () => {
  assert.equal(auIndexedCostBase({ auBasis: 100_000, currentPriceLevel: 1.25 }), 100_000);
});

test('INDEX: the state readers match InflationAdjustReducer\'s own fallback order', () => {
  assert.equal(auCpiRate({ cpiRates: { AU: 0.031 }, effectiveInflationRates: { AU: 0.02 } }), 0.031);
  assert.equal(auCpiRate({ effectiveInflationRates: { AU: 0.028 }, inflationRates: { AU: 0.02 } }), 0.028);
  assert.equal(auCpiRate({ inflationRates: { AU: 0.025 } }), 0.025);
  assert.equal(auCpiRate({}), 0);
  assert.equal(auCpiLevel({ cpiAccumulator: { AU: 1.4 }, inflationAccumulator: { AU: 1.2 } }), 1.4);
  assert.equal(auCpiLevel({ inflationAccumulator: { AU: 1.2 } }), 1.2);
  assert.equal(auCpiLevel({}), 1);
});

// ─── The AU dwelling ─────────────────────────────────────────────────────────

const auHouseState = (propOverrides = {}) => ({
  people: { primary: { residency: 'AU' } },
  cpiRates: { AU: 0.03 },
  cpiAccumulator: { AU: 1.20 },
  auSavingsAccount: makeAccount({ stateKey: 'auSavingsAccount', currency: 'AUD',
    holdings: [{ id: 'h', marketValue: 1000, costBasis: 1000 }] }),
  auHouse: {
    kind: 'real-property', stateKey: 'auHouse', name: 'AU House', country: 'AU',
    value: 1_200_000, costBasis: 400_000, mortgageBalance: 0,
    acquisitionDate: '2016-07-01', isPrimaryResidence: false,
    accumulatedDepreciation: 0, capitalizedImprovements: 0,
    ...propOverrides,
  },
});

const sellAuHouse = (state, salePrice = 1_000_000) =>
  new AuHouseSaleApplyReducer(makeServices()).reduce(state, {
    type: 'AU_HOUSE_SALE_APPLY', salePrice, costBasis: 400_000, mortgageBalance: 0,
    residency: 'AU', ownershipType: 'sole', ownerId: 'primary',
    stateKey: 'auHouse', destinationKey: 'auSavingsAccount',
  }, new Date('2032-01-15'));

const taxAction = (next) => next.next.find(a => a.type === 'AU_HOUSE_SALE_TAX');

test('AU HOUSE: the disposal carries an indexed gain strictly below the raw gain', () => {
  const tax = taxAction(sellAuHouse(auHouseState()));
  assert.equal(tax.gain, 600_000);
  // Back-cast from 2016-07-01 to 2032-01-15 at 3%: basis 400,000 → ~634,300.
  const years = (ms('2032-01-15') - ms('2016-07-01')) / YEAR_MS;
  const expected = +(1_000_000 - 400_000 * 1.03 ** years).toFixed(2);
  assert.ok(Math.abs(tax.auIndexedGain - expected) < 0.02,
    `auIndexedGain ${tax.auIndexedGain} vs expected ${expected}`);
  assert.ok(tax.auIndexedGain < tax.gain);
});

test('AU HOUSE: an authored acquisitionPriceLevel overrides the back-cast', () => {
  const tax = taxAction(sellAuHouse(auHouseState({ acquisitionPriceLevel: 0.80 })));
  // level 1.20 / 0.80 = 1.5 ⇒ basis 600,000 ⇒ gain 400,000.
  assert.equal(tax.auIndexedGain, 400_000);
});

test('AU HOUSE: the indexed gain is the ASSESSABLE one — s118-185 applies to it too', () => {
  // Occupied as the main residence for part of the ownership period: the exemption
  // fraction must ride the indexed figure, or the reform re-opens the phantom
  // assessable-income defect the un-indexed path already had to fix.
  const state = auHouseState({ mainResidenceFrom: '2028-01-01', mainResidenceUntil: '2030-01-01' });
  const tax = taxAction(sellAuHouse(state));
  assert.ok(tax.auTaxableFraction < 1, 'fixture must actually earn a partial exemption');
  const unfractioned = tax.auIndexedGain / tax.auTaxableFraction;
  assert.ok(unfractioned > tax.auIndexedGain);
  // And it stays below the nominal assessable gain, which is the relief itself.
  assert.ok(tax.auIndexedGain < tax.gain * tax.auTaxableFraction);
});

test('AU HOUSE: a dwelling sold at a loss is not indexed into a bigger loss', () => {
  // Rental history ⇒ the loss is deductible, so `gain` can go negative through the
  // term fields. Indexation must leave it exactly where it is.
  const state = auHouseState({ accumulatedDepreciation: 1 });
  const tax = taxAction(sellAuHouse(state, 300_000));
  assert.ok(tax.auShortTermGain + tax.auLongTermGain < 0, 'fixture must realize a loss');
  assert.equal(tax.auIndexedGain, +((tax.auShortTermGain + tax.auLongTermGain) * tax.auTaxableFraction).toFixed(2));
});

test('AU HOUSE: FY2027 classification books the INDEXED gain in the real bucket', () => {
  const tax = taxAction(sellAuHouse(auHouseState()));
  const fn  = getFn(new AuTaxModule2027(), 'AU_HOUSE_SALE_TAX');
  const s1  = fn({
    people: { primary: { residency: 'AU' } },
    auRealCapitalGainsYTD: 0, auPersonRealCapitalGainsYTD: {},
    auCapitalGainsYTD: 0, auPersonCapitalGainsYTD: {},
    auDiscountableGainsYTD: 0, auPersonDiscountableGainsYTD: {},
  }, tax);
  // Gross bucket keeps the nominal assessable gain; the real bucket takes the indexed one.
  assert.equal(s1.auPersonRealCapitalGainsYTD.primary, tax.auIndexedGain);
  assert.ok(s1.auPersonRealCapitalGainsYTD.primary < s1.auPersonCapitalGainsYTD.primary,
    'the reform must grant property some indexation relief');
});

// ─── The foreign (US) dwelling an AU resident owns ───────────────────────────

test('US HOUSE: the AU-assessable gain indexes from the level stamped at the move', () => {
  const state = {
    people: { primary: { residency: 'AU' } },
    cpiRates: { AU: 0.03 }, cpiAccumulator: { AU: 1.32 },
    auSavingsAccount: makeAccount({ stateKey: 'auSavingsAccount', currency: 'USD',
      holdings: [{ id: 'h', marketValue: 1000, costBasis: 1000 }] }),
    usHouse: {
      kind: 'real-property', stateKey: 'usHouse', country: 'US',
      value: 900_000, costBasis: 300_000, mortgageBalance: 0,
      acquisitionDate: '2015-01-01', isPrimaryResidence: false,
      accumulatedDepreciation: 0, capitalizedImprovements: 0,
      // s855-45: stepped up at the 2028 move, level stamped at 1.10.
      costBaseByCountry: { AU: 600_000 },
      acquisitionDateByCountry: { AU: ms('2028-01-01') },
      acquisitionPriceLevel: 1.10,
    },
  };
  const next = new UsHouseSaleApplyReducer(makeServices()).reduce(state, {
    type: 'US_HOUSE_SALE_APPLY', salePrice: 900_000, costBasis: 300_000, mortgageBalance: 0,
    residency: 'AU', stateKey: 'usHouse', destinationKey: 'auSavingsAccount',
  }, new Date('2033-01-01'));
  const tax = next.next.find(a => a.type === 'US_HOUSE_SALE_TAX');
  assert.equal(tax.auGain, 300_000);                       // 900k − 600k step-up
  assert.equal(tax.auIndexedGain, 180_000);                // 900k − 600k × (1.32/1.10)

  // And the FY2027 classifier books the indexed figure, converted to AUD.
  const fn = getFn(new AuTaxModule2027(), 'US_HOUSE_SALE_TAX');
  const s1 = fn({
    people: { primary: { residency: 'AU' } },
    effectiveExchangeRates: { USD_AUD: 1.5 },   // 1 USD = 1.5 AUD
    auRealCapitalGainsYTD: 0, auPersonRealCapitalGainsYTD: {},
    usSourceRealCapGainsAudYTD: 0, usSourcePersonRealCapGainsAudYTD: {},
  }, tax);
  assert.equal(s1.auRealCapitalGainsYTD, 270_000);         // 180k USD × 1.5
});

// ─── Buying a dwelling mid-run stamps the level exactly ──────────────────────

test('PURCHASE: an in-sim purchase stamps acquisitionPriceLevel from the CPI series', () => {
  const state = {
    cpiAccumulator: { AU: 1.18 }, inflationAccumulator: { AU: 1.25 },
    auSavingsAccount: makeAccount({ stateKey: 'auSavingsAccount', currency: 'AUD',
      holdings: [{ id: 'h', marketValue: 900_000, costBasis: 900_000 }] }),
    newHouse: { kind: 'real-property', stateKey: 'newHouse', country: 'AU', value: 0, costBasis: 0 },
  };
  const next = new PropertyPurchaseApplyReducer(makeServices()).reduce(state, {
    type: 'PROPERTY_PURCHASE_APPLY', stateKey: 'newHouse', cashKey: 'auSavingsAccount',
    price: 800_000, cashDue: 800_000,
  }, new Date('2035-03-01'));
  // The dedicated ATO series, not the household inflation accumulator — both the stamp
  // and the disposal must read the same one or the ratio means nothing.
  assert.equal(next.newHouse.acquisitionPriceLevel, 1.18);
  assert.equal(next.newHouse.acquisitionDate, ms('2035-03-01'));
});
