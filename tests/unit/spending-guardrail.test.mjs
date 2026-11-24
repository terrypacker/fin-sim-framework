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
 * spending-guardrail.test.mjs
 *
 * Tests for design/26 Increment 2 — Guardrail (Guyton-Klinger) strategy.
 *
 *   - GuardrailBaselineApplyReducer: stores initialWithdrawalRate in state.guardrail
 *   - GuardrailAdjustApplyReducer: multiplies discretionary slice
 *   - GuardrailAnnualCheckReducer: cut / raise triggers; no action when in-band
 *   - RetirementDateHandler: emits GUARDRAIL_BASELINE_APPLY with correct rate
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { GuardrailBaselineApplyReducer } from '../../src/finance/spending/strategies/guardrail-baseline-apply-reducer.js';
import { GuardrailAdjustApplyReducer }   from '../../src/finance/spending/strategies/guardrail-adjust-apply-reducer.js';
import { GuardrailAnnualCheckReducer }   from '../../src/finance/spending/strategies/guardrail-annual-check-reducer.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';
import { RetirementDateHandler }         from '../../src/finance/spending/strategies/retirement-date-handler.js';

const US_ADV = { type: 'US_PERIOD_ADVANCE' };

function baseExpensesState({ essential = 7_000, discretionary = 3_000 } = {}) {
  return {
    expenses:       { essential, discretionary },
    monthlyExpenses: essential + discretionary,
    activeRegimes:  [],
  };
}

function withGuardrail(state, guardrail) {
  return { ...state, guardrail };
}

function withDrawdownAccount(state, { stateKey = 'savings', balance = 1_000_000, currency = 'USD', drawdownPriority = 1 } = {}) {
  return { ...state, [stateKey]: { stateKey, balance, currency, drawdownPriority } };
}

// ── GuardrailBaselineApplyReducer ─────────────────────────────────────────────

const baselineReducer = new GuardrailBaselineApplyReducer();

test('SPEND-GR-1: GuardrailBaselineApplyReducer stores initialWithdrawalRate', () => {
  const s    = { guardrail: null };
  const next = baselineReducer.reduce(s, {
    type: 'GUARDRAIL_BASELINE_APPLY',
    initialWithdrawalRate: 0.04,
    portfolioValue:        1_200_000,
    annualSpending:        48_000,
    date:                  new Date('2026-01-01'),
  });
  assert.ok(Math.abs(next.guardrail.initialWithdrawalRate - 0.04) < 1e-10);
  assert.ok(Math.abs(next.guardrail.portfolioValue - 1_200_000) < 0.01);
  assert.strictEqual(next.guardrail.currentAdjustmentMultiplier, 1.0);
  assert.strictEqual(next.guardrail.lastAdjustmentDate, null);
});

test('SPEND-GR-2: GuardrailBaselineApplyReducer overwrites any previous guardrail on re-fire', () => {
  const s = withGuardrail({}, { initialWithdrawalRate: 0.05, currentAdjustmentMultiplier: 0.9 });
  const next = baselineReducer.reduce(s, {
    type: 'GUARDRAIL_BASELINE_APPLY',
    initialWithdrawalRate: 0.04,
    portfolioValue: 1_000_000,
    annualSpending: 40_000,
    date: new Date(),
  });
  assert.ok(Math.abs(next.guardrail.initialWithdrawalRate - 0.04) < 1e-10);
  assert.strictEqual(next.guardrail.currentAdjustmentMultiplier, 1.0);
});

// ── GuardrailAdjustApplyReducer ───────────────────────────────────────────────

const adjustReducer = new GuardrailAdjustApplyReducer();

test('SPEND-GR-3: GuardrailAdjustApplyReducer multiplies discretionary by multiplier', () => {
  const s    = baseExpensesState({ essential: 7_000, discretionary: 3_000 });
  const next = adjustReducer.reduce(
    withGuardrail(s, { currentAdjustmentMultiplier: 1.0 }),
    { type: 'GUARDRAIL_ADJUST_APPLY', multiplier: 0.90, cause: 'cut' },
  );
  assert.ok(Math.abs(next.expenses.discretionary - 2_700) < 0.01);
  assert.ok(Math.abs(next.expenses.essential - 7_000) < 0.01);
});

