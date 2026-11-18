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
 * bootstrap-rolling.test.mjs — design 133 phase 4 (the rolling-start sweep).
 *
 *   - G-B3: under ROLLING with n = the number of start years, each start year appears exactly
 *     once, and the by-start-year strip's success values match the per-path rows;
 *   - path i's start is the window's first year + (i mod count), from the RESOLVED window;
 *   - RANDOM (and absent) leaves every path's params as before; the draw stream is untouched;
 *   - the panel line, the pairing record and the shading rule.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { rollingStartYears, applyRollingStart, ROLLING_SHADE_YEARS }
  from '../../src/finance/economic-regimes/bootstrap-window.js';
import { perturbParams, mcReturnPaths, mcEquityStart }
  from '../../src/finance/monte-carlo/parallel/mc-worker-core.js';
import { runsToRows, byStartYear, pairingMismatches } from '../../src/finance/monte-carlo/mc-analysis.js';
import { formatReturnPaths }      from '../../src/visualization/monte-carlo/mc-config-panel.js';
import { IntlRetirementMcRunner } from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { IntlRetirementMcConfig } from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';

const ROLL = { mcEquityBootstrapStarts: 'ROLLING' };

describe('the start year each path gets', () => {
  test('default MC (joint inflation): 1951 + i, cycling after 2023', () => {
    assert.equal(perturbParams(ROLL, 0, []).equityReturnBootstrapStartYear, 1951);
    assert.equal(perturbParams(ROLL, 72, []).equityReturnBootstrapStartYear, 2023);
    assert.equal(perturbParams(ROLL, 73, []).equityReturnBootstrapStartYear, 1951, 'cycles');
    assert.equal(perturbParams(ROLL, 0, []).equityReturnBootstrapStartRun, null, 'replays through 2023');
  });

  test('the resolved window decides: FULL without joint inflation, an authored year when set', () => {
    const gauss = { ...ROLL, mcInflationModel: 'GAUSSIAN' };
    assert.deepEqual(rollingStartYears(perturbParams(gauss, 0, [])), { fromYear: 1871, toYear: 2023, count: 153 });
    assert.equal(perturbParams({ ...gauss, equityReturnBootstrapFromYear: 1926 }, 3, []).equityReturnBootstrapStartYear, 1929);
    // Clamped under joint inflation: no rolling start before 1951, so no Gaussian-inflation years.
    assert.equal(perturbParams({ ...ROLL, equityReturnBootstrapFromYear: 1926 }, 0, []).equityReturnBootstrapStartYear, 1951);
  });

  test('ROLLING replaces an authored start year and run', () => {
    const p = perturbParams({ ...ROLL, equityReturnBootstrapStartYear: 1966, equityReturnBootstrapStartRun: 15 }, 2, []);
    assert.equal(p.equityReturnBootstrapStartYear, 1953);
    assert.equal(p.equityReturnBootstrapStartRun, null);
  });

  test('RANDOM, absent, or off the bootstrap: params unchanged', () => {
    for (const base of [{}, { mcEquityBootstrapStarts: 'RANDOM' },
      { ...ROLL, mcEquityReturnModel: 'WHITE_NOISE' }, { ...ROLL, mcSequenceRisk: false }]) {
      assert.equal(perturbParams(base, 5, []).equityReturnBootstrapStartYear, undefined, JSON.stringify(base));
    }
    const p = { a: 1 };
    assert.equal(applyRollingStart(p, 3), p);
    assert.deepEqual(p, { a: 1 });
  });
});

