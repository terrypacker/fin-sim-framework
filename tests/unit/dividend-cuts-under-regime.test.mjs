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
 * dividend-cuts-under-regime.test.mjs
 *
 * Tests for dividend-yield cuts under economic regimes (design 24 Phase C / design 28 §7):
 *
 *   EVT-DIV-CUT-1: RegimeApplyReducer accumulates dividendAdjustment from active regimes
 *                  into effectiveDividendAdjustments.
 *   EVT-DIV-CUT-2: DividendScheduledHandler scales amount by (1 + effectiveDividendAdjustments[rateKey]).
 *   EVT-DIV-CUT-3: Integration — shock with dividendAdjustment sets effectiveDividendAdjustments
 *                  after sim.stepTo the shock date.
 *   EVT-DIV-CUT-4: Integration — effectiveDividendAdjustments resets to zero after regime expires.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { RegimeApplyReducer }       from '../../src/finance/economic-regimes/regime-apply-reducer.js';
import { DividendScheduledHandler } from '../../src/finance/handlers/dividend-scheduled-handler.js';
import { RATE_KEYS }                from '../../src/finance/economic-regimes/rate-keys.js';
import { ACCOUNT_ROLES }            from '../../src/finance/state/account-roles.js';
import { ServiceRegistry }          from '../../src/services/service-registry.js';
import { ScenarioLoader }           from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }             from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRegime({ dividendAdjustment, factor = 1.0, startDate = '2026-01-01', durationMonths = 12 }) {
  return {
    id:                     'test-regime',
    shockId:                'test',
    startDate:              new Date(startDate),
    endDate:                new Date(new Date(startDate).setMonth(new Date(startDate).getMonth() + durationMonths)),
    recoveryProfile:        'V',
    durationMonths,
    currentFactor:          factor,
    returnAdjustment:       null,
    interestRateAdjustment: null,
    inflationAdjustment:    null,
    appreciationAdjustment: null,
    fxAdjustment:           null,
    dividendAdjustment,
  };
}

function makeState(overrides = {}) {
  return {
    activeRegimes:          [],
    baseGrowthRates:        {},
    baseInterestRates:      {},
    baseInflationRates:     {},
    baseAppreciationRates:  {},
    effectiveDividendAdjustments: {},
    ...overrides,
  };
}

// ─── Unit: RegimeApplyReducer ─────────────────────────────────────────────────

test('EVT-DIV-CUT-1: RegimeApplyReducer accumulates dividendAdjustment at factor 1.0', () => {
  const reducer = new RegimeApplyReducer();
  const regime  = makeRegime({ dividendAdjustment: { [RATE_KEYS.EQUITY_US]: -0.40 } });
  const state   = makeState({ activeRegimes: [regime] });

  const next = reducer.reduce(state, { type: 'RECOMPUTE_REGIMES' }, new Date('2026-01-01'));

  const adj = next.effectiveDividendAdjustments?.[RATE_KEYS.EQUITY_US] ?? NaN;
  assert.ok(
    Math.abs(adj - (-0.40)) < 0.001,
    `Expected effectiveDividendAdjustments.EQUITY_US ≈ -0.40, got ${adj}`
  );
});

test('EVT-DIV-CUT-1b: RegimeApplyReducer starts from 0 base (not from any prior dividend field)', () => {
  const reducer = new RegimeApplyReducer();
  const state   = makeState({ activeRegimes: [] });

  const next = reducer.reduce(state, { type: 'RECOMPUTE_REGIMES' }, new Date('2026-01-01'));

  const adj = next.effectiveDividendAdjustments?.[RATE_KEYS.EQUITY_US] ?? 0;
  assert.strictEqual(adj, 0, `Expected 0 with no active regimes, got ${adj}`);
});

