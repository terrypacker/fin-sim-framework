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
 * evt-fx-process.test.mjs — design 47 Phase 1 (time-varying FX rates).
 *
 * EVT-FXP-1  NONE model: effectiveExchangeRates flat == base every period; sim.rng never advances.
 * EVT-FXP-2  MEAN_REVERTING: rate varies over time; same seed → identical path (repeatable).
 * EVT-FXP-3  Snapshot rewind + replay reproduces the identical rate path.
 * EVT-FXP-4  Process model step functions: NONE/WHITE_NOISE/RANDOM_WALK/MEAN_REVERTING semantics.
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';
import { FX_PROCESS_MODELS } from '../../src/finance/fx/fx-process-models.js';

beforeEach(() => ServiceRegistry.resetAll());

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

function makeConfig({ fxProcessModel = 'NONE', fxVolatility = 0.06, fxReversionSpeed = 0.5 } = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER'],
    simStart: '2026-01-01',
    simEnd:   '2031-01-01',
    parameters: {
      monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0, auInflationRate: 0,
      rothGrowthRate: 0, iraGrowthRate: 0, k401GrowthRate: 0,
      brokerageGrowthRate: 0, brokerageDividendRate: 0, fixedIncomeInterestRate: 0,
      usSavingsInterestRate: 0, auSavingsInterestRate: 0,
      superGrowthRate: 0, auStockGrowthRate: 0, auStockDividendRate: 0,
      exchangeRateUsdToAud: 1.55, intlTransferFeeUsd: 15,
      fxProcessModel, fxVolatility, fxReversionSpeed,
    },
    persons: [{
      __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1966-01-01',
      citizen: ['US', 'AU'], lifeExpectancy: 90, monthlyWage: 0,
      retirementDate: '2025-01-01', socialSecurityMonthly: 0,
    }],
    accounts: [
      {
        __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings',
        role: 'us-savings', stateKey: 'usSavingsAccount',
        initialValue: 10000, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
      },
      {
        __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings',
        role: 'au-savings', stateKey: 'auSavingsAccount',
        initialValue: 0, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: '$' },
      },
    ],
  };
}

/** Step the sim month-by-month, collecting the effective USD_AUD rate at each. */
function collectRatePath(sim, months = 48) {
  const path = [];
  let d = new Date(sim.currentDate);
  for (let i = 0; i < months; i++) {
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 28));
    sim.stepTo(d);
    path.push(sim.state.effectiveExchangeRates.USD_AUD);
  }
  return path;
}

// ── EVT-FXP-1: NONE model is flat and draws no randomness ─────────────────────
test('EVT-FXP-1: NONE model leaves effectiveExchangeRates flat and never advances the RNG', () => {
  const sim = loadScenario(makeConfig({ fxProcessModel: 'NONE' }));
  const seedBefore = sim.rngState;
  const path = collectRatePath(sim, 48);

  assert.ok(path.every(r => r === 1.55), `Expected flat 1.55, got e.g. ${path.slice(0, 3)}`);
  assert.strictEqual(sim.rngState, seedBefore, 'RNG must not advance when no FX process is active');
});

// ── EVT-FXP-2: MEAN_REVERTING varies over time and is repeatable at a fixed seed ──
test('EVT-FXP-2: MEAN_REVERTING rate varies over time and reproduces exactly at the same seed', () => {
  // Two independent, freshly-reset builds — each seeded identically (the sim's
  // default seed), so the seeded RNG must reproduce the identical path.
  ServiceRegistry.resetAll();
  const pathA = collectRatePath(loadScenario(makeConfig({ fxProcessModel: 'MEAN_REVERTING' })), 48);
  ServiceRegistry.resetAll();
  const pathB = collectRatePath(loadScenario(makeConfig({ fxProcessModel: 'MEAN_REVERTING' })), 48);

  // Varies: not every point equals the base anchor.
  assert.ok(pathA.some(r => Math.abs(r - 1.55) > 1e-6), 'Expected the rate to move away from 1.55');
  // Positive: log-space composition keeps it > 0.
  assert.ok(pathA.every(r => r > 0), 'Rate must stay positive');
  // Repeatable: identical seed ⇒ identical path (the "designed to be repeatable" RNG).
  assert.deepStrictEqual(pathA, pathB, 'Same-seed runs must produce the identical FX path');
});

