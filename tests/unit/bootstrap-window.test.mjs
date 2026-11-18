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
 *   - `formatReturnPaths` turns it into the panel's line;
 *   - phase 2: an authored first year (`equityReturnBootstrapFromYear`) — the 50-year floor, the
 *     joint-mode clamp to 1951 with its warning, the pairing window, and the e2e effect.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { describeBootstrapWindow, bootstrapWindowName, bootstrapWindowWarning, authoredBootstrapFrom,
  HISTORICAL_LAST_YEAR, LATEST_BOOTSTRAP_FROM } from '../../src/finance/economic-regimes/bootstrap-window.js';
import { EquityReturnTickHandler, HISTORICAL_BOOTSTRAP_WINDOWS } from '../../src/finance/economic-regimes/equity-return-tick-handler.js';
import { EquityReturnStepReducer } from '../../src/finance/economic-regimes/equity-return-step-reducer.js';
import { mcReturnPaths, mcEquityWindow } from '../../src/finance/monte-carlo/parallel/mc-worker-core.js';
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

// ─── phase 2: an authored first year ───────────────────────────────────────────

describe('equityReturnBootstrapFromYear — the rules (design 133 §3.2)', () => {
  const GAUSS = { ...BOOT, inflationStochastic: true, inflationModel: 'GAUSSIAN' };

  test('the latest allowed year keeps 50 years of history: 1974', () => {
    assert.equal(LATEST_BOOTSTRAP_FROM, 1974);
    assert.equal(HISTORICAL_LAST_YEAR - LATEST_BOOTSTRAP_FROM + 1, 50);
  });

  test('blank is the automatic window, exactly as before', () => {
    for (const blank of [null, undefined, '']) {
      assert.equal(bootstrapWindowName({ ...JOINT, equityReturnBootstrapFromYear: blank }), 'POSTWAR');
      assert.equal(bootstrapWindowName({ ...GAUSS, equityReturnBootstrapFromYear: blank }), 'FULL');
    }
  });

  test('a year samples from that year; 1871 and 1951 resolve to the named windows', () => {
    assert.equal(bootstrapWindowName({ ...GAUSS, equityReturnBootstrapFromYear: 1926 }), 1926);
    assert.equal(bootstrapWindowName({ ...GAUSS, equityReturnBootstrapFromYear: 1871 }), 'FULL');
    assert.equal(bootstrapWindowName({ ...GAUSS, equityReturnBootstrapFromYear: 1951 }), 'POSTWAR');
    assert.deepEqual(describeBootstrapWindow({ ...GAUSS, equityReturnBootstrapFromYear: 1926 }),
      { name: 1926, fromYear: 1926, toYear: 2023, automatic: false, reason: 'set' });
  });

  test('outside 1871–1974, or not a whole year, it refuses and names the floor', () => {
    for (const bad of [1870, 1975, 2000, 1950.5, 'abc']) {
      assert.throws(() => authoredBootstrapFrom({ equityReturnBootstrapFromYear: bad }), /1871 to 1974.*50 years/, String(bad));
    }
    assert.equal(authoredBootstrapFrom({ equityReturnBootstrapFromYear: '1960' }), 1960);
  });

  test('a stale invalid year does not fail a run that is not replaying history', () => {
    assert.equal(bootstrapWindowName({ equityReturnBootstrapFromYear: 2010 }), 'FULL');
    assert.equal(bootstrapWindowWarning({ equityReturnBootstrapFromYear: 1900 }), null);
  });

  test('under joint inflation a pre-1951 year clamps to 1951, and says so', () => {
    const p = { ...JOINT, equityReturnBootstrapFromYear: 1926 };
    assert.equal(bootstrapWindowName(p), 'POSTWAR');
    assert.equal(describeBootstrapWindow(p).reason, 'set to 1926; joint inflation starts in 1951');
    assert.match(bootstrapWindowWarning(p), /1926 runs from 1951.*Gaussian/);
    // At or after 1951 there is nothing to clamp.
    assert.equal(bootstrapWindowName({ ...JOINT, equityReturnBootstrapFromYear: 1970 }), 1970);
    assert.equal(bootstrapWindowWarning({ ...JOINT, equityReturnBootstrapFromYear: 1970 }), null);
  });
});

