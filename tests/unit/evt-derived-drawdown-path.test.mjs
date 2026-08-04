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
 * Design 84 G2, on the ORDINARY DRAWDOWN PATH — the one that actually drains a
 * wrapper in retirement.
 *
 * G2 was first wired into `roth-classes.js`, the event-driven withdrawal reducer.
 * Retirement spending does not use it: it goes through
 * `AccountService.reduceLedgerForWithdrawal`, which mutates the ledger directly and
 * emits its own tax actions. So on every real plan the derived pool was never drawn
 * and the s99B charge never saw it — the `auAssessableAmount` stamp was simply absent
 * and the tax module fell back to assessing the whole withdrawal.
 *
 * It showed up as a broken invariant: a Roth drained to `balance 0` / `earningsBasis
 * 0` while `derivedIncomeBasis` still held a five-figure sum, stranded for the
 * remaining thirty years of the horizon — the same shape as the G8 defect it was
 * supposed to help fix.
 *
 * This is the THIRD design 84 gap of the form "the ordinary drawdown path did not see
 * it" (G7 emitted no action at all; G9 could not see the rollover buckets). Anything
 * taught to the reducers in `roth-classes.js` must be taught to this path too, or it
 * is inert wherever it matters.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AccountService } from '../../src/finance/services/account-service.js';
import { Graph } from '../../src/graph/graph.js';
import { EventBus } from '../../src/simulation-framework/event-bus.js';
import { ACCOUNT_TYPE } from '../../src/finance/assets/account.js';

const svc = () => new AccountService(new Graph(), new EventBus());

const roth = (over = {}) => ({
  type: ACCOUNT_TYPE.ROTH,
  balance: 1_000_000,
  contributionBasis: 200_000,
  earningsBasis: 800_000,
  derivedIncomeBasis: 200_000,     // a quarter of the earnings are derived
  ...over,
});

test('G2 drawdown: the derived pool is drawn pro-rata with the earnings', () => {
  const a = roth();
  // Draw 600k: 200k of contributions first (§408A ordering), then 400k of earnings —
  // half the earnings, so half the pool.
  const r = svc().reduceLedgerForWithdrawal(a, 600_000);

  assert.equal(r.fromContrib, 200_000);
  assert.equal(r.fromEarnings, 400_000);
  assert.equal(a.earningsBasis, 400_000);
  assert.equal(a.derivedIncomeBasis, 100_000, 'half the earnings left ⇒ half the pool did');
  assert.equal(r.derivedDrawn, 100_000, 'and that half is the s99B-assessable slice of this draw');
});

test('G2 drawdown: draining the earnings zeroes the pool — nothing is stranded', () => {
  // The regression in its original shape: balance and earningsBasis reach zero while
  // derivedIncomeBasis keeps a five-figure sum for the rest of the horizon.
  const a = roth();
  svc().reduceLedgerForWithdrawal(a, 1_000_000);

  assert.equal(a.earningsBasis, 0);
  assert.equal(a.derivedIncomeBasis, 0,
    'a fully drained wrapper cannot still hold assessable derived income');
});

test('G2 drawdown: drawing only contributions leaves the pool untouched', () => {
  const a = roth();
  const r = svc().reduceLedgerForWithdrawal(a, 150_000);

  assert.equal(r.fromEarnings, 0);
  assert.equal(a.derivedIncomeBasis, 200_000, 'corpus out first — no derived income distributed');
  assert.equal(r.derivedDrawn, 0);
});

test('G2 drawdown: an account with no pool reports UNDEFINED, not zero', () => {
  // The distinction is load-bearing. `undefined` omits `auAssessableAmount` from the
  // tax action, so the module falls back to assessing the whole withdrawal — the
  // pre-G2 behaviour. Returning 0 would silently zero the s99B charge on every saved
  // state written before the pool existed.
  const a = roth({ derivedIncomeBasis: undefined });
  const r = svc().reduceLedgerForWithdrawal(a, 600_000);

  assert.equal(r.derivedDrawn, undefined);
  assert.equal(a.derivedIncomeBasis, undefined, 'no pool must be invented');
});

test('G2 drawdown: the emitted s99B action carries the derived slice', () => {
  const a = roth();
  const s = svc();
  const split = s.reduceLedgerForWithdrawal(a, 600_000);
  const { taxActions } = s.earlyWithdrawalTaxActions(a, {
    ...split, penaltyRate: 0, residency: 'AU', stateKey: 'rothAccount',
  });
  const tax = taxActions.find(t => t.type === 'ROTH_WITHDRAWAL_EARNINGS_TAX');

  assert.ok(tax, 'an earnings draw must emit the s99B action');
  assert.equal(tax.amount, 400_000, 'the full earnings amount still drives §72(t)');
  assert.equal(tax.auAssessableAmount, 100_000,
    'but only the derived quarter is assessable under s99B');
});

test('G2 drawdown: a pool larger than the drawn share cannot over-assess', () => {
  // Pool == earnings (everything derived, e.g. the conservative opening seed).
  const a = roth({ derivedIncomeBasis: 800_000 });
  const r = svc().reduceLedgerForWithdrawal(a, 600_000);

  assert.equal(r.derivedDrawn, 400_000, 'all-derived wrapper ⇒ the whole earnings draw is assessable');
  assert.equal(a.derivedIncomeBasis, 400_000);
  assert.ok(r.derivedDrawn <= r.fromEarnings, 'the assessable slice can never exceed the draw');
});