test('SPEND-GR-4: GuardrailAdjustApplyReducer syncs monthlyExpenses', () => {
  const s    = baseExpensesState({ essential: 7_000, discretionary: 3_000 });
  const next = adjustReducer.reduce(
    withGuardrail(s, { currentAdjustmentMultiplier: 1.0 }),
    { type: 'GUARDRAIL_ADJUST_APPLY', multiplier: 0.90, cause: 'cut' },
  );
  assert.ok(Math.abs(next.monthlyExpenses - (7_000 + 2_700)) < 0.01);
});

test('SPEND-GR-5: GuardrailAdjustApplyReducer compounds currentAdjustmentMultiplier', () => {
  const s = baseExpensesState();
  const s2 = adjustReducer.reduce(
    withGuardrail(s, { currentAdjustmentMultiplier: 1.0 }),
    { type: 'GUARDRAIL_ADJUST_APPLY', multiplier: 0.90, cause: 'cut' },
  );
  // Second cut
  const s3 = adjustReducer.reduce(s2, { type: 'GUARDRAIL_ADJUST_APPLY', multiplier: 0.90, cause: 'cut' });
  assert.ok(Math.abs(s3.guardrail.currentAdjustmentMultiplier - 0.81) < 1e-10);
});

test('SPEND-GR-6: GuardrailAdjustApplyReducer no-ops when state.expenses absent', () => {
  const s = withGuardrail({ monthlyExpenses: 10_000 }, { currentAdjustmentMultiplier: 1.0 });
  const next = adjustReducer.reduce(s, { type: 'GUARDRAIL_ADJUST_APPLY', multiplier: 0.90, cause: 'cut' });
  assert.strictEqual(next.monthlyExpenses, 10_000);
});

// ── GuardrailAnnualCheckReducer ───────────────────────────────────────────────

const checkReducer = new GuardrailAnnualCheckReducer({
  cutThreshold: 0.20, raiseThreshold: 0.20, cutPct: 0.10, raisePct: 0.10,
});

function stateWithBaseline({ portfolioBalance = 1_000_000, monthly = 10_000, initialRate = 0.12 } = {}) {
  // initialRate = (10_000 * 12) / 1_000_000 = 0.12 by default
  return withGuardrail(
    withDrawdownAccount(baseExpensesState({ essential: 7_000, discretionary: 3_000 }), {
      balance: portfolioBalance, currency: 'USD', drawdownPriority: 1,
    }),
    {
      initialWithdrawalRate:       initialRate,
      currentAdjustmentMultiplier: 1.0,
      lastAdjustmentDate:          null,
    },
  );
}

test('SPEND-GR-7: no action when withdrawal rate is within bands', () => {
  // initialRate = 0.12; portfolio = 1_000_000; annual = 10_000*12=120_000; rate = 0.12 → in band
  const s    = stateWithBaseline({ portfolioBalance: 1_000_000, initialRate: 0.12 });
  const next = checkReducer.reduce(s, US_ADV);
  // next.next should be empty (no GUARDRAIL_ADJUST_APPLY emitted)
  assert.strictEqual((next.next ?? []).length, 0);
});

test('SPEND-GR-8: GUARDRAIL_ADJUST_APPLY (cut) emitted when rate is above cut band', () => {
  // Portfolio drops to 800_000: rate = 120_000 / 800_000 = 0.15 > 0.12 * 1.20 = 0.144
  const s    = stateWithBaseline({ portfolioBalance: 800_000, initialRate: 0.12 });
  const next = checkReducer.reduce(s, US_ADV);
  assert.strictEqual((next.next ?? []).length, 1);
  assert.strictEqual(next.next[0].type, 'GUARDRAIL_ADJUST_APPLY');
  assert.strictEqual(next.next[0].cause, 'cut');
  assert.ok(Math.abs(next.next[0].multiplier - 0.90) < 1e-10);
});

