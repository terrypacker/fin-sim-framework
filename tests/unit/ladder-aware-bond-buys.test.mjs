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
 * ladder-aware-bond-buys.test.mjs — design 128.
 *
 * A rebalance BOND buy into a laddered account used to open a nominal bond FUND lot, which
 * sat until the next ladder pass (six months to a year) and was then absorbed as ONE lump
 * tail rung, dated from the absorbing advance rather than the ladder's grid. The ladder now
 * stamps a `bondLadderIntent` on its account and the rebalance buys the ladder's own
 * instrument, spread equally over its next N grid dates, the same day.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { BondLadderReducer, ladderSlots, ladderSlotYield, buyIntoLadder, _compactLadderLots }
  from '../../src/finance/behavioral/bond-ladder-reducer.js';
import { RebalanceToTargetApplyReducer } from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
import { BondMaturityReducer } from '../../src/finance/economic-regimes/bond-maturity-reducer.js';
import { ALLOCATION }    from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS }     from '../../src/finance/economic-regimes/rate-keys.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';

const YEAR = 365.25 * 24 * 60 * 60 * 1000;
const ms   = (y, m = 0, d = 1) => Date.UTC(y, m, d);

const APPLY = new RebalanceToTargetApplyReducer();

function account(holdings, extra = {}) {
  return { stateKey: 'acct', role: ACCOUNT_ROLES.US_STOCK, country: 'US', currency: { code: 'USD' },
    balance: holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0), holdings, ...extra };
}
function stateAt(acct, atMs, { rate = 0.05, inflation = 0.03 } = {}) {
  return {
    people: { p1: { residency: 'US' } },
    effectiveInterestRates:  { [RATE_KEYS.FIXED_INCOME_US]: rate },
    effectiveInflationRates: { US: inflation },
    currentPeriods: { US: { startMs: atMs } },
    acct,
  };
}
const bondFund = (mv, id = 'seed') => ({ id, allocation: ALLOCATION.BOND, marketValue: mv, costBasis: mv });
const equity   = (mv) => ({ id: 'eq', allocation: ALLOCATION.EQUITY, rateKey: RATE_KEYS.EQUITY_US, marketValue: mv, costBasis: mv,
  purchaseDate: new Date(ms(2020)) });
const ladder   = (opts = {}) => new BondLadderReducer({ stateKey: 'acct', targetRungs: 5, spacingYears: 1, ...opts });
const advance  = (r, state) => r.reduce(state, { type: 'US_PERIOD_ADVANCE' });

/** Materialize a ladder on 1 Jan `y`, then apply a BOND buy of `amount` on `buyMs`. */
function ladderThenBuy({ y = 2030, buyMs = ms(y), amount = 100_000, opts = {}, mutate = a => a } = {}) {
  const built = advance(ladder(opts), stateAt(account([equity(200_000), bondFund(50_000)]), ms(y))).acct;
  const acct  = mutate(built);
  const state = stateAt(acct, buyMs);
  const out = APPLY.reduce(state, {
    type: 'REBALANCE_TO_TARGET_APPLY', stateKey: 'acct', role: ACCOUNT_ROLES.US_STOCK, taxable: false, country: 'US',
    legs: [{ allocation: ALLOCATION.BOND, delta: amount }],
  }, new Date(buyMs));
  return { built, state, after: out.acct, bought: out.acct.holdings.filter(h => h.id.includes('-buy-')) };
}

describe('design 128 §3.1 — the ladder stamps its intent', () => {
  test('LB-1: materialization stamps the shape, anchored at the build date', () => {
    const acct = advance(ladder({ inflationLinked: true }), stateAt(account([bondFund(50_000)]), ms(2030))).acct;
    const i = acct.bondLadderIntent;
    assert.equal(i.rungs, 5);
    assert.equal(i.spacingYears, 1);
    assert.equal(i.anchorMs, ms(2030));
    assert.equal(i.inflationLinked, true);
    assert.equal(i.tipsCouponMode, 'MARKET', 'AUTO resolved: no pinned coupon');
    assert.equal(i.rateKey, RATE_KEYS.FIXED_INCOME_US);
    assert.equal(i.minSlotBuy, 1000);
  });

  test('LB-2: a pass with no bonds still stamps the intent (no anchor yet)', () => {
    const acct = advance(ladder(), stateAt(account([equity(100_000)]), ms(2030))).acct;
    assert.equal(acct.bondLadderIntent.rungs, 5);
    assert.equal(acct.bondLadderIntent.anchorMs, null);
    assert.equal(acct._bondLadderRungs, undefined, 'nothing was laddered');
  });

  test('LB-3: an MPC change of N re-materializes and re-anchors', () => {
    const r = ladder();
    const first = advance(r, stateAt(account([bondFund(50_000)]), ms(2030))).acct;
    r.targetRungs = 3;
    const next = advance(r, stateAt(first, ms(2031))).acct;
    assert.equal(next.bondLadderIntent.rungs, 3);
    assert.equal(next.bondLadderIntent.anchorMs, ms(2031));
  });
});

