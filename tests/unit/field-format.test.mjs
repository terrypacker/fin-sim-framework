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
 * field-format.test.mjs — design 101 R2: the FieldFormatter is the one place a state
 * path + value becomes display text, labels and hovers.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { FieldFormatter }      from '../../src/visualization/state/field-format.js';
import { StateSchemaRegistry } from '../../src/finance/services/state-schema-registry.js';

function formatter({ state = null } = {}) {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usStockAccount', { currency: { code: 'USD' }, type: 'brokerage', name: 'Brokerage', country: 'US' });
  reg.registerAccount('superAccount',   { currency: { code: 'AUD' }, type: 'super',     name: 'Super',     country: 'AU' });
  reg.registerPerson({ id: 'p1', name: 'Marge' });
  return { reg, f: new FieldFormatter({ registry: reg, stateProvider: () => state }) };
}

// ── describe ────────────────────────────────────────────────────────────────

test('describe: kind, currency, chartable and typed come from the one registry', () => {
  const { f } = formatter();
  assert.deepEqual(
    (({ kind, currencyCode, chartable, typed }) => ({ kind, currencyCode, chartable, typed }))(
      f.describe('usStockAccount.holdings[id=h1].marketValue')),
    { kind: 'currency', currencyCode: 'USD', chartable: true, typed: true },
    'the per-account stamp is seen, which the module-default registry could not (R-9)');
  assert.equal(f.describe('currentPeriods.US.startMs').chartable, false);
  assert.equal(f.describe('somethingUnregistered').typed, false);
});

// ── labels ──────────────────────────────────────────────────────────────────

test('label: a record shows its display name, a field its beautified leaf', () => {
  const { f } = formatter();
  assert.equal(f.label('usStockAccount'), 'US Brokerage');
  assert.equal(f.label('usStockAccount.holdings[id=h1].marketValue'), 'Market Value');
});

test('contextLabel: owner · holding · field, the holding named from state (R-7)', () => {
  const state = {
    securities: { 'sec-core': { symbol: 'SWTSX', name: 'Schwab Total Stock Market' } },
    usStockAccount: { holdings: [
      { id: 'h1', securityId: 'sec-core' },
      { id: 'h2', label: 'SF Bay' },
      { id: 'h3' },
    ] },
  };
  const { f } = formatter({ state });
  assert.equal(f.contextLabel('usStockAccount.holdings[id=h1].marketValue'), 'US Brokerage · SWTSX · Market Value');
  assert.equal(f.contextLabel('usStockAccount.holdings[id=h2].costBasis'),   'US Brokerage · SF Bay · Cost Basis');
  assert.equal(f.contextLabel('usStockAccount.holdings[id=h3].units'),       'US Brokerage · h3 · Units');
  assert.equal(f.contextLabel('usStockAccount.holdings[id=gone].units'),     'US Brokerage · gone · Units',
    'a lot no longer held falls back to its id');
});

test('contextLabel: people, metrics, balance copies and ownerless paths', () => {
  const { f } = formatter();
  assert.equal(f.contextLabel('people.p1.monthlyWage'), 'Marge · Monthly Wage');
  assert.equal(f.contextLabel('metrics.netWorth'), 'Net Worth');
  assert.equal(f.contextLabel('metrics.superAccount'), 'AU Super', 'a balance copy reads as its account');
  assert.equal(f.contextLabel('effectiveGrowthRates.EQUITY_US'), 'Effective Growth Rates · EQUITY US');
  assert.equal(f.contextLabel('usStockAccount.balance'), 'US Brokerage · Balance');
});

test('contextLabel: an explicit state wins over the provider', () => {
  const { f } = formatter({ state: null });
  const state = { usStockAccount: { holdings: [{ id: 'h1', label: 'Tech lot' }] } };
  assert.equal(f.contextLabel('usStockAccount.holdings[id=h1].units', { state }), 'US Brokerage · Tech lot · Units');
});

// ── format ──────────────────────────────────────────────────────────────────

test('format: delegates scalars to the registry (currency, rate, fx, date)', () => {
  const { f } = formatter();
  assert.equal(f.format('usStockAccount.balance', 1234.5), '$1,234.50');
  assert.equal(f.format('effectiveGrowthRates.EQUITY_US', 0.0715), '7.15%');
  assert.equal(f.format('effectiveExchangeRates.USD_AUD', 1.55), '1.5500');
  assert.equal(f.format('currentPeriods.US.startMs', Date.UTC(2050, 0, 1)), '2050-01-01');
});

test('format: compact money for dense rows and chips', () => {
  const { f } = formatter();
  assert.equal(f.format('usStockAccount.balance', 3_214_000, { compact: true }), '$3.21M');
  assert.equal(f.format('superAccount.balance',     450_200, { compact: true }), 'A$450k');
  assert.equal(f.format('usStockAccount.balance',       320, { compact: true }), '$320');
  assert.equal(f.format('usStockAccount.balance',  -12_600, { compact: true }), '-$13k');
  assert.equal(f.format('effectiveGrowthRates.EQUITY_US', 0.07, { compact: true }), '7.00%',
    'compact only changes money');
});

test('format: an object under a subtree glob is declined, never "[object Object]"', () => {
  const { f } = formatter();
  // `auSuperCapsByPerson.**` is money, and matches the record object itself too.
  assert.equal(f.format('auSuperCapsByPerson.p1', { concessionalYTD: 5 }), null);
  assert.equal(f.format('usStockAccount.holdings', [{ id: 'h1' }]), null);
  assert.equal(f.format('someUnregisteredText', 'x'), null);
});

// ── valueTitle ──────────────────────────────────────────────────────────────

test('valueTitle: an untyped number says it is a guess', () => {
  const { f } = formatter();
  assert.match(f.valueTitle('somethingUnregistered', 12), /No schema entry/);
  assert.equal(f.valueTitle('effectiveGrowthRates.EQUITY_US', 0.07), null);
});

test('valueTitle: a converted amount shows the native amount and the rate', () => {
  const { reg, f } = formatter();
  assert.equal(f.valueTitle('superAccount.balance', 1000), null, 'no display currency: nothing converted');
  reg.displaySettings   = { displayCurrency: 'USD' };
  reg.currencyConverter = { convert: (v, from, to) => (from === 'AUD' && to === 'USD' ? v * 0.65 : null) };
  reg.rateStateProvider = () => ({});
  assert.equal(f.valueTitle('superAccount.balance', 1000), 'A$1,000.00 native @ 0.6500 AUD→USD');
  assert.equal(f.format('superAccount.balance', 1000), '$650.00');
  assert.equal(f.valueTitle('usStockAccount.balance', 1000), null, 'already in the display currency');
});
