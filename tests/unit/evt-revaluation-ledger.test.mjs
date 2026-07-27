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
 * Design 84 G8 — a REVALUATION must move the contribution/earnings ledger.
 *
 * A revaluation moves market value with no cash crossing the account boundary. Two
 * paths do it: a shock's level effect (RevalueAssetReducer) and a bond marked to a new
 * rate curve (BondPriceAdjustReducer). Both used to rewrite `balance` from Σ holdings
 * and leave `contributionBasis`/`earningsBasis` exactly where they were, so the design
 * 53 §8 invariant `contributionBasis + earningsBasis == balance` drifted permanently.
 *
 * The visible symptom that found it: an `earningsBasis` LARGER than the balance it
 * belongs to, still standing decades later on an account whose balance had reached
 * zero. On a Roth held by an Australian resident `earningsBasis` is the s99B-assessable
 * slice, so the drift over-assesses every later withdrawal.
 *
 * Direction matches G12: a fall lands on the gain first, a rise is appreciation and is
 * credited to earnings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RevalueAssetReducer } from '../../src/finance/economic-regimes/revalue-asset-reducer.js';
import { BondPriceAdjustReducer } from '../../src/finance/economic-regimes/bond-price-adjust-reducer.js';
import { revalueLedger } from '../../src/finance/assets/investment-account.js';
import { ALLOCATION } from '../../src/finance/holdings/allocation.js';
import { makeAccount } from '../helpers/reducer-fixtures.js';

const RATE_KEY_EQUITY_US = 'EQUITY_US';

/** A ledger-bearing US account with one equity sleeve: 20% corpus, 80% earnings. */
function rothState({ balance = 1_000_000, contributionBasis = 200_000, earningsBasis = 800_000 } = {}) {
  const acct = makeAccount({
    stateKey: 'rothAccount', country: 'US', balance,
    holdings: [{ marketValue: balance, costBasis: contributionBasis, allocation: ALLOCATION.EQUITY }],
  });
  return { rothAccount: { ...acct, contributionBasis, earningsBasis } };
}

const crash = (multiplier = -0.40) => ({
  type: 'REVALUE_ASSET_APPLY',
  rateKey: RATE_KEY_EQUITY_US,
  holdingsStateKeys: ['rothAccount'],
  targetStateKeys: [],
  multiplier,
});

const assertInvariant = (a, label) => assert.ok(
  Math.abs((a.contributionBasis + a.earningsBasis) - a.balance) < 0.02,
  `${label}: design 53 §8 — contributionBasis (${a.contributionBasis}) + earningsBasis `
  + `(${a.earningsBasis}) must equal balance (${a.balance})`,
);

// ─── the shock path (G8 as reported) ─────────────────────────────────────────

test('G8: a −40% shock takes the ledger down with the balance', () => {
  const state = rothState();
  const next  = new RevalueAssetReducer().reduce(state, crash(-0.40)).rothAccount;

  assert.equal(next.balance, 600_000, 'the balance still falls 40%');
  assert.equal(next.earningsBasis, 400_000, 'the 400k loss comes out of earnings');
  assert.equal(next.contributionBasis, 200_000, 'corpus untouched while earnings remain');
  assertInvariant(next, 'post-shock');
});

test('G8: earningsBasis can no longer exceed the balance it belongs to', () => {
  // The reported symptom, in its original shape.
  const state  = rothState();
  const before = state.rothAccount;
  assert.ok(before.earningsBasis <= before.balance, 'precondition');

  const next = new RevalueAssetReducer().reduce(state, crash(-0.60)).rothAccount;
  assert.ok(next.earningsBasis <= next.balance,
    `earningsBasis (${next.earningsBasis}) must not exceed balance (${next.balance})`);
});

test('G8: a crash deeper than the earnings spills into corpus and floors at zero', () => {
  const state = rothState({ contributionBasis: 900_000, earningsBasis: 100_000 });
  const next  = new RevalueAssetReducer().reduce(state, crash(-0.40)).rothAccount;

  assert.equal(next.balance, 600_000);
  assert.equal(next.earningsBasis, 0, 'earnings wiped first');
  assert.equal(next.contributionBasis, 600_000, 'the remaining 300k comes off corpus');
  assertInvariant(next, 'deep crash');
});