test('EVT-DIV-CUT-1c: two overlapping regimes accumulate dividendAdjustment additively', () => {
  const reducer = new RegimeApplyReducer();
  const r1 = makeRegime({ dividendAdjustment: { [RATE_KEYS.EQUITY_US]: -0.30 } });
  const r2 = makeRegime({ dividendAdjustment: { [RATE_KEYS.EQUITY_US]: -0.20 }, startDate: '2026-02-01' });
  const state = makeState({ activeRegimes: [r1, r2] });

  const next = reducer.reduce(state, { type: 'RECOMPUTE_REGIMES' }, new Date('2026-02-15'));

  const adj = next.effectiveDividendAdjustments?.[RATE_KEYS.EQUITY_US] ?? NaN;
  // Both at V-curve partway through — factor will be close to 1 near start; allow tolerance
  assert.ok(adj < -0.40, `Expected combined adj < -0.40, got ${adj}`);
});

// ─── Unit: DividendScheduledHandler ──────────────────────────────────────────

test('EVT-DIV-CUT-2: DividendScheduledHandler scales amount by (1 + adjustment)', () => {
  const stateKey = 'stockAccount';
  const role     = ACCOUNT_ROLES.US_STOCK;
  const mockRegistry = {
    getStateKey: (_role, _ownerId) => stateKey,
    getAccount:  (state, _role, _ownerId) => state[stateKey],
  };

  const handler = new DividendScheduledHandler({
    stateRegistry: mockRegistry, role,
    dividendRate: 0.04, reinvest: false,
  });

  const adjustment = -0.50;
  const state = {
    [stateKey]:                   { balance: 100000, ownerId: null },
    effectiveDividendAdjustments: { [RATE_KEYS.EQUITY_US]: adjustment },
    people:                       {},
  };

  const actions = handler.call({ data: {}, state });

  const applyAction = actions.find(a => a.type === 'STOCK_DIVIDEND_CASH_APPLY');
  assert.ok(applyAction, 'Expected a STOCK_DIVIDEND_CASH_APPLY action');

  const expectedAmount = +(100000 * 0.04 * (1 + adjustment)).toFixed(2);
  assert.strictEqual(applyAction.amount, expectedAmount,
    `Expected dividend amount ${expectedAmount}, got ${applyAction.amount}`);
});

test('EVT-DIV-CUT-2b: DividendScheduledHandler falls back to dividendRate when no adjustment in state', () => {
  const stateKey = 'stockAccount';
  const mockRegistry = {
    getStateKey: (_r, _o) => stateKey,
    getAccount:  (state, _r, _o) => state[stateKey],
  };

  const handler = new DividendScheduledHandler({
    stateRegistry: mockRegistry, role: ACCOUNT_ROLES.US_STOCK,
    dividendRate: 0.04, reinvest: false,
  });

  const state = {
    [stateKey]: { balance: 100000, ownerId: null },
    people: {},
  };

  const actions = handler.call({ data: {}, state });
  const applyAction = actions.find(a => a.type === 'STOCK_DIVIDEND_CASH_APPLY');
  assert.ok(applyAction, 'Expected a STOCK_DIVIDEND_CASH_APPLY action');

  const expectedAmount = +(100000 * 0.04).toFixed(2);
  assert.strictEqual(applyAction.amount, expectedAmount,
    `Expected unmodified dividend ${expectedAmount}, got ${applyAction.amount}`);
});

test('EVT-DIV-CUT-2c: DividendScheduledHandler clamps zero — complete dividend suspension', () => {
  const stateKey = 'stockAccount';
  const mockRegistry = {
    getStateKey: (_r, _o) => stateKey,
    getAccount:  (state, _r, _o) => state[stateKey],
  };

  const handler = new DividendScheduledHandler({
    stateRegistry: mockRegistry, role: ACCOUNT_ROLES.US_STOCK,
    dividendRate: 0.04, reinvest: false,
  });

  const state = {
    [stateKey]:                   { balance: 100000, ownerId: null },
    effectiveDividendAdjustments: { [RATE_KEYS.EQUITY_US]: -1.0 },
    people:                       {},
  };

  const actions = handler.call({ data: {}, state });
  // With -1.0 adjustment, effectiveRate = 0.04 * 0 = 0, so no dividend action emitted
  const applyAction = actions.find(a => a.type === 'STOCK_DIVIDEND_CASH_APPLY');
  assert.strictEqual(applyAction, undefined, 'Should emit no STOCK_DIVIDEND_CASH_APPLY when dividends are fully cut');
});

// ─── Integration: shock → effectiveDividendAdjustments ───────────────────────

