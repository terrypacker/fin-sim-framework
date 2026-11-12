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
 * Design 131 §3.1 — gold's nominal return carries the US inflation deviation in joint mode.
 *
 *   GIP-1  the step reducer writes GOLD at the US deviation, never the AU one
 *   GIP-2  the fold adds it to gold's effective rate and its per-account variants
 *   GIP-3  e2e joint mode: state carries it and gold's rate includes it
 *   GIP-4  outside joint mode there is no gold pass-through (Gaussian runs unchanged)
 *   GIP-5  the G1 gate (§4): gold's REAL return no longer falls with inflation
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { InflationStepReducer } from '../../src/finance/economic-regimes/inflation-step-reducer.js';
import { EquityReturnReducer }  from '../../src/finance/economic-regimes/equity-return-reducer.js';
import { RATE_KEYS }            from '../../src/finance/economic-regimes/rate-keys.js';
import { loadScenarioSim }      from '../helpers/scenario-harness.js';

const GOLD  = RATE_KEYS.GOLD;
const JOINT = {
  equityReturnStochastic: true, equityReturnModel: 'HISTORICAL_BOOTSTRAP',
  inflationStochastic: true, inflationModel: 'HISTORICAL_JOINT', yieldCurveStochastic: true,
};
const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

describe('design 131 §3.1 — gold inflation pass-through', () => {
  test('GIP-1 the step reducer writes GOLD at the US deviation, not the AU one', () => {
    const r = new InflationStepReducer();
    const pass = r.reduce({}, { type: 'INFLATION_STEP_APPLY', deviation: { US: 0.04, AU: -0.02 }, floor: -0.05, passThrough: true });
    assert.equal(pass.equityInflationPassThrough[GOLD], 0.04);
    const plain = r.reduce({}, { type: 'INFLATION_STEP_APPLY', deviation: { US: 0.04, AU: -0.02 }, floor: -0.05 });
    assert.ok(!('equityInflationPassThrough' in plain));
  });

  test('GIP-2 the fold adds it to gold\'s rate and to every GOLD:: account variant', () => {
    const st = {
      effectiveGrowthRates:       { [GOLD]: 0.05, [`${GOLD}::superAccount`]: 0.05, [RATE_KEYS.EQUITY_US]: 0.07 },
      equityReturnDev:            { [GOLD]: -0.10, [RATE_KEYS.EQUITY_US]: 0 },
      equityReturnDriftComp:      { [GOLD]: 0.01 },
      equityInflationPassThrough: { [GOLD]: 0.03, [RATE_KEYS.EQUITY_US]: 0 },
    };
    const next = new EquityReturnReducer().reduce(st, { type: 'US_PERIOD_ADVANCE' });
    close(next.effectiveGrowthRates[GOLD], 0.05 - 0.10 + 0.01 + 0.03);
    close(next.effectiveGrowthRates[`${GOLD}::superAccount`], 0.05 - 0.10 + 0.01 + 0.03);
    // A pass-through with no gold draw at all (goldReturnVol 0) still reaches gold.
    const noDraw = new EquityReturnReducer().reduce(
      { effectiveGrowthRates: { [GOLD]: 0.05 }, equityReturnDev: {}, equityInflationPassThrough: { [GOLD]: 0.02 } },
      { type: 'US_PERIOD_ADVANCE' });
    close(noDraw.effectiveGrowthRates[GOLD], 0.07);
  });

  const END = Date.UTC(2040, 0, 1);
  const run = (params) => loadScenarioSim({ telemetry: 'off', simEnd: END, stepTo: END, params: { randomSeed: 7, ...params } }).sim.state;

  test('GIP-3 e2e joint mode: gold carries the US inflation deviation', () => {
    const st = run(JOINT);
    assert.equal(st.equityInflationPassThrough[GOLD], st.inflationDev.US);
    assert.equal(st.equityInflationPassThrough[GOLD], st.equityInflationPassThrough[RATE_KEYS.EQUITY_US]);
  });

  test('GIP-4 outside joint mode there is no pass-through', () => {
    const st = run({ ...JOINT, equityReturnModel: 'WHITE_NOISE' });
    assert.ok(st.inflationDev);
    assert.ok(!('equityInflationPassThrough' in st));
  });

  // G1 (design 131 §4). goldReturnVol 0 removes gold's own noise, so the slope measures only
  // what this phase changes: the link between gold's real return and the inflation path. The
  // pre-131 counterfactual is read off the same run (the nominal rate minus the pass-through),
  // so both slopes come from identical inflation paths.
  test('GIP-5 G1 gate: gold\'s real return no longer falls one-for-one with inflation', () => {
    const xs = [], realWith = [], realWithout = [];
    for (let seed = 1; seed <= 4; seed++) {
      const { sim } = loadScenarioSim({ telemetry: 'off', simEnd: Date.UTC(2070, 0, 1), params: { ...JOINT, randomSeed: seed, goldReturnVol: 0 } });
      for (let y = 2028; y < 2070; y++) {
        sim.stepTo(new Date(Date.UTC(y, 6, 1)));   // mid-year: both rates folded at the 1 Jan advance
        const s = sim.state;
        const g = s.effectiveGrowthRates[GOLD], p = s.equityInflationPassThrough?.[GOLD] ?? 0;
        const infl = s.effectiveInflationRates.US;
        // In logs, so the counterfactual is exactly linear: log real = log nominal − log(1 + i).
        xs.push(Math.log(1 + infl));
        realWith.push(Math.log(1 + g) - Math.log(1 + infl));
        realWithout.push(Math.log(1 + g - p) - Math.log(1 + infl));   // the pre-131 model: nominal fixed
      }
    }
    const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
    const slope = (x, y) => { const mx = mean(x), my = mean(y); let s = 0, d = 0; x.forEach((v, i) => { s += (v - mx) * (y[i] - my); d += (v - mx) ** 2; }); return s / d; };
    const sWith = slope(xs, realWith), sWithout = slope(xs, realWithout);
    assert.ok(xs.length > 100 && Math.max(...xs) - Math.min(...xs) > 0.05, 'the paths must move inflation');
    assert.ok(Math.abs(sWith) < 0.05, `real gold vs inflation, with pass-through: slope ${sWith}`);
    assert.ok(Math.abs(sWithout + 1) < 0.01, `without pass-through: slope ${sWithout}`);
  });
});
