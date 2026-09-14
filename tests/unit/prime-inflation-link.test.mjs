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
 * prime-inflation-link.test.mjs — design 104 (the prime rate follows inflation).
 *
 *   - the rule: primeDev_t = ρ·primeDev_{t−1} + (1−ρ)·β·inflationDev_t, with optional noise
 *     that draws only when it is above 0;
 *   - the step reducer and the fold (with its floor) and what follows it downstream:
 *     prime-linked cash accounts (PrimeRelinkReducer) and variable loans (resolveLoanRate);
 *   - the modes are either/or: "follows inflation" ignores the Prime Rate Schedule, and the
 *     default mode keeps it;
 *   - Monte Carlo's mode resolution and pairing record;
 *   - the UI shows the schedule only in schedule mode and the link settings only in link mode.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { InflationTickHandler } from '../../src/finance/economic-regimes/inflation-tick-handler.js';
import { InflationStepReducer } from '../../src/finance/economic-regimes/inflation-step-reducer.js';
import { InflationPathReducer } from '../../src/finance/economic-regimes/inflation-path-reducer.js';
import { PrimeRelinkReducer }   from '../../src/finance/economic-regimes/prime-relink-reducer.js';
import { resolveLoanRate }      from '../../src/finance/account-rules/loan-classes.js';
import { mcPrimeModel, perturbParams } from '../../src/finance/monte-carlo/parallel/mc-worker-core.js';
import { pairingMismatches }    from '../../src/finance/monte-carlo/mc-analysis.js';
import { IntlRetirementMcRunner } from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { IntlRetirementMcConfig } from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { loadScenarioSim }      from '../helpers/scenario-harness.js';

const mkRng = (seed = 42) => {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
};
const countingRng = (inner = mkRng()) => { const r = () => { r.calls++; return inner(); }; r.calls = 0; return r; };
const noRng = () => { throw new Error('must not draw'); };

const PRIME = { beta: { US: 1.3, AU: 1.3 }, rho: { US: 0.6, AU: 0.75 }, noise: { US: 0, AU: 0 }, floor: { US: 0.0025, AU: 0.001 } };

// ─── the rule ────────────────────────────────────────────────────────────────────

describe('InflationTickHandler — prime link', () => {
  test('primeDev moves (1−ρ) of the way toward β × the inflation deviation each year', () => {
    const h = new InflationTickHandler({ model: 'HISTORICAL_JOINT', prime: PRIME });
    const state = { equityReturnBootstrap: { year: 1974 }, inflationDev: { US: 0.01, AU: 0.0 }, primeDev: { US: 0.004, AU: -0.002 } };
    const a = h.call({ sim: { rng: noRng }, state })[0];
    for (const cc of ['US', 'AU']) {
      const expected = PRIME.rho[cc] * state.primeDev[cc] + (1 - PRIME.rho[cc]) * PRIME.beta[cc] * a.deviation[cc];
      assert.ok(Math.abs(a.primeDeviation[cc] - expected) < 1e-15, cc);
    }
    assert.deepEqual(a.primeFloor, PRIME.floor);
  });

  test('a sustained inflation deviation settles at β times it', () => {
    // Hold inflation at +2 points by feeding the same deviation back; the prime deviation
    // converges on 1.3 × 2 = 2.6 points.
    const h = new InflationTickHandler({ prime: PRIME, vol: { US: 0, AU: 0 } });
    let state = { inflationDev: { US: 0.02, AU: 0.02 }, primeDev: { US: 0, AU: 0 } };
    for (let t = 0; t < 60; t++) {
      const a = h.call({ sim: { rng: mkRng(t) }, state: { ...state, inflationDev: { US: 0.02 / Math.exp(-0.33), AU: 0.02 / Math.exp(-0.33) } } })[0];
      state = { ...state, primeDev: a.primeDeviation };
    }
    assert.ok(Math.abs(state.primeDev.US - 0.026) < 1e-6, `US ${state.primeDev.US}`);
    assert.ok(Math.abs(state.primeDev.AU - 0.026) < 1e-6, `AU ${state.primeDev.AU}`);
  });

  test('noise 0 draws nothing extra; noise above 0 draws one Gaussian per country', () => {
    const quiet = countingRng();
    new InflationTickHandler({ prime: PRIME }).call({ sim: { rng: quiet }, state: {} });
    assert.equal(quiet.calls, 4, 'the inflation draws only');
    const noisy = countingRng();
    new InflationTickHandler({ prime: { ...PRIME, noise: { US: 0.013, AU: 0.009 } } }).call({ sim: { rng: noisy }, state: {} });
    assert.equal(noisy.calls, 8);
  });

  test('without the link the action carries no prime fields', () => {
    const a = new InflationTickHandler().call({ sim: { rng: mkRng() }, state: {} })[0];
    assert.ok(!('primeDeviation' in a) && !('primeFloor' in a));
  });

  test('toJSON / fromJSON round-trips the link', () => {
    assert.deepEqual(InflationTickHandler.fromJSON(new InflationTickHandler({ prime: PRIME }).toJSON()).prime, PRIME);
  });
});