describe('design 128 §3.2 — a rebalance BOND buy buys the ladder', () => {
  test('LB-4: a 1 January buy on a 5-rung TIPS ladder — five TIPS lots the same day, no fund', () => {
    const { bought, after, state } = ladderThenBuy({ y: 2030, buyMs: ms(2031), opts: { inflationLinked: true } });
    assert.equal(bought.length, 5, 'one lot per slot');
    assert.ok(bought.every(h => h.marketValue === 20_000 && h.costBasis === 20_000 && h.faceValue === 20_000), 'a fifth each, at par, basis = cash');
    assert.ok(bought.every(h => h.inflationLinked === true && h.tipsCouponMode === 'MARKET'), 'the ladder\'s instrument');
    assert.ok(bought.every(h => new Date(h.purchaseDate).getTime() === ms(2031)), 'bought today');
    assert.ok(!after.holdings.some(h => h.allocation === ALLOCATION.BOND && h.maturityDate == null), 'no nominal fund lot');
    for (const h of bought) {
      const tenor = (new Date(h.maturityDate).getTime() - ms(2031)) / YEAR;
      assert.equal(h.couponRate, ladderSlotYield(state, after.bondLadderIntent, tenor), 'the real yield at the slot\'s own tenor');
      assert.ok(h.couponRate < 0.05, 'a real yield, below the 5% nominal');
    }
  });

  test('LB-5: the lots land on the ladder\'s grid dates — the rungs\' own maturities', () => {
    const { built, bought } = ladderThenBuy({ y: 2030, buyMs: ms(2030, 6, 1) });
    const rungMats = built.holdings.filter(h => h.maturityDate).map(h => new Date(h.maturityDate).getTime()).sort();
    assert.deepEqual(bought.map(h => new Date(h.maturityDate).getTime()).sort(), rungMats,
      'a 1 July buy is not dated 30 June: it joins the 1 January grid');
  });

  test('LB-6: every rung consumed — the slots still come from the grid, not from the buy date', () => {
    const { built, bought } = ladderThenBuy({
      y: 2030, buyMs: ms(2032, 6, 1),
      mutate: a => ({ ...a, holdings: a.holdings.filter(h => h.allocation !== ALLOCATION.BOND) }),
    });
    const expected = ladderSlots(built.bondLadderIntent, ms(2032, 6, 1)).map(s => s.maturityMs);
    assert.deepEqual(bought.map(h => new Date(h.maturityDate).getTime()), expected);
    assert.ok(expected.every(t => (t - ms(2030)) % YEAR === 0), 'anchor + m × spacing');
  });

  test('LB-7: a buy below the per-slot floor goes to the longest slot alone', () => {
    const { bought, built } = ladderThenBuy({ amount: 4_000 });
    assert.equal(bought.length, 1);
    assert.equal(bought[0].marketValue, 4_000);
    const slots = ladderSlots(built.bondLadderIntent, ms(2030));
    assert.equal(new Date(bought[0].maturityDate).getTime(), slots[slots.length - 1].maturityMs);
  });

  test('LB-8: an awkward amount is value-exact', () => {
    const { bought } = ladderThenBuy({ amount: 33_333.33 });
    assert.equal(+bought.reduce((s, h) => s + h.marketValue, 0).toFixed(2), 33_333.33);
  });

  test('LB-9: no ladder — the BOND buy is the old fund lot, unchanged', () => {
    const state = stateAt(account([equity(100_000), bondFund(50_000)]), ms(2030));
    const out = APPLY.reduce(state, {
      type: 'REBALANCE_TO_TARGET_APPLY', stateKey: 'acct', role: ACCOUNT_ROLES.US_STOCK, taxable: false, country: 'US',
      legs: [{ allocation: ALLOCATION.BOND, delta: 10_000 }],
    }, new Date(ms(2030)));
    const reb = out.acct.holdings.filter(h => h.id.startsWith('reb-BOND'));
    assert.equal(reb.length, 1);
    assert.equal(reb[0].maturityDate ?? null, null, 'a bond fund');
  });
});

describe('design 128 — bought lots keep their own vintage, and merge after a roll', () => {
  test('LB-10: two buys a year apart are separate lots; once rolled onto one date and seasoned, they merge', () => {
    const intent = { rungs: 2, spacingYears: 1, anchorMs: ms(2030), roll: true, taxExemption: 'state',
      inflationLinked: false, tipsCouponMode: null, couponRate: null, rateKey: RATE_KEYS.FIXED_INCOME_US,
      inflationExpectation: null, minSlotBuy: 0 };
    const st = stateAt(account([]), ms(2030));
    let hs = buyIntoLadder([], 20_000, intent, { state: st, stateKey: 'acct', purchaseMs: ms(2030, 6, 1), priceLevel: 1 });
    hs = buyIntoLadder(hs, 20_000, intent, { state: st, stateKey: 'acct', purchaseMs: ms(2031, 6, 1), priceLevel: 1 });
    assert.equal(hs.length, 4, 'no join at purchase');
    const shared = ms(2030) + 2 * YEAR;
    const onShared = hs.filter(h => new Date(h.maturityDate).getTime() === shared);
    assert.equal(onShared.length, 2, 'both buys hold the 2032 slot');
    assert.notEqual(+new Date(onShared[0].purchaseDate), +new Date(onShared[1].purchaseDate), 'each keeps its own date');

    // Roll at the first advance past the shared maturity; both re-issue as the same bond.
    const rolled = new BondMaturityReducer()
      .reduce(stateAt(account(hs), ms(2032, 6, 1)), { type: 'US_PERIOD_ADVANCE' }).acct.holdings;
    const after  = _compactLadderLots(rolled, ms(2033, 6, 1));
    const merged = after.filter(h => new Date(h.maturityDate).getTime() === shared + 2 * YEAR);
    assert.equal(merged.length, 1, 'same bond, seasoned ⇒ one lot');
    assert.equal(merged[0].marketValue, 20_000);
    assert.ok(rolled.filter(h => new Date(h.maturityDate).getTime() === shared + 2 * YEAR).every(h => h.duration === 2),
      'a rolled ladder rung takes the roll tenor as its duration');
  });
});
