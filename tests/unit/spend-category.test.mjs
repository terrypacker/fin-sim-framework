/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * spend-category.test.mjs — design 89 phase 1 (§6.1 A, §8, §8.1).
 *
 * Four handlers emit `EXPENSE_DEBIT` into the same residence-appropriate cash pool, and
 * until now the payload could not tell them apart: `targetKey` is identical, amount and
 * date carry no signal, and `section988.businessFraction` is 0 for both a month's
 * groceries and a home's rates. The spending report has to draw those as separate bands,
 * so the emitter — the only thing that knows — stamps `spendCategory`.
 *
 * `capitalFraction` rides along because the same report must not count an investment as
 * a cost: design 75 §5.2 splits a repair by `capitalizeRepairs` and design 86 G8 splits
 * an event by `capitalize`, and both splits happen where the money is already blended
 * across several properties into one debit.
 *
 *   SC-1..3   the four emitters stamp four DISTINCT values, drawn from the closed set.
 *   SC-4..7   capitalFraction: constant where it is structurally zero, debit-weighted
 *             where design 75 splits it, and never in disagreement with the basis leg.
 *   SC-8..10  ExpenseEventHandler — the capitalization gate, split funding, and the
 *             `category` / `spendCategory` name collision this design deliberately avoids.
 *   SC-11     blendCapitalFraction's own edges.
 *
 * Run with: node --test tests/unit/spend-category.test.mjs
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { MonthlyExpensesHandler }        from '../../src/finance/handlers/monthly-expenses-handler.js';
import { HouseRunningCostHandler }       from '../../src/finance/handlers/house-running-cost-handler.js';
import { RealPropertyRepairTickHandler } from '../../src/finance/handlers/real-property-repair-tick-handler.js';
import { ExpenseEventHandler }           from '../../src/finance/spending/strategies/expense-event-handler.js';
import { SPEND_CATEGORY, SPEND_CATEGORIES, blendCapitalFraction }
  from '../../src/finance/spending/spend-category.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';

const DATE = new Date('2030-06-30');

const mkRng = (seed = 42) => {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
};

const registry = {
  resolveTransactionAccountKey: () => 'usCash',
  getStateKey: () => 'usCash',
  getFlaggedStateKey: () => null,
};

/** A property carrying only the fields the two cost handlers read. */
const property = (over = {}) => ({
  value: 500_000, currency: { code: 'USD' }, country: 'US',
  annualRunningCost: 12_000, runningCostValuePct: 0, runningCostGrowth: 0,
  rentalEnabled: false, capitalizeRepairs: 0,
  ...over,
});

const baseState = (over = {}) => ({
  people: { p1: { id: 'p1', residency: 'US' } },
  effectiveExchangeRates: { USD_AUD: 1.5, AUD_USD: 1 / 1.5 },
  inflationAccumulator: { US: 1, AU: 1 },
  monthlyExpenses: 8_000,
  usCash: { balance: 5_000_000, minimumBalance: 0, currency: { code: 'USD' } },
  ...over,
});

const roles = { usRole: ACCOUNT_ROLES.US_SAVINGS, usOwnerId: 'p1',
                auRole: ACCOUNT_ROLES.AU_SAVINGS, auOwnerId: 'p1' };

const debitsOf = (actions) => actions.filter(a => a.type === 'EXPENSE_DEBIT');
const oneDebit = (actions) => {
  const d = debitsOf(actions);
  assert.equal(d.length, 1, 'expected exactly one EXPENSE_DEBIT');
  return d[0];
};

/** One debit from each of the four emitters, on states that make each of them fire. */
function debitFromEveryEmitter() {
  const living = oneDebit(new MonthlyExpensesHandler({ stateRegistry: registry, expensesCurrency: 'USD',
                                                       monthlyExpenses: 8_000, primaryPersonKey: 'p1', ...roles })
    .call({ data: { amount: 8_000 }, state: baseState(), date: DATE }));

  const running = oneDebit(new HouseRunningCostHandler({ stateRegistry: registry, propertyKeys: ['house'],
                                                         primaryPersonKey: 'p1', ...roles })
    .call({ state: baseState({ house: property() }), date: DATE }));

  const repair = oneDebit(new RealPropertyRepairTickHandler({ stateRegistry: registry, propertyKeys: ['house'],
                                                              primaryPersonKey: 'p1', ...roles })
    .call({ sim: { rng: mkRng(1) },
            state: baseState({ house: property({ repairModel: 'CONTINUOUS', repairMedian: 20_000, repairSigma: 0.2 }) }) }));

  const event = oneDebit(new ExpenseEventHandler({ stateRegistry: registry, expensesCurrency: 'USD', ...roles })
    .call({ state: baseState(), data: { amount: 25_000, category: 'travel' } }));

  return { living, running, repair, event };
}

