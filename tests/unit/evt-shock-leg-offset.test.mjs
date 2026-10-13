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
 * evt-shock-leg-offset.test.mjs — a leg's `startMonths` (design 121 §3), split at schedule time.
 *
 * LAG-1  the shock is split by offset: one ECONOMIC_SHOCK per group, on its own date, with
 *        only its own legs; ticks span each group's longest leg from its own start
 * LAG-2  level effects fire ONCE, with the offset-0 group
 * LAG-3  no leg at 0: the level effects still fire on the shock's date, and add no regime
 * LAG-4  in the sim, the delayed leg is absent from activeRegimes before its date and live after
 * LAG-5  a severity sweep reaches the delayed group; a startDate sweep moves every group
 * LAG-6  absent the field (or every leg at 0), the schedule is identical, object for object
 * LAG-7  startMonths must be a non-negative integer
 * LAG-8  a group starting at or after the run's end is dropped with a warning
 * LAG-9  an optimizer/MPC rollout seeded from a snapshot before the delayed date sees the leg
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }           from '../../src/index.js';
import { ECONOMIC_REGIMES, applySeverity } from '../../src/scenarios/toolsets/economic-regimes-toolset.js';
import { SHOCK_LIBRARY }          from '../../src/finance/economic-shocks/shock-library.js';
import { EconomicShockHandler }   from '../../src/finance/economic-regimes/economic-shock-handler.js';
import { OptimizationProblem }    from '../../src/finance/optimization/optimization-problem.js';
import { OPTIMIZATION_OBJECTIVES } from '../../src/finance/optimization/optimization-objectives.js';

beforeEach(() => ServiceRegistry.resetAll());

const quiet = (fn) => {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; }
};

/** An equity leg now, a rates leg two years later, both L/12. */
function lagShock(overrides = {}) {
  return {
    shockId: 'LAG', name: 'Lag', startDate: '2027-01-01', severity: 0.20,
    levelEffects: { equityRevaluation: { rateKeys: ['EQUITY_US'], multiplier: -0.10 } },
    legs: [
      { id: 'now', regime: { returnAdjustment: { EQUITY_US: -0.02 } },
        recovery: { profile: 'L', durationMonths: 12 } },
      { id: 'later', startMonths: 24,
        regime: { interestRateAdjustment: { FIXED_INCOME_US: 0.03 },
                  returnAdjustment:       { FIXED_INCOME_US: 0.03 } },
        recovery: { profile: 'L', durationMonths: 18 } },
    ],
    ...overrides,
  };
}

const schedule = (shocks, endDate) => ECONOMIC_REGIMES.schedules({
  parameters: { shocks }, accounts: [], ...(endDate ? { endDate } : {}),
});
const day = (d) => d.toISOString().slice(0, 10);
const shocksOf = (events) => events.filter(e => e.type === 'ECONOMIC_SHOCK');
const ticksOf  = (events) => events.filter(e => e.type === 'ECONOMIC_RECOVERY_TICK');

test('LAG-1: the shock splits by offset, each group on its own date with its own legs', () => {
  const events = schedule([lagShock()]);
  const shocks = shocksOf(events);
  assert.deepEqual(shocks.map(e => day(e.date)), ['2027-01-01', '2029-01-01']);
  assert.deepEqual(shocks.map(e => e.data.shock.legs.map(l => l.id)), [['now'], ['later']]);
  assert.deepEqual(shocks.map(e => day(e.data.shock.startDate)), ['2027-01-01', '2029-01-01']);
  for (const e of shocks) assert.equal(e.data.shock.shockId, 'LAG', 'the episode keeps one id');

  // 12 ticks for the first group, 18 for the delayed one counted from ITS start.
  const ticks = ticksOf(events).map(e => day(e.date));
  assert.equal(ticks.length, 12 + 18);
  assert.equal(ticks[0], '2027-02-01');
  assert.equal(ticks[11], '2028-01-01');
  assert.equal(ticks[12], '2029-02-01');
  assert.equal(ticks[29], '2030-07-01');
});

test('LAG-2: level effects fire once, with the offset-0 group', () => {
  const [first, later] = shocksOf(schedule([lagShock()]));
  assert.ok(first.data.shock.levelEffects, 'the offset-0 group carries the level break');
  assert.equal(later.data.shock.levelEffects, undefined, 'the delayed group must not re-fire it');

  const handler = new EconomicShockHandler({ rateKeyToStateKeys: {}, allAccountStateKeys: ['a'] });
  const revals = (e) => handler.call({ data: e.data }).filter(a => a.type === 'REVALUE_ASSET_APPLY');
  assert.equal(revals(first).length, 1);
  assert.equal(revals(later).length, 0);
});

