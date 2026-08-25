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
 * scenario-service.test.mjs
 *
 * Tests for ScenarioService: getParams, getInitialState, createScenario,
 * newScenario, and helper methods.
 *
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';
import { jest }            from '@jest/globals';
import { ScenarioRegistry } from '../../src/scenarios/scenario-registry.js';
import { Graph } from '../../src/graph/graph.js';
import { ScenarioService }  from '../../src/services/scenario-service.js';
import { ScenarioStorage }  from '../../src/scenarios/scenario-storage.js';
import {ServiceRegistry} from "../../src/services/service-registry.js";
import {
  IntlRetirementScenario,
  INTL_RETIREMENT_DEFAULTS,
} from "../../src/scenarios/intl-retirement-scenario.js";
import {ScenarioLoader} from "../../src/scenarios/scenario-loader.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePrebuilt(id, order = 1) {
  return {
    cls: {
      scenarioId:         () => id,
      scenarioName:       () => `Label ${id}`,
      getParamSchema:     () => [],
      buildDefaultConfig: () => null,
      instantiate:        jest.fn((_p, _s, _e) => ({ id, buildSim: jest.fn() })),
    },
    order,
    active: false,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2041, 0, 1)),
  };
}

function setStorageData(data) {
  localStorage.setItem(ScenarioStorage.STORAGE_KEY, JSON.stringify(data));
}

function makeStack({ prebuiltScenarios = [] } = {}) {
  const registry = new ScenarioRegistry(new ScenarioStorage(), new Graph());
  registry.loadPrebuilt(prebuiltScenarios);
  return { registry, service: new ScenarioService({}, registry) };
}

beforeEach(() => {
  localStorage.clear();
  if (typeof global.structuredClone !== 'function') {
    global.structuredClone = (obj) => JSON.parse(JSON.stringify(obj));
    // Note: JSON.parse/stringify is a basic fallback.
    // For full support (Dates, Sets, etc.), use a real polyfill like 'core-js'.
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// getParams()
// ═════════════════════════════════════════════════════════════════════════════

test('getParams: returns [] when prebuilt with no schema is active', () => {
  const { service } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const active = service.getActive();
  // Registry now eagerly derives a typed array from getParamSchema(); no-schema prebuilt → [].
  assert.deepStrictEqual(active.params, []);
});

test('getParams: returns mapped params for user scenario', () => {
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{ name: 'S', params: [{ name: 'drift', type: 'Number', value: 0.05 }] }],
  });
  const { service } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const active = service.getActive();
  assert.deepStrictEqual(active.params, [{ name: 'drift', type: 'Number', value: 0.05 }]);
});

test('getParams: returns [] for user scenario with no params', () => {
  setStorageData({ lastUsed: 'u:0', scenarios: [{ name: 'S', params: [] }] });
  const { service } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const active = service.getActive();
  assert.deepStrictEqual(active.params, []);
});

// ═════════════════════════════════════════════════════════════════════════════
// getInitialState()
// ═════════════════════════════════════════════════════════════════════════════

test('getInitialState: returns {} when prebuilt is active', () => {
  const { service } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const active = service.getActive();
  assert.deepStrictEqual(active.initialState, {});
});

test('getInitialState: returns initialState for user scenario', () => {
  const state = { metrics: { amount: 99 } };
  setStorageData({ lastUsed: 'u:0', scenarios: [{ name: 'S', initialState: state }] });
  const { service } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const active = service.getActive();
  assert.deepStrictEqual(active.initialState, state);
});

// ═════════════════════════════════════════════════════════════════════════════
// createActiveScenario()
// ═════════════════════════════════════════════════════════════════════════════

test('createActiveScenario: calls scenarioClass.instantiate when prebuilt is active', () => {
  const pb = makePrebuilt('alpha');
  const { service } = makeStack({ prebuiltScenarios: [pb] });
  service.createActiveScenario();
  expect(pb.cls.instantiate).toHaveBeenCalledWith({}, new Date(pb.simStart), new Date(pb.simEnd));
});

