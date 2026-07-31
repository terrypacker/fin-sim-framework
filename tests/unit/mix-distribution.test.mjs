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
 * mix-distribution.test.mjs — design 82 §8.
 *
 * The risk in this module is not that a percentile is off by a rank; it is that the
 * report answers a DIFFERENT QUESTION than its label, plausibly. The three ways that
 * happens, each pinned below:
 *
 *   1. **A ruined path is counted as a mix of zeros.** Then "REAL_ESTATE p50" quietly
 *      includes every path that holds nothing, and a plan looks less house-heavy the
 *      more often it goes broke. §8.2 requires those path-years to be EXCLUDED and the
 *      count surfaced.
 *   2. **A threshold is evaluated at a per-path instant.** "At simEnd" has to mean the
 *      same year for every path, or the rate mixes instants.
 *   3. **The bands are treated as a mix.** They are marginal — the tests assert that
 *      the p90s legitimately do NOT sum to 1, so nobody "fixes" that later.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  MIX_CLASSES, ILLIQUID_CLASSES, mixPoint, buildMixSeries, mixBands,
  thresholdProbability, thresholdProbabilities, mixByOutcome, outcomeGapAt,
  DEFAULT_MIX_THRESHOLDS,
} from '../../src/finance/allocation-reporting/mix-distribution.js';

const DATE = new Date(Date.UTC(2040, 11, 31));

const row = (assetClass, marketValue) => ({
  date: DATE, assetClass, marketValue, stateKey: 'k', source: 'holding',
});

// ── mixPoint ────────────────────────────────────────────────────────────────

test('MIX-1: mixPoint reports shares of GROSS assets, liabilities excluded', () => {
  const { grossAssets, mix } = mixPoint([
    row('EQUITY', 600_000),
    row('BOND',   400_000),
    row('LIABILITY', -500_000),
  ]);

  // The mortgage does not shrink the denominator: an allocation is of gross assets.
  assert.equal(grossAssets, 1_000_000);
  assert.equal(mix.EQUITY, 0.6);
  assert.equal(mix.BOND,   0.4);
});

test('MIX-2: every class is emitted, present or not, so the matrix keeps a fixed shape', () => {
  const { mix } = mixPoint([row('EQUITY', 100)]);
  assert.deepEqual(Object.keys(mix), [...MIX_CLASSES]);
  assert.equal(mix.GOLD, 0);
  assert.ok(!('LIABILITY' in mix), 'LIABILITY is not a mix column');
});

test('MIX-3: a state holding nothing yields gross 0, and the caller must read that as ABSENT', () => {
  const { grossAssets, mix } = mixPoint([]);
  assert.equal(grossAssets, 0);
  // All zeros — indistinguishable from a real mix if `grossAssets` is ignored, which
  // is exactly why `gross` travels beside `shares` in the recorded matrix.
  assert.ok(Object.values(mix).every(v => v === 0));
});

// ── buildMixSeries ──────────────────────────────────────────────────────────

const path = (seed, failed, series) => ({ seed, failed, series });
const sample = (year, gross, mix) => ({ year, grossAssetsUsd: gross, mix });

test('MIX-4: buildMixSeries produces a positional matrix with a fixed class header', () => {
  const built = buildMixSeries([
    path(1, false, [sample(2026, 1000, { EQUITY: 0.5, BOND: 0.5 }),
                    sample(2027, 2000, { EQUITY: 0.75, BOND: 0.25 })]),
  ]);

  assert.deepEqual(built.classes, [...MIX_CLASSES]);
  assert.deepEqual(built.years, [2026, 2027]);
  assert.deepEqual(built.paths[0].gross, [1000, 2000]);
  const eq = built.classes.indexOf('EQUITY');
  assert.equal(built.paths[0].shares[0][eq], 0.5);
  assert.equal(built.paths[0].shares[1][eq], 0.75);
});

test('MIX-5: a year one path is missing is left ABSENT, never carried forward', () => {
  const built = buildMixSeries([
    path(1, false, [sample(2026, 1000, { EQUITY: 1 }), sample(2027, 1000, { EQUITY: 1 })]),
    path(2, false, [sample(2026, 500,  { BOND: 1 })]),   // no 2027
  ]);

  assert.deepEqual(built.years, [2026, 2027]);
  // Gross 0 marks it absent. Repeating 2026's mix into 2027 would invent a data point,
  // which is the one thing a distribution must never do.
  assert.equal(built.paths[1].gross[1], 0);
  assert.ok(built.paths[1].shares[1].every(v => v === 0));
});

test('MIX-6: buildMixSeries returns null when no path carried a mix', () => {
  assert.equal(buildMixSeries([]), null);
  assert.equal(buildMixSeries([path(1, false, [])]), null);
});

