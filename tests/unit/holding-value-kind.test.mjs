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
 * holding-value-kind.test.mjs — design 94 §11's FIFTH invariant walk (step 2a).
 *
 * The four walks design 93 left behind all check a NUMBER: balance equals Σ market value,
 * market value equals units x price, par equals units x par-per-unit. This one cannot,
 * because the defect it exists to catch **conserves every number it touches**.
 *
 * Design 94 §9.5b measured it: with equity unitised under a throwaway spike, a position
 * held the same 600 units through a 44-year run that reinvested a dividend into it every
 * single year, while `pricePerUnit` absorbed all of it. Market value was right to the
 * cent, balance was right to the cent, every invariant held — and all 5,505 tests passed.
 * Only the unit count was fiction.
 *
 * So the assertions here are about WHICH PRIMITIVE RAN, not about what the value is:
 * a PRICE move must leave `units` alone, and a UNITS move must leave `pricePerUnit` alone.
 * That is checkable, and it is the only thing that is.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { HoldingTransactAction, VALUE_KIND } from '../../src/finance/holdings/holding-actions.js';
import { HoldingTransactReducer } from '../../src/finance/holdings/holding-reducers.js';
import { computeHoldingsGrowth, computeHoldingsDividends }
  from '../../src/finance/holdings/holdings-earnings.js';
import { TypeRegistry } from '../../src/simulation-framework/type-registry.js';
import { registerHoldingActionTypes } from '../../src/finance/holdings/holding-actions.js';

const reducer = new HoldingTransactReducer();

/** A UNITISED equity position: 600 units at 100, the design 93 §5b convention. */
const unitisedLot = (over = {}) => ({
  id: 'h1', allocation: 'EQUITY', units: 600, pricePerUnit: 100,
  marketValue: 60000, costBasis: 60000, rateKey: 'EQUITY_AU', ...over,
});

/** The same position, SCALAR — no unit count. */
const scalarLot = (over = {}) => ({
  id: 'h1', allocation: 'EQUITY', marketValue: 60000, costBasis: 60000,
  rateKey: 'EQUITY_AU', ...over,
});

const stateWith = (holding) => ({ acct: { balance: holding.marketValue, holdings: [holding] } });

function applyDelta(holding, { marketValueDelta, costBasisDelta = 0, valueKind }) {
  const next = reducer.reduce(
    stateWith(holding),
    new HoldingTransactAction({ stateKey: 'acct', holdingId: 'h1', marketValueDelta, costBasisDelta, valueKind }),
  );
  return next.acct.holdings[0];
}

describe('design 94 §11 — a value change declares its KIND (step 2a)', () => {

  test('UNITISED + PRICE: the price moves and the unit count does not', () => {
    const out = applyDelta(unitisedLot(), { marketValueDelta: 6000, valueKind: VALUE_KIND.PRICE });
    assert.equal(out.units, 600, 'appreciation must not mint units');
    assert.equal(out.pricePerUnit, 110);
    assert.equal(out.marketValue, 66000);
  });

  test('UNITISED + UNITS: the unit count moves and the price does not', () => {
    const out = applyDelta(unitisedLot(), { marketValueDelta: 6000, valueKind: VALUE_KIND.UNITS });
    assert.equal(out.pricePerUnit, 100, 'new money must not re-price the units already held');
    assert.equal(out.units, 660, '6,000 at 100 buys 60 more units');
    assert.equal(out.marketValue, 66000);
  });

  test('the two kinds are NOT the same operation — the gate is not vacuous', () => {
    const asPrice = applyDelta(unitisedLot(), { marketValueDelta: 6000, valueKind: VALUE_KIND.PRICE });
    const asUnits = applyDelta(unitisedLot(), { marketValueDelta: 6000, valueKind: VALUE_KIND.UNITS });
    assert.equal(asPrice.marketValue, asUnits.marketValue,
      'both conserve the money exactly — which is why no numeric invariant can see the bug');
    assert.notEqual(asPrice.units, asUnits.units, 'and they differ in the count, which is what can');
  });

  test('a UNITS credit does not step basis — the action`s own costBasisDelta still owns it', () => {
    const noBasis = applyDelta(unitisedLot(), { marketValueDelta: 6000, valueKind: VALUE_KIND.UNITS });
    assert.equal(noBasis.costBasis, 60000, 'a reinvested dividend books income, not basis (F3)');
    const withBasis = applyDelta(unitisedLot(),
      { marketValueDelta: 6000, costBasisDelta: 6000, valueKind: VALUE_KIND.UNITS });
    assert.equal(withBasis.costBasis, 66000, 'and a contribution that DOES carry basis still does');
  });

  test('SCALAR: the two kinds are indistinguishable — step 2a is behaviour-neutral', () => {
    const asPrice = applyDelta(scalarLot(), { marketValueDelta: 6000, valueKind: VALUE_KIND.PRICE });
    const asUnits = applyDelta(scalarLot(), { marketValueDelta: 6000, valueKind: VALUE_KIND.UNITS });
    assert.deepEqual(asUnits, asPrice, 'no count to move, so both land on marketValue, unrounded');
    assert.equal(asPrice.marketValue, 66000);
  });

  test('the default kind is PRICE, so every unconverted emitter behaves as before', () => {
    const explicit = applyDelta(unitisedLot(), { marketValueDelta: 6000, valueKind: VALUE_KIND.PRICE });
    const implicit = applyDelta(unitisedLot(), { marketValueDelta: 6000, valueKind: undefined });
    assert.deepEqual(implicit, explicit);
  });

  test('a withdrawal still floors at zero under either kind', () => {
    for (const valueKind of [VALUE_KIND.PRICE, VALUE_KIND.UNITS]) {
      const out = applyDelta(unitisedLot(), { marketValueDelta: -99999, valueKind });
      assert.equal(out.marketValue, 0, `${valueKind}: floored, never negative`);
    }
  });
});