test('createActiveScenario: uses scenarioId to find matching prebuilt scenarioClass', () => {
  const pbA = makePrebuilt('alpha', 1);
  const pbB = makePrebuilt('beta',  2);
  const expectedStart = '2025-01-01';
  const expectedEnd   = '2026-01-01';
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{
      name: 'S', scenarioId: 'p:beta', params: [], initialState: {},
      simStart: expectedStart, simEnd: expectedEnd,
    }],
  });
  const { service } = makeStack({ prebuiltScenarios: [pbA, pbB] });
  service.createActiveScenario();
  expect(pbA.cls.instantiate).not.toHaveBeenCalled();
  expect(pbB.cls.instantiate).toHaveBeenCalledWith({}, new Date(expectedStart), new Date(expectedEnd));
});

test('createActiveScenario: falls back to first prebuilt for user scenario without scenarioId match', () => {
  const pbA = makePrebuilt('alpha', 1);
  const pbB = makePrebuilt('beta',  2);
  const expectedStart = '2025-01-01';
  const expectedEnd   = '2026-01-01';
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{ name: 'S', params: [], initialState: {}, simStart: expectedStart, simEnd: expectedEnd }],
  });
  const { service } = makeStack({ prebuiltScenarios: [pbA, pbB] });
  service.createActiveScenario();
  // First prebuilt by order (pbA) is the fallback target.
  expect(pbA.cls.instantiate).toHaveBeenCalledWith(
    {}, new Date(expectedStart), new Date(expectedEnd)
  );
  expect(pbB.cls.instantiate).not.toHaveBeenCalled();
});

test('createActiveScenario: throws when there is no active scenario', () => {
  const registry = new ScenarioRegistry(new ScenarioStorage(), new Graph());
  registry.loadPrebuilt([]);
  const service = new ScenarioService({}, registry);
  assert.throws(() => service.createActiveScenario(), /no active scenario/i);
});

// ═════════════════════════════════════════════════════════════════════════════
// newScenario()
// ═════════════════════════════════════════════════════════════════════════════

test('newScenario: returns new scenario with u:0 id and scenarioId from fromScenario', () => {
  const pb = makePrebuilt('alpha');
  const { registry, service } = makeStack({ prebuiltScenarios: [pb] });
  const fromScenario = registry.getActive();
  const created = service.newScenario(fromScenario);
  assert.strictEqual(created.id, 'u:0');
  assert.strictEqual(created.scenarioId, 'p:alpha');
  assert.strictEqual(registry.getActive().id, 'u:0');
});

test('newScenario: copies simStart and simEnd from fromScenario', () => {
  const pb = makePrebuilt('alpha');
  const { registry, service } = makeStack({ prebuiltScenarios: [pb] });
  const fromScenario = registry.getActive();
  const created = service.newScenario(fromScenario);
  assert.strictEqual(created.simStart, fromScenario.simStart);
  assert.strictEqual(created.simEnd,   fromScenario.simEnd);
});

test('newScenario: params is empty array when fromScenario has no getParamSchema', () => {
  const pb = makePrebuilt('alpha');  // no scenarioClass → getParamSchema() returns []
  const { registry, service } = makeStack({ prebuiltScenarios: [pb] });
  const created = service.newScenario(registry.getActive());
  assert.ok(Array.isArray(created.params));
  assert.strictEqual(created.params.length, 0);
});

