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
 * mc-grid-metrics.test.mjs — ranking grid cells by a chosen criterion (design 100 §10).
 *
 * Pins:
 *   - one percentile formula: the registry reproduces the cell summary's numbers exactly;
 *   - a "zero on failure" metric at a percentile inside the failures is flagged, not
 *     ranked as if it measured something (§10.3.4), and survivors-only reads past it;
 *   - dense ranks, ties shared, degenerate cells last by failure rate;
 *   - the paired reading is `pairedMetric` / `pairedRescues`, and the paired failure rate
 *     is exactly the difference in failure counts (§10.3.6);
 *   - a field older rows lack is unavailable, never zero.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import {
  GRID_METRICS, GRID_STATS, GRID_READINGS, FAILURE_RATE,
  gridMetric, gridCellMetric, rankCells, normalizeGridReading,
  normalizeGridConstraints, normalizeGridColumns, activeConstraints, gridConstraintCheck,
  constraintThreshold, betterOp, DEFAULT_GRID_COLUMNS,
} from '../../src/finance/monte-carlo/mc-grid-metrics.js';
import { summarizeGridCell, GRID_MODES } from '../../src/finance/monte-carlo/mc-grid.js';
import { pairedMetric } from '../../src/finance/monte-carlo/mc-analysis.js';

/** Ten paths; the first `fails` fail and trough at zero, as a failed path does. */
function cellRows(fails, scale = 1) {
  return Array.from({ length: 10 }, (_, k) => {
    const seed = k + 1, failed = k < fails;
    return {
      seed, failed, nw: seed * 100 * scale, afterTaxNW: (seed * 90 + (seed % 3) * 7) * scale,
      netWorthCagr: seed / 100, taxPaid: seed * 10 * scale,
      troughRealNetLiq: failed ? 0 : seed * 50 * scale,
    };
  });
}

describe('gridCellMetric — level', () => {
  test('MGM-1 the registry reproduces the cell summary exactly (one percentile formula)', () => {
    const rows = cellRows(2);
    const s = summarizeGridCell(rows, { sampled: [], mcSequenceRisk: true });
    assert.equal(gridCellMetric(rows, { metric: 'afterTaxNW' }).value, s.medianAfterTaxNW);
    assert.equal(gridCellMetric(rows, { metric: 'nw', stat: GRID_STATS.P10 }).value, s.p10);
    assert.equal(gridCellMetric(rows, { metric: 'nw', stat: GRID_STATS.P90 }).value, s.p90);
    assert.equal(gridCellMetric(rows, { metric: 'troughRealNetLiq', stat: GRID_STATS.P10 }).value,
      s.pathShape.p10TroughRealNetLiquidity);
    assert.equal(gridCellMetric(rows, { metric: FAILURE_RATE }).value, s.failureRate);
  });

  test('MGM-2 a zero-on-failure percentile inside the failures is degenerate and ranks last', () => {
    const none = gridCellMetric(cellRows(0), { metric: 'troughRealNetLiq', stat: GRID_STATS.P10 });
    const two  = gridCellMetric(cellRows(2), { metric: 'troughRealNetLiq', stat: GRID_STATS.P10 });
    const four = gridCellMetric(cellRows(4), { metric: 'troughRealNetLiq', stat: GRID_STATS.P10 });
    assert.equal(none.degenerate, false);
    assert.equal(two.degenerate, true, '20% failed, so P10 lands on a failed path');
    assert.equal(four.degenerate, true);
    // Degenerate cells rank after every valid one, the fewer failures first.
    assert.deepEqual(rankCells([four, none, two]), [3, 1, 2]);

    // P50 is still a measurement at 20% failed.
    assert.equal(gridCellMetric(cellRows(2), { metric: 'troughRealNetLiq' }).degenerate, false);
    // A metric that a failure does not zero is never flagged.
    assert.equal(gridCellMetric(cellRows(4), { metric: 'nw', stat: GRID_STATS.P10 }).degenerate, false);
  });

  test('MGM-3 survivors-only takes the statistic over surviving paths and counts them', () => {
    const r = gridCellMetric(cellRows(2), { metric: 'troughRealNetLiq', stat: GRID_STATS.P10, survivorsOnly: true });
    assert.equal(r.degenerate, false);
    assert.equal(r.survivors, 8);
    assert.equal(r.n, 8);
    // Survivors are seeds 3…10, troughs 150…500: P10 of eight points by interpolation.
    assert.equal(r.value, 150 + 0.7 * 50);
  });

  test('MGM-4 a field the rows lack is unavailable, never zero, and has no rank', () => {
    const old = cellRows(0).map(({ troughRealNetLiq: _t, ...r }) => r);
    const r = gridCellMetric(old, { metric: 'netLiq' });
    assert.equal(r.unavailable, true);
    assert.equal(r.value, null);
    assert.deepEqual(rankCells([r, gridCellMetric(cellRows(0), { metric: 'nw' })]), [null, 1]);
  });

  test('MGM-5 unknown metrics and statistics throw rather than rank on nothing', () => {
    assert.throws(() => gridMetric('netLiquidity'), /unknown "netLiquidity"/);
    assert.throws(() => gridCellMetric(cellRows(0), { metric: 'nw', stat: GRID_STATS.WIN_RATE }), /paired/);
    assert.throws(() => gridCellMetric(cellRows(0), { metric: 'nw', reading: GRID_READINGS.PAIRED }), /reference rows/);
    assert.equal(new Set(GRID_METRICS.map(m => m.id)).size, GRID_METRICS.length, 'ids are unique');
  });
});

