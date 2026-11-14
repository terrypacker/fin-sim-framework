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
 * au-brokerage-gold-tax.test.mjs — gold held in an AUD-domiciled brokerage.
 *
 * Every gold disposal the suite covered sat in a US account. The located gold policy for an
 * AU resident (`GOLD_PREFERENCE_BY_RESIDENCY.AU`) names `au-stock`, so an AU brokerage can
 * hold a GOLD sleeve. These pin what its disposal must book, by both exits:
 *
 *   G-AU1 — a spending draw (`AuStockWithdrawalApplyReducer`) of a GOLD lot is a US
 *           collectible gain (28% bucket), not an ordinary US capital gain.
 *   G-AU2 — a rebalance sale of a GOLD lot states its currency: an AUD gain reaches the US
 *           buckets in USD and the AU buckets in AUD, not "as though it were USD".
 *   G-AU2b — that gain is AU-source: it stays out of the FY2027 US-source real slice.
 *   G-AU3 — a GOLD lot sold inside twelve months is not Division 115 discount-eligible.
 *
 * Effects are measured on the tax buckets the US and AU modules actually book, not on the
 * payload fields, because a missing field is read as a default rather than as an error.
 *
 * Run with: node --test tests/unit/au-brokerage-gold-tax.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AuStockWithdrawalApplyReducer } from '../../src/finance/account-rules/au/au-brokerage-classes.js';
import { RebalanceToTargetReducer }      from '../../src/finance/behavioral/rebalance-to-target-reducer.js';
import { RebalanceToTargetApplyReducer } from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
import { UsTaxModule2026 } from '../../src/finance/tax/us/us-tax-module-2026.js';
import { AuTaxModule2027 } from '../../src/finance/tax/au/au-tax-module-2027.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { ALLOCATION }    from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS }     from '../../src/finance/economic-regimes/rate-keys.js';
import { makeAccount, makeServices } from '../helpers/reducer-fixtures.js';

const FX = 1.5;                       // 1 USD = 1.5 AUD
const close = (a, b, msg) => assert.ok(Math.abs((a ?? 0) - b) < 0.02, `${msg}: got ${a}, want ${b}`);

/** Zeroed tax buckets for an AU-resident household with one person. */
const buckets = () => ({
  people: { primary: { residency: 'AU' } },
  effectiveExchangeRates: { USD_AUD: FX },
  usCapitalGainsYTD: 0, usCollectibleGainsYTD: 0, usOrdinaryIncomeYTD: 0,
  auCapitalGainsYTD: 0, auDiscountableGainsYTD: 0, auRealCapitalGainsYTD: 0,
  auOrdinaryIncomeYTD: 0,
});

/** An AU bucket's total: the household scalar plus its per-person twin (design 76 attribution). */
const AU_PERSON = {
  auCapitalGainsYTD:      'auPersonCapitalGainsYTD',
  auDiscountableGainsYTD: 'auPersonDiscountableGainsYTD',
  auRealCapitalGainsYTD:  'auPersonRealCapitalGainsYTD',
  usSourceRealCapGainsAudYTD: 'auPersonUsSourceRealCapGainsAudYTD',
};
const au = (s, k) => (s[k] ?? 0) + Object.values(s[AU_PERSON[k]] ?? {}).reduce((a, b) => a + b, 0);

/** Run each emitted tax action through the US module, then the FY2027 AU module (both run, as in the sim). */
function book(state, actions) {
  const us = new UsTaxModule2026().getReducerFns();
  const au = new AuTaxModule2027().getReducerFns();
  let s = state;
  for (const a of actions) {
    for (const fns of [us, au]) {
      const fn = fns.get(a.type);
      if (fn) s = fn(s, a);
    }
  }
  return s;
}

const goldLot = (over = {}) => ({
  id: 'lot-gold', allocation: ALLOCATION.GOLD, rateKey: RATE_KEYS.GOLD,
  marketValue: 150_000, costBasis: 100_000, purchaseDate: new Date(Date.UTC(2030, 8, 1)),
  costBaseByCountry: null, acquisitionDateByCountry: null, ...over,
});

