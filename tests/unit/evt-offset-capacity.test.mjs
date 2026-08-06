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
 * evt-offset-capacity.test.mjs — design 86 G4, offset capacity.
 *
 * An offset only suppresses interest up to the linked loan's balance. Everything above
 * that earns NOTHING — not interest (no handler is wired to the offset roles) and not
 * a loan-rate saving. Nothing surfaced that surplus, which made an over-funded offset
 * look identical to a correctly sized one in every report, while a P&I loan quietly
 * amortized its own offset into irrelevance.
 *
 *   OFFCAP-1: split at the loan balance — applied + idle = the offset.
 *   OFFCAP-2: an over-funded offset reports the excess as idle.
 *   OFFCAP-3: no loan, or a paid-off loan, ⇒ the whole offset is idle.
 *   OFFCAP-4: the property-keyed join matches the one that decides interest —
 *             other properties and other currencies do not absorb capacity.
 *   OFFCAP-5: multiple offsets on one property sum.
 *   OFFCAP-6: FX-converted to the base currency, like every other wealth metric.
 *   OFFCAP-7: inert for a plan with no offsets.
 *   OFFCAP-8: end-to-end — a P&I loan drives its own offset idle over time.
 *
 * Run with: node --test tests/unit/evt-offset-capacity.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { USD, AUD } from '../../src/finance/assets/account.js';
import { computeOffsetCapacity, deriveOffsetCapacity }
  from '../../src/finance/derived-metrics/offset-capacity.js';
import { effectivePrincipal } from '../../src/finance/account-rules/loan-classes.js';

const loan = (o = {}) => ({
  type: 'loan', stateKey: 'hLoan', balance: 300_000, linkedPropertyKey: 'h',
  currency: USD, ...o,
});
const offset = (o = {}) => ({
  type: 'offset', stateKey: 'off', balance: 100_000, offsetsPropertyKey: 'h',
  currency: USD, ...o,
});

describe('offset capacity', () => {
  test('OFFCAP-1: splits at the loan balance; the parts sum to the offset', () => {
    const { idle, applied } = computeOffsetCapacity({ hLoan: loan(), off: offset() });
    assert.equal(applied, 100_000);
    assert.equal(idle, 0);
    assert.equal(applied + idle, 100_000);
  });

  test('OFFCAP-2: an over-funded offset reports the excess as idle', () => {
    const { idle, applied } = computeOffsetCapacity({
      hLoan: loan({ balance: 300_000 }), off: offset({ balance: 500_000 }),
    });
    assert.equal(applied, 300_000);
    assert.equal(idle, 200_000, 'A$200k neither invested nor offsetting');
  });

  test('OFFCAP-3: no loan, or a paid-off loan, makes the whole offset idle', () => {
    assert.deepEqual(computeOffsetCapacity({ off: offset() }), { idle: 100_000, applied: 0 });
    assert.deepEqual(computeOffsetCapacity({ hLoan: loan({ balance: 0 }), off: offset() }),
                     { idle: 100_000, applied: 0 });
  });

  test('OFFCAP-4: the join matches the one that decides interest', () => {
    // Same guards as offsetBalanceForLoan: wrong property, or wrong currency, and the
    // offset does not suppress principal — so it must not be reported as applied either.
    const other = { hLoan: loan(), off: offset({ offsetsPropertyKey: 'elsewhere' }) };
    assert.deepEqual(computeOffsetCapacity(other), { idle: 100_000, applied: 0 });
    assert.equal(effectivePrincipal(other, 'hLoan', other.hLoan), 300_000,
      'and the engine agrees it suppresses nothing');

    const ccy = { hLoan: loan(), off: offset({ currency: AUD }) };
    const capacity = computeOffsetCapacity(ccy, 'AUD');
    assert.equal(capacity.applied, 0, 'a cross-currency offset is ignored by the interest calc');
    assert.equal(effectivePrincipal(ccy, 'hLoan', ccy.hLoan), 300_000);
  });

  test('OFFCAP-5: multiple offsets on one property sum', () => {
    const state = {
      hLoan: loan({ balance: 250_000 }),
      o1: offset({ stateKey: 'o1', balance: 150_000 }),
      o2: offset({ stateKey: 'o2', balance: 200_000 }),
    };
    const { idle, applied } = computeOffsetCapacity(state);
    assert.equal(applied, 250_000);
    assert.equal(idle, 100_000);
    // The engine clamps the same way.
    assert.equal(effectivePrincipal(state, 'hLoan', state.hLoan), 0);
  });

  test('OFFCAP-6: FX-converts to the base currency', () => {
    const state = {
      effectiveExchangeRates: { USD_AUD: 1.5 },
      hLoan: loan({ balance: 100_000, currency: AUD }),
      off:   offset({ balance: 400_000, currency: AUD }),
    };
    const { idle, applied } = computeOffsetCapacity(state, 'USD');
    assert.ok(Math.abs(applied - 100_000 / 1.5) < 0.01, `applied ${applied}`);
    assert.ok(Math.abs(idle    - 300_000 / 1.5) < 0.01, `idle ${idle}`);
  });

  test('OFFCAP-7: inert for a plan with no offsets', () => {
    const state = { hLoan: loan(), cash: { type: 'savings', balance: 50_000, currency: USD } };
    assert.deepEqual(computeOffsetCapacity(state), { idle: 0, applied: 0 });
    deriveOffsetCapacity(state, 'USD');
    assert.equal(state.metrics.offsetIdleCapacity, 0);
    assert.equal(state.metrics.offsetAppliedCapacity, 0);
  });

  test('OFFCAP-8: a P&I loan drives its own offset idle as it amortizes', () => {
    // The slow leak this metric exists to show: the offset balance never moves and net
    // worth looks healthy, while the share of it doing any work falls to zero.
    const shrinking = [300_000, 200_000, 100_000, 0].map(b =>
      computeOffsetCapacity({ hLoan: loan({ balance: b }), off: offset({ balance: 300_000 }) }));
    assert.deepEqual(shrinking.map(c => c.applied), [300_000, 200_000, 100_000, 0]);
    assert.deepEqual(shrinking.map(c => c.idle),    [0, 100_000, 200_000, 300_000]);
  });
});
