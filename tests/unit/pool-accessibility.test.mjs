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
 * pool-accessibility.test.mjs
 *
 * DESIGN 97 §24.3 / §24.7 — `accessible` / `locked` / `unlocksAt` on the pool cube.
 *
 * PAC-1  A pool with no gated claim is unchanged — accessible === balance, locked 0
 * PAC-2  A wrapper pool under the gate — the headline cover figure falls, sizing does not
 * PAC-3  `available` (a flow's givable) is sized off accessible, not balance
 * PAC-4  A spouse-owned claim resolves against the SPOUSE's birth date
 * PAC-5  `unlocksAt` is the earliest gate still shut, and null once every gate is open
 * PAC-6  A claim whose owner cannot be resolved is LOCKED, not open (§24.2 Q1)
 * PAC-7  accessible <= balance always — `locked` can never go negative
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  poolMetrics, allPoolMetrics, poolContext,
} from '../../src/finance/pools/pool-metrics.js';
import { normalizeLiquidityGraph } from '../../src/finance/pools/liquidity-graph.js';
import { ACCOUNT_TYPE, USD, SavingsAccount } from '../../src/finance/assets/account.js';
import {
  BrokerageAccount, RothAccount, TraditionalIRAAccount, FourOhOneKAccount,
} from '../../src/finance/assets/investment-account.js';

const BIRTH_PRIMARY = new Date('1980-01-01T00:00:00Z');   // 50 at 2030, 65 at 2045
const BIRTH_SPOUSE  = new Date('1960-01-01T00:00:00Z');   // 70 at 2030 — already past every gate

const AT_50 = Date.parse('2030-01-01T00:00:00Z');
const AT_65 = Date.parse('2045-01-01T00:00:00Z');

const ACCOUNTS = [
  { stateKey: 'usSavingsAccount', type: ACCOUNT_TYPE.SAVINGS },
  { stateKey: 'usStockAccount',   type: ACCOUNT_TYPE.BROKERAGE },
  { stateKey: 'k401Account',      type: ACCOUNT_TYPE.FOUR_OH_ONE_K },
  { stateKey: 'rothAccount',      type: ACCOUNT_TYPE.ROTH },
  { stateKey: 'iraAccount',       type: ACCOUNT_TYPE.TRADITIONAL_IRA },
  { stateKey: 'spouseIraAccount', type: ACCOUNT_TYPE.TRADITIONAL_IRA },
];

/**
 * A household with a taxable book and a wrapper book, spending 100k/yr.
 * `currentPeriods` carries the instant, exactly as a run does.
 */
function householdState(asOfMs = AT_50) {
  return {
    people: {
      primary: { birthDate: BIRTH_PRIMARY },
      spouse:  { birthDate: BIRTH_SPOUSE },
    },
    primaryPersonKey: 'primary',
    currentPeriods:   { US: { startMs: asOfMs } },
    monthlyExpenses:  100_000 / 12,
    effectiveExchangeRates: { USD_AUD: 1 },

    usSavingsAccount: new SavingsAccount(50_000,   { ownerId: 'primary', currency: USD }),
    usStockAccount:   new BrokerageAccount(200_000, { ownerId: 'primary', currency: USD }),
    k401Account:      new FourOhOneKAccount(400_000, { ownerId: 'primary', currency: USD }),
    rothAccount:      Object.assign(
      new RothAccount(300_000, { ownerId: 'primary', currency: USD }), { contributionBasis: 90_000 }),
    iraAccount:       new TraditionalIRAAccount(100_000, { ownerId: 'primary', currency: USD }),
    spouseIraAccount: new TraditionalIRAAccount(250_000, { ownerId: 'spouse',  currency: USD }),
  };
}

const graphOf = (pools) => normalizeLiquidityGraph({ pools }, ACCOUNTS);
const ctxOf   = (state) => poolContext(state, { baseCurrency: 'USD' });

// ─── PAC-1 ───────────────────────────────────────────────────────────────────

test('PAC-1: a pool with no gated claim is unchanged — accessible is the balance', () => {
  const state = householdState();
  const g = graphOf([{ id: 'cash', spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] }]);
  const m = poolMetrics(state, g.pools[0], ctxOf(state));

  assert.equal(m.balance,    50_000);
  assert.equal(m.accessible, 50_000);
  assert.equal(m.locked,     0);
  assert.equal(m.unlocksAt,  null);
  assert.equal(m.yearsOfCover, 0.5);
});