test('LAG-3: with no leg at 0 the level break stays on the shock date and adds no regime', () => {
  const shock = lagShock();
  shock.legs = shock.legs.map(l => ({ ...l, startMonths: l.id === 'now' ? 6 : 24 }));
  const events = schedule([shock]);
  const shocks = shocksOf(events);
  assert.deepEqual(shocks.map(e => day(e.date)), ['2027-01-01', '2027-07-01', '2029-01-01']);

  const levelOnly = shocks[0].data.shock;
  assert.deepEqual(levelOnly.legs, []);
  assert.ok(levelOnly.levelEffects);

  const handler = new EconomicShockHandler({ rateKeyToStateKeys: {}, allAccountStateKeys: ['a'] });
  const actions = handler.call({ data: shocks[0].data });
  assert.equal(actions.filter(a => a.type === 'ADD_REGIME_APPLY').length, 0,
    'a level-only group must not push a phantom regime (its tags would wake behavioral strategies)');
  assert.equal(actions.filter(a => a.type === 'REVALUE_ASSET_APPLY').length, 1);
  // No ticks for the level-only group: 12 + 18.
  assert.equal(ticksOf(events).length, 30);
});

// ─── In the sim ──────────────────────────────────────────────────────────────

const SIM_START = new Date('2026-01-01');
const BASE_CFG = {
  toolsets:   ['US_BANKING', 'US_TAX', 'US_RETIREMENT', 'ECONOMIC_REGIMES'],
  simStart:   '2026-01-01',
  parameters: {
    monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
    usEquityGrowthRate: 0, intlExUsEquityGrowthRate: 0,
    usEquityDividendYield: 0, intlExUsEquityDividendYield: 0,
    fixedIncomeInterestRate: 0.04, usSavingsInterestRate: 0,
  },
  persons: [{
    __type: 'Person', id: 'primary', name: 'Primary',
    birthDate: '1975-04-15', citizen: ['US'], lifeExpectancy: 90,
    monthlyWage: 0, retirementDate: '2025-01-01', socialSecurityMonthly: 0,
  }],
  accounts: [{
    __type: 'SavingsAccount', id: 'checking', name: 'Checking',
    role: 'us-savings', stateKey: 'checkingAccount',
    initialValue: 50000, ownershipType: 'sole', ownerId: 'primary',
    minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
  }],
};

function loadScenario(shocks, simEnd = '2032-01-01') {
  const cfg = structuredClone(BASE_CFG);
  cfg.parameters.shocks = shocks;
  cfg.simEnd = simEnd;
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context: services.simulationContext, simStart: SIM_START, simEnd: new Date(simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);
  return scenario.sim;
}

const liveIds = (sim) => (sim.state.activeRegimes ?? []).map(r => r.id);

test('LAG-4: the delayed leg is absent before its date and live after it', () => {
  const sim = loadScenario([lagShock()]);
  const fiDelta = () => sim.state.effectiveInterestRates.FIXED_INCOME_US
    - sim.state.baseInterestRates.FIXED_INCOME_US;

  sim.stepTo(new Date('2027-06-01'));
  assert.deepEqual(liveIds(sim), ['regime-LAG-now']);
  assert.ok(Math.abs(fiDelta()) < 1e-12, 'no rate move during the first leg');

  sim.stepTo(new Date('2028-12-15'));
  assert.ok(!liveIds(sim).includes('regime-LAG-later'),
    `the delayed leg must not be in force a fortnight early, got ${liveIds(sim)}`);
  assert.ok(Math.abs(fiDelta()) < 1e-12);

  sim.stepTo(new Date('2029-06-01'));
  assert.ok(liveIds(sim).includes('regime-LAG-later'), `got ${liveIds(sim)}`);
  assert.ok(Math.abs(fiDelta() - 0.03) < 1e-12, `the leg is at full strength, got ${fiDelta()}`);

  sim.stepTo(new Date('2031-01-01'));
  assert.ok(!liveIds(sim).includes('regime-LAG-later'), 'and gone after its 18 months');
  assert.ok(Math.abs(fiDelta()) < 1e-12);
});

