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
 * pool-graph-generator.test.mjs — design 97 §18.3, step 2.
 *
 * `scripts/lib/pool-graph.mjs` turns a five-number spec into a whole `liquidityGraph` so a
 * study can sweep pool SHAPES as arm values. Two properties carry the whole file:
 *
 *   · **every generated graph normalizes.** The generator is upstream of the engine's own
 *     validation, so a shape it can emit and `normalizeLiquidityGraph` rejects is a study
 *     that dies mid-grid — or worse, one whose author edits the generator until it stops
 *     complaining. PG-8 runs every shape through the real normalizer.
 *   · **every sleeve is claimed exactly once.** Design 97 §3.1: what a sequence does not
 *     claim keeps its own `drawdownPriority`, so an unclaimed EQUITY sleeve can be spent
 *     ahead of a pool that was supposed to come first — "the arm would still run, and would
 *     quietly not be the arm". PG-3 asserts it across every shape, which is the difference
 *     between a rule in a comment and a rule.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildPoolGraph, classifyAccounts, POOL_KIND, REFILL, SHAPES,
         withWrappersAt, WRAPPER_PLACEMENTS } from '../../scripts/lib/pool-graph.mjs';
import { normalizeLiquidityGraph, compileToDrawdownSequence }
  from '../../src/finance/pools/liquidity-graph.js';

/** A plan with two of everything, because a one-account plan hides every ordering bug. */
const ACCOUNTS = [
  { stateKey: 'usSavings',   type: 'checking' },
  { stateKey: 'auSavings',   type: 'savings' },
  { stateKey: 'usBrokerage', type: 'brokerage' },
  { stateKey: 'auBrokerage', type: 'brokerage' },
  { stateKey: 'auOffset',    type: 'offset', offsetsPropertyKey: 'auHouse' },
  // Claimed by nothing UNLESS the order names a wrappers pool — and "unclaimed" is not mild:
  // §3.1 rule 3 draws such an account after every pool, so a plan whose pools never run dry
  // never spends it (PG-16).
  { stateKey: 'iraAccount',   type: 'ira' },
  { stateKey: 'superAccount', type: 'super' },
];
const CFG = { accounts: ACCOUNTS };

const SIZED = { cashYears: 1, bondYears: 4 };
const normalize = (g) => normalizeLiquidityGraph(g, ACCOUNTS, {});

test('PG-1: the pool-less arm is a POINT IN THE SAME SPACE, and it is null', () => {
  // Not a separate code path in the study: null is what leaves drawdownPriority untouched.
  assert.equal(buildPoolGraph(CFG, { order: SHAPES.POOL_LESS, ...SIZED }), null);
});

test('PG-2: the study\'s central arm compiles to cash → bonds → offset → equity', () => {
  const g = buildPoolGraph(CFG, { order: SHAPES.OFFSET_AFTER_BONDS, ...SIZED });
  const seq = compileToDrawdownSequence(normalize(g));

  // The order is the finding, so it is asserted as a whole rather than by spot check.
  assert.deepEqual(seq, [
    { key: 'usSavings',   sleeves: null },
    { key: 'auSavings',   sleeves: null },
    { key: 'usBrokerage', sleeves: ['CASH'] },
    { key: 'auBrokerage', sleeves: ['CASH'] },
    { key: 'usBrokerage', sleeves: ['BOND'] },
    { key: 'auBrokerage', sleeves: ['BOND'] },
    { key: 'auOffset',    sleeves: null },
    { key: 'usBrokerage', sleeves: ['EQUITY', 'GOLD'] },
    { key: 'auBrokerage', sleeves: ['EQUITY', 'GOLD'] },
  ]);
});

test('PG-3: every shape claims every sleeve of every brokerage it touches, exactly once', () => {
  for (const [name, order] of Object.entries(SHAPES)) {
    if (!order.length) continue;
    const g = normalize(buildPoolGraph(CFG, { order, ...SIZED }));

    for (const key of ['usBrokerage', 'auBrokerage']) {
      const claimed = g.pools.flatMap(p => p.claims.filter(c => c.key === key).flatMap(c => c.sleeves ?? []));
      assert.deepEqual([...claimed].sort(), ['BOND', 'CASH', 'EQUITY', 'GOLD'],
        `${name}: ${key} claims ${claimed.join(',')} — an unclaimed sleeve keeps its own `
        + 'drawdownPriority and can be spent ahead of the pool that should come first');
      assert.equal(new Set(claimed).size, claimed.length, `${name}: ${key} claims a sleeve twice`);
    }
  }
});