// ─── reducers and what follows prime ─────────────────────────────────────────────

describe('the prime fold and its consumers', () => {
  const folded = (primeDev, prime = 0.045) => {
    let st = new InflationStepReducer().reduce({}, { type: 'INFLATION_STEP_APPLY', deviation: { US: 0, AU: 0 }, primeDeviation: primeDev, primeFloor: PRIME.floor });
    st = {
      ...st,
      baseInterestRates:      { PRIME_US: prime, PRIME_AU: 0.0435, 'SAVINGS_US::cash': prime + 0.01 },
      effectiveInterestRates: { PRIME_US: prime, PRIME_AU: 0.0435, 'SAVINGS_US::cash': prime + 0.01 },
      primeLinks:             [{ stateKey: 'cash', savKey: 'SAVINGS_US', primeKey: 'PRIME_US', spread: 0.01 }],
    };
    st = new InflationPathReducer().reduce(st, { type: 'US_PERIOD_ADVANCE' });
    return new PrimeRelinkReducer().reduce(st, { type: 'US_PERIOD_ADVANCE' });
  };

  test('the step stores the deviation and floor only when the link sent them', () => {
    const r = new InflationStepReducer();
    assert.ok(!('primeDev' in r.reduce({}, { type: 'INFLATION_STEP_APPLY', deviation: { US: 0 } })));
    const st = r.reduce({}, { type: 'INFLATION_STEP_APPLY', deviation: { US: 0 }, primeDeviation: { US: 0.01 }, primeFloor: { US: 0.0025 } });
    assert.deepEqual(st.primeDev, { US: 0.01 });
    assert.deepEqual(st.primeFloor, { US: 0.0025 });
  });

  test('prime moves, and a prime-linked cash account and a variable loan follow it', () => {
    const st = folded({ US: 0.02, AU: 0 });
    assert.ok(Math.abs(st.effectiveInterestRates.PRIME_US - 0.065) < 1e-12);
    assert.ok(Math.abs(st.effectiveInterestRates['SAVINGS_US::cash'] - 0.075) < 1e-12, 'cash keeps its +1 point spread');
    const loan = { country: 'US', primeSpread: -0.0163 };
    assert.ok(Math.abs(resolveLoanRate(st, loan) - (0.065 - 0.0163)) < 1e-12);
  });

  test('prime is clamped at its floor', () => {
    const st = folded({ US: -0.10, AU: 0 });
    assert.equal(st.effectiveInterestRates.PRIME_US, 0.0025);
  });

  test('no prime deviation leaves prime alone', () => {
    const st = folded({ US: 0, AU: 0 });
    assert.equal(st.effectiveInterestRates.PRIME_US, 0.045);
  });
});

// ─── either/or, e2e ──────────────────────────────────────────────────────────────

