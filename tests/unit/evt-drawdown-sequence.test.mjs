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
 * EVT-DRAWDOWN-SEQUENCE (design 97) — `state.drawdownSequence`: one ordered list whose
 * entries are an account OR an (account, sleeves) pair.
 *
 * The policy it exists for is "after bonds, before equity". Account priority and
 * within-account sleeve order are two separate orderings, and that policy lives between
 * them: an account-level priority is either before BOTH sleeves of a brokerage or after
 * both. SEQ-3 is that case, and it is the reason the design exists.
 *
 * SEQ-1: absent ⇒ the drawdownPriority walk, unchanged
 * SEQ-2: a sleeve-narrowed pool draws only its sleeve and STOPS at its value
 * SEQ-3: bond sleeve → a whole account → equity sleeve of the SAME account, in one draw
 * SEQ-4: an account absent from the sequence is still reachable, after it
 * SEQ-5: the four config errors throw at validation, not at run time
 * SEQ-6: a capped pool draw leaves holdings summing to balance (no desync)
 * SEQ-7: the param reaches state through a real scenario load
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AccountService }       from '../../src/finance/services/account-service.js';
import { CheckingAccount, USD, ACCOUNT_TYPE } from '../../src/finance/assets/account.js';
import { BrokerageAccount }     from '../../src/finance/assets/investment-account.js';
import { Holding }              from '../../src/finance/holdings/holding.js';
import { ALLOCATION }           from '../../src/finance/holdings/allocation.js';
import { EventBus }             from '../../src/simulation-framework/event-bus.js';
import { Graph }                from '../../src/graph/graph.js';
import { GraphQueryApi }        from '../../src/graph/graph-query-api.js';
import { normalizeDrawdownSequence } from '../../src/finance/holdings/drawdown-sequence.js';
import { loadScenarioSim }      from '../helpers/scenario-harness.js';

const D = (y) => new Date(Date.UTC(y, 0, 1));
const DRAW_DATE = new Date(2026, 0, 1);

/**
 * savings (the target) + a mixed brokerage (BOND 60k / EQUITY 90k) + a second whole
 * account (cash-like brokerage, 40k) that has to sit BETWEEN the two sleeves.
 */
function fixture(stateFields = {}) {
  const svc     = new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
  const savings = new CheckingAccount(0, { country: 'US', currency: USD });
  const broker  = new BrokerageAccount(150_000, { country: 'US', currency: USD, drawdownPriority: 1 });
  broker.holdings = [
    new Holding({ id: 'bond', allocation: ALLOCATION.BOND,   marketValue: 60_000, costBasis: 60_000, purchaseDate: D(2015), rateKey: 'FIXED_INCOME_US' }),
    new Holding({ id: 'eq',   allocation: ALLOCATION.EQUITY, marketValue: 90_000, costBasis: 30_000, purchaseDate: D(2010), rateKey: 'EQUITY_US' }),
  ];
  // The "offset" stand-in: a whole account that must be drawn after bonds, before equity.
  const backstop = new BrokerageAccount(40_000, { country: 'US', currency: USD, drawdownPriority: 2 });
  backstop.holdings = [
    new Holding({ id: 'bcash', allocation: ALLOCATION.CASH, marketValue: 40_000, costBasis: 40_000, purchaseDate: D(2020), rateKey: 'SAVINGS_US' }),
  ];
  const state = {
    savingsAccount: savings, brokerAccount: broker, backstopAccount: backstop,
    personBirthDate: new Date(1970, 0, 1),
    ...stateFields,
  };
  return { svc, savings, broker, backstop, state };
}

const mv = (acct, id) => acct.holdings.find(h => h.id === id)?.marketValue ?? 0;

test('SEQ-1: no drawdownSequence ⇒ the drawdownPriority walk, unchanged', () => {
  const a = fixture();
  const b = fixture({ drawdownSequence: [] });   // empty is absent
  a.svc.replenishSavings(a.state, 'savingsAccount', 30_000, DRAW_DATE);
  b.svc.replenishSavings(b.state, 'savingsAccount', 30_000, DRAW_DATE);
  assert.deepEqual(
    a.broker.holdings.map(h => [h.id, h.marketValue]),
    b.broker.holdings.map(h => [h.id, h.marketValue]),
  );
  // Blind FIFO: the 2010 equity lot is the oldest, so it goes first — the pre-97 behavior.
  assert.equal(mv(a.broker, 'eq'), 60_000);
  assert.equal(mv(a.broker, 'bond'), 60_000);
});

test('SEQ-2: a sleeve-narrowed pool draws only its sleeve and stops at its value', () => {
  const { svc, broker, backstop, state } = fixture({
    drawdownSequence: [{ key: 'brokerAccount', sleeves: [ALLOCATION.BOND] }],
  });
  // Ask for 80k — more than the bond sleeve holds. The POOL caps at 60k: it consumes the
  // bond lot and nothing else, which is the filter. The 20k residual then comes from the
  // sources the sequence did NOT claim, in ordinary priority order — here that is the same
  // account's own equity (priority 1), ahead of the backstop (priority 2). Listing one
  // sleeve says WHEN to spend it; it does not strand the rest of the account (SEQ-4).
  svc.replenishSavings(state, 'savingsAccount', 80_000, DRAW_DATE);

  assert.equal(mv(broker, 'bond'), 0,      'the bond sleeve is spent, exactly');
  assert.equal(mv(broker, 'eq'), 70_000,   'the 20k residual came from the unclaimed remainder');
  assert.equal(backstop.balance, 40_000,   'the priority-2 account was never reached');
});

