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
 * Group E — behavioral reducer postconditions (design 37 §6 E).
 *
 * Two behavioral classes, all I1-PURE (immutable holdings math / action emission —
 * none are service-backed, so the default runReducer no-mutation check applies):
 *
 *  - TRIGGER reducers (PanicSell, OpportunisticRebalance, StrategicAssetLocation,
 *    DownturnRothConversion, CashBucketDrawdown, ContributionSuspensionToggle)
 *    read regimes/holdings and EMIT actions or toggle a flag. Asserted I1 + I2
 *    (determinism) + I7 (no-op) + I10 (idempotent per-shock latch) as tagged.
 *  - *Apply reducers (BehavioralPanicSellApply, OpportunisticRebalanceApply,
 *    AssetLocationRebalanceApply, StockHarvestApply) MOVE holdings within/between
 *    accounts. Asserted I3 (§4.4 re-sync) + I4 + I6 (pro-rata basis) + I5 for the
 *    cross-account swap, plus I7 missing-target safety.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runReducer, assertConserved, assertStateUnchanged, sumHoldings,
} from '../helpers/reducer-postconditions.js';
import { makeAccount, makeAction } from '../helpers/reducer-fixtures.js';

import { REGIME_TAG } from '../../src/finance/economic-regimes/regime-tag.js';
import { ALLOCATION } from '../../src/finance/holdings/allocation.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';

import { PanicSellReducer } from '../../src/finance/behavioral/panic-sell-reducer.js';
import { BehavioralPanicSellApplyReducer } from '../../src/finance/behavioral/behavioral-panic-sell-apply-reducer.js';
import { OpportunisticRebalanceReducer } from '../../src/finance/behavioral/opportunistic-rebalance-reducer.js';
import { OpportunisticRebalanceApplyReducer } from '../../src/finance/behavioral/opportunistic-rebalance-apply-reducer.js';
import { StrategicAssetLocationReducer } from '../../src/finance/behavioral/strategic-asset-location-reducer.js';
import { AssetLocationRebalanceApplyReducer } from '../../src/finance/behavioral/asset-location-rebalance-apply-reducer.js';
import { DownturnRothConversionReducer } from '../../src/finance/behavioral/downturn-roth-conversion-reducer.js';
import { CashBucketDrawdownReducer } from '../../src/finance/behavioral/cash-bucket-drawdown-reducer.js';
import { ContributionSuspensionToggleReducer } from '../../src/finance/behavioral/contribution-suspension-toggle-reducer.js';
import { StockHarvestApplyReducer } from '../../src/finance/behavioral/stock-harvest-apply-reducer.js';

const DATE = new Date('2030-06-15');

const regime = (shockId, tag, extra = {}) => ({ shockId, tags: [tag], ...extra });

// ─── BehavioralPanicSellApplyReducer (apply; I3/I4/I6/I7) ──────────────────────

test('BehavioralPanicSellApplyReducer: rotates equity→cash, conserves balance (I3/I6)', () => {
  const r = new BehavioralPanicSellApplyReducer();
  const state = {
    iraAccount: makeAccount({ stateKey: 'iraAccount', holdings: [{ id: 'h1', allocation: ALLOCATION.EQUITY, marketValue: 1000, costBasis: 800 }] }),
  };
  const next = runReducer(r, state, makeAction('BEHAVIORAL_PANIC_SELL_APPLY', { stateKey: 'iraAccount', sourceHoldingId: 'h1', sellAmount: 300 }),
    DATE, { balance: true, nonNegative: true });
  const acct = next.iraAccount;
  assert.equal(acct.balance, 1000, 'within-account rotation conserves balance (I3)');
  const equity = acct.holdings.find(h => h.id === 'h1');
  const cash   = acct.holdings.find(h => h.allocation === ALLOCATION.CASH);
  assert.equal(equity.marketValue, 700);
  assert.equal(equity.costBasis, 560, 'basis reduced pro-rata to units sold (I6)');
  assert.equal(cash.marketValue, 300);
});

