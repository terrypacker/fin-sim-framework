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
 * bootstrap-start.test.mjs — design 133 phase 3 (a pinned start year).
 *
 *   - G-B1: a pinned run replays the named years in order, never wraps past 2023, then goes
 *     back to random blocks; under joint inflation the inflation tick reads the same years;
 *   - the run reads the whole series (a pinned year outside the window still replays) and is
 *     re-centred on the window's mean;
 *   - the first block's uniform is drawn and discarded, so later draws stay in place;
 *   - blank is byte-identical; the rules, warnings, panel line and pairing record.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { authoredBootstrapStart, bootstrapPinnedRun, bootstrapStartWarning, describeBootstrapStart }
  from '../../src/finance/economic-regimes/bootstrap-window.js';
import { EquityReturnTickHandler, HISTORICAL_BOOTSTRAP_WINDOWS } from '../../src/finance/economic-regimes/equity-return-tick-handler.js';
import { EquityReturnStepReducer }   from '../../src/finance/economic-regimes/equity-return-step-reducer.js';
import { HISTORICAL_EQUITY_RETURNS } from '../../src/finance/economic-regimes/historical-equity-returns.js';
import { RATE_KEYS, EQUITY_SLEEVES } from '../../src/finance/economic-regimes/rate-keys.js';
import { mcReturnPaths, mcEquityStart } from '../../src/finance/monte-carlo/parallel/mc-worker-core.js';
import { pairingMismatches }         from '../../src/finance/monte-carlo/mc-analysis.js';
import { formatReturnPaths }         from '../../src/visualization/monte-carlo/mc-config-panel.js';
import { loadScenarioSim }           from '../helpers/scenario-harness.js';

const US        = RATE_KEYS.EQUITY_US;
const ZERO_IDIO = Object.fromEntries(EQUITY_SLEEVES.map(k => [k, 0]));
const BOOT  = { equityReturnStochastic: true, equityReturnModel: 'HISTORICAL_BOOTSTRAP' };
const JOINT = { ...BOOT, inflationStochastic: true, inflationModel: 'HISTORICAL_JOINT' };
const GAUSS = { ...BOOT, inflationStochastic: true, inflationModel: 'GAUSSIAN' };

