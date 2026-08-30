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
 * evt-recovery-rebound.test.mjs
 *
 * The rebound-capable recovery profiles (design 21 §22).
 *
 * Every other profile fades a regime's adjustments toward zero, so the best a shock can
 * ever do is hand the baseline back. Real recoveries did not creep back at baseline — the
 * S&P regained its 2007 peak in 65 months while compounding at 7 % needs ~140 — so a
 * preset calibrated to a measured trough was structurally unable to also reach the measured
 * recovery. V_REBOUND / U_REBOUND fix that by letting the factor go NEGATIVE, which flips
 * the regime's own drag into a tailwind.
 *
 *   REBOUND-1: the four original profiles ignore the new third argument
 *   REBOUND-2: the factor crosses zero at reboundStart × duration and goes negative after
 *   REBOUND-3: reboundPeak sets how far below zero, and the window still ends at 0
 *   REBOUND-4: a negative factor raises effectiveGrowthRates ABOVE base, in the reducer
 *   REBOUND-5: the regime is not dropped while its factor is negative
 *   REBOUND-6: end-to-end — a rebound leg returns the book to its pre-shock value sooner
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { RecoveryCurves }     from '../../src/finance/economic-regimes/recovery-curves.js';
import { RegimeApplyReducer } from '../../src/finance/economic-regimes/regime-apply-reducer.js';
import { ServiceRegistry }    from '../../src/services/service-registry.js';
import { ScenarioLoader }     from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }       from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

// ─── Unit ─────────────────────────────────────────────────────────────────────

test('REBOUND-1: the four original profiles ignore the new third argument', () => {
  // The reducer now passes the regime so the rebound profiles can read their knobs off it.
  // Every pre-existing regime must be byte-identical, which means V/U/W/L must not look.
  const noise = { reboundStart: 0.1, reboundPeak: 9 };
  for (const p of ['V', 'U', 'W', 'L']) {
    for (const t of [0, 1, 5, 9, 12, 17, 18, 30]) {
      assert.strictEqual(RecoveryCurves[p](t, 18), RecoveryCurves[p](t, 18, noise),
        `${p}(${t}) must not depend on the regime argument`);
    }
  }
});

test('REBOUND-2: the factor crosses zero at reboundStart × duration and goes negative after', () => {
  const regime = { reboundStart: 0.25, reboundPeak: 0.4 };
  const D = 120;
  for (const profile of ['V_REBOUND', 'U_REBOUND']) {
    const f = (t) => RecoveryCurves[profile](t, D, regime);
    assert.strictEqual(f(0), 1, `${profile} starts at full strength`);
    assert.ok(Math.abs(f(30)) < 1e-9, `${profile} must cross zero at month 30, got ${f(30)}`);
    assert.ok(f(20) > 0,  `${profile} is still a drag before the crossing, got ${f(20)}`);
    assert.ok(f(60) < 0,  `${profile} is a TAILWIND after it, got ${f(60)}`);
    assert.strictEqual(f(D), 0, `${profile} is spent at the end of the window`);
    assert.strictEqual(f(D + 12), 0, `${profile} stays spent past the window`);
  }
});

test('REBOUND-3: reboundPeak sets how far below zero the factor swings', () => {
  const D = 100;
  const at = (peak, t) => RecoveryCurves.V_REBOUND(t, D, { reboundStart: 0.5, reboundPeak: peak });
  // The excursion is a half-sine over the remaining window, so its minimum is −peak at
  // the midpoint of that remainder — month 75 for reboundStart 0.5 over 100 months.
  assert.ok(Math.abs(at(0.4, 75) - (-0.4)) < 1e-9, `expected −0.4 at the trough, got ${at(0.4, 75)}`);
  assert.ok(Math.abs(at(0.8, 75) - (-0.8)) < 1e-9, `expected −0.8 at the trough, got ${at(0.8, 75)}`);
  // peak 0 degenerates to "fade and then nothing" — a plain fade with a longer tail.
  assert.strictEqual(at(0, 75), -0);
});

test('REBOUND-4: a negative factor raises effectiveGrowthRates ABOVE base, in the reducer', () => {
  const reducer = new RegimeApplyReducer();
  const start   = new Date('2030-01-01');
  const regime  = {
    id: 'r1', shockId: 's1', startDate: start,
    endDate: new Date('2040-01-01'),
    recoveryProfile: 'V_REBOUND', durationMonths: 120,
    reboundStart: 0.25, reboundPeak: 0.5,
    returnAdjustment: { EQUITY_US: -0.40 },
  };
  const state = {
    activeRegimes: [regime],
    baseGrowthRates: { EQUITY_US: 0.07 },
    baseInterestRates: {}, baseInflationRates: {}, baseAppreciationRates: {},
    newState: null,
  };
  state.newState = (s, patch) => ({ ...s, ...patch });

  // Month 12 — still inside the decline phase, so the drag is on.
  const during = reducer.reduce(state, { type: 'RECOMPUTE_REGIMES' }, new Date('2031-01-01'));
  assert.ok(during.effectiveGrowthRates.EQUITY_US < 0.07,
    `still a drag at month 12, got ${during.effectiveGrowthRates.EQUITY_US}`);

  // Month 75 — deep in the rebound, so the same regime is now a tailwind.
  const after = reducer.reduce(state, { type: 'RECOMPUTE_REGIMES' }, new Date('2036-04-01'));
  assert.ok(after.effectiveGrowthRates.EQUITY_US > 0.07,
    `expected an above-baseline rate in the rebound, got ${after.effectiveGrowthRates.EQUITY_US}`);
});

