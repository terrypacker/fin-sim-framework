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
 * EVT-YEARS-OF-SPEND (design 97 §9) — the pool target as N YEARS OF SPENDING.
 *
 * A percentage target and a years target diverge in exactly the wrong direction: a fixed
 * BOND percentage over-provisions as the book grows and under-provisions after a crash.
 * YOS-4 is the test that pins that difference, because it is the only reason the mode exists.
 *
 * YOS-1: the mix is the pools' dollar figures over the book, equity residual
 * YOS-2: fill order CASH → BOND → GOLD → EQUITY when the book cannot cover the pools
 * YOS-3: no spend line / empty book ⇒ falls back to the authored target (never a zero mix)
 * YOS-4: the target TRACKS the spend line and IGNORES the book — the percentage's failure
 * YOS-5: an explicit AUD-denominated spend figure is converted before the years arithmetic
 * YOS-6: unselected / other schedule modes are untouched
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { RebalanceToTargetReducer, ALLOCATION_SCHEDULE }
  from '../../src/finance/behavioral/rebalance-to-target-reducer.js';

const AUTHORED = { EQUITY: 0.60, BOND: 0.39, CASH: 0.00, GOLD: 0.01 };

const make = (opts = {}) => new RebalanceToTargetReducer({
  accounts: [], scheduleMode: ALLOCATION_SCHEDULE.YEARS_OF_SPEND,
  targetAllocation: AUTHORED, poolYears: { CASH: 2, BOND: 4 }, ...opts,
});

/** $10k/month ⇒ $120k/year. */
const spending = (monthly = 10_000, extra = {}) => ({ monthlyExpenses: monthly, ...extra });

test('YOS-1: pools are dollar figures over the book; equity takes the residual', () => {
  const mix = make()._resolveYearsTarget(spending(), 3_000_000);
  // 2 × 120k = 240k = 8 % ; 4 × 120k = 480k = 16 % ; gold keeps its authored 1 %.
  assert.ok(Math.abs(mix.CASH   - 0.08) < 1e-9, `cash ${mix.CASH}`);
  assert.ok(Math.abs(mix.BOND   - 0.16) < 1e-9, `bond ${mix.BOND}`);
  assert.ok(Math.abs(mix.GOLD   - 0.01) < 1e-9, `gold ${mix.GOLD}`);
  assert.ok(Math.abs(mix.EQUITY - 0.75) < 1e-9, `equity ${mix.EQUITY}`);
  assert.ok(Math.abs(mix.CASH + mix.BOND + mix.GOLD + mix.EQUITY - 1) < 1e-9, 'sums to 1');
});

test('YOS-2: when the book cannot cover the pools, the LOWER pool wins', () => {
  // $500k book, $720k of pools authored. Cash (240k) is filled first, bonds take the rest.
  const tight = make()._resolveYearsTarget(spending(), 500_000);
  assert.ok(Math.abs(tight.CASH - 0.48) < 1e-9, `cash ${tight.CASH}`);
  assert.ok(Math.abs(tight.BOND - 0.52) < 1e-9, `bond ${tight.BOND}`);
  assert.equal(tight.EQUITY, 0);
  assert.equal(tight.GOLD, 0);

  // Smaller than the cash pool alone ⇒ all cash. A book too small for the buckets should be
  // ALL cash, not a proportionally shrunken copy of a mix it cannot afford.
  const tiny = make()._resolveYearsTarget(spending(), 200_000);
  assert.equal(tiny.CASH, 1);
  assert.equal(tiny.BOND, 0);
  assert.equal(tiny.EQUITY, 0);
});

test('YOS-3: no spend line or empty book falls back to the authored target', () => {
  const r = make();
  assert.equal(r._resolveYearsTarget({}, 3_000_000), null);
  assert.equal(r._resolveYearsTarget(spending(0), 3_000_000), null);
  assert.equal(r._resolveYearsTarget(spending(), 0), null);
  // …and the resolver hands back the authored mix rather than a zero one.
  assert.deepEqual(r.resolveScheduledTarget({}, null, 3_000_000), AUTHORED);
});

test('YOS-4: the target tracks the SPEND LINE and ignores the book — the percentage\'s failure', () => {
  const r = make();
  // Book triples, spending flat: a percentage target would hold its share and let cover
  // balloon (measured: 3.5 → 13.6 years on the reference plan). The years target CUTS the
  // share so the DOLLARS — and therefore the years of cover — stay put.
  const small = r._resolveYearsTarget(spending(), 2_000_000);
  const big   = r._resolveYearsTarget(spending(), 6_000_000);
  assert.ok(big.BOND < small.BOND, 'share falls as the book grows');
  assert.ok(Math.abs(big.BOND * 6_000_000 - small.BOND * 2_000_000) < 1e-6,
    'the DOLLAR pool is identical — that is the whole point');
  assert.ok(Math.abs(big.BOND * 6_000_000 - 4 * 120_000) < 1e-6, 'and it is exactly 4 years');

  // Spending rises 50 %, book flat ⇒ the pool grows with it. A percentage target would not
  // move at all, which is the under-provisioning half of the same defect.
  const inflated = r._resolveYearsTarget(spending(15_000), 2_000_000);
  assert.ok(Math.abs(inflated.BOND * 2_000_000 - 4 * 180_000) < 1e-6,
    'the pool follows the inflated spend line');
});

test('YOS-5: an explicitly AUD-denominated spend figure is converted first', () => {
  // A$120k/yr at USD_AUD 1.55 is US$77,419 — the pools are sized off the converted figure,
  // not the raw number, or "4 years" would mean four years of a different currency.
  const state = { monthlyExpenses: 10_000, effectiveExchangeRates: { USD_AUD: 1.55 } };
  const aud = make({ expensesCurrency: 'AUD' })._resolveYearsTarget(state, 3_000_000);
  const usd = make({ expensesCurrency: 'USD' })._resolveYearsTarget(state, 3_000_000);
  assert.ok(Math.abs(aud.BOND * 1.55 - usd.BOND) < 1e-9, `aud ${aud.BOND} usd ${usd.BOND}`);
  // RESIDENCE (the default) reads the native figure as already base-denominated, matching
  // MonthlyExpensesHandler, which re-bases it into the residence currency at spend time.
  const res = make()._resolveYearsTarget(state, 3_000_000);
  assert.ok(Math.abs(res.BOND - usd.BOND) < 1e-9, 'RESIDENCE == base currency');
});

test('YOS-6: the other schedule modes are untouched', () => {
  const stat = new RebalanceToTargetReducer({
    accounts: [], targetAllocation: AUTHORED, poolYears: { CASH: 2, BOND: 4 },
  });
  assert.deepEqual(stat.resolveScheduledTarget(spending(), null, 3_000_000), AUTHORED);
});