describe('spendCategory — design 89 §6.1(A)', () => {

  test('SC-1 each of the four emitters stamps its own category', () => {
    const { living, running, repair, event } = debitFromEveryEmitter();
    assert.equal(living.spendCategory,  SPEND_CATEGORY.LIVING);
    assert.equal(running.spendCategory, SPEND_CATEGORY.HOUSING_RUNNING);
    assert.equal(repair.spendCategory,  SPEND_CATEGORY.HOUSING_REPAIR);
    assert.equal(event.spendCategory,   SPEND_CATEGORY.DISCRETIONARY);
  });

  test('SC-2 the four values are DISTINCT — the whole point of the field', () => {
    // Load-bearing. Every per-emitter assertion above passes equally well against four
    // handlers that all stamp one constant, which is the state the field exists to end:
    // "monthly expenses" and "property expenses" are the two bands the ask names, and
    // they were the same row.
    const stamped = Object.values(debitFromEveryEmitter()).map(d => d.spendCategory);
    assert.equal(new Set(stamped).size, 4, `four emitters collapsed onto ${new Set(stamped).size} categor(ies)`);
  });

  test('SC-3 every stamped value is in the closed vocabulary', () => {
    // A typo'd literal is otherwise a silently new band in the report rather than a
    // failure — and §7(a) would keep totalling correctly while the chart grew a stripe.
    for (const [name, debit] of Object.entries(debitFromEveryEmitter())) {
      assert.ok(SPEND_CATEGORIES.includes(debit.spendCategory),
        `${name} stamped ${JSON.stringify(debit.spendCategory)}, which is not in SPEND_CATEGORIES`);
    }
  });
});

describe('capitalFraction — design 89 §8.1', () => {

  test('SC-4 living and running costs are structurally zero, and stamped anyway', () => {
    // Not omitted: every EXPENSE_DEBIT carries the pair, so a consumer can compute
    // `amount * (1 - capitalFraction)` across all of them without a per-category branch.
    const { living, running } = debitFromEveryEmitter();
    assert.equal(living.capitalFraction,  0);
    assert.equal(running.capitalFraction, 0);
  });

  test('SC-5 a repair carries its property\'s capitalizeRepairs', () => {
    const mk = (capitalizeRepairs) => oneDebit(
      new RealPropertyRepairTickHandler({ stateRegistry: registry, propertyKeys: ['house'],
                                          primaryPersonKey: 'p1', ...roles })
        .call({ sim: { rng: mkRng(1) },
                state: baseState({ house: property({ capitalizeRepairs,
                                                     repairModel: 'CONTINUOUS', repairMedian: 20_000, repairSigma: 0.2 }) }) }));

    assert.equal(mk(0).capitalFraction,    0,    'pure maintenance');
    assert.equal(mk(1).capitalFraction,    1,    'wholly capitalized — not spending at all');
    assert.equal(mk(0.35).capitalFraction, 0.35, 'design 75 §5.2\'s split, carried onto the debit');
  });

  test('SC-6 two properties blend DEBIT-WEIGHTED, not 50/50', () => {
    // The case an arithmetic mean or a winner-takes-all flag gets wrong: one tick repairs
    // a fully-capitalizing property and a fully-expensing one out of the same account, and
    // their repair draws are not equal. Deliberately unequal `repairMedian` so a 0.5
    // answer is visibly wrong.
    const state = baseState({
      big:   property({ capitalizeRepairs: 1, repairModel: 'CONTINUOUS', repairMedian: 80_000, repairSigma: 0.0001 }),
      small: property({ capitalizeRepairs: 0, repairModel: 'CONTINUOUS', repairMedian: 20_000, repairSigma: 0.0001 }),
    });
    const actions = new RealPropertyRepairTickHandler({ stateRegistry: registry, propertyKeys: ['big', 'small'],
                                                        primaryPersonKey: 'p1', ...roles })
      .call({ sim: { rng: mkRng(7) }, state });

    const debit  = oneDebit(actions);
    const big    = actions.find(a => a.type === 'HOUSE_REPAIR_APPLY' && a.stateKey === 'big');
    const expect = big.amount / (big.amount + actions.find(a => a.type === 'HOUSE_REPAIR_APPLY' && a.stateKey === 'small').amount);

    assert.ok(Math.abs(debit.capitalFraction - expect) < 1e-9,
      `expected the debit-weighted ${expect}, got ${debit.capitalFraction}`);
    assert.ok(Math.abs(debit.capitalFraction - 0.5) > 0.05,
      'a 50/50 answer would mean the weighting was dropped');
  });

  test('SC-7 the debit and the basis leg cannot disagree about the split', () => {
    // They are read from one expression, and this is what pins that: reconstruct the
    // fraction from the HOUSE_REPAIR_APPLY legs the reducer actually capitalizes, and it
    // must equal what the debit claims. Two independent reads is the design 82 §5.1
    // failure mode — a duplicated split that stays correct only by comment.
    const state = baseState({
      a: property({ capitalizeRepairs: 0.8, repairModel: 'CONTINUOUS', repairMedian: 30_000, repairSigma: 0.3 }),
      b: property({ capitalizeRepairs: 0.1, country: 'AU', currency: { code: 'AUD' },
                    repairModel: 'CONTINUOUS', repairMedian: 45_000, repairSigma: 0.3 }),
    });
    const actions = new RealPropertyRepairTickHandler({ stateRegistry: registry, propertyKeys: ['a', 'b'],
                                                        primaryPersonKey: 'p1', ...roles })
      .call({ sim: { rng: mkRng(31) }, state });

    const debit = oneDebit(actions);
    // The legs are NATIVE (AUD for b); convert to the account's currency the same way
    // the handler did, so the reconstruction is of the split and not of the FX.
    const fx = (key) => (state[key].country === 'AU' ? 1 / state.effectiveExchangeRates.USD_AUD : 1);
    let capital = 0, total = 0;
    for (const leg of actions.filter(a => a.type === 'HOUSE_REPAIR_APPLY')) {
      const inAccount = leg.amount * fx(leg.stateKey);
      capital += inAccount * leg.capitalize;
      total   += inAccount;
    }
    assert.ok(total > 0, 'the fixture must actually draw repairs');
    assert.ok(Math.abs(debit.capitalFraction - capital / total) < 1e-9,
      `debit says ${debit.capitalFraction}, the basis legs say ${capital / total}`);
  });
});