// ── bands, and the 0/0 rule ─────────────────────────────────────────────────

/** Four paths at one year: three solvent with rising house share, one ruined. */
function fourPaths() {
  return buildMixSeries([
    path(1, false, [sample(2050, 1000, { EQUITY: 0.80, REAL_ESTATE: 0.20 })]),
    path(2, false, [sample(2050, 1000, { EQUITY: 0.50, REAL_ESTATE: 0.50 })]),
    path(3, false, [sample(2050, 1000, { EQUITY: 0.10, REAL_ESTATE: 0.90 })]),
    path(4, true,  [sample(2050, 0,    { EQUITY: 0,    REAL_ESTATE: 0 })]),
  ]);
}

test('MIX-7: THE 0/0 RULE — a path holding nothing is excluded, not counted as 0% house', () => {
  const b = mixBands(fourPaths(), { percentiles: [0.50] });

  assert.equal(b.n[0], 3, 'three paths had a mix');
  assert.equal(b.excluded[0], 1, 'the ruined path is reported, not absorbed');

  // Median of {0.20, 0.50, 0.90} = 0.50. Had the ruined path been folded in as 0%,
  // the median of {0, 0.20, 0.50, 0.90} would drop to 0.20 — a plan that looks LESS
  // house-heavy precisely because it went broke more often.
  assert.equal(b.bands.REAL_ESTATE[0.50][0], 0.50);
});

test('MIX-8: bands are MARGINAL — the p90s do not sum to 1, and must not be made to', () => {
  // Five paths, each concentrated in a different class. Every path's own shares sum to
  // 1, so nothing here is malformed — the bands still cannot be added.
  const series = buildMixSeries([
    path(1, false, [sample(2050, 1000, { EQUITY: 0.80, BOND: 0.10, REAL_ESTATE: 0.10 })]),
    path(2, false, [sample(2050, 1000, { EQUITY: 0.60, BOND: 0.20, REAL_ESTATE: 0.20 })]),
    path(3, false, [sample(2050, 1000, { EQUITY: 0.40, BOND: 0.30, REAL_ESTATE: 0.30 })]),
    path(4, false, [sample(2050, 1000, { EQUITY: 0.20, BOND: 0.40, REAL_ESTATE: 0.40 })]),
    path(5, false, [sample(2050, 1000, { EQUITY: 0.10, BOND: 0.45, REAL_ESTATE: 0.45 })]),
  ]);

  const b = mixBands(series, { percentiles: [0.90] });
  const total = b.classes.reduce((sum, c) => sum + (b.bands[c][0.90][0] ?? 0), 0);

  // EQUITY p90 = 0.60 comes from path 2; BOND and REAL_ESTATE p90 = 0.40 from path 4.
  // Different worlds, so they sum to 1.4. Any renderer that stacks these asserts a mix
  // nobody held — which is why §8.2 forbids stacking outright.
  assert.equal(b.bands.EQUITY[0.90][0], 0.60);
  assert.equal(b.bands.REAL_ESTATE[0.90][0], 0.40);
  assert.ok(total > 1.3, `marginal bands sum to ${total}, not 1 — this is correct`);
});

test('MIX-9: percentiles are nearest-rank, so every band value is a share some path held', () => {
  const b = mixBands(fourPaths(), { percentiles: [0.10, 0.50, 0.90] });
  const held = new Set([0.20, 0.50, 0.90]);
  for (const p of [0.10, 0.50, 0.90]) {
    assert.ok(held.has(b.bands.REAL_ESTATE[p][0]),
      `p${p} = ${b.bands.REAL_ESTATE[p][0]} was actually held by a path`);
  }
});

// ── thresholds ──────────────────────────────────────────────────────────────

test('MIX-10: an "end" threshold reads the SAME year for every path', () => {
  const series = buildMixSeries([
    // Path 1 is house-heavy early and diversified at the end; path 2 the reverse.
    path(1, false, [sample(2050, 1000, { REAL_ESTATE: 0.90 }), sample(2051, 1000, { REAL_ESTATE: 0.10 })]),
    path(2, false, [sample(2050, 1000, { REAL_ESTATE: 0.10 }), sample(2051, 1000, { REAL_ESTATE: 0.90 })]),
  ]);

  const t = thresholdProbability(series, {
    key: 're', label: 're', classes: ['REAL_ESTATE'], op: '>=', share: 0.60, when: 'end',
  });

  assert.equal(t.toYear, 2051);
  assert.equal(t.n, 2);
  assert.equal(t.hits, 1, 'only path 2 is house-heavy at 2051');
  assert.equal(t.rate, 0.5);
});

