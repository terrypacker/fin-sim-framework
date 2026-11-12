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
 * Design 131 §3.2 / §3.5 — gold replays its own historical year under the equity bootstrap.
 *
 *   GRP-1  the packaged series matches the World Bank and Shiller CSVs
 *   GRP-2  the series is re-centred, and the default vol is its sd rounded (0.29)
 *   GRP-3  a gold-row year replays that year's deviation, rescaled, with no ε draw
 *   GRP-4  a pre-1969 year, replay off, and WHITE_NOISE all keep the correlated draw
 *   GRP-5  the drift compensation is the rescaled series' measured drag
 *   GRP-6  an authored vol rescales the replay; goldReplay false turns it off (e2e)
 *   GRP-7  e2e joint mode, defaults: every gold-row year replays its row at vol 0.29
 *
 * G2 (the in-model statistics against history) is `scripts/lab/gold-model-check.mjs`, recorded
 * in design 131 §3.2.1; it is too slow for the unit suite.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';
import { readFileSync }   from 'node:fs';

import { EquityReturnTickHandler, HISTORICAL_BOOTSTRAP_SERIES, HISTORICAL_GOLD_SERIES, DEFAULT_GOLD_RETURN_VOL } from '../../src/finance/economic-regimes/equity-return-tick-handler.js';
import { HISTORICAL_EQUITY_RETURNS } from '../../src/finance/economic-regimes/historical-equity-returns.js';
import { HISTORICAL_GOLD_RETURNS }   from '../../src/finance/economic-regimes/historical-gold.js';
import { RATE_KEYS }                 from '../../src/finance/economic-regimes/rate-keys.js';
import { loadScenarioSim }           from '../helpers/scenario-harness.js';

const GOLD = RATE_KEYS.GOLD;
const N    = HISTORICAL_BOOTSTRAP_SERIES.deviations.length;
const startAt = (year) => (year - HISTORICAL_EQUITY_RETURNS.firstYear + 0.5) / N;
const countingRng = (u) => { const r = () => { r.calls++; return u; }; r.calls = 0; return r; };
/** A sim whose shared rng starts the block at `year` and whose keyed streams count their use. */
const simAt = (year) => {
  const keyed = { calls: 0 };
  return { keyed, sim: { rng: countingRng(startAt(year)), keyedRng: () => { keyed.calls++; return () => 0.42; } } };
};
const handler = (gold, opts = {}) => new EquityReturnTickHandler({ model: 'HISTORICAL_BOOTSTRAP', vol: 0.18, blockLength: 5, gold, ...opts });

