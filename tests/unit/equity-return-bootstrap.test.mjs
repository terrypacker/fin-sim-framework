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
 * equity-return-bootstrap.test.mjs — design 102 (historical block bootstrap + model labels).
 *
 *   - the bundled series is in sync with the Shiller CSV it was generated from;
 *   - a block replays CONSECUTIVE historical years, re-centred and rescaled to `vol`, and
 *     draws exactly one uniform per block (the RNG-cursor rule, design 74 §4);
 *   - the cursor wraps from the last year to the first;
 *   - GEOMETRIC drift compensation is exact on history itself;
 *   - every other model's action and state keep their pre-design-102 shape;
 *   - e2e: the param reaches the handler, and runs are seed-reproducible;
 *   - every model id has a dropdown label, and the label reaches the loaded params.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';
import { readFileSync }   from 'node:fs';

import {
  EquityReturnTickHandler, EQUITY_RETURN_MODEL_IDS, EQUITY_RETURN_MODEL_LABELS, HISTORICAL_BOOTSTRAP_SERIES,
} from '../../src/finance/economic-regimes/equity-return-tick-handler.js';
import { EquityReturnStepReducer }   from '../../src/finance/economic-regimes/equity-return-step-reducer.js';
import { HISTORICAL_EQUITY_RETURNS } from '../../src/finance/economic-regimes/historical-equity-returns.js';
import { RATE_KEYS, EQUITY_SLEEVES } from '../../src/finance/economic-regimes/rate-keys.js';
import { loadScenarioSim }           from '../helpers/scenario-harness.js';

const US        = RATE_KEYS.EQUITY_US;
const ZERO_IDIO = Object.fromEntries(EQUITY_SLEEVES.map(k => [k, 0]));
const { deviations, sd, firstYear, dragVar } = HISTORICAL_BOOTSTRAP_SERIES;
const N = deviations.length;

/** A constant-uniform rng that counts its draws. */
const countingRng = (u) => { const r = () => { r.calls++; return u; }; r.calls = 0; return r; };

/** Step the handler `years` times, threading state through the real step reducer. */
function walk(handler, rng, years) {
  const reducer = new EquityReturnStepReducer();
  let state = {};
  const actions = [];
  for (let t = 0; t < years; t++) {
    const a = handler.call({ sim: { rng }, state })[0];
    actions.push(a);
    state = reducer.reduce(state, a);
  }
  return { actions, state };
}

const bootstrap = (opts = {}) => new EquityReturnTickHandler({ model: 'HISTORICAL_BOOTSTRAP', vol: sd, idioVol: ZERO_IDIO, ...opts });

// ─── the bundled series ──────────────────────────────────────────────────────────

describe('historical equity series', () => {
  test('matches the Shiller CSV it is generated from (re-run the build script if not)', () => {
    const [hdr, ...lines] = readFileSync(new URL('../../docs/economic-shocks/data/Shiller-SP500-monthly.csv', import.meta.url), 'utf8').trim().split(/\r?\n/);
    const cols = hdr.split(',');
    const iD = cols.indexOf('observation_date'), iT = cols.indexOf('real_total_return_price');
    const jan = lines.map(l => l.split(',')).filter(c => c[iD].slice(5, 7) === '01' && c[iT] !== '').map(c => Number(c[iT]));
    const expected = jan.slice(1).map((v, i) => v / jan[i] - 1);
    assert.equal(HISTORICAL_EQUITY_RETURNS.returns.length, expected.length);
    assert.equal(HISTORICAL_EQUITY_RETURNS.firstYear, 1871);
    expected.forEach((r, i) => assert.ok(Math.abs(HISTORICAL_EQUITY_RETURNS.returns[i] - r) < 1e-6, `year ${1871 + i}`));
  });

  test('is re-centred: the deviations sum to zero, so the anchor stays the centre', () => {
    assert.ok(Math.abs(deviations.reduce((s, x) => s + x, 0)) < 1e-9);
    // The measured drag is close to, but not, the Gaussian σ² (about 4% below it on this
    // series). A gross mismatch would mean the series or the formula broke.
    assert.ok(Math.abs(dragVar / (sd * sd) - 1) < 0.1, `dragVar ${dragVar} vs σ² ${sd * sd}`);
  });
});

// ─── the handler ─────────────────────────────────────────────────────────────────

