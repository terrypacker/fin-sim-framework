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
 * evt-foreign-property-cgt.test.mjs
 *
 * Design 62 §5 (Gap 3) — an AU resident is taxable on worldwide capital gains, so the
 * foreign (US) house is AU-assessable from the s855-45 stepped-up basis, net of the AU
 * main-residence exemption (6-year absence rule). The AU house (TAP) is NOT stepped up.
 *
 *   - EVT-62: RealPropertyService.recordResidencyChange steps up FOREIGN property only.
 *   - EVT-62: auMainResidenceExemptFraction models the s118-145 absence rule.
 *   - EVT-62: US module classifies US_HOUSE_SALE_TAX as an AU gain for a resident (FITO
 *     removal set populated), and leaves a non-resident US-only.
 *   - EVT-62: AU FY2027 module routes the US house gain into the real bucket (un-indexed).
 *   - EVT-62: RealProperty round-trips costBaseByCountry / acquisitionDateByCountry.
 *
 * Run with: node --test tests/unit/evt-foreign-property-cgt.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { auMainResidenceExemptFraction } from '../../src/finance/account-rules/us/us-real-property-classes.js';
import { RealPropertyService } from '../../src/finance/services/real-property-service.js';
import { RealProperty }        from '../../src/finance/assets/real-property.js';
import { UsTaxModule2026 }     from '../../src/finance/tax/us/us-tax-module-2026.js';
import { AuTaxModule2027 }     from '../../src/finance/tax/au/au-tax-module-2027.js';
import { ScenarioSerializer }  from '../../src/scenarios/scenario-serializer.js';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const MOVE_MS = Date.UTC(2024, 6, 1);
const getFn   = (module, actionType) => module.getReducerFns().get(actionType);

// ── Step-up: foreign only ──────────────────────────────────────────────────────
test('EVT-62: recordResidencyChange steps up FOREIGN property, not domestic (TAP)', () => {
  const svc = Object.create(RealPropertyService.prototype);
  const usHouse = { country: 'US', value: 800_000, balanceAtResidencyChange: null };
  const auHouse = { country: 'AU', value: 600_000, balanceAtResidencyChange: null };
  svc.recordResidencyChange(usHouse, { country: 'AU', stepUp: true, priceLevel: 1.2, asOfMs: MOVE_MS });
  svc.recordResidencyChange(auHouse, { country: 'AU', stepUp: true, priceLevel: 1.2, asOfMs: MOVE_MS });

  assert.equal(usHouse.costBaseByCountry.AU, 800_000, 'US (foreign) house stepped up to market value');
  assert.equal(usHouse.acquisitionDateByCountry.AU, MOVE_MS, 'deemed-acquisition date stamped');
  assert.equal(usHouse.acquisitionPriceLevel, 1.2);
  assert.ok(auHouse.costBaseByCountry == null, 'AU (TAP) house NOT stepped up');
  assert.equal(auHouse.balanceAtResidencyChange, 600_000, 'AU house value still snapshotted');
});

// ── Main-residence exemption (s118-145 absence rule) ───────────────────────────
test('EVT-62: main-residence exemption fraction models the absence rule', () => {
  const sale = MOVE_MS + 3 * YEAR_MS;
  // Investment property (not a main residence) ⇒ fully assessable.
  assert.equal(auMainResidenceExemptFraction({ isPrimaryResidence: false }, MOVE_MS, sale), 0);
  // Main residence, not income-producing ⇒ indefinite exemption.
  assert.equal(auMainResidenceExemptFraction({ isPrimaryResidence: true }, MOVE_MS, sale), 1);
  // Main residence, income-producing, sold within 6y ⇒ fully exempt.
  const rented = { isPrimaryResidence: true, rentalEnabled: true, monthlyRent: 2_000 };
  assert.equal(auMainResidenceExemptFraction(rented, MOVE_MS, MOVE_MS + 4 * YEAR_MS), 1);
  // Main residence, income-producing, sold at 12y ⇒ 6/12 exempt.
  assert.equal(auMainResidenceExemptFraction(rented, MOVE_MS, MOVE_MS + 12 * YEAR_MS), 0.5);
  // No deemed-acquisition date ⇒ treat as fully main residence.
  assert.equal(auMainResidenceExemptFraction({ isPrimaryResidence: true }, null, sale), 1);
});

// ── Classification: US module AU-assesses the resident's foreign house ──────────
test('EVT-62: US_HOUSE_SALE_TAX is AU-assessed for a resident (FITO set populated)', () => {
  const fn = getFn(new UsTaxModule2026(), 'US_HOUSE_SALE_TAX');
  const base = { usCapitalGainsYTD: 0, auCapitalGainsYTD: 0, auDiscountableGainsYTD: 0, usSourceCapGainsAudYTD: 0, usSourceCapGainsUsdYTD: 0 };
  // no FX rates ⇒ toAUD is 1:1, so AUD == USD amounts here.
  const resident = fn({ ...base }, { gain: 100_000, auGain: 250_000, auDiscountableGain: 250_000, residency: 'AU' });
  assert.equal(resident.usCapitalGainsYTD, 100_000, 'US gain always recorded (post-$500k exemption)');
  assert.equal(resident.auCapitalGainsYTD, 250_000, 'AU gain from the stepped-up basis');
  assert.equal(resident.auDiscountableGainsYTD, 250_000, 'discount-eligible (held ≥12mo)');
  assert.equal(resident.usSourceCapGainsAudYTD, 250_000, 'US-source ⇒ FITO removal set populated');

  const nonResident = fn({ ...base }, { gain: 100_000, auGain: 0, residency: 'US' });
  assert.equal(nonResident.auCapitalGainsYTD, 0, 'non-resident: US-only, no AU gain');
});

// ── FY2027: US house gain routes into the real (indexed) bucket, un-indexed ─────
test('EVT-62: AU FY2027 routes the US house gain into the real bucket', () => {
  const fn = getFn(new AuTaxModule2027(), 'US_HOUSE_SALE_TAX');
  assert.ok(fn, 'FY2027 module handles US_HOUSE_SALE_TAX');
  const out = fn({ auRealCapitalGainsYTD: 0, usSourceRealCapGainsAudYTD: 0 }, { auGain: 250_000, residency: 'AU' });
  assert.equal(out.auRealCapitalGainsYTD, 250_000, 'real bucket = un-indexed auGain (property indexation deferred)');
  assert.equal(out.usSourceRealCapGainsAudYTD, 250_000, 'US-source real gain tracked for the FITO limit');
  // Non-resident ⇒ untouched.
  const nr = fn({ auRealCapitalGainsYTD: 0 }, { auGain: 250_000, residency: 'US' });
  assert.equal(nr.auRealCapitalGainsYTD, 0);
});

// ── Serialization ──────────────────────────────────────────────────────────────
test('EVT-62: RealProperty round-trips the cross-border CGT fields', () => {
  const p = new RealProperty(800_000, {
    country: 'US', isPrimaryResidence: true,
    costBaseByCountry: { AU: 800_000 }, acquisitionPriceLevel: 1.2, acquisitionDateByCountry: { AU: MOVE_MS },
  });
  const back = ScenarioSerializer._makeRealProperty(ScenarioSerializer._serializeRealProperty(p));
  assert.deepEqual(back.costBaseByCountry, { AU: 800_000 });
  assert.deepEqual(back.acquisitionDateByCountry, { AU: MOVE_MS });
  assert.equal(back.acquisitionPriceLevel, 1.2);
});
