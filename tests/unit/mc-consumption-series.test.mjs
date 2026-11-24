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
 * mc-consumption-series.test.mjs — the MC sampler's per-year REAL consumption reading
 * (`mc-run --consumption`).
 *
 * A consumption-utility scorecard needs each path's spending YEAR BY YEAR, because a
 * concave utility scores a smooth path above the same total spent unevenly. The sampler
 * reads `state.cumulativeConsumption` at each year boundary and `consumptionByYear`
 * differences it. Three claims: reading it does not perturb the run; the years sum back
 * to the lifetime total exactly; and the years line up with the yearly samples.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { loadScenarioSim } from '../helpers/scenario-harness.js';
import { computeNetWorth }  from '../../src/finance/derived-metrics/net-worth.js';
import { createMcSampler, extractYearlyTimeSeries } from '../../src/finance/monte-carlo/mc-sampling.js';
import { consumptionByYear, consumptionYears } from '../../scripts/lib/mc.mjs';

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2034, 0, 1));

function run(opts) {
  const { sim } = loadScenarioSim({
    simStart: SIM_START, simEnd: SIM_END, stepTo: SIM_END, telemetry: 'off', ...opts,
  });
  return sim;
}

test('MCCONS-1: sampling consumption does not perturb the run', () => {
  const bare  = run({});
  const with_ = run({ sampler: createMcSampler(), samplerCadence: 'year-boundary' });
  assert.equal(computeNetWorth(with_.state, 'USD'), computeNetWorth(bare.state, 'USD'));
  assert.equal(with_.state.cumulativeConsumption, bare.state.cumulativeConsumption);
});

test('MCCONS-2: yearly real spending sums back to the lifetime total', () => {
  const sim = run({ sampler: createMcSampler(), samplerCadence: 'year-boundary' });
  const ts  = extractYearlyTimeSeries(sim);
  const by  = consumptionByYear(ts);
  assert.equal(by.length, ts.length);
  assert.ok(sim.state.cumulativeConsumption > 0, 'the scenario spends something');
  for (const c of by) assert.ok(c >= 0, `a year's spending is never negative, got ${c}`);
  // Each entry is rounded, so allow half a dollar per year.
  const total = by.reduce((a, b) => a + b, 0);
  const last  = ts[ts.length - 1].consumption;
  assert.ok(Math.abs(total - last) <= by.length * 0.5, `sum ${total} vs cumulative ${last}`);
  assert.ok(Math.abs(last - sim.state.cumulativeConsumption) <= sim.state.cumulativeConsumption * 0.15,
    'the last yearly sample sits at (or just before) the end of the run');
});

test('MCCONS-3: years are calendar years in order, one per sample', () => {
  const sim = run({ sampler: createMcSampler(), samplerCadence: 'year-boundary' });
  const ys  = consumptionYears(extractYearlyTimeSeries(sim));
  assert.equal(ys[0], 2026);
  for (let i = 1; i < ys.length; i++) assert.equal(ys[i], ys[i - 1] + 1);
});
