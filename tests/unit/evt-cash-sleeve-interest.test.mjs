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
 * evt-cash-sleeve-interest.test.mjs — money-market yield on the CASH sleeve of an
 * equity-served account (brokerage / retirement / super), design 60.
 *
 * These accounts run off the equity-growth earnings handler, which (post the
 * design-59 growth follow-up) credits CASH no return of its own. This monthly
 * stream pays the cash sleeve the account's country savings rate (reused from
 * effectiveInterestRates), compounding via reinvestment, taxed per the account's
 * wrapper: US ordinary income (brokerage), AU ordinary income (au-stock), or
 * tax-deferred (401k / IRA / Roth / super).
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { computeHoldingsCashInterest } from '../../src/finance/holdings/holdings-earnings.js';
import { CashSleeveInterestApplyReducer } from '../../src/finance/reducers/cash-sleeve-interest-apply-reducer.js';

import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { BaseScenario }           from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';

// ── Unit: the cash-interest compute helper ───────────────────────────────────

test('EVT-CASH-INT-1: computeHoldingsCashInterest pays only CASH sleeves, monthly, and reinvests', () => {
  const state = {
    effectiveInterestRates: { SAVINGS_US: 0.03 },
    acct: { holdings: [
      { id: 'c1', allocation: 'CASH',   marketValue: 10000, rateKey: 'SAVINGS_US' },  // 10000 × 0.03/12 = 25
      { id: 'e1', allocation: 'EQUITY', marketValue: 50000, rateKey: 'EQUITY_US' }, // ignored
      { id: 'b1', allocation: 'BOND',   marketValue: 20000, couponRate: 0.04 },     // ignored
      { id: 'g1', allocation: 'GOLD',   marketValue: 10000, rateKey: 'GOLD' },       // ignored
    ] },
  };

  const r = computeHoldingsCashInterest({ state, stateKey: 'acct', rateKey: 'SAVINGS_US', fallbackRate: 0.03 });

  assert.strictEqual(r.amount, 25, 'only the CASH sleeve earns, at rate ÷ 12');
  assert.strictEqual(r.holdingActions.length, 1, 'one reinvest action, into the cash sleeve');
  assert.strictEqual(r.holdingActions[0].holdingId, 'c1');
  assert.strictEqual(r.holdingActions[0].marketValueDelta, 25);
  assert.strictEqual(r.holdingActions[0].costBasisDelta, 0, 'reinvested interest does not raise basis');
});

test('EVT-CASH-INT-2: rate resolution — per-account key wins, then shared key, then fallback', () => {
  const mk = (rates) => ({ effectiveInterestRates: rates, acct: { holdings: [
    { id: 'c1', allocation: 'CASH', marketValue: 12000, rateKey: 'SAVINGS_US' },
  ] } });

  // per-account override `SAVINGS_US::acct` = 6% wins over the shared 3%
  const perAcct = computeHoldingsCashInterest({ state: mk({ 'SAVINGS_US::acct': 0.06, SAVINGS_US: 0.03 }), stateKey: 'acct', rateKey: 'SAVINGS_US', fallbackRate: 0.01 });
  assert.strictEqual(perAcct.amount, +(12000 * 0.06 / 12).toFixed(2), 'per-account key wins');

  // shared key used when no per-account override
  const shared = computeHoldingsCashInterest({ state: mk({ SAVINGS_US: 0.03 }), stateKey: 'acct', rateKey: 'SAVINGS_US', fallbackRate: 0.01 });
  assert.strictEqual(shared.amount, +(12000 * 0.03 / 12).toFixed(2), 'shared key used');

  // fallbackRate used when the map has no entry at all
  const fb = computeHoldingsCashInterest({ state: mk({}), stateKey: 'acct', rateKey: 'SAVINGS_US', fallbackRate: 0.01 });
  assert.strictEqual(fb.amount, +(12000 * 0.01 / 12).toFixed(2), 'fallback rate used');
});

// ── Reducer postconditions: the three tax modes ──────────────────────────────

const baseState = () => ({
  usOrdinaryIncomeYTD: 0, auOrdinaryIncomeYTD: 0,
  usSourceOrdinaryUsdYTD: 0, usSourceOrdinaryAudYTD: 0,
  acct: { balance: 10000, holdings: [{ id: 'c1', allocation: 'CASH', marketValue: 10000 }] },
});

