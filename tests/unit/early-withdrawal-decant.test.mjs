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
 * early-withdrawal-decant.test.mjs — design 45 Phase 1.
 *
 * The scheduled early-withdrawal "decant" lever: a proactive, pre-move draw from
 * US tax-deferred / Roth accounts (at 10% penalty, while under the age gate) that
 * lands NET cash in taxable brokerage at cost basis = market, so the AU residency
 * step-up later forgives the pre-move gain.
 *
 * Covers the §10 Phase-1 test list: penalty + tax actions emitted, ledger ties,
 * cash lands at market basis, step-up forgives pre-move gain — plus the toolset
 * schedules() wiring (per-class amounts, owner/key resolution, Q2 ordering).
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { EventBus }       from '../../src/simulation-framework/event-bus.js';
import { Graph }          from '../../src/graph/graph.js';
import { GraphQueryApi }  from '../../src/graph/graph-query-api.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { USD }            from '../../src/finance/assets/account.js';
import {
  RothAccount, TraditionalIRAAccount, FourOhOneKAccount, BrokerageAccount,
} from '../../src/finance/assets/investment-account.js';
import {
  ScheduledEarlyWithdrawalApplyReducer, EarlyWithdrawalPolicyHandler,
} from '../../src/finance/account-rules/us/early-withdrawal-classes.js';
import { US_EARLY_WITHDRAWAL, retargetEarlyWithdrawalEvents } from '../../src/scenarios/toolsets/us-early-withdrawal-toolset.js';
import { ACCOUNT_ROLES }       from '../../src/finance/state/account-roles.js';

function makeSvc() {
  const graph = new Graph();
  return new AccountService(graph, new GraphQueryApi(graph), new EventBus());
}

/** Person aged 50 at 2030 (below every age gate → 10% penalty applies). */
const DATE = new Date(Date.UTC(2030, 5, 1));
function makeState() {
  const ira  = new TraditionalIRAAccount(100_000, { contributionBasis: 40_000, earningsBasis: 60_000 });
  const k401 = new FourOhOneKAccount(50_000,      { contributionBasis: 30_000, earningsBasis: 20_000 });
  const roth = new RothAccount(40_000,            { contributionBasis: 30_000, earningsBasis: 10_000 });
  const brok = new BrokerageAccount(0,            { country: 'US', currency: USD });
  for (const a of [ira, k401, roth, brok]) a.ownerId = 'p1';
  return {
    iraAccount: ira, k401Account: k401, rothAccount: roth, brokerage: brok,
    people: { p1: { birthDate: new Date(Date.UTC(1980, 0, 1)), residency: 'US' } },
  };
}

const KEYS = { iraKey: 'iraAccount', k401Key: 'k401Account', rothKey: 'rothAccount', destinationKey: 'brokerage' };
function apply(state, { taxDeferredAmount = 0, rothAmount = 0, residency = 'US' } = {}) {
  const svc = makeSvc();
  const reducer = new ScheduledEarlyWithdrawalApplyReducer({ accountService: svc });
  const action  = { type: 'SCHEDULED_EARLY_WITHDRAWAL_APPLY', taxDeferredAmount, rothAmount, residency, ...KEYS };
  return { svc, result: reducer.reduce(state, action, DATE) };
}

const ties = (a) => Math.abs((a.contributionBasis + a.earningsBasis) - a.balance) < 1e-6;

// ── Tax-deferred class (IRA → 401k), penalty, tax actions ──────────────────────

test('decant: tax-deferred draws IRA first, nets to brokerage minus 10% penalty', () => {
  const state = makeState();
  const { result } = apply(state, { taxDeferredAmount: 30_000 });

  // 30k gross entirely from the IRA (drawn first); 401k untouched.
  assert.ok(Math.abs(result.iraAccount.balance  - 70_000) < 1e-6);   // 100k − 30k
  assert.ok(Math.abs(result.k401Account.balance - 50_000) < 1e-6);   // untouched
  // Net = gross − 10% penalty = 27k lands in brokerage; penalty never credited.
  assert.ok(Math.abs(result.brokerage.balance - 27_000) < 1e-6);
});

