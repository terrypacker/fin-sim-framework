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
 * state-schema-registry.test.mjs — design 101 R1 (§9.2): the value-rendering defects
 * each have a test here, named by their R-number.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { StateSchemaRegistry, ParameterValueType } from '../../src/finance/services/state-schema-registry.js';

function usdRegistry() {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usStockAccount', { currency: { code: 'USD' }, type: 'brokerage' });
  return reg;
}

// ── R-1: id-addressed holding paths ─────────────────────────────────────────

test('R-1: a bracketed holding path resolves exactly as the positional one does', () => {
  const reg = usdRegistry();
  for (const field of ['marketValue', 'costBasis', 'pricePerUnit', 'faceValue', 'units',
                       'dividendYield', 'couponRate', 'couponFrequency', 'purchaseDate',
                       'costBaseByCountry.AU', 'acquisitionDateByCountry.AU']) {
    const pos = reg.resolve(`usStockAccount.holdings.0.${field}`);
    const ids = reg.resolve(`usStockAccount.holdings[id=h-us-equity].${field}`);
    assert.notEqual(ids.kind, 'unknown', `${field} is typed`);
    assert.equal(ids.kind, pos.kind, `${field}: same kind`);
    assert.equal(ids.currencyCode, pos.currencyCode, `${field}: same currency`);
  }
});

test('R-1: a lot in a USD account formats as USD money, and its yield keeps 4 dp', () => {
  const reg = usdRegistry();
  assert.equal(reg.format('usStockAccount.holdings[id=h1].marketValue', 123456.789), '$123,456.79');
  assert.equal(reg.format('usStockAccount.holdings[id=h1].dividendYield', 0.0715), '7.15%');
});

test('R-1: the per-country cost base is the account\'s currency, not the country\'s', () => {
  // AccountService.recordResidencyChange stamps costBaseByCountry[country] = marketValue.
  const reg = usdRegistry();
  assert.equal(reg.resolve('usStockAccount.holdings[id=h1].costBaseByCountry.AU').currencyCode, 'USD');
});

// ── R-2: rates are percentages, FX multipliers are not ─────────────────────

test('R-2: an annual rate renders as a percentage', () => {
  const reg = new StateSchemaRegistry();
  assert.equal(reg.format('effectiveGrowthRates.EQUITY_US', 0.0715), '7.15%');
  assert.equal(reg.format('effectiveInterestRates.SAVINGS_US', 0.00125), '0.125%');
});

test('R-2: FX rates are their own kind, shown as a 4-dp multiplier', () => {
  const reg = new StateSchemaRegistry();
  for (const p of ['baseExchangeRates.USD_AUD', 'effectiveExchangeRates.USD_AUD', 'fxAnchorRates.USD_AUD']) {
    assert.equal(reg.resolve(p).kind, 'fxRate', p);
  }
  assert.equal(reg.format('effectiveExchangeRates.USD_AUD', 1.55), '1.5500');
});

// ── R-3: epoch-ms timestamps ────────────────────────────────────────────────

const JAN_1_2050_MS = Date.UTC(2050, 0, 1);

test('R-3: an epoch-ms field is a date, formatted as one and not chartable', () => {
  const reg = new StateSchemaRegistry();
  for (const p of ['currentPeriods.US.startMs', 'priorMarkMs', 'people.p1.residencySinceMs',
                   'auHouseProperty.acquisitionDateByCountry.AU']) {
    assert.equal(reg.resolve(p).kind, 'date', p);
    assert.equal(reg.isChartable(p), false, `${p} is not chartable`);
  }
  assert.equal(reg.format('currentPeriods.US.startMs', JAN_1_2050_MS), '2050-01-01');
  assert.equal(reg.isChartable('usStockAccount.balance'), true);
});

test('R-3: a date uses the display timezone formatter when one is wired', () => {
  const reg = new StateSchemaRegistry();
  const seen = [];
  reg.displaySettings = { formatDate: d => { seen.push(d); return 'Jan 01, 2050'; } };
  assert.equal(reg.format('currentPeriods.US.startMs', JAN_1_2050_MS), 'Jan 01, 2050');
  assert.ok(seen[0] instanceof Date && seen[0].getTime() === JAN_1_2050_MS);
});

