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
 * evt-au-cgt-reform.test.mjs
 *
 * AU CGT reform (design 57) Phase 4:
 *   - the 1 July 2027 deemed cost base reset (AuCgtBasisResetReducer)
 *   - the Age Pension / JobSeeker exemption from the 30% CGT minimum tax
 *
 * Run with: node --test tests/unit/evt-au-cgt-reform.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AuCgtBasisResetReducer } from '../../src/finance/account-rules/au/au-cgt-reset-classes.js';
import { AuTaxRates2027 } from '../../src/finance/tax/au/au-tax-rates-2027.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';

// ─── Deemed cost base reset (design 57 §6.4, Method 1) ───────────────────────

/** Minimal accountService exposing one AU_STOCK account at a given stateKey. */
function stubAccountService(stateKey) {
  return { getAll: () => [{ role: ACCOUNT_ROLES.AU_STOCK, stateKey }] };
}

test('EVT-CGT-RESET: resets AU stock lots to market-value AU basis + July-2027 level', () => {
  const r = new AuCgtBasisResetReducer({ accountService: stubAccountService('auStockAccount') });
  const state = {
    inflationAccumulator: { AU: 1.3 },
    auStockAccount: {
      holdings: [
        { marketValue: 1000, costBasis: 600, costBaseByCountry: { AU: 700 }, acquisitionPriceLevel: null, purchaseDate: new Date(Date.UTC(2020, 0, 1)) },
        { marketValue: 500,  costBasis: 400, costBaseByCountry: null,        acquisitionPriceLevel: 1.0,  purchaseDate: new Date(Date.UTC(2022, 0, 1)) },
      ],
    },
  };
  const next = r.reduce(state);
  const [h0, h1] = next.auStockAccount.holdings;

  // AU cost base reset to market value; acquisition level stamped to July-2027 level.
  assert.strictEqual(h0.costBaseByCountry.AU, 1000);
  assert.strictEqual(h0.acquisitionPriceLevel, 1.3);
  assert.strictEqual(h1.costBaseByCountry.AU, 500);
  assert.strictEqual(h1.acquisitionPriceLevel, 1.3);

  // US cost base and purchase date are untouched (dual cost base preserved).
  assert.strictEqual(h0.costBasis, 600);
  assert.strictEqual(h0.purchaseDate.getUTCFullYear(), 2020);
});

test('EVT-CGT-RESET: only AU_STOCK accounts are reset; others untouched', () => {
  const r = new AuCgtBasisResetReducer({ accountService: stubAccountService('auStockAccount') });
  const state = {
    inflationAccumulator: { AU: 1.2 },
    auStockAccount: { holdings: [{ marketValue: 800, costBasis: 500, costBaseByCountry: { AU: 500 }, acquisitionPriceLevel: null }] },
    superAccount:   { holdings: [{ marketValue: 900, costBasis: 500, costBaseByCountry: { AU: 500 }, acquisitionPriceLevel: null }] },
  };
  const next = r.reduce(state);
  assert.strictEqual(next.auStockAccount.holdings[0].costBaseByCountry.AU, 800, 'AU stock reset');
  assert.strictEqual(next.superAccount.holdings[0].costBaseByCountry.AU, 500, 'super untouched');
  assert.strictEqual(next.superAccount.holdings[0].acquisitionPriceLevel, null, 'super level untouched');
});

// ─── Age Pension / JobSeeker minimum-tax exemption (design 57 §6.6) ──────────

const auResident = (overrides = {}) => ({
  people: { primary: { residency: 'AU' } },
  auOrdinaryIncomeYTD: 0, auCapitalGainsYTD: 0, auNonResidentWithholdingYTD: 0,
  auSuperTaxYTD: 0, auFrankingCreditYTD: 0,
  ...overrides,
});

test('EXEMPT: income-support recipient pays no 30% minimum-tax top-up', () => {
  const rates = new AuTaxRates2027();
  const gainState = { auCapitalGainsYTD: 100_000, auRealCapitalGainsYTD: 100_000 };

  const taxed  = rates.computeTax(auResident({ ...gainState }));
  const exempt = rates.computeTax(auResident({ ...gainState, auMinTaxExempt: true }));

  assert.ok(taxed.cgtMinimumTaxTopUp > 0, 'non-exempt gets a top-up');
  assert.strictEqual(exempt.cgtMinimumTaxTopUp, 0, 'exempt gets no top-up');
  assert.ok(exempt.netLiability < taxed.netLiability, 'exemption lowers the liability');
});
