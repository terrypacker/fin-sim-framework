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
 * spending-amortized.test.mjs — the AMORTIZED spending strategy (spend it down to zero at the
 * plan end, never below the essential slice).
 *
 * AMORT-1  annuity-due factor: r = 0 is n; one year is 1; matches the closed form.
 * AMORT-2  target = portfolio / annuityDue(r, years) / 12; only discretionary moves.
 * AMORT-3  the essential slice is a floor: a small portfolio sets discretionary to 0, not below.
 * AMORT-4  remaining own Social Security is counted at its present value from the claim month.
 * AMORT-5  an AU resident's expense figure is re-based at the anchor: spot/anchor units per USD.
 * AMORT-6  smoothing moves only part of the way from the current spend to the target.
 * AMORT-7  no horizon, a past horizon, or no tick date: state unchanged.
 * AMORT-8  registry wires the params and the sim end as the horizon.
 * AMORT-9  end to end, zero returns and zero inflation: the account runs down to ~0 at the end.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  AmortizedSpendingReducer, annuityDueFactor, socialSecurityPv, usdToExpenseUnits,
} from '../../src/finance/spending/strategies/amortized-spending-reducer.js';
import { SPENDING_STRATEGY_REGISTRY } from '../../src/finance/spending/spending-strategy-registry.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

const DAY = 24 * 3600 * 1000, YEAR = 365.25 * DAY;
const NOW = Date.UTC(2030, 0, 1);
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

function makeState({ usd = 1_200_000, essential = 3000, discretionary = 3000, people = {}, fx = null } = {}) {
  return {
    expenses: { essential, discretionary },
    monthlyExpenses: essential + discretionary,
    people,
    ...(fx ?? {}),
    usBrokerage: { stateKey: 'usBrokerage', balance: usd, currency: 'USD', drawdownPriority: 1 },
  };
}
const reducer = (o = {}) => new AmortizedSpendingReducer({ horizonEnd: NOW + 30 * YEAR, realRate: 0.03, ...o });
const run = (r, s, date = NOW) => r.reduce(s, { type: 'US_PERIOD_ADVANCE' }, new Date(date));
const stateOf = (out) => out;   // newState returns the patched state (plus `next`)

test('AMORT-1: annuity-due factor', () => {
  assert.equal(annuityDueFactor(0, 12), 12);
  close(annuityDueFactor(0.03, 1), 1);
  close(annuityDueFactor(0.03, 30), (1 - 1.03 ** -30) / 0.03 * 1.03);
  assert.equal(annuityDueFactor(0.03, 0), 0);
});

test('AMORT-2: spend = portfolio / annuity due / 12; essential untouched', () => {
  const s = stateOf(run(reducer(), makeState()));
  const target = 1_200_000 / annuityDueFactor(0.03, 30) / 12;
  close(s.monthlyExpenses, target);
  assert.equal(s.expenses.essential, 3000);
  close(s.expenses.discretionary, target - 3000);
  close(s.amortizedSpending.horizonYears, 30);
});

test('AMORT-3: the essential slice is the floor', () => {
  const s = stateOf(run(reducer(), makeState({ usd: 100_000 })));
  assert.equal(s.expenses.discretionary, 0);
  assert.equal(s.monthlyExpenses, 3000);
});

test('AMORT-4: remaining own Social Security counts at present value from the claim month', () => {
  // Born 15 Jan 1970 (not the 1st: SSA attains an age the day before a birthday), FRA 67 (claim month Jan 2037 = 7 years out), PIA 2,000 today.
  const people = { primary: { birthDate: '1970-01-15T00:00:00.000Z', socialSecurityMonthly: 2000, ssClaimAge: 67 } };
  const pv = socialSecurityPv(makeState({ people }), NOW, 30, 0.03);
  const expected = 12 * 2000 * annuityDueFactor(0.03, 23) / 1.03 ** 7;
  close(pv, expected, 1e-3);
  const s = stateOf(run(reducer(), makeState({ people })));
  close(s.amortizedSpending.socialSecurityPv, pv);
  close(s.monthlyExpenses, (1_200_000 + pv) / annuityDueFactor(0.03, 30) / 12);
  // A person with no benefit, or already past the horizon, adds nothing.
  assert.equal(socialSecurityPv(makeState({ people: { p: { birthDate: '1970-01-01', socialSecurityMonthly: 0 } } }), NOW, 30, 0.03), 0);
  assert.equal(socialSecurityPv(makeState({ people }), NOW, 5, 0.03), 0);
});