describe('rankCells', () => {
  test('MGM-6 dense ranks in the metric\'s direction, ties shared', () => {
    const lower  = [0.1, 0.1, 0.3, 0.0].map(value => ({ value, better: 'lower' }));
    assert.deepEqual(rankCells(lower), [2, 2, 3, 1]);
    const higher = [5, 9, 9, null].map(value => ({ value, better: 'higher' }));
    assert.deepEqual(rankCells(higher), [2, 1, 1, null]);
  });
});

describe('gridCellMetric — paired against the reference', () => {
  test('MGM-7 a money Δ is pairedMetric\'s, and a win for a lower-is-better metric is a fall', () => {
    const ref = cellRows(0), rows = cellRows(0, 1.1);
    const pm = pairedMetric(ref, rows, 'afterTaxNW');
    const p = (stat, metric = 'afterTaxNW') =>
      gridCellMetric(rows, { metric, stat, reading: GRID_READINGS.PAIRED, refRows: ref });
    assert.equal(p(GRID_STATS.P10).value, pm.p10);
    assert.equal(p(GRID_STATS.P50).value, pm.p50);
    assert.equal(p(GRID_STATS.WIN_RATE).value, 1);
    assert.equal(p(GRID_STATS.WIN_RATE).better, 'higher');
    // Tax rose by 10% in every world: ahead on after-tax NW, behind on tax.
    assert.equal(p(GRID_STATS.WIN_RATE, 'taxPaid').value, 0);
    // The reference against itself is zero, not missing.
    assert.equal(gridCellMetric(ref, { metric: 'afterTaxNW', reading: GRID_READINGS.PAIRED, refRows: ref }).value, 0);
  });

  test('MGM-8 the paired failure rate is the difference in failure counts, with both rescue counts', () => {
    const fails = (seeds) => [1, 2, 3, 4].map(seed => ({ seed, failed: seeds.includes(seed) }));
    const ref = fails([1, 2]);
    const swap = gridCellMetric(fails([1, 3]), { metric: FAILURE_RATE, reading: GRID_READINGS.PAIRED, refRows: ref });
    assert.deepEqual([swap.rescues, swap.reverseRescues, swap.value], [1, 1, 0]);
    const better = gridCellMetric(fails([1]), { metric: FAILURE_RATE, reading: GRID_READINGS.PAIRED, refRows: ref });
    assert.equal(better.value, (1 - 2) / 4);
    assert.equal(better.reverseRescues, 0);
  });

  test('MGM-9 survivors-only pairs only the worlds where both cells survive', () => {
    const ref = cellRows(2), rows = cellRows(3, 1.1);
    const r = gridCellMetric(rows, { metric: 'afterTaxNW', reading: GRID_READINGS.PAIRED, refRows: ref, survivorsOnly: true });
    assert.equal(r.n, 7);
  });
});

describe('normalizeGridReading', () => {
  test('MGM-10 defaults per mode, and what a mode cannot do is dropped', () => {
    const core = ({ metric, stat, reading, survivorsOnly }) => ({ metric, stat, reading, survivorsOnly });
    assert.deepEqual(core(normalizeGridReading(null, GRID_MODES.MC)),
      { metric: FAILURE_RATE, stat: 'p50', reading: 'level', survivorsOnly: false });
    assert.deepEqual(core(normalizeGridReading({ metric: 'nw', stat: 'p10', reading: 'paired', survivorsOnly: true },
      GRID_MODES.DETERMINISTIC)), { metric: 'nw', stat: 'p50', reading: 'level', survivorsOnly: false });
    assert.equal(normalizeGridReading({ stat: 'winRate' }, GRID_MODES.MC).stat, 'p50', 'a win rate needs the paired reading');
    assert.equal(normalizeGridReading({ metric: 'gone' }, GRID_MODES.MC).metric, FAILURE_RATE);
    assert.equal(normalizeGridReading({ survivorsOnly: true }, GRID_MODES.MC).survivorsOnly, false,
      'the failure rate has no survivors-only form');
  });
});

