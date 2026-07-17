/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Holding }    from '../../src/finance/holdings/holding.js';
import { ALLOCATION } from '../../src/finance/holdings/allocation.js';
import { consumeHoldings, consumeHoldingsFifo } from '../../src/finance/holdings/holdings-fifo.js';
import { SLEEVE_ORDER, LOT_STRATEGY, buildHoldingsComparator,
         resolveDrawdownSelection, withRebalanceCoupling } from '../../src/finance/holdings/holdings-selection.js';

const RATE = 'EQUITY_US';
const D    = (y, m = 0, d = 1) => new Date(Date.UTC(y, m, d));

function holding({ id, mv, basis, date, alloc = ALLOCATION.EQUITY }) {
  return new Holding({
    id, allocation: alloc, marketValue: mv, costBasis: basis,
    purchaseDate: date, rateKey: RATE,
  });
}

/** A mixed-sleeve brokerage: appreciated equity, cash (no gain), bond, gold. */
function mixedSleeves() {
  return [
    holding({ id: 'eq',   mv: 1000, basis: 200, date: D(2015), alloc: ALLOCATION.EQUITY }), // big gain
    holding({ id: 'cash', mv: 1000, basis: 1000, date: D(2020), alloc: ALLOCATION.CASH }),  // no gain
    holding({ id: 'bond', mv: 1000, basis: 900,  date: D(2018), alloc: ALLOCATION.BOND }),  // small gain
    holding({ id: 'gold', mv: 1000, basis: 300,  date: D(2016), alloc: ALLOCATION.GOLD }),  // big gain
  ];
}

// ─── Back-compat: consumeHoldings with no selection === FIFO ──────────────────

test('consumeHoldings without selection is identical to consumeHoldingsFifo', () => {
  const a = consumeHoldings(mixedSleeves(), 1500);
  const b = consumeHoldingsFifo(mixedSleeves(), 1500);
  assert.deepEqual(a, b);
});

test('consumeHoldings selection:null walks purchaseDate ascending (oldest = eq 2015)', () => {
  // Oldest lot is eq (2015). FIFO sells it first ⇒ realizes its large gain.
  const r = consumeHoldings(mixedSleeves(), 1000, { selection: null });
  assert.equal(r.consumed, 1000);
  assert.equal(r.realizedBasis, 200); // the whole equity lot (basis 200) consumed
});

// ─── Lever A — sleeve order ──────────────────────────────────────────────────

test('Lever A TAX_COST sells CASH before EQUITY — lower realized gain', () => {
  const r = consumeHoldings(mixedSleeves(), 1000, {
    selection: { sleeveOrder: SLEEVE_ORDER.TAX_COST, lotStrategy: LOT_STRATEGY.FIFO },
  });
  assert.equal(r.consumed, 1000);
  // CASH sleeve consumed fully: basis 1000, so zero realized gain.
  assert.equal(r.realizedBasis, 1000);
  // The equity lot survives untouched.
  const eq = r.newHoldings.find(h => h.id === 'eq');
  assert.ok(eq && eq.marketValue === 1000);
});

test('Lever A TAX_COST vs FIFO: same cash raised, strictly less gain realized', () => {
  const amount = 1500;
  const fifo    = consumeHoldings(mixedSleeves(), amount);
  const taxCost = consumeHoldings(mixedSleeves(), amount, {
    selection: { sleeveOrder: SLEEVE_ORDER.TAX_COST, lotStrategy: LOT_STRATEGY.FIFO },
  });
  const gainFifo    = fifo.consumed    - fifo.realizedBasis;
  const gainTaxCost = taxCost.consumed - taxCost.realizedBasis;
  assert.equal(fifo.consumed, taxCost.consumed);           // same cash
  assert.ok(gainTaxCost < gainFifo, `${gainTaxCost} < ${gainFifo}`); // less gain
});

test('Lever A order runs CASH → BOND → EQUITY → GOLD across the whole account', () => {
  // Raise 2500: consumes CASH(1000) + BOND(1000) fully, then 500 of EQUITY.
  const r = consumeHoldings(mixedSleeves(), 2500, {
    selection: { sleeveOrder: SLEEVE_ORDER.TAX_COST, lotStrategy: LOT_STRATEGY.FIFO },
  });
  assert.equal(r.consumed, 2500);
  const eq   = r.newHoldings.find(h => h.id === 'eq');
  const gold = r.newHoldings.find(h => h.id === 'gold');
  assert.ok(eq && eq.marketValue === 500);   // half the equity lot left
  assert.ok(gold && gold.marketValue === 1000); // gold untouched (sold last)
  assert.ok(!r.newHoldings.find(h => h.id === 'cash')); // cash gone
  assert.ok(!r.newHoldings.find(h => h.id === 'bond')); // bond gone
});

