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
 * mix-series-from-runs.test.mjs — design 100 §4.
 *
 * The runs → mix-matrix conversion used to live inline in `scripts/lib/mc.mjs`. The MC tab
 * needs the same conversion, so it moved into `mix-distribution.js`. These pin its shape
 * and that a run made without `mix: true` yields null (nothing to draw), not an empty mix.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { mixSeriesFromRuns, MIX_CLASSES } from '../../src/finance/allocation-reporting/mix-distribution.js';

const point = (year, gross, mix) => ({ date: new Date(Date.UTC(year, 0, 1)), grossAssetsUsd: gross, mix });

test('MSR-1 builds the matrix from runs that recorded a mix', () => {
  const [a, b] = MIX_CLASSES;
  const ms = mixSeriesFromRuns([
    { seed: 1, scenarioFailed: false, timeSeries: [point(2030, 100, { [a]: 1 }), point(2031, 120, { [a]: 0.5, [b]: 0.5 })] },
    { seed: 2, scenarioFailed: true,  timeSeries: [point(2030, 80, { [b]: 1 }), point(2031, 0, {})] },
  ]);

  assert.deepEqual(ms.years, [2030, 2031]);
  assert.equal(ms.paths.length, 2);
  assert.equal(ms.paths[1].failed, true);
  assert.deepEqual(ms.paths[0].gross, [100, 120]);
  const ai = ms.classes.indexOf(a);
  assert.equal(ms.paths[0].shares[0][ai], 1);
  assert.equal(ms.paths[0].shares[1][ai], 0.5);
});

test('MSR-2 points without a mix are skipped; a batch with none returns null', () => {
  const runs = [{ seed: 1, scenarioFailed: false, timeSeries: [{ date: new Date(Date.UTC(2030, 0, 1)), netWorthUsd: 5 }] }];
  assert.equal(mixSeriesFromRuns(runs), null);
  assert.equal(mixSeriesFromRuns([]), null);
});

test('MSR-3 accepts dates that were serialized to strings', () => {
  const [a] = MIX_CLASSES;
  const ms = mixSeriesFromRuns([{ seed: 1, scenarioFailed: false,
    timeSeries: [{ date: '2030-01-01T00:00:00.000Z', grossAssetsUsd: 10, mix: { [a]: 1 } }] }]);
  assert.deepEqual(ms.years, [2030]);
});