describe('equityReturnBootstrapFromYear — Monte Carlo', () => {
  test('the pairing window follows the resolved first year', () => {
    assert.equal(mcEquityWindow({}), 1951);
    assert.equal(mcEquityWindow({ equityReturnBootstrapFromYear: 1970 }), 1970);
    assert.equal(mcEquityWindow({ equityReturnBootstrapFromYear: 1926 }), 1951, 'joint clamps');
    assert.equal(mcEquityWindow({ equityReturnBootstrapFromYear: 1926, mcInflationModel: 'GAUSSIAN' }), 1926);
    assert.equal(mcEquityWindow({ mcEquityReturnModel: 'WHITE_NOISE', equityReturnBootstrapFromYear: 1926 }), null);
  });

  test('the panel line shows an authored year, and a clamped one says why', () => {
    assert.equal(formatReturnPaths(mcReturnPaths({ equityReturnBootstrapFromYear: 1970 })),
      'Equity: historical bootstrap, 1970–2023 · Inflation: historical, joint with equity');
    assert.equal(formatReturnPaths(mcReturnPaths({ equityReturnBootstrapFromYear: 1926 })),
      'Equity: historical bootstrap, 1951–2023 (set to 1926; joint inflation starts in 1951) · Inflation: historical, joint with equity');
  });
});

describe('equityReturnBootstrapFromYear — e2e', () => {
  const END = Date.UTC(2060, 0, 1);
  const GAUSS = { ...BOOT, inflationStochastic: true, inflationModel: 'GAUSSIAN' };
  test('every replayed year is inside the authored window, and every window year is reachable', () => {
    const h = new EquityReturnTickHandler({ model: 'HISTORICAL_BOOTSTRAP', window: 1970, blockLength: 5,
      idioVol: { EQUITY_AU: 0, EQUITY_EX_US: 0, EQUITY_EX_AU: 0 } });
    const reducer = new EquityReturnStepReducer();
    let s = 1, state = {};
    const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const seen = new Set();
    for (let t = 0; t < 2000; t++) {
      const a = h.call({ sim: { rng }, state })[0];
      state = reducer.reduce(state, a);
      seen.add(a.bootstrap.year);
    }
    assert.equal(Math.min(...seen), 1970);
    assert.equal(Math.max(...seen), 2023);
    assert.equal(seen.size, 2023 - 1970 + 1);
  });

  test('under joint inflation a clamped year runs exactly the automatic post-war window', () => {
    const run = (extra) => JSON.stringify(loadScenarioSim({ telemetry: 'off', simEnd: END, stepTo: END,
      params: { randomSeed: 11, ...JOINT, ...extra } }).sim.state);
    assert.equal(run({ equityReturnBootstrapFromYear: 1926 }), run({}));
  });

  test('blank is byte-identical to before; a year changes the run', () => {
    const run = (extra) => JSON.stringify(loadScenarioSim({ telemetry: 'off', simEnd: END, stepTo: END,
      params: { randomSeed: 11, ...GAUSS, ...extra } }).sim.state);
    const blank = run({});
    assert.equal(run({ equityReturnBootstrapFromYear: null }), blank);
    assert.equal(run({ equityReturnBootstrapFromYear: 1871 }), blank, '1871 is FULL');
    assert.notEqual(run({ equityReturnBootstrapFromYear: 1970 }), blank);
  });

  test('a year outside the floor fails the compile with the rule', () => {
    assert.throws(() => loadScenarioSim({ telemetry: 'off', simEnd: END,
      params: { randomSeed: 11, ...GAUSS, equityReturnBootstrapFromYear: 1990 } }), /1871 to 1974/);
  });

  test('the handler is built on the year window', () => {
    const { sim } = loadScenarioSim({ telemetry: 'off', simEnd: END,
      params: { randomSeed: 11, ...GAUSS, equityReturnBootstrapFromYear: 1970 } });
    const h = [...sim.handlers.map.values()].flat().map(e => e?.handler ?? e).find(x => x instanceof EquityReturnTickHandler);
    assert.equal(h.window, 1970);
    assert.equal(h._window().firstYear + h._window().start, 1970);
    assert.equal(HISTORICAL_BOOTSTRAP_WINDOWS.FULL.start, 0);
  });
});