test('newScenario: pre-populates params from scenarioClass.getParamSchema()', () => {
  const fakeSchema = [
    { key: 'monthlyExpenses', label: 'Monthly Expenses', type: 'Number', group: 'Expenses', defaultValue: 6000 },
    { key: 'retirementDate',  label: 'Retirement Date',  type: 'Date',   group: 'People',   defaultValue: '2040-01-01' },
    { key: 'reinvest',        label: 'Reinvest',         type: 'Boolean', group: 'People',  defaultValue: false },
  ];
  const pb = {
    cls: {
      scenarioId:         () => 'test',
      scenarioName:       () => 'Test',
      getParamSchema:     () => fakeSchema,
      buildDefaultConfig: () => null,
      instantiate:        jest.fn(),
    },
    order: 1, active: false,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2041, 0, 1)),
  };
  const { registry, service } = makeStack({ prebuiltScenarios: [pb] });
  const created = service.newScenario(registry.getActive());
  assert.strictEqual(created.params.length, 3);
  assert.deepStrictEqual(created.params[0], { name: 'monthlyExpenses', label: 'Monthly Expenses', type: 'Number', group: 'Expenses', value: 6000 });
  assert.deepStrictEqual(created.params[1], { name: 'retirementDate',  label: 'Retirement Date',  type: 'Date',   group: 'People',  value: '2040-01-01' });
  assert.deepStrictEqual(created.params[2], { name: 'reinvest',        label: 'Reinvest',         type: 'Boolean', group: 'People', value: false });
});

// ═════════════════════════════════════════════════════════════════════════════
// newBlankScenario()
// ═════════════════════════════════════════════════════════════════════════════

test('newBlankScenario: returns new active u:0 scenario bound to BlankScenario', () => {
  const pb = makePrebuilt('alpha');
  const { registry, service } = makeStack({ prebuiltScenarios: [pb] });
  const created = service.newBlankScenario(registry.getActive());
  assert.strictEqual(created.id, 'u:0');
  // Bound to the no-op BlankScenario class, NOT the source scenario's class.
  assert.strictEqual(created.scenarioId, 'blank');
  assert.strictEqual(created.scenarioClass?.scenarioId?.(), 'blank');
  assert.strictEqual(created.prebuilt, false);
  assert.strictEqual(registry.getActive().id, 'u:0');
});

test('newBlankScenario: copies simStart and simEnd from fromScenario', () => {
  const pb = makePrebuilt('alpha');
  const { registry, service } = makeStack({ prebuiltScenarios: [pb] });
  const fromScenario = registry.getActive();
  const created = service.newBlankScenario(fromScenario);
  assert.strictEqual(created.simStart, fromScenario.simStart);
  assert.strictEqual(created.simEnd,   fromScenario.simEnd);
});

test('newBlankScenario: all config collections are empty (blank canvas)', () => {
  const { registry } = buildAndCompilePrebuilt();
  const active  = registry.scenarioRegistry.getActive();
  const created = registry.scenarioService.newBlankScenario(active);

  // Even when copied from a fully-compiled prebuilt, the blank scenario keeps
  // no domain data, params, toolsets, or graph snapshot.
  for (const key of ['params', 'events', 'handlers', 'actions', 'reducers',
                     'toolsets', 'persons', 'accounts', 'realProperties', 'collectibles']) {
    assert.ok(Array.isArray(created[key]), `${key} should be an array`);
    assert.strictEqual(created[key].length, 0, `${key} should be empty`);
  }
  assert.deepStrictEqual(created.initialState, {});
});

// ── Shared setup for full-copy tests ─────────────────────────────────────────

function buildAndCompilePrebuilt() {
  ServiceRegistry.resetAll();
  const PREBUILT_SCENARIOS = [
    {
      cls:      IntlRetirementScenario,
      order:    1,
      active:   true,
      simStart: new Date(Date.UTC(2026, 0, 1)),
      simEnd:   new Date(Date.UTC(2041, 0, 1)),
    },
  ];
  const registry = ServiceRegistry.getInstance();
  registry.scenarioRegistry.loadPrebuilt(PREBUILT_SCENARIOS);

  const activeScenario = registry.scenarioService.createActiveScenario();
  activeScenario.buildSim();

  const activeConfig = registry.scenarioService.getActive();
  const ScenarioCls = activeScenario.constructor;
  const declaredToolsets = ScenarioCls.getToolsets?.() ?? [];
  if (declaredToolsets.length > 0 && !activeConfig?.toolsets?.length) {
    const defaultCfg = ScenarioCls.buildDefaultConfig(
      activeScenario.params, activeScenario.simStart, activeScenario.simEnd
    );
    if (defaultCfg && activeConfig) Object.assign(activeConfig, defaultCfg);
  }
  new ScenarioLoader().load(activeConfig, registry);

  return { registry, activeScenario };
}