test('SPEND-GR-9: GUARDRAIL_ADJUST_APPLY (raise) emitted when rate is below raise band', () => {
  // Portfolio grows to 1_500_000: rate = 120_000 / 1_500_000 = 0.08 < 0.12 * 0.80 = 0.096
  const s    = stateWithBaseline({ portfolioBalance: 1_500_000, initialRate: 0.12 });
  const next = checkReducer.reduce(s, US_ADV);
  assert.strictEqual((next.next ?? []).length, 1);
  assert.strictEqual(next.next[0].type, 'GUARDRAIL_ADJUST_APPLY');
  assert.strictEqual(next.next[0].cause, 'raise');
  assert.ok(Math.abs(next.next[0].multiplier - 1.10) < 1e-10);
});

test('SPEND-GR-10: no action when guardrail baseline not yet captured', () => {
  const s = baseExpensesState();
  withDrawdownAccount(s, { balance: 1_000_000 });
  // No guardrail.initialWithdrawalRate
  const next = checkReducer.reduce(s, US_ADV);
  assert.strictEqual((next.next ?? []).length, 0);
});

test('SPEND-GR-11: no action when no drawdown accounts in state', () => {
  const s = withGuardrail(baseExpensesState(), {
    initialWithdrawalRate: 0.12, currentAdjustmentMultiplier: 1.0,
  });
  // No accounts with drawdownPriority
  const next = checkReducer.reduce(s, US_ADV);
  assert.strictEqual((next.next ?? []).length, 0);
});

// ── RetirementDateHandler ─────────────────────────────────────────────────────

const retHandler = new RetirementDateHandler({ baseCurrency: 'USD' });

test('SPEND-GR-12: RetirementDateHandler emits GUARDRAIL_BASELINE_APPLY with correct rate', () => {
  const state = withDrawdownAccount(
    { monthlyExpenses: 10_000, people: {} },
    { balance: 1_000_000, currency: 'USD', drawdownPriority: 1 },
  );
  const actions = retHandler.call({ state, date: new Date('2030-01-01') });
  assert.strictEqual(actions.length, 1);
  assert.strictEqual(actions[0].type, 'GUARDRAIL_BASELINE_APPLY');
  // annualSpending = 120_000; portfolioValue = 1_000_000; rate = 0.12
  assert.ok(Math.abs(actions[0].initialWithdrawalRate - 0.12) < 1e-10);
  assert.ok(Math.abs(actions[0].portfolioValue - 1_000_000) < 0.01);
});

test('SPEND-GR-13: RetirementDateHandler returns empty array when portfolioValue is 0', () => {
  const state = { monthlyExpenses: 10_000, people: {} };
  // No drawdown accounts → portfolioValue = 0
  const actions = retHandler.call({ state, date: new Date() });
  assert.strictEqual(actions.length, 0);
});

test('SPEND-GR-14: RetirementDateHandler uses state.monthlyExpenses for annualSpending', () => {
  const state = withDrawdownAccount(
    { monthlyExpenses: 8_000 },
    { balance: 800_000, currency: 'USD', drawdownPriority: 1 },
  );
  const actions = retHandler.call({ state, date: new Date() });
  assert.ok(Math.abs(actions[0].annualSpending - 96_000) < 0.01);
  assert.ok(Math.abs(actions[0].initialWithdrawalRate - 0.12) < 1e-10);
});

// ── once a year (both countries' period advances reach the check) ──────────────────────────

