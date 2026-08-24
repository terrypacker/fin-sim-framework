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

import { BondLadderReducer, materializeLadder, ladderCarryover, _compactLadderLots } from '../../src/finance/behavioral/bond-ladder-reducer.js';
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

// ─── Carryover basis on rebuild (design 62 §9.5 follow-up) ───────────────────────

/**
 * A ladder rebuild REPLACES the lots it finds. It used to rebuild from market value
 * alone, which silently re-based the whole sleeve at market: unrealized gain vanished
 * untaxed, an AU s855-45 residency step-up was overwritten by a second one, and the
 * post-2027 indexation clock restarted. `ladderCarryover` conserves all three.
 */
describe('ladder rebuild carries the replaced sleeve\'s tax attributes', () => {
  const sum = (hs, f) => +hs.reduce((s, h) => s + f(h), 0).toFixed(2);
  const bonds = (acct) => acct.holdings.filter(h => h.allocation === ALLOCATION.BOND);

  test('LC-1: unrealized gain survives the rebuild — basis is carried, not re-based at market', () => {
    // A sleeve marked up to 40k on a 25k basis: 15k of unrealized gain.
    const lot = { ...bondSleeve(40_000), costBasis: 25_000 };
    const reducer = new BondLadderReducer({ stateKey: 'acct', country: 'US', targetRungs: 5 });
    const next = reducer.reduce(stateWith(stockAccount([lot])), { type: 'US_PERIOD_ADVANCE' });
    const rungs = bonds(next.acct);
    assert.equal(sum(rungs, h => h.marketValue), 40_000, 'value conserved');
    assert.equal(sum(rungs, h => h.costBasis),   25_000, 'basis conserved to the cent — no free step-up');
    assert.ok(rungs.every(h => h.costBasis < h.marketValue), 'every rung carries its share of the gain');
  });

  test('LC-2: an AU residency step-up survives the rebuild (the reported bug)', () => {
    const moveMs = ms(2028);
    const lot = {
      ...bondSleeve(40_000), costBasis: 25_000,
      purchaseDate: new Date(ms(2020)),
      costBaseByCountry:        { AU: 32_000 },   // stepped up to market at the 2028 move
      acquisitionDateByCountry: { AU: moveMs },
      acquisitionPriceLevel:    1.4,
    };
    const reducer = new BondLadderReducer({ stateKey: 'acct', country: 'US', targetRungs: 4 });
    const next = reducer.reduce(stateWith(stockAccount([lot]), { asOfY: 2030 }), { type: 'US_PERIOD_ADVANCE' });
    const rungs = bonds(next.acct);
    assert.equal(sum(rungs, h => h.costBaseByCountry.AU), 32_000, 'AU stepped-up base conserved');
    assert.equal(sum(rungs, h => h.costBasis),            25_000, 'US basis conserved');
    assert.ok(rungs.every(h => h.acquisitionDateByCountry.AU === moveMs),
      'the AU deemed-acquisition date is carried, not reset to the rebuild');
    assert.ok(rungs.every(h => h.acquisitionPriceLevel === 1.4),
      'the indexation base is the move\'s level, not the rebuild\'s');
    assert.ok(rungs.every(h => new Date(h.purchaseDate).getTime() === ms(2020)),
      'holding period runs from the replaced lot, not the rebuild');
  });

  test('LC-3: mixed vintages — basis and level blend exactly, the date is the newest', () => {
    const acct = stockAccount([
      { ...bondSleeve(30_000, 'old'), costBasis: 20_000, purchaseDate: new Date(ms(2020)), acquisitionPriceLevel: 1.0 },
      { ...bondSleeve(10_000, 'new'), costBasis: 10_000, purchaseDate: new Date(ms(2029)), acquisitionPriceLevel: 1.5 },
    ]);
    const reducer = new BondLadderReducer({ stateKey: 'acct', country: 'US', targetRungs: 3 });
    const rungs = bonds(reducer.reduce(stateWith(acct, { asOfY: 2030 }), { type: 'US_PERIOD_ADVANCE' }).acct);

    assert.equal(sum(rungs, h => h.marketValue), 40_000);
    assert.equal(sum(rungs, h => h.costBasis),   30_000);
    // The blend is EXACT for indexation: Σ basisᵢ×(now/levelᵢ) must be unchanged.
    const levelNow  = 2.0;
    const beforeIdx = 20_000 * (levelNow / 1.0) + 10_000 * (levelNow / 1.5);
    const afterIdx  = rungs.reduce((s, h) => s + h.costBasis * (levelNow / h.acquisitionPriceLevel), 0);
    assert.ok(Math.abs(beforeIdx - afterIdx) < 0.01, `indexed base conserved (${beforeIdx} vs ${afterIdx})`);
    assert.ok(rungs.every(h => new Date(h.purchaseDate).getTime() === ms(2029)),
      'newest vintage governs — no ≥12-month credit granted to money bought later');
  });

  test('LC-4: a lot carrying no level enters the blend at today\'s level (factor 1)', () => {
    const lot = { ...bondSleeve(20_000), costBasis: 20_000, acquisitionPriceLevel: null };
    const carry = ladderCarryover([lot], 1.8);
    assert.equal(carry.priceLevel, 1.8, 'un-indexed ⇒ indexes at factor 1 from now, as before');
    assert.equal(carry.costBaseByCountry, null, 'no step-up to carry');
    assert.equal(carry.acquisitionDateByCountry, null);
  });

  test('LC-5: nothing to carry ⇒ null, and rungs fall back to par basis', () => {
    assert.equal(ladderCarryover([], 1.0), null);
    assert.equal(ladderCarryover([{ marketValue: 0, costBasis: 0 }], 1.0), null);
    const rungs = materializeLadder({ bondValue: 30_000, rungs: 3, asOfMs: ms(2030), stateKey: 'a' });
    assert.ok(rungs.every(h => h.costBasis === h.faceValue && h.costBaseByCountry === null));
  });

  test('LC-6: rounding remainder lands on the last rung — carried sums are exact', () => {
    // 100k over 3 rungs on a basis that does not divide evenly either.
    const lot = { ...bondSleeve(100_000), costBasis: 70_000.01, costBaseByCountry: { AU: 55_555.55 } };
    const reducer = new BondLadderReducer({ stateKey: 'acct', country: 'US', targetRungs: 3 });
    const rungs = bonds(reducer.reduce(stateWith(stockAccount([lot])), { type: 'US_PERIOD_ADVANCE' }).acct);
    assert.equal(sum(rungs, h => h.costBasis),            70_000.01);
    assert.equal(sum(rungs, h => h.costBaseByCountry.AU), 55_555.55);
    assert.equal(sum(rungs, h => h.faceValue),           100_000);
  });

  test('LC-7: a rebuild after a rebuild does not drift (idempotent through the lever)', () => {
    const lot = { ...bondSleeve(40_000), costBasis: 25_000, costBaseByCountry: { AU: 30_000 } };
    const reducer = new BondLadderReducer({ stateKey: 'acct', country: 'US', targetRungs: 5 });
    let acct = reducer.reduce(stateWith(stockAccount([lot])), { type: 'US_PERIOD_ADVANCE' }).acct;
    for (const [n, y] of [[8, 2031], [3, 2032], [11, 2033]]) {
      reducer.targetRungs = n;
      acct = reducer.reduce(stateWith(acct, { asOfY: y }), { type: 'US_PERIOD_ADVANCE' }).acct;
      assert.equal(bonds(acct).length, n);
      assert.equal(sum(bonds(acct), h => h.costBasis), 25_000, `basis intact after the ${n}-rung rebuild`);
      assert.equal(sum(bonds(acct), h => h.costBaseByCountry.AU), 30_000, `AU base intact after the ${n}-rung rebuild`);
    }
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

// ─── Absorbing un-laddered fund sleeves (§10.5, crude form) ────────────────────

describe('BondLadderReducer — absorbs new bond FUND sleeves as a tail rung', () => {
  // Drawdown eats an account's rungs; the design-61 rebalancer's next bond buy into an
  // account holding no bonds spawns a PERPETUAL FUND sleeve (`_newSleeve`), and nothing
  // converted one back into a dated rung. Over a long horizon the "ladder" became a
  // minority of the account's bonds. Absorbing keeps every bond dollar in a dated rung
  // WITHOUT resetting the maturity spacing that a full rebuild would destroy.
  //
  // design 93 §5.0a — the absorbed money opens its OWN rung at the ladder tail rather
  // than being folded into the standing ones. A purchase is a lot: blending made the new
  // dollars inherit an acquisition date they were never bought on, and it forced a choice
  // about what par the blend carries that has no good answer. The standing rungs are now
  // untouched, which is the property the assertions below check.
  const laddered = (asOfY = 2030, rungs = 4) => {
    const acct = stockAccount([bondSleeve(100_000, 'seed')]);
    const next = new BondLadderReducer({ stateKey: 'acct', targetRungs: rungs, spacingYears: 1 })
      .reduce(stateWith(acct, { asOfY }), { type: 'US_PERIOD_ADVANCE' });
    return next.acct;
  };

  test('a fund sleeve becomes a new tail rung, conserving value and basis', () => {
    const before = laddered();
    const rungsBefore = before.holdings.filter(h => h.allocation === ALLOCATION.BOND);
    const maturitiesBefore = rungsBefore.map(h => new Date(h.maturityDate).getTime()).sort();

    // A rebalance buy lands as an undated fund sleeve carrying a basis below its value.
    const withFund = { ...before, holdings: [...before.holdings, { id: 'fund', allocation: ALLOCATION.BOND, marketValue: 40_000, costBasis: 30_000 }] };
    const after = new BondLadderReducer({ stateKey: 'acct', targetRungs: 4, spacingYears: 1 })
      .reduce(stateWith(withFund, { asOfY: 2031 }), { type: 'US_PERIOD_ADVANCE' }).acct;

    const bonds = after.holdings.filter(h => h.allocation === ALLOCATION.BOND);
    assert.equal(bonds.length, 5, 'four standing rungs plus the tail rung the money bought');
    assert.ok(bonds.every(h => h.maturityDate != null), 'no undated bond survives');
    assert.equal(+bonds.reduce((s, h) => s + h.marketValue, 0).toFixed(2), 140_000, 'market value conserved');
    assert.equal(+bonds.reduce((s, h) => s + h.costBasis,   0).toFixed(2), 130_000, 'cost basis conserved — NOT re-based at market');
    assert.equal(+bonds.reduce((s, h) => s + h.faceValue,   0).toFixed(2), 140_000, 'the new rung is issued at par for the cash it holds');

    // The standing rungs are BYTE-identical. Nothing about them — value, par, basis,
    // acquisition date — may move, because nothing happened to them.
    for (const b of rungsBefore) {
      assert.deepEqual(bonds.find(h => h.id === b.id), b, `standing rung ${b.id} untouched`);
    }
    const tail = bonds.find(h => !rungsBefore.some(b => b.id === h.id));
    assert.equal(tail.marketValue, 40_000);
    assert.equal(tail.faceValue,   40_000, 'issued at par today');
    assert.equal(tail.costBasis,   30_000, 'carries the absorbed lot\'s basis — no step-up without a disposal');
    assert.ok(!maturitiesBefore.includes(new Date(tail.maturityDate).getTime()),
      'the tail rung matures at the ladder tail, beyond every standing rung');
    assert.deepEqual(
      bonds.filter(h => h.id !== tail.id).map(h => new Date(h.maturityDate).getTime()).sort(),
      maturitiesBefore,
      'maturity spacing untouched — this is an absorption, not a rebuild');
  });

  test('a second absorption in the same year merges into the same vintage lot', () => {
    // Bounded lot growth: one added rung per tail-maturity YEAR, the same convention
    // `mergeCouponReinvestLots` uses. Same instrument, same maturity, same year — no
    // holding-period test can distinguish the halves, so merging is not the blend §5.0a
    // forbids.
    const before   = laddered();
    const addFund  = (a, mv) => ({ ...a, holdings: [...a.holdings, { id: `f${mv}`, allocation: ALLOCATION.BOND, marketValue: mv, costBasis: mv }] });
    const run = (a) => new BondLadderReducer({ stateKey: 'acct', targetRungs: 4, spacingYears: 1 })
      .reduce(stateWith(a, { asOfY: 2031 }), { type: 'US_PERIOD_ADVANCE' }).acct;

    const once  = run(addFund(before, 20_000));
    const twice = run(addFund(once,   20_000));
    const bonds = twice.holdings.filter(h => h.allocation === ALLOCATION.BOND);
    assert.equal(bonds.length, 5, 'still one tail rung, not two');
    assert.equal(+bonds.reduce((s, h) => s + h.marketValue, 0).toFixed(2), 140_000);
  });

  test('no fund sleeve ⇒ still a no-op (the roll self-maintains the ladder)', () => {
    const before = laddered();
    const after = new BondLadderReducer({ stateKey: 'acct', targetRungs: 4, spacingYears: 1 })
      .reduce(stateWith(before, { asOfY: 2031 }), { type: 'US_PERIOD_ADVANCE' }).acct;
    assert.equal(after, before, 'unchanged state object — no churn');
  });
});

// ─── TIPS ladders ──────────────────────────────────────────────────────────────

describe('BondLadderReducer — TIPS rungs at a pinned real yield', () => {
  test('inflationLinked + a pinned couponRate stamps every rung', () => {
    const acct = stockAccount([bondSleeve(100_000)]);
    const next = new BondLadderReducer({
      stateKey: 'acct', targetRungs: 5, spacingYears: 1,
      inflationLinked: true, couponRate: 0.01,
    }).reduce(stateWith(acct, { asOfY: 2030, rate: 0.05 }), { type: 'US_PERIOD_ADVANCE' });
    const rungs = next.acct.holdings;
    assert.equal(rungs.length, 5);
    assert.ok(rungs.every(h => h.inflationLinked === true), 'every rung is a TIPS');
    assert.ok(rungs.every(h => h.couponRate === 0.01),
      'the pinned REAL yield overrides the 5% nominal curve — a CPI-indexed principal paying the nominal yield compensates for inflation twice');
  });

  test('default is unchanged: nominal rungs priced off the curve', () => {
    const acct = stockAccount([bondSleeve(100_000)]);
    const next = new BondLadderReducer({ stateKey: 'acct', targetRungs: 5, spacingYears: 1 })
      .reduce(stateWith(acct, { asOfY: 2030, rate: 0.05 }), { type: 'US_PERIOD_ADVANCE' });
    assert.ok(next.acct.holdings.every(h => h.inflationLinked === false));
    assert.ok(next.acct.holdings.every(h => h.couponRate === 0.05));
  });
});

describe('BOND_LADDER account resolution — every matching account, not the first', () => {
  const entry = BEHAVIORAL_STRATEGY_REGISTRY.BOND_LADDER;
  // Five `us-stock` accounts is an ordinary household (his/hers brokerage, a shared one,
  // two TreasuryDirect). The old `.find(a => a.role === role)` laddered exactly ONE of
  // them and left every other bond sleeve a perpetual fund — the same class of defect as
  // the earnings handlers that resolved a role to a single account.
  const ACCOUNTS = [
    { stateKey: 'usStockAccount',    role: 'us-stock' },
    { stateKey: 'sharedBrokerage',   role: 'us-stock' },
    { stateKey: 'treasuryDirect',    role: 'us-stock' },
    { stateKey: 'iraAccount',        role: 'ira' },
    { stateKey: 'superAccount',      role: 'super' },
  ];

  test('a single role ladders EVERY account carrying it', () => {
    const reducers = entry.reducers({ parameters: { bondLadderRole: 'us-stock' }, accounts: ACCOUNTS });
    assert.deepEqual(reducers.map(r => r.stateKey), ['usStockAccount', 'sharedBrokerage', 'treasuryDirect']);
  });

  test('a LIST of roles ladders each of them', () => {
    const reducers = entry.reducers({ parameters: { bondLadderRole: ['ira', 'super'] }, accounts: ACCOUNTS });
    assert.deepEqual(reducers.map(r => r.stateKey), ['iraAccount', 'superAccount']);
    assert.equal(reducers[1].country, 'AU', 'the super ladder prices off the AU curve');
  });

  test("'ALL' ladders every account (the reducer is inert on those holding no bonds)", () => {
    const reducers = entry.reducers({ parameters: { bondLadderRole: 'ALL' }, accounts: ACCOUNTS });
    assert.equal(reducers.length, 5);
  });

  test('a role matching nothing still falls back to the taxable brokerage (back-compat)', () => {
    const reducers = entry.reducers({ parameters: { bondLadderRole: 'roth-ira' }, accounts: ACCOUNTS });
    assert.deepEqual(reducers.map(r => r.stateKey), ['usStockAccount', 'sharedBrokerage', 'treasuryDirect']);
  });

  test('TIPS + coupon params reach every constructed reducer', () => {
    const reducers = entry.reducers({
      parameters: { bondLadderRole: 'ALL', bondLadderInflationLinked: true, bondLadderCouponRate: 0.01 },
      accounts:   ACCOUNTS,
    });
    assert.ok(reducers.every(r => r.inflationLinked === true && r.couponRate === 0.01));
  });
});

describe('BondLadderReducer — absorption cannot touch a TIPS rung\'s deflation floor', () => {
  // `faceValue` means different things in the two instruments, and treating them alike
  // was a runaway. On a TIPS it is the ORIGINAL issue face, held only as the deflation
  // floor that `redeem` takes a max() against; the indexed principal sits well above it
  // after years of CPI accretion. Scaling the floor by the mv ratio folded the accretion
  // INTO the floor, and because the floor becomes the redemption value, each roll
  // ratcheted the position higher — 266 of 1750 paths past $1e12 at 75% equity, one
  // reaching 1e+63.
  //
  // design 93 §5.0a retires the question rather than answering it. Absorption opens a new
  // rung, so no rule about how to re-price a blended lot has to exist and the standing
  // rung — TIPS or nominal — is not written to at all. These tests assert exactly that:
  // the ratchet is now structurally unreachable, not merely computed correctly.
  const rung = (mv, face, tips) => ({
    id: 'r1', allocation: ALLOCATION.BOND, marketValue: mv, costBasis: mv, faceValue: face,
    maturityDate: new Date(ms(2035)), inflationLinked: tips, rollAtMaturity: true, rollTermYears: 5,
  });
  const absorbInto = (h) => {
    const acct = stockAccount([h, bondSleeve(20_000, 'fund')], { _bondLadderRungs: 2 });
    const bonds = new BondLadderReducer({ stateKey: 'acct', targetRungs: 2, spacingYears: 1 })
      .reduce(stateWith(acct, { asOfY: 2031 }), { type: 'US_PERIOD_ADVANCE' })
      .acct.holdings.filter(x => x.allocation === ALLOCATION.BOND);
    return { rung: bonds.find(x => x.id === 'r1'), tail: bonds.find(x => x.id !== 'r1'), bonds };
  };

  test('a TIPS rung is left exactly as it was; the cash buys its own rung at par', () => {
    // Principal has indexed 130 against an original face of 100. The floor stays at 100 —
    // it is a claim on the units this lot holds, and absorption did not buy any.
    const { rung: r, tail } = absorbInto(rung(130_000, 100_000, true));
    assert.equal(r.marketValue, 130_000, 'the standing TIPS is not written to');
    assert.equal(r.faceValue,   100_000, 'its deflation floor is its own original face');
    assert.equal(tail.marketValue, 20_000);
    assert.equal(tail.faceValue,   20_000, 'the new money buys par at par');
  });

  test('a NOMINAL rung keeps its price-to-par ratio because nothing re-priced it', () => {
    const { rung: r, tail } = absorbInto(rung(90_000, 100_000, false));
    assert.equal(r.marketValue, 90_000);
    assert.equal(r.faceValue,   100_000);
    assert.equal(+(r.marketValue / r.faceValue).toFixed(4), 0.9, 'ratio untouched');
    assert.equal(tail.faceValue, 20_000);
  });

  test('no rung can end up with a floor above the principal it is a floor for', () => {
    const { bonds } = absorbInto(rung(130_000, 100_000, true));
    for (const b of bonds) {
      assert.ok(b.faceValue <= b.marketValue,
        `a floor above the principal turns redeem()'s max() into a ratchet (${b.id})`);
    }
  });
});

// ── Ladder lot compaction (design 93 §5.4 item 3) ────────────────────────────

describe('_compactLadderLots — absorption growth has a ceiling', () => {
  // Absorption opens one rung per year and nothing else merges them: design 61's
  // `_compactSeasonedLots` deliberately touches only the rebalancer's own `reb-` lots.
  // Measured on the bond golden extended to 2060, the IRA's LIVE ladder lots go 22 → 12
  // with this in place; growth is slowed roughly 3.5x, not stopped.
  const YEAR = 365.25 * 24 * 60 * 60 * 1000;
  const asOf = Date.UTC(2040, 0, 1);
  const rung = (id, over) => ({
    id, allocation: ALLOCATION.BOND, units: 100, parPerUnit: 100, pricePerUnit: 100,
    marketValue: 10_000, costBasis: 10_000, faceValue: 10_000,
    maturityDate: new Date(Date.UTC(2044, 0, 1)), couponRate: 0.04, rateKey: 'FIXED_INCOME_US',
    taxExemption: 'state', rollAtMaturity: true, rollTermYears: 4,
    zeroCoupon: false, inflationLinked: false,
    purchaseDate: new Date(asOf - over * YEAR),
    acquisitionPriceLevel: 1.2,
    ...over,
  });

  test('two seasoned rungs that have become the same bond merge, conserving value and basis', () => {
    const a = rung('ladder-acct-absorb-2044', 3);
    const b = { ...rung('ladder-acct-1', 2), units: 50, marketValue: 5_000, costBasis: 4_000, faceValue: 5_000 };
    const out = _compactLadderLots([a, b], asOf);

    assert.equal(out.length, 1, 'same maturity, same coupon, same everything ⇒ one lot');
    assert.equal(out[0].id, a.id, 'the survivor is the EARLIEST lot, so FIFO order is unchanged');
    assert.equal(out[0].units,       150,    'unit counts sum');
    assert.equal(out[0].marketValue, 15_000, 'value is DERIVED from the merged count, never summed separately');
    assert.equal(out[0].faceValue,   15_000, 'and so is par');
    assert.equal(out[0].costBasis,   14_000, 'basis sums — the merge is not a disposal');
    assert.equal(out[0].purchaseDate.getTime(), a.purchaseDate.getTime());
  });

  test('a rung that is not yet seasoned is never merged', () => {
    // Both must be past twelve months, so no holding-period rule — Div 115, §1222, the
    // post-2027 indexation clock — can distinguish them now or ever after.
    const a = rung('ladder-acct-0', 3);
    const b = { ...rung('ladder-acct-1', 3), purchaseDate: new Date(asOf - 0.5 * YEAR) };
    assert.equal(_compactLadderLots([a, b], asOf).length, 2);
  });

  test('any difference in the instrument prevents the merge', () => {
    const base = rung('ladder-acct-0', 3);
    const differs = [
      ['maturityDate',    { maturityDate: new Date(Date.UTC(2045, 0, 1)) }],
      ['couponRate',      { couponRate: 0.05 }],
      ['inflationLinked', { inflationLinked: true }],
      ['taxExemption',    { taxExemption: 'none' }],
      ['cpiIndexRatio',   { cpiIndexRatio: 1.1 }],
    ];
    for (const [what, patch] of differs) {
      const other = { ...rung('ladder-acct-1', 2), ...patch };
      assert.equal(_compactLadderLots([base, other], asOf).length, 2,
        `lots differing in ${what} must not merge`);
    }
  });

  test('only the ladder\'s own lots are eligible', () => {
    // The same discipline design 61 applies to `reb-` lots: an authored lot, a
    // coupon-reinvestment lot or another strategy's lot is left exactly where it is.
    const a = rung('ladder-acct-0', 3);
    const b = rung('authored-bond', 2);
    assert.equal(_compactLadderLots([a, b], asOf).length, 2);
  });

  test('nothing to merge returns the SAME array — no churn, no journal diff', () => {
    const hs = [rung('ladder-acct-0', 3)];
    assert.equal(_compactLadderLots(hs, asOf), hs);
  });
});