test('BehavioralPanicSellApplyReducer: missing account / holding is a no-op (I7)', () => {
  const r = new BehavioralPanicSellApplyReducer();
  const prev = { iraAccount: makeAccount({ stateKey: 'iraAccount', holdings: [{ id: 'h1', allocation: ALLOCATION.EQUITY, marketValue: 1000, costBasis: 800 }] }) };
  const missAcct = runReducer(r, structuredClone(prev), makeAction('BEHAVIORAL_PANIC_SELL_APPLY', { stateKey: 'nope', sourceHoldingId: 'h1', sellAmount: 300 }), DATE);
  assertStateUnchanged(prev, missAcct);
  const missHolding = runReducer(r, structuredClone(prev), makeAction('BEHAVIORAL_PANIC_SELL_APPLY', { stateKey: 'iraAccount', sourceHoldingId: 'zz', sellAmount: 300 }), DATE);
  assertStateUnchanged(prev, missHolding);
});

// ─── OpportunisticRebalanceApplyReducer (apply; I3/I4/I6/I7) ───────────────────

test('OpportunisticRebalanceApplyReducer: within-account rebalance conserves value (I3)', () => {
  const r = new OpportunisticRebalanceApplyReducer();
  const state = {
    iraAccount: makeAccount({ stateKey: 'iraAccount', holdings: [
      { id: 'e1', allocation: ALLOCATION.EQUITY, marketValue: 700, costBasis: 700 },
      { id: 'b1', allocation: ALLOCATION.BOND,   marketValue: 300, costBasis: 300 },
    ] }),
  };
  const next = runReducer(r, state, makeAction('OPPORTUNISTIC_REBALANCE_APPLY', {
    stateKey: 'iraAccount', legs: [{ allocation: ALLOCATION.EQUITY, delta: -100 }, { allocation: ALLOCATION.BOND, delta: 100 }],
  }), DATE, { balance: true, nonNegative: true });
  const acct = next.iraAccount;
  assert.equal(acct.balance, 1000, 'rebalance conserves total (I3)');
  assert.equal(acct.holdings.find(h => h.id === 'e1').marketValue, 600);
  assert.equal(acct.holdings.find(h => h.id === 'b1').marketValue, 400);
});

test('OpportunisticRebalanceApplyReducer: missing account is a no-op (I7)', () => {
  const r = new OpportunisticRebalanceApplyReducer();
  const prev = { iraAccount: makeAccount({ stateKey: 'iraAccount', holdings: [{ id: 'e1', allocation: ALLOCATION.EQUITY, marketValue: 700, costBasis: 700 }] }) };
  const next = runReducer(r, structuredClone(prev), makeAction('OPPORTUNISTIC_REBALANCE_APPLY', { stateKey: 'nope', legs: [{ allocation: ALLOCATION.EQUITY, delta: -100 }] }), DATE);
  assertStateUnchanged(prev, next);
});

// ─── AssetLocationRebalanceApplyReducer (apply; cross-account I3/I5/I6/I7) ──────

test('AssetLocationRebalanceApplyReducer: cross-account swap conserves value (I3/I5)', () => {
  const r = new AssetLocationRebalanceApplyReducer();
  const state = {
    iraAccount:  makeAccount({ stateKey: 'iraAccount',  holdings: [{ id: 'b1', allocation: ALLOCATION.BOND,   marketValue: 1000, costBasis: 1000 }] }),
    rothAccount: makeAccount({ stateKey: 'rothAccount', holdings: [{ id: 'e1', allocation: ALLOCATION.EQUITY, marketValue: 1000, costBasis: 1000 }] }),
  };
  const prev = structuredClone(state);
  const next = runReducer(r, state, makeAction('ASSET_LOCATION_REBALANCE_APPLY', {
    fromStateKey: 'iraAccount', fromHoldingId: 'b1', toStateKey: 'rothAccount', toHoldingId: 'e1', swapAmount: 500,
  }), DATE, { balance: true, nonNegative: true });
  assert.equal(next.iraAccount.balance, 500);
  assert.equal(next.rothAccount.balance, 1500);
  assert.equal(sumHoldings(next.iraAccount), 500);   // I3
  assert.equal(sumHoldings(next.rothAccount), 1500); // I3
  assertConserved(prev, next, 'iraAccount', 'rothAccount'); // I5 (no cash pool, no tax)
});