test('PAC-1b: a sleeve-narrowed brokerage claim has no gate — §22.6 makes the case impossible', () => {
  // `normalizeClaims` refuses a sleeve narrowing on anything but a BROKERAGE, and a brokerage
  // carries no `minimumAge`, so the narrowed path can never meet a gate. Pinned so that a
  // future claim syntax cannot quietly introduce one.
  const state = householdState();
  state.usStockAccount.holdings = [
    { allocation: 'BOND',   marketValue: 120_000, rateKey: 'BOND_US' },
    { allocation: 'EQUITY', marketValue:  80_000, rateKey: 'EQUITY_US' },
  ];
  const g = graphOf([
    { id: 'reserve', spendOrder: 10, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
  ]);
  const m = poolMetrics(state, g.pools[0], ctxOf(state));
  assert.equal(m.balance,    120_000);
  assert.equal(m.accessible, 120_000);
  assert.equal(m.locked,     0);
});

// ─── PAC-2 ───────────────────────────────────────────────────────────────────

test('PAC-2: a wrapper pool under the gate — cover falls, sizing does not move', () => {
  const state = householdState(AT_50);
  const g = graphOf([{
    id: 'wrappers', spendOrder: 40,
    target: { mode: 'AMOUNT', value: 900_000 },
    claims: [{ key: 'k401Account' }, { key: 'rothAccount' }, { key: 'iraAccount' }],
  }]);
  const m = poolMetrics(state, g.pools[0], ctxOf(state));

  // What it HOLDS is untouched — 400k + 300k + 100k.
  assert.equal(m.balance, 800_000);
  // What a Phase 1 draw would find: the Roth contribution basis, and nothing else.
  assert.equal(m.accessible, 90_000);
  assert.equal(m.locked,     710_000);

  // The headline: 8.0 years of cover claimed, 0.9 deliverable.
  assert.equal(m.yearsOfCover, 0.9);

  // …while every SIZING figure still reads the balance (§24.3's line).
  assert.equal(m.target,    900_000);
  assert.equal(m.shortfall, 100_000);          // 900k asked − 800k HELD, not − 90k reachable
  assert.equal(m.capacity,  800_000);
  assert.equal(m.utilised,  800_000);
});

test('PAC-2b: past the gate the same pool reports its whole balance as cover', () => {
  const state = householdState(AT_65);
  const g = graphOf([{
    id: 'wrappers', spendOrder: 40,
    claims: [{ key: 'k401Account' }, { key: 'rothAccount' }, { key: 'iraAccount' }],
  }]);
  const m = poolMetrics(state, g.pools[0], ctxOf(state));
  assert.equal(m.accessible, 800_000);
  assert.equal(m.locked,     0);
  assert.equal(m.unlocksAt,  null);
  assert.equal(m.yearsOfCover, 8);
});

test('PAC-2c: a MIXED pool counts the taxable claim whole and the wrapper only to its basis', () => {
  const state = householdState(AT_50);
  const g = graphOf([{
    id: 'mixed', spendOrder: 20,
    claims: [{ key: 'usSavingsAccount' }, { key: 'k401Account' }],
  }]);
  const m = poolMetrics(state, g.pools[0], ctxOf(state));
  assert.equal(m.balance,    450_000);
  assert.equal(m.accessible, 50_000);          // the savings only
  assert.equal(m.locked,     400_000);
});

// ─── PAC-3 ───────────────────────────────────────────────────────────────────

test('PAC-3: `available` sizes a flow off ACCESSIBLE, never off locked money', () => {
  const state = householdState(AT_50);
  const g = graphOf([{
    id: 'wrappers', spendOrder: 40,
    floor:  { mode: 'AMOUNT', value: 40_000 },
    claims: [{ key: 'k401Account' }, { key: 'rothAccount' }],
  }]);
  const m = poolMetrics(state, g.pools[0], ctxOf(state));
  // 90k of Roth basis is reachable; the floor holds 40k of it back.
  assert.equal(m.accessible, 90_000);
  assert.equal(m.available,  50_000);
  // Sized off the balance it would have offered 660k an edge could not have moved.
  assert.notEqual(m.available, m.balance - 40_000);
});

test('PAC-3b: a fully locked pool can give nothing', () => {
  const state = householdState(AT_50);
  const g = graphOf([{ id: 'k', spendOrder: 40, claims: [{ key: 'k401Account' }] }]);
  const m = poolMetrics(state, g.pools[0], ctxOf(state));
  assert.equal(m.balance,    400_000);
  assert.equal(m.accessible, 0);
  assert.equal(m.available,  0);
  assert.equal(m.yearsOfCover, 0);
});

// ─── PAC-4 ───────────────────────────────────────────────────────────────────

test('PAC-4: a spouse-owned claim resolves against the SPOUSE, not the primary', () => {
  const state = householdState(AT_50);          // primary 50, spouse 70
  const g = graphOf([
    { id: 'mine',   spendOrder: 10, claims: [{ key: 'iraAccount' }] },
    { id: 'theirs', spendOrder: 20, claims: [{ key: 'spouseIraAccount' }] },
  ]);
  const m = allPoolMetrics(state, g, ctxOf(state));

  assert.equal(m.mine.accessible,   0,       'the primary is 10 years short of the gate');
  assert.equal(m.theirs.accessible, 250_000, 'the spouse is past it');
  assert.equal(m.theirs.locked,     0);
  assert.equal(m.theirs.unlocksAt,  null);
});

// ─── PAC-5 ───────────────────────────────────────────────────────────────────

test('PAC-5: unlocksAt is the EARLIEST gate still shut among the claims', () => {
  const state = householdState(AT_50);
  // 401(k)/Roth open at 59.5, the IRA at 60 — so the pool's date is the 59.5 one.
  const g = graphOf([{
    id: 'wrappers', spendOrder: 40,
    claims: [{ key: 'iraAccount' }, { key: 'k401Account' }],
  }]);
  const m = poolMetrics(state, g.pools[0], ctxOf(state));
  assert.ok(typeof m.unlocksAt === 'string', 'an ISO instant');
  assert.equal(new Date(m.unlocksAt).getUTCFullYear(), 2039);   // 1980 + 59.5

  // Only-the-IRA reports the LATER date, which proves the min is doing work.
  const gIra = graphOf([{ id: 'ira', spendOrder: 40, claims: [{ key: 'iraAccount' }] }]);
  const mIra = poolMetrics(state, gIra.pools[0], ctxOf(state));
  assert.equal(new Date(mIra.unlocksAt).getUTCFullYear(), 2040);   // 1980 + 60
  assert.ok(new Date(m.unlocksAt) < new Date(mIra.unlocksAt));
});

test('PAC-5b: an OPEN claim contributes no date — a part-open pool reports the shut one', () => {
  const state = householdState(AT_50);
  const g = graphOf([{
    id: 'mixed', spendOrder: 20,
    claims: [{ key: 'spouseIraAccount' }, { key: 'iraAccount' }],
  }]);
  const m = poolMetrics(state, g.pools[0], ctxOf(state));
  // The spouse's is already open, so the date is the primary's.
  assert.equal(new Date(m.unlocksAt).getUTCFullYear(), 2040);
  assert.equal(m.accessible, 250_000);
});

// ─── PAC-6 ───────────────────────────────────────────────────────────────────

test('PAC-6: a claim whose owner cannot be resolved is LOCKED, not open (§24.2 Q1)', () => {
  const state = householdState(AT_50);
  // A stale key: the account names an owner who is not on the plan. The extracted predicate
  // inherits `isWithdrawalEligible`'s coercion, under which a null birth date reads as
  // ELIGIBLE — unreachable from the drawdown walk, reachable here. Reporting a gated wrapper
  // as fully spendable on missing data is §24.1's defect by a second road.
  state.iraAccount.ownerId = 'nobody';
  const g = graphOf([{ id: 'ira', spendOrder: 40, claims: [{ key: 'iraAccount' }] }]);
  const m = poolMetrics(state, g.pools[0], ctxOf(state));

  assert.equal(m.balance,    100_000);
  assert.equal(m.accessible, 0, 'unprovable is locked, never open');
  assert.equal(m.locked,     100_000);
  assert.equal(m.unlocksAt,  null, 'no owner ⇒ no date to promise');
});

test('PAC-6b: with no period instant on state a gated claim reads locked, an ungated one does not', () => {
  const state = householdState(AT_50);
  delete state.currentPeriods;                 // a hand-built state, no run behind it
  const g = graphOf([
    { id: 'cash', spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'ira',  spendOrder: 40, claims: [{ key: 'iraAccount' }] },
  ]);
  const m = allPoolMetrics(state, g, poolContext(state, { baseCurrency: 'USD' }));
  assert.equal(m.cash.accessible, 50_000, 'no gate ⇒ unaffected by a missing date');
  assert.equal(m.ira.accessible,  0,      'a gate with no date to ask against stays shut');
});

test('PAC-6c: an explicit asOf beats the state fallback', () => {
  const state = householdState(AT_50);          // currentPeriods says 2030
  const g = graphOf([{ id: 'ira', spendOrder: 40, claims: [{ key: 'iraAccount' }] }]);
  const late = poolMetrics(state, g.pools[0], poolContext(state, { baseCurrency: 'USD', asOf: AT_65 }));
  assert.equal(late.accessible, 100_000, 'asked at 65, the gate is open');
  const now = poolMetrics(state, g.pools[0], ctxOf(state));
  assert.equal(now.accessible, 0, 'asked at 50, it is not');
});

// ─── PAC-7 ───────────────────────────────────────────────────────────────────

test('PAC-7: accessible never exceeds balance, so locked is never negative', () => {
  const state = householdState(AT_50);
  // The trap this guards: `balance` follows the CLAIM (holdings when present), while the
  // account-level penalty-free figure follows the BALANCE. A Roth whose basis exceeds what
  // its lots are worth — an ordinary state after a fall — would otherwise report accessible
  // above balance and a negative `locked`.
  state.rothAccount.holdings = [{ allocation: 'EQUITY', marketValue: 40_000, rateKey: 'EQUITY_US' }];
  const g = graphOf([{ id: 'roth', spendOrder: 40, claims: [{ key: 'rothAccount' }] }]);
  const m = poolMetrics(state, g.pools[0], ctxOf(state));

  assert.equal(m.balance,    40_000, 'the lots are the authority for a claim');
  assert.equal(m.accessible, 40_000, 'the 90k basis is capped by what the claim holds');
  assert.equal(m.locked,     0);
  assert.ok(m.accessible <= m.balance);
});

// ─── PAC-8: the cube ─────────────────────────────────────────────────────────
// The metrics are only half the feature. The numbers have to reach `state.liquidityPools`,
// survive the journal diff, and tie against the live state — or the panel draws a believable
// picture of a run that did not happen (`pool-history.js#tiePoolHistory`).

test('PAC-8: accessible/locked/unlocksAt are stamped on the cube and tie through the journal', async () => {
  const { PoolFlowReducer } = await import('../../src/finance/pools/pool-flow-reducer.js');
  const { buildPoolHistory, tiePoolHistory, poolSeries } =
    await import('../../src/finance/pools/pool-history.js');
  const { diffStates } = await import('../../src/simulation-framework/state-utils.js');

  const graph = graphOf([
    { id: 'cash',     spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'wrappers', spendOrder: 40, claims: [{ key: 'k401Account' }, { key: 'rothAccount' }] },
  ]);
  const reducer = new PoolFlowReducer({ graph, expensesCurrency: 'USD' });

  const before = householdState(AT_50);
  const { next, ...after } = reducer.reduce(
    before, { type: 'US_PERIOD_ADVANCE', date: new Date(AT_50) }, new Date(AT_50));

  const w = after.liquidityPools.wrappers;
  assert.equal(w.balance,    700_000);
  assert.equal(w.accessible, 90_000);
  assert.equal(w.locked,     610_000);
  assert.equal(new Date(w.unlocksAt).getUTCFullYear(), 2039);

  // An ungated pool stamps the pair too, saying nothing — which is what makes the field safe
  // to read unconditionally in the panel and the CSV.
  assert.equal(after.liquidityPools.cash.accessible, 50_000);
  assert.equal(after.liquidityPools.cash.locked,     0);
  assert.equal(after.liquidityPools.cash.unlocksAt,  null);

  // The replay: the fields ride the ordinary `liquidityPools.<id>.<field>` diff path, and the
  // tie is what makes anything on the panel quotable.
  const journal = [{ seq: 0, date: new Date(AT_50), action: { type: 'US_PERIOD_ADVANCE' },
    stateDiff: diffStates(before, after) }];
  const hist = buildPoolHistory({ journal });
  assert.deepEqual(poolSeries(hist, 'accessible', ['wrappers']).series.wrappers, [90_000]);
  assert.deepEqual(poolSeries(hist, 'locked',     ['wrappers']).series.wrappers, [610_000]);

  const tie = tiePoolHistory(hist, after);
  assert.equal(tie.ok, true, `the replay must equal the live cube: ${JSON.stringify(tie.mismatches)}`);
  assert.equal(tie.unchecked, false);
});

test('PAC-8b: a PAYCHECK evaluation refreshes accessible rather than carrying it forward', () => {
  // A gate opens on a DATE, not on an advance. Design 107 §5.1 has a paycheck evaluation take
  // most of the prior entry back, and `accessible` must not be among the carried fields — or a
  // wrapper reads as locked for up to a year after it opened.
  const fields = ['balance', 'accessible', 'locked', 'unlocksAt', 'yearsOfCover'];
  const src = readFileSync(
    new URL('../../src/finance/pools/pool-flow-reducer.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('if (isPaycheck && prior[pool.id])'));
  const narrow = block.slice(0, block.indexOf('continue;'));
  for (const f of fields) {
    assert.ok(new RegExp(`\\b${f}:\\s*entry\\.`).test(narrow),
      `the paycheck entry must restamp '${f}' from the live metrics, not carry it forward`);
  }
});