// ── G-AU1: spending draw ─────────────────────────────────────────────────────────

test('G-AU1: a spending draw of AU-brokerage gold books a US COLLECTIBLE gain, in USD', () => {
  const state = {
    ...buckets(),
    auSavingsAccount: makeAccount({ stateKey: 'auSavingsAccount', currency: 'AUD', balance: 5_000 }),
    auStockAccount:   makeAccount({ stateKey: 'auStockAccount', currency: 'AUD', holdings: [goldLot()] }),
    currentPeriods: { US: { startMs: Date.UTC(2032, 0, 1) }, AU: { startMs: Date.UTC(2031, 6, 1) } },
  };
  const next = new AuStockWithdrawalApplyReducer(makeServices()).reduce(state,
    { type: 'AU_STOCK_WITHDRAWAL_APPLY', salePrice: 30_000, residency: 'AU' },
    new Date(Date.UTC(2032, 0, 1)));
  // 30,000 of a 150,000 lot ⇒ basis 20,000, gain A$10,000 = US$6,666.67, held 16 months.
  const taxed = book(next, next.next ?? []);
  close(taxed.usCollectibleGainsYTD, 10_000 / FX, 'US 28% collectible bucket');
  close(taxed.usCapitalGainsYTD, 0, 'nothing in the ordinary US LTCG bucket');
  close(au(taxed, 'auCapitalGainsYTD'), 10_000, 'AU nominal gain in AUD');
  close(au(taxed, 'auDiscountableGainsYTD'), 10_000, 'sixteen months qualifies under Division 115');
});

// ── G-AU2 / G-AU3: rebalance sale ───────────────────────────────────────────────

const APPLY = new RebalanceToTargetApplyReducer();

/** One reducer→apply cycle selling the whole gold sleeve of an AU brokerage. */
function rebalanceOutOfGold(gold, atMs) {
  const acct = {
    stateKey: 'auStockAccount', role: ACCOUNT_ROLES.AU_STOCK, type: 'brokerage', country: 'AU',
    currency: { code: 'AUD' },
    holdings: [
      { id: 'lot-eq', allocation: ALLOCATION.EQUITY, rateKey: RATE_KEYS.EQUITY_AU,
        marketValue: 150_000, costBasis: 150_000, purchaseDate: new Date(Date.UTC(2015, 0, 1)),
        costBaseByCountry: null, acquisitionDateByCountry: null },
      gold,
    ],
  };
  acct.balance = acct.holdings.reduce((s, h) => s + h.marketValue, 0);
  const state = {
    ...buckets(),
    activeRegimes: [], regimeActions: {},
    currentPeriods: { US: { startMs: atMs }, AU: { startMs: atMs } },
    auStockAccount: acct,
  };
  const reducer = new RebalanceToTargetReducer({
    accounts: [{ stateKey: 'auStockAccount', role: ACCOUNT_ROLES.AU_STOCK }],
    targetAllocation: { EQUITY: 1.0 },
    driftBandTaxable: 0.10, driftBandSheltered: 0.02,
  });
  const actions = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' }).next ?? [];
  let applied = state;
  const taxes = [];
  for (const a of actions) {
    applied = APPLY.reduce(applied, a);
    taxes.push(...(applied.next ?? []));
  }
  const goldTax = taxes.find(t => t.type === 'COLLECTIBLE_SALE_TAX');
  assert.ok(goldTax, `the gold sale emits COLLECTIBLE_SALE_TAX (got ${taxes.map(t => t.type)})`);
  const taxed = book(state, [goldTax]);
  return { goldTax, taxed };
}