describe('Prime Rate Mode — e2e', () => {
  const END = Date.UTC(2036, 0, 1);
  const SCHEDULE = [{ year: 2030, PRIME_US: 0.08 }];
  const run = (params) => loadScenarioSim({ telemetry: 'off', simEnd: END, stepTo: END, params: { randomSeed: 7, ...params } });

  test('the default mode keeps the schedule', () => {
    const st = run({ primeSchedule: SCHEDULE }).sim.state;
    assert.ok(Math.abs(st.effectiveInterestRates.PRIME_US - 0.08) < 1e-12);
    assert.ok(!('primeDev' in st));
  });

  test('"follows inflation" ignores the schedule, and prime follows the inflation path', () => {
    const st = run({ primeSchedule: SCHEDULE, primeRateModel: 'INFLATION_LINKED', inflationStochastic: true }).sim.state;
    assert.ok(st.primeDev, 'the link ran');
    const expected = Math.max(0.0025, st.baseInterestRates.PRIME_US + st.primeDev.US);
    assert.ok(Math.abs(st.effectiveInterestRates.PRIME_US - expected) < 1e-12, 'prime = seed + the link, with no schedule step');
  });

  test('"follows inflation" without the inflation path leaves prime at its setting', () => {
    const st = run({ primeSchedule: SCHEDULE, primeRateModel: 'INFLATION_LINKED' }).sim.state;
    assert.equal(st.effectiveInterestRates.PRIME_US, st.baseInterestRates.PRIME_US);
  });

  test('the UI shows the schedule only in schedule mode, and the link settings only in link mode', () => {
    const params = run({}).cfg.params;
    const vis = (name) => params.find(p => p.name === name)?.visibleWhen;
    assert.deepEqual(vis('primeSchedule'), { param: 'primeRateModel', equals: 'SCHEDULE' });
    for (const k of ['primeInflationResponseUs', 'primeInflationResponseAu', 'primeInflationSmoothingUs', 'primeInflationSmoothingAu',
                     'primeFloorUs', 'primeFloorAu', 'primePolicyNoiseUs', 'primePolicyNoiseAu']) {
      assert.deepEqual(vis(k), { param: 'primeRateModel', equals: 'INFLATION_LINKED' }, k);
    }
  });
});

// ─── Monte Carlo ─────────────────────────────────────────────────────────────────

describe('Monte Carlo prime mode', () => {
  test('AUTO follows inflation unless the plan has a schedule; SCENARIO defers; explicit wins', () => {
    assert.equal(mcPrimeModel({}), 'INFLATION_LINKED');
    assert.equal(mcPrimeModel({ primeSchedule: [{ year: 2030, PRIME_US: 0.05 }] }), 'SCHEDULE', 'a written schedule is kept');
    assert.equal(mcPrimeModel({ mcInflationPath: false }), 'SCHEDULE', 'nothing to follow');
    assert.equal(mcPrimeModel({ primeRateModel: 'INFLATION_LINKED', primeSchedule: [{ year: 2030 }] }), 'INFLATION_LINKED');
    assert.equal(mcPrimeModel({ mcPrimeRateModel: 'SCENARIO' }), 'SCHEDULE');
    assert.equal(mcPrimeModel({ mcPrimeRateModel: 'SCHEDULE' }), 'SCHEDULE');
  });

  test('perturbParams writes the resolved mode into each path', () => {
    assert.equal(perturbParams({}, 0, []).primeRateModel, 'INFLATION_LINKED');
    assert.equal(perturbParams({ mcInflationPath: false }, 0, []).primeRateModel, 'SCHEDULE');
  });

  test('a batch records its prime mode, and a change is flagged as unpaired', async () => {
    const SIM_START = new Date(Date.UTC(2026, 0, 1)), SIM_END = new Date(Date.UTC(2028, 1, 1));
    const cfgTemplate = IntlRetirementScenario.buildDefaultConfig({ fxProcessModel: 'NONE' }, SIM_START, SIM_END);
    const runner = () => new IntlRetirementMcRunner({ n: 2, simStart: SIM_START, simEnd: SIM_END, cfgTemplate, mcConfig: new IntlRetirementMcConfig() });
    const def = await runner().run();
    assert.equal(def.summary.pairing.primeModel, 'INFLATION_LINKED');
    const sched = await runner().run({ mcPrimeRateModel: 'SCHEDULE' });
    assert.deepEqual(pairingMismatches(def.summary.pairing, sched.summary.pairing), ['prime rate mode INFLATION_LINKED vs SCHEDULE']);
  });
});