test('newScenario: full copy is made', () => {
  const { registry } = buildAndCompilePrebuilt();

  const active  = registry.scenarioRegistry.getActive();
  const created = registry.scenarioService.newScenario(active);

  // ── Identity fields ───────────────────────────────────────────────────────
  assert.strictEqual(created.id,         'u:0');
  assert.strictEqual(created.order,       100);
  assert.strictEqual(created.prebuilt,    false);
  assert.strictEqual(created.scenarioId,  active.id);

  // simStart / simEnd are the same Date reference (not cloned)
  assert.strictEqual(created.simStart, active.simStart);
  assert.strictEqual(created.simEnd,   active.simEnd);

  // ── Structural counts ─────────────────────────────────────────────────────
  assert.strictEqual(created.params.length,         active.params.length);
  assert.strictEqual(created.events.length,          active.events.length);
  assert.strictEqual(created.handlers.length,        active.handlers.length);
  assert.strictEqual(created.actions.length,         active.actions.length);
  assert.strictEqual(created.reducers.length,        active.reducers.length);
  assert.strictEqual(created.toolsets.length,        active.toolsets.length);
  assert.strictEqual(created.persons.length,         active.persons.length);
  assert.strictEqual(created.accounts.length,        active.accounts.length);
  assert.strictEqual(created.realProperties.length,  active.realProperties.length);
  assert.strictEqual(created.collectibles.length,    active.collectibles.length);

  // ── copy is independent (structuredClone) ─────────────────────────────────
  assert.notStrictEqual(created.params,         active.params);
  assert.notStrictEqual(created.events,          active.events);
  assert.notStrictEqual(created.handlers,        active.handlers);
  assert.notStrictEqual(created.reducers,        active.reducers);
  assert.notStrictEqual(created.persons,         active.persons);
  assert.notStrictEqual(created.accounts,        active.accounts);
  assert.notStrictEqual(created.initialState,    active.initialState);

  // ── Deep-equal content ────────────────────────────────────────────────────
  assert.deepStrictEqual(created.params,          active.params);
  assert.deepStrictEqual(created.events,           active.events);
  assert.deepStrictEqual(created.handlers,         active.handlers);
  assert.deepStrictEqual(created.actions,          active.actions);
  assert.deepStrictEqual(created.reducers,         active.reducers);
  assert.deepStrictEqual(created.toolsets,         active.toolsets);
  assert.deepStrictEqual(created.persons,          active.persons);
  assert.deepStrictEqual(created.accounts,         active.accounts);
  assert.deepStrictEqual(created.realProperties,   active.realProperties);
  assert.deepStrictEqual(created.collectibles,     active.collectibles);
  // initialState may contain Date objects (e.g. in people map) that structuredClone
  // converts to strings in jsdom. Normalize both sides via JSON round-trip so the
  // comparison tests data equality, not object identity or Date/string type equality.
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(created.initialState)),
    JSON.parse(JSON.stringify(active.initialState))
  );
});