test('SEQ-3: bond sleeve → a whole account → equity sleeve of the SAME account', () => {
  const { svc, broker, backstop, state } = fixture({
    drawdownSequence: [
      { key: 'brokerAccount', sleeves: [ALLOCATION.BOND] },     // bucket 2
      { key: 'backstopAccount' },                               // the backstop below it
      { key: 'brokerAccount', sleeves: [ALLOCATION.EQUITY] },   // bucket 3
    ],
  });
  // 130k: 60k of bond, then all 40k of the backstop, then 30k of equity.
  svc.replenishSavings(state, 'savingsAccount', 130_000, DRAW_DATE);

  assert.equal(mv(broker, 'bond'), 0);
  assert.equal(backstop.balance, 0);
  assert.equal(mv(broker, 'eq'), 60_000, 'equity is reached ONLY after the backstop is dry');
});

test('SEQ-4: what the sequence does not claim follows it, in priority order', () => {
  const { svc, broker, backstop, state } = fixture({
    drawdownSequence: [{ key: 'brokerAccount', sleeves: [ALLOCATION.BOND] }],
  });
  // 160k: 60k from the listed bond pool, then the unclaimed remainder in priority order —
  // the same account's equity (90k, priority 1), then the backstop (10k of 40k, priority 2).
  // The remainder rule is the difference between "equity was sold later than you wanted",
  // which is visible in the journal, and a spurious OUT_OF_FUNDS with the money still there.
  svc.replenishSavings(state, 'savingsAccount', 160_000, DRAW_DATE);
  assert.equal(mv(broker, 'bond'), 0);
  assert.equal(mv(broker, 'eq'), 0, 'an unlisted SLEEVE of a listed account is still reachable');
  assert.equal(backstop.balance, 30_000, 'and the unlisted account follows it');
});

test('SEQ-5: the config errors throw at validation', () => {
  const accounts = [
    { stateKey: 'brokerAccount', type: ACCOUNT_TYPE.BROKERAGE },
    { stateKey: 'savingsAccount', type: ACCOUNT_TYPE.SAVINGS },
  ];
  const ok = normalizeDrawdownSequence(
    [{ key: 'brokerAccount', sleeves: ['BOND'] }, 'savingsAccount'], accounts);
  assert.deepEqual(ok, [
    { key: 'brokerAccount', sleeves: ['BOND'] },
    { key: 'savingsAccount', sleeves: null },
  ]);

  assert.throws(() => normalizeDrawdownSequence([{ key: 'nope' }], accounts), /not an account stateKey/);
  assert.throws(() => normalizeDrawdownSequence(
    [{ key: 'brokerAccount', sleeves: ['BOND'] }, { key: 'brokerAccount', sleeves: ['BOND', 'EQUITY'] }],
    accounts), /twice/);
  assert.throws(() => normalizeDrawdownSequence(
    [{ key: 'brokerAccount', sleeves: ['BOND'] }, { key: 'brokerAccount' }], accounts), /whole of/);
  assert.throws(() => normalizeDrawdownSequence(
    [{ key: 'savingsAccount', sleeves: ['CASH'] }], accounts), /only a BROKERAGE/);
  assert.throws(() => normalizeDrawdownSequence(
    [{ key: 'brokerAccount', sleeves: ['STONKS'] }], accounts), /unknown sleeve/);
  assert.throws(() => normalizeDrawdownSequence(
    [{ key: 'brokerAccount' }], accounts, { drawdownMode: 'PROPORTIONAL' }), /PROPORTIONAL/);

  assert.equal(normalizeDrawdownSequence(null, accounts), null);
  assert.equal(normalizeDrawdownSequence([], accounts), null);
});

test('SEQ-6: a capped pool draw leaves holdings summing to balance', () => {
  const { svc, broker, state } = fixture({
    drawdownSequence: [{ key: 'brokerAccount', sleeves: [ALLOCATION.BOND] }],
  });
  // The debit is sized off the account BALANCE and the consume off the POOL. Without the
  // §3.2 cap these disagree and the account silently stops summing to itself.
  svc.replenishSavings(state, 'savingsAccount', 80_000, DRAW_DATE);
  const sum = broker.holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0);
  assert.ok(Math.abs(sum - broker.balance) < 0.01,
    `holdings ${sum} must equal balance ${broker.balance}`);
});

test('SEQ-7: the param reaches state through a real scenario load', () => {
  const seq = [
    { key: 'usSavingsAccount' },
    { key: 'usStockAccount', sleeves: ['BOND'] },
    { key: 'fixedIncomeAccount' },
    { key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD'] },
  ];
  const { sim } = loadScenarioSim({
    params:   { drawdownSequence: seq },
    simStart: '2026-01-01', simEnd: '2026-06-01',
  });
  assert.deepEqual(sim.state.drawdownSequence, [
    { key: 'usSavingsAccount',   sleeves: null },
    { key: 'usStockAccount',     sleeves: ['BOND'] },
    { key: 'fixedIncomeAccount', sleeves: null },
    { key: 'usStockAccount',     sleeves: ['EQUITY', 'GOLD'] },
  ]);

  // And absent ⇒ the key does not exist at all ("absent is absent"), so no whole-state
  // fixture in the repo grows a line to say nothing.
  const plain = loadScenarioSim({ simStart: '2026-01-01', simEnd: '2026-06-01' });
  assert.equal('drawdownSequence' in plain.sim.state, false);
});