test('EVT-CASH-INT-3: taxMode=us credits balance and books US ordinary income', () => {
  const r = new CashSleeveInterestApplyReducer({});
  const next = r.reduce(baseState(), { type: 'CASH_SLEEVE_INTEREST_APPLY', amount: 25, stateKey: 'acct', taxMode: 'us', residency: 'US' });

  assert.strictEqual(next.acct.balance, 10025, 'interest credited to balance');
  assert.strictEqual(next.usOrdinaryIncomeYTD, 25, 'federal + state ordinary income');
  assert.strictEqual(next.auOrdinaryIncomeYTD, 0, 'no AU booking when US-resident');
  assert.deepEqual(next.next, [], 'no chained tax action on the US path');
});

test('EVT-CASH-INT-4: taxMode=us while AU-resident mirrors into AU worldwide + the FITO removal set', () => {
  const r = new CashSleeveInterestApplyReducer({});
  const next = r.reduce(baseState(), { type: 'CASH_SLEEVE_INTEREST_APPLY', amount: 25, stateKey: 'acct', taxMode: 'us', residency: 'AU' });

  assert.strictEqual(next.usOrdinaryIncomeYTD, 25);
  assert.strictEqual(next.auOrdinaryIncomeYTD, 25, 'AU taxes US-source interest worldwide');
  assert.strictEqual(next.usSourceOrdinaryUsdYTD, 25, 'FITO removal set (USD)');
  assert.strictEqual(next.usSourceOrdinaryAudYTD, 25, 'FITO removal set (AUD)');
});

test('EVT-CASH-INT-5: taxMode=au credits balance and chains AU_SAVINGS_EARNINGS_TAX', () => {
  const r = new CashSleeveInterestApplyReducer({});
  const next = r.reduce(baseState(), { type: 'CASH_SLEEVE_INTEREST_APPLY', amount: 30, stateKey: 'acct', taxMode: 'au', residency: 'AU' });

  assert.strictEqual(next.acct.balance, 10030);
  assert.strictEqual(next.usOrdinaryIncomeYTD, 0, 'US buckets untouched on the AU path');
  const tax = next.next.find(a => a.type === 'AU_SAVINGS_EARNINGS_TAX');
  assert.ok(tax, 'chains the AU ordinary-income tax action');
  assert.strictEqual(tax.amount, 30);
});

test('EVT-CASH-INT-6: taxMode=deferred credits balance with no immediate tax', () => {
  const r = new CashSleeveInterestApplyReducer({});
  const next = r.reduce(baseState(), { type: 'CASH_SLEEVE_INTEREST_APPLY', amount: 40, stateKey: 'acct', taxMode: 'deferred', residency: 'US' });

  assert.strictEqual(next.acct.balance, 10040, 'interest grows the tax-deferred wrapper');
  assert.strictEqual(next.usOrdinaryIncomeYTD, 0, 'no immediate tax — taxed (or not, for Roth) on withdrawal');
  assert.deepEqual(next.next.filter(a => a.type === 'AU_SAVINGS_EARNINGS_TAX'), [], 'no AU tax chained');
});

// ── Integration: a brokerage cash sleeve earns and is taxed end-to-end ────────

function run(params, mutateCfg) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = IntlRetirementScenario.buildDefaultConfig(params, undefined, undefined);
  if (mutateCfg) mutateCfg(cfg);
  const scenario = new BaseScenario({
    context: services.simulationContext, initialState: cfg.initialState ?? {},
    simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);
  return scenario.sim;
}

function seedCashSleeve(cfg) {
  const acct = (cfg.accounts ?? []).find(a => a.role === 'us-stock');
  assert.ok(acct, 'expected a us-stock account in the default scenario');
  acct.holdings = [
    { id: 'cash-sleeve', allocation: 'CASH', marketValue: 100000, costBasis: 100000, rateKey: 'SAVINGS_US' },
  ];
  acct.initialValue = 100000;
  acct.balance = 100000;
}

test('EVT-CASH-INT-7: a brokerage CASH sleeve accrues monthly interest end-to-end', () => {
  const sim = run({ residencyState: 'NE', usSavingsInterestRate: 0.03, monthlyExpenses: 0, inflationAdjust: false }, seedCashSleeve);
  sim.stepTo(new Date(Date.UTC(2026, 3, 2)));   // a few month-ends into the run

  const acct = sim.state.usStockAccount;
  const cash = acct.holdings.find(h => h.id === 'cash-sleeve');
  assert.ok(cash.marketValue > 100000, `cash sleeve should have grown from interest, got ${cash.marketValue}`);
  assert.ok(Math.abs(acct.balance - cash.marketValue) < 0.01, '§4.4: balance stays synced to the single sleeve');
  assert.ok((sim.state.usOrdinaryIncomeYTD ?? 0) > 0, 'brokerage cash interest is US ordinary income');
});