// ── EVT-FXP-3: snapshot rewind + replay reproduces the identical path ──────────
test('EVT-FXP-3: rewinding to a snapshot and replaying reproduces the identical FX path', () => {
  const sim = loadScenario(makeConfig({ fxProcessModel: 'MEAN_REVERTING' }));

  // Build the ordered monthly date sequence and run once, keying rate by date.
  const dates = [];
  let d = new Date(sim.currentDate);
  for (let i = 0; i < 48; i++) {
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 28));
    dates.push(d);
  }
  const original = new Map();
  for (const dt of dates) {
    sim.stepTo(dt);
    original.set(dt.toISOString(), sim.state.effectiveExchangeRates.USD_AUD);
  }

  // Rewind to an early snapshot, then replay every date after the snapshot's
  // date. Each replayed rate must match the original run exactly.
  const history = sim.history;
  assert.ok(history?.snapshots?.length > 1, 'expected snapshots to exist');
  history.restoreSnapshot(1);
  const snapDate = new Date(sim.currentDate);

  let replayed = 0;
  for (const dt of dates) {
    if (dt <= snapDate) continue;
    sim.stepTo(dt);
    assert.strictEqual(
      sim.state.effectiveExchangeRates.USD_AUD,
      original.get(dt.toISOString()),
      `replay diverged at ${dt.toISOString()}`,
    );
    replayed++;
  }
  assert.ok(replayed > 0, 'expected to replay at least one post-snapshot date');
});

// ── EVT-FXP-4: process model step semantics ───────────────────────────────────
test('EVT-FXP-4: FX_PROCESS_MODELS step functions behave per spec', () => {
  const ctx = { sigma: 0.1, dt: 1 / 12, k: 0.5, z: 1.0 };

  // NONE: always 0.
  assert.strictEqual(FX_PROCESS_MODELS.NONE(0.4, ctx), 0);

  // WHITE_NOISE: memoryless — ignores prev.
  assert.strictEqual(
    FX_PROCESS_MODELS.WHITE_NOISE(0.4, ctx),
    FX_PROCESS_MODELS.WHITE_NOISE(-0.9, ctx),
    'white noise must ignore prev',
  );

  // RANDOM_WALK: accumulates on prev.
  const step = ctx.sigma * Math.sqrt(ctx.dt) * ctx.z;
  assert.ok(Math.abs(FX_PROCESS_MODELS.RANDOM_WALK(0.4, ctx) - (0.4 + step)) < 1e-12);

  // MEAN_REVERTING: with z=0 a displaced deviation decays toward 0.
  const decayed = FX_PROCESS_MODELS.MEAN_REVERTING(0.4, { ...ctx, z: 0 });
  assert.ok(decayed > 0 && decayed < 0.4, `expected decay toward 0, got ${decayed}`);
});

// ─── randomSeed parameter (design 86 P8 follow-up) ────────────────────────────

/**
 * `randomSeed` is applied by ScenarioLoader, not buildSim, because buildSim runs
 * BEFORE the params are loaded. Before it existed the key was simply unread, so
 * every run of a stochastic scenario drew the identical sequence and a "seed sweep"
 * measured one path repeatedly.
 */
function fxPathForSeed(randomSeed, { explicitSeed = null } = {}) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = makeConfig({ fxProcessModel: 'RANDOM_WALK', fxVolatility: 0.12 });
  if (randomSeed != null) cfg.parameters.randomSeed = randomSeed;
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(cfg.simStart),
    simEnd:   new Date(cfg.simEnd),
  });
  scenario.buildSim(explicitSeed != null ? { seed: explicitSeed } : {});
  new ScenarioLoader().load(structuredClone(cfg), services);
  scenario.sim.stepTo(new Date('2031-01-01'));
  return scenario.sim.state.effectiveExchangeRates?.USD_AUD;
}

test('EVT-FXP-5: the same randomSeed reproduces the identical FX path', () => {
  const a = fxPathForSeed(7);
  const b = fxPathForSeed(7);
  assert.strictEqual(a, b);
});

test('EVT-FXP-6: DIFFERENT randomSeeds draw different FX paths', () => {
  const seen = new Set();
  for (const s of [1, 2, 3, 4, 5]) seen.add(fxPathForSeed(s));
  assert.ok(seen.size > 1,
    'every seed produced the same rate — randomSeed is not reaching sim.rng, which '
    + 'makes any seed sweep one path measured repeatedly');
});

test('EVT-FXP-7: omitting randomSeed is unchanged from seed 1', () => {
  const absent = fxPathForSeed(null);
  const one    = fxPathForSeed(1);
  assert.strictEqual(absent, one, 'the default must stay byte-identical');
});

test('EVT-FXP-8: an explicit buildSim seed WINS over the parameter', () => {
  // Monte Carlo depends on this: its per-iteration seed is the only thing making
  // paths differ, so a scenario parameter must never be able to override it and
  // collapse every iteration onto one ordering.
  const viaParam    = fxPathForSeed(9);
  const overridden  = fxPathForSeed(9, { explicitSeed: 3 });
  const viaExplicit = fxPathForSeed(null, { explicitSeed: 3 });
  assert.strictEqual(overridden, viaExplicit, 'the explicit seed must decide the path');
  assert.notStrictEqual(overridden, viaParam, 'and the parameter must be ignored');
});
