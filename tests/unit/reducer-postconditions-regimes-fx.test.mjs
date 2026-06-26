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
 * Groups F (economic regimes) + G (FX) reducer postconditions (design 37 §6 F/G).
 *
 * All four are I1-PURE (no service-backed cash movement) — the default runReducer
 * no-mutation check applies:
 *
 *  - RemoveRegimeReducer (I1/I7/I10) — filters one regime out of activeRegimes.
 *  - RegimeApplyReducer (I1/I2/I7)   — recomputes effective* rates from base +
 *    active-regime recovery factors; drops fully-recovered regimes.
 *  - BondPriceAdjustReducer (I1/I3/I4) — marks BOND holdings to market on a rate
 *    delta and re-syncs §4.4.
 *  - FxRefreshReducer (I1/I2/I7)     — mirrors base FX rates/fees → effective.
 *
 * (AddRegime, RevalueAsset, FxTransferApply are pinned in the backfill file.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runReducer, assertStateUnchanged, sumHoldings } from '../helpers/reducer-postconditions.js';
import { makeAccount, makeAction } from '../helpers/reducer-fixtures.js';
import { ALLOCATION } from '../../src/finance/holdings/allocation.js';

import { RemoveRegimeReducer } from '../../src/finance/economic-regimes/remove-regime-reducer.js';
import { RegimeApplyReducer } from '../../src/finance/economic-regimes/regime-apply-reducer.js';
import { BondPriceAdjustReducer } from '../../src/finance/economic-regimes/bond-price-adjust-reducer.js';
import { FxRefreshReducer } from '../../src/finance/fx/fx-refresh-reducer.js';

const DATE = new Date('2030-06-15');

// ─── RemoveRegimeReducer (I1/I7/I10) ───────────────────────────────────────────

test('RemoveRegimeReducer: removes the regime with the matching id (I1)', () => {
  const r = new RemoveRegimeReducer();
  const state = { activeRegimes: [{ id: 'r1' }, { id: 'r2' }] };
  const next = runReducer(r, state, makeAction('REMOVE_REGIME_APPLY', { regimeId: 'r1' }), DATE);
  assert.deepEqual(next.activeRegimes.map(x => x.id), ['r2']);
});

test('RemoveRegimeReducer: missing regimeId is a no-op (I7); removing an absent id is idempotent (I10)', () => {
  const r = new RemoveRegimeReducer();
  const prev = { activeRegimes: [{ id: 'r2' }] };
  const noId = runReducer(r, structuredClone(prev), makeAction('REMOVE_REGIME_APPLY', {}), DATE);
  assertStateUnchanged(prev, noId);

  // I10 — removing 'r1' (already absent) leaves the list unchanged; re-running stays stable.
  const once  = r.reduce(structuredClone(prev), makeAction('REMOVE_REGIME_APPLY', { regimeId: 'r1' }), DATE);
  const twice = r.reduce(once, makeAction('REMOVE_REGIME_APPLY', { regimeId: 'r1' }), DATE);
  assert.deepEqual(twice.activeRegimes.map(x => x.id), ['r2']);
});

// ─── RegimeApplyReducer (I1/I2/I7) ─────────────────────────────────────────────