const SIM_START = new Date('2026-01-01');
const SIM_END   = new Date('2029-06-01');

const BASE_CFG = {
  toolsets:   ['US_BANKING', 'US_TAX', 'US_RETIREMENT', 'ECONOMIC_REGIMES'],
  simStart:   '2026-01-01',
  simEnd:     '2029-06-01',
  parameters: {
    monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
    rothGrowthRate: 0.0, iraGrowthRate: 0, k401GrowthRate: 0,
    brokerageGrowthRate: 0, brokerageDividendRate: 0.04,
    fixedIncomeInterestRate: 0, usSavingsInterestRate: 0,
  },
  persons: [{
    __type: 'Person', id: 'primary', name: 'Primary',
    birthDate: '1975-04-15', citizen: ['US'], lifeExpectancy: 90,
    monthlyWage: 0, retirementDate: '2025-01-01', socialSecurityMonthly: 0,
  }],
  accounts: [
    {
      __type: 'SavingsAccount', id: 'checking', name: 'Checking',
      role: 'us-savings', stateKey: 'checkingAccount',
      initialValue: 50000, ownershipType: 'sole', ownerId: 'primary',
      minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
    },
    {
      __type: 'BrokerageAccount', id: 'stock', name: 'US Stock',
      role: 'us-stock', stateKey: 'stockAccount',
      initialValue: 100000, ownershipType: 'sole', ownerId: 'primary',
      contributionBasis: 100000, earningsBasis: 0, loanBalance: 0,
      minimumAge: null, balanceAtResidencyChange: null,
      drawdownPriority: 1, country: 'US', currency: { code: 'USD', symbol: '$' },
    },
  ],
};

function loadScenario(extraParams = {}) {
  const cfg = structuredClone(BASE_CFG);
  cfg.parameters = { ...BASE_CFG.parameters, ...extraParams };
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: SIM_START,
    simEnd:   SIM_END,
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);
  return { scenario, sim: scenario.sim };
}

test('EVT-DIV-CUT-3: shock with dividendAdjustment sets effectiveDividendAdjustments after shock fires', () => {
  const shock = {
    shockId: 'div-cut-test',
    name:    'Dividend Cut Test',
    startDate: '2026-03-01',
    regime: { dividendAdjustment: { [RATE_KEYS.EQUITY_US]: -0.50 } },
    recovery: { profile: 'V', durationMonths: 24 },
  };

  const { sim } = loadScenario({ shocks: [shock] });

  // Step to just after shock fires
  sim.stepTo(new Date('2026-04-01'));

  const adj = sim.state.effectiveDividendAdjustments?.[RATE_KEYS.EQUITY_US] ?? NaN;
  assert.ok(
    Math.abs(adj - (-0.50)) < 0.05,
    `effectiveDividendAdjustments.EQUITY_US should be ≈ -0.50 at regime peak, got ${adj}`
  );
});

test('EVT-DIV-CUT-4: effectiveDividendAdjustments resets to zero after regime expires', () => {
  const shock = {
    shockId: 'div-cut-expire',
    name:    'Short Dividend Cut',
    startDate: '2026-02-01',
    regime: { dividendAdjustment: { [RATE_KEYS.EQUITY_US]: -0.40 } },
    recovery: { profile: 'V', durationMonths: 6 },
  };

  const { sim } = loadScenario({ shocks: [shock] });

  // During regime: adjustment should be present
  sim.stepTo(new Date('2026-04-01'));
  const adjDuring = sim.state.effectiveDividendAdjustments?.[RATE_KEYS.EQUITY_US] ?? 0;
  assert.ok(adjDuring < 0, `Expected negative adjustment during regime, got ${adjDuring}`);

  // After regime expires (> 6 months from Feb 2026)
  sim.stepTo(new Date('2026-10-01'));
  const adjAfter = sim.state.effectiveDividendAdjustments?.[RATE_KEYS.EQUITY_US] ?? 0;
  assert.ok(
    Math.abs(adjAfter) < 0.01,
    `Expected effectiveDividendAdjustments.EQUITY_US ≈ 0 after regime expires, got ${adjAfter}`
  );
  assert.strictEqual(sim.state.activeRegimes.length, 0, 'Regime should be dropped after expiry');
});