test('AMORT-5: an AU resident re-bases at the anchor, so a USD buys spot/anchor expense units', () => {
  const fx = { effectiveExchangeRates: { USD_AUD: 1.6 }, baseExchangeRates: { USD_AUD: 1.5 } };
  const au = { primary: { residency: 'AU' } }, us = { primary: { residency: 'US' } };
  close(usdToExpenseUnits(1000, { ...fx, people: au }), 1000 * 1.6 / 1.5);
  assert.equal(usdToExpenseUnits(1000, { ...fx, people: us }), 1000);
  close(usdToExpenseUnits(1000, { ...fx, people: us }, 'AUD'), 1600);
  // Design 122: the rate frozen at the move wins over the authored anchor.
  close(usdToExpenseUnits(1000, { ...fx, expenseRebaseRates: { USD_AUD: 1.4 }, people: au }), 1000 * 1.6 / 1.4);
  // No anchor (single-country plan): no re-basing.
  assert.equal(usdToExpenseUnits(1000, { people: au }), 1000);
});

test('AMORT-6: smoothing moves part of the way to the target', () => {
  const target = 1_200_000 / annuityDueFactor(0.03, 30) / 12;
  const s = stateOf(run(reducer({ smoothing: 0.5 }), makeState()));
  close(s.monthlyExpenses, 0.5 * 6000 + 0.5 * target);
});

test('AMORT-7: no horizon, past horizon, or no date leaves state unchanged', () => {
  const st = makeState();
  for (const r of [new AmortizedSpendingReducer({ horizonEnd: null }), reducer({ horizonEnd: NOW - DAY })]) {
    const s = stateOf(run(r, structuredClone(st)));
    assert.equal(s.monthlyExpenses, 6000);
    assert.equal(s.amortizedSpending, undefined);
  }
  const s = stateOf(reducer().reduce(structuredClone(st), { type: 'US_PERIOD_ADVANCE' }, undefined));
  assert.equal(s.monthlyExpenses, 6000);
});

test('AMORT-8: registry wiring', () => {
  const end = new Date('2060-01-01');
  const [r] = SPENDING_STRATEGY_REGISTRY.AMORTIZED.reducers({ endDate: end,
    parameters: { amortizeRealRate: 0.025, amortizeSmoothing: 0.4, monthlyExpensesCurrency: 'USD' } });
  assert.ok(r instanceof AmortizedSpendingReducer);
  assert.equal(r.horizonEndMs, end.getTime());
  assert.equal(r.realRate, 0.025);
  assert.equal(r.smoothing, 0.4);
  assert.equal(r.expensesCurrency, 'USD');
  const keys = SPENDING_STRATEGY_REGISTRY.AMORTIZED.paramSchema().map(p => p.key);
  assert.deepEqual(keys, ['amortizeRealRate', 'amortizeSmoothing']);
});

// ── end to end ──────────────────────────────────────────────────────────────────────────────
beforeEach(() => ServiceRegistry.resetAll());

function loadScenario(config) {
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context: services.simulationContext, simStart: new Date(config.simStart), simEnd: new Date(config.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(structuredClone(config), services);
  return scenario.sim;
}

test('AMORT-9: zero returns, zero inflation: spending runs the account down to ~0 at the end', () => {
  const sim = loadScenario({
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER'],
    simStart: '2020-01-01', simEnd: '2030-01-01',
    parameters: {
      monthlyExpenses: 2000, discretionarySharePct: 0.5, inflationRate: 0, auInflationRate: 0,
      usSavingsInterestRate: 0, auSavingsInterestRate: 0, exchangeRateUsdToAud: 1.55, intlTransferFeeUsd: 15,
      spendingStrategy: ['AMORTIZED'], amortizeRealRate: 0,
    },
    persons: [{ __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1960-01-01',
      citizen: ['US'], lifeExpectancy: 95, monthlyWage: 0, retirementDate: '2019-01-01', socialSecurityMonthly: 0 }],
    accounts: [
      { __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings', role: 'us-savings', stateKey: 'usSavingsAccount',
        initialValue: 600_000, ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0, country: 'US',
        currency: { code: 'USD', symbol: '$' }, drawdownPriority: 1 },
      { __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings', role: 'au-savings', stateKey: 'auSavingsAccount',
        initialValue: 0, ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0, country: 'AU',
        currency: { code: 'AUD', symbol: '$' } },
    ],
  });
  sim.stepTo(new Date('2021-02-01'));
  const a = sim.state.amortizedSpending;
  assert.ok(a, 'the rule ran');
  close(a.targetMonthly, a.portfolio / a.horizonYears / 12, 1e-9);
  assert.ok(sim.state.monthlyExpenses > 1000, 'spends above the essential floor');
  sim.stepTo(new Date('2029-12-31'));
  const left = sim.state.usSavingsAccount.balance;
  assert.ok(left >= 0 && left < 0.03 * 600_000, `left at the end: ${left}`);
  assert.ok(!sim.state.scenarioFailed, 'never ran out');
});