test('AssetLocationRebalanceApplyReducer: missing holding is a no-op (I7)', () => {
  const r = new AssetLocationRebalanceApplyReducer();
  const prev = {
    iraAccount:  makeAccount({ stateKey: 'iraAccount',  holdings: [{ id: 'b1', allocation: ALLOCATION.BOND,   marketValue: 1000, costBasis: 1000 }] }),
    rothAccount: makeAccount({ stateKey: 'rothAccount', holdings: [{ id: 'e1', allocation: ALLOCATION.EQUITY, marketValue: 1000, costBasis: 1000 }] }),
  };
  const next = runReducer(r, structuredClone(prev), makeAction('ASSET_LOCATION_REBALANCE_APPLY', {
    fromStateKey: 'iraAccount', fromHoldingId: 'zz', toStateKey: 'rothAccount', toHoldingId: 'e1', swapAmount: 500,
  }), DATE);
  assertStateUnchanged(prev, next);
});

// ─── StockHarvestApplyReducer (apply; sell+rebuy I3/I4/I7) ─────────────────────

test('StockHarvestApplyReducer: loss harvest realizes signed loss, rebuys, balance unchanged (I3)', () => {
  const r = new StockHarvestApplyReducer();
  const state = {
    usStockAccount: makeAccount({ stateKey: 'usStockAccount', holdings: [
      { id: 'h1', allocation: ALLOCATION.EQUITY, marketValue: 800, costBasis: 1000 }, // unrealized loss
      { id: 'h2', allocation: ALLOCATION.EQUITY, marketValue: 200, costBasis: 200 },
    ] }),
  };
  const next = runReducer(r, state, makeAction('STOCK_HARVEST_APPLY', {
    stateKey: 'usStockAccount', sellAmount: 800, sourceHoldingId: 'h1', substituteHoldingId: 'h2', purpose: 'LOSS', residency: 'US',
  }), DATE, { balance: true, nonNegative: true });
  assert.equal(next.usStockAccount.balance, 1000, 'sell+rebuy cancel: balance unchanged (I3)');
  const tax = next.next.find(a => a.type === 'STOCK_WITHDRAWAL_TAX');
  assert.equal(tax.gain, -200, 'signed loss reaches the tax accumulator (no Math.max floor)');
  // Source fully consumed; substitute absorbed the proceeds with fresh basis.
  assert.equal(next.usStockAccount.holdings.find(h => h.id === 'h1'), undefined);
  assert.equal(next.usStockAccount.holdings.find(h => h.id === 'h2').marketValue, 1000);
});

test('StockHarvestApplyReducer: gain harvest on same holding resets basis to market', () => {
  const r = new StockHarvestApplyReducer();
  const state = {
    usStockAccount: makeAccount({ stateKey: 'usStockAccount', holdings: [
      { id: 'h1', allocation: ALLOCATION.EQUITY, marketValue: 1000, costBasis: 600 }, // unrealized gain
    ] }),
  };
  const next = runReducer(r, state, makeAction('STOCK_HARVEST_APPLY', {
    stateKey: 'usStockAccount', sellAmount: 1000, sourceHoldingId: 'h1', substituteHoldingId: 'h1', purpose: 'GAIN', residency: 'US',
  }), DATE, { balance: true, nonNegative: true });
  assert.equal(next.usStockAccount.balance, 1000);
  const rebought = next.usStockAccount.holdings.find(h => h.id === 'h1');
  assert.equal(rebought.marketValue, 1000);
  assert.equal(rebought.costBasis, 1000, 'rebuy resets basis to market (gain reset to 0)');
  assert.equal(next.next.find(a => a.type === 'STOCK_WITHDRAWAL_TAX').gain, 400, 'realized gain = 1000 − 600');
});

