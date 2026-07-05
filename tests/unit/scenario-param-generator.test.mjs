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
 * scenario-param-generator.test.mjs — design 55 §5.
 *
 * Unit coverage for ScenarioParamGenerator: key scheme, node shape, value
 * seeding from the record, per-type templates, role/class type fallback,
 * duplicate-stateKey handling, and design-10 Money seeding.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { ScenarioParamGenerator, isGeneratedParamKey, decodeGeneratedParamKey }
  from '../../src/scenarios/params/scenario-param-generator.js';

// A minimal cfg with one account per relevant type, a person, and a property.
function sampleCfg() {
  return {
    accounts: [
      { stateKey: 'usSavingsAccount', type: 'savings',   name: 'US Savings', country: 'US', balance: 30000 },
      { stateKey: 'rothAccount',      type: 'roth',       name: 'Roth IRA',   country: 'US', balance: 80000, contributionBasis: 60000 },
    ],
    persons: [
      { id: 'primary', name: 'Primary', monthlyWage: 8000, retirementDate: '2040-01-01T00:00:00.000Z' },
    ],
    realProperties: [
      { stateKey: 'usHouseProperty', name: 'US House', country: 'US', value: 1000000, appreciationRate: 0.04, plannedSaleYear: null },
    ],
  };
}

test('GEN-1: emits namespaced keys with per-record node and record-seeded value', () => {
  const out = ScenarioParamGenerator.generate(sampleCfg());
  const byKey = new Map(out.map(e => [e.key, e]));

  const roth = byKey.get('acct.rothAccount.balance');
  assert.ok(roth, 'acct.rothAccount.balance should be generated');
  assert.deepStrictEqual(roth.node, { type: 'account', stateKey: 'rothAccount', field: 'balance' });
  assert.strictEqual(roth.defaultValue, 80000, 'value seeds from the record');
  assert.strictEqual(roth.type, 'Number');

  const wage = byKey.get('person.primary.monthlyWage');
  assert.deepStrictEqual(wage.node, { type: 'person', id: 'primary', field: 'monthlyWage' });
  assert.strictEqual(wage.defaultValue, 8000);

  const sale = byKey.get('prop.usHouseProperty.plannedSaleYear');
  assert.deepStrictEqual(sale.node, { type: 'realProperty', stateKey: 'usHouseProperty', field: 'plannedSaleYear' });
  assert.strictEqual(sale.defaultValue, null, 'nullable field seeds null');
});

test('GEN-2: per-type templates — savings gets balance only, roth adds contributionBasis', () => {
  const out = ScenarioParamGenerator.generate(sampleCfg());
  const keys = out.map(e => e.key);
  assert.ok(keys.includes('acct.usSavingsAccount.balance'));
  assert.ok(!keys.includes('acct.usSavingsAccount.contributionBasis'), 'savings has no contributionBasis param');
  assert.ok(keys.includes('acct.rothAccount.balance'));
  assert.ok(keys.includes('acct.rothAccount.contributionBasis'), 'roth exposes contributionBasis');
});

test('GEN-3: label and group derive from the record display name + country', () => {
  const out = ScenarioParamGenerator.generate(sampleCfg());
  const roth = out.find(e => e.key === 'acct.rothAccount.balance');
  assert.strictEqual(roth.label, 'Roth IRA — Balance');
  assert.strictEqual(roth.group, 'US · Roth IRA');
  const wage = out.find(e => e.key === 'person.primary.monthlyWage');
  assert.strictEqual(wage.group, 'Primary', 'person group is the record name (no country)');
});

test('GEN-4: falls back to __type / role when `type` is absent (raw buildDefaultConfig record)', () => {
  const cfg = {
    accounts: [
      { stateKey: 'k401Account', __type: 'FourOhOneKAccount', role: 'k401', name: '401(k)', balance: 300000, contributionBasis: 200000 },
      { stateKey: 'auStock',     role: 'au-stock',            name: 'AU Stock', balance: 60000 },
    ],
  };
  const keys = ScenarioParamGenerator.generate(cfg).map(e => e.key);
  assert.ok(keys.includes('acct.k401Account.balance'), '__type fallback resolves 401k');
  assert.ok(keys.includes('acct.k401Account.contributionBasis'));
  assert.ok(keys.includes('acct.auStock.balance'), 'role fallback resolves brokerage');
});

test('GEN-5: duplicate stateKey warns and skips the duplicate', () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const cfg = { accounts: [
      { stateKey: 'dup', type: 'savings', name: 'A', balance: 1 },
      { stateKey: 'dup', type: 'savings', name: 'B', balance: 2 },
    ] };
    const out = ScenarioParamGenerator.generate(cfg);
    const dupEntries = out.filter(e => e.key === 'acct.dup.balance');
    assert.strictEqual(dupEntries.length, 1, 'only the first record wins');
    assert.strictEqual(dupEntries[0].defaultValue, 1);
    assert.ok(warnings.some(w => w.includes('Duplicate param key')), 'warns on collision');
  } finally {
    console.warn = orig;
  }
});