describe('equityReturnBootstrapFromYear — the sweep surface', () => {
  test('a grid axis over 1871–1974, never a batch draw or an optimizer lever', async () => {
    await import('../../src/visualization/workbench/plugins/finance/finance-plugin-package.js');
    const { buildGridAxes, buildOptVariables } = await import('../../src/finance/optimization/intl-retirement-opt-config.js');
    const { IntlRetirementMcConfig } = await import('../../src/finance/monte-carlo/intl-retirement-mc-config.js');
    const { paramSchemaDefaults }    = await import('../../src/finance/param-schema-utils.js');
    const { IntlRetirementScenario } = await import('../../src/scenarios/intl-retirement-scenario.js');
    const d = paramSchemaDefaults(IntlRetirementScenario.buildFullParamSchema());
    const KEY = 'equityReturnBootstrapFromYear';
    const axis = buildGridAxes(d).find(v => v.paramKey === KEY);
    assert.ok(axis, 'grid axis');
    assert.deepEqual([axis.min, axis.max, axis.step, axis.unset], [1871, 1974, 1, true]);
    // A typed centre still stays inside the history.
    assert.deepEqual((({ min, max }) => [min, max])(buildGridAxes({ ...d, [KEY]: 1972 }).find(v => v.paramKey === KEY)), [1967, 1974]);
    assert.equal(new IntlRetirementMcConfig().buildVariables(d).some(v => v.paramKey === KEY), false, 'no batch row');
    assert.equal(buildOptVariables(d).some(v => v.paramKey === KEY), false, 'no optimizer lever');
  });
});

describe('G-A2 — every window is exact on its own history (design 133 §8)', () => {
  // At an anchor equal to the window's own geometric mean, and the vol equal to its own sd,
  // replaying the whole window in order returns exactly that mean: re-centring and the
  // drift compensation are per window, so a window changes the shape and never the level.
  for (const from of [1871, 1926, 1951, 1970]) {
    test(`from ${from}`, async () => {
      const { bootstrapWindowFrom: winFrom } = await import('../../src/finance/economic-regimes/equity-return-tick-handler.js');
      const w = winFrom(from);
      const n = w.deviations.length;
      const r = (await import('../../src/finance/economic-regimes/historical-equity-returns.js')).HISTORICAL_EQUITY_RETURNS.returns.slice(w.start);
      const anchor = Math.exp(r.reduce((s, x) => s + Math.log(1 + x), 0) / n) - 1;
      const h = new EquityReturnTickHandler({ model: 'HISTORICAL_BOOTSTRAP', window: from, vol: w.sd, blockLength: n,
        idioVol: { EQUITY_AU: 0, EQUITY_EX_US: 0, EQUITY_EX_AU: 0 } });
      const reducer = new EquityReturnStepReducer();
      let state = {}, sumLog = 0;
      for (let t = 0; t < n; t++) {
        const a = h.call({ sim: { rng: () => 0 }, state })[0];   // one block, starting at `from`
        state = reducer.reduce(state, a);
        sumLog += Math.log(1 + anchor + a.deviation.EQUITY_US + a.driftComp.EQUITY_US);
      }
      assert.equal(state.equityReturnBootstrap.year, 2023);
      assert.ok(Math.abs(Math.exp(sumLog / n) - 1 - anchor) < 1e-9, `${from}: ${Math.exp(sumLog / n) - 1} vs ${anchor}`);
    });
  }
});
