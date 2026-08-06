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
 * Frontier units — `unitForLever` and `model.reduceUnit`.
 *
 * A grid's `reduce` axis can be money (a spend ceiling), a rate (a break-even return)
 * or a year (an earliest safe retirement). The HTML study report formatted all three
 * as dollars, so a return frontier of -0.03 rendered as **"$0"** and every rate-reduced
 * grid advertised itself as inert — a headline panel reading "$0 – $0" trains the
 * reader to skip the panel. The unit has to travel with the model.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { unitForLever, buildGridModel } from '../../scripts/lib/grid-report.mjs';

describe('unitForLever', () => {
  test('classifies the levers studies actually reduce over', () => {
    assert.equal(unitForLever('spendTotal'),      'money');
    assert.equal(unitForLever('monthlyExpenses'), 'money');
    assert.equal(unitForLever('equityShift'),     'rate');
    assert.equal(unitForLever('retire.primary'),  'year');
    assert.equal(unitForLever('moveYear'),        'year');
    assert.equal(unitForLever('property.usHouseProperty.saleYear'),        'year');
    assert.equal(unitForLever('loan.auHousePropertyLoan.interestOnlyUntilYear'), 'year');
    assert.equal(unitForLever('loan.auHousePropertyLoan.primeSpread'),     'rate');
    assert.equal(unitForLever('offset.auOffsetAccount.balance'),           'money');
  });

  test('falls back to a raw number rather than guessing a currency', () => {
    // Printing the bare value looks wrong; printing "$0" for a rate IS wrong and
    // reads as a measured no-op. Prefer the former.
    assert.equal(unitForLever('somethingNovel'), 'number');
    assert.equal(unitForLever(undefined),        'number');
    assert.equal(unitForLever(null),             'number');
  });
});

describe('buildGridModel carries reduceUnit', () => {
  const spec = (reduceLever) => ({
    title: 't',
    axes: {
      fill:   { lever: 'offset.o.balance', values: [1, 0], labels: ['a', 'b'] },
      reduce: { lever: reduceLever, values: [0, -0.01, -0.02] },
    },
    report: { rows: 'fill', reduce: { axis: 'reduce', pick: 'last-passing' } },
  });
  const results = (n) => Array.from({ length: n }, (_, i) => ({
    id: '', passed: true, netWorth: 1,
  }));

  test('a return-reduced grid is a rate, not money', () => {
    const s = spec('equityShift');
    const rows = [];
    for (let f = 0; f < 2; f++) for (let r = 0; r < 3; r++) {
      rows.push({ id: `fill=${f},reduce=${r}`, passed: r < 2, netWorth: 1 });
    }
    const m = buildGridModel({ spec: s, results: rows });
    assert.equal(m.reduceUnit, 'rate');
  });

  test('a spend-reduced grid is money', () => {
    const s = spec('spendTotal');
    s.axes.reduce.values = [8000, 9000, 10000];
    const rows = [];
    for (let f = 0; f < 2; f++) for (let r = 0; r < 3; r++) {
      rows.push({ id: `fill=${f},reduce=${r}`, passed: r < 2, netWorth: 1 });
    }
    const m = buildGridModel({ spec: s, results: rows });
    assert.equal(m.reduceUnit, 'money');
  });
});
