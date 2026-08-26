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
 * wage-splits.test.mjs — design 95 §6, phase 2.
 *
 * Direct deposit across several accounts. The properties that matter are not the
 * happy path (60/20/remainder is arithmetic) but the ones that decide whether a
 * routing decision can quietly lose money or overdraw an account:
 *
 *   - Σ(credited) === total, for EVERY input including the malformed ones;
 *   - a shortfall stops allocating rather than going negative;
 *   - an unresolvable destination falls back rather than vanishing;
 *   - a cross-currency destination is refused rather than silently converted;
 *   - and the no-split path returns null, so the emitted action is byte-identical
 *     to phase 1 and every existing scenario is untouched.
 *
 * Run with: node --test tests/unit/wage-splits.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { splitWage, creditPay, SPLIT_MODE, _resetSplitWarnings }
  from '../../src/finance/payroll/wage-splits.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USD = { code: 'USD', symbol: '$' };
const AUD = { code: 'AUD', symbol: '$' };

const STATE = {
  usSavingsAccount:  { balance: 1_000, currency: USD },
  spouseSavings:     { balance:     0, currency: USD },
  brokerageAccount:  { balance:     0, currency: USD },
  auSavingsAccount:  { balance:     0, currency: AUD },
  noCurrency:        { balance:     0 },
};

const FALLBACK = 'usSavingsAccount';
const opts = (over = {}) => ({ state: STATE, wageCurrency: 'USD',
                               personLabel: 'Test', ...over });

const pct   = (destinationKey, value) => ({ destinationKey, mode: SPLIT_MODE.PERCENT, value });
const fixed = (destinationKey, value) => ({ destinationKey, mode: SPLIT_MODE.FIXED,   value });

const sum = rows => +(rows ?? []).reduce((a, r) => a + r.amount, 0).toFixed(2);

// Warnings are one-per-session by design; reset so each test can assert on its own.
function quiet(fn) {
  _resetSplitWarnings();
  const warn = console.warn;
  const seen = [];
  console.warn = (...a) => seen.push(a.join(' '));
  try { return { result: fn(), warnings: seen }; }
  finally { console.warn = warn; }
}

// ─── The no-op path ───────────────────────────────────────────────────────────

test('WS-1 no splits ⇒ null, so the action shape is unchanged', () => {
  for (const empty of [null, undefined, []]) {
    assert.equal(splitWage(10_000, empty, FALLBACK, opts()), null);
  }
  // Zero or negative pay has nothing to allocate either.
  assert.equal(splitWage(0, [pct('spouseSavings', 0.5)], FALLBACK, opts()), null);
});

test('WS-2 a list that resolves to the fallback alone ⇒ null', () => {
  // 100% to the transaction account IS the un-split path. Returning a one-entry
  // split would emit a different action for identical behaviour, which would move
  // every golden for no reason.
  const r = splitWage(10_000, [pct(FALLBACK, 1.0)], FALLBACK, opts());
  assert.equal(r, null);
});

// ─── Allocation ───────────────────────────────────────────────────────────────

test('WS-3 PERCENT allocates on the total, remainder to the fallback', () => {
  const r = splitWage(10_000,
    [pct('spouseSavings', 0.20), pct('brokerageAccount', 0.30)], FALLBACK, opts());

  assert.deepEqual(r, [
    { targetKey: 'spouseSavings',    amount: 2_000 },
    { targetKey: 'brokerageAccount', amount: 3_000 },
    { targetKey: FALLBACK,           amount: 5_000 },
  ]);
});

test('WS-4 FIXED is taken first, then PERCENT of the ORIGINAL total', () => {
  const r = splitWage(10_000,
    [pct('spouseSavings', 0.20), fixed('brokerageAccount', 1_000)], FALLBACK, opts());

  // The percentage is 20% of 10,000 = 2,000 — NOT 20% of the 9,000 left after the
  // fixed transfer (which would be 1,800). "Put 20% in savings" means 20% of pay.
  const spouse = r.find(x => x.targetKey === 'spouseSavings');
  assert.equal(spouse.amount, 2_000, 'PERCENT is computed on the original total');
  assert.equal(r.find(x => x.targetKey === 'brokerageAccount').amount, 1_000);
  assert.equal(r.find(x => x.targetKey === FALLBACK).amount, 7_000);

  // …and FIXED really did run first: it appears before the percentage in the list.
  assert.equal(r[0].targetKey, 'brokerageAccount');
});

// ─── Conservation ─────────────────────────────────────────────────────────────

