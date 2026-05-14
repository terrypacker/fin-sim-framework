/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * scenario.test.mjs
 * Tests for ScenarioRunner
 * Run with: node --test tests/scenario.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ScenarioRunner } from '../../src/simulation-framework/scenario.js';
import { Simulation }     from '../../src/simulation-framework/simulation.js';
import { DateUtils }      from '../../src/simulation-framework/date-utils.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Minimal runner: each sim accumulates a counter driven by a seeded RNG
function makeRunner() {
  return new ScenarioRunner({
    createSimulation: (params, seed) => {
      const sim = new Simulation(params.startDate, { seed, initialState: { total: 0 } });

      sim.reducers.register('ADD', (state, action) => ({
        ...state,
        total: state.total + action.value
      }));

      sim.register('QUARTERLY_PL', ({ sim }) => [
        { type: 'ADD', value: params.drift + sim.rng() * params.vol }
      ]);

      sim.scheduleRecurring({
        startDate:  params.startDate,
        type:       'QUARTERLY_PL',
        intervalFn: d => DateUtils.addMonths(d, 3)
      });

      return sim;
    },

    evaluate: (sim) => ({ total: sim.state.total })
  });
}

const BASE_PARAMS = {
  startDate: new Date(2025, 0, 1),
  endDate:   new Date(2030, 0, 1),
  drift:     0.02,
  vol:       0.05
};

// ─── runScenario ──────────────────────────────────────────────────────────────

test('ScenarioRunner.runScenario: returns the result of evaluate', () => {
  const runner = makeRunner();
  const result = runner.runScenario(BASE_PARAMS, 1);

  assert.ok(typeof result.total === 'number', 'result.total should be a number');
  assert.ok(result.total > 0, 'total should be positive after 5 years of drift');
});

test('ScenarioRunner.runScenario: same seed produces identical result', () => {
  const runner  = makeRunner();
  const result1 = runner.runScenario(BASE_PARAMS, 42);
  const result2 = runner.runScenario(BASE_PARAMS, 42);

  assert.strictEqual(result1.total, result2.total);
});

test('ScenarioRunner.runScenario: different seeds produce different results', () => {
  const runner  = makeRunner();
  const result1 = runner.runScenario(BASE_PARAMS, 1);
  const result2 = runner.runScenario(BASE_PARAMS, 2);

  assert.notStrictEqual(result1.total, result2.total);
});

// ─── runBatch ─────────────────────────────────────────────────────────────────

test('ScenarioRunner.runBatch: returns one result per scenario', () => {
  const runner = makeRunner();

  const batch = [
    { params: BASE_PARAMS, seed: 1 },
    { params: BASE_PARAMS, seed: 2 },
    { params: BASE_PARAMS, seed: 3 },
  ];

  const results = runner.runBatch({ scenarios: batch });

  assert.strictEqual(results.length, 3);
});

test('ScenarioRunner.runBatch: each result carries the original scenario fields', () => {
  const runner = makeRunner();

  const results = runner.runBatch({
    scenarios: [{ params: BASE_PARAMS, seed: 7 }]
  });

  assert.strictEqual(results[0].seed, 7);
  assert.ok('result' in results[0], 'result field should be present');
});

test('ScenarioRunner.runBatch: returns empty array for empty scenarios list', () => {
  const runner  = makeRunner();
  const results = runner.runBatch({ scenarios: [] });

  assert.deepStrictEqual(results, []);
});

// ─── monteCarlo ───────────────────────────────────────────────────────────────

test('ScenarioRunner.monteCarlo: returns exactly n results', () => {
  const runner  = makeRunner();
  const results = runner.monteCarlo({
    n:          100,
    baseParams: BASE_PARAMS,
    perturb:    (base, i) => ({ ...base, drift: base.drift + (i * 0.0001) })
  });

  assert.strictEqual(results.length, 100);
});

