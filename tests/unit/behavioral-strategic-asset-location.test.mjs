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
 * behavioral-strategic-asset-location.test.mjs
 *
 * Tests for design/29 §3.4 StrategicAssetLocation (Increment 4):
 *   - Swap concentrates bonds in tax-deferred (IRA), equity in Roth
 *   - AssetLocationRebalanceApplyReducer moves value correctly
 *   - Balance invariant preserved after swap
 *   - No taxable account (US_STOCK) involved
 *   - No-op when all holdings already correctly located
 */

import { test, describe } from 'node:test';
import assert              from 'node:assert/strict';

import { Holding }          from '../../src/finance/holdings/holding.js';
import { ALLOCATION }       from '../../src/finance/holdings/allocation.js';
import { ACCOUNT_ROLES }    from '../../src/finance/state/account-roles.js';
import { StrategicAssetLocationReducer }       from '../../src/finance/behavioral/strategic-asset-location-reducer.js';
import { AssetLocationRebalanceApplyReducer }  from '../../src/finance/behavioral/asset-location-rebalance-apply-reducer.js';

function holding(id, mv, basis, allocation) {
  return new Holding({ id, allocation, marketValue: mv, costBasis: basis, rateKey: 'EQUITY_US' });
}

function account(holdings) {
  const balance = holdings.reduce((s, h) => s + h.marketValue, 0);
  return { holdings, balance };
}

// ─── AssetLocationRebalanceApplyReducer ──────────────────────────────────────

describe('AssetLocationRebalanceApplyReducer', () => {

  test('SAL-1: moves value from source holding to target holding', () => {
    const equityInIra = holding('ira-equity', 5000, 5000, ALLOCATION.EQUITY);
    const bondInRoth  = holding('roth-bond',  5000, 5000, ALLOCATION.BOND);
    const state = {
      iraAccount:  account([equityInIra]),
      rothAccount: account([bondInRoth]),
    };

    const reducer = new AssetLocationRebalanceApplyReducer();
    const result  = reducer.reduce(state, {
      type: 'ASSET_LOCATION_REBALANCE_APPLY',
      fromStateKey: 'iraAccount',  fromHoldingId: 'ira-equity',
      toStateKey:   'rothAccount', toHoldingId:   'roth-bond',
      swapAmount:   3000,
    });

    const iraHolding  = result.iraAccount.holdings.find(h => h.id === 'ira-equity');
    const rothHolding = result.rothAccount.holdings.find(h => h.id === 'roth-bond');

    assert.ok(iraHolding,  'source holding should remain (partial sell)');
    assert.strictEqual(iraHolding.marketValue,  2000);
    assert.strictEqual(rothHolding.marketValue, 8000);  // 5000 + 3000
  });

  test('SAL-2: balance invariant after swap', () => {
    const h1 = holding('h1', 10000, 10000, ALLOCATION.BOND);
    const h2 = holding('h2',  8000,  8000, ALLOCATION.EQUITY);
    const state = {
      k401Account: account([h1]),
      rothAccount: account([h2]),
    };

    const reducer = new AssetLocationRebalanceApplyReducer();
    const result  = reducer.reduce(state, {
      type: 'ASSET_LOCATION_REBALANCE_APPLY',
      fromStateKey: 'k401Account', fromHoldingId: 'h1',
      toStateKey:   'rothAccount', toHoldingId:   'h2',
      swapAmount:   4000,
    });

    const k401Sum = result.k401Account.holdings.reduce((s, h) => s + h.marketValue, 0);
    const rothSum = result.rothAccount.holdings.reduce((s, h) => s + h.marketValue, 0);

    assert.ok(Math.abs(result.k401Account.balance - k401Sum) < 0.01, 'k401 balance == holding sum');
    assert.ok(Math.abs(result.rothAccount.balance - rothSum) < 0.01, 'roth balance == holding sum');
  });

  test('SAL-3: missing fromHolding → state unchanged', () => {
    const h2 = holding('h2', 5000, 5000, ALLOCATION.EQUITY);
    const state = { iraAccount: account([]), rothAccount: account([h2]) };
    const reducer = new AssetLocationRebalanceApplyReducer();

    const result = reducer.reduce(state, {
      type: 'ASSET_LOCATION_REBALANCE_APPLY',
      fromStateKey: 'iraAccount', fromHoldingId: 'nonexistent',
      toStateKey: 'rothAccount', toHoldingId: 'h2',
      swapAmount: 1000,
    });

    assert.strictEqual(result, state);
  });

});