test('StockHarvestApplyReducer: missing account / source holding is a no-op (I7)', () => {
  const r = new StockHarvestApplyReducer();
  const prev = { usStockAccount: makeAccount({ stateKey: 'usStockAccount', holdings: [{ id: 'h1', allocation: ALLOCATION.EQUITY, marketValue: 800, costBasis: 1000 }] }) };
  const missAcct = runReducer(r, structuredClone(prev), makeAction('STOCK_HARVEST_APPLY', { stateKey: 'nope', sellAmount: 800, sourceHoldingId: 'h1', substituteHoldingId: 'h1' }), DATE);
  assertStateUnchanged(prev, missAcct);
  const missSrc = runReducer(r, structuredClone(prev), makeAction('STOCK_HARVEST_APPLY', { stateKey: 'usStockAccount', sellAmount: 800, sourceHoldingId: 'zz', substituteHoldingId: 'h1' }), DATE);
  assertStateUnchanged(prev, missSrc);
});

// ─── PanicSellReducer (trigger; I1/I2/I7/I10) ──────────────────────────────────

function panicState() {
  return {
    activeRegimes: [regime('s1', REGIME_TAG.PANIC_SELL_TRIGGER, { currentFactor: 0.5 })],
    iraAccount: makeAccount({ stateKey: 'iraAccount', holdings: [{ id: 'h1', allocation: ALLOCATION.EQUITY, marketValue: 1000, costBasis: 800 }] }),
  };
}

test('PanicSellReducer: emits a sized panic-sell on regime entry; latches the shock (I1)', () => {
  const r = new PanicSellReducer({ allAccounts: [{ stateKey: 'iraAccount' }], panicFraction: 0.30 });
  const next = runReducer(r, panicState(), makeAction('US_PERIOD_ADVANCE'), DATE);
  const sell = next.next.find(a => a.type === 'BEHAVIORAL_PANIC_SELL_APPLY');
  assert.ok(sell);
  assert.equal(sell.sellAmount, 150, 'panicFraction(0.30) × severity(0.5) × 1000');
  assert.deepEqual(next.regimeActions.panic_sell.firedForShocks, ['s1']);
});