test('WS-5 CONSERVATION: Σ(credited) === total for every configuration', () => {
  const cases = [
    [pct('spouseSavings', 0.20), pct('brokerageAccount', 0.30)],
    [fixed('spouseSavings', 1_234.56)],
    [pct('spouseSavings', 1 / 3), pct('brokerageAccount', 1 / 3)],   // repeating decimals
    [fixed('spouseSavings', 9_999.99), pct('brokerageAccount', 0.5)],// shortfall
    [pct('spouseSavings', 0.9), pct('brokerageAccount', 0.9)],       // over 100%
    [pct('spouseSavings', 0.25), fixed('brokerageAccount', 100),
     pct('spouseSavings', 0.25)],                                    // duplicate key
    [pct('nosuchaccount', 0.5), pct('spouseSavings', 0.25)],         // unresolvable
    [pct('auSavingsAccount', 0.5)],                                  // wrong currency
  ];
  for (const total of [10_000, 8_333.33, 0.01, 7]) {
    for (const splits of cases) {
      const { result } = quiet(() => splitWage(total, splits, FALLBACK, opts()));
      if (result === null) continue;          // no-split path credits the total whole
      assert.equal(sum(result), total,
        `Σ must equal the total for ${JSON.stringify(splits)} at ${total}`);
      assert.ok(result.every(x => x.amount > 0), 'no zero or negative allocations');
    }
  }
});

// ─── Shortfall ────────────────────────────────────────────────────────────────

test('WS-6 a shortfall stops allocating and never goes negative', () => {
  const { result } = quiet(() => splitWage(1_000,
    [fixed('spouseSavings', 800), fixed('brokerageAccount', 800)], FALLBACK, opts()));

  assert.equal(result[0].amount, 800, 'the first fixed entry is satisfied in full');
  assert.equal(result[1].amount, 200, 'the second gets only what is left');
  assert.equal(result.length, 2, 'nothing remains for the fallback');
  assert.equal(sum(result), 1_000);
  // A wage event is not a spending event: it must never push the pool negative and
  // escalate into the drawdown cascade, selling assets to fund a direct deposit.
  assert.ok(result.every(x => x.amount > 0));
});

test('WS-7 an entry beyond the money gets nothing at all', () => {
  const { result } = quiet(() => splitWage(1_000,
    [fixed('spouseSavings', 1_000), fixed('brokerageAccount', 500)], FALLBACK, opts()));
  assert.deepEqual(result.map(x => x.targetKey), ['spouseSavings']);
  assert.equal(sum(result), 1_000);
});

// ─── Validation ───────────────────────────────────────────────────────────────

test('WS-8 percentages over 100% are normalised, and warn once', () => {
  const { result, warnings } = quiet(() => splitWage(10_000,
    [pct('spouseSavings', 0.9), pct('brokerageAccount', 0.9)], FALLBACK, opts()));

  assert.equal(result.find(x => x.targetKey === 'spouseSavings').amount, 5_000,
    'relative intent is preserved by scaling, not by truncating the later entry');
  assert.equal(sum(result), 10_000);
  assert.equal(warnings.length, 1, 'exactly one warning');
  assert.match(warnings[0], /180\.0%/);
});

test('WS-9 an unresolvable destination falls back — the money is never dropped', () => {
  const { result, warnings } = quiet(() => splitWage(10_000,
    [pct('deletedAccount', 0.5), pct('spouseSavings', 0.2)], FALLBACK, opts()));

  assert.equal(result.find(x => x.targetKey === 'deletedAccount'), undefined,
    'nothing is credited to an account that does not exist');
  assert.equal(result.find(x => x.targetKey === 'spouseSavings').amount, 2_000,
    'the valid entry is unaffected');
  assert.equal(result.find(x => x.targetKey === FALLBACK).amount, 8_000,
    'the rejected share falls to the transaction account rather than vanishing');
  assert.equal(sum(result), 10_000, 'conservation holds through the rejection');
  assert.match(warnings.join(' '), /names no account/);
});

test('WS-10 a cross-currency destination is refused, not converted', () => {
  const { result, warnings } = quiet(() => splitWage(10_000,
    [pct('auSavingsAccount', 0.5)], FALLBACK, opts({ wageCurrency: 'USD' })));

  // Crediting an AUD account from a USD wage would conjure currency at an implied
  // rate of 1.0 — the money would leave nothing and arrive as AUD. A real
  // cross-currency split is an INTL transfer with an FX leg and a §988 disposal.
  assert.equal(result, null, 'the only entry is refused, so there is nothing to split');
  assert.match(warnings.join(' '), /international/);

  // Control: the SAME split into a same-currency account IS honoured, so the
  // rejection above is about currency and not about the account being unreachable.
  const { result: ok } = quiet(() => splitWage(10_000,
    [pct('auSavingsAccount', 0.5)], 'auSavingsAccount', opts({ wageCurrency: 'AUD' })));
  assert.equal(ok, null, 'and 100% to the fallback is still the no-split path');

  const { result: ok2 } = quiet(() => splitWage(10_000,
    [pct('spouseSavings', 0.5)], FALLBACK, opts()));
  assert.equal(ok2.find(x => x.targetKey === 'spouseSavings').amount, 5_000,
    'control: a same-currency destination is credited normally');
});