test('ScenarioRunner.monteCarlo: each run uses a unique seed (1-based)', () => {
  const runner = makeRunner();
  const seeds  = [];

  // Override createSimulation to capture seeds
  const capturingRunner = new ScenarioRunner({
    createSimulation: (params, seed) => {
      seeds.push(seed);
      return makeRunner().createSimulation(params, seed);
    },
    evaluate: (sim) => ({ total: sim.state.total })
  });

  capturingRunner.monteCarlo({ n: 5, baseParams: BASE_PARAMS, perturb: b => b });

  assert.deepStrictEqual(seeds, [1, 2, 3, 4, 5]);
});

test('ScenarioRunner.monteCarlo: perturb function receives base params and index', () => {
  const runner   = makeRunner();
  const captured = [];

  runner.monteCarlo({
    n:          3,
    baseParams: BASE_PARAMS,
    perturb:    (base, i) => {
      captured.push({ base, i });
      return base;
    }
  });

  assert.strictEqual(captured.length, 3);
  assert.strictEqual(captured[0].i, 0);
  assert.strictEqual(captured[1].i, 1);
  assert.strictEqual(captured[2].i, 2);
  assert.strictEqual(captured[0].base, BASE_PARAMS);
});

// ─── summarize ────────────────────────────────────────────────────────────────

test('ScenarioRunner.summarize: mean is the arithmetic average of mapped values', () => {
  const runner  = makeRunner();
  const results = [{ v: 10 }, { v: 20 }, { v: 30 }];
  const { mean } = runner.summarize(results, r => r.v);

  assert.strictEqual(mean, 20);
});

test('ScenarioRunner.summarize: p10 is the value at the 10th percentile', () => {
  const runner  = makeRunner();
  // 10 values: 10, 20, ..., 100
  const results = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(v => ({ v }));
  const { p10 } = runner.summarize(results, r => r.v);

  // floor(10 * 0.1) = index 1 → value 20
  assert.strictEqual(p10, 20);
});

test('ScenarioRunner.summarize: p50 is the median value', () => {
  const runner  = makeRunner();
  const results = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(v => ({ v }));
  const { p50 } = runner.summarize(results, r => r.v);

  // floor(10 * 0.5) = index 5 → value 60
  assert.strictEqual(p50, 60);
});

test('ScenarioRunner.summarize: p90 is the value at the 90th percentile', () => {
  const runner  = makeRunner();
  const results = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(v => ({ v }));
  const { p90 } = runner.summarize(results, r => r.v);

  // floor(10 * 0.9) = index 9 → value 100
  assert.strictEqual(p90, 100);
});

test('ScenarioRunner.summarize: sorts values before computing percentiles', () => {
  const runner  = makeRunner();
  // Provide in reverse order; summarize must sort ascending
  const results = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10].map(v => ({ v }));
  const { mean, p10 } = runner.summarize(results, r => r.v);

  assert.strictEqual(mean, 55);
  assert.strictEqual(p10, 20);  // same result as sorted input
});

test('ScenarioRunner.summarize: single result has mean equal to that value', () => {
  const runner  = makeRunner();
  const { mean, p10, p50, p90 } = runner.summarize([{ v: 42 }], r => r.v);

  assert.strictEqual(mean, 42);
  // All percentiles collapse to the only value
  assert.strictEqual(p10, 42);
  assert.strictEqual(p50, 42);
  assert.strictEqual(p90, 42);
});

// ─── summarize with mapFailure ────────────────────────────────────────────────

const mapFailure = r => ({ failed: r.scenarioFailed, outOfFundsDate: r.outOfFundsDate });

test('ScenarioRunner.summarize: successRate is 1.0 when no runs failed', () => {
  const runner  = makeRunner();
  const results = [
    { v: 10, scenarioFailed: false, outOfFundsDate: null },
    { v: 20, scenarioFailed: false, outOfFundsDate: null },
    { v: 30, scenarioFailed: false, outOfFundsDate: null },
  ];

  const { successRate, failureCount } = runner.summarize(results, r => r.v, mapFailure);

  assert.strictEqual(successRate, 1.0);
  assert.strictEqual(failureCount, 0);
});