test('decant: tax-deferred overflow spills IRA→401k in order', () => {
  const state = makeState();
  const { result } = apply(state, { taxDeferredAmount: 120_000 }); // > 100k IRA

  assert.ok(Math.abs(result.iraAccount.balance  -      0) < 1e-6);   // IRA drained
  assert.ok(Math.abs(result.k401Account.balance - 30_000) < 1e-6);   // 50k − 20k spill
  // Net = 120k × 0.9 = 108k.
  assert.ok(Math.abs(result.brokerage.balance - 108_000) < 1e-6);
});

test('decant: tax-deferred emits IRA contrib+earnings and K401 tax actions with penalty', () => {
  const state = makeState();
  const { result } = apply(state, { taxDeferredAmount: 120_000, residency: 'AU' });
  const byType = Object.fromEntries(result.next.map(a => [a.type, a]));

  // IRA: 40k contrib + 60k earnings (split), each penalized 10%.
  assert.ok(Math.abs(byType.IRA_WITHDRAWAL_CONTRIB_TAX.amount        - 40_000) < 1e-6);
  assert.ok(Math.abs(byType.IRA_WITHDRAWAL_CONTRIB_TAX.penaltyAmount -  4_000) < 1e-6);
  assert.ok(Math.abs(byType.IRA_WITHDRAWAL_EARNINGS_TAX.amount        - 60_000) < 1e-6);
  assert.strictEqual(byType.IRA_WITHDRAWAL_EARNINGS_TAX.residency, 'AU');   // AU-assessable
  // 401k spill of 20k, whole-gross penalty.
  assert.ok(Math.abs(byType.K401_WITHDRAWAL_TAX.amount        - 20_000) < 1e-6);
  assert.ok(Math.abs(byType.K401_WITHDRAWAL_TAX.penaltyAmount -  2_000) < 1e-6);
});

// ── Roth class: contributions free, earnings penalized ─────────────────────────

test('decant: Roth draws contributions first (penalty-free), then earnings (penalty)', () => {
  const state = makeState();
  const { result } = apply(state, { rothAmount: 35_000 });   // 30k contrib + 5k earnings
  const roth = result.rothAccount;

  assert.ok(Math.abs(roth.contributionBasis - 0)     < 1e-6);  // contributions out first
  assert.ok(Math.abs(roth.earningsBasis     - 5_000) < 1e-6);  // 10k − 5k earnings
  // Only the 5k earnings portion is penalized: net = 30k + 5k×0.9 = 34.5k.
  assert.ok(Math.abs(result.brokerage.balance - 34_500) < 1e-6);
  const ta = result.next.filter(a => a.type === 'ROTH_WITHDRAWAL_EARNINGS_TAX');
  assert.strictEqual(ta.length, 1);
  assert.ok(Math.abs(ta[0].amount        - 5_000) < 1e-6);
  assert.ok(Math.abs(ta[0].penaltyAmount -   500) < 1e-6);
});

test('decant: a contributions-only Roth draw emits no tax action and no penalty', () => {
  const state = makeState();
  const { result } = apply(state, { rothAmount: 20_000 });   // all from 30k contrib
  assert.ok(Math.abs(result.brokerage.balance - 20_000) < 1e-6);  // no penalty
  assert.strictEqual(result.next.filter(a => a.type.startsWith('ROTH_')).length, 0);
});

// ── Ledger ties + zero-gain landing (the §2 step-up setup) ─────────────────────

test('decant: source ledgers stay tied to balance (design 43 inv-1)', () => {
  const state = makeState();
  const { result } = apply(state, { taxDeferredAmount: 70_000, rothAmount: 35_000 });
  assert.ok(ties(result.iraAccount));
  assert.ok(ties(result.k401Account));
  assert.ok(ties(result.rothAccount));
});

test('decant: cash lands in brokerage at cost basis = market (zero unrealized gain)', () => {
  const state = makeState();
  const { result } = apply(state, { taxDeferredAmount: 50_000 });
  const brok = result.brokerage;
  const net  = 45_000; // 50k × 0.9

  assert.ok(Math.abs(brok.balance           - net) < 1e-6);
  assert.ok(Math.abs(brok.contributionBasis - net) < 1e-6);  // deposited cash is all cost
  assert.ok(Math.abs(brok.earningsBasis     - 0)   < 1e-6);  // no gain at deposit
  assert.ok(ties(brok));
});

