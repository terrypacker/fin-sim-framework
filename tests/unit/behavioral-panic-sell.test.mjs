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
 * behavioral-panic-sell.test.mjs
 *
 * Tests for design/29 §3.1 PanicSell and §3.5 OpportunisticRebalance (Increment 5).
 */

import { test, describe } from 'node:test';
import assert              from 'node:assert/strict';

import { Holding }          from '../../src/finance/holdings/holding.js';
import { ALLOCATION }       from '../../src/finance/holdings/allocation.js';
import { REGIME_TAG }       from '../../src/finance/economic-regimes/regime-tag.js';
import { ACCOUNT_ROLES }    from '../../src/finance/state/account-roles.js';
import { PanicSellReducer }                   from '../../src/finance/behavioral/panic-sell-reducer.js';
import { BehavioralPanicSellApplyReducer }    from '../../src/finance/behavioral/behavioral-panic-sell-apply-reducer.js';
import { OpportunisticRebalanceReducer }      from '../../src/finance/behavioral/opportunistic-rebalance-reducer.js';
import { OpportunisticRebalanceApplyReducer } from '../../src/finance/behavioral/opportunistic-rebalance-apply-reducer.js';

function holding(id, mv, basis, allocation) {
  return new Holding({ id, allocation, marketValue: mv, costBasis: basis, rateKey: 'EQUITY_US' });
}

function account(holdings) {
  return { holdings, balance: holdings.reduce((s, h) => s + h.marketValue, 0) };
}

function regime(shockId, tags = [REGIME_TAG.PANIC_SELL_TRIGGER], factor = 0.3) {
  return { id: `regime-${shockId}`, shockId, tags, currentFactor: factor };
}

// ─── PanicSellReducer ────────────────────────────────────────────────────────

describe('PanicSellReducer', () => {

  const allAccounts = [{ stateKey: 'k401Account', role: ACCOUNT_ROLES.K401 }];
  const reducer = new PanicSellReducer({ allAccounts, panicFraction: 0.30 });

  test('PS-1: emits BEHAVIORAL_PANIC_SELL_APPLY on PANIC_SELL_TRIGGER entry', () => {
    const h1 = holding('e1', 10000, 10000, ALLOCATION.EQUITY);
    const state = {
      activeRegimes: [regime('shock1')],
      regimeActions: {},
      k401Account: account([h1]),
      people: { primary: { residency: 'US' } },
    };

    const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    const sellActions = result.next.filter(a => a.type === 'BEHAVIORAL_PANIC_SELL_APPLY');
    assert.ok(sellActions.length > 0, 'should emit panic sell actions');
    assert.strictEqual(sellActions[0].stateKey, 'k401Account');
    assert.ok(sellActions[0].sellAmount > 0);
  });

  test('PS-2: idempotent — same shock does not fire twice', () => {
    const h1 = holding('e1', 10000, 10000, ALLOCATION.EQUITY);
    const state = {
      activeRegimes: [regime('shock1')],
      regimeActions: { panic_sell: { firedForShocks: ['shock1'] } },
      k401Account: account([h1]),
    };

    const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    const sellActions = result.next.filter(a => a.type === 'BEHAVIORAL_PANIC_SELL_APPLY');
    assert.strictEqual(sellActions.length, 0, 'should not fire again for same shock');
  });

  test('PS-3: no-op when no PANIC_SELL_TRIGGER regime', () => {
    const h1 = holding('e1', 10000, 10000, ALLOCATION.EQUITY);
    const state = {
      activeRegimes: [regime('shock1', [REGIME_TAG.ECONOMIC_STRESS])],
      regimeActions: {},
      k401Account: account([h1]),
    };

    const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    const sellActions = result.next.filter(a => a.type === 'BEHAVIORAL_PANIC_SELL_APPLY');
    assert.strictEqual(sellActions.length, 0, 'ECONOMIC_STRESS does not trigger panic sell');
  });

  test('PS-4: records shockId in regimeActions after firing', () => {
    const h1 = holding('e1', 10000, 10000, ALLOCATION.EQUITY);
    const state = {
      activeRegimes: [regime('shock2')],
      regimeActions: {},
      k401Account: account([h1]),
    };

    const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    assert.ok(result.regimeActions.panic_sell.firedForShocks.includes('shock2'));
  });

});

// ─── BehavioralPanicSellApplyReducer ─────────────────────────────────────────