test('PanicSellReducer: idempotent per shock (I10) and deterministic (I2); no-op without trigger (I7)', () => {
  const r = new PanicSellReducer({ allAccounts: [{ stateKey: 'iraAccount' }], panicFraction: 0.30 });
  // I10 — re-firing for an already-latched shock emits nothing.
  const already = { ...panicState(), regimeActions: { panic_sell: { firedForShocks: ['s1'] } } };
  const next = runReducer(r, already, makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.equal(next.next.filter(a => a.type === 'BEHAVIORAL_PANIC_SELL_APPLY').length, 0);

  // I2 — same input → deep-equal output.
  const a = r.reduce(panicState(), makeAction('US_PERIOD_ADVANCE'), DATE);
  const b = r.reduce(panicState(), makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.deepEqual(a, b);

  // I7 — no qualifying regime.
  const calm = runReducer(r, { activeRegimes: [], iraAccount: panicState().iraAccount }, makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.equal(calm.next.length, 0);
});

// ─── OpportunisticRebalanceReducer (trigger; I1/I2/I7) ─────────────────────────

test('OpportunisticRebalanceReducer: emits rebalance legs when allocation drifts past the band (I1)', () => {
  const r = new OpportunisticRebalanceReducer({ taxAdvantaged: [{ stateKey: 'iraAccount' }], targetAllocation: { EQUITY: 0.6, BOND: 0.4 }, rebalanceDriftBand: 0.05 });
  const state = {
    activeRegimes: [],
    iraAccount: makeAccount({ stateKey: 'iraAccount', holdings: [
      { id: 'e1', allocation: ALLOCATION.EQUITY, marketValue: 800, costBasis: 800 },
      { id: 'b1', allocation: ALLOCATION.BOND,   marketValue: 200, costBasis: 200 },
    ] }),
  };
  const next = runReducer(r, state, makeAction('US_PERIOD_ADVANCE'), DATE);
  const apply = next.next.find(a => a.type === 'OPPORTUNISTIC_REBALANCE_APPLY');
  assert.ok(apply);
  const eq = apply.legs.find(l => l.allocation === ALLOCATION.EQUITY);
  const bd = apply.legs.find(l => l.allocation === ALLOCATION.BOND);
  assert.equal(eq.delta, -200); // 600 target − 800 actual
  assert.equal(bd.delta, 200);  // 400 target − 200 actual
});

test('OpportunisticRebalanceReducer: balanced account within band is a no-op (I7); deterministic (I2)', () => {
  const r = new OpportunisticRebalanceReducer({ taxAdvantaged: [{ stateKey: 'iraAccount' }], targetAllocation: { EQUITY: 0.6, BOND: 0.4 }, rebalanceDriftBand: 0.05 });
  const balanced = {
    activeRegimes: [],
    iraAccount: makeAccount({ stateKey: 'iraAccount', holdings: [
      { id: 'e1', allocation: ALLOCATION.EQUITY, marketValue: 600, costBasis: 600 },
      { id: 'b1', allocation: ALLOCATION.BOND,   marketValue: 400, costBasis: 400 },
    ] }),
  };
  const next = runReducer(r, balanced, makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.equal(next.next.length, 0);
  const a = r.reduce(structuredClone(balanced), makeAction('US_PERIOD_ADVANCE'), DATE);
  const b = r.reduce(structuredClone(balanced), makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.deepEqual(a, b);
});

// ─── StrategicAssetLocationReducer (trigger; I1/I2/I7) ─────────────────────────

test('StrategicAssetLocationReducer: proposes a tax-advantaged swap for mislocated holdings (I1)', () => {
  const r = new StrategicAssetLocationReducer({ taxAdvantaged: [
    { stateKey: 'iraAccount', role: ACCOUNT_ROLES.IRA },
    { stateKey: 'rothAccount', role: ACCOUNT_ROLES.ROTH },
  ] });
  const state = {
    // Default policy: BOND → IRA/K401, EQUITY → ROTH. Both holdings are mislocated.
    iraAccount:  makeAccount({ stateKey: 'iraAccount',  holdings: [{ id: 'e1', allocation: ALLOCATION.EQUITY, marketValue: 500, costBasis: 500 }] }),
    rothAccount: makeAccount({ stateKey: 'rothAccount', holdings: [{ id: 'b1', allocation: ALLOCATION.BOND,   marketValue: 500, costBasis: 500 }] }),
  };
  const next = runReducer(r, state, makeAction('US_PERIOD_ADVANCE'), DATE);
  const move = next.next.find(a => a.type === 'ASSET_LOCATION_REBALANCE_APPLY');
  assert.ok(move);
  assert.equal(move.fromStateKey, 'iraAccount');
  assert.equal(move.toStateKey, 'rothAccount');
  assert.equal(move.swapAmount, 500);
});

test('StrategicAssetLocationReducer: well-located holdings produce no moves (I7); deterministic (I2)', () => {
  const r = new StrategicAssetLocationReducer({ taxAdvantaged: [
    { stateKey: 'iraAccount', role: ACCOUNT_ROLES.IRA },
    { stateKey: 'rothAccount', role: ACCOUNT_ROLES.ROTH },
  ] });
  const state = {
    iraAccount:  makeAccount({ stateKey: 'iraAccount',  holdings: [{ id: 'b1', allocation: ALLOCATION.BOND,   marketValue: 500, costBasis: 500 }] }),
    rothAccount: makeAccount({ stateKey: 'rothAccount', holdings: [{ id: 'e1', allocation: ALLOCATION.EQUITY, marketValue: 500, costBasis: 500 }] }),
  };
  const next = runReducer(r, state, makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.equal(next.next.length, 0);
  const a = r.reduce(structuredClone(state), makeAction('US_PERIOD_ADVANCE'), DATE);
  const b = r.reduce(structuredClone(state), makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.deepEqual(a, b);
});

// ─── DownturnRothConversionReducer (trigger; I1/I2/I7/I10) ─────────────────────

test('DownturnRothConversionReducer: fires a Roth conversion capped to IRA balance on regime entry (I1)', () => {
  const r = new DownturnRothConversionReducer({ iraKey: 'iraAccount', rothKey: 'rothAccount', downturnConversionAmount: 20000 });
  const state = {
    activeRegimes: [regime('s1', REGIME_TAG.ECONOMIC_STRESS)],
    people: { p1: { residency: 'US' } },
    iraAccount: makeAccount({ stateKey: 'iraAccount', balance: 50000 }),
  };
  const next = runReducer(r, state, makeAction('US_PERIOD_ADVANCE'), DATE);
  const conv = next.next.find(a => a.type === 'ROTH_CONVERSION_APPLY');
  assert.equal(conv.amount, 20000);
  assert.equal(conv.residency, 'US');
  assert.deepEqual(next.regimeActions.downturn_roth_conversion.firedForShocks, ['s1']);
});

test('DownturnRothConversionReducer: idempotent per shock (I10); empty IRA / no trigger is a no-op (I7)', () => {
  const r = new DownturnRothConversionReducer({ iraKey: 'iraAccount', rothKey: 'rothAccount' });
  // I10 — already latched.
  const latched = {
    activeRegimes: [regime('s1', REGIME_TAG.ECONOMIC_STRESS)],
    people: { p1: { residency: 'US' } },
    regimeActions: { downturn_roth_conversion: { firedForShocks: ['s1'] } },
    iraAccount: makeAccount({ stateKey: 'iraAccount', balance: 50000 }),
  };
  const noRefire = runReducer(r, latched, makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.equal(noRefire.next.filter(a => a.type === 'ROTH_CONVERSION_APPLY').length, 0);

  // I7 — empty IRA.
  const empty = {
    activeRegimes: [regime('s2', REGIME_TAG.ECONOMIC_STRESS)],
    people: { p1: { residency: 'US' } },
    iraAccount: makeAccount({ stateKey: 'iraAccount', balance: 0, holdings: [{ id: 'h', marketValue: 0, costBasis: 0 }] }),
  };
  const noFunds = runReducer(r, empty, makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.equal(noFunds.next.length, 0);
});

// ─── CashBucketDrawdownReducer (trigger/toggle; I1/I2/I7) ──────────────────────

test('CashBucketDrawdownReducer: toggles the drawdown override on/off with stress regime (I1)', () => {
  const r = new CashBucketDrawdownReducer();
  const on = runReducer(r, { activeRegimes: [regime('s1', REGIME_TAG.ECONOMIC_STRESS)] }, makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.equal(on.regimeActions.drawdown_source_override.active, true);

  const off = runReducer(r, { activeRegimes: [], regimeActions: { drawdown_source_override: { active: true } } }, makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.equal(off.regimeActions.drawdown_source_override.active, false);
});

test('CashBucketDrawdownReducer: unchanged flag is a no-op (I7); deterministic (I2)', () => {
  const r = new CashBucketDrawdownReducer();
  const prev = { activeRegimes: [], regimeActions: { drawdown_source_override: { active: false } } };
  const next = runReducer(r, structuredClone(prev), makeAction('US_PERIOD_ADVANCE'), DATE);
  assertStateUnchanged(prev, next);
  const a = r.reduce({ activeRegimes: [regime('s1', REGIME_TAG.ECONOMIC_STRESS)] }, makeAction('US_PERIOD_ADVANCE'), DATE);
  const b = r.reduce({ activeRegimes: [regime('s1', REGIME_TAG.ECONOMIC_STRESS)] }, makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.deepEqual(a, b);
});

// ─── ContributionSuspensionToggleReducer (trigger/toggle; I1/I2/I7) ────────────

test('ContributionSuspensionToggleReducer: suspends/resumes on ECONOMIC_STRESS presence (I1)', () => {
  const r = new ContributionSuspensionToggleReducer();
  const suspended = runReducer(r, { activeRegimes: [regime('s1', REGIME_TAG.ECONOMIC_STRESS)] }, makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.equal(suspended.contributionsSuspended, true);

  const resumed = runReducer(r, { activeRegimes: [], contributionsSuspended: true }, makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.equal(resumed.contributionsSuspended, false);
});

test('ContributionSuspensionToggleReducer: unchanged state is a no-op (I7)', () => {
  const r = new ContributionSuspensionToggleReducer();
  const prev = { activeRegimes: [], contributionsSuspended: false };
  const next = runReducer(r, structuredClone(prev), makeAction('US_PERIOD_ADVANCE'), DATE);
  assertStateUnchanged(prev, next);
});
