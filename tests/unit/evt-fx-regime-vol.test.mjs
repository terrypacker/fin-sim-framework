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
 * evt-fx-regime-vol.test.mjs — design 47 Phase 2 (regime → FX volatility coupling).
 *
 * EVT-FXRV-1  A regime's fxVolAdjustment amplifies effectiveFxVol multiplicatively
 *             (baseFxVol × (1 + adj × factor)) while active.
 * EVT-FXRV-2  A vol-only regime (fxVolAdjustment, no fxAdjustment) raises vol but
 *             leaves the anchor (fxAnchorRates) at base — no directional drift.
 * EVT-FXRV-3  After a V recovery expires, effectiveFxVol decays back to baseFxVol.
 * EVT-FXRV-4  A full-crisis regime (both) drifts the anchor up AND raises vol.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

const BASE_VOL = 0.06;

function loadScenario(config) {
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(config.simStart),
    simEnd:   new Date(config.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(structuredClone(config), services);
  return scenario.sim;
}

function makeConfig(shock, { fxProcessModel = 'MEAN_REVERTING' } = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER', 'ECONOMIC_REGIMES'],
    simStart: '2026-01-01',
    simEnd:   '2029-01-01',
    parameters: {
      monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0, auInflationRate: 0,
      rothGrowthRate: 0, iraGrowthRate: 0, k401GrowthRate: 0,
      brokerageGrowthRate: 0, brokerageDividendRate: 0, fixedIncomeInterestRate: 0,
      usSavingsInterestRate: 0, auSavingsInterestRate: 0,
      superGrowthRate: 0, auStockGrowthRate: 0, auStockDividendRate: 0,
      exchangeRateUsdToAud: 1.55, intlTransferFeeUsd: 0,
      fxProcessModel, fxVolatility: BASE_VOL, fxReversionSpeed: 0.5,
      shocks: [shock],
    },
    persons: [{
      __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1975-04-15',
      citizen: ['US'], lifeExpectancy: 90, monthlyWage: 0,
      retirementDate: '2025-01-01', socialSecurityMonthly: 0,
    }],
    accounts: [
      {
        __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings',
        role: 'us-savings', stateKey: 'usSavingsAccount',
        initialValue: 50000, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
      },
      {
        __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings',
        role: 'au-savings', stateKey: 'auSavingsAccount',
        initialValue: 50000, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: '$' },
      },
    ],
  };
}

// ── EVT-FXRV-1: multiplicative volatility amplification ───────────────────────
test('EVT-FXRV-1: fxVolAdjustment amplifies effectiveFxVol multiplicatively while active', () => {
  const sim = loadScenario(makeConfig({
    shockId: 'vol-amp', name: 'Vol Amp', startDate: '2026-03-01',
    levelEffects: null,
    regime: { fxVolAdjustment: { USD_AUD: 0.5 } },
    recovery: { profile: 'L', durationMonths: 24 },
  }));

  // Before the shock: effective vol == base.
  sim.stepTo(new Date('2026-02-15'));
  assert.ok(Math.abs(sim.state.effectiveFxVol.USD_AUD - BASE_VOL) < 1e-9,
    `expected base vol before shock, got ${sim.state.effectiveFxVol.USD_AUD}`);

  // Mid-window (L-curve factor = 1): effectiveFxVol = 0.06 × (1 + 0.5) = 0.09.
  sim.stepTo(new Date('2026-09-01'));
  assert.ok(Math.abs(sim.state.effectiveFxVol.USD_AUD - BASE_VOL * 1.5) < 1e-9,
    `expected 0.09, got ${sim.state.effectiveFxVol.USD_AUD}`);
});