describe('BehavioralPanicSellApplyReducer', () => {

  const reducer = new BehavioralPanicSellApplyReducer();

  test('PSA-1: reduces equity holding and creates CASH holding', () => {
    const equity = holding('e1', 10000, 8000, ALLOCATION.EQUITY);
    const state  = { k401Account: account([equity]) };

    const result = reducer.reduce(state, {
      type: 'BEHAVIORAL_PANIC_SELL_APPLY',
      stateKey: 'k401Account',
      sourceHoldingId: 'e1',
      sellAmount: 3000,
    });

    const newEquity = result.k401Account.holdings.find(h => h.id === 'e1');
    const cash      = result.k401Account.holdings.find(h => h.allocation === ALLOCATION.CASH);

    assert.ok(newEquity, 'equity holding should remain (partial)');
    assert.ok(Math.abs(newEquity.marketValue - 7000) < 0.01, `equity mv should be 7000, got ${newEquity.marketValue}`);
    assert.ok(cash, 'CASH holding should be created');
    assert.ok(Math.abs(cash.marketValue - 3000) < 0.01, `cash mv should be 3000, got ${cash.marketValue}`);
  });

  test('PSA-2: balance invariant preserved', () => {
    const equity = holding('e1', 10000, 10000, ALLOCATION.EQUITY);
    const state  = { k401Account: account([equity]) };

    const result = reducer.reduce(state, {
      type: 'BEHAVIORAL_PANIC_SELL_APPLY',
      stateKey: 'k401Account',
      sourceHoldingId: 'e1',
      sellAmount: 4000,
    });

    const balSum = result.k401Account.holdings.reduce((s, h) => s + h.marketValue, 0);
    assert.ok(Math.abs(result.k401Account.balance - balSum) < 0.01, 'balance == holding sum');
  });

  test('PSA-3: adds to existing CASH holding', () => {
    const equity = holding('e1', 10000, 10000, ALLOCATION.EQUITY);
    const cash   = holding('c1', 2000, 2000, ALLOCATION.CASH);
    const state  = { k401Account: account([equity, cash]) };

    const result = reducer.reduce(state, {
      type: 'BEHAVIORAL_PANIC_SELL_APPLY',
      stateKey: 'k401Account',
      sourceHoldingId: 'e1',
      sellAmount: 3000,
    });

    const newCash = result.k401Account.holdings.find(h => h.id === 'c1');
    assert.strictEqual(newCash.marketValue, 5000);  // 2000 + 3000
  });

});

// ─── OpportunisticRebalanceReducer ────────────────────────────────────────────

describe('OpportunisticRebalanceReducer', () => {

  const taxAdvantaged = [{ stateKey: 'rothAccount', role: ACCOUNT_ROLES.ROTH }];
  const target = { EQUITY: 0.60, BOND: 0.40 };
  const reducer = new OpportunisticRebalanceReducer({ taxAdvantaged, targetAllocation: target, rebalanceDriftBand: 0.05 });

  test('OR-1: emits OPPORTUNISTIC_REBALANCE_APPLY when drift exceeds band', () => {
    // 80% equity, 20% bond → 20% drift from 60/40 target
    const equity = holding('e1', 8000, 8000, ALLOCATION.EQUITY);
    const bond   = holding('b1', 2000, 2000, ALLOCATION.BOND);
    const state  = {
      rothAccount:   account([equity, bond]),
      activeRegimes: [],
      regimeActions: {},
    };

    const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    const rebalActions = result.next.filter(a => a.type === 'OPPORTUNISTIC_REBALANCE_APPLY');
    assert.ok(rebalActions.length > 0, 'should emit rebalance action when drifted');
    assert.strictEqual(rebalActions[0].stateKey, 'rothAccount');
  });

  test('OR-2: no-op when within drift band', () => {
    // 62% equity, 38% bond → 2% drift, under 5% band
    const equity = holding('e1', 6200, 6200, ALLOCATION.EQUITY);
    const bond   = holding('b1', 3800, 3800, ALLOCATION.BOND);
    const state  = {
      rothAccount:   account([equity, bond]),
      activeRegimes: [],
      regimeActions: {},
    };

    const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    const rebalActions = result.next.filter(a => a.type === 'OPPORTUNISTIC_REBALANCE_APPLY');
    assert.strictEqual(rebalActions.length, 0, 'within band: no rebalance');
  });

});

// ─── OpportunisticRebalanceApplyReducer ──────────────────────────────────────

describe('OpportunisticRebalanceApplyReducer', () => {

  const reducer = new OpportunisticRebalanceApplyReducer();

  test('ORA-1: adjusts holdings toward target allocation', () => {
    // 80% equity, 20% bond → legs say equity -2000, bond +2000
    const equity = holding('e1', 8000, 8000, ALLOCATION.EQUITY);
    const bond   = holding('b1', 2000, 2000, ALLOCATION.BOND);
    const state  = { rothAccount: account([equity, bond]) };

    const result = reducer.reduce(state, {
      type: 'OPPORTUNISTIC_REBALANCE_APPLY',
      stateKey: 'rothAccount',
      legs: [
        { allocation: ALLOCATION.EQUITY, delta: -2000 },
        { allocation: ALLOCATION.BOND,   delta:  2000 },
      ],
    });

    const newEquity = result.rothAccount.holdings.find(h => h.id === 'e1');
    const newBond   = result.rothAccount.holdings.find(h => h.id === 'b1');
    assert.strictEqual(newEquity.marketValue, 6000);
    assert.strictEqual(newBond.marketValue,   4000);
  });

  test('ORA-2: total account value preserved after rebalance', () => {
    const equity = holding('e1', 7000, 7000, ALLOCATION.EQUITY);
    const bond   = holding('b1', 3000, 3000, ALLOCATION.BOND);
    const state  = { k401Account: account([equity, bond]) };

    const result = reducer.reduce(state, {
      type: 'OPPORTUNISTIC_REBALANCE_APPLY',
      stateKey: 'k401Account',
      legs: [{ allocation: ALLOCATION.EQUITY, delta: -1000 }, { allocation: ALLOCATION.BOND, delta: 1000 }],
    });

    const total = result.k401Account.holdings.reduce((s, h) => s + h.marketValue, 0);
    assert.ok(Math.abs(total - 10000) < 0.01, `total value should be preserved: ${total}`);
  });

});
