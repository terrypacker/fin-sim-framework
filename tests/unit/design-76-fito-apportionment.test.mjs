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
 * design-76-fito-apportionment.test.mjs
 *
 * Design 76 Phase 4 (Gap D, remainder): `usTaxPaidOnUsSourceAud` is the one FITO
 * input that cannot be *attributed*. US tax is assessed MFJ and stamped once per US
 * settle, so there is no per-person value to migrate to — it must be APPORTIONED,
 * by each person's share of the US-source income Australia is taxing a second time.
 *
 * Also covers the latent defect P4 exposed in `_auTaxOnUsSourceIncome`: the A$1,000
 * de-minimis test is per-person, but the fallback that handles it used to be
 * all-or-nothing across the household, so a MIXED household (one spouse over the
 * threshold, one under) contributed zero for the under-threshold spouse and declared
 * their whole liability AU-source — hence creditable against US tax.
 *
 * Run with: node --test tests/unit/design-76-fito-apportionment.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TaxSettleService } from '../../src/finance/tax-settle-service.js';

const FY = { startMs: Date.UTC(2026, 6, 1), endMs: Date.UTC(2027, 5, 30) };

/**
 * Two AU residents whose US-source income is deliberately lopsided (90/10), so an
 * even split and an income-share apportionment give visibly different answers.
 */
function makeState({ usTaxPaidOnUsSourceAud = 20000, primaryUsSource = 180000, spouseUsSource = 20000 } = {}) {
  return {
    people: {
      primary: { id: 'primary', name: 'Terry',  residency: 'AU' },
      spouse:  { id: 'spouse',  name: 'Jeanne', residency: 'AU' },
    },
    currentPeriods: { AU: FY, US: FY },
    // All assessable income is US-source here, so the shares are unambiguous.
    auPersonOrdinaryIncomeYTD:      { primary: primaryUsSource, spouse: spouseUsSource },
    auPersonUsSourceOrdinaryAudYTD: { primary: primaryUsSource, spouse: spouseUsSource },
    auPersonCapitalGainsYTD: {}, auPersonDiscountableGainsYTD: {},
    auPersonUsSourceCapGainsAudYTD: {}, auPersonUsSourceRealCapGainsAudYTD: {},
    auPersonRealCapitalGainsYTD: {}, auPersonFrankingCreditYTD: {},
    auPersonNonResidentWithholdingYTD: {}, auPersonNrWithholdingInterestYTD: {},
    auPersonNrWithholdingUnfrankedDividendYTD: {}, auPersonSuperTaxYTD: {},
    auOrdinaryIncomeYTD: 0, auCapitalGainsYTD: 0, auDiscountableGainsYTD: 0,
    usSourceOrdinaryAudYTD: 0, usSourceCapGainsAudYTD: 0, usSourceRealCapGainsAudYTD: 0,
    usTaxPaidOnUsSourceAud,
    inflationAccumulator: { AU: 1.0, US: 1.0 },
    baseExchangeRates: { USD_AUD: 1, AUD_USD: 1 },
    effectiveExchangeRates: { USD_AUD: 1, AUD_USD: 1 },
  };
}

const byKey = details => Object.fromEntries(details.map(d => [d.personKey, d.taxDetail]));

describe('design 76 P4 — the FITO cap is apportioned by US-source income share', () => {
  test('the person bearing 90% of the US-source income gets ~90% of the offset', () => {
    const svc = new TaxSettleService();
    const details = byKey(svc.computeAuTaxPerPerson(makeState()));

    // Each person's offset is capped at their own limit, so compare the INPUT that
    // P4 changed — foreignIncomeTaxOffset is the apportioned usTaxPaidOnUsSourceAud.
    const p = details.primary.inputs.foreignIncomeTaxOffset;
    const s = details.spouse.inputs.foreignIncomeTaxOffset;
    assert.ok(Math.abs(p - 18000) < 1, `primary should receive ~90% of 20000, got ${p}`);
    assert.ok(Math.abs(s -  2000) < 1, `spouse should receive ~10% of 20000, got ${s}`);
    // Apportionment must conserve the household total — no offset created or lost.
    assert.ok(Math.abs((p + s) - 20000) < 1, 'apportioned offsets must sum to the household total');
  });

  test('equal US-source income degrades to the old even split', () => {
    const svc = new TaxSettleService();
    const details = byKey(svc.computeAuTaxPerPerson(
      makeState({ primaryUsSource: 100000, spouseUsSource: 100000 })));
    assert.ok(Math.abs(details.primary.inputs.foreignIncomeTaxOffset - 10000) < 1);
    assert.ok(Math.abs(details.spouse.inputs.foreignIncomeTaxOffset  - 10000) < 1);
  });

  test('no US-source income anywhere falls back to an even split, not a divide-by-zero', () => {
    const svc = new TaxSettleService();
    const state = makeState({ primaryUsSource: 0, spouseUsSource: 0 });
    // Give them AU-source income so there is still a return to file.
    state.auPersonOrdinaryIncomeYTD = { primary: 90000, spouse: 60000 };
    const details = byKey(svc.computeAuTaxPerPerson(state));
    for (const key of ['primary', 'spouse']) {
      const v = details[key].inputs.foreignIncomeTaxOffset;
      assert.ok(Number.isFinite(v), `${key} offset must be finite, got ${v}`);
      assert.ok(Math.abs(v - 10000) < 1, `${key} should fall back to the even split, got ${v}`);
    }
  });

  test('each return exposes its own US-source slice', () => {
    // These feed the per-person de-minimis apportionment below; without them a
    // mixed household silently contributes zero for the under-threshold spouse.
    const svc = new TaxSettleService();
    const details = byKey(svc.computeAuTaxPerPerson(makeState()));
    assert.strictEqual(details.primary.inputs.usSourceOrdinary, 180000);
    assert.strictEqual(details.spouse.inputs.usSourceOrdinary,   20000);
  });
});

describe('design 76 P4 — a mixed de-minimis household', () => {
  test('one spouse under the A$1,000 shortcut still reports AU tax on US-source income', () => {
    // The exact shape FTC-US-9 caught: apportionment puts primary well over the
    // A$1,000 threshold (so they get a computed fitoLimit) and spouse well under
    // (so theirs is null). The under-threshold spouse must NOT contribute zero.
    const svc = new TaxSettleService();
    // A$10,000 split 400k/40k ⇒ primary 9,091 (over the threshold, real limit) and
    // spouse 909 (under it, limit null). The spouse still has 40k of income, so they
    // owe real AU tax — a fixture where they owed nothing could not show the leak.
    const state = makeState({ usTaxPaidOnUsSourceAud: 10000, primaryUsSource: 400000, spouseUsSource: 40000 });
    const byName = byKey(svc.computeAuTaxPerPerson(state));

    assert.ok(byName.primary.fitoLimit != null,
      'primary should be over the A$1,000 threshold and compute a real limit');
    assert.ok(byName.spouse.fitoLimit == null,
      'spouse should fall under the A$1,000 shortcut — this is the MIXED case');

    // The enabling data for the per-person fallback. Without a US-source slice on
    // the under-threshold spouse's return, `_auTaxOnUsSourceIncome` has nothing to
    // apportion by and contributes 0 for them — declaring their whole liability
    // AU-source and creditable. FTC-US-9 covers the end-to-end consequence; this
    // asserts the inputs that make the fix possible are actually present.
    assert.ok(byName.spouse.inputs.usSourceOrdinary > 0,
      'the under-threshold spouse must still expose their US-source slice');
    assert.ok(byName.spouse.netLiability > 0,
      'fixture must produce a real spouse liability to misclassify');
  });
});
