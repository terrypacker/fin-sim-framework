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
 * currency-schema-coverage.test.mjs
 *
 * Design 10 §Phase 3 (native-code audit). Guards two invariants:
 *   1. StateSchemaRegistry.registerAccount / registerAsset stamp a non-null
 *      currency code, per-account holdings patterns win over the generic
 *      code-less globs, and re-registration is idempotent (no pattern growth).
 *   2. A fully compiled IntlRetirementScenario has NO money field that resolves
 *      to a currency ValueType without a code — otherwise the display layer
 *      cannot know the source currency to convert from.
 */

import { test }   from 'node:test';
import assert      from 'node:assert/strict';

import { StateSchemaRegistry } from '../../src/finance/services/state-schema-registry.js';
import { ServiceRegistry }     from '../../src/services/service-registry.js';
import { ScenarioLoader }      from '../../src/scenarios/scenario-loader.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';

// ── Unit: registry stamping ────────────────────────────────────────────────

test('registerAccount: balance + holdings resolve to the account currency', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavingsAccount', { currency: { code: 'USD' }, type: 'savings' });

  assert.equal(reg.resolve('usSavingsAccount.balance').currencyCode, 'USD');
  assert.equal(reg.resolve('usSavingsAccount.loanBalance').currencyCode, 'USD');
  // Per-account holdings pattern must beat the code-less `*.holdings.*` glob.
  assert.equal(reg.resolve('usSavingsAccount.holdings.0.marketValue').currencyCode, 'USD');
  assert.equal(reg.resolve('usSavingsAccount.holdings.3.costBasis').currencyCode, 'USD');
});

test('registerAsset: derives currency from country when descriptor is absent', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAsset('auHouseProperty', { currency: null, country: 'AU' });

  for (const f of ['value', 'costBasis', 'mortgageBalance', 'monthlyMortgage']) {
    const vt = reg.resolve(`auHouseProperty.${f}`);
    assert.equal(vt.kind, 'currency');
    assert.equal(vt.currencyCode, 'AUD', `${f} should be AUD`);
  }
});

test('re-registration is idempotent (pattern list does not grow)', () => {
  const reg = new StateSchemaRegistry();
  const account = { currency: { code: 'AUD' }, type: 'super' };
  reg.registerAccount('superAccount', account);
  const after1 = reg._patterns.length;
  reg.registerAccount('superAccount', account);
  reg.registerAccount('superAccount', account);
  assert.equal(reg._patterns.length, after1, 'holdings patterns must not accumulate on rebuild');
  assert.equal(reg.resolve('superAccount.holdings.0.marketValue').currencyCode, 'AUD');
});

test('registerPerson: wage/SS stamp per-field currency (design 10 §Phase 5)', () => {
  const reg = new StateSchemaRegistry();
  reg.registerPerson({ id: 'p1', wageCurrency: 'AUD', ssCurrency: 'USD' });
  assert.equal(reg.resolve('people.p1.monthlyWage').currencyCode, 'AUD');
  assert.equal(reg.resolve('people.p1.socialSecurityMonthly').currencyCode, 'USD');

  // Defaults from residency / citizenship when no explicit code is present.
  reg.registerPerson({ id: 'p2', residency: 'AUS' });
  assert.equal(reg.resolve('people.p2.monthlyWage').currencyCode, 'AUD');
  reg.registerPerson({ id: 'p3', citizen: ['US'] });
  assert.equal(reg.resolve('people.p3.monthlyWage').currencyCode, 'USD');
});

test('registerCurrencyPaths: free-standing money param stamps its state paths', () => {
  const reg = new StateSchemaRegistry();
  reg.registerCurrencyPaths(['monthlyExpenses', 'expenses.essential', 'expenses.discretionary'], 'AUD');
  for (const p of ['monthlyExpenses', 'expenses.essential', 'expenses.discretionary']) {
    assert.equal(reg.resolve(p).currencyCode, 'AUD', `${p} should be AUD`);
  }
});

test('currency override re-stamps account/asset paths to the new code', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavingsAccount', { currency: { code: 'USD' }, type: 'savings' });
  assert.equal(reg.resolve('usSavingsAccount.balance').currencyCode, 'USD');
  // Re-register with an explicit override (the editor's currency selector path).
  reg.registerAccount('usSavingsAccount', { currency: { code: 'AUD' }, type: 'savings' });
  assert.equal(reg.resolve('usSavingsAccount.balance').currencyCode, 'AUD');
  assert.equal(reg.resolve('usSavingsAccount.holdings.0.marketValue').currencyCode, 'AUD');

  reg.registerAsset('usHouseProperty', { currency: null, country: 'US' });
  assert.equal(reg.resolve('usHouseProperty.value').currencyCode, 'USD');
  reg.registerAsset('usHouseProperty', { currency: { code: 'AUD' }, country: 'US' });
  assert.equal(reg.resolve('usHouseProperty.value').currencyCode, 'AUD');
});

// ── Integration: compiled scenario has no code-less money ───────────────────

function buildIntlRetirementState() {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  registry.scenarioRegistry.loadPrebuilt([{
    cls: IntlRetirementScenario,
    order: 1,
    active: true,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2041, 0, 1)),
  }]);
  const scenario = registry.scenarioService.createActiveScenario();
  scenario.buildSim();
  const cfg = registry.scenarioService.getActive();
  new ScenarioLoader().load(cfg, registry);
  return { state: scenario.sim.state, reg: registry.schemaRegistry };
}

function numericLeaves(obj, path, out) {
  if (obj == null) return out;
  if (typeof obj === 'number') { out.push(path); return out; }
  if (typeof obj !== 'object') return out;
  if (Array.isArray(obj)) { obj.forEach((v, i) => numericLeaves(v, `${path}.${i}`, out)); return out; }
  for (const [k, v] of Object.entries(obj)) numericLeaves(v, path ? `${path}.${k}` : k, out);
  return out;
}

test('compiled IntlRetirementScenario: every currency field has a code', () => {
  const { state, reg } = buildIntlRetirementState();
  const offenders = numericLeaves(state, '', [])
    .filter(p => { const vt = reg.resolve(p); return vt.kind === 'currency' && !vt.currencyCode; });
  assert.deepEqual(offenders, [], `code-less currency paths:\n${offenders.join('\n')}`);
});

test('compiled scenario: representative money paths carry the right code', () => {
  const { reg } = buildIntlRetirementState();
  const expect = {
    'usSavingsAccount.balance':            'USD',
    'superAccount.balance':                'AUD',
    'usHouseProperty.value':               'USD',
    'auHouseProperty.value':               'AUD',
    'collectibleAccount.value':            'USD',
    'iraAccount.holdings.0.marketValue':   'USD',
    'auStockAccount.holdings.0.costBasis': 'AUD',
    'people.primary.monthlyWage':          'USD',
    'auPersonOrdinaryIncomeYTD.primary':   'AUD',
  };
  for (const [path, code] of Object.entries(expect)) {
    const vt = reg.resolve(path);
    assert.equal(vt.kind, 'currency', `${path} should be currency`);
    assert.equal(vt.currencyCode, code, `${path} should be ${code}`);
  }
});
