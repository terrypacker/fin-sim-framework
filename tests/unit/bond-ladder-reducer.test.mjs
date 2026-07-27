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
 * bond-ladder-reducer.test.mjs — design 66 §G8 Phase C (ladder-length lever).
 *
 * The BondLadderReducer materializes and re-shapes a self-perpetuating N-rung bond
 * ladder in a designated account from that account's BOND value, so ladder length is
 * an optimizer / MPC lever. Covers materializeLadder (the rung builder) + the
 * reducer's bootstrap materialization, idempotence, MPC re-shape, and inert cases.
 */

import { test, describe, beforeEach } from 'node:test';
import assert                         from 'node:assert/strict';

import { BondLadderReducer, materializeLadder } from '../../src/finance/behavioral/bond-ladder-reducer.js';
import { ALLOCATION }  from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS }   from '../../src/finance/economic-regimes/rate-keys.js';

const ms = (y, m = 0, d = 1) => Date.UTC(y, m, d);

function stockAccount(holdings, extra = {}) {
  const balance = holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0);
  return { role: 'us-stock', country: 'US', balance, holdings, ...extra };
}

function stateWith(account, { asOfY = 2030, rate = 0.05 } = {}) {
  return {
    effectiveInterestRates: { [RATE_KEYS.FIXED_INCOME_US]: rate },
    currentPeriods:         { US: { startMs: ms(asOfY) } },
    acct: account,
  };
}

const bondSleeve = (mv, id = 'b1') => ({ id, allocation: ALLOCATION.BOND, marketValue: mv, costBasis: mv });
const equity     = (mv, id = 'eq') => ({ id, allocation: ALLOCATION.EQUITY, marketValue: mv, costBasis: mv });

// ─── materializeLadder ──────────────────────────────────────────────────────────

describe('materializeLadder (§G8)', () => {
  test('splits value into N equal staggered rolling rungs; last absorbs the remainder', () => {
    const rungs = materializeLadder({
      bondValue: 100_000, rungs: 5, spacingYears: 1, asOfMs: ms(2030),
      roll: true, taxExemption: 'state', stateKey: 'usStockAccount',
      rateKey: RATE_KEYS.FIXED_INCOME_US, couponRate: 0.05,
    });
    assert.equal(rungs.length, 5);
    // Even $20k split, exact sum.
    assert.equal(rungs.reduce((s, h) => s + h.faceValue, 0), 100_000);
    assert.ok(rungs.every(h => h.marketValue === h.faceValue && h.costBasis === h.faceValue));
    // Staggered maturities ~1 year apart, strictly increasing (5 distinct rungs);
    // every rung rolls to the ladder tail (5y).
    const mats = rungs.map(h => new Date(h.maturityDate).getTime());
    const YEAR = 365.25 * 24 * 60 * 60 * 1000;
    for (let i = 1; i < mats.length; i++) {
      assert.ok(Math.abs((mats[i] - mats[i - 1]) - YEAR) < 1000, `rung ${i} is ~1yr past rung ${i - 1}`);
    }
    assert.equal(new Set(mats).size, 5, 'five distinct maturities');
    assert.ok(rungs.every(h => h.rollAtMaturity === true && h.rollTermYears === 5));
    assert.ok(rungs.every(h => h.taxExemption === 'state' && h.couponRate === 0.05));
    // Deterministic ids.
    assert.deepEqual(rungs.map(h => h.id), [0, 1, 2, 3, 4].map(k => `ladder-usStockAccount-${k}`));
  });

  test('remainder lands on the last rung (odd split still sums exactly)', () => {
    const rungs = materializeLadder({ bondValue: 100_000, rungs: 3, asOfMs: ms(2030), stateKey: 'a' });
    assert.equal(rungs.reduce((s, h) => s + h.faceValue, 0), 100_000);
    assert.equal(rungs[0].faceValue, 33_333.33);
    assert.equal(rungs[2].faceValue, +(100_000 - 2 * 33_333.33).toFixed(2)); // 33,333.34
  });

  test('roll OFF ⇒ rungs do not self-perpetuate (rollTermYears null)', () => {
    const rungs = materializeLadder({ bondValue: 30_000, rungs: 3, asOfMs: ms(2030), roll: false, stateKey: 'a' });
    assert.ok(rungs.every(h => h.rollAtMaturity === false && h.rollTermYears === null));
  });
});

