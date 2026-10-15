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
 * evt-shock-stagflation-phases.test.mjs — STAGFLATION_1970S_LITE's money in phases (design 121 §4-5).
 *
 * STAG-1  at the library default bases each phase lands on its measured real rates
 *         (MEASUREMENTS §12): about −1 % real while inflation runs, +6-7 % once it breaks
 * STAG-2  gold moves one-for-one with the US inflation legs (+5 pp, then the +1.5 tail), and only then
 * STAG-3  the month-120 phase step is a yield RISE (bonds are marked down, not up)
 * STAG-4  every fixed-income returnAdjustment mirrors its interestRateAdjustment
 * STAG-5  a run that ends inside the episode drops the later phases without a warning
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceRegistry }  from '../../src/services/service-registry.js';
import { ScenarioLoader }   from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }     from '../../src/index.js';
import { ECONOMIC_REGIMES } from '../../src/scenarios/toolsets/economic-regimes-toolset.js';
import { SHOCK_LIBRARY }    from '../../src/finance/economic-shocks/shock-library.js';

beforeEach(() => ServiceRegistry.resetAll());

const PRESET = SHOCK_LIBRARY.STAGFLATION_1970S_LITE;
const SHOCK_START = '2027-01-01';

/** A sim at the LIBRARY DEFAULT bases (no rate overrides), the only base the legs are computed against. */
function loadDefaults(simEnd) {
  const cfg = {
    toolsets: ['US_BANKING', 'US_TAX', 'US_RETIREMENT', 'AU_BANKING', 'ECONOMIC_REGIMES'],
    simStart: '2026-01-01', simEnd,
    parameters: { shocks: [{ preset: 'STAGFLATION_1970S_LITE', startDate: SHOCK_START }] },
    persons: [{ __type: 'Person', id: 'primary', name: 'P', birthDate: '1975-04-15', citizen: ['US'],
      lifeExpectancy: 120, monthlyWage: 0, retirementDate: '2025-01-01', socialSecurityMonthly: 0 }],
    accounts: [{ __type: 'SavingsAccount', id: 'checking', name: 'C', role: 'us-savings',
      stateKey: 'checkingAccount', initialValue: 50000, ownershipType: 'sole', ownerId: 'primary',
      minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' } }],
  };
  const services = ServiceRegistry.getInstance();
  const sc = new BaseScenario({ context: services.simulationContext,
    simStart: new Date('2026-01-01'), simEnd: new Date(simEnd) });
  sc.buildSim();
  new ScenarioLoader().load(cfg, services);
  return sc.sim;
}

/** Mid-month `m` months after the shock. */
const monthAfter = (m) => new Date(Date.UTC(2027, m, 15));

function read(sim) {
  const s = sim.state;
  return {
    fiUs: s.effectiveInterestRates.FIXED_INCOME_US, primeUs: s.effectiveInterestRates.PRIME_US,
    fiAu: s.effectiveInterestRates.FIXED_INCOME_AU, primeAu: s.effectiveInterestRates.PRIME_AU,
    infUs: s.effectiveInflationRates.US, infAu: s.effectiveInflationRates.AU,
    gold: s.effectiveGrowthRates.GOLD,
  };
}

const near = (actual, expected, what) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: expected ${expected}, got ${actual}`);

test('STAG-1 / STAG-2: each phase lands on its measured real rates, and gold moves only with inflation', () => {
  const sim = loadDefaults('2070-01-01');

  // [month, US FI real, US policy real, AU FI real, AU policy real, US infl, AU infl, gold]
  const CHECKS = [
    [  60, -0.010, -0.008, -0.020, -0.016, 0.080, 0.116, 0.10 ],   // 1973-80
    [ 150,  0.072,  0.064,  0.055,  0.066, 0.045, 0.081, 0.065 ],  // US 1981-85, AU 1981-90 (both tails)
    [ 300,  0.010,  0.015,  0.060,  0.044, 0.030, 0.030, 0.05 ],   // US base, AU 1991-99
  ];
  for (const [m, fiUs, prUs, fiAu, prAu, infUs, infAu, gold] of CHECKS) {
    sim.stepTo(monthAfter(m));
    const r = read(sim);
    near(r.infUs, infUs, `month ${m} US inflation`);
    near(r.infAu, infAu, `month ${m} AU inflation`);
    near(r.fiUs - r.infUs,    fiUs, `month ${m} US FI real`);
    near(r.primeUs - r.infUs, prUs, `month ${m} US policy real`);
    near(r.fiAu - r.infAu,    fiAu, `month ${m} AU FI real`);
    near(r.primeAu - r.infAu, prAu, `month ${m} AU policy real`);
    near(r.gold, gold, `month ${m} gold`);
  }

  // Past every leg (AU's last fades out at month 456): back to base.
  sim.stepTo(monthAfter(470));
  const end = read(sim);
  near(end.fiAu, 0.04, 'AU FI back to base');
  near(end.primeAu, 0.0435, 'AU policy back to base');
});

test('STAG-3: the month-120 phase step RAISES yields, so held bonds are marked down', () => {
  const sim = loadDefaults('2040-01-01');
  sim.stepTo(monthAfter(119));
  const before = read(sim);
  sim.stepTo(monthAfter(121));
  const after = read(sim);
  // The old rates leg was U/240 from a 1981 PEAK: its yields only ever FELL, handing a held
  // ladder a windfall at the end of the inflation decade that 1979-81 never paid.
  assert.ok(after.fiUs > before.fiUs, `US FI ${before.fiUs} → ${after.fiUs} must rise`);
  assert.ok(after.fiAu > before.fiAu, `AU FI ${before.fiAu} → ${after.fiAu} must rise`);
});

test('STAG-4: every fixed-income returnAdjustment mirrors its interestRateAdjustment', () => {
  for (const leg of PRESET.legs) {
    const ira = leg.regime?.interestRateAdjustment ?? {};
    for (const [key, v] of Object.entries(ira)) {
      if (!key.startsWith('FIXED_INCOME_')) continue;
      assert.equal(leg.regime.returnAdjustment?.[key], v, `${leg.id}.${key}`);
    }
  }
});

test('STAG-5: a run that ends inside the episode drops the later phases silently', () => {
  const warnings = [];
  const w = console.warn;
  console.warn = (m) => warnings.push(m);
  let events;
  try {
    events = ECONOMIC_REGIMES.schedules({
      parameters: { shocks: [{ preset: 'STAGFLATION_1970S_LITE', startDate: SHOCK_START }] },
      accounts: [], endDate: new Date('2040-01-01'),
    });
  } finally { console.warn = w; }

  const shocks = events.filter(e => e.type === 'ECONOMIC_SHOCK');
  assert.deepEqual(shocks.map(e => e.date.toISOString().slice(0, 10)), ['2027-01-01', '2037-01-01']);
  assert.deepEqual(warnings, [], 'a preset past the run end is ordinary, not an authoring slip');
});