test('PG-4: a class no kind claims falls to the LAST pool in the spend order', () => {
  // CASH_ONLY names no buffer, so BOND has nowhere of its own to go. It joins growth —
  // which is the honest reading of "no bond bucket": bonds are just part of the book.
  const g = normalize(buildPoolGraph(CFG, { order: SHAPES.CASH_ONLY, cashYears: 1 }));
  const growth = g.pools.find(p => p.id === POOL_KIND.GROWTH);

  assert.deepEqual([...growth.claims.find(c => c.key === 'usBrokerage').sleeves].sort(),
    ['BOND', 'EQUITY', 'GOLD']);
  assert.equal(growth.target, null, 'the residual pool must stay unsized');
});

test('PG-5: a TARGETED pool that would absorb the residual throws, naming the spec field', () => {
  // [cash, buffer] leaves EQUITY and GOLD unclaimed, and buffer is last — so the reserve
  // would silently become the whole book while still calling itself "4 years".
  assert.throws(
    () => buildPoolGraph(CFG, { order: [POOL_KIND.CASH, POOL_KIND.BUFFER], ...SIZED }),
    /no unique split across classes/,
  );
});

test('PG-6: cash accounts with no cash pool throw — unclaimed means LAST, not first', () => {
  assert.throws(
    () => buildPoolGraph(CFG, { order: [POOL_KIND.BUFFER, POOL_KIND.GROWTH], bondYears: 4 }),
    /Unclaimed accounts are drawn AFTER every pool/,
  );
});

test('PG-7: a pool the plan cannot fill throws rather than reporting an empty reserve', () => {
  const noOffset = { accounts: ACCOUNTS.filter(a => a.type !== 'offset') };
  assert.throws(
    () => buildPoolGraph(noOffset, { order: SHAPES.OFFSET_AFTER_BONDS, ...SIZED }),
    /would claim nothing/,
  );
});

test('PG-8: every shape × refill the study sweeps survives the real normalizer', () => {
  for (const [name, order] of Object.entries(SHAPES)) {
    if (!order.length) continue;
    for (const refill of Object.values(REFILL)) {
      for (const bondYears of [null, 0, 4]) {
        const g = buildPoolGraph(CFG, { order, cashYears: 1, bondYears, refill });
        assert.doesNotThrow(() => normalize(g), `${name} / ${refill} / bondYears=${bondYears}`);
      }
    }
  }
});

describe('the cascade', () => {
  const flowsFor = (order, spec) =>
    Object.fromEntries(buildPoolGraph(CFG, { order, ...SIZED, ...spec }).flows.map(f => [f.id, f]));

  test('PG-9: the offset is a SECOND source into cash, tried after the reserve', () => {
    const f = flowsFor(SHAPES.OFFSET_AFTER_BONDS, { refill: REFILL.CASCADE });
    // The thing §1 says a list cannot express, and the reason a pool is a node.
    assert.equal(f['buffer-to-cash'].to, POOL_KIND.CASH);
    assert.equal(f['offset-to-cash'].to, POOL_KIND.CASH);
    assert.ok(f['offset-to-cash'].priority > f['buffer-to-cash'].priority,
      'the backstop must be tried only after the reserve could not fill the pool');
  });

  test('PG-10: trigger and target are two numbers — the (s, S) band, not a drift band', () => {
    const f = flowsFor(SHAPES.OFFSET_AFTER_BONDS, { refill: REFILL.CASCADE, refillTriggerYears: 0.5 });
    const g = buildPoolGraph(CFG, { order: SHAPES.OFFSET_AFTER_BONDS, ...SIZED, refill: REFILL.CASCADE });
    const cash = g.pools.find(p => p.id === POOL_KIND.CASH);

    assert.equal(f['buffer-to-cash'].trigger.below.value, 0.5);   // s
    assert.equal(cash.target.value, 1);                            // S
    assert.notEqual(f['buffer-to-cash'].trigger.below.value, cash.target.value,
      'conflating the trigger with the fill target is what makes a band churn (§12.3)');
  });

  test('PG-11: the harvest gate is the RETURN gate, and only under CASCADE_HARVEST', () => {
    // §16.1b: a trailing-high gate cannot tell a falling market from a pool being spent
    // down, and latches shut forever after the first crash. The generator can only emit
    // the gate that survived that finding.
    assert.equal(flowsFor(SHAPES.CASH_BOND, { refill: REFILL.CASCADE })['growth-to-buffer'].gate,
      undefined);
    const gated = flowsFor(SHAPES.CASH_BOND, { refill: REFILL.CASCADE_HARVEST })['growth-to-buffer'];
    assert.deepEqual(gated.gate, { sourceReturnOver: 0 });
  });

  test('PG-12: no edge is emitted into a pool with no target — it would move nothing, forever', () => {
    const f = flowsFor(SHAPES.CASH_BOND, { refill: REFILL.CASCADE, bondYears: null });
    assert.equal(f['growth-to-buffer'], undefined);
    assert.ok(f['buffer-to-cash'], 'the cash pool is still targeted, so its refill stands');
  });

  test('PG-13: REFILL.NONE authors the topology without the behaviour', () => {
    const g = buildPoolGraph(CFG, { order: SHAPES.OFFSET_AFTER_BONDS, ...SIZED, refill: REFILL.NONE });
    assert.deepEqual(g.flows, []);
    assert.equal(g.pools.length, 4, 'the pools, their sizes and the spend order all survive');
  });
});

