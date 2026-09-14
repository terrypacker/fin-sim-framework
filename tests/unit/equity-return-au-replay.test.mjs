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
 * equity-return-au-replay.test.mjs — design 102 §6 (the AU market replays its own history).
 *
 *   - the bundled AU series is in sync with the OECD CSVs it is generated from;
 *   - in a bootstrap year with AU data, the AU sleeve is that year's AU deviation, rescaled
 *     to the sleeve's model sd, and takes NO idio draw;
 *   - before 1958 (no AU data) it falls back to β × market + idio;
 *   - `auReplay: false` restores β × market + idio everywhere;
 *   - only the AU sleeve changes, and only under the bootstrap;
 *   - e2e: the scenario toggle reaches the handler.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';
import { readFileSync }   from 'node:fs';

import { EquityReturnTickHandler, HISTORICAL_BOOTSTRAP_SERIES, HISTORICAL_AU_SERIES } from '../../src/finance/economic-regimes/equity-return-tick-handler.js';
import { HISTORICAL_EQUITY_RETURNS } from '../../src/finance/economic-regimes/historical-equity-returns.js';
import { RATE_KEYS, EQUITY_SLEEVES, DEFAULT_EQUITY_BETA } from '../../src/finance/economic-regimes/rate-keys.js';
import { loadScenarioSim }           from '../helpers/scenario-harness.js';

const AU        = RATE_KEYS.EQUITY_AU;
const N         = HISTORICAL_BOOTSTRAP_SERIES.deviations.length;
const US_SD     = HISTORICAL_BOOTSTRAP_SERIES.sd;
const ZERO_IDIO = Object.fromEntries(EQUITY_SLEEVES.map(k => [k, 0]));
const AU_IDIO   = 0.13;

/** A constant-uniform rng that counts its draws; `u` picks the block's start year. */
const countingRng = (u) => { const r = () => { r.calls++; return u; }; r.calls = 0; return r; };
/** The uniform that starts a FULL-window block at `year`. */
const startAt = (year) => (year - HISTORICAL_EQUITY_RETURNS.firstYear + 0.5) / N;

const handler = (opts = {}) => new EquityReturnTickHandler({
  model: 'HISTORICAL_BOOTSTRAP', vol: US_SD, blockLength: 5,
  idioVol: { ...ZERO_IDIO, [AU]: AU_IDIO }, ...opts,
});

describe('the AU series', () => {
  test('matches the OECD share price and CPI CSVs (re-run the build script if not)', () => {
    const read = (f) => {
      const [hdr, ...lines] = readFileSync(new URL(`../../docs/economic-shocks/data/${f}`, import.meta.url), 'utf8').trim().split(/\r?\n/);
      const cols = hdr.split(',');
      return lines.map(l => { const c = l.split(','); return Object.fromEntries(cols.map((k, i) => [k, c[i]])); });
    };
    const px  = new Map(read('FRED-SPASTT01AUM661N.csv').filter(r => r.observation_date.slice(5, 7) === '01').map(r => [Number(r.observation_date.slice(0, 4)), Number(r.SPASTT01AUM661N)]));
    const cpi = new Map(read('FRED-CPALTT01AUQ659N.csv').filter(r => r.observation_date.slice(5, 7) === '10').map(r => [Number(r.observation_date.slice(0, 4)), Number(r.CPALTT01AUQ659N) / 100]));
    const { firstYear, returns } = HISTORICAL_EQUITY_RETURNS.au;
    assert.equal(firstYear, 1958);
    assert.equal(firstYear + returns.length - 1, HISTORICAL_EQUITY_RETURNS.firstYear + N - 1, 'ends the same year as the US series');
    returns.forEach((r, i) => {
      const y = firstYear + i;
      const expected = (px.get(y + 1) / px.get(y)) / (1 + cpi.get(y)) - 1;
      assert.ok(Math.abs(r - expected) < 1e-6, `AU ${y}`);
    });
  });

  test('is re-centred', () => {
    assert.ok(Math.abs(HISTORICAL_AU_SERIES.deviations.reduce((s, x) => s + x, 0)) < 1e-9);
  });
});

describe('EquityReturnTickHandler — AU replay', () => {
  test('a year with AU data replays AU\'s own deviation, rescaled, with no AU idio draw', () => {
    const rng = countingRng(startAt(1974));
    const a   = handler().call({ sim: { rng }, state: {} })[0];
    assert.equal(a.bootstrap.year, 1974);
    assert.equal(rng.calls, 1, 'only the block start — the AU idio draw is skipped');
    const beta     = DEFAULT_EQUITY_BETA[AU];
    const sleeveSd = Math.sqrt(beta * beta * US_SD * US_SD + AU_IDIO * AU_IDIO);
    const expected = HISTORICAL_AU_SERIES.deviations[1974 - 1958] * (sleeveSd / HISTORICAL_AU_SERIES.sd);
    assert.ok(Math.abs(a.deviation[AU] - expected) < 1e-15);
    // The US sleeve is untouched: β = 1 on the market factor.
    assert.ok(Math.abs(a.deviation[RATE_KEYS.EQUITY_US] - a.marketDev) < 1e-15);
  });

  test('a year before 1958 falls back to β × market + idio (one AU draw)', () => {
    const rng = countingRng(startAt(1900));
    const a   = handler().call({ sim: { rng }, state: {} })[0];
    assert.equal(a.bootstrap.year, 1900);
    assert.equal(rng.calls, 3, 'block start (1 uniform) + the AU idio Gaussian (2)');
  });

  test('auReplay: false keeps β × market + idio in every year', () => {
    const rng = countingRng(startAt(1974));
    const a   = handler({ auReplay: false, idioVol: ZERO_IDIO }).call({ sim: { rng }, state: {} })[0];
    assert.ok(Math.abs(a.deviation[AU] - DEFAULT_EQUITY_BETA[AU] * a.marketDev) < 1e-15);
  });

  test('the drift compensation is the sleeve\'s model variance either way', () => {
    const on  = handler().call({ sim: { rng: countingRng(startAt(1974)) }, state: {} })[0];
    const off = handler({ auReplay: false }).call({ sim: { rng: countingRng(startAt(1974)) }, state: {} })[0];
    assert.equal(on.driftComp[AU], off.driftComp[AU]);
  });

  test('WHITE_NOISE never replays AU history', () => {
    const rng = countingRng(0.3);
    new EquityReturnTickHandler({ model: 'WHITE_NOISE', idioVol: { ...ZERO_IDIO, [AU]: AU_IDIO } }).call({ sim: { rng }, state: {} });
    assert.equal(rng.calls, 4, 'market Gaussian + AU idio Gaussian');
  });

  test('toJSON / fromJSON round-trips the flag', () => {
    assert.equal(EquityReturnTickHandler.fromJSON(handler({ auReplay: false }).toJSON()).auReplay, false);
  });
});

describe('AU replay — e2e', () => {
  const END = Date.UTC(2040, 0, 1);
  const auDev = (replay) => loadScenarioSim({
    telemetry: 'off', simEnd: END, stepTo: END,
    params: { equityReturnStochastic: true, equityReturnModel: 'HISTORICAL_BOOTSTRAP', randomSeed: 7, equityReturnBootstrapAuReplay: replay },
  }).sim.state.equityReturnDev[AU];

  test('the scenario toggle reaches the handler', () => {
    assert.notEqual(auDev(true), auDev(false));
  });
});