test('Lever A PRESERVE_GROWTH sells GOLD before EQUITY', () => {
  // Raise 2500: CASH + BOND + 500 GOLD; equity untouched.
  const r = consumeHoldings(mixedSleeves(), 2500, {
    selection: { sleeveOrder: SLEEVE_ORDER.PRESERVE_GROWTH, lotStrategy: LOT_STRATEGY.FIFO },
  });
  const eq   = r.newHoldings.find(h => h.id === 'eq');
  const gold = r.newHoldings.find(h => h.id === 'gold');
  assert.ok(eq && eq.marketValue === 1000);  // equity fully preserved
  assert.ok(gold && gold.marketValue === 500); // gold half-sold
});

// ─── Lever B — lot strategy (within a sleeve) ────────────────────────────────

/** Three equity lots, same sleeve, different basis and dates. */
function equityLots() {
  return [
    holding({ id: 'lo',   mv: 1000, basis: 200,  date: D(2015) }), // big gain, oldest
    holding({ id: 'hi',   mv: 1000, basis: 950,  date: D(2022) }), // tiny gain, newest
    holding({ id: 'loss', mv: 1000, basis: 1200, date: D(2021) }), // at a loss
  ];
}

test('Lever B FIFO realizes the oldest lot (biggest gain)', () => {
  const r = consumeHoldings(equityLots(), 1000, {
    selection: { lotStrategy: LOT_STRATEGY.FIFO },
  });
  assert.equal(r.realizedBasis, 200); // 'lo' lot
});

test('Lever B HIFO realizes the highest-basis lot first (least gain)', () => {
  const r = consumeHoldings(equityLots(), 1000, {
    selection: { lotStrategy: LOT_STRATEGY.HIFO },
  });
  // Highest basis-ratio is the loss lot (1200/1000 = 1.2), consumed first.
  assert.equal(r.realizedBasis, 1200);
});

test('Lever B HIFO realizes a smaller gain than FIFO on the same cash', () => {
  const fifo = consumeHoldings(equityLots(), 1000, { selection: { lotStrategy: LOT_STRATEGY.FIFO } });
  const hifo = consumeHoldings(equityLots(), 1000, { selection: { lotStrategy: LOT_STRATEGY.HIFO } });
  const gainFifo = fifo.consumed - fifo.realizedBasis;
  const gainHifo = hifo.consumed - hifo.realizedBasis;
  assert.ok(gainHifo < gainFifo, `${gainHifo} < ${gainFifo}`);
});

test('Lever B LOSS_FIRST realizes the loss lot first', () => {
  const r = consumeHoldings(equityLots(), 1000, {
    selection: { lotStrategy: LOT_STRATEGY.LOSS_FIRST },
  });
  // 'loss' lot: gain = 1000 - 1200 = -200 (only lot at a loss), sold first.
  assert.equal(r.realizedBasis, 1200);
  assert.ok(r.consumed - r.realizedBasis < 0); // realized a loss
});

test('Lever B SPECIFIC behaves as MIN_GAIN today (HIFO proxy)', () => {
  const specific = consumeHoldings(equityLots(), 1000, { selection: { lotStrategy: LOT_STRATEGY.SPECIFIC } });
  const hifo     = consumeHoldings(equityLots(), 1000, { selection: { lotStrategy: LOT_STRATEGY.HIFO } });
  assert.deepEqual(specific, hifo);
});

// ─── Lever A + B compose; value conservation invariant ───────────────────────

test('sleeve order dominates, lot strategy breaks ties within a sleeve', () => {
  const holdings = [
    holding({ id: 'eqA', mv: 500, basis: 100, date: D(2015), alloc: ALLOCATION.EQUITY }),
    holding({ id: 'eqB', mv: 500, basis: 480, date: D(2019), alloc: ALLOCATION.EQUITY }),
    holding({ id: 'cash', mv: 500, basis: 500, date: D(2020), alloc: ALLOCATION.CASH }),
  ];
  // TAX_COST → CASH first (500), then within EQUITY, HIFO picks eqB (basis 480).
  const r = consumeHoldings(holdings, 1000, {
    selection: { sleeveOrder: SLEEVE_ORDER.TAX_COST, lotStrategy: LOT_STRATEGY.HIFO },
  });
  assert.equal(r.consumed, 1000);
  assert.equal(r.realizedBasis, 500 + 480); // cash (500) + eqB (480)
  assert.ok(r.newHoldings.find(h => h.id === 'eqA')); // eqA (low basis) preserved
});

test('value is conserved under every selection policy (Σ consumed + Σ remaining = Σ start)', () => {
  const start = mixedSleeves().reduce((s, h) => s + h.marketValue, 0);
  for (const sel of [
    null,
    { sleeveOrder: SLEEVE_ORDER.TAX_COST, lotStrategy: LOT_STRATEGY.FIFO },
    { sleeveOrder: SLEEVE_ORDER.PRESERVE_GROWTH, lotStrategy: LOT_STRATEGY.HIFO },
    { lotStrategy: LOT_STRATEGY.LOSS_FIRST },
    { sleeveWeights: { CASH: 0, BOND: 1, EQUITY: 2, GOLD: 3 } },
  ]) {
    const r = consumeHoldings(mixedSleeves(), 2200, { selection: sel });
    const remaining = r.newHoldings.reduce((s, h) => s + (h.marketValue ?? 0), 0);
    assert.ok(Math.abs((r.consumed + remaining) - start) < 0.01, `policy ${JSON.stringify(sel)}`);
  }
});

