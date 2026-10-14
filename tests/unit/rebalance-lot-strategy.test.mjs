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
 * rebalance-lot-strategy.test.mjs — `rebalanceLotStrategy`: which lots a TAXABLE rebalance
 * sells. Before it the rebalancer always walked FIFO, so a sale that could have come out of
 * a high-basis lot realized the oldest lot's whole gain (macro-regimes study flag 22: \$184k
 * against ~\$104k for the same trade). FIFO stays the default, byte-identical.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { RebalanceToTargetReducer }
  from '../../src/finance/behavioral/rebalance-to-target-reducer.js';
import { RebalanceToTargetApplyReducer, REBALANCE_LOT_STRATEGIES }
  from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
import { BEHAVIORAL_STRATEGY_REGISTRY } from '../../src/finance/behavioral/behavioral-strategy-registry.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { ALLOCATION }    from '../../src/finance/holdings/allocation.js';

// An old lot carrying a large gain and a young lot bought near today's price.
function state(extra = {}) {
  return {
    activeRegimes: [], regimeActions: {},
    people: { p1: { residency: 'US' } },
    currentPeriods: { US: { startMs: Date.UTC(2030, 0, 1) }, AU: { startMs: Date.UTC(2030, 0, 1) } },
    usStockAccount: { balance: 100000, holdings: [
      { id: 'old',   allocation: ALLOCATION.EQUITY, marketValue: 50000, costBasis: 10000, purchaseDate: new Date(Date.UTC(2015, 0, 1)) },
      { id: 'young', allocation: ALLOCATION.EQUITY, marketValue: 50000, costBasis: 49000, purchaseDate: new Date(Date.UTC(2028, 0, 1)) },
    ] },
    ...extra,
  };
}

// Sell half the equity into bonds; return the realized STOCK_WITHDRAWAL_TAX gain.
function realizedGain(apply, s = state()) {
  const reducer = new RebalanceToTargetReducer({
    accounts: [{ stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK }],
    targetAllocation: { EQUITY: 0.5, BOND: 0.5 }, driftBandTaxable: 0.10, driftBandSheltered: 0.02,
  });
  let gain = 0;
  for (const a of reducer.reduce(s, { type: 'US_PERIOD_ADVANCE' }).next ?? []) {
    for (const t of apply.reduce(s, a).next ?? []) if (t.type === 'STOCK_WITHDRAWAL_TAX') gain += t.gain;
  }
  return gain;
}

test('default and FIFO sell the oldest lot first', () => {
  assert.strictEqual(realizedGain(new RebalanceToTargetApplyReducer()), 40000);
  assert.strictEqual(realizedGain(new RebalanceToTargetApplyReducer({ lotStrategy: 'FIFO' })), 40000);
});

test('HIFO sells the highest-basis lot first', () => {
  assert.strictEqual(realizedGain(new RebalanceToTargetApplyReducer({ lotStrategy: 'HIFO' })), 1000);
});

test('DRAWDOWN follows state.drawdownLotStrategy at each rebalance', () => {
  const apply = new RebalanceToTargetApplyReducer({ lotStrategy: 'DRAWDOWN' });
  assert.strictEqual(realizedGain(apply, state({ drawdownLotStrategy: 'HIFO' })), 1000);
  assert.strictEqual(realizedGain(apply, state({ drawdownLotStrategy: 'FIFO' })), 40000);
  assert.strictEqual(realizedGain(apply), 40000, 'no drawdown strategy in state ⇒ FIFO');
});

test('an unknown value falls back to FIFO', () => {
  assert.strictEqual(realizedGain(new RebalanceToTargetApplyReducer({ lotStrategy: 'NOPE' })), 40000);
});

test('TARGET_ALLOCATION builds the apply reducer from rebalanceLotStrategy', () => {
  const entry = BEHAVIORAL_STRATEGY_REGISTRY.TARGET_ALLOCATION;
  const schema = entry.paramSchema().find(f => f.key === 'rebalanceLotStrategy');
  assert.deepStrictEqual(schema.options, REBALANCE_LOT_STRATEGIES);
  assert.strictEqual(schema.defaultValue, 'FIFO');
  const build = parameters => entry.reducers({ parameters, accounts: [] })
    .find(r => r instanceof RebalanceToTargetApplyReducer);
  assert.strictEqual(build({}).lotStrategy, 'FIFO');
  assert.strictEqual(build({ rebalanceLotStrategy: 'HIFO' }).lotStrategy, 'HIFO');
});