describe('design 94 §9.4 — the emitters declare the right kind', () => {

  const account = (holding) => ({
    acct: { balance: holding.marketValue, holdings: [holding] },
    effectiveGrowthRates: { EQUITY_AU: 0.10 },
  });

  test('appreciation is a PRICE move', () => {
    const { holdingActions } = computeHoldingsGrowth({
      state: account(scalarLot()), stateKey: 'acct', fallbackRate: 0.1, fallbackRateKey: 'EQUITY_AU',
    });
    assert.equal(holdingActions.length, 1);
    assert.equal(holdingActions[0].valueKind ?? VALUE_KIND.PRICE, VALUE_KIND.PRICE);
  });

  test('a reinvested dividend is a UNITS move — the §9.5b defect, at its source', () => {
    const { holdingActions } = computeHoldingsDividends({
      state: account(scalarLot({ dividendYield: 0.04 })), stateKey: 'acct',
      fallbackYield: 0.04, fallbackRateKey: 'EQUITY_AU',
    });
    assert.equal(holdingActions.length, 1);
    assert.equal(holdingActions[0].valueKind, VALUE_KIND.UNITS,
      'a dividend buys more of the instrument; it does not raise the price of what is held');
  });

  test('and the two reach the same lot with the same costBasisDelta — which is why they were confused', () => {
    const st = account(scalarLot({ dividendYield: 0.04 }));
    const g = computeHoldingsGrowth({ state: st, stateKey: 'acct', fallbackRate: 0.1, fallbackRateKey: 'EQUITY_AU' });
    const d = computeHoldingsDividends({ state: st, stateKey: 'acct', fallbackYield: 0.04, fallbackRateKey: 'EQUITY_AU' });
    assert.equal(g.holdingActions[0].holdingId, d.holdingActions[0].holdingId);
    assert.equal(g.holdingActions[0].costBasisDelta, d.holdingActions[0].costBasisDelta);
  });
});

describe('design 94 §9.4 — the kind survives serialization and the payload manifest', () => {

  test('toJSON omits the default and emits the exception', () => {
    const priced = new HoldingTransactAction({ stateKey: 'a', holdingId: 'h', marketValueDelta: 1 }).toJSON();
    assert.ok(!('valueKind' in priced),
      'an explicit PRICE on every action would add a field to every fixture in the repo');
    const united = new HoldingTransactAction({
      stateKey: 'a', holdingId: 'h', marketValueDelta: 1, valueKind: VALUE_KIND.UNITS }).toJSON();
    assert.equal(united.valueKind, VALUE_KIND.UNITS);
  });

  test('fromJSON restores it, and an absent field reads as PRICE', () => {
    const round = HoldingTransactAction.fromJSON({
      stateKey: 'a', holdingId: 'h', marketValueDelta: 1, valueKind: VALUE_KIND.UNITS });
    assert.equal(round.valueKind, VALUE_KIND.UNITS);
    const legacy = HoldingTransactAction.fromJSON({ stateKey: 'a', holdingId: 'h', marketValueDelta: 1 });
    assert.ok(legacy.valueKind == null, 'a payload written before this field still means PRICE');
  });

  test('the payload manifest carries it — an undeclared field is dropped SILENTLY', () => {
    const registry = new TypeRegistry();
    registerHoldingActionTypes(registry);
    const payload = registry.pickPayload(new HoldingTransactAction({
      stateKey: 'a', holdingId: 'h', marketValueDelta: 1, valueKind: VALUE_KIND.UNITS }));
    assert.equal(payload.valueKind, VALUE_KIND.UNITS,
      '`pickPayload` copies only the fields the manifest names — this is the drift class design 91 closed');
  });
});