test('SPEND-GR-15: a second advance inside the year does not check again', () => {
  // Out of band both times (rate 0.15 > cut band 0.144). The July advance six months after a
  // January check must not cut a second time; the next January must.
  const jan = checkReducer.reduce(stateWithBaseline({ portfolioBalance: 800_000 }), US_ADV, new Date('2030-01-01'));
  assert.strictEqual(jan.next.filter(a => a.type === 'GUARDRAIL_ADJUST_APPLY').length, 1);
  assert.strictEqual(new Date(jan.guardrail.lastCheckDate).toISOString().slice(0, 10), '2030-01-01');
  const { next: _n, ...afterJan } = jan;
  const jul = checkReducer.reduce(afterJan, { type: 'AU_PERIOD_ADVANCE' }, new Date('2030-07-01'));
  assert.strictEqual((jul.next ?? []).filter(a => a.type === 'GUARDRAIL_ADJUST_APPLY').length, 0);
  assert.strictEqual(new Date(jul.guardrail.lastCheckDate).toISOString().slice(0, 10), '2030-01-01');
  const jan2 = checkReducer.reduce(afterJan, US_ADV, new Date('2031-01-01'));
  assert.strictEqual(jan2.next.filter(a => a.type === 'GUARDRAIL_ADJUST_APPLY').length, 1);
});

test('SPEND-GR-16: an in-band check is still stamped, so it counts as the year\'s check', () => {
  const s = checkReducer.reduce(stateWithBaseline({ portfolioBalance: 1_000_000 }), US_ADV, new Date('2030-01-01'));
  assert.strictEqual((s.next ?? []).length, 0);
  assert.strictEqual(new Date(s.guardrail.lastCheckDate).toISOString().slice(0, 10), '2030-01-01');
});

function runGuardrailPlan(toolsets) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = { toolsets, simStart: '2020-03-01', simEnd: '2025-01-01',
    parameters: { monthlyExpenses: 2000, exchangeRateUsdToAud: 1.55, spendingStrategy: ['GUARDRAIL'] },
    persons: [{ __type: 'Person', id: 'primary', name: 'P', birthDate: '1960-01-15', citizen: ['US'],
      lifeExpectancy: 95, monthlyWage: 0, retirementDate: '2019-01-01', socialSecurityMonthly: 0 }],
    accounts: [{ __type: 'SavingsAccount', id: 'us-savings', name: 'US', role: 'us-savings', stateKey: 'usSavingsAccount',
      initialValue: 1e6, ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0, country: 'US',
      currency: { code: 'USD', symbol: '$' }, drawdownPriority: 1 }] };
  if (toolsets.includes('AU_RETIREMENT')) cfg.accounts.push({ __type: 'SavingsAccount', id: 'au-savings', name: 'AU',
    role: 'au-savings', stateKey: 'auSavingsAccount', initialValue: 0, ownershipType: 'sole', ownerId: 'primary',
    minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: '$' } });
  const sc = new BaseScenario({ context: services.simulationContext, simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd) });
  sc.buildSim();
  new ScenarioLoader().load(structuredClone(cfg), services);
  const checks = new Set();
  for (let y = 2020; y <= 2024; y++) for (const m of [0, 6]) {
    const d = new Date(Date.UTC(y, m, 2));
    if (d < new Date(cfg.simStart)) continue;
    sc.sim.stepTo(d);
    const last = sc.sim.state.guardrail?.lastCheckDate;
    if (last) checks.add(new Date(last).toISOString().slice(0, 10));
  }
  return [...checks];
}

test('SPEND-GR-17: a two-country plan checks once a year, like a US-only plan', () => {
  // Both toolsets fire AU_PERIOD_ADVANCE (1 Jul) and US_PERIOD_ADVANCE (1 Jan); before the gate the
  // guardrail checked on both. The first advance after the start is 1 Jul 2020, so it keeps July.
  assert.deepStrictEqual(runGuardrailPlan(['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER']),
    ['2020-07-01', '2021-07-01', '2022-07-01', '2023-07-01', '2024-07-01']);
  assert.deepStrictEqual(runGuardrailPlan(['US_RETIREMENT']),
    ['2021-01-01', '2022-01-01', '2023-01-01', '2024-01-01']);
});