// ── R-5: ordinals, counts and years ─────────────────────────────────────────

test('R-5: ordinals and counts render as integers, years without a separator', () => {
  const reg = usdRegistry();
  assert.equal(reg.format('usStockAccount.drawdownPriority', 8), '8');
  assert.equal(reg.format('usStockAccount.holdings[id=b1].couponFrequency', 2), '2');
  assert.equal(reg.format('usStockAccount.holdings[id=b1].units', 12.5), '12.5000');
  assert.equal(reg.format('usHousePropertyLoan.maturityYear', 2045), '2045');
  assert.equal(reg.isChartable('usHousePropertyLoan.maturityYear'), false);
  assert.equal(reg.format('securities.sec-core.beta', 1.1), '1.10');
});

// ── R-6: year-keyed children of an exact-registered parent ─────────────────

test('R-6: year-keyed series type their children, not just the parent', () => {
  const reg = new StateSchemaRegistry();
  assert.equal(reg.resolve('bracketIndexAccumulatorByYear.US.2044').kind, 'decimal');
  assert.equal(reg.resolve('inflationAccumulator.AU').kind, 'decimal');
  const unused = reg.resolve('auSuperCapsByPerson.p1.unusedByFy.2031');
  assert.equal(unused.kind, 'currency');
  assert.equal(unused.currencyCode, 'AUD');
  assert.equal(reg.resolve('auSuperCapsByPerson.p1.bringForward.cap').currencyCode, 'AUD');
  assert.equal(reg.resolve('auSuperCapsByPerson.p1.bringForward.firstFy').kind, 'year',
    'the bring-forward trigger year is not money');
});

// ── R-8: country prefix ─────────────────────────────────────────────────────

test('R-8: a name already leading with its country is not prefixed twice', () => {
  const reg = new StateSchemaRegistry();
  reg.registerDisplayRecord('auSavingsAccount', { name: 'AU Savings', country: 'AU' }, 'account');
  reg.registerDisplayRecord('auStockAccount',   { name: 'Brokerage',  country: 'AU' }, 'account');
  assert.equal(reg.displayNameFor('auSavingsAccount'), 'AU Savings');
  assert.equal(reg.displayNameFor('auStockAccount'),   'AU Brokerage');
});

// ── Mirror prefix and status ───────────────────────────────────────────────

test('usPendingReturn mirrors the top-level YTD fields', () => {
  const reg = new StateSchemaRegistry();
  const vt = reg.resolve('usPendingReturn.usCapitalGainsYTD');
  assert.equal(vt.kind, 'currency');
  assert.equal(vt.currencyCode, 'USD');
  assert.equal(reg.resolve('usPendingReturn.currentPeriods.US.endMs').kind, 'date');
  assert.equal(reg.resolve('usPendingReturn.notAField').kind, 'unknown');
});

test('status: residency, the current period and flags are status; identity text is not', () => {
  const reg = new StateSchemaRegistry();
  assert.equal(reg.isStatus('people.p1.residency'), true);
  assert.equal(reg.isStatus('currentPeriods.AU.name'), true);
  assert.equal(reg.isStatus('scenarioFailed'), true, 'booleans are status');
  assert.equal(reg.isStatus('usStockAccount.holdings[id=h1].label'), false);
  assert.equal(reg.isStatus('usStockAccount.holdings[id=h1].rateKey'), false);
  assert.equal(reg.isStatus('securities.sec-core.symbol'), false);
});

test('ParameterValueType: status defaults off; text({status}) and boolean() set it', () => {
  assert.equal(ParameterValueType.text().status, false);
  assert.equal(ParameterValueType.text({ status: true }).status, true);
  assert.equal(ParameterValueType.boolean().status, true);
  assert.equal(ParameterValueType.rate().status, false);
});