test('newScenario: active config has correct content after compile', () => {
  const { registry } = buildAndCompilePrebuilt();
  const active = registry.scenarioRegistry.getActive();
  const D = INTL_RETIREMENT_DEFAULTS;

  // ── Params: typed schema array populated from IntlRetirementScenario + toolsets ──
  // active.params is the merged scenario+toolset schema, so every scenario key
  // must appear and at least one toolset-only key (e.g. monthlyExpenses from
  // US_RETIREMENT) must too.
  assert.ok(Array.isArray(active.params), 'params should be an array after compile');
  const paramNames = new Set(active.params.map(p => p.name));
  for (const s of IntlRetirementScenario.getParamSchema()) {
    assert.ok(paramNames.has(s.key), `scenario-level param ${s.key} should be in active.params`);
  }

  const expensesParam = active.params.find(p => p.name === 'monthlyExpenses');
  assert.ok(expensesParam, 'monthlyExpenses (toolset-owned) param should exist in active.params');
  // monthlyExpenses is a Money param (design 10 §Phase 5) — numeric value + currency.
  assert.strictEqual(expensesParam.type,     'Money');
  assert.strictEqual(expensesParam.value,    D.monthlyExpenses);
  assert.strictEqual(expensesParam.currency, 'USD');

  // Per-record params are now generated from the records (design 55), keyed
  // acct.<stateKey>.<field> / person.<id>.<field>. balance is NOT among them for a
  // holdings-bearing account (it derives from Σ holdings, §13); contributionBasis is
  // the generated retirement scalar.
  const rothParam = active.params.find(p => p.name === 'acct.rothAccount.contributionBasis');
  assert.ok(rothParam,                                  'acct.rothAccount.contributionBasis param should exist');
  assert.strictEqual(rothParam.value, D.rothBasis);

  const retirementDateParam = active.params.find(p => p.name === 'person.primary.retirementDate');
  assert.ok(retirementDateParam,                        'person.primary.retirementDate param should exist');
  assert.strictEqual(retirementDateParam.type, 'Date');

  // ── Persons ───────────────────────────────────────────────────────────────
  assert.strictEqual(active.persons.length, 2);
  const primary = active.persons.find(p => p.id === 'primary');
  assert.ok(primary,                                    'primary person should exist');
  assert.strictEqual(primary.name,        'Primary');
  assert.strictEqual(primary.monthlyWage, D.primaryMonthlyWage);

  const spouse = active.persons.find(p => p.id === 'spouse');
  assert.ok(spouse,                                     'spouse person should exist');
  assert.strictEqual(spouse.name,        'Spouse');
  assert.strictEqual(spouse.monthlyWage, D.spouseMonthlyWage);

  // ── Accounts: key balances ────────────────────────────────────────────────
  const usSavings = active.accounts.find(a => a.stateKey === 'usSavingsAccount');
  assert.ok(usSavings,                                  'usSavingsAccount should exist');
  assert.strictEqual(usSavings.balance, D.initialUsSavings);

  const roth = active.accounts.find(a => a.stateKey === 'rothAccount');
  assert.ok(roth,                                       'rothAccount should exist');
  assert.strictEqual(roth.balance, D.rothBalance);

  const ira = active.accounts.find(a => a.stateKey === 'iraAccount');
  assert.ok(ira,                                        'iraAccount should exist');
  assert.strictEqual(ira.balance, D.iraBalance);

  const k401 = active.accounts.find(a => a.stateKey === 'k401Account');
  assert.ok(k401,                                       'k401Account should exist');
  assert.strictEqual(k401.balance, D.k401Balance);

  const superAcc = active.accounts.find(a => a.stateKey === 'superAccount');
  assert.ok(superAcc,                                   'superAccount should exist');
  assert.strictEqual(superAcc.balance, D.superBalance);

  // ── Real properties ───────────────────────────────────────────────────────
  assert.strictEqual(active.realProperties.length, 2);
  const usHouse = active.realProperties.find(p => p.stateKey === 'usHouseProperty');
  assert.ok(usHouse,                                    'US house should exist');
  assert.strictEqual(usHouse.country, 'US');

  const auHouse = active.realProperties.find(p => p.stateKey === 'auHouseProperty');
  assert.ok(auHouse,                                    'AU house should exist');
  assert.strictEqual(auHouse.country, 'AU');

  // ── Collectibles ──────────────────────────────────────────────────────────
  assert.strictEqual(active.collectibles.length, 1);
  assert.strictEqual(active.collectibles[0].name, 'Gold');

  // ── Events: populated from toolset compile ────────────────────────────────
  assert.ok(active.events.length > 0,               'events should be populated after compile');
  assert.ok(active.events.every(e => e.__type && e.type && e.id),
    'every event should have __type, type, and id');

  // ── Handlers: populated from toolset compile ──────────────────────────────
  assert.ok(active.handlers.length > 0,             'handlers should be populated after compile');
  assert.ok(active.handlers.every(h => h.__type && h.id),
    'every handler should have __type and id');
  assert.ok(active.handlers.some(h => h.__type === 'MonthlyExpensesHandler'),
    'MonthlyExpensesHandler should be present');
  assert.ok(active.handlers.some(h => h.__type === 'UsPeriodAdvanceHandler' || h.__type === 'AuPeriodAdvanceHandler'),
    'PeriodAdvanceHandler should be present');
  // Design 95 §P0: the compile now emits PayrollHandler, which superseded
  // PayrollHandler as the stage-INCOME wage handler.
  assert.ok(active.handlers.some(h => h.__type === 'PayrollHandler'),
    'PayrollHandler should be present');

  // ── Reducers: populated from toolset compile ──────────────────────────────
  assert.ok(active.reducers.length > 0,             'reducers should be populated after compile');
  assert.ok(active.reducers.every(r => r.__type && r.id),
    'every reducer should have __type and id');
  assert.ok(active.reducers.some(r => r.__type === 'DynamicTaxReducer'),
    'DynamicTaxReducer should be present');
  assert.ok(active.reducers.some(r => r.__type === 'ExpenseDebitReducer'),
    'ExpenseDebitReducer should be present');

  // ── Initial state: key account balances match defaults ────────────────────
  const st = active.initialState;
  assert.strictEqual(st.usSavingsAccount.balance,  D.initialUsSavings);
  assert.strictEqual(st.rothAccount.balance,        D.rothBalance);
  assert.strictEqual(st.iraAccount.balance,         D.iraBalance);
  assert.strictEqual(st.k401Account.balance,        D.k401Balance);
  assert.strictEqual(st.superAccount.balance,       D.superBalance);
  assert.strictEqual(st.auSavingsAccount.balance,   D.auSavingsBalance);
  assert.strictEqual(st.monthlyExpenses,            D.monthlyExpenses);
  assert.strictEqual(st.people.primary.monthlyWage, D.primaryMonthlyWage);
  assert.strictEqual(st.people.spouse.monthlyWage,  D.spouseMonthlyWage);
});