test('REBOUND-5: the regime is not dropped while its factor is negative', () => {
  const reducer = new RegimeApplyReducer();
  const state = {
    activeRegimes: [{
      id: 'r1', shockId: 's1', startDate: new Date('2030-01-01'),
      endDate: new Date('2040-01-01'),
      recoveryProfile: 'U_REBOUND', durationMonths: 120,
      reboundStart: 0.25, reboundPeak: 0.5,
      returnAdjustment: { EQUITY_US: -0.40 },
    }],
    baseGrowthRates: { EQUITY_US: 0.07 },
    baseInterestRates: {}, baseInflationRates: {}, baseAppreciationRates: {},
    newState: (s, patch) => ({ ...s, ...patch }),
  };
  // The drop guard is `factor <= 0 && now >= endDate`. A negative factor BEFORE the end
  // date must survive it, or the tailwind would be deleted the moment it started.
  const mid = reducer.reduce(state, { type: 'RECOMPUTE_REGIMES' }, new Date('2036-04-01'));
  assert.strictEqual(mid.activeRegimes.length, 1, 'the regime must survive its own rebound');
  assert.ok(mid.activeRegimes[0].currentFactor < 0);

  // Past the end date it is gone, exactly as before.
  const done = reducer.reduce(state, { type: 'RECOMPUTE_REGIMES' }, new Date('2041-01-01'));
  assert.strictEqual(done.activeRegimes.length, 0, 'and it is dropped once past endDate');
});

// ─── End-to-end ───────────────────────────────────────────────────────────────

const CFG = {
  toolsets: ['US_BANKING', 'US_TAX', 'US_RETIREMENT', 'ECONOMIC_REGIMES'],
  simStart: '2026-01-01', simEnd: '2044-01-01',
  parameters: {
    monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
    rothGrowthRate: 0.07, iraGrowthRate: 0, k401GrowthRate: 0,
    brokerageGrowthRate: 0, brokerageDividendRate: 0,
    fixedIncomeInterestRate: 0, usSavingsInterestRate: 0,
  },
  persons: [{ __type: 'Person', id: 'primary', name: 'P', birthDate: '1975-04-15', citizen: ['US'],
    lifeExpectancy: 120, monthlyWage: 0, retirementDate: '2025-01-01', socialSecurityMonthly: 0 }],
  accounts: [
    { __type: 'SavingsAccount', id: 'checking', name: 'C', role: 'us-savings', stateKey: 'checkingAccount',
      initialValue: 50000, ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0, country: 'US',
      currency: { code: 'USD', symbol: '$' } },
    { __type: 'RothAccount', stateKey: 'rothAccount', role: 'roth-ira', name: 'R', initialValue: 100000,
      contributionBasis: 0, ownerId: 'primary', drawdownPriority: 5, country: 'US',
      currency: { code: 'USD', symbol: '$' } },
  ],
};

function runToPeak(recovery) {
  ServiceRegistry.resetAll();
  const cfg = structuredClone(CFG);
  cfg.parameters.shocks = [{
    shockId: 'T', name: 'T', startDate: '2027-01-15',
    levelEffects: { equityRevaluation: { rateKeys: ['EQUITY_US'], multiplier: -0.30 } },
    legs: [{ id: 'equity', regime: { returnAdjustment: { EQUITY_US: -0.10 } }, recovery }],
    recovery,
  }];
  const services = ServiceRegistry.getInstance();
  const sc = new BaseScenario({ context: services.simulationContext,
    simStart: new Date('2026-01-01'), simEnd: new Date('2044-01-01') });
  sc.buildSim();
  new ScenarioLoader().load(cfg, services);

  const path = [];
  for (let m = 0; m <= 200; m++) {
    sc.sim.stepTo(new Date(Date.UTC(2026, m, 1)));
    path.push(sc.sim.state.rothAccount.balance);
  }
  const pre = path[12];                       // the last observation before the shock
  for (let m = 13; m < path.length; m++) if (path[m] >= pre) return m - 12;
  return null;
}

test('REBOUND-6: a rebound leg returns the book to its pre-shock value sooner', () => {
  const plain   = runToPeak({ profile: 'U',         durationMonths: 72 });
  const rebound = runToPeak({ profile: 'U_REBOUND', durationMonths: 72,
                              reboundStart: 0.35, reboundPeak: 0.9 });

  assert.ok(plain   != null, 'the control arm must get back to its prior peak eventually');
  assert.ok(rebound != null, 'so must the rebound arm');
  assert.ok(rebound < plain,
    `the rebound must recover sooner: rebound ${rebound} mo vs plain ${plain} mo`);
});
