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
 * sampler-year-boundary.test.mjs — design 82 §4 / §5.1(b).
 *
 * The contract: a `'year-boundary'` sampler produces **exactly one record per
 * calendar year**, each carrying the state as at 31 December of that year — the
 * same state `stepTo(31 Dec)` would leave behind.
 *
 * Why this is worth a test rather than a comment. An allocation chart's whole claim
 * is that two points are comparable, and that claim rests entirely on the sample
 * instant. The failure mode is silent: with the event-count cadence the samples
 * still arrive, still look like a series, and are simply read at whatever event
 * happened to be the 12th — so a mix moves because event volume changed, not
 * because the portfolio did. Nothing throws, and the chart is wrong in a way that
 * looks like a finding.
 *
 * The equivalence assertion (`stepTo` vs sampler) is the load-bearing one: it is
 * what lets the lab report and the workbench plugin sample through different
 * mechanisms and still be quoting the same number.
 */

import { test }            from 'node:test';
import assert              from 'node:assert/strict';
import { loadScenarioSim } from '../helpers/scenario-harness.js';

const SIM_START = '2026-01-01';
const SIM_END   = '2031-01-01';

/** Net worth is enough of a probe: any state-instant difference moves it. */
const probe = (state, date) => ({
  at:       new Date(date),
  netWorth: state.metrics?.netWorth ?? null,
  equity:   state.usStockAccount?.balance ?? null,
});

function runWithCadence(samplerCadence) {
  const { sim } = loadScenarioSim({
    simStart: SIM_START, simEnd: SIM_END, stepTo: SIM_END,
    telemetry: 'off', sampler: probe, samplerCadence,
  });
  return sim;
}

test('year-boundary cadence yields exactly one sample per calendar year', () => {
  const sim = runWithCadence('year-boundary');
  const years = sim.samples.map(s => s.at.getUTCFullYear());

  assert.deepEqual(years, [...new Set(years)], 'a year must not be sampled twice');
  assert.deepEqual(years, [...years].sort((a, b) => a - b), 'samples must be in year order');
  // 2026…2030 complete, plus the terminal flush at the 2031-01-01 horizon.
  assert.deepEqual(years, [2026, 2027, 2028, 2029, 2030, 2031]);
});

test('completed years are stamped at 31 December; the terminal flush at the horizon', () => {
  const sim = runWithCadence('year-boundary');
  const stamps = sim.samples.map(s => s.at.toISOString().slice(0, 10));

  assert.deepEqual(stamps.slice(0, 5), [
    '2026-12-31', '2027-12-31', '2028-12-31', '2029-12-31', '2030-12-31',
  ]);
  // The horizon falls mid-year, so the last sample is stamped at simEnd rather than
  // at a 31 December it never reached. Without this flush the terminal state — the
  // most-quoted point on any chart — would be missing entirely.
  assert.equal(stamps.at(-1), '2031-01-01');
});

test('a year-boundary sample equals what stepTo(31 December) leaves behind', () => {
  const sampled = runWithCadence('year-boundary');

  // The equivalence that lets the lab page and the plugin sample differently and
  // still agree: step a second run to each year-end and compare.
  for (const sample of sampled.samples) {
    const year = sample.at.getUTCFullYear();
    if (year > 2030) continue; // the terminal flush has no 31 Dec counterpart

    const { sim } = loadScenarioSim({
      simStart: SIM_START, simEnd: SIM_END, telemetry: 'off',
      stepTo: new Date(Date.UTC(year, 11, 31)),
    });
    assert.equal(
      sample.netWorth, sim.state.metrics?.netWorth,
      `net worth at ${year}-12-31 must match stepTo's`);
    assert.equal(sample.equity, sim.state.usStockAccount?.balance,
      `brokerage balance at ${year}-12-31 must match stepTo's`);
  }
});

test('the interval cadence is untouched — design 78 § 4.5 keeps its event-count series', () => {
  const sim = runWithCadence('interval');
  // Many more records than years, and (the point) not one per calendar year.
  assert.ok(sim.samples.length > 6, `expected an event-cadence series, got ${sim.samples.length}`);
  const years = sim.samples.map(s => s.at.getUTCFullYear());
  assert.ok(years.length > new Set(years).size, 'interval sampling repeats years, by design');
});

test('a mid-year sample is replaced by that year’s completed one (playback safety)', () => {
  // Scrub to mid-2028, then run on. The partial reading must not survive: a chart
  // with one stale point and no way to see it is the worst outcome here.
  const { sim } = loadScenarioSim({
    simStart: SIM_START, simEnd: SIM_END, telemetry: 'off',
    sampler: probe, samplerCadence: 'year-boundary',
  });

  sim.stepTo(new Date(Date.UTC(2028, 5, 30)));
  const partial = sim.samples.find(s => s.at.getUTCFullYear() === 2028);
  assert.ok(partial, 'the scrub instant is sampled so the panel can draw "now"');
  assert.equal(partial.at.toISOString().slice(0, 10), '2028-06-30');

  sim.stepTo(new Date(SIM_END));
  const completed = sim.samples.filter(s => s.at.getUTCFullYear() === 2028);
  assert.equal(completed.length, 1, 'the year must still hold exactly one sample');
  assert.equal(completed[0].at.toISOString().slice(0, 10), '2028-12-31');
});