test('RegimeApplyReducer: composes effective rates from base + scaled adjustment (I1)', () => {
  const r = new RegimeApplyReducer();
  const state = {
    baseInterestRates: { BOND_US: 0.04 },
    // L curve at t=0 → factor 1.0 (full shock), deterministic.
    activeRegimes: [{ id: 'r1', recoveryProfile: 'L', startDate: DATE, durationMonths: 12, interestRateAdjustment: { BOND_US: -0.02 } }],
  };
  const next = runReducer(r, state, makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.equal(next.effectiveInterestRates.BOND_US, 0.02, 'base 0.04 + (−0.02)×factor(1)');
  assert.equal(next.activeRegimes[0].currentFactor, 1, 'recovery factor attached to the live regime');
});

test('RegimeApplyReducer: drops a fully-recovered, past-end regime; deterministic (I2)', () => {
  const r = new RegimeApplyReducer();
  const state = {
    baseInterestRates: { BOND_US: 0.04 },
    activeRegimes: [{ id: 'old', recoveryProfile: 'L', startDate: new Date('2020-01-01'), endDate: new Date('2021-01-01'), durationMonths: 12, interestRateAdjustment: { BOND_US: -0.02 } }],
  };
  const next = runReducer(r, state, makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.equal(next.activeRegimes.length, 0, 'factor 0 + past endDate ⇒ dropped');
  assert.equal(next.effectiveInterestRates.BOND_US, 0.04, 'no live regime ⇒ effective == base');

  const a = r.reduce(structuredClone(state), makeAction('US_PERIOD_ADVANCE'), DATE);
  const b = r.reduce(structuredClone(state), makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.deepEqual(a, b);
});

test('RegimeApplyReducer: no active regimes ⇒ effective mirrors base (I7)', () => {
  const r = new RegimeApplyReducer();
  const next = runReducer(r, { baseInterestRates: { BOND_US: 0.04 }, activeRegimes: [] }, makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.deepEqual(next.effectiveInterestRates, { BOND_US: 0.04 });
  assert.deepEqual(next.activeRegimes, []);
});

// ─── BondPriceAdjustReducer (I1/I3/I4) ─────────────────────────────────────────

test('BondPriceAdjustReducer: marks bonds down on a rate rise, re-syncs §4.4 (I3/I4)', () => {
  const r = new BondPriceAdjustReducer();
  const state = {
    effectiveInterestRates: { BOND_US: 0.05 },
    priorMarkRates:         { BOND_US: 0.03 },
    bondAccount: makeAccount({ stateKey: 'bondAccount', holdings: [{ id: 'b1', allocation: ALLOCATION.BOND, rateKey: 'BOND_US', duration: 5, marketValue: 1000, costBasis: 1000 }] }),
  };
  const next = runReducer(r, state, makeAction('US_PERIOD_ADVANCE'), DATE, { balance: true, nonNegative: true });
  // Δprice = −duration(5) × Δrate(0.02) × 1000 = −100
  assert.equal(next.bondAccount.holdings[0].marketValue, 900);
  assert.equal(next.bondAccount.balance, 900, '§4.4 re-synced (I3)');
  assert.equal(sumHoldings(next.bondAccount), 900);
  assert.equal(next.bondAccount.holdings[0].costBasis, 1000, 'mark-to-market only — basis untouched');
  assert.deepEqual(next.priorMarkRates, { BOND_US: 0.05 }, 'prior marks snapshot the new effective rates');
});

test('BondPriceAdjustReducer: first period (empty priorMarkRates) leaves holdings unchanged (I7)', () => {
  const r = new BondPriceAdjustReducer();
  const state = {
    effectiveInterestRates: { BOND_US: 0.05 },
    bondAccount: makeAccount({ stateKey: 'bondAccount', holdings: [{ id: 'b1', allocation: ALLOCATION.BOND, rateKey: 'BOND_US', duration: 5, marketValue: 1000, costBasis: 1000 }] }),
  };
  const next = runReducer(r, state, makeAction('US_PERIOD_ADVANCE'), DATE, { balance: true, nonNegative: true });
  assert.equal(next.bondAccount.balance, 1000, 'Δrate=0 on first mark ⇒ no price change');
  assert.deepEqual(next.priorMarkRates, { BOND_US: 0.05 }, 'still snapshots for next period');
});

test('BondPriceAdjustReducer: rate drop never drives marketValue below 0 (I4)', () => {
  const r = new BondPriceAdjustReducer();
  const state = {
    // A huge rate rise on a long-duration bond would overshoot negative — clamps at 0.
    effectiveInterestRates: { BOND_US: 0.50 },
    priorMarkRates:         { BOND_US: 0.00 },
    bondAccount: makeAccount({ stateKey: 'bondAccount', holdings: [{ id: 'b1', allocation: ALLOCATION.BOND, rateKey: 'BOND_US', duration: 10, marketValue: 100, costBasis: 100 }] }),
  };
  const next = runReducer(r, state, makeAction('US_PERIOD_ADVANCE'), DATE, { balance: true, nonNegative: true });
  assert.equal(next.bondAccount.holdings[0].marketValue, 0);
  assert.equal(next.bondAccount.balance, 0);
});

// ─── FxRefreshReducer (I1/I2/I7) ───────────────────────────────────────────────

test('FxRefreshReducer: mirrors base FX rates/fees into the effective fields (I1)', () => {
  const r = new FxRefreshReducer();
  const state = { baseExchangeRates: { USD_AUD: 1.55 }, baseFxFees: { USD_AUD: 15 } };
  const next = runReducer(r, state, makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.deepEqual(next.effectiveExchangeRates, { USD_AUD: 1.55 });
  assert.deepEqual(next.effectiveFxFees, { USD_AUD: 15 });
});

test('FxRefreshReducer: no base FX config is a no-op (I7); deterministic (I2)', () => {
  const r = new FxRefreshReducer();
  const prev = { somethingElse: 1 };
  const noop = runReducer(r, structuredClone(prev), makeAction('US_PERIOD_ADVANCE'), DATE);
  assertStateUnchanged(prev, noop);

  const base = { baseExchangeRates: { USD_AUD: 1.55 }, baseFxFees: { USD_AUD: 15 } };
  const a = r.reduce(structuredClone(base), makeAction('US_PERIOD_ADVANCE'), DATE);
  const b = r.reduce(structuredClone(base), makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.deepEqual(a, b);
});
