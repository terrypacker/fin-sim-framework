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
 * holding-activity.test.mjs — covers the pure derivation helpers backing the
 * Holdings workbench plugin: snapshotHoldings / totalSnapshot and the
 * stateDiff-driven buildHoldingActivity ledger.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import {
  snapshotHoldings,
  totalSnapshot,
  buildHoldingActivity,
  HOLDING_ACTIVITY_KIND,
} from '../../src/finance/holdings/holding-activity.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const STATE_KEY = 'usStockAccount';

/** Build a minimal journal entry that carries a `<stateKey>.holdings` diff. */
function entry({ seq, date, type, before, after }) {
  return {
    seq,
    date: new Date(date),
    action:  { type },
    reducer: { name: `${type} reducer` },
    stateDiff: [{ field: `${STATE_KEY}.holdings`, before, after, delta: null }],
  };
}

const H = (id, marketValue, costBasis, extra = {}) => ({ id, marketValue, costBasis, ...extra });

// ── snapshot ─────────────────────────────────────────────────────────────────

test('snapshotHoldings derives unrealized gain and labels', () => {
  const rows = snapshotHoldings({
    holdings: [
      H('h-us', 78_400, 108_000, { label: 'US Equity', allocation: 'EQUITY' }),
      H('h-intl', 62_100, 42_000, { label: 'Intl Equity', allocation: 'EQUITY' }),
      H('hld17', 4_200, 9_000), // no label → falls back to id
    ],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].unrealized, -29_600);
  assert.equal(rows[1].unrealized, 20_100);
  assert.equal(rows[2].label, 'hld17');

  const t = totalSnapshot(rows);
  assert.equal(t.marketValue, 144_700);
  assert.equal(t.unrealized, -14_300);
});

test('snapshotHoldings tolerates missing holdings array', () => {
  assert.deepEqual(snapshotHoldings(null), []);
  assert.deepEqual(snapshotHoldings({}), []);
});

// ── activity ledger ────────────────────────────────────────────────────────

test('buildHoldingActivity classifies sells, buys and skips basis-only moves', () => {
  const entries = [
    // Contribution: +5,000 to a holding → BUY
    entry({ seq: 1, date: '2026-03-01', type: 'STOCK_CONTRIBUTION_APPLY',
      before: [H('h-us', 50_000, 50_000)],
      after:  [H('h-us', 55_000, 55_000)] }),
    // FIFO sale: -12,000 → SELL
    entry({ seq: 2, date: '2026-06-01', type: 'STOCK_WITHDRAWAL_APPLY',
      before: [H('h-us', 55_000, 55_000)],
      after:  [H('h-us', 43_000, 43_000)] }),
    // Basis-only correction (no market move) → skipped
    entry({ seq: 3, date: '2026-07-01', type: 'HOLDING_SET_BASIS',
      before: [H('h-us', 43_000, 43_000)],
      after:  [H('h-us', 43_000, 40_000)] }),
  ];

  const rows = buildHoldingActivity(entries, STATE_KEY);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, HOLDING_ACTIVITY_KIND.BUY);
  assert.equal(rows[0].mvDelta, 5_000);
  assert.equal(rows[1].kind, HOLDING_ACTIVITY_KIND.SELL);
  assert.equal(rows[1].mvDelta, -12_000);
});

test('buildHoldingActivity treats a HOLDING_TRANSACT with no basis change as GROWTH, not a BUY', () => {
  // Appreciation arrives as a HOLDING_TRANSACT: marketValue up, cost basis flat.
  const entries = [
    entry({ seq: 1, date: '2027-12-30', type: 'HOLDING_TRANSACT',
      before: [H('h-us', 900_000, 900_000)],
      after:  [H('h-us', 990_000, 900_000)] }),
  ];
  assert.equal(buildHoldingActivity(entries, STATE_KEY).length, 0);          // hidden by default
  const shown = buildHoldingActivity(entries, STATE_KEY, { includeGrowth: true });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].kind, HOLDING_ACTIVITY_KIND.GROWTH);
  assert.equal(shown[0].mvDelta, 90_000);
});

test('buildHoldingActivity hides growth rows unless includeGrowth is set', () => {
  const entries = [
    entry({ seq: 1, date: '2026-12-31', type: 'STOCK_EARNINGS_APPLY',
      before: [H('h-us', 50_000, 50_000)],
      after:  [H('h-us', 52_500, 50_000)] }),
  ];

  assert.equal(buildHoldingActivity(entries, STATE_KEY).length, 0);

  const withGrowth = buildHoldingActivity(entries, STATE_KEY, { includeGrowth: true });
  assert.equal(withGrowth.length, 1);
  assert.equal(withGrowth[0].kind, HOLDING_ACTIVITY_KIND.GROWTH);
  assert.equal(withGrowth[0].mvDelta, 2_500);
});

test('buildHoldingActivity respects the as-of cutoff and detects added/removed holdings', () => {
  const entries = [
    // A new holding appears (rebuy / substitute) → BUY for the full position
    entry({ seq: 1, date: '2026-01-01', type: 'HOLDING_TRANSACT',
      before: [H('h-us', 10_000, 10_000)],
      after:  [H('h-us', 10_000, 10_000), H('h-sub', 8_000, 8_000)] }),
    // Future sale beyond the cutoff → excluded
    entry({ seq: 2, date: '2027-01-01', type: 'STOCK_WITHDRAWAL_APPLY',
      before: [H('h-us', 10_000, 10_000)],
      after:  [H('h-us', 0, 0)] }),
  ];

  const asOfMs = new Date('2026-06-01').getTime();
  const rows   = buildHoldingActivity(entries, STATE_KEY, { asOfMs });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].holdingId, 'h-sub');
  assert.equal(rows[0].kind, HOLDING_ACTIVITY_KIND.BUY);
  assert.equal(rows[0].mvDelta, 8_000);
});

test('buildHoldingActivity ignores entries without a holdings diff', () => {
  const entries = [{
    seq: 1, date: new Date('2026-01-01'),
    action: { type: 'EXPENSE_DEBIT' },
    stateDiff: [{ field: 'usSavingsAccount.balance', before: 100, after: 90, delta: -10 }],
  }];
  assert.deepEqual(buildHoldingActivity(entries, STATE_KEY), []);
});