test('ScenarioRunner.summarize: successRate is 0 when all runs failed', () => {
  const runner  = makeRunner();
  const d       = new Date(2030, 0, 1);
  const results = [
    { v: 10, scenarioFailed: true, outOfFundsDate: d },
    { v: 20, scenarioFailed: true, outOfFundsDate: d },
  ];

  const { successRate, failureCount } = runner.summarize(results, r => r.v, mapFailure);

  assert.strictEqual(successRate, 0);
  assert.strictEqual(failureCount, 2);
});

test('ScenarioRunner.summarize: successRate reflects partial failures', () => {
  const runner  = makeRunner();
  const d       = new Date(2031, 3, 1);
  const results = [
    { v: 10, scenarioFailed: false, outOfFundsDate: null },
    { v: 20, scenarioFailed: false, outOfFundsDate: null },
    { v: 30, scenarioFailed: true,  outOfFundsDate: d },
    { v: 40, scenarioFailed: true,  outOfFundsDate: d },
  ];

  const { successRate, failureCount } = runner.summarize(results, r => r.v, mapFailure);

  assert.strictEqual(successRate, 0.5);
  assert.strictEqual(failureCount, 2);
});

test('ScenarioRunner.summarize: medianOutOfFundsDate is median of failed run dates', () => {
  const runner = makeRunner();
  // Three failure dates; median (index floor(3*0.5)=1) is the middle one
  const d1 = new Date(2028, 0, 1);
  const d2 = new Date(2030, 0, 1);
  const d3 = new Date(2035, 0, 1);
  const results = [
    { v: 1, scenarioFailed: false, outOfFundsDate: null },
    { v: 2, scenarioFailed: true,  outOfFundsDate: d3 },
    { v: 3, scenarioFailed: true,  outOfFundsDate: d1 },
    { v: 4, scenarioFailed: true,  outOfFundsDate: d2 },
  ];

  const { medianOutOfFundsDate } = runner.summarize(results, r => r.v, mapFailure);

  assert.strictEqual(medianOutOfFundsDate.getTime(), d2.getTime());
});

test('ScenarioRunner.summarize: medianOutOfFundsDate is absent when no failures', () => {
  const runner  = makeRunner();
  const results = [{ v: 1, scenarioFailed: false, outOfFundsDate: null }];

  const summary = runner.summarize(results, r => r.v, mapFailure);

  assert.strictEqual('medianOutOfFundsDate' in summary, false);
});

test('ScenarioRunner.summarize: omitting mapFailure produces no failure fields', () => {
  const runner  = makeRunner();
  const results = [{ v: 10 }, { v: 20 }];

  const summary = runner.summarize(results, r => r.v);

  assert.strictEqual('successRate'          in summary, false);
  assert.strictEqual('failureCount'         in summary, false);
  assert.strictEqual('medianOutOfFundsDate' in summary, false);
});

// ─── summarize with deficit tracking ─────────────────────────────────────────

const mapFailureWithDeficit = r => ({
  failed:            r.scenarioFailed,
  outOfFundsDate:    r.outOfFundsDate,
  cumulativeDeficit: r.cumulativeDeficit ?? 0,
  deficitMonths:     r.deficitMonths ?? 0,
});

test('ScenarioRunner.summarize: p50Deficit is median cumulativeDeficit across failed runs', () => {
  const runner = makeRunner();
  const d      = new Date(2030, 0, 1);
  const results = [
    { v: 1, scenarioFailed: false, outOfFundsDate: null,  cumulativeDeficit: 0,      deficitMonths: 0 },
    { v: 2, scenarioFailed: true,  outOfFundsDate: d,     cumulativeDeficit: 10_000, deficitMonths: 12 },
    { v: 3, scenarioFailed: true,  outOfFundsDate: d,     cumulativeDeficit: 30_000, deficitMonths: 24 },
    { v: 4, scenarioFailed: true,  outOfFundsDate: d,     cumulativeDeficit: 50_000, deficitMonths: 36 },
  ];

  const { p50Deficit } = runner.summarize(results, r => r.v, mapFailureWithDeficit);

  // sorted deficits: [10000, 30000, 50000]; floor(3*0.5)=1 → 30000
  assert.strictEqual(p50Deficit, 30_000);
});

