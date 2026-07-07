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
 * design/51-tax-bucket-fx-normalization.md
 *
 * Every YTD tax accumulator has one canonical currency (US/state buckets USD, AU
 * buckets AUD). A `*_TAX` reducer whose source income is in a different currency
 * converts each cross-currency write at the event's recorded FX rate before
 * accumulating. These tests pin the helper and a representative slice of both
 * modules; the regolded evt-* suites are the per-income-type golden guard.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { toCcy, toUSD, toAUD } from '../../src/finance/tax/tax-fx.js';
import { UsTaxModule2026 }     from '../../src/finance/tax/us/us-tax-module-2026.js';
import { AuTaxModule2026 }     from '../../src/finance/tax/au/au-tax-module-2026.js';

const RATE = 1.55; // 1 USD = 1.55 AUD
const withRate = (extra = {}) => ({ effectiveExchangeRates: { USD_AUD: RATE }, ...extra });

const usFns = new Map(new UsTaxModule2026().getReducerFns());
const auFns = new Map(new AuTaxModule2026().getReducerFns());

const zeroTax = () => ({
  usOrdinaryIncomeYTD: 0, usCapitalGainsYTD: 0, usCollectibleGainsYTD: 0,
  usNegativeIncomeYTD: 0, usPenaltyYTD: 0, ftcYTD: 0,
  auOrdinaryIncomeYTD: 0, auCapitalGainsYTD: 0, auNonResidentWithholdingYTD: 0,
});

// ─── Helper ─────────────────────────────────────────────────────────────────

test('toCcy: converts AUD→USD at the recorded rate', () => {
  assert.strictEqual(toUSD(3000, 'AUD', withRate()), 3000 / RATE);
  assert.strictEqual(toAUD(8000, 'USD', withRate()), 8000 * RATE);
});

test('toCcy: same currency is a no-op (no rate needed)', () => {
  assert.strictEqual(toUSD(500, 'USD', withRate()), 500);
  assert.strictEqual(toCcy(500, 'AUD', 'AUD', {}), 500);
});

test('toCcy: missing rate falls back to the native amount (never silent 1:1 mislabel)', () => {
  assert.strictEqual(toUSD(3000, 'AUD', {}), 3000);                       // no effectiveExchangeRates
  assert.strictEqual(toUSD(3000, 'AUD', { effectiveExchangeRates: {} }), 3000);
});

// ─── AU module: AUD-source → USD buckets converted, AU buckets native ─────────

test('AU_WAGES_INCOME_TAX (US-resident earner): AUD wage normalized into USD buckets, AU NR bucket native', () => {
  const fn = auFns.get('AU_WAGES_INCOME_TAX');
  const next = fn(withRate(zeroTax()), { type: 'AU_WAGES_INCOME_TAX', amount: 2000, residency: 'US', personKey: 'spouse' });
  assert.strictEqual(next.usOrdinaryIncomeYTD, 2000 / RATE);            // AUD → USD
  assert.strictEqual(next.ftcYTD, 2000 / RATE);                        // ftc is USD-canonical
  assert.strictEqual(next.auNonResidentWithholdingYTD, 2000);          // AU bucket stays native AUD
});

test('AU_SAVINGS_EARNINGS_TAX (AU resident): AUD interest → USD worldwide bucket converted, AU ordinary native', () => {
  const fn = auFns.get('AU_SAVINGS_EARNINGS_TAX');
  const next = fn(withRate(zeroTax()), { type: 'AU_SAVINGS_EARNINGS_TAX', amount: 1000, residency: 'AU' });
  assert.strictEqual(next.usOrdinaryIncomeYTD, 1000 / RATE);
  assert.strictEqual(next.ftcYTD, 1000 / RATE);
  assert.strictEqual(next.auOrdinaryIncomeYTD, 1000);                  // native AUD
});

// ─── US module: USD-source → AU buckets converted, US buckets native ──────────

test('WAGES_INCOME_TAX (AU resident): USD wage normalized into AUD bucket, US bucket + ftc native USD', () => {
  const fn = usFns.get('WAGES_INCOME_TAX');
  // No personKey → shared auOrdinaryIncomeYTD branch.
  const next = fn(withRate(zeroTax()), { type: 'WAGES_INCOME_TAX', amount: 8000, residency: 'AU' });
  assert.strictEqual(next.usOrdinaryIncomeYTD, 8000);                  // USD native
  assert.strictEqual(next.auOrdinaryIncomeYTD, 8000 * RATE);          // USD → AUD
  assert.strictEqual(next.ftcYTD, 8000);                              // ftc is USD-canonical
});

test('STOCK_WITHDRAWAL_TAX (AU resident): USD gain → AUD CGT bucket converted, US CGT native', () => {
  const fn = usFns.get('STOCK_WITHDRAWAL_TAX');
  const next = fn(withRate(zeroTax()), { type: 'STOCK_WITHDRAWAL_TAX', gain: 10000, auGain: 10000, residency: 'AU' });
  assert.strictEqual(next.usCapitalGainsYTD, 10000);                  // USD native
  assert.strictEqual(next.auCapitalGainsYTD, 10000 * RATE);          // USD → AUD
});

// ─── Back-compat: rate-less path is byte-identical to the pre-normalization sum ──

test('AU_WAGES_INCOME_TAX with no recorded rate accrues the native amount (no throw)', () => {
  const fn = auFns.get('AU_WAGES_INCOME_TAX');
  const next = fn(zeroTax(), { type: 'AU_WAGES_INCOME_TAX', amount: 2000, residency: 'US', personKey: 'spouse' });
  assert.strictEqual(next.usOrdinaryIncomeYTD, 2000);                 // native fallback
  assert.strictEqual(next.auNonResidentWithholdingYTD, 2000);
});