describe('EquityReturnTickHandler — HISTORICAL_BOOTSTRAP', () => {
  test('a block replays consecutive years and draws ONE uniform per block', () => {
    const rng = countingRng(0);                                  // every block starts at 1871
    const { actions } = walk(bootstrap({ blockLength: 5 }), rng, 12);
    assert.equal(rng.calls, 3, 'blocks start in years 1, 6 and 11 — and idio is off');
    const idx = actions.map(a => a.bootstrap.index);
    assert.deepEqual(idx, [0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1]);
    assert.deepEqual(actions.map(a => a.bootstrap.remaining), [4, 3, 2, 1, 0, 4, 3, 2, 1, 0, 4, 3]);
    assert.equal(actions[0].bootstrap.year, firstYear);
    actions.forEach((a, t) => assert.ok(Math.abs(a.marketDev - deviations[idx[t]]) < 1e-12, `year ${t}`));
  });

  test('a start drawn near 1 wraps from the last historical year to the first', () => {
    const { actions } = walk(bootstrap({ blockLength: 3 }), countingRng(0.9999999), 3);
    assert.deepEqual(actions.map(a => a.bootstrap.index), [N - 1, 0, 1]);
  });

  test('vol rescales the historical deviations; the shape is kept', () => {
    const at = (vol) => walk(bootstrap({ vol, blockLength: 4 }), countingRng(0.37), 4).actions.map(a => a.marketDev);
    const base = at(sd), doubled = at(2 * sd);
    base.forEach((d, t) => assert.ok(Math.abs(doubled[t] - 2 * d) < 1e-12));
  });

  test('GEOMETRIC compensation is exact on history: replaying it all returns the anchor', () => {
    // At the anchor = history's own geometric mean, anchor + dev + comp IS each historical
    // return, so the realized geometric mean is the anchor to rounding.
    const r      = HISTORICAL_EQUITY_RETURNS.returns;
    const anchor = Math.exp(r.reduce((s, x) => s + Math.log(1 + x), 0) / N) - 1;
    const geoAt = (a) => {
      const { actions } = walk(bootstrap({ blockLength: N }), countingRng(0), N);
      const sumLog = actions.reduce((s, o) => s + Math.log(1 + a + o.deviation[US] + o.driftComp[US]), 0);
      return Math.exp(sumLog / N) - 1;
    };
    assert.ok(Math.abs(geoAt(anchor) - anchor) < 1e-9, `got ${geoAt(anchor)} vs ${anchor}`);
    // At another anchor it's an approximation (the drag depends weakly on the level).
    assert.ok(Math.abs(geoAt(0.10) - 0.10) < 0.003, `got ${geoAt(0.10)}`);
  });

  test('the cursor lives in state: a restored state resumes the same block', () => {
    const h = bootstrap({ blockLength: 5 });
    const straight = walk(h, countingRng(0.5), 4).actions.map(a => a.marketDev);
    // Resume from the state after year 2 with an rng that would start a DIFFERENT block.
    const { state } = walk(h, countingRng(0.5), 2);
    const resumed = [h.call({ sim: { rng: countingRng(0.1) }, state })[0]];
    assert.equal(resumed[0].marketDev, straight[2], 'mid-block years come from the cursor, not the rng');
  });

  test('toJSON / fromJSON round-trips the block length', () => {
    const h = EquityReturnTickHandler.fromJSON(bootstrap({ blockLength: 8 }).toJSON());
    assert.equal(h.blockLength, 8);
    assert.equal(h.model, 'HISTORICAL_BOOTSTRAP');
  });
});

describe('the other models are unchanged by design 102', () => {
  for (const model of ['WHITE_NOISE', 'MEAN_REVERTING']) {
    test(`${model}: no bootstrap field on the action, no cursor in state`, () => {
      const { actions, state } = walk(new EquityReturnTickHandler({ model }), countingRng(0.3), 3);
      actions.forEach(a => assert.ok(!('bootstrap' in a)));
      assert.ok(!('equityReturnBootstrap' in state));
    });
  }

  test('every model id has a dropdown label, and no label names an unknown id', () => {
    assert.deepEqual([...EQUITY_RETURN_MODEL_IDS].sort(), Object.keys(EQUITY_RETURN_MODEL_LABELS).sort());
    assert.match(EQUITY_RETURN_MODEL_LABELS.MEAN_REVERTING, /momentum/i);
  });
});

// ─── e2e ─────────────────────────────────────────────────────────────────────────

describe('HISTORICAL_BOOTSTRAP — e2e', () => {
  const END = Date.UTC(2040, 0, 1);
  const run = (params) => loadScenarioSim({
    telemetry: 'off', simEnd: END, stepTo: END,
    params: { equityReturnStochastic: true, equityReturnModel: 'HISTORICAL_BOOTSTRAP', randomSeed: 7, ...params },
  });
  const nw = (r) => Math.round(r.sim.state.metrics?.netWorth ?? 0);

  test('the scenario runs the bootstrap and records which historical year it replayed', () => {
    const cur = run({}).sim.state.equityReturnBootstrap;
    assert.ok(cur, 'no bootstrap cursor in state');
    assert.ok(Number.isInteger(cur.year) && cur.year >= firstYear && cur.year < firstYear + N);
  });

  test('same seed reproduces; a different seed draws a different history', () => {
    assert.equal(nw(run({})), nw(run({})));
    assert.notEqual(nw(run({})), nw(run({ randomSeed: 8 })));
  });

  test('the block length reaches the handler', () => {
    assert.notEqual(nw(run({ equityReturnBootstrapBlock: 1 })), nw(run({ equityReturnBootstrapBlock: 10 })));
  });

  test('the model param carries its option labels into the loaded params', () => {
    const entry = run({}).cfg.params.find(p => p.name === 'equityReturnModel');
    assert.equal(entry.optionLabels?.HISTORICAL_BOOTSTRAP, EQUITY_RETURN_MODEL_LABELS.HISTORICAL_BOOTSTRAP);
    assert.ok(entry.options.includes('HISTORICAL_BOOTSTRAP'));
  });
});
