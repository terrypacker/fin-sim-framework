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
 * mc-mix-sampler.test.mjs — design 82 §8.1/§8.3.
 *
 * Two properties, and the first is the one that would be catastrophic and silent.
 *
 * **The sampler must be INERT on the run.** It is handed LIVE state, not a snapshot
 * (design 78 §4.5 — that is the whole point: a clone per event was the cost being
 * removed). So a cube build that wrote anything back — a normalized field, a lazily
 * materialized holding, a memo — would perturb the very simulation it is describing,
 * and every downstream MC number would be measuring the measurement. Nothing else in
 * the pipeline would notice.
 *
 * **The record must retain nothing from state.** Same contract: a retained reference
 * would alias an object that keeps mutating, so a "2040 sample" would quietly become
 * whatever 2069 left behind.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { loadScenarioSim } from '../helpers/scenario-harness.js';
import { computeNetWorth }  from '../../src/finance/derived-metrics/net-worth.js';
import { createMcSampler }  from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { MIX_CLASSES }      from '../../src/finance/allocation-reporting/mix-distribution.js';

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2034, 0, 1));

function run(opts) {
  const { sim } = loadScenarioSim({
    simStart: SIM_START, simEnd: SIM_END, stepTo: SIM_END, telemetry: 'off', ...opts,
  });
  return sim;
}

test('MCMIX-1: sampling the mix does not perturb the run, to the last digit', () => {
  const bare = run({});
  const with_ = run({ sampler: createMcSampler({ mix: true }), samplerCadence: 'year-boundary' });

  // Not `assert.ok(Math.abs(a - b) < 1)` — an exact match is the claim. Anything the
  // cube wrote back would show up as a difference here and nowhere else.
  assert.equal(computeNetWorth(with_.state, 'USD'), computeNetWorth(bare.state, 'USD'));
  assert.equal(with_.state.scenarioFailed ?? false, bare.state.scenarioFailed ?? false);
  assert.equal(String(with_.state.outOfFundsDate ?? null), String(bare.state.outOfFundsDate ?? null));
});

test('MCMIX-2: the record carries the mix vector plus its denominator', () => {
  const sim = run({ sampler: createMcSampler({ mix: true }), samplerCadence: 'year-boundary' });

  assert.ok(sim.samples.length >= 8, `one sample per year, got ${sim.samples.length}`);
  for (const s of sim.samples) {
    assert.equal(typeof s.grossAssetsUsd, 'number');
    assert.deepEqual(Object.keys(s.mix), [...MIX_CLASSES]);
    // Shares of gross assets sum to 1 whenever anything is held. The denominator
    // travels with them because a zero-gross sample is ABSENT, not a mix of zeros.
    const total = Object.values(s.mix).reduce((a, b) => a + b, 0);
    if (s.grossAssetsUsd > 0) assert.ok(Math.abs(total - 1) < 1e-9, `shares sum to ${total}`);
  }
});

test('MCMIX-3: the record retains nothing from state — numbers and strings only', () => {
  const sim = run({ sampler: createMcSampler({ mix: true }), samplerCadence: 'year-boundary' });
  const sample = sim.samples[0];

  // structuredClone throws on anything holding a function or a class instance, which
  // is how a leaked state reference would most often show up.
  assert.doesNotThrow(() => structuredClone(sample));
  for (const v of Object.values(sample.mix)) assert.equal(typeof v, 'number');
});

test('MCMIX-4: without `mix` the record is unchanged — an ordinary run pays nothing', () => {
  const sim = run({ sampler: createMcSampler(), samplerCadence: 'year-boundary' });
  const sample = sim.samples[0];

  // `priceLevel` joined the base record in design 97 §18 (the trough metric's deflator).
  // The assertion stays EXACT rather than becoming a subset check: its job is to catch a
  // field creeping into the per-sample record, which is the one place in MC where a cost
  // is paid ~45 times per path per arm.
  assert.deepEqual(Object.keys(sample).sort(),
    ['date', 'houseValueUsd', 'netLiquidity', 'netWorthUsd', 'priceLevel']);
});