describe('ExpenseEventHandler — design 86 G8 meets design 89', () => {

  const mkEvent = (data, state = baseState()) =>
    new ExpenseEventHandler({ stateRegistry: registry, expensesCurrency: 'USD', ...roles })
      .call({ state, data });

  test('SC-8 capitalFraction follows the SAME gate capitalizeAmount uses', () => {
    // `capitalize` without a linked property capitalizes nothing — `capitalizeAmount` is
    // 0 there — so the debit must not claim otherwise. Inferring the fraction from the
    // authored field alone would report an improvement that never lifted a basis.
    const linked = mkEvent({ amount: 40_000, capitalize: 0.6, propertyKey: 'house' },
                           baseState({ house: property() }));
    assert.equal(oneDebit(linked).capitalFraction, 0.6);
    assert.ok(linked.find(a => a.type === 'EXPENSE_EVENT_APPLY').capitalizeAmount > 0);

    const unlinked = mkEvent({ amount: 40_000, capitalize: 0.6 });
    assert.equal(oneDebit(unlinked).capitalFraction, 0,
      'no property ⇒ nothing was capitalized, whatever the event authored');
    assert.equal(unlinked.find(a => a.type === 'EXPENSE_EVENT_APPLY').capitalizeAmount, 0);
  });

  test('SC-9 a part-funded event stamps BOTH legs identically', () => {
    // One transaction, two accounts. The legs already had to agree about §988 character
    // (design 87); they must agree about what the household bought for the same reason —
    // a report grouping by category would otherwise split one event across two bands.
    const state = baseState({
      house:  property(),
      giftFund: { balance: 15_000, minimumBalance: 0, currency: { code: 'USD' } },
    });
    const debits = debitsOf(mkEvent({ amount: 40_000, capitalize: 0.25,
                                      propertyKey: 'house', fundFrom: 'giftFund' }, state));

    assert.equal(debits.length, 2, 'the fixture must actually split the funding');
    assert.equal(debits[0].spendCategory,   debits[1].spendCategory);
    assert.equal(debits[0].capitalFraction, debits[1].capitalFraction);
    assert.equal(debits[0].capitalFraction, 0.25);
  });

  test('SC-10 spendCategory does not collide with the event\'s authored category', () => {
    // The reason for the name. This handler emits both actions in the same tick: one
    // carries a closed reporting vocabulary, the other the author's free text. Sharing
    // the key `category` would make an accidental join between them look reasonable.
    const actions = mkEvent({ amount: 12_000, category: 'travel' });
    const apply   = actions.find(a => a.type === 'EXPENSE_EVENT_APPLY');

    assert.equal(apply.category, 'travel', 'the authored value is untouched');
    assert.equal(oneDebit(actions).spendCategory, SPEND_CATEGORY.DISCRETIONARY);
    assert.equal(oneDebit(actions).category, undefined,
      'EXPENSE_DEBIT must not carry a field named `category` — see spend-category.js');
  });
});

describe('blendCapitalFraction', () => {

  test('SC-11 debit-weighted, clamped, and zero-safe', () => {
    assert.equal(blendCapitalFraction(30, 100), 0.3);
    assert.equal(blendCapitalFraction(0, 100),  0);
    assert.equal(blendCapitalFraction(100, 100), 1);
    // A zero or absent debit is a no-op rather than a NaN — the same contract
    // blendExpenseBusinessFraction and blendExpensePriceLevel already keep.
    assert.equal(blendCapitalFraction(0, 0),     0);
    assert.equal(blendCapitalFraction(5, 0),     0);
    assert.equal(blendCapitalFraction(-5, 100),  0, 'clamped low');
    assert.equal(blendCapitalFraction(500, 100), 1, 'clamped high');
  });
});