test('G-AU2: a rebalance sale of AU-brokerage gold books USD in the US buckets and AUD in the AU ones', () => {
  // Gain A$50,000 on a lot held 16 months at the 2032 sale.
  const { taxed } = rebalanceOutOfGold(goldLot(), Date.UTC(2032, 0, 1));
  close(taxed.usCollectibleGainsYTD, 50_000 / FX, 'US collectible bucket in USD');
  close(taxed.foreignPassiveIncomeYTD, 50_000 / FX, 'US FTC passive basket in USD');
  close(au(taxed, 'auCapitalGainsYTD'), 50_000, 'AU nominal bucket in AUD');
  close(au(taxed, 'auRealCapitalGainsYTD'), 50_000, 'AU real bucket in AUD (no indexation on a flat CPI)');
});

test('G-AU2b: AU-brokerage gold is AU-source, so it is not in the FY2027 US-source real slice', () => {
  // The FITO limit's "without US-source" pass subtracts this slice; AU_STOCK_WITHDRAWAL_TAX
  // already excludes AU-native disposals from it.
  const { taxed } = rebalanceOutOfGold(goldLot(), Date.UTC(2032, 0, 1));
  close(au(taxed, 'usSourceRealCapGainsAudYTD'), 0, 'US-source real slice');
});

test('G-AU3: AU-brokerage gold sold inside twelve months is not discount-eligible', () => {
  // Bought 1 Sep 2031, sold 1 Jan 2032 — four months.
  const { taxed } = rebalanceOutOfGold(goldLot({ purchaseDate: new Date(Date.UTC(2031, 8, 1)) }),
                                       Date.UTC(2032, 0, 1));
  close(au(taxed, 'auCapitalGainsYTD'), 50_000, 'AU nominal bucket in AUD');
  close(au(taxed, 'auDiscountableGainsYTD'), 0, 'no Division 115 discount inside twelve months');
});

// ── The same two defects on the service drawdown path's EQUITY leg ──────────────
//
// `AccountService` draws an AU-domiciled brokerage with STOCK_WITHDRAWAL_TAX (currency
// 'AUD'), not AU_STOCK_WITHDRAWAL_TAX. The US module converted that gain for the AU
// buckets but booked it unconverted into the US ones, and the FY2027 AU module put it in
// the US-source real slice.

const stockSale = (stateKey, currency) => ({
  type: 'STOCK_WITHDRAWAL_TAX', currency, residency: 'AU', stateKey,
  gain: 30_000, auGain: 30_000, auIndexedGain: 30_000, auDiscountableGain: 30_000,
  usShortTermGain: 0, usLongTermGain: 30_000, auShortTermGain: 0, auLongTermGain: 30_000,
  proceeds: 90_000, costBasis: 60_000, description: 'draw',
});

test('G-AU2 (equity): an AUD STOCK_WITHDRAWAL_TAX books USD in the US bucket and stays out of the US-source slice', () => {
  const state = { ...buckets(),
    auBrokerage: makeAccount({ stateKey: 'auBrokerage', currency: 'AUD', country: 'AU', balance: 0 }) };
  const taxed = book(state, [stockSale('auBrokerage', 'AUD')]);
  close(taxed.usCapitalGainsYTD, 30_000 / FX, 'US LTCG bucket in USD');
  close(au(taxed, 'auCapitalGainsYTD'), 30_000, 'AU nominal bucket in AUD');
  close(au(taxed, 'auRealCapitalGainsYTD'), 30_000, 'AU real bucket in AUD');
  close(au(taxed, 'usSourceRealCapGainsAudYTD'), 0, 'US-source real slice');
  close(taxed.usSourceCapGainsAudYTD, 0, 'US-source nominal slice');
});

test('control: a US-domiciled STOCK_WITHDRAWAL_TAX is unchanged (USD, and in the US-source real slice)', () => {
  const state = { ...buckets(),
    usStockAccount: makeAccount({ stateKey: 'usStockAccount', currency: 'USD', country: 'US', balance: 0 }) };
  const taxed = book(state, [stockSale('usStockAccount', 'USD')]);
  close(taxed.usCapitalGainsYTD, 30_000, 'US LTCG bucket');
  close(au(taxed, 'auCapitalGainsYTD'), 30_000 * FX, 'AU nominal bucket in AUD');
  close(au(taxed, 'usSourceRealCapGainsAudYTD'), 30_000 * FX, 'US-source real slice');
});