test('ScenarioRunner.summarize: p90Deficit is 90th-percentile cumulativeDeficit across failed runs', () => {
  const runner = makeRunner();
  const d      = new Date(2030, 0, 1);
  const results = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i, idx) => ({
    v: i,
    scenarioFailed: true,
    outOfFundsDate: d,
    cumulativeDeficit: i * 1_000,
    deficitMonths: i,
  }));

  const { p90Deficit } = runner.summarize(results, r => r.v, mapFailureWithDeficit);

  // floor(10*0.9) = index 9 → 10000
  assert.strictEqual(p90Deficit, 10_000);
});

test('ScenarioRunner.summarize: p50DeficitMonths is median deficitMonths across failed runs', () => {
  const runner = makeRunner();
  const d      = new Date(2030, 0, 1);
  const results = [
    { v: 1, scenarioFailed: true, outOfFundsDate: d, cumulativeDeficit: 1000, deficitMonths: 6  },
    { v: 2, scenarioFailed: true, outOfFundsDate: d, cumulativeDeficit: 2000, deficitMonths: 18 },
    { v: 3, scenarioFailed: true, outOfFundsDate: d, cumulativeDeficit: 3000, deficitMonths: 36 },
  ];

  const { p50DeficitMonths } = runner.summarize(results, r => r.v, mapFailureWithDeficit);

  // floor(3*0.5) = index 1 → 18
  assert.strictEqual(p50DeficitMonths, 18);
});

test('ScenarioRunner.summarize: deficit fields absent when no runs failed', () => {
  const runner  = makeRunner();
  const results = [
    { v: 10, scenarioFailed: false, outOfFundsDate: null, cumulativeDeficit: 0, deficitMonths: 0 },
  ];

  const summary = runner.summarize(results, r => r.v, mapFailureWithDeficit);

  assert.strictEqual('p50Deficit'      in summary, false);
  assert.strictEqual('p90Deficit'      in summary, false);
  assert.strictEqual('p50DeficitMonths' in summary, false);
  assert.strictEqual('p90DeficitMonths' in summary, false);
});

// ─── optimize ─────────────────────────────────────────────────────────────────

test('ScenarioRunner.optimize: returns bestParams and bestScore', () => {
  const runner = makeRunner();

  const { bestParams, bestScore } = runner.optimize({
    initialParams:    { ...BASE_PARAMS, drift: 0.01 },
    runner,
    iterations:       5,
    mutate:           (p) => ({ ...p, drift: p.drift + 0.01 }),
    mapResultToScore: (r) => r.total
  });

  assert.ok(typeof bestScore  === 'number', 'bestScore should be a number');
  assert.ok(typeof bestParams === 'object', 'bestParams should be an object');
  assert.ok(bestScore > 0, 'bestScore should be positive');
});

test('ScenarioRunner.optimize: higher drift yields higher score', () => {
  const runner = makeRunner();

  // Each iteration increases drift by a fixed amount; best should be the last one
  let iterCount = 0;

  const { bestParams } = runner.optimize({
    initialParams:    { ...BASE_PARAMS, drift: 0.01 },
    runner,
    iterations:       5,
    mutate:           (p) => ({ ...p, drift: p.drift + 0.01 }),
    mapResultToScore: (r) => r.total
  });

  // Best drift should be greater than the starting drift
  assert.ok(
    bestParams.drift > 0.01,
    `bestParams.drift (${bestParams.drift}) should exceed starting drift 0.01`
  );
});