test('MIX-11: "any" scans the window; a class-list threshold SUMS the shares', () => {
  const series = buildMixSeries([
    path(1, false, [sample(2050, 1000, { REAL_ESTATE: 0.40, PRIVATE_EQUITY: 0.40 }),
                    sample(2051, 1000, { EQUITY: 1 })]),
    path(2, false, [sample(2050, 1000, { EQUITY: 1 }), sample(2051, 1000, { EQUITY: 1 })]),
  ]);

  const t = thresholdProbability(series, {
    key: 'illiquid', label: 'illiquid', classes: [...ILLIQUID_CLASSES],
    op: '>=', share: 0.75, when: 'any',
  });

  // 0.40 + 0.40 = 0.80 in 2050 — neither class alone would clear 0.75, which is the
  // point of summing rather than testing each in turn.
  assert.equal(t.hits, 1);
  assert.equal(t.n, 2);
});

test('MIX-12: a path with no mix anywhere in the window is EXCLUDED, not a miss', () => {
  const series = buildMixSeries([
    path(1, false, [sample(2050, 1000, { REAL_ESTATE: 0.90 })]),
    path(2, true,  [sample(2050, 0,    { REAL_ESTATE: 0 })]),
  ]);

  const t = thresholdProbability(series, {
    key: 're', label: 're', classes: ['REAL_ESTATE'], op: '>=', share: 0.60, when: 'end',
  });

  // 1/1, not 1/2. A ruined path has no shape; counting it as "not house-heavy" would
  // answer "how often is the plan both solvent and house-heavy" under this label.
  assert.equal(t.n, 1);
  assert.equal(t.excluded, 1);
  assert.equal(t.rate, 1);
});

test('MIX-13: toOffset narrows the window to the first N years', () => {
  const series = buildMixSeries([
    path(1, false, [
      sample(2050, 1000, { EQUITY: 1 }),
      sample(2051, 1000, { EQUITY: 1 }),
      sample(2052, 1000, { EQUITY: 0 }),   // equity gone, but late
    ]),
  ]);

  const early = thresholdProbability(series, {
    key: 'gone', label: 'gone', classes: ['EQUITY'], op: '<=', share: 0.001,
    when: 'any', toOffset: 1,
  });
  const ever = thresholdProbability(series, {
    key: 'gone', label: 'gone', classes: ['EQUITY'], op: '<=', share: 0.001, when: 'any',
  });

  assert.equal(early.toYear, 2051);
  assert.equal(early.hits, 0);
  assert.equal(ever.hits, 1);
});

test('MIX-14: the shipped threshold set evaluates on a real-shaped matrix', () => {
  const results = thresholdProbabilities(fourPaths(), DEFAULT_MIX_THRESHOLDS);
  assert.equal(results.length, DEFAULT_MIX_THRESHOLDS.length);
  for (const r of results) {
    assert.equal(r.n, 3, `${r.key} tested the three solvent paths`);
    assert.equal(r.excluded, 1);
    assert.ok(r.rate >= 0 && r.rate <= 1);
  }
  // One path of three ends ≥60% house.
  assert.equal(results.find(r => r.key === 'real-estate-60-end').rate, 1 / 3);
});

// ── conditioning on failure ─────────────────────────────────────────────────

test('MIX-15: mixByOutcome splits the bands and keeps both counts', () => {
  const series = buildMixSeries([
    path(1, true,  [sample(2050, 1000, { REAL_ESTATE: 0.90, EQUITY: 0.10 })]),
    path(2, true,  [sample(2050, 1000, { REAL_ESTATE: 0.80, EQUITY: 0.20 })]),
    path(3, false, [sample(2050, 1000, { REAL_ESTATE: 0.20, EQUITY: 0.80 })]),
  ]);

  const split = mixByOutcome(series, { percentiles: [0.50] });
  assert.equal(split.nFailed, 2);
  assert.equal(split.nSurvived, 1);
  assert.equal(split.survived.bands.REAL_ESTATE[0.50][0], 0.20);

  const gap = outcomeGapAt(series);
  const house = gap.rows.find(r => r.key === 'REAL_ESTATE');
  // Failing paths are the house-heavy ones ⇒ the shape IS the failure mechanism.
  assert.ok(house.gap > 0.5, `house gap ${house.gap} is the finding to act on`);
  assert.equal(gap.year, 2050);
});

test('MIX-16: outcomeGapAt reports nothing to condition on when no path failed', () => {
  const gap = outcomeGapAt(buildMixSeries([
    path(1, false, [sample(2050, 1000, { EQUITY: 1 })]),
  ]));
  assert.equal(gap.nFailed, 0);
  assert.equal(gap.rows.find(r => r.key === 'EQUITY').failed, null);
});
