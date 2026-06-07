/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import { flattenStatePaths, groupFor, STATE_FIELD_GROUPS } from '../../src/visualization/state/state-paths.js';
import { ParameterValueType } from '../../src/finance/services/state-schema-registry.js';

// ─── flattenStatePaths ────────────────────────────────────────────────────────

test('flattenStatePaths: emits only finite-number leaves', () => {
  const state = { a: 1, b: 'hello', c: true, d: null, e: undefined, f: Infinity };
  const paths = flattenStatePaths(state);
  assert.deepStrictEqual(paths.map(p => p.path), ['a']);
  assert.strictEqual(paths[0].value, 1);
});

test('flattenStatePaths: recurses into nested objects', () => {
  const state = { account: { balance: 50_000 } };
  const paths = flattenStatePaths(state);
  assert.strictEqual(paths.length, 1);
  assert.strictEqual(paths[0].path, 'account.balance');
  assert.strictEqual(paths[0].value, 50_000);
});

test('flattenStatePaths: indexes arrays positionally', () => {
  const state = { holdings: [{ marketValue: 100 }, { marketValue: 200 }] };
  const paths = flattenStatePaths(state);
  const pathNames = paths.map(p => p.path);
  assert.ok(pathNames.includes('holdings.0.marketValue'));
  assert.ok(pathNames.includes('holdings.1.marketValue'));
});

test('flattenStatePaths: skips NaN and Infinity', () => {
  const state = { bad: NaN, inf: Infinity, negInf: -Infinity, ok: 42 };
  const paths = flattenStatePaths(state);
  assert.deepStrictEqual(paths.map(p => p.path), ['ok']);
});

test('flattenStatePaths: returns type from StateSchemaRegistry', () => {
  const state = { effectiveExchangeRates: { USD_AUD: 0.65 } };
  const paths = flattenStatePaths(state);
  assert.strictEqual(paths.length, 1);
  assert.strictEqual(paths[0].type.kind, 'rate');
});

test('flattenStatePaths: returns unknown type for unregistered path', () => {
  const state = { someCustomField: 42 };
  const paths = flattenStatePaths(state);
  assert.strictEqual(paths[0].type.kind, 'unknown');
});

test('flattenStatePaths: metrics.* paths get metric type', () => {
  const state = { metrics: { netWorth: 500_000 } };
  const paths = flattenStatePaths(state);
  assert.strictEqual(paths[0].path, 'metrics.netWorth');
  assert.strictEqual(paths[0].type.kind, 'metric');
});

test('flattenStatePaths: handles empty state', () => {
  const paths = flattenStatePaths({});
  assert.deepStrictEqual(paths, []);
});

test('flattenStatePaths: handles null/undefined state gracefully', () => {
  assert.deepStrictEqual(flattenStatePaths(null), []);
  assert.deepStrictEqual(flattenStatePaths(undefined), []);
});

test('flattenStatePaths: deeply nested object emits full path', () => {
  const state = { a: { b: { c: { d: 99 } } } };
  const paths = flattenStatePaths(state);
  assert.strictEqual(paths[0].path, 'a.b.c.d');
  assert.strictEqual(paths[0].value, 99);
});

// ─── groupFor ────────────────────────────────────────────────────────────────

test('groupFor: metrics.* → Metrics', () => {
  assert.strictEqual(groupFor('metrics.netWorth'), 'Metrics');
  assert.strictEqual(groupFor('metrics.balance'),  'Metrics');
});

test('groupFor: FX paths', () => {
  assert.strictEqual(groupFor('effectiveExchangeRates.USD_AUD'), 'FX');
  assert.strictEqual(groupFor('baseExchangeRates.USD_AUD'),      'FX');
});

test('groupFor: Regime Rates paths', () => {
  assert.strictEqual(groupFor('effectiveInflationRates.USD'),    'Regime Rates');
  assert.strictEqual(groupFor('effectiveAppreciationRates.US_REAL_ESTATE'), 'Regime Rates');
  assert.strictEqual(groupFor('effectiveInterestRates.SAVINGS'), 'Regime Rates');
});

test('groupFor: Asset Values paths', () => {
  assert.strictEqual(groupFor('usSavingsAccount.holdings.0.marketValue'), 'Asset Values');
  assert.strictEqual(groupFor('rothIra.holdings.2.costBasis'),            'Asset Values');
});

test('groupFor: Balances paths', () => {
  assert.strictEqual(groupFor('usSavingsAccount.balance'), 'Balances');
  assert.strictEqual(groupFor('rothIra.balance'),          'Balances');
});

test('groupFor: Tax / YTD paths', () => {
  assert.strictEqual(groupFor('usOrdinaryIncomeYTD'), 'Tax / YTD');
  assert.strictEqual(groupFor('auCapitalGainsYTD'),   'Tax / YTD');
  assert.strictEqual(groupFor('cumulativeDeficit'),   'Tax / YTD');
});

test('groupFor: auto-groups unmatched paths by first segment', () => {
  assert.strictEqual(groupFor('someWeirdField'),          'someWeirdField');
  assert.strictEqual(groupFor('foo.bar.baz'),             'foo');
  assert.strictEqual(groupFor('inflationAccumulator'),    'inflationAccumulator');
});

test('groupFor: metrics.balance goes to Metrics not Balances (Metrics has priority)', () => {
  assert.strictEqual(groupFor('metrics.balance'), 'Metrics',
    'metrics.* must be checked before *.balance');
});

// ─── STATE_FIELD_GROUPS ───────────────────────────────────────────────────────

test('STATE_FIELD_GROUPS: Metrics is the first group (priority ordering)', () => {
  assert.strictEqual(STATE_FIELD_GROUPS[0].label, 'Metrics');
});

test('STATE_FIELD_GROUPS: all expected curated groups are present', () => {
  const labels = STATE_FIELD_GROUPS.map(g => g.label);
  for (const expected of ['Metrics', 'FX', 'Regime Rates', 'Asset Values', 'Balances', 'Tax / YTD']) {
    assert.ok(labels.includes(expected), `missing group: ${expected}`);
  }
});