describe('design 131 — the gold series', () => {
  test('GRP-1 matches the World Bank gold and Shiller CPI CSVs (re-run the build script if not)', () => {
    const csv = (f) => readFileSync(new URL(`../../docs/economic-shocks/data/${f}`, import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1).map(l => l.split(','));
    const gold = new Map(csv('WorldBank-CMO-gold-monthly.csv').map(([m, v]) => [m, Number(v)]));
    const [hdr] = readFileSync(new URL('../../docs/economic-shocks/data/Shiller-SP500-monthly.csv', import.meta.url), 'utf8').split(/\r?\n/);
    const cpiCol = hdr.split(',').indexOf('CPI');
    const cpi = new Map(csv('Shiller-SP500-monthly.csv').filter(c => c[0].slice(5, 7) === '01').map(c => [Number(c[0].slice(0, 4)), Number(c[cpiCol])]));
    const { firstYear, returns } = HISTORICAL_GOLD_RETURNS;
    assert.equal(firstYear, 1969);
    assert.equal(firstYear + returns.length - 1, HISTORICAL_EQUITY_RETURNS.firstYear + N - 1, 'ends the same year as the equity series');
    returns.forEach((r, i) => {
      const y = firstYear + i;
      const expected = (gold.get(`${y + 1}-01`) / gold.get(`${y}-01`)) / (cpi.get(y + 1) / cpi.get(y)) - 1;
      assert.ok(Math.abs(r - expected) < 1e-6, `gold ${y}`);
    });
    assert.ok(returns[1979 - 1969] > 1.5, '1979 is +161% real');
  });

  test('GRP-2 re-centred; the default vol is the sd rounded to the percent', () => {
    assert.ok(Math.abs(HISTORICAL_GOLD_SERIES.deviations.reduce((s, x) => s + x, 0)) < 1e-9);
    assert.ok(Math.abs(HISTORICAL_GOLD_SERIES.sd - 0.2939) < 1e-3);
    assert.equal(DEFAULT_GOLD_RETURN_VOL, 0.29);
  });
});

/**
 * Steps a joint-mode run to just after each 31 Dec tick and counts the years whose stored
 * gold deviation is (or, for a gold-row year, is NOT) the bootstrap year's row at `vol`.
 */
function replayedYears(params, vol) {
  const { sim } = loadScenarioSim({ telemetry: 'off', simEnd: Date.UTC(2070, 0, 1), params: {
    randomSeed: 3, equityReturnStochastic: true, equityReturnModel: 'HISTORICAL_BOOTSTRAP',
    inflationStochastic: true, inflationModel: 'HISTORICAL_JOINT', yieldCurveStochastic: true, ...params } });
  let replayed = 0, mismatched = 0;
  for (let y = 2027; y < 2070; y++) {
    sim.stepTo(new Date(Date.UTC(y, 11, 31, 12)));
    const s = sim.state, row = (s.equityReturnBootstrap?.year ?? 0) - 1969;
    if (row < 0 || row >= HISTORICAL_GOLD_SERIES.deviations.length) continue;
    const expected = HISTORICAL_GOLD_SERIES.deviations[row] * (vol / HISTORICAL_GOLD_SERIES.sd);
    if (Math.abs(s.equityReturnDev[GOLD] - expected) < 1e-12) replayed++; else mismatched++;
  }
  return { replayed, mismatched };
}

describe('design 131 — EquityReturnTickHandler gold replay', () => {
  const VOL = 0.29;

  test('GRP-3 a gold-row year replays its own deviation, rescaled, and draws no ε', () => {
    const { sim, keyed } = simAt(1979);
    const a = handler({ vol: VOL, correlation: 0.5, replay: true }).call({ sim, state: {} })[0];
    assert.equal(a.bootstrap.year, 1979);
    const expected = HISTORICAL_GOLD_SERIES.deviations[1979 - 1969] * (VOL / HISTORICAL_GOLD_SERIES.sd);
    assert.ok(Math.abs(a.deviation[GOLD] - expected) < 1e-15);
    assert.equal(keyed.calls, 0, 'the gold stream is not touched in a replay year');
  });

  test('GRP-4 a pre-1969 year, replay off, and WHITE_NOISE keep the correlated draw', () => {
    for (const [year, gold] of [[1955, { vol: VOL, correlation: 0, replay: true }], [1979, { vol: VOL, correlation: 0, replay: false }]]) {
      const { sim, keyed } = simAt(year);
      const a = handler(gold).call({ sim, state: {} })[0];
      assert.equal(keyed.calls, 1, `${year} replay ${gold.replay}: one ε from the keyed stream`);
      assert.ok(Math.abs(a.driftComp[GOLD] - VOL * VOL / 2) < 1e-15);
    }
    const keyed = { calls: 0 };
    new EquityReturnTickHandler({ model: 'WHITE_NOISE', gold: { vol: VOL, correlation: 0, replay: true } })
      .call({ sim: { rng: countingRng(0.3), keyedRng: () => { keyed.calls++; return () => 0.42; } }, state: {} });
    assert.equal(keyed.calls, 1, 'WHITE_NOISE never replays');
  });

  test('GRP-5 the replay\'s drift compensation is the rescaled series\' measured drag', () => {
    const { sim } = simAt(1990);
    const a = handler({ vol: VOL, correlation: 0, replay: true }).call({ sim, state: {} })[0];
    const s = VOL / HISTORICAL_GOLD_SERIES.sd;
    assert.ok(Math.abs(a.driftComp[GOLD] - s * s * HISTORICAL_GOLD_SERIES.dragVar / 2) < 1e-15);
    const none = handler({ vol: VOL, correlation: 0, replay: true }, { driftComp: 'NONE' }).call({ sim: simAt(1990).sim, state: {} })[0];
    assert.equal(none.driftComp[GOLD], 0);
  });

  test('GRP-6 the params reach the replay: an authored vol rescales it, goldReplay false turns it off', () => {
    const at015 = replayedYears({ goldReturnVol: 0.15 }, 0.15);
    assert.ok(at015.replayed > 10 && at015.mismatched === 0, 'every gold-row year at 0.15 / sd');
    const off = replayedYears({ goldReplay: false }, DEFAULT_GOLD_RETURN_VOL);
    assert.equal(off.replayed, 0, 'no year carries its historical row');
    assert.ok(off.mismatched > 10);
  });

  test('GRP-7 e2e joint mode, defaults: each gold-row year replays its row at vol 0.29', () => {
    const { replayed, mismatched } = replayedYears({}, 0.29);
    assert.ok(replayed > 10, `replayed ${replayed} years`);
    assert.equal(mismatched, 0);
  });
});