describe('the readouts', () => {
  test('the panel line says the starts roll', () => {
    const info = mcReturnPaths(ROLL);
    assert.deepEqual(info.start, { rolling: true, fromYear: 1951, toYear: 2023, count: 73 });
    assert.match(formatReturnPaths(info), /rolling starts: path 1 opens with 1951, each next path a year later \(73 start years/);
  });

  test('the pairing record: a rolling batch pairs with neither a random nor a pinned one', () => {
    assert.equal(mcEquityStart(ROLL), 'ROLLING');
    assert.equal(mcEquityStart({ ...ROLL, mcEquityReturnModel: 'WHITE_NOISE' }), null);
    const rec = (equityStart) => ({ n: 3, seeds: [1, 2, 3], sampled: [], equityModel: 'HISTORICAL_BOOTSTRAP', equityStart });
    assert.ok(pairingMismatches(rec('ROLLING'), rec(null)).includes('pinned start rolling (one per path) vs none'));
    assert.deepEqual(pairingMismatches(rec('ROLLING'), rec('ROLLING')), []);
  });

  test('rows carry startYear and real terminal wealth only when the path was pinned', () => {
    const [a, b] = runsToRows([
      { seed: 1, params: { equityReturnBootstrapStartYear: 1966 }, finalNetWorthUsd: 3e6,
        terminalRates: { priceLevels: { US: 2 }, usdAud: 1.5 } },
      { seed: 2, params: {}, finalNetWorthUsd: 3e6 }]);
    assert.equal(a.startYear, 1966);
    assert.equal(a.realNw, 1.5e6);
    assert.equal('startYear' in b, false);
    assert.equal('realNw' in b, false);
  });

  test('byStartYear ranks on real wealth when every row has it: inflation is what starts differ in', () => {
    const rows = [
      { startYear: 1951, failed: false, nw: 4, realNw: 3 },
      { startYear: 1973, failed: false, nw: 9, realNw: 1 },   // high nominal, poor real
    ];
    const ys = byStartYear(rows, { lastYear: 2023 });
    assert.deepEqual(ys.map(y => [y.medianNw, y.real]), [[3, true], [1, true]]);
  });

  test('byStartYear groups, orders and shades under 15 years (or under a shorter horizon)', () => {
    const rows = [
      { startYear: 2015, failed: false, nw: 5, minRealNetLiq: 1 },
      { startYear: 1966, failed: true,  nw: 1, minRealNetLiq: 0 },
      { startYear: 1966, failed: false, nw: 3, minRealNetLiq: 2 },
      { seed: 9, failed: true },   // unpinned: not in the strip
    ];
    const ys = byStartYear(rows, { lastYear: 2023, horizonYears: 40 });
    assert.deepEqual(ys.map(y => y.startYear), [1966, 2015]);
    assert.deepEqual(ys[0], { startYear: 1966, n: 2, failed: 1, successRate: 0.5, minRealNetLiq: 0,
                              medianNw: 2, real: false, pinnedYears: 40, short: false });
    assert.equal(ys[1].pinnedYears, 9);
    assert.equal(ys[1].short, true);
    // A 5-year plan replays all of its years from 2015: nothing to shade.
    assert.equal(byStartYear(rows, { lastYear: 2023, horizonYears: 5 })[1].short, false);
    assert.equal(ROLLING_SHADE_YEARS, 15);
  });
});

describe('G-B3: a rolling batch covers every start', () => {
  test('n = 73 ⇒ each of 1951–2023 once; the strip matches the rows', async () => {
    const simStart = new Date(Date.UTC(2026, 0, 1));
    const simEnd   = new Date(Date.UTC(2028, 1, 1));
    const cfgTemplate = IntlRetirementScenario.buildDefaultConfig({ fxProcessModel: 'NONE' }, simStart, simEnd);
    const { runs, summary } = await new IntlRetirementMcRunner({
      n: 73, simStart, simEnd, cfgTemplate, mcConfig: new IntlRetirementMcConfig(),
    }).run(ROLL);

    assert.equal(summary.pairing.equityStart, 'ROLLING');
    const rows  = runsToRows(runs);
    const years = rows.map(r => r.startYear).sort((a, b) => a - b);
    assert.deepEqual(years, Array.from({ length: 73 }, (_, i) => 1951 + i));

    const strip = byStartYear(rows, { lastYear: 2023 });
    assert.equal(strip.length, 73);
    for (const y of strip) {
      const row = rows.find(r => r.startYear === y.startYear);
      assert.equal(y.n, 1);
      assert.equal(y.successRate, row.failed ? 0 : 1, `start ${y.startYear}`);
    }
  });
});
