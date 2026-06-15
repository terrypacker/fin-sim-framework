/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  paramsToCsv,
  csvToParamUpdates,
  coerceParamValue,
  CSV_SCALAR_TYPES,
} from '../../src/visualization/scenario/param-csv.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sampleParams() {
  return [
    { name: 'iraGrowthRate',        label: 'IRA Growth Rate',   type: 'Number',  group: 'US Rates', value: 0.07 },
    { name: 'dividendReinvest',     label: 'Reinvest Dividends', type: 'Boolean', group: 'US Rates', value: false },
    { name: 'primaryRetirementDate', label: 'Primary Retire',    type: 'Date',    group: 'People',   value: '2040-01-01' },
    { name: 'drawdownStrategy',     label: 'Drawdown',          type: 'Enum',    group: 'Spending', value: 'TAXABLE_FIRST',
      options: ['TAXABLE_FIRST', 'ROTH_FIRST', 'CUSTOM'] },
    { name: 'note',                 label: 'Note',              type: 'String',  group: 'Misc',     value: 'hello' },
  ];
}

// ─── Export ───────────────────────────────────────────────────────────────────

test('paramsToCsv emits a header and one row per scalar param', () => {
  const csv  = paramsToCsv(sampleParams());
  const rows = csv.trim().split('\r\n');
  assert.equal(rows[0], 'key,group,type,label,value,currency');
  assert.equal(rows.length, 6); // header + 5 params
  assert.ok(rows.some(r => r.startsWith('iraGrowthRate,US Rates,Number,IRA Growth Rate,0.07')));
});

test('paramsToCsv skips hidden and non-scalar params', () => {
  const params = [
    ...sampleParams(),
    { name: 'shocks',  label: 'Shocks', type: 'ShockList', group: 'Econ', value: [] },
    { name: 'modes',   label: 'Modes',  type: 'EnumMulti', group: 'Econ', value: ['A'] },
    { name: 'secret',  label: 'Secret', type: 'Number',    group: 'Hidden', value: 1, hidden: true },
  ];
  const csv = paramsToCsv(params);
  assert.ok(!csv.includes('shocks'));
  assert.ok(!csv.includes('modes'));
  assert.ok(!csv.includes('secret'));
});

test('paramsToCsv quotes fields containing commas and quotes', () => {
  const csv = paramsToCsv([
    { name: 'k', label: 'Has, comma', type: 'String', group: 'g', value: 'a "quoted" value' },
  ]);
  assert.ok(csv.includes('"Has, comma"'));
  assert.ok(csv.includes('"a ""quoted"" value"'));
});

test('paramsToCsv formats Boolean and empty Number consistently', () => {
  const csv = paramsToCsv([
    { name: 'b', label: 'B', type: 'Boolean', group: 'g', value: true },
    { name: 'n', label: 'N', type: 'Number',  group: 'g', value: null },
  ]);
  assert.ok(csv.includes('b,g,Boolean,B,true'));
  assert.ok(csv.includes('n,g,Number,N,,\r\n')); // empty value cell + empty currency cell
});

// ─── Parse ────────────────────────────────────────────────────────────────────

test('csvToParamUpdates reads only key and value, ignoring column order/extras', () => {
  const text = 'label,value,type,key\nIRA,0.065,Number,iraGrowthRate\n';
  const updates = csvToParamUpdates(text);
  assert.deepEqual(updates, [{ key: 'iraGrowthRate', rawValue: '0.065', rawCurrency: '' }]);
});

test('csvToParamUpdates handles quoted fields with commas and newlines', () => {
  const text = 'key,value\n"a,b","line1\nline2"\n';
  const updates = csvToParamUpdates(text);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].key, 'a,b');
  assert.equal(updates[0].rawValue, 'line1\nline2');
});

test('csvToParamUpdates skips blank lines and empty keys', () => {
  const text = 'key,value\n\niraGrowthRate,0.07\n,9\n';
  const updates = csvToParamUpdates(text);
  assert.deepEqual(updates, [{ key: 'iraGrowthRate', rawValue: '0.07', rawCurrency: '' }]);
});