const countingRng = (seed = 3) => {
  let s = seed;
  const r = () => { r.calls++; s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  r.calls = 0;
  return r;
};

function walk(opts, years, rng = countingRng()) {
  const h = new EquityReturnTickHandler({ model: 'HISTORICAL_BOOTSTRAP', idioVol: ZERO_IDIO, ...opts });
  const reducer = new EquityReturnStepReducer();
  let state = {};
  const actions = [];
  for (let t = 0; t < years; t++) {
    const a = h.call({ sim: { rng }, state })[0];
    actions.push(a);
    state = reducer.reduce(state, a);
  }
  return { actions, state, rng };
}

describe('the pinned run in the handler (G-B1)', () => {
  test('replays the named years in order, then goes back to random blocks', () => {
    const { actions } = walk({ pinned: { startYear: 1966, years: 15 }, blockLength: 5 }, 30);
    const years = actions.map(a => a.bootstrap.year);
    assert.deepEqual(years.slice(0, 15), Array.from({ length: 15 }, (_, i) => 1966 + i));
    assert.ok(actions.slice(0, 15).every(a => a.bootstrap.pinned === true));
    assert.ok(actions.slice(15).every(a => a.bootstrap.pinned === undefined), 'random blocks after the run');
    assert.deepEqual(actions.slice(0, 15).map(a => a.bootstrap.remaining), Array.from({ length: 15 }, (_, i) => 14 - i));
  });

  test('never wraps past 2023: a long run is cut at the end of the history', () => {
    const { actions } = walk({ pinned: { startYear: 2015, years: 20 }, blockLength: 5 }, 12);
    const years = actions.map(a => a.bootstrap.year);
    assert.deepEqual(years.slice(0, 9), [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023]);
    assert.equal(actions[8].bootstrap.remaining, 0);
    assert.equal(actions[9].bootstrap.pinned, undefined);
  });

  test('re-centred on the window\'s mean, and a year outside the window still replays', () => {
    const w = HISTORICAL_BOOTSTRAP_WINDOWS.POSTWAR;
    const vol = 0.2;
    const { actions } = walk({ window: 'POSTWAR', vol, pinned: { startYear: 1929, years: 3 } }, 3);
    assert.deepEqual(actions.map(a => a.bootstrap.year), [1929, 1930, 1931]);
    const r = HISTORICAL_EQUITY_RETURNS.returns;
    actions.forEach((a, i) => {
      const expected = (r[1929 - HISTORICAL_EQUITY_RETURNS.firstYear + i] - w.mean) * (vol / w.sd);
      assert.ok(Math.abs(a.marketDev - expected) < 1e-15, `year ${1929 + i}`);
    });
  });

  test('inside the window, a pinned year carries exactly the deviation a random block would', () => {
    const w = HISTORICAL_BOOTSTRAP_WINDOWS.FULL;
    const { actions } = walk({ vol: w.sd, pinned: { startYear: 1966, years: 1 } }, 1);
    assert.equal(actions[0].marketDev, w.deviations[1966 - 1871]);
  });

  test('the first block\'s uniform is drawn and discarded', () => {
    const pinned = walk({ pinned: { startYear: 1966, years: 5 }, blockLength: 5 }, 10).rng.calls;
    const random = walk({ blockLength: 5 }, 10).rng.calls;
    assert.equal(pinned, random);
    assert.equal(pinned, 2);
  });

  test('a restored state resumes the pinned run', () => {
    const h = new EquityReturnTickHandler({ model: 'HISTORICAL_BOOTSTRAP', idioVol: ZERO_IDIO, pinned: { startYear: 1966, years: 10 } });
    const { state } = walk({ pinned: { startYear: 1966, years: 10 } }, 4);
    const next = h.call({ sim: { rng: () => { throw new Error('a pinned run draws nothing'); } }, state })[0];
    assert.equal(next.bootstrap.year, 1970);
  });

  test('the pinned config survives a snapshot round trip, and is absent when unset', () => {
    const h = new EquityReturnTickHandler({ model: 'HISTORICAL_BOOTSTRAP', pinned: { startYear: 1966, years: 10 } });
    const back = EquityReturnTickHandler.fromJSON(JSON.parse(JSON.stringify(h.toJSON())));
    assert.deepEqual(back.pinned, { startYear: 1966, years: 10 });
    assert.ok(!('pinned' in new EquityReturnTickHandler({ model: 'HISTORICAL_BOOTSTRAP' }).toJSON()));
  });
});

describe('the rules', () => {
  test('any year of the history; the run is cut at its end', () => {
    assert.equal(authoredBootstrapStart({}), null);
    assert.deepEqual(authoredBootstrapStart({ equityReturnBootstrapStartYear: 1966 }), { startYear: 1966, years: 58, toYear: 2023 });
    assert.deepEqual(authoredBootstrapStart({ equityReturnBootstrapStartYear: 1966, equityReturnBootstrapStartRun: 15 }), { startYear: 1966, years: 15, toYear: 1980 });
    assert.deepEqual(authoredBootstrapStart({ equityReturnBootstrapStartYear: 2015, equityReturnBootstrapStartRun: 20 }), { startYear: 2015, years: 9, toYear: 2023 });
    assert.deepEqual(authoredBootstrapStart({ equityReturnBootstrapStartYear: 2023 }), { startYear: 2023, years: 1, toYear: 2023 });
  });

  test('refuses years outside the history and runs below one year', () => {
    for (const bad of [1870, 2024, 1966.5]) {
      assert.throws(() => authoredBootstrapStart({ equityReturnBootstrapStartYear: bad }), /1871 to 2023/, String(bad));
    }
    for (const bad of [0, -3, 2.5]) {
      assert.throws(() => authoredBootstrapStart({ equityReturnBootstrapStartYear: 1966, equityReturnBootstrapStartRun: bad }), /1 or more/, String(bad));
    }
  });

  test('ignored, never validated, when the bootstrap does not run', () => {
    assert.equal(bootstrapPinnedRun({ equityReturnBootstrapStartYear: 1700 }), null);
    assert.equal(describeBootstrapStart({ equityReturnBootstrapStartYear: 1700 }), null);
  });

  test('under joint inflation, pre-1951 years warn; from 1951 they do not', () => {
    assert.match(bootstrapStartWarning({ ...JOINT, equityReturnBootstrapStartYear: 1929 }), /1929–1950 have no inflation history/);
    assert.match(bootstrapStartWarning({ ...JOINT, equityReturnBootstrapStartYear: 1929, equityReturnBootstrapStartRun: 5 }), /1929–1933/);
    assert.match(bootstrapStartWarning({ ...JOINT, equityReturnBootstrapStartYear: 1950 }), /1950: 1950 has no inflation history/);
    assert.equal(bootstrapStartWarning({ ...JOINT, equityReturnBootstrapStartYear: 1966 }), null);
    assert.equal(bootstrapStartWarning({ ...GAUSS, equityReturnBootstrapStartYear: 1929 }), null);
  });
});

describe('Monte Carlo', () => {
  test('the panel line says every path opens with the run', () => {
    assert.equal(formatReturnPaths(mcReturnPaths({ equityReturnBootstrapStartYear: 1966, equityReturnBootstrapStartRun: 15 })),
      'Equity: historical bootstrap, 1951–2023 (automatic: joint inflation); every path opens with 1966–1980 in order · Inflation: historical, joint with equity');
  });

  test('the pairing record names the run, and a pinned batch never pairs with an unpinned one', () => {
    assert.equal(mcEquityStart({}), null);
    assert.equal(mcEquityStart({ equityReturnBootstrapStartYear: 1966, equityReturnBootstrapStartRun: 15 }), '1966+15');
    assert.equal(mcEquityStart({ mcEquityReturnModel: 'WHITE_NOISE', equityReturnBootstrapStartYear: 1966 }), null);
    const rec = (equityStart) => ({ n: 1, seeds: [1], sampled: [], mcSequenceRisk: true, equityModel: 'HISTORICAL_BOOTSTRAP', equityStart });
    assert.deepEqual(pairingMismatches(rec(null), rec('1966+15')), ['pinned start none vs 1966 for 15 years']);
    assert.deepEqual(pairingMismatches(rec('1966+15'), rec('1966+15')), []);
  });
});

describe('e2e', () => {
  const END = Date.UTC(2050, 0, 1);
  const run = (params) => loadScenarioSim({ telemetry: 'off', simEnd: END, stepTo: END, params: { randomSeed: 5, ...params } }).sim.state;

  test('blank is byte-identical to before', () => {
    const blank = JSON.stringify(run(GAUSS));
    assert.equal(JSON.stringify(run({ ...GAUSS, equityReturnBootstrapStartYear: null, equityReturnBootstrapStartRun: null })), blank);
    assert.notEqual(JSON.stringify(run({ ...GAUSS, equityReturnBootstrapStartYear: 1966 })), blank);
  });

  test('a pinned run is in state at the end of a run that is still inside it', () => {
    const st = run({ ...GAUSS, equityReturnBootstrapStartYear: 1966 });
    assert.equal(st.equityReturnBootstrap.pinned, true);
    assert.ok(st.equityReturnBootstrap.year >= 1966 + 20 && st.equityReturnBootstrap.year <= 1966 + 25, String(st.equityReturnBootstrap.year));
  });

  test('joint inflation follows the pinned years', () => {
    const st = run({ ...JOINT, equityReturnBootstrapStartYear: 1966 });
    assert.equal(st.equityReturnBootstrap.pinned, true);
    assert.ok(st.inflationDev, 'inflation ran');
  });

  test('a start year outside the history fails the compile with the rule', () => {
    assert.throws(() => loadScenarioSim({ telemetry: 'off', simEnd: END,
      params: { randomSeed: 5, ...GAUSS, equityReturnBootstrapStartYear: 2030 } }), /1871 to 2023/);
  });
});