// ═════════════════════════════════════════════════════════════════════════════
// _getParams() — typed param conversion
// ═════════════════════════════════════════════════════════════════════════════

test('_getParams: converts Number params to flat object', () => {
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{ name: 'S', params: [{ name: 'drift', type: 'Number', value: 0.07 }] }],
  });
  // User scenario has no scenarioId match → falls back to first prebuilt's factory,
  // which we observe to see what params it received.
  const pb = makePrebuilt('alpha');
  const { service } = makeStack({ prebuiltScenarios: [pb] });
  service.createActiveScenario();
  const callArgs = pb.cls.instantiate.mock.calls[0][0];
  assert.strictEqual(callArgs.drift, 0.07);
});

test('_getParams: converts Date params to Date objects', () => {
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{
      name: 'S', scenarioId: 'p:alpha',
      params: [{ name: 'primaryRetirementDate', type: 'Date', value: '2040-01-01' }],
    }],
  });
  const pb = makePrebuilt('alpha');
  const { service } = makeStack({ prebuiltScenarios: [pb] });
  service.createActiveScenario();
  const callArgs = pb.cls.instantiate.mock.calls[0][0];
  assert.ok(callArgs.primaryRetirementDate instanceof Date, 'Date param should be converted to Date');
  assert.strictEqual(callArgs.primaryRetirementDate.toISOString().slice(0, 10), '2040-01-01');
});

