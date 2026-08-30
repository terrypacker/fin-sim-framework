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
 * scripts-path-grid.test.mjs
 *
 * `scripts/lib/path.mjs` reads the PATH a run took; `scripts/lib/grid.mjs` runs the
 * cells and tables them. Both are small, and both carry a trap that produced a wrong
 * answer before it was found:
 *
 *  · `sleeveReturn` restricted to untouched lots — a whole-book estimator reads a SALE
 *    as a market loss, so the arm that sells most looks like the arm that lived through
 *    the worst market.
 *  · coupons and dividends added back — they are paid OUT to cash, never accrue into a
 *    lot's market value, so a price-only reading scores bonds at ~0%/yr.
 *  · a cell that throws ABORTS the grid — the characteristic failure is a grid that
 *    completes having measured nothing, and a caught error turns that into one odd cell
 *    in an otherwise complete table.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { lotSnapshot, sleeveReturn, sleeveReturnTracker, troughTracker } from '../../scripts/lib/path.mjs';
import { runGrid, markdownTable, escapeMoney, gridEnvelope } from '../../scripts/lib/grid.mjs';

/** A state holding one equity lot and one bond lot, at the given values. */
const state = ({ eqMv, eqCb, bdMv, bdCb, coupon = 0.04, face = 100_000 }) => ({
  usStockAccount: {
    balance: 1, currency: { code: 'USD' },
    holdings: [
      { id: 'eq1', allocation: 'EQUITY', marketValue: eqMv, costBasis: eqCb },
      { id: 'bd1', allocation: 'BOND', marketValue: bdMv, costBasis: bdCb,
        couponRate: coupon, faceValue: face },
    ],
  },
});

describe('path — sleeveReturn', () => {
  test('a pure price move reads as the price move', () => {
    const a = lotSnapshot(state({ eqMv: 100, eqCb: 100, bdMv: 0, bdCb: 0 }));
    const b = lotSnapshot(state({ eqMv: 110, eqCb: 100, bdMv: 0, bdCb: 0 }));
    assert.equal(sleeveReturn(a, b, 'EQUITY').value, 0.10);
  });

  test('a SALE is excluded, not read as a crash', () => {
    // Cost basis moved ⇒ a flow. Counting it would report −50% in a flat market.
    const a = lotSnapshot(state({ eqMv: 100, eqCb: 100, bdMv: 0, bdCb: 0 }));
    const b = lotSnapshot(state({ eqMv: 50, eqCb: 50, bdMv: 0, bdCb: 0 }));
    const r = sleeveReturn(a, b, 'EQUITY');
    assert.equal(r.value, null, 'a sold lot must not contribute a return');
    assert.equal(r.lots, 0);
  });

  test('the equity dividend is added back', () => {
    const a = lotSnapshot(state({ eqMv: 100, eqCb: 100, bdMv: 0, bdCb: 0 }));
    const b = lotSnapshot(state({ eqMv: 100, eqCb: 100, bdMv: 0, bdCb: 0 }));
    assert.equal(sleeveReturn(a, b, 'EQUITY', 0.02).value, 0.02);
  });

  test('the bond coupon is added back, off faceValue not market value', () => {
    // The failure this prevents: a flat bond price reads as a 0% year, which is the
    // whole of a bond's return missing. Coupon is 4% of A FACE of 100,000 = 4,000 on a
    // 80,000 market value ⇒ 5%, not 4%.
    const a = lotSnapshot(state({ eqMv: 0, eqCb: 0, bdMv: 80_000, bdCb: 80_000 }));
    const b = lotSnapshot(state({ eqMv: 0, eqCb: 0, bdMv: 80_000, bdCb: 80_000 }));
    assert.equal(sleeveReturn(a, b, 'BOND').value, 0.05);
  });

  test('a lot that vanished between snapshots contributes nothing', () => {
    const a = lotSnapshot(state({ eqMv: 100, eqCb: 100, bdMv: 0, bdCb: 0 }));
    assert.equal(sleeveReturn(a, {}, 'EQUITY').value, null);
  });

  test('mixed currency is REPORTED rather than silently absorbed', () => {
    const s = state({ eqMv: 100, eqCb: 100, bdMv: 0, bdCb: 0 });
    s.auStockAccount = { balance: 1, currency: { code: 'AUD' },
      holdings: [{ id: 'eq2', allocation: 'EQUITY', marketValue: 155, costBasis: 155 }] };
    const a = lotSnapshot(s), b = lotSnapshot(s);
    assert.equal(sleeveReturn(a, b, 'EQUITY').mixedCurrency, true);
    assert.equal(sleeveReturn(lotSnapshot(state({ eqMv: 1, eqCb: 1, bdMv: 0, bdCb: 0 })),
      lotSnapshot(state({ eqMv: 1, eqCb: 1, bdMv: 0, bdCb: 0 })), 'EQUITY').mixedCurrency, false);
  });
});

