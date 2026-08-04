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
 * Design 84 §6.4b — `pairedMetric`, the money-metric sibling of `pairedRescues`.
 *
 * `pairedRescues` classifies each seed by the `failed` flag. That is right for "will
 * this plan survive" and empty for "which wrapper should this money sit in", because
 * a decant-vs-hold contrast runs on plans that mostly do not fail either way. The
 * first test below pins that motivation: identical rows where nothing fails give the
 * rescue view nothing to say and the money view a clear answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pairedRescues, pairedMetric } from '../../scripts/lib/mc-analysis.mjs';

const rows = (specs) => specs.map(([seed, afterTaxNW, failed = false]) => ({ seed, afterTaxNW, failed }));

test('the rescue view is empty where the money view is decisive', () => {
  const control   = rows([[1, 100], [2, 200], [3, 300]]);
  const treatment = rows([[1, 110], [2, 220], [3, 330]]);

  const r = pairedRescues(control, treatment);
  assert.equal(r.rescues, 0);
  assert.equal(r.reverseRescues, 0, 'nothing fails ⇒ the ruin view has nothing to report');

  const m = pairedMetric(control, treatment);
  assert.equal(m.wins, 3, 'the money view sees the treatment ahead in every world');
  assert.equal(m.losses, 0);
});

test('pairs by SEED, not by position', () => {
  const control   = rows([[1, 100], [2, 200], [3, 300]]);
  const treatment = rows([[3, 330], [1, 90], [2, 220]]);   // shuffled
  const m = pairedMetric(control, treatment);

  assert.equal(m.n, 3);
  assert.equal(m.wins, 2);
  assert.equal(m.losses, 1, 'seed 1 went backwards and must be counted as such');
  assert.equal(m.worst, -10);
});

test('the loss count is the finding — a favourable median does not hide it', () => {
  // Big wins, one real loss. A mean would drown it; the count must not.
  const control   = rows([[1, 100], [2, 100], [3, 100], [4, 100]]);
  const treatment = rows([[1, 500], [2, 500], [3, 500], [4,  90]]);
  const m = pairedMetric(control, treatment);

  assert.equal(m.wins, 3);
  assert.equal(m.losses, 1, 'state-dependent harm survives a strongly favourable centre');
  assert.equal(m.worst, -10);
  assert.ok(m.p50 > 0, 'the median is still positive — which is exactly why the count matters');
});

test('percentiles describe the DIFFERENCE, not either arm\'s level', () => {
  const control   = rows([[1, 1000], [2, 1000], [3, 1000], [4, 1000], [5, 1000]]);
  const treatment = rows([[1, 1010], [2, 1020], [3, 1030], [4, 1040], [5, 1050]]);
  const m = pairedMetric(control, treatment);

  assert.equal(m.p50, 30, 'median paired delta, not the median of ~1030');
  assert.equal(m.worst, 10);
  assert.equal(m.best, 50);
  assert.ok(Math.abs(m.medianRel - 0.03) < 1e-9);
});

test('unpaired and missing rows are reported, never silently dropped', () => {
  const control   = rows([[1, 100], [2, 200], [3, 300]]);
  const treatment = [{ seed: 1, afterTaxNW: 110, failed: false },
                     { seed: 2, failed: false }];              // seed 3 absent, seed 2 metric-less
  const m = pairedMetric(control, treatment);

  assert.equal(m.n, 1);
  assert.equal(m.unpaired, 1, 'seed 3 has no counterpart');
  assert.equal(m.missing, 1, 'seed 2 carries no metric — an arm run before the field existed');
});

test('tolerance folds noise into ties rather than into a direction', () => {
  const control   = rows([[1, 1000], [2, 1000]]);
  const treatment = rows([[1, 1000.4], [2, 999.6]]);
  const m = pairedMetric(control, treatment, 'afterTaxNW', 1);

  assert.equal(m.ties, 2);
  assert.equal(m.wins, 0);
  assert.equal(m.losses, 0, 'sub-tolerance jitter must not be reported as harm');
});

test('an alternate metric can be selected', () => {
  const control   = [{ seed: 1, taxPaid: 100 }, { seed: 2, taxPaid: 200 }];
  const treatment = [{ seed: 1, taxPaid: 90 },  { seed: 2, taxPaid: 260 }];
  const m = pairedMetric(control, treatment, 'taxPaid');

  assert.equal(m.metric, 'taxPaid');
  assert.equal(m.wins, 1);
  assert.equal(m.losses, 1);
});