test('decant: pre-move growth on the decanted cash is forgiven by the AU step-up (§2)', () => {
  const state = makeState();
  const { svc, result } = apply(state, { taxDeferredAmount: 50_000 });
  const brok = result.brokerage;            // 45k net, basis = market, gain 0

  // Simulate pre-move appreciation: 45k → 65k (20k unrealized gain).
  brok.balance       += 20_000;
  brok.earningsBasis += 20_000;

  // Move to AU with the residency cost-base step-up (design 36 §12.2).
  svc.recordResidencyChange(brok, { country: 'AU', stepUp: true });

  // The whole pre-move gain (the 20k that grew while US-resident) is forgiven for AU.
  assert.ok(Math.abs(brok.costBaseStepUpByCountry.AU - 20_000) < 1e-6);
});

// ── Cap to drawable; no-op guards ──────────────────────────────────────────────

test('decant: a request beyond the balance is capped, not overdrawn', () => {
  const state = makeState();
  const { result } = apply(state, { rothAmount: 999_999 });
  assert.ok(Math.abs(result.rothAccount.balance - 0) < 1e-6);          // fully drained, not negative
  // Net = 30k contrib + 10k earnings × 0.9 = 39k.
  assert.ok(Math.abs(result.brokerage.balance - 39_000) < 1e-6);
});

test('decant: zero amounts are a no-op (no draw, no actions)', () => {
  const state = makeState();
  const { result } = apply(state, { taxDeferredAmount: 0, rothAmount: 0 });
  assert.ok(Math.abs(result.iraAccount.balance - 100_000) < 1e-6);
  assert.ok(Math.abs(result.brokerage.balance  -       0) < 1e-6);
  assert.deepStrictEqual(result.next, []);
});

// ── Toolset schedules() wiring ─────────────────────────────────────────────────

function makeContext(parameters) {
  return {
    parameters,
    people:   [{ id: 'p1', name: 'Pat' }],
    accounts: [
      { role: ACCOUNT_ROLES.IRA,      ownerId: 'p1', stateKey: 'iraAccount' },
      { role: ACCOUNT_ROLES.K401,     ownerId: 'p1', stateKey: 'k401Account' },
      { role: ACCOUNT_ROLES.ROTH,     ownerId: 'p1', stateKey: 'rothAccount' },
      { role: ACCOUNT_ROLES.US_STOCK, ownerId: 'p1', stateKey: 'brokerage' },
    ],
  };
}
const BASE = { earlyWithdrawalEnabled: true, earlyWithdrawalOwner: 'primary', inflationRate: 0 };

test('toolset: disabled or empty schedule emits no events', () => {
  assert.deepStrictEqual(US_EARLY_WITHDRAWAL.schedules(makeContext({ ...BASE, earlyWithdrawalEnabled: false, earlyWithdrawalSchedule: [{ year: 2030, taxDeferredAmount: 10_000 }] })), []);
  assert.deepStrictEqual(US_EARLY_WITHDRAWAL.schedules(makeContext({ ...BASE, earlyWithdrawalSchedule: [] })), []);
});

test('toolset: emits one SCHEDULED_EARLY_WITHDRAWAL with resolved keys and Q2 order', () => {
  const events = US_EARLY_WITHDRAWAL.schedules(makeContext({
    ...BASE, earlyWithdrawalSchedule: [{ year: 2030, taxDeferredAmount: 25_000, rothAmount: 5_000 }],
  }));
  assert.strictEqual(events.length, 1);
  const e = events[0];
  assert.strictEqual(e.type, 'SCHEDULED_EARLY_WITHDRAWAL');
  assert.ok(e.order > 0, 'orders after Roth conversions (default order 0) on the same date');
  assert.strictEqual(e.date.getUTCFullYear(), 2030);
  assert.strictEqual(e.data.iraKey,         'iraAccount');
  assert.strictEqual(e.data.k401Key,        'k401Account');
  assert.strictEqual(e.data.rothKey,        'rothAccount');
  assert.strictEqual(e.data.destinationKey, 'brokerage');
  assert.ok(Math.abs(e.data.taxDeferredAmount - 25_000) < 1e-6); // inflationRate 0 ⇒ real == nominal
  assert.ok(Math.abs(e.data.rothAmount        -  5_000) < 1e-6);
});