describe('path — sleeveReturnTracker', () => {
  test('compounds, and divides by the years that PRODUCED a reading', () => {
    // Three observations ⇒ two intervals, both +10%. A year where every lot was touched
    // contributes nothing and must not be averaged in as a flat year.
    const t = sleeveReturnTracker();
    t.observe(state({ eqMv: 100, eqCb: 100, bdMv: 0, bdCb: 0 }));
    t.observe(state({ eqMv: 110, eqCb: 100, bdMv: 0, bdCb: 0 }));
    t.observe(state({ eqMv: 121, eqCb: 100, bdMv: 0, bdCb: 0 }));
    assert.ok(Math.abs(t.cagr('EQUITY') - 0.10) < 1e-12);
    assert.deepEqual(t.yearly('EQUITY'), [10, 10]);
  });

  test('a sleeve that never produced a reading is null, not zero', () => {
    const t = sleeveReturnTracker();
    t.observe(state({ eqMv: 100, eqCb: 100, bdMv: 0, bdCb: 0 }));
    assert.equal(t.cagr('BOND'), null);
  });
});

describe('path — troughTracker', () => {
  test('tracks the minimum and the year it happened', () => {
    const t = troughTracker(s => s.v);
    for (const [y, v] of [[2028, 5], [2029, 3], [2030, 4]]) t.observe({ v }, y);
    assert.equal(t.value, 3);
    assert.equal(t.year, 2029);
  });

  test('a window EXCLUDES years outside it', () => {
    // The transition year binds at every setting and says nothing about the lever, which
    // is why the window is a parameter and not a comment.
    const t = troughTracker(s => s.v, [2028, 2035]);
    t.observe({ v: 0.1 }, 2027);      // transition year — must not count
    t.observe({ v: 5 }, 2028);
    assert.equal(t.value, 5);
    assert.deepEqual(t.window, [2028, 2035]);
  });

  test('an untouched tracker is Infinity, which cannot be mistaken for a low reading', () => {
    assert.equal(troughTracker(() => 1, [2050, 2050]).value, Infinity);
  });
});

describe('grid', () => {
  const rows = [{ id: 'r1', label: 'Row one' }, { id: 'r2' }];
  const cols = [{ id: 'c1', label: 'Col one' }, { id: 'c2', label: 'Col two' }];

  test('runs every cell and keys them row/col', async () => {
    const { results, errors } = await runGrid({
      rows, cols, cell: (r, c) => ({ v: `${r.id}${c.id}` }),
    });
    assert.equal(errors, 0);
    assert.deepEqual(Object.keys(results).sort(), ['r1/c1', 'r1/c2', 'r2/c1', 'r2/c2']);
    assert.deepEqual(results['r2/c1'], { row: 'r2', col: 'c1', v: 'r2c1' });
  });

  test('a throwing cell ABORTS the grid by default', async () => {
    // Not a preference. A caught error turns a wiring failure into one odd entry in an
    // otherwise complete table — the exact shape of a finding.
    await assert.rejects(
      runGrid({ rows, cols, cell: (r) => { if (r.id === 'r2') throw new Error('inert axis'); return {}; } }),
      /inert axis/);
  });

  test("onError:'mark' keeps going and records the error", async () => {
    const { results, errors } = await runGrid({
      rows, cols, onError: 'mark',
      cell: (r) => { if (r.id === 'r2') throw new Error('boom'); return { ok: true }; },
    });
    assert.equal(errors, 2);
    assert.equal(results['r2/c1'].error, 'boom');
    assert.equal(results['r1/c1'].ok, true);
  });

  test('markdownTable emits a single-space corner when unlabelled', () => {
    const t = markdownTable({ rows, cols, cell: (r, c) => `${r.id}${c.id}` });
    const [head, sep, first] = t.split('\n');
    assert.equal(head, '| | Col one | Col two |');
    assert.equal(sep, '|---|---|---|');
    assert.equal(first, '| Row one | r1c1 | r1c2 |');
  });

  test('markdownTable uses the corner when given one', () => {
    const t = markdownTable({ rows, cols, corner: 'sleeve', cell: () => '' });
    assert.equal(t.split('\n')[0], '| sleeve | Col one | Col two |');
  });

  test('money is ESCAPED, or a row of two figures renders as LaTeX', () => {
    assert.equal(escapeMoney(1_234_567), '\\$1.23m');
    assert.equal(escapeMoney(null), '—');
    assert.equal(escapeMoney(Infinity), '—');
  });

  test('the envelope keeps the axes, not just the cells', () => {
    const env = gridEnvelope({ rows, cols, results: {}, base: 'plan.json' });
    assert.equal(env.base, 'plan.json');
    assert.deepEqual(env.rows, rows);
    assert.deepEqual(env.columns, cols);
    assert.ok(env.generatedAt);
  });
});