// ─── Lever A — WEIGHTED (optimizable) ────────────────────────────────────────

test('Lever A sleeveWeights: ascending weight = sold first', () => {
  // Weights put GOLD first (0) then CASH (1); raise 1500 ⇒ GOLD(1000) + CASH(500).
  const r = consumeHoldings(mixedSleeves(), 1500, {
    selection: { sleeveWeights: { GOLD: 0, CASH: 1, BOND: 2, EQUITY: 3 }, lotStrategy: LOT_STRATEGY.FIFO },
  });
  assert.ok(!r.newHoldings.find(h => h.id === 'gold')); // gold sold first
  const cash = r.newHoldings.find(h => h.id === 'cash');
  assert.ok(cash && cash.marketValue === 500);
});

// ─── Comparator unit ─────────────────────────────────────────────────────────

test('buildHoldingsComparator(null) is pure purchaseDate ascending', () => {
  const cmp = buildHoldingsComparator(null);
  const a = holding({ id: 'a', mv: 1, basis: 1, date: D(2010) });
  const b = holding({ id: 'b', mv: 1, basis: 1, date: D(2020) });
  assert.ok(cmp(a, b) < 0);
  assert.ok(cmp(b, a) > 0);
});

// ─── resolveDrawdownSelection — null short-circuit + rebalance flag ────────────

test('resolveDrawdownSelection: FIFO/FIFO with no coupling ⇒ null (byte-identical)', () => {
  assert.equal(resolveDrawdownSelection({ sleeveOrderMode: 'FIFO', lotStrategy: 'FIFO' }), null);
  assert.equal(resolveDrawdownSelection({}), null);
});

test('resolveDrawdownSelection: coupling weight forces a non-null policy even under FIFO', () => {
  const sel = resolveDrawdownSelection({ sleeveOrderMode: 'FIFO', lotStrategy: 'FIFO', rebalanceWeight: 1 });
  assert.ok(sel);
  assert.equal(sel.rebalanceWeight, 1);
  assert.equal(sel.lotStrategy, 'FIFO');
});

// ─── Lever C — withRebalanceCoupling ──────────────────────────────────────────

/** An account 70/30 EQUITY/BOND against a 60/40 target ⇒ EQUITY is over-weight. */
function overweightEquityAccount() {
  return {
    targetComposition: { EQUITY: 0.6, BOND: 0.4 },
    holdings: [
      holding({ id: 'eq',   mv: 7000, basis: 3000, date: D(2015), alloc: ALLOCATION.EQUITY }),
      holding({ id: 'bond', mv: 3000, basis: 2900, date: D(2018), alloc: ALLOCATION.BOND }),
    ],
  };
}

test('withRebalanceCoupling: no-op when coupling off / no target / empty', () => {
  const acct = overweightEquityAccount();
  const base = resolveDrawdownSelection({ sleeveOrderMode: 'TAX_COST', lotStrategy: 'FIFO' }); // no rebalanceWeight
  assert.equal(withRebalanceCoupling(base, acct), base);            // coupling off ⇒ unchanged
  const coupled = resolveDrawdownSelection({ rebalanceWeight: 1 });
  assert.equal(withRebalanceCoupling(coupled, { holdings: [] }), coupled);          // no target ⇒ unchanged
  assert.equal(withRebalanceCoupling(coupled, { targetComposition: {}, holdings: [] }), coupled);
  assert.equal(withRebalanceCoupling(null, acct), null);
});

test('withRebalanceCoupling: over-weight sleeve is sold first (score lower)', () => {
  const acct = overweightEquityAccount();
  const sel  = withRebalanceCoupling(resolveDrawdownSelection({ rebalanceWeight: 1 }), acct);
  assert.equal(typeof sel.sleeveScore, 'function');
  // EQUITY over-weight (+0.1) ⇒ lower score; BOND under-weight (−0.1) ⇒ higher.
  assert.ok(sel.sleeveScore(ALLOCATION.EQUITY) < sel.sleeveScore(ALLOCATION.BOND));
  // Consume 1000: it drains the over-weight EQUITY sleeve, leaving BOND intact.
  const r = consumeHoldings(acct.holdings, 1000, { selection: sel });
  assert.equal(r.newHoldings.find(h => h.id === 'bond').marketValue, 3000);
  assert.equal(r.newHoldings.find(h => h.id === 'eq').marketValue, 6000);
});

test('withRebalanceCoupling: selling the over-weight sleeve moves the mix toward target', () => {
  const acct = overweightEquityAccount(); // 7000/3000 = 70/30
  const sel  = withRebalanceCoupling(resolveDrawdownSelection({ rebalanceWeight: 1 }), acct);
  const r = consumeHoldings(acct.holdings, 1000, { selection: sel });
  const eq   = r.newHoldings.find(h => h.id === 'eq').marketValue;
  const bond = r.newHoldings.find(h => h.id === 'bond').marketValue;
  const eqFrac = eq / (eq + bond);
  assert.ok(eqFrac < 0.70, `equity fraction ${eqFrac} should fall toward the 0.60 target`);
});
