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
 * bootstrap-window.test.mjs — design 133 phase 1 (the bootstrap window made visible).
 *
 *   - `describeBootstrapWindow` names the window a run samples: POSTWAR under joint
 *     inflation, FULL otherwise, nothing when the bootstrap is not the process;
 *   - the toolset builds the equity handler with that same window (one rule, two readers);
 *   - `mcReturnPaths` resolves what every Monte Carlo path runs, and the default Monte Carlo
 *     samples 1951–2023;
 *   - `formatReturnPaths` turns it into the panel's line.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { describeBootstrapWindow, bootstrapWindowName, HISTORICAL_LAST_YEAR } from '../../src/finance/economic-regimes/bootstrap-window.js';
import { EquityReturnTickHandler } from '../../src/finance/economic-regimes/equity-return-tick-handler.js';
import { mcReturnPaths }           from '../../src/finance/monte-carlo/parallel/mc-worker-core.js';
import { formatReturnPaths }       from '../../src/visualization/monte-carlo/mc-config-panel.js';
import { loadScenarioSim }         from '../helpers/scenario-harness.js';

const BOOT  = { equityReturnStochastic: true, equityReturnModel: 'HISTORICAL_BOOTSTRAP' };
const JOINT = { ...BOOT, inflationStochastic: true, inflationModel: 'HISTORICAL_JOINT' };

describe('describeBootstrapWindow', () => {
  test('joint inflation samples the post-war years', () => {
    assert.deepEqual(describeBootstrapWindow(JOINT),
      { name: 'POSTWAR', fromYear: 1951, toYear: 2023, automatic: true, reason: 'joint inflation' });
  });

  test('without joint inflation it samples the whole series', () => {
    const w = describeBootstrapWindow({ ...BOOT, inflationStochastic: true, inflationModel: 'GAUSSIAN' });
    assert.equal(w.name, 'FULL');
    assert.equal(w.fromYear, 1871);
    assert.equal(w.toYear, HISTORICAL_LAST_YEAR);
  });

  test('nothing to describe unless the bootstrap is the running process', () => {
    assert.equal(describeBootstrapWindow({}), null);
    assert.equal(describeBootstrapWindow({ ...JOINT, equityReturnStochastic: false }), null);
    assert.equal(describeBootstrapWindow({ ...JOINT, equityReturnModel: 'WHITE_NOISE' }), null);
  });
});

describe('the toolset builds the handler with the same window', () => {
  const END = Date.UTC(2028, 0, 1);
  const handlerWindow = (params) => {
    const { sim } = loadScenarioSim({ telemetry: 'off', simEnd: END, params: { randomSeed: 7, ...params } });
    const found = [...sim.handlers.map.values()].flat()
      .map(e => e?.handler ?? e).find(h => h instanceof EquityReturnTickHandler);
    assert.ok(found, 'an equity handler is built');
    return found.window;
  };

  for (const [label, params] of [['joint', JOINT], ['gaussian', { ...BOOT, inflationStochastic: true, inflationModel: 'GAUSSIAN' }]]) {
    test(label, () => assert.equal(handlerWindow(params), bootstrapWindowName(params)));
  }
});

describe('mcReturnPaths', () => {
  test('the default Monte Carlo runs the bootstrap on 1951–2023 with joint inflation', () => {
    const r = mcReturnPaths({});
    assert.equal(r.equityModel, 'HISTORICAL_BOOTSTRAP');
    assert.equal(r.inflationModel, 'HISTORICAL_JOINT');
    assert.equal(r.window.fromYear, 1951);
  });

  test('Gaussian Monte Carlo inflation widens it to the whole series', () => {
    assert.equal(mcReturnPaths({ mcInflationModel: 'GAUSSIAN' }).window.fromYear, 1871);
  });

  test('no window without the bootstrap, and the params passed in are untouched', () => {
    const p = { mcEquityReturnModel: 'WHITE_NOISE' };
    assert.equal(mcReturnPaths(p).window, null);
    assert.deepEqual(p, { mcEquityReturnModel: 'WHITE_NOISE' });
    assert.equal(mcReturnPaths({ mcSequenceRisk: false }).equityModel, null);
  });
});

describe('formatReturnPaths', () => {
  test('names the years and why they were chosen', () => {
    assert.equal(formatReturnPaths(mcReturnPaths({})),
      'Equity: historical bootstrap, 1951–2023 (automatic: joint inflation) · Inflation: historical, joint with equity');
  });

  test('no years for a non-bootstrap process, and off paths say so', () => {
    assert.equal(formatReturnPaths({ equityModel: 'WHITE_NOISE', inflationModel: 'GAUSSIAN', window: null }),
      'Equity: white noise · Inflation: Gaussian');
    assert.equal(formatReturnPaths({ equityModel: null, inflationModel: null, window: null }),
      'Equity: off (single-run returns) · Inflation: off (single-run inflation)');
    assert.equal(formatReturnPaths(null), '');
  });
});