test('WS-11 an account with no declared currency is accepted', () => {
  // Absent currency is unknown, not wrong. Refusing it would make the guard fire on
  // ordinary hand-built test states and inert accounts.
  const { result } = quiet(() => splitWage(10_000,
    [pct('noCurrency', 0.5)], FALLBACK, opts()));
  assert.equal(result.find(x => x.targetKey === 'noCurrency').amount, 5_000);
});

test('WS-12 malformed entries are skipped without disturbing the rest', () => {
  const { result } = quiet(() => splitWage(10_000, [
    pct('spouseSavings', 0.2),
    { destinationKey: 'brokerageAccount', mode: 'PERCENT', value: 'not a number' },
    { destinationKey: 'brokerageAccount', mode: 'PERCENT', value: -0.5 },
    {},
  ], FALLBACK, opts()));

  assert.equal(result.find(x => x.targetKey === 'spouseSavings').amount, 2_000);
  assert.equal(sum(result), 10_000);
});

// ─── creditPay ────────────────────────────────────────────────────────────────

/** A minimal accountService that records what it was asked to move. */
function recorder() {
  const moves = [];
  return {
    moves,
    transaction: (account, amount) => {
      moves.push({ account, amount });
      if (account) account.balance = +(account.balance + amount).toFixed(2);
    },
  };
}

test('WS-13 creditPay with no splits credits targetKey exactly as before', () => {
  const state = structuredClone(STATE);
  const svc   = recorder();
  creditPay(svc, state, { amount: 5_000, targetKey: 'spouseSavings' }, FALLBACK);

  assert.equal(svc.moves.length, 1);
  assert.equal(state.spouseSavings.balance, 5_000);
});

test('WS-14 creditPay fans out across splits', () => {
  const state = structuredClone(STATE);
  const svc   = recorder();
  creditPay(svc, state, {
    amount: 10_000, targetKey: FALLBACK,
    splits: [{ targetKey: 'spouseSavings', amount: 2_000 },
             { targetKey: 'brokerageAccount', amount: 3_000 },
             { targetKey: FALLBACK, amount: 5_000 }],
  }, FALLBACK);

  assert.equal(state.spouseSavings.balance,    2_000);
  assert.equal(state.brokerageAccount.balance, 3_000);
  assert.equal(state.usSavingsAccount.balance, 6_000);   // 1,000 opening + 5,000
});

test('WS-15 creditPay reconciles a stale action rather than losing money', () => {
  // Actions are persisted and replayed (design 81), so this reducer can be handed
  // splits that do not sum to the amount. Silently crediting less would make the
  // shortfall invisible in every downstream number.
  const state = structuredClone(STATE);
  const svc   = recorder();
  const { warnings } = quiet(() => creditPay(svc, state, {
    amount: 10_000, targetKey: FALLBACK,
    splits: [{ targetKey: 'spouseSavings', amount: 2_000 }],
  }, FALLBACK));

  const credited = svc.moves.reduce((a, m) => a + m.amount, 0);
  assert.equal(credited, 10_000, 'the full amount still reaches the ledger');
  assert.equal(state.spouseSavings.balance,    2_000);
  assert.equal(state.usSavingsAccount.balance, 9_000);   // 1,000 opening + 8,000 residual
  assert.match(warnings.join(' '), /splits sum to/);
});

test('WS-16 creditPay routes an unknown split target to the fallback', () => {
  const state = structuredClone(STATE);
  const svc   = recorder();
  creditPay(svc, state, {
    amount: 1_000, targetKey: FALLBACK,
    splits: [{ targetKey: 'accountDeletedSinceTheActionWasWritten', amount: 1_000 }],
  }, FALLBACK);

  assert.equal(state.usSavingsAccount.balance, 2_000,
    'a split naming a since-deleted account credits the fallback, never undefined');
  assert.ok(svc.moves.every(m => m.account != null),
    'transaction() is never called with undefined — that throws inside accountService');
});