test('PG-14: OFFSET_CAP is claimed only when the facility links to a loan', () => {
  const capped = buildPoolGraph(CFG, { order: SHAPES.OFFSET_AFTER_BONDS, ...SIZED });
  assert.deepEqual(capped.pools.find(p => p.id === POOL_KIND.OFFSET).capacity, { mode: 'OFFSET_CAP' });

  // Unlinked, the normalizer throws (no loan to cap against), so the generator must not ask
  // for a cap it cannot substantiate — an offset reporting its BALANCE as its capacity is the
  // exact illusion §12.1 exists to remove.
  const unlinkedAccts = ACCOUNTS.map(a => (a.type === 'offset' ? { ...a, offsetsPropertyKey: null } : a));
  const g = buildPoolGraph({ accounts: unlinkedAccts }, { order: SHAPES.OFFSET_AFTER_BONDS, ...SIZED });
  assert.equal(g.pools.find(p => p.id === POOL_KIND.OFFSET).capacity, undefined);
  assert.doesNotThrow(() => normalizeLiquidityGraph(g, unlinkedAccts, {}));
});

describe('the wrappers pool', () => {
  test('PG-16: omitted, the wrappers are claimed by nothing — the silent "never spent" case', () => {
    const g = normalize(buildPoolGraph(CFG, { order: SHAPES.OFFSET_AFTER_BONDS, ...SIZED }));
    const claimed = new Set(g.pools.flatMap(p => p.claims.map(c => c.key)));
    assert.ok(!claimed.has('iraAccount') && !claimed.has('superAccount'));
  });

  test('PG-17: every placement claims them WHOLE and changes only the spend order', () => {
    const base = normalize(buildPoolGraph(CFG, { order: SHAPES.OFFSET_AFTER_BONDS, ...SIZED }));
    for (const at of WRAPPER_PLACEMENTS.filter(Boolean)) {
      const order = withWrappersAt(SHAPES.OFFSET_AFTER_BONDS, at);
      const g = normalize(buildPoolGraph(CFG, { order, ...SIZED }));
      const w = g.pools.find(p => p.id === POOL_KIND.WRAPPERS);

      assert.ok(w, `${at}: no wrappers pool`);
      assert.deepEqual(w.claims.map(c => c.key).sort(), ['iraAccount', 'superAccount']);
      // Whole-account, never sleeve-narrowed: sleeves only mean something on a brokerage draw.
      assert.ok(w.claims.every(c => c.sleeves == null), `${at}: sleeve-narrowed a wrapper`);
      // No target, no capacity rule — so it moves the ORDER and nothing else, which is what
      // makes it a clean axis rather than a second allocation lever.
      assert.equal(w.target, null);
      assert.equal(w.capacity.mode, 'BALANCE');

      // …and every other pool is untouched by the placement.
      for (const p of base.pools) {
        assert.deepEqual(g.pools.find(q => q.id === p.id).claims, p.claims, `${at}: ${p.id} moved`);
      }
    }
  });

  test('PG-18: the placement is the ORDER, and each position is distinct', () => {
    const seqs = new Map();
    for (const at of WRAPPER_PLACEMENTS) {
      const order = withWrappersAt(SHAPES.OFFSET_AFTER_BONDS, at);
      seqs.set(String(at), compileToDrawdownSequence(normalize(buildPoolGraph(CFG, { order, ...SIZED }))));
    }
    // `first` really is first, `last` really is last.
    assert.equal(seqs.get('first')[0].key, 'iraAccount');
    assert.equal(seqs.get('last').at(-1).key, 'superAccount');
    // No two placements compile to the same walk — an axis whose points coincide is not an axis.
    const seen = new Set();
    for (const [at, seq] of seqs) {
      const sig = JSON.stringify(seq);
      assert.ok(!seen.has(sig), `${at} compiles to a walk another placement already produced`);
      seen.add(sig);
    }
  });

  test('PG-19: the residual lands on a SLEEVE-CAPABLE pool, not on whatever is last', () => {
    // wrappers last + no buffer: BOND has nowhere named. Handing it to the wrappers pool would
    // be a sleeve narrowing on a non-brokerage — rejected by the normalizer, with a message
    // about a claim the author never wrote.
    const order = withWrappersAt(SHAPES.CASH_ONLY, 'last');
    const g = normalize(buildPoolGraph(CFG, { order, cashYears: 1 }));
    const growth = g.pools.find(p => p.id === POOL_KIND.GROWTH);
    assert.deepEqual([...growth.claims.find(c => c.key === 'usBrokerage').sleeves].sort(),
      ['BOND', 'EQUITY', 'GOLD']);
    assert.ok(g.pools.find(p => p.id === POOL_KIND.WRAPPERS).claims.every(c => c.sleeves == null));
  });

  test('PG-20: an order with no sleeve-capable pool throws, naming what has nowhere to go', () => {
    // No cash accounts, so the cash-pool rule does not fire first and this case is reachable.
    const noCash = { accounts: ACCOUNTS.filter(a => !['checking', 'savings'].includes(a.type)) };
    assert.throws(
      () => buildPoolGraph(noCash, { order: [POOL_KIND.OFFSET, POOL_KIND.WRAPPERS] }),
      /names no pool that can hold/,
    );
  });

  test('PG-20b: a targeted pool absorbing the residual still throws — and says WHY it absorbed it', () => {
    // `[cash, wrappers]` puts the residual on cash, because the wrappers pool cannot hold
    // sleeves. The message must not claim cash is last in the order; it is last among the
    // pools that can carry a narrowing, which is a different sentence.
    assert.throws(
      () => buildPoolGraph(CFG, { order: [POOL_KIND.CASH, POOL_KIND.WRAPPERS], cashYears: 1 }),
      /LAST pool in `order` that can hold sleeves/,
    );
  });

  test('PG-21: a plan with no wrappers cannot author the pool', () => {
    const noWrappers = { accounts: ACCOUNTS.filter(a => !['ira', 'super'].includes(a.type)) };
    assert.throws(
      () => buildPoolGraph(noWrappers, { order: withWrappersAt(SHAPES.CASH_BOND, 'last'), ...SIZED }),
      /would claim nothing/,
    );
  });

  test('PG-22: an unknown placement throws rather than silently doing nothing', () => {
    assert.throws(() => withWrappersAt(SHAPES.CASH_BOND, 'middle'), /unknown position/);
    // null is a POINT on the axis — "never claimed" — not an omission.
    assert.deepEqual(withWrappersAt(SHAPES.CASH_BOND, null), SHAPES.CASH_BOND);
  });
});