// ─── Reducer ─────────────────────────────────────────────────────────────────────

describe('BondLadderReducer (§G8 Phase C)', () => {
  let reducer;
  beforeEach(() => { reducer = new BondLadderReducer({ stateKey: 'acct', country: 'US', targetRungs: 5 }); });

  test('materializes a ladder from the account bond value on the first period; spares other sleeves', () => {
    const account = stockAccount([equity(60_000), bondSleeve(40_000)]);
    const next = reducer.reduce(stateWith(account), { type: 'US_PERIOD_ADVANCE' });
    const acct = next.acct;
    const rungs = acct.holdings.filter(h => h.allocation === ALLOCATION.BOND);
    assert.equal(rungs.length, 5, '40k bond value laddered into 5 rungs');
    assert.equal(rungs.reduce((s, h) => s + h.marketValue, 0), 40_000, 'bond value conserved');
    assert.equal(acct.holdings.find(h => h.id === 'eq').marketValue, 60_000, 'equity untouched');
    assert.equal(acct.balance, 100_000, 'balance re-synced');
    assert.equal(acct._bondLadderRungs, 5, 'rung-count marker stamped');
    // Coupon locked from the current yield (G1); Treasury tax treatment (default).
    assert.ok(rungs.every(h => h.couponRate === 0.05 && h.taxExemption === 'state'));
  });

  test('is idempotent — a second period at the same length does not churn holdings', () => {
    const account = stockAccount([bondSleeve(40_000)]);
    const once  = reducer.reduce(stateWith(account), { type: 'US_PERIOD_ADVANCE' });
    const twice = reducer.reduce(stateWith(once.acct, { asOfY: 2031 }), { type: 'US_PERIOD_ADVANCE' });
    assert.equal(twice.acct.holdings, once.acct.holdings, 'holdings array identity unchanged (no re-materialize)');
  });

  test('re-materializes when the lever changes the rung count (MPC re-wire)', () => {
    const account = stockAccount([bondSleeve(40_000)]);
    const first = reducer.reduce(stateWith(account), { type: 'US_PERIOD_ADVANCE' });
    assert.equal(first.acct.holdings.filter(h => h.allocation === ALLOCATION.BOND).length, 5);

    // Simulate the MPC actuate: reducerService.updateReducer(reducer, { targetRungs: 8 }).
    reducer.targetRungs = 8;
    const reshaped = reducer.reduce(stateWith(first.acct, { asOfY: 2031 }), { type: 'US_PERIOD_ADVANCE' });
    const rungs = reshaped.acct.holdings.filter(h => h.allocation === ALLOCATION.BOND);
    assert.equal(rungs.length, 8, 'ladder re-shaped to 8 rungs');
    assert.equal(rungs.reduce((s, h) => s + h.marketValue, 0), 40_000, 'value still conserved');
    assert.equal(reshaped.acct._bondLadderRungs, 8, 'marker updated');
    assert.ok(rungs.every(h => h.rollTermYears === 8), 'rungs roll to the new 8y tail');
  });

  test('inert when the account holds no bonds (nothing to ladder)', () => {
    const account = stockAccount([equity(100_000)]);
    const next = reducer.reduce(stateWith(account), { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.acct.holdings.length, 1);
    assert.equal(next.acct.holdings[0].allocation, ALLOCATION.EQUITY);
    assert.equal(next.acct._bondLadderRungs, undefined, 'no marker stamped');
  });

  test('inert when the designated account is absent', () => {
    const orphan = new BondLadderReducer({ stateKey: 'missing', targetRungs: 5 });
    const account = stockAccount([bondSleeve(40_000)]);
    const next = orphan.reduce(stateWith(account), { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.acct.holdings.length, 1, 'untouched — target account not present');
  });

  test('clamps the rung count to a sane [2,30] range', () => {
    const tiny = new BondLadderReducer({ stateKey: 'acct', targetRungs: 1 });
    const next = tiny.reduce(stateWith(stockAccount([bondSleeve(20_000)])), { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.acct.holdings.filter(h => h.allocation === ALLOCATION.BOND).length, 2, 'floored at 2 rungs');
  });
});

// ─── Wiring (strategy → reducer, opt param, MPC control) ─────────────────────────

import { BEHAVIORAL_STRATEGY_REGISTRY } from '../../src/finance/behavioral/behavioral-strategy-registry.js';
import { DEFAULT_OPTIMIZATION_CONFIGS } from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { COCKPIT_CONTROLS }             from '../../src/finance/mpc/cockpit-controller.js';

describe('BOND_LADDER lever wiring (§G8 Phase C)', () => {
  test('the BOND_LADDER strategy constructs a BondLadderReducer targeting the brokerage', () => {
    const entry = BEHAVIORAL_STRATEGY_REGISTRY.BOND_LADDER;
    assert.ok(entry, 'strategy registered');
    const reducers = entry.reducers({
      parameters: { bondLadderRungs: 7 },
      accounts:   [{ stateKey: 'usStockAccount', role: 'us-stock' }],
    });
    assert.equal(reducers.length, 1);
    assert.equal(reducers[0].constructor.type, 'BondLadderReducer');
    assert.equal(reducers[0].stateKey, 'usStockAccount');
    assert.equal(reducers[0].targetRungs, 7);
  });

  test('the strategy is inert (no reducer) when no ladderable account is present', () => {
    const reducers = BEHAVIORAL_STRATEGY_REGISTRY.BOND_LADDER.reducers({ parameters: {}, accounts: [] });
    assert.deepEqual(reducers, []);
  });

  test('bondLadderRungs is an INTEGER optimizer variable', () => {
    const p = DEFAULT_OPTIMIZATION_CONFIGS.find(c => c.paramKey === 'bondLadderRungs');
    assert.ok(p, 'opt param registered');
    assert.equal(p.type, 'integer');
    assert.equal(p.min, 2);
    assert.equal(p.max, 15);
  });

  test('the BOND_LADDER MPC control re-wires a live BondLadderReducer', () => {
    const ctrl = COCKPIT_CONTROLS.BOND_LADDER;
    assert.ok(ctrl && ctrl.liveActuatable, 'control registered + live-actuatable');
    assert.ok(ctrl.appliesTo({ behavioralStrategies: ['BOND_LADDER'] }));
    assert.ok(!ctrl.appliesTo({ behavioralStrategies: [] }));

    const reducer = new BondLadderReducer({ stateKey: 'acct', targetRungs: 5 });
    let updated = null;
    const services = {
      reducerService: {
        getAll: () => [reducer],
        updateReducer: (r, changes) => { Object.assign(r, changes); updated = changes; },
      },
    };
    const scenario = { params: [{ key: 'bondLadderRungs', value: 5 }] };
    const ok = ctrl.actuate({ services, scenario, candidate: { bondLadderRungs: 9 } });
    assert.equal(ok, true);
    assert.equal(updated.targetRungs, 9, 'live reducer re-wired to the new rung count');
    assert.equal(reducer.targetRungs, 9);
    assert.equal(scenario.params[0].value, 9, 'scenario param persisted');
  });
});

// ─── Full-sim e2e: the strategy ladders the real brokerage bonds (§10.7) ─────────

import { loadScenarioSim } from '../helpers/scenario-harness.js';

test('LADDER-E2E: selecting BOND_LADDER materializes the brokerage bonds into a rolling ladder', () => {
  // behavioralStrategies / bondLadderRungs are toolset-contributed params;
  // buildDefaultConfig forwards them straight from the override bag (no cfg poke).
  const { sim } = loadScenarioSim({
    params: {
      monthlyExpenses: 0, inflationAdjust: false,
      behavioralStrategies: ['BOND_LADDER'], bondLadderRungs: 6,
    },
    stepTo: new Date(Date.UTC(2028, 0, 2)),   // past a couple of period advances
  });

  const acct  = sim.state.usStockAccount;
  const bonds = acct.holdings.filter(h => h.allocation === 'BOND');
  const rungs = bonds.filter(h => typeof h.id === 'string' && h.id.startsWith('ladder-'));
  assert.ok(rungs.length >= 6, `expected a >=6-rung ladder, got ${rungs.length}`);
  // Rungs self-perpetuate (roll to the ladder tail) and are staggered.
  assert.ok(rungs.every(h => h.rollAtMaturity === true && h.rollTermYears > 0), 'rungs roll to tail');
  const distinctMaturities = new Set(rungs.map(h => new Date(h.maturityDate).getTime()));
  assert.ok(distinctMaturities.size >= 5, 'rungs mature on staggered dates');
  // Equity sleeve survived (the ladder only touches the bond sleeve).
  assert.ok(acct.holdings.some(h => h.allocation === 'EQUITY'), 'equity sleeve preserved');
});
