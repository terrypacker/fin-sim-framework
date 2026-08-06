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

// ── What the 31 December boundary actually straddles (design 82 §5.2, corrected) ──
//
// The open question this closes was posed on a WRONG premise: §5.2 said "the annual
// investment family hangs off PERIOD_ADVANCE_US, which is dated 1 January", and
// concluded that every 31 December sample is read before the year's growth. Measured,
// the calendar splits in two, and only one half lags:
//
//   31 December — the whole INVESTMENT family (`interval: 'year-end'`): account
//                 earnings, dividends, coupons, RMDs, plus the year's expenses and
//                 tax settles. All of it IS in the sample.
//   1 January   — REAL-ASSET appreciation (property / company equity / collectibles,
//                 `interval: 'annually'`) and the PERIOD_ADVANCE cascade, which is
//                 where the rebalance fires.
//
// Two consequences the whole report rests on, so they get a test rather than a note:
//
//   1. The boundary must stay BEFORE the cascade. §7.3's drift finding only exists
//      because the sample is pre-rebalance — read it after and every class shows
//      0.0% drift by construction. Moving the boundary would not just move figures,
//      it would delete the headline.
//   2. A residual bias, correctly scoped: at 31 December year Y financial assets
//      carry a full year of growth and real assets carry NONE of year Y's
//      appreciation. So every mix understates the real-asset share by about one
//      appreciation cycle — which runs AGAINST §9's REAL_ESTATE finding rather than
//      manufacturing it.
//
// If someone re-dates either family, the mix figures change meaning silently. This
// is the assertion that makes that loud.

test('the boundary sits after the year’s investment growth and before the 1 Jan cascade', () => {
  const APPRECIATION_RATE = 0.04;
  const { sim } = loadScenarioSim({
    simStart: SIM_START, simEnd: SIM_END, telemetry: 'off',
    params: { auHouseAppreciationRate: APPRECIATION_RATE },
    sampler: (state) => ({
      house:  state.auHouseProperty?.value ?? null,
      equity: state.usStockAccount?.balance ?? null,
    }),
    samplerCadence: 'year-boundary',
    stepTo: SIM_END,
  });

  const samples = sim.samples;
  assert.ok(samples.length >= 3, 'need a few years to compare');

  // Financial growth IS captured: the brokerage moves between consecutive year-ends.
  const equities = samples.map(s => s.equity).filter(v => v != null);
  assert.ok(equities.length >= 3, 'the brokerage must be sampled');
  assert.ok(equities.some((v, i) => i > 0 && v !== equities[i - 1]),
    'a 31 Dec sample must already carry that year’s investment earnings');

  // Real-asset appreciation LAGS by one cycle: it is credited on 1 January, so the
  // house value at 31 Dec Y is still what it was on 1 Jan Y.
  const houses = samples.map(s => s.house).filter(v => v != null);
  if (houses.length >= 3) {
    // Consecutive year-end house values step by exactly one appreciation cycle —
    // i.e. the sample at 31 Dec Y shows year Y-1's appreciation, not year Y's.
    const ratio = houses[1] / houses[0];
    assert.ok(Math.abs(ratio - (1 + APPRECIATION_RATE)) < 1e-6,
      `house should step one appreciation cycle per year-end, got ratio ${ratio}`);
  }
});