// ── EVT-FXRV-2: vol-only regime leaves the anchor at base ─────────────────────
test('EVT-FXRV-2: vol-only regime raises vol but does not drift the anchor', () => {
  const sim = loadScenario(makeConfig({
    shockId: 'vol-only', name: 'Vol Only', startDate: '2026-03-01',
    levelEffects: null,
    regime: { fxVolAdjustment: { USD_AUD: 0.5 } }, // no fxAdjustment
    recovery: { profile: 'L', durationMonths: 24 },
  }));

  sim.stepTo(new Date('2026-09-01'));
  // Anchor (pristine base + drift) stays at base — no directional bias.
  assert.ok(Math.abs(sim.state.fxAnchorRates.USD_AUD - 1.55) < 1e-9,
    `anchor should stay at base 1.55, got ${sim.state.fxAnchorRates.USD_AUD}`);
  // But vol is amplified.
  assert.ok(sim.state.effectiveFxVol.USD_AUD > BASE_VOL,
    `expected amplified vol, got ${sim.state.effectiveFxVol.USD_AUD}`);
});

// ── EVT-FXRV-3: recovery decays vol back to baseline ──────────────────────────
test('EVT-FXRV-3: after V recovery expires, effectiveFxVol returns to baseFxVol', () => {
  const sim = loadScenario(makeConfig({
    shockId: 'vol-recover', name: 'Vol Recover', startDate: '2026-02-01',
    levelEffects: null,
    regime: { fxVolAdjustment: { USD_AUD: 1.0 } },
    recovery: { profile: 'V', durationMonths: 6 },
  }));

  // Past the 6-month V window (Feb→Aug): regime dropped, vol back to base.
  sim.stepTo(new Date('2026-11-01'));
  assert.ok(Math.abs(sim.state.effectiveFxVol.USD_AUD - BASE_VOL) < 1e-9,
    `expected vol back to base after recovery, got ${sim.state.effectiveFxVol.USD_AUD}`);
  assert.strictEqual(sim.state.activeRegimes.length, 0, 'regime should be dropped after V recovery');
});

// ── EVT-FXRV-4: full crisis — drift + vol together ────────────────────────────
test('EVT-FXRV-4: full-crisis regime drifts the anchor up AND raises volatility', () => {
  const sim = loadScenario(makeConfig({
    shockId: 'full-crisis', name: 'Full Crisis', startDate: '2026-03-01',
    levelEffects: null,
    regime: { fxAdjustment: { USD_AUD: 0.08 }, fxVolAdjustment: { USD_AUD: 0.5 } },
    recovery: { profile: 'L', durationMonths: 24 },
  }));

  sim.stepTo(new Date('2026-09-01'));
  // Anchor drifted up by 0.08 (L factor = 1).
  assert.ok(Math.abs(sim.state.fxAnchorRates.USD_AUD - (1.55 + 0.08)) < 1e-9,
    `expected anchor 1.63, got ${sim.state.fxAnchorRates.USD_AUD}`);
  // Vol amplified to 0.09.
  assert.ok(Math.abs(sim.state.effectiveFxVol.USD_AUD - BASE_VOL * 1.5) < 1e-9,
    `expected vol 0.09, got ${sim.state.effectiveFxVol.USD_AUD}`);
});

// ── EVT-FXRV-5: anchor tracks the recovery curve monthly (no fiscal-boundary lag) ──
// Regression for the bug where fxAnchorRates was only recaptured on the annual
// US/AU period advances, so regime drift lagged up to 6 months into the rate.
// The recovery ticks (RECOMPUTE_REGIMES, monthly) must keep the anchor current.
test('EVT-FXRV-5: anchor decays with the V recovery curve month-by-month', () => {
  const sim = loadScenario(makeConfig({
    shockId: 'anchor-track', name: 'Anchor Track', startDate: '2030-01-01',
    levelEffects: null,
    regime: { fxAdjustment: { USD_AUD: 0.08 } },
    recovery: { profile: 'V', durationMonths: 18 },
  }));

  // Three months in (t=3): V factor = 1 - 3/18 = 0.8333 → anchor = 1.55 + 0.08×0.8333.
  sim.stepTo(new Date(Date.UTC(2030, 3, 20))); // Apr 20 2030 ≈ t=3.6mo, mid-recovery
  const anchor = sim.state.fxAnchorRates.USD_AUD;
  // Must be strictly between base and the peak — i.e. the drift is present AND
  // already decaying, not stuck at base (the lag bug) nor frozen at the peak.
  assert.ok(anchor > 1.56 && anchor < 1.63,
    `mid-recovery anchor should be decaying inside (1.56, 1.63), got ${anchor}`);
});