test('toolset: real base-year amounts compound to nominal by inflation', () => {
  const [e] = US_EARLY_WITHDRAWAL.schedules(makeContext({
    ...BASE, inflationRate: 0.03, earlyWithdrawalSchedule: [{ year: 2030, taxDeferredAmount: 10_000 }],
  }));
  // BRACKET_BASE_YEAR is 2025 → 5 years of 3% compounding.
  assert.ok(Math.abs(e.data.taxDeferredAmount - 10_000 * Math.pow(1.03, 5)) < 1e-6);
});

test('toolset: handler short-circuits when there is no destination', () => {
  const handler = new EarlyWithdrawalPolicyHandler();
  const out = handler.call({
    state: { people: { p1: { residency: 'US' } } },
    data:  { taxDeferredAmount: 10_000, destinationKey: 'missing' },
  });
  assert.deepStrictEqual(out, []);
});

// ── Phase 3: opt-in optimization window + retarget helper ──────────────────────

test('toolset: an optimization window seeds 0-amount tunable placeholders for each year', () => {
  const events = US_EARLY_WITHDRAWAL.schedules(makeContext({
    ...BASE, earlyWithdrawalStartYear: 2030, earlyWithdrawalEndYear: 2032,
  }));
  assert.deepStrictEqual(events.map(e => e.date.getUTCFullYear()), [2030, 2031, 2032]);
  assert.ok(events.every(e => e.data.taxDeferredAmount === 0 && e.data.rothAmount === 0), 'placeholders start at 0');
  assert.ok(events.every(e => e.order > 0), 'still order after conversions');
});

test('toolset: an explicit entry overrides the window placeholder for its year (no duplicate)', () => {
  const events = US_EARLY_WITHDRAWAL.schedules(makeContext({
    ...BASE, earlyWithdrawalStartYear: 2030, earlyWithdrawalEndYear: 2032,
    earlyWithdrawalSchedule: [{ year: 2031, taxDeferredAmount: 25_000 }],
  }));
  assert.strictEqual(events.length, 3);   // one per window year, 2031 not duplicated
  assert.ok(Math.abs(events.find(e => e.date.getUTCFullYear() === 2031).data.taxDeferredAmount - 25_000) < 1e-6);
  assert.strictEqual(events.find(e => e.date.getUTCFullYear() === 2030).data.taxDeferredAmount, 0); // placeholder
});

test('toolset: no window + empty schedule emits nothing (manual scenarios stay clean)', () => {
  assert.deepStrictEqual(US_EARLY_WITHDRAWAL.schedules(makeContext({ ...BASE })), []);
});

test('retargetEarlyWithdrawalEvents rewrites only future events for scheduled years', () => {
  const mk = (y) => ({ type: 'SCHEDULED_EARLY_WITHDRAWAL', date: new Date(Date.UTC(y, 11, 1)), data: { taxDeferredAmount: 0, rothAmount: 0 } });
  const future = mk(2031), other = mk(2032), past = mk(2030);
  const hits = retargetEarlyWithdrawalEvents([future, other, past],
    [{ year: 2031, taxDeferredAmount: 40_000, rothAmount: 5_000 }],
    { inflationRate: 0, nowMs: Date.UTC(2031, 0, 1) });
  assert.strictEqual(hits, 1);
  assert.ok(Math.abs(future.data.taxDeferredAmount - 40_000) < 1e-6);
  assert.ok(Math.abs(future.data.rothAmount        -  5_000) < 1e-6);
  assert.strictEqual(other.data.taxDeferredAmount, 0);   // year not in schedule → untouched
  assert.strictEqual(past.data.taxDeferredAmount,  0);   // ≤ nowMs → untouched
});
