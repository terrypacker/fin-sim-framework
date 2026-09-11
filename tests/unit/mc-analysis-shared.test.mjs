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
 * mc-analysis-shared.test.mjs — design 100 §2.1 / §2.4.
 *
 * The MC analysis moved into src so the app and the lab compute every band and rescue
 * count the same way. These pin: the lab path is the SAME module (not a copy that can
 * drift), the runs→rows adapter, and the return bands counting paths whose net worth
 * shrank — the old edges started at 0 and dropped them silently.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import * as shared from '../../src/finance/monte-carlo/mc-analysis.js';
import * as lab    from '../../scripts/lib/mc-analysis.mjs';

test('MCA-1 the lab module re-exports the shared functions, not copies', () => {
  for (const name of ['pairedRescues', 'pairedMetric', 'failureRate', 'failureByBand',
    'failureDrivers', 'runsToRows', 'RETURN_BAND_EDGES']) {
    assert.equal(lab[name], shared[name], name);
  }
});

test('MCA-2 runsToRows maps the runner shape to analysis rows', () => {
  const rows = shared.runsToRows([{
    seed: 7, scenarioFailed: true, outOfFundsDate: new Date(Date.UTC(2051, 5, 1)),
    finalNetWorthUsd: 10, afterTaxNetWorthUsd: 8, lifetimeRepairSpend: 3,
    pathShape: { netWorthCagr: 0.01, worst5yrCagr: -0.1, maxDrawdown: 0.4, troughRealNetLiquidity: 0 },
  }, { seed: 8, scenarioFailed: false }]);

  assert.deepEqual(rows[0], {
    seed: 7, failed: true, oof: '2051-06-01', nw: 10, afterTaxNW: 8,
    netWorthCagr: 0.01, worst5yrCagr: -0.1, maxDrawdown: 0.4, troughRealNetLiq: 0, repairSpend: 3,
  });
  // A run without pathShape (older result) maps to nulls, never zeros.
  assert.equal(rows[1].failed, false);
  assert.equal(rows[1].oof, null);
  assert.equal(rows[1].netWorthCagr, null);
});

test('MCA-3 the return bands count negative realized growth', () => {
  const rows = [
    { failed: true,  netWorthCagr: -0.02 },
    { failed: false, netWorthCagr: 0.05 },
    { failed: true,  netWorthCagr: null },
  ];
  const bands = shared.failureByBand(rows, 'netWorthCagr', shared.RETURN_BAND_EDGES);
  assert.deepEqual(bands[0], { lo: -1, hi: 0, n: 1, rate: 1 });
  assert.equal(bands.reduce((t, b) => t + b.n, 0), 2, 'every numeric CAGR lands in exactly one band');
});

test('MCA-4 failureDrivers reads out-of-funds years from adapted runner rows', () => {
  const rows = shared.runsToRows([
    { seed: 1, scenarioFailed: true, outOfFundsDate: new Date(Date.UTC(2049, 0, 1)), pathShape: { netWorthCagr: 0 } },
    { seed: 2, scenarioFailed: false, pathShape: { netWorthCagr: 0.05 } },
  ]);
  const d = shared.failureDrivers(rows, ['netWorthCagr']);
  assert.deepEqual(d.oofYears, [2049]);
  assert.equal(d.fields[0].survived, 0.05);
});