// ─── StrategicAssetLocationReducer ───────────────────────────────────────────

describe('StrategicAssetLocationReducer', () => {

  // policy: BOND → IRA/K401, EQUITY → ROTH
  const policy = {
    [ALLOCATION.BOND]:   [ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.K401],
    [ALLOCATION.EQUITY]: [ACCOUNT_ROLES.ROTH],
  };
  const taxAdvantaged = [
    { stateKey: 'iraAccount',  role: ACCOUNT_ROLES.IRA  },
    { stateKey: 'rothAccount', role: ACCOUNT_ROLES.ROTH },
  ];

  test('SAL-H-1: emits swap when IRA holds equity and Roth holds bonds', () => {
    // IRA has equity (should be in Roth), Roth has bonds (should be in IRA)
    const equityInIra = holding('e1', 5000, 5000, ALLOCATION.EQUITY);
    const bondInRoth  = holding('b1', 5000, 5000, ALLOCATION.BOND);
    const state = {
      iraAccount:  account([equityInIra]),
      rothAccount: account([bondInRoth]),
    };

    const reducer = new StrategicAssetLocationReducer({ taxAdvantaged, assetLocationPolicy: policy });
    const result  = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });

    const swaps = result.next.filter(a => a.type === 'ASSET_LOCATION_REBALANCE_APPLY');
    assert.ok(swaps.length > 0, 'should emit at least one swap action');
    assert.ok(swaps.every(s => s.fromStateKey !== 'usStockAccount' && s.toStateKey !== 'usStockAccount'),
      'no taxable account in any swap');
  });

  test('SAL-H-2: no-op when all holdings already correctly located', () => {
    // IRA has bonds (correct), Roth has equity (correct)
    const bondInIra  = holding('b1', 5000, 5000, ALLOCATION.BOND);
    const equityRoth = holding('e1', 5000, 5000, ALLOCATION.EQUITY);
    const state = {
      iraAccount:  account([bondInIra]),
      rothAccount: account([equityRoth]),
    };

    const reducer = new StrategicAssetLocationReducer({ taxAdvantaged, assetLocationPolicy: policy });
    const result  = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });

    const swaps = result.next.filter(a => a.type === 'ASSET_LOCATION_REBALANCE_APPLY');
    assert.strictEqual(swaps.length, 0, 'no swap needed when policy satisfied');
  });

  test('SAL-H-3: taxable accounts not in taxAdvantaged → never involved in a swap', () => {
    // Even if we add a taxable account to state, the reducer only looks at taxAdvantaged
    const equityInIra  = holding('e1', 5000, 5000, ALLOCATION.EQUITY);
    const bondInStock  = holding('b1', 5000, 5000, ALLOCATION.BOND);
    const state = {
      iraAccount:     account([equityInIra]),
      usStockAccount: account([bondInStock]),  // taxable — must never be used
      rothAccount:    account([]),
    };

    const reducer = new StrategicAssetLocationReducer({ taxAdvantaged, assetLocationPolicy: policy });
    const result  = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });

    const swaps = result.next.filter(a => a.type === 'ASSET_LOCATION_REBALANCE_APPLY');
    assert.ok(swaps.every(s => s.fromStateKey !== 'usStockAccount' && s.toStateKey !== 'usStockAccount'),
      'taxable account must not appear in any swap');
  });

});