test('_getParams: Boolean params remain as boolean values', () => {
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{
      name: 'S', scenarioId: 'p:alpha',
      params: [{ name: 'reinvest', type: 'Boolean', value: true }],
    }],
  });
  const pb = makePrebuilt('alpha');
  const { service } = makeStack({ prebuiltScenarios: [pb] });
  service.createActiveScenario();
  const callArgs = pb.cls.instantiate.mock.calls[0][0];
  assert.strictEqual(callArgs.reinvest, true);
});

test('_getParams: empty Date value does not produce an Invalid Date', () => {
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{
      name: 'S', scenarioId: 'p:alpha',
      params: [{ name: 'retirementDate', type: 'Date', value: '' }],
    }],
  });
  const pb = makePrebuilt('alpha');
  const { service } = makeStack({ prebuiltScenarios: [pb] });
  service.createActiveScenario();
  const callArgs = pb.cls.instantiate.mock.calls[0][0];
  // Empty date value should pass through as empty string (falsy guard in _getParams)
  assert.strictEqual(callArgs.retirementDate, '');
});

// ═════════════════════════════════════════════════════════════════════════════
// resetParamsFromSchema()
// ═════════════════════════════════════════════════════════════════════════════

function makePrebuiltWithSchema(id, schema) {
  return {
    cls: {
      scenarioId:         () => id,
      scenarioName:       () => `Label ${id}`,
      getParamSchema:     () => schema,
      buildDefaultConfig: () => null,
      instantiate:        jest.fn(),
    },
    order: 1, active: false,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2041, 0, 1)),
  };
}

test('resetParamsFromSchema: resets each param value to the schema default', () => {
  const schema = [
    { key: 'drift', label: 'Drift', type: 'Number', group: null, defaultValue: 0.05 },
    { key: 'years', label: 'Years', type: 'Number', group: null, defaultValue: 15 },
  ];
  const pb = makePrebuiltWithSchema('alpha', schema);
  const { service, registry } = makeStack({ prebuiltScenarios: [pb] });
  const active = registry.getActive();

  // Simulate user editing params in the UI (direct mutation, as the view does)
  active.params[0].value = 0.99;
  active.params[1].value = 99;

  service.resetParamsFromSchema(active);

  assert.strictEqual(active.params[0].value, 0.05);
  assert.strictEqual(active.params[1].value, 15);
});

test('resetParamsFromSchema: leaves user-added params (not in schema) untouched', () => {
  const schema = [
    { key: 'drift', label: 'Drift', type: 'Number', group: null, defaultValue: 0.05 },
  ];
  const pb = makePrebuiltWithSchema('alpha', schema);
  const { service, registry } = makeStack({ prebuiltScenarios: [pb] });
  const active = registry.getActive();

  // Add a user-defined param not in the schema
  active.params.push({ name: 'custom', type: 'Number', value: 42 });
  active.params[0].value = 0.99;

  service.resetParamsFromSchema(active);

  // Schema param reset, user-added param unchanged
  assert.strictEqual(active.params[0].value, 0.05);
  assert.strictEqual(active.params[1].value, 42);
});

test('resetParamsFromSchema: is a no-op when scenarioClass has no schema', () => {
  const { service } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const active = service.getActive();
  // Should not throw; params stays []
  service.resetParamsFromSchema(active);
  assert.deepStrictEqual(active.params, []);
});

test('resetParamsFromSchema: is a no-op when scenario has no scenarioClass', () => {
  const scenario = { params: [{ name: 'x', type: 'Number', value: 7 }] };
  const { service } = makeStack();
  service.resetParamsFromSchema(scenario);
  // No crash, value unchanged
  assert.strictEqual(scenario.params[0].value, 7);
});