test('PG-15b: `exclude` drops a book from the pools — which puts it LAST, not out of reach', () => {
  const g = normalize(buildPoolGraph(CFG, {
    order: SHAPES.OFFSET_AFTER_BONDS, ...SIZED, exclude: ['auBrokerage'],
  }));
  const claimed = new Set(g.pools.flatMap(p => p.claims.map(c => c.key)));

  assert.ok(!claimed.has('auBrokerage'));
  assert.ok(claimed.has('usBrokerage'), 'the rest of the book is untouched');
  // The distinction the doc comment insists on: excluded is not ring-fenced. It keeps its
  // drawdownPriority, so the sequence's remainder still reaches it after every pool.
  assert.ok(!compileToDrawdownSequence(g).some(e => e.key === 'auBrokerage'));
});

test('PG-15: classifyAccounts sorts every spendable account into a bucket a pool can claim', () => {
  const { cash, brokerage, offset, wrappers } = classifyAccounts(CFG);
  assert.deepEqual(cash.map(a => a.stateKey),      ['usSavings', 'auSavings']);
  assert.deepEqual(brokerage.map(a => a.stateKey), ['usBrokerage', 'auBrokerage']);
  assert.deepEqual(offset.map(a => a.stateKey),    ['auOffset']);
  // The wrappers get a bucket of their own so a study can PLACE them. Leaving them to the
  // remainder is what made "never spent" the silent default (PG-16).
  assert.deepEqual(wrappers.map(a => a.stateKey),  ['iraAccount', 'superAccount']);
});