test('LAG-5: severity reaches the delayed group; a startDate sweep moves every group', () => {
  // An MC sweep writes `severity` onto a preset entry and `resolveShockEntry` applies it before
  // `scheduleShock` sees the shock. The library is frozen, so apply it the same way here: the
  // swept shock must reach the delayed group with its scaled values.
  const swept = applySeverity(lagShock(), 0.40);
  const [, later] = shocksOf(schedule([swept]));
  const ra = later.data.shock.legs[0].regime.returnAdjustment.FIXED_INCOME_US;
  assert.ok(Math.abs(ra - 0.06) < 1e-12, `k = 2 must reach the delayed leg, got ${ra}`);
  assert.equal(later.data.shock.severity, 0.40);

  const moved = shocksOf(schedule([lagShock({ startDate: '2030-04-01' })]));
  assert.deepEqual(moved.map(e => day(e.date)), ['2030-04-01', '2032-04-01']);
});

test('LAG-6: absent the field, or with every leg at 0, the schedule is unchanged', () => {
  for (const [id, preset] of Object.entries(SHOCK_LIBRARY)) {
    const entry  = { preset: id, startDate: '2030-01-01' };
    const before = schedule([entry]);
    assert.equal(shocksOf(before).length, 1, `${id}: one event`);

    if (!Array.isArray(preset.legs)) continue;
    const zeroed = { ...preset, startDate: new Date('2030-01-01'),
      legs: preset.legs.map(l => ({ ...l, startMonths: 0 })) };
    const after = schedule([zeroed]);
    assert.equal(shocksOf(after).length, 1, `${id}: explicit 0 does not split`);
    assert.deepEqual(ticksOf(after).map(e => +e.date), ticksOf(before).map(e => +e.date),
      `${id}: ticks unchanged`);
  }
  // The undelayed path hands the handler the resolved shock itself, not a copy.
  const custom = { ...lagShock({ severity: undefined }), legs: lagShock().legs.map(({ startMonths, ...l }) => l) };
  assert.equal(shocksOf(schedule([custom]))[0].data.shock, custom);
});

test('LAG-7: startMonths must be a non-negative integer', () => {
  for (const bad of [-1, 1.5, '12', NaN]) {
    const shock = lagShock();
    shock.legs[1].startMonths = bad;
    assert.throws(() => schedule([shock]), /Shock "LAG" leg "later": startMonths must be/,
      `${JSON.stringify(bad)} must be refused`);
  }
});

test('LAG-8: a group starting at or after the run end is dropped with a warning', () => {
  const warnings = [];
  const w = console.warn;
  console.warn = (m) => warnings.push(m);
  let events;
  try { events = schedule([lagShock()], new Date('2029-01-01')); } finally { console.warn = w; }

  assert.deepEqual(shocksOf(events).map(e => day(e.date)), ['2027-01-01']);
  assert.equal(ticksOf(events).length, 12);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Shock "LAG": leg\(s\) "later" start 24 months after 2027-01-01/);
});

// ─── Rollouts ────────────────────────────────────────────────────────────────

test('LAG-9: a rollout seeded before the delayed date sees the delayed leg', () => {
  // A snapshot keeps the compile's queue (design 39 §14.9.4), so the delayed ECONOMIC_SHOCK must
  // be in it — and the seeded sim must put the leg in force on its date, as a t₀ compile does.
  const RUN_START = new Date(Date.UTC(2026, 0, 1));
  const RUN_END   = new Date(Date.UTC(2050, 0, 1));
  const AS_OF     = new Date(Date.UTC(2045, 0, 1));
  const params = { shocks: [lagShock({ startDate: '2044-01-01' })] };   // later leg: 2046-01-01
  const problem = (initialState) => new OptimizationProblem({
    variables: [], baseParams: params, objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
    simStart: RUN_START, simEnd: RUN_END, initialState,
  });
  const seededFrom = (p) => p._seededSim({ ...p._resolveBase(), endDate: RUN_END });

  const snapshot = quiet(() => problem({ kind: 'compile', cfgTemplate: null }).rollToSnapshot({}, AS_OF));
  const seeded   = quiet(() => seededFrom(problem({ kind: 'snapshot', snapshot, cfgTemplate: null })));

  const pending = seeded.cloneQueue()
    .filter(e => e.type === 'ECONOMIC_SHOCK' && e.date > AS_OF)
    .map(e => [day(e.date), e.data.shock.legs.map(l => l.id)]);
  assert.deepEqual(pending, [['2046-01-01', ['later']]]);

  assert.ok(!liveIds(seeded).includes('regime-LAG-later'));
  quiet(() => seeded.stepTo(new Date(Date.UTC(2046, 5, 1))));
  assert.ok(liveIds(seeded).includes('regime-LAG-later'), `got ${liveIds(seeded)}`);
});
