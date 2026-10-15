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
 * rebalance-intl-share.test.mjs — `rebalanceIntlShareUs/Au`, the equity MARKET target
 * (macro-regimes study flag 28, option 2). A sheltered account trades to the share; a
 * taxable account only steers the sale or buy it was already making; no target ⇒ the
 * action is exactly what it was.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { RebalanceToTargetReducer }      from '../../src/finance/behavioral/rebalance-to-target-reducer.js';
import { RebalanceToTargetApplyReducer } from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
import { BEHAVIORAL_STRATEGY_REGISTRY }  from '../../src/finance/behavioral/behavioral-strategy-registry.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { ALLOCATION }    from '../../src/finance/holdings/allocation.js';

const lot = (id, rateKey, mv, basis, allocation = ALLOCATION.EQUITY) =>
  ({ id, allocation, rateKey, marketValue: mv, costBasis: basis, purchaseDate: new Date(Date.UTC(2020, 0, 1)) });

function state(stateKey, holdings) {
  return {
    activeRegimes: [], regimeActions: {}, people: { p1: { residency: 'US' } },
    currentPeriods: { US: { startMs: Date.UTC(2030, 0, 1) }, AU: { startMs: Date.UTC(2030, 0, 1) } },
    [stateKey]: { balance: holdings.reduce((s, h) => s + h.marketValue, 0), holdings },
  };
}

function run(s, stateKey, role, target, intlShare) {
  const reducer = new RebalanceToTargetReducer({ accounts: [{ stateKey, role }], targetAllocation: target,
    driftBandTaxable: 0.10, driftBandSheltered: 0.02, intlShare });
  const apply = new RebalanceToTargetApplyReducer();
  const actions = reducer.reduce(s, { type: 'US_PERIOD_ADVANCE' }).next ?? [];
  let next = s, gain = 0;
  for (const a of actions) {
    next = apply.reduce(next, a);
    for (const t of next.next ?? []) if (t.type === 'STOCK_WITHDRAWAL_TAX') gain += t.gain;
  }
  const mv = k => next[stateKey].holdings.filter(h => h.allocation === ALLOCATION.EQUITY && h.rateKey === k)
    .reduce((x, h) => x + h.marketValue, 0);
  const total = next[stateKey].holdings.reduce((x, h) => x + h.marketValue, 0);
  return { actions, us: mv('EQUITY_US'), intl: mv('EQUITY_INTL_EX_US'), total, gain };
}

test('a sheltered account rebalances markets with no class drift', () => {
  const s = state('iraAccount', [lot('us', 'EQUITY_US', 95000, 50000), lot('x', 'EQUITY_INTL_EX_US', 5000, 4000)]);
  const r = run(s, 'iraAccount', ACCOUNT_ROLES.IRA, { EQUITY: 1 }, { US: 0.30 });
  assert.strictEqual(r.actions.length, 1, 'market drift alone triggers');
  assert.ok(Math.abs(r.intl - 30000) < 1 && Math.abs(r.us - 70000) < 1, `${r.us}/${r.intl}`);
  assert.ok(Math.abs(r.total - 100000) < 1, 'value conserved');
});

test('a sheltered account inside its band is left alone', () => {
  const s = state('iraAccount', [lot('us', 'EQUITY_US', 71000, 50000), lot('x', 'EQUITY_INTL_EX_US', 29000, 20000)]);
  assert.strictEqual(run(s, 'iraAccount', ACCOUNT_ROLES.IRA, { EQUITY: 1 }, { US: 0.30 }).actions.length, 0);
});

test('a taxable account never trades for the split alone', () => {
  const s = state('usStockAccount', [lot('us', 'EQUITY_US', 95000, 50000), lot('x', 'EQUITY_INTL_EX_US', 5000, 4000)]);
  assert.strictEqual(run(s, 'usStockAccount', ACCOUNT_ROLES.US_STOCK, { EQUITY: 1 }, { US: 0.30 }).actions.length, 0);
});

test('a taxable sale steers to the target when it can reach it', () => {
  // 80/20 US/intl, target 30%; sell half the equity. After: \$50k of equity, 30% = \$15k
  // intl, so \$5k comes out of intl and \$45k out of US and the split lands on target.
  const s = state('usStockAccount', [lot('us', 'EQUITY_US', 80000, 40000), lot('x', 'EQUITY_INTL_EX_US', 20000, 10000)]);
  const r = run(s, 'usStockAccount', ACCOUNT_ROLES.US_STOCK, { EQUITY: 0.5, BOND: 0.5 }, { US: 0.30 });
  assert.ok(Math.abs(r.us - 35000) < 1 && Math.abs(r.intl - 15000) < 1, `${r.us}/${r.intl}`);
  assert.ok(Math.abs(r.gain - 25000) < 1, `gain ${r.gain}`);   // 45k×½ + 5k×½
});

test('a taxable sale takes only the over-weight market when the target is out of reach', () => {
  // 95/5, target 30%: even after the sale intl is under target, so all \$50k is US.
  const s = state('usStockAccount', [lot('us', 'EQUITY_US', 95000, 50000), lot('x', 'EQUITY_INTL_EX_US', 5000, 4000)]);
  const r = run(s, 'usStockAccount', ACCOUNT_ROLES.US_STOCK, { EQUITY: 0.5, BOND: 0.5 }, { US: 0.30 });
  assert.ok(Math.abs(r.us - 45000) < 1 && Math.abs(r.intl - 5000) < 1, `${r.us}/${r.intl}`);
});

test('a taxable buy goes into the under-weight market first', () => {
  const s = state('usStockAccount', [
    lot('us', 'EQUITY_US', 50000, 50000), lot('b', 'FIXED_INCOME_US', 50000, 50000, ALLOCATION.BOND)]);
  const r = run(s, 'usStockAccount', ACCOUNT_ROLES.US_STOCK, { EQUITY: 0.8, BOND: 0.2 }, { US: 0.30 });
  // Buy $30k of equity: the target is 30% of $80k = $24k intl, so $24k intl and $6k US.
  assert.ok(Math.abs(r.intl - 24000) < 1 && Math.abs(r.us - 56000) < 1, `${r.us}/${r.intl}`);
});

test('no target: the action carries no intlShare and nothing changes', () => {
  const s = state('iraAccount', [lot('us', 'EQUITY_US', 95000, 50000), lot('x', 'EQUITY_INTL_EX_US', 5000, 4000)]);
  const r = run(s, 'iraAccount', ACCOUNT_ROLES.IRA, { EQUITY: 1 }, null);
  assert.strictEqual(r.actions.length, 0);
});

test('TARGET_ALLOCATION passes the two params to the planning reducer', () => {
  const entry = BEHAVIORAL_STRATEGY_REGISTRY.TARGET_ALLOCATION;
  const planner = p => entry.reducers({ parameters: p, accounts: [] }).find(r => r instanceof RebalanceToTargetReducer);
  assert.strictEqual(planner({}).intlShare, null);
  assert.deepStrictEqual(planner({ rebalanceIntlShareUs: 0.15 }).intlShare, { US: 0.15, AU: null });
});