test('csvToParamUpdates throws when required columns are missing', () => {
  assert.throws(() => csvToParamUpdates('foo,bar\n1,2\n'), /must have.*key.*value/i);
});

test('csvToParamUpdates tolerates LF-only line endings and missing trailing newline', () => {
  const updates = csvToParamUpdates('key,value\niraGrowthRate,0.07');
  assert.deepEqual(updates, [{ key: 'iraGrowthRate', rawValue: '0.07', rawCurrency: '' }]);
});

// ─── Coercion ─────────────────────────────────────────────────────────────────

test('coerceParamValue coerces by the live param type', () => {
  assert.deepEqual(coerceParamValue({ type: 'Number' }, '0.065'), { ok: true, value: 0.065 });
  assert.deepEqual(coerceParamValue({ type: 'Number' }, ''), { ok: true, value: null });
  assert.deepEqual(coerceParamValue({ type: 'Boolean' }, 'TRUE'), { ok: true, value: true });
  assert.deepEqual(coerceParamValue({ type: 'Boolean' }, 'false'), { ok: true, value: false });
  assert.deepEqual(coerceParamValue({ type: 'Date' }, '2040-01-01'), { ok: true, value: '2040-01-01' });
  assert.deepEqual(coerceParamValue({ type: 'String' }, 'hi'), { ok: true, value: 'hi' });
});

test('coerceParamValue rejects malformed scalars', () => {
  assert.equal(coerceParamValue({ type: 'Number' }, 'abc').ok, false);
  assert.equal(coerceParamValue({ type: 'Boolean' }, 'maybe').ok, false);
  assert.equal(coerceParamValue({ type: 'Date' }, 'not-a-date').ok, false);
});

test('coerceParamValue validates Enum membership when options are present', () => {
  const enumParam = { type: 'Enum', options: ['TAXABLE_FIRST', 'ROTH_FIRST'] };
  assert.deepEqual(coerceParamValue(enumParam, 'ROTH_FIRST'), { ok: true, value: 'ROTH_FIRST' });
  assert.equal(coerceParamValue(enumParam, 'BOGUS').ok, false);
  // No options → accept any string.
  assert.deepEqual(coerceParamValue({ type: 'Enum' }, 'anything'), { ok: true, value: 'anything' });
});

// ─── Money type ─────────────────────────────────────────────────────────────────

test('Money param: value + currency export and round-trip (design 10 §Phase 5)', () => {
  const params = [
    { name: 'monthlyExpenses', label: 'Monthly Expenses', type: 'Money',
      group: 'Spending', value: 6000, currency: 'AUD' },
  ];
  const csv = paramsToCsv(params);
  // currency rides in its own column.
  assert.ok(csv.includes('monthlyExpenses,Spending,Money,Monthly Expenses,6000,AUD'));

  const [update] = csvToParamUpdates(csv);
  assert.equal(update.key, 'monthlyExpenses');
  assert.equal(update.rawValue, '6000');
  assert.equal(update.rawCurrency, 'AUD');

  // value coerces numerically, like Number.
  assert.deepEqual(coerceParamValue({ type: 'Money' }, update.rawValue), { ok: true, value: 6000 });
  assert.deepEqual(coerceParamValue({ type: 'Money' }, ''), { ok: true, value: null });
  assert.ok(CSV_SCALAR_TYPES.has('Money'));
});

// ─── Round trip ───────────────────────────────────────────────────────────────

test('export → parse → coerce round-trips every scalar param', () => {
  const params = sampleParams();
  const byKey  = new Map(params.map(p => [p.name, p]));
  const csv    = paramsToCsv(params);

  for (const { key, rawValue } of csvToParamUpdates(csv)) {
    const param = byKey.get(key);
    assert.ok(param, `unknown key ${key}`);
    assert.ok(CSV_SCALAR_TYPES.has(param.type));
    const res = coerceParamValue(param, rawValue);
    assert.ok(res.ok, `coerce failed for ${key}: ${res.error}`);
    assert.deepEqual(res.value, param.value);
  }
});