describe('constraints and list columns (design 100 §10.10)', () => {
  test('MGM-11 constraints and columns are made valid, and travel with the reading', () => {
    const cs = normalizeGridConstraints([
      { metric: 'gone', threshold: 1 },
      { metric: FAILURE_RATE, stat: 'p10', op: '>=', threshold: 10 },
      { metric: 'troughRealNetLiq', stat: 'winRate', threshold: 5 },
      { metric: 'taxPaid', stat: 'p90', op: 'bogus', threshold: '' },
    ], GRID_MODES.MC);
    assert.deepEqual(cs, [
      { metric: FAILURE_RATE, stat: 'p50', op: '>=', threshold: 10 },          // no statistic; op kept
      { metric: 'troughRealNetLiq', stat: 'p50', op: '>=', threshold: 5 },     // a level has no win rate
      { metric: 'taxPaid', stat: 'p90', op: '<=', threshold: null },           // better direction; blank kept
    ]);
    assert.equal(normalizeGridConstraints([{ metric: 'nw', stat: 'p10', threshold: 1 }], GRID_MODES.DETERMINISTIC)[0].stat,
      'p50', 'a deterministic cell has one path');
    assert.equal(betterOp('afterTaxNW'), '>=');
    assert.equal(betterOp('deficit'), '<=');

    assert.deepEqual(normalizeGridColumns(undefined, GRID_MODES.MC), DEFAULT_GRID_COLUMNS);
    assert.deepEqual(normalizeGridColumns([], GRID_MODES.MC), [], 'removing every column is a real choice');
    assert.equal(normalizeGridColumns(undefined, GRID_MODES.DETERMINISTIC)[2].stat, 'p50');

    const r = normalizeGridReading({ constraints: [{ metric: FAILURE_RATE, threshold: 5 }] }, GRID_MODES.MC);
    assert.equal(r.constraints.length, 1);
    assert.deepEqual(r.columns, DEFAULT_GRID_COLUMNS);
    assert.deepEqual(r.listSort, { key: 'rank', reversed: false });
    assert.equal(normalizeGridReading(r, GRID_MODES.DETERMINISTIC).constraints.length, 1);
  });

  test('MGM-12 a threshold is typed in the printed unit, and the boundary meets', () => {
    const rows = cellRows(2);                                  // 20% failed
    const fr = (op, threshold) => normalizeGridConstraints([{ metric: FAILURE_RATE, op, threshold }], GRID_MODES.MC);
    assert.equal(gridConstraintCheck(rows, fr('<=', 20)).meets, true, '"20" means 20%, and 20% ≤ 20%');
    const miss = gridConstraintCheck(rows, fr('<=', 10));
    assert.equal(miss.meets, false);
    assert.equal(miss.misses[0].value, 0.2);
    assert.equal(constraintThreshold({ metric: FAILURE_RATE, threshold: 10 }), 0.1);
    assert.equal(constraintThreshold({ metric: 'taxPaid', threshold: 10 }), 10, 'money is not scaled');
  });

  test('MGM-13 a blank threshold is inactive', () => {
    const cs = normalizeGridConstraints([{ metric: FAILURE_RATE, threshold: null }], GRID_MODES.MC);
    assert.equal(activeConstraints(cs).length, 0);
    assert.equal(gridConstraintCheck(cellRows(9), cs).meets, true);
  });

  test('MGM-14 a constraint reads gridCellMetric\'s number; a degenerate floor and an unavailable field miss', () => {
    const floor = normalizeGridConstraints([{ metric: 'troughRealNetLiq', stat: 'p10', threshold: 1 }], GRID_MODES.MC);
    assert.equal(gridConstraintCheck(cellRows(0), floor).meets, true);
    const degen = gridConstraintCheck(cellRows(2), floor);
    assert.equal(degen.meets, false, 'P10 lands on a failed path at zero');
    assert.equal(degen.misses[0].value,
      gridCellMetric(cellRows(2), { metric: 'troughRealNetLiq', stat: 'p10' }).value);

    const gone = gridConstraintCheck(cellRows(0),
      normalizeGridConstraints([{ metric: 'deficit', threshold: 100 }], GRID_MODES.MC));
    assert.equal(gone.meets, false);
    assert.equal(gone.misses[0].unavailable, true);
  });

  test('MGM-15 ranks cover the eligible cells only', () => {
    const results = [
      gridCellMetric(cellRows(0), { metric: 'afterTaxNW' }),
      gridCellMetric(cellRows(0, 2), { metric: 'afterTaxNW' }),
      gridCellMetric(cellRows(0, 3), { metric: 'afterTaxNW' }),
    ];
    assert.deepEqual(rankCells(results), [3, 2, 1]);
    assert.deepEqual(rankCells(results, [true, true, false]), [2, 1, null]);
    // An ineligible degenerate cell takes no place among the degenerate ones either.
    const trough = [0, 2, 4].map(f => gridCellMetric(cellRows(f), { metric: 'troughRealNetLiq', stat: 'p10' }));
    assert.deepEqual(rankCells(trough, [true, false, true]), [1, null, 2]);
  });
});