test('G8: a POSITIVE level effect credits earnings, not corpus', () => {
  const state = rothState();
  const next  = new RevalueAssetReducer().reduce(state, crash(+0.25)).rothAccount;

  assert.equal(next.balance, 1_250_000);
  assert.equal(next.earningsBasis, 1_050_000, 'the gain is appreciation → earnings');
  assert.equal(next.contributionBasis, 200_000, 'corpus never grows on a revaluation');
  assertInvariant(next, 'boom');
});

test('G8: an account with no ledger is left alone (brokerage keeps per-holding basis)', () => {
  const acct = makeAccount({
    stateKey: 'usStockAccount', country: 'US', balance: 500_000,
    holdings: [{ marketValue: 500_000, costBasis: 300_000, allocation: ALLOCATION.EQUITY }],
  });
  const state = { usStockAccount: acct };
  const next  = new RevalueAssetReducer().reduce(state, { ...crash(-0.40), holdingsStateKeys: ['usStockAccount'] }).usStockAccount;

  assert.equal(next.balance, 300_000, 'the balance still marks down');
  assert.ok(!('earningsBasis' in next) || next.earningsBasis === undefined,
    'no ledger should be invented on an account that does not carry one');
});

test('G8: only the shocked sleeve moves, and the ledger follows the whole account', () => {
  // A Roth with equity AND cash: a −40% EQUITY shock must not mark the cash down,
  // and the ledger must fall by the ACCOUNT's loss, not the sleeve's notional.
  const acct = makeAccount({
    stateKey: 'rothAccount', country: 'US', balance: 1_000_000,
    holdings: [
      { marketValue: 600_000, costBasis: 600_000, allocation: ALLOCATION.EQUITY },
      { marketValue: 400_000, costBasis: 400_000, allocation: ALLOCATION.CASH },
    ],
  });
  const state = { rothAccount: { ...acct, contributionBasis: 200_000, earningsBasis: 800_000 } };
  const next  = new RevalueAssetReducer().reduce(state, crash(-0.40)).rothAccount;

  assert.equal(next.balance, 760_000, 'equity 600k→360k, cash untouched');
  assert.equal(next.earningsBasis, 560_000, 'the 240k account-level loss comes off earnings');
  assertInvariant(next, 'mixed sleeves');
});

// ─── the bond-mark path (the same defect, found while fixing G8) ─────────────

test('G8: a bond rate mark inside a Roth moves the ledger too', () => {
  const acct = makeAccount({
    stateKey: 'rothAccount', country: 'US', balance: 1_000_000,
    holdings: [{
      marketValue: 1_000_000, costBasis: 1_000_000, allocation: ALLOCATION.BOND,
      rateKey: 'FIXED_INCOME_US', duration: 6,
    }],
  });
  const state = {
    rothAccount: { ...acct, contributionBasis: 200_000, earningsBasis: 800_000 },
    // Rates rise 1pt since the prior mark ⇒ price falls by duration × Δrate.
    effectiveInterestRates: { FIXED_INCOME_US: 0.05 },
    priorMarkRates:         { FIXED_INCOME_US: 0.04 },
    yieldCurve: {}, priorMarkCurve: {},
    currentPeriods: { US: { startMs: Date.UTC(2040, 0, 1) } },
  };

  const next = new BondPriceAdjustReducer().reduce(state, { type: 'US_PERIOD_ADVANCE' }).rothAccount;

  assert.ok(next.balance < 1_000_000, `a rate rise must mark the bond down; got ${next.balance}`);
  assert.ok(next.earningsBasis < 800_000, 'the markdown must reach the ledger');
  assertInvariant(next, 'bond mark');
});

// ─── the helper's contract ───────────────────────────────────────────────────

test('G8: revalueLedger returns null for a no-op and for a ledger-less account', () => {
  assert.equal(revalueLedger({ contributionBasis: 1, earningsBasis: 1 }, 100, 100), null,
    'an unchanged balance is not a revaluation');
  assert.equal(revalueLedger({ balance: 100 }, 100, 50), null,
    'an account with no ledger fields yields nothing to spread');
  assert.equal(revalueLedger(null, 100, 50), null);
});