test('GEN-6: record without a stateKey/id is skipped (with a warning)', () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const cfg = { accounts: [{ type: 'savings', name: 'No Key', balance: 5 }] };
    const out = ScenarioParamGenerator.generate(cfg);
    assert.strictEqual(out.length, 0);
    assert.ok(warnings.some(w => w.includes('no stateKey')));
  } finally {
    console.warn = orig;
  }
});

test('GEN-7: Money template field seeds design-10 currency metadata from the record', () => {
  // Phase 1 templates are all Number; exercise the money path directly so the
  // design-10 seeding stays covered for the phase that flips `money: true`.
  const [entry] = ScenarioParamGenerator._expand(
    'acct', 'account',
    { name: 'AU Savings', currency: { code: 'AUD' }, balance: 5000 },
    'auSavingsAccount',
    [{ field: 'balance', label: 'Balance', type: 'Number', money: true }],
  );
  assert.strictEqual(entry.type, 'Money');
  assert.strictEqual(entry.defaultCurrency, 'AUD');
  assert.deepStrictEqual(entry.currencyStateKeys, ['auSavingsAccount.balance']);
});

test('GEN-8: isGeneratedParamKey recognises generated namespaces only', () => {
  assert.ok(isGeneratedParamKey('acct.rothAccount.balance'));
  assert.ok(isGeneratedParamKey('person.primary.monthlyWage'));
  assert.ok(isGeneratedParamKey('prop.usHouseProperty.value'));
  assert.ok(!isGeneratedParamKey('rothBalance'));
  assert.ok(!isGeneratedParamKey('monthlyExpenses'));
  assert.ok(!isGeneratedParamKey(undefined));
});

test('GEN-9: decodeGeneratedParamKey round-trips a generated key back to its node', () => {
  assert.deepStrictEqual(decodeGeneratedParamKey('acct.rothAccount.balance'),
    { type: 'account', stateKey: 'rothAccount', field: 'balance' });
  assert.deepStrictEqual(decodeGeneratedParamKey('person.primary.monthlyWage'),
    { type: 'person', id: 'primary', field: 'monthlyWage' });
  assert.deepStrictEqual(decodeGeneratedParamKey('prop.usHouseProperty.plannedSaleYear'),
    { type: 'realProperty', stateKey: 'usHouseProperty', field: 'plannedSaleYear' });
  assert.strictEqual(decodeGeneratedParamKey('rothBalance'), null, 'non-generated key → null');
  assert.strictEqual(decodeGeneratedParamKey('acct.balance'), null, 'malformed (no owner) → null');
});

// ── Collectible / company-equity template wiring (design 55 §4 / Phase 4) ────────
// The templates are intentionally empty today (§13: basis/holdings stay out of the
// param surface), but the generator loops over cfg.collectibles / cfg.companyEquities
// with them, so a field added to a template later auto-generates params with no
// generator change. These tests pin that wiring: the plumbing (loop, key namespace,
// node shape, decode) is in place ahead of the fields.

test('GEN-10: collectibles/companyEquities are processed; empty templates emit no params, no crash', () => {
  const cfg = {
    collectibles:    [{ stateKey: 'artCollectible', name: 'Art', country: 'US', value: 50000 }],
    companyEquities: [{ stateKey: 'companyEquityAccount', name: 'RSUs', country: 'US', value: 120000 }],
  };
  const out = ScenarioParamGenerator.generate(cfg);
  assert.strictEqual(out.length, 0, 'empty templates ⇒ no params today (wiring present, fields deferred)');
});

test('GEN-11: a populated collectible/equity template field generates the coll./equity. namespace', () => {
  // Exercise _expand directly (the templates ship empty) to prove that the moment a
  // field is added, it emits the right key, node type, and decodes round-trip.
  const [coll] = ScenarioParamGenerator._expand(
    'coll', 'collectible',
    { name: 'Art', value: 50000 }, 'artCollectible',
    [{ field: 'value', label: 'Value', type: 'Number' }],
  );
  assert.strictEqual(coll.key, 'coll.artCollectible.value');
  assert.deepStrictEqual(coll.node, { type: 'collectible', stateKey: 'artCollectible', field: 'value' });
  assert.deepStrictEqual(decodeGeneratedParamKey(coll.key),
    { type: 'collectible', stateKey: 'artCollectible', field: 'value' });

  const [eq] = ScenarioParamGenerator._expand(
    'equity', 'companyEquity',
    { name: 'RSUs', plannedSaleYear: 2035 }, 'companyEquityAccount',
    [{ field: 'plannedSaleYear', label: 'Planned Sale Year', type: 'Number' }],
  );
  assert.strictEqual(eq.key, 'equity.companyEquityAccount.plannedSaleYear');
  assert.deepStrictEqual(eq.node, { type: 'companyEquity', stateKey: 'companyEquityAccount', field: 'plannedSaleYear' });
  assert.deepStrictEqual(decodeGeneratedParamKey(eq.key),
    { type: 'companyEquity', stateKey: 'companyEquityAccount', field: 'plannedSaleYear' });
});
