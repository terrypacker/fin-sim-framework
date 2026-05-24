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
import { ScenarioService }  from '../../src/services/scenario-service.js';
import { ScenarioStorage }  from '../../src/scenarios/scenario-storage.js';
import { PrebuiltScenario } from '../../src/scenarios/prebuilt-scenario.js';
import {ServiceRegistry} from "../../src/services/service-registry.js";
import {
  IntlRetirementScenario,
  INTL_RETIREMENT_DEFAULTS,
} from "../../src/scenarios/intl-retirement-scenario.js";
import {BaseApp} from "../../src/apps/base-app.js";
import {ScenarioLoader} from "../../src/scenarios/scenario-loader.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePrebuilt(id, order = 1) {
  const factory = jest.fn((_p, _i) => ({ id, buildSim: jest.fn(), loadDefaults: jest.fn() }));
  return new PrebuiltScenario({
    id, label: `Label ${id}`, order,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd: new Date(Date.UTC(2041, 0, 1)),
    factory,
  });
}

function setStorageData(data) {
  localStorage.setItem(ScenarioStorage.STORAGE_KEY, JSON.stringify(data));
}

function makeStack({ prebuiltScenarios = [] } = {}) {
  const registry = new ScenarioRegistry(new ScenarioStorage());
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

test('getParams: returns {} when prebuilt is active', () => {
  const { service } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const active = service.getActive();
  assert.deepStrictEqual(active.params, {});
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

test('createActiveScenario: calls prebuilt factory when prebuilt is active', () => {
  const pb = makePrebuilt('alpha');
  const { service } = makeStack({ prebuiltScenarios: [pb] });
  service.createActiveScenario();
  expect(pb.factory).toHaveBeenCalledWith({}, {}, new Date(pb.simStart), new Date(pb.simEnd));
});

test('createActiveScenario: uses scenarioId to find matching prebuilt factory', () => {
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
  expect(pbA.factory).not.toHaveBeenCalled();
  expect(pbB.factory).toHaveBeenCalledWith({}, {}, new Date(expectedStart), new Date(expectedEnd));
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
  expect(pbA.factory).toHaveBeenCalledWith(
    {}, {}, new Date(expectedStart), new Date(expectedEnd)
  );
  expect(pbB.factory).not.toHaveBeenCalled();
});

test('createActiveScenario: throws when there is no active scenario', () => {
  const registry = new ScenarioRegistry(new ScenarioStorage());
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
  const scenarioClass = { getParamSchema: () => fakeSchema };
  const pb = new PrebuiltScenario({
    id: 'test', label: 'Test', order: 1,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd: new Date(Date.UTC(2041, 0, 1)),
    factory: jest.fn(), scenarioClass,
  });
  const { registry, service } = makeStack({ prebuiltScenarios: [pb] });
  const created = service.newScenario(registry.getActive());
  assert.strictEqual(created.params.length, 3);
  assert.deepStrictEqual(created.params[0], { name: 'monthlyExpenses', label: 'Monthly Expenses', type: 'Number', group: 'Expenses', value: 6000 });
  assert.deepStrictEqual(created.params[1], { name: 'retirementDate',  label: 'Retirement Date',  type: 'Date',   group: 'People',  value: '2040-01-01' });
  assert.deepStrictEqual(created.params[2], { name: 'reinvest',        label: 'Reinvest',         type: 'Boolean', group: 'People', value: false });
});

// ── Shared setup for full-copy tests ─────────────────────────────────────────

function buildAndCompilePrebuilt() {
  ServiceRegistry.reset();
  const PREBUILT_SCENARIOS = [
    new PrebuiltScenario({
      id:            'intl-retirement',
      label:         'International Retirement',
      order:         1,
      prebuilt:      true,
      active:        true,
      simStart: new Date(Date.UTC(2026, 0, 1)),
      simEnd:   new Date(Date.UTC(2041, 0, 1)),
      scenarioClass: IntlRetirementScenario,
      factory:  (params, _initialState, simStart, simEnd) => new IntlRetirementScenario({
        context: ServiceRegistry.getInstance().simulationContext,
        params,
        simStart,
        simEnd,
      }),
    }),
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

  // ── Params: typed schema array populated from IntlRetirementScenario ──────
  assert.ok(Array.isArray(active.params), 'params should be an array after compile');
  assert.strictEqual(active.params.length, IntlRetirementScenario.getParamSchema().length);

  const expensesParam = active.params.find(p => p.name === 'monthlyExpenses');
  assert.ok(expensesParam,                              'monthlyExpenses param should exist');
  assert.strictEqual(expensesParam.type,  'Number');
  assert.strictEqual(expensesParam.value, D.monthlyExpenses);

  const rothParam = active.params.find(p => p.name === 'rothBalance');
  assert.ok(rothParam,                                  'rothBalance param should exist');
  assert.strictEqual(rothParam.value, D.rothBalance);

  const retirementDateParam = active.params.find(p => p.name === 'primaryRetirementDate');
  assert.ok(retirementDateParam,                        'primaryRetirementDate param should exist');
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
  assert.strictEqual(usSavings.initialValue, D.initialUsSavings);

  const roth = active.accounts.find(a => a.stateKey === 'rothAccount');
  assert.ok(roth,                                       'rothAccount should exist');
  assert.strictEqual(roth.initialValue, D.rothBalance);

  const ira = active.accounts.find(a => a.stateKey === 'iraAccount');
  assert.ok(ira,                                        'iraAccount should exist');
  assert.strictEqual(ira.initialValue, D.iraBalance);

  const k401 = active.accounts.find(a => a.stateKey === 'k401Account');
  assert.ok(k401,                                       'k401Account should exist');
  assert.strictEqual(k401.initialValue, D.k401Balance);

  const superAcc = active.accounts.find(a => a.stateKey === 'superAccount');
  assert.ok(superAcc,                                   'superAccount should exist');
  assert.strictEqual(superAcc.initialValue, D.superBalance);

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
  assert.ok(active.handlers.some(h => h.__type === 'PeriodAdvanceHandler'),
    'PeriodAdvanceHandler should be present');
  assert.ok(active.handlers.some(h => h.__type === 'MonthlyWagesHandler'),
    'MonthlyWagesHandler should be present');

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
  const callArgs = pb.factory.mock.calls[0][0];
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
  const callArgs = pb.factory.mock.calls[0][0];
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
  const callArgs = pb.factory.mock.calls[0][0];
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
  const callArgs = pb.factory.mock.calls[0][0];
  // Empty date value should pass through as empty string (falsy guard in _getParams)
  assert.strictEqual(callArgs.retirementDate, '');
});
