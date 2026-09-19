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
 * penalty-free-availability.test.mjs
 *
 * DESIGN 97 §24.2 / §24.7 — the extracted Phase-1 availability authority.
 *
 * PFA-1  The extraction is faithful — the service's two methods delegate and agree
 * PFA-2  The §24.1 divergence, pinned per type — `isDrawdownAccessible` is NOT this rule
 * PFA-3  The age gate — no gate, below, exactly at, above; the 59.5 decimal gate
 * PFA-4  The amount — Roth basis below the gate, 0 for the others, minimumBalance floor
 * PFA-5  `unlocksAt` is the inverse of the gate, to the millisecond
 * PFA-6  The two observable edge cases the extraction deliberately preserved (§24.2 Q1)
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AccountService } from '../../src/finance/services/account-service.js';
import { isDrawdownAccessible } from '../../src/finance/derived-metrics/net-liquidity.js';
import {
  hasAgeGate, isAgeEligible, drawableBalance,
  penaltyFreeAvailable, penaltyFreeAvailableFor, unlocksAt,
} from '../../src/finance/account-rules/penalty-free-availability.js';
import {
  RothAccount, TraditionalIRAAccount, FourOhOneKAccount,
  SuperannuationAccount, BrokerageAccount,
} from '../../src/finance/assets/investment-account.js';
import { SavingsAccount } from '../../src/finance/assets/account.js';

/** A service instance without the constructor's wiring — only the two pure methods are used. */
const svc = Object.create(AccountService.prototype);

const BIRTH = new Date('1980-01-01T00:00:00Z');
const BAL   = 100_000;

/** The four wrapper types, each with the same balance, owned by the same person. */
const wrappers = () => ({
  k401:  new FourOhOneKAccount(BAL,      { ownerId: 'primary', drawdownPriority: 1 }),
  roth:  Object.assign(new RothAccount(BAL, { ownerId: 'primary', drawdownPriority: 1 }),
    { contributionBasis: 30_000 }),
  ira:   new TraditionalIRAAccount(BAL,  { ownerId: 'primary', drawdownPriority: 1 }),
  super: new SuperannuationAccount(BAL,  { ownerId: 'primary', drawdownPriority: 1 }),
});

// ─── PFA-1 ───────────────────────────────────────────────────────────────────
// The service still answers, and answers the same thing the module does. This is the whole
// proof that §24.2 was a MOVE: if these ever diverge, the service grew a second copy back.

test('PFA-1: AccountService delegates the gate and the amount to the shared authority', () => {
  const at = new Date('2030-01-01T00:00:00Z');          // age 50
  for (const [name, a] of Object.entries(wrappers())) {
    const viaModule  = isAgeEligible(a, BIRTH, at);
    const viaService = svc.isWithdrawalEligible(a, { birthDate: BIRTH }, at);
    assert.equal(viaService, viaModule, `${name}: eligibility must come from one rule`);

    assert.equal(svc._penaltyFreeAvailable(a, viaModule),
      penaltyFreeAvailableFor(a, viaModule), `${name}: amount must come from one rule`);
    assert.equal(svc._drawableBalance(a), drawableBalance(a), `${name}: floor is one rule`);
  }
});

test('PFA-1b: the convenience form equals gate-then-amount', () => {
  const at = new Date('2030-01-01T00:00:00Z');
  for (const [name, a] of Object.entries(wrappers())) {
    assert.equal(
      penaltyFreeAvailable(a, { birthDate: BIRTH, asOf: at }),
      penaltyFreeAvailableFor(a, isAgeEligible(a, BIRTH, at)),
      name,
    );
  }
});

// ─── PFA-2 ───────────────────────────────────────────────────────────────────
// Design 97 §24.1, pinned. This test exists to FAIL if anyone reroutes the pool cover figure
// (or `householdReserve`) onto `isDrawdownAccessible`, which is the mistake §22.3 specified
// and §24.1 measured: it reads `allowsEarlyWithdrawal` before the age, so it calls three of
// the four wrappers reachable while a Phase 1 draw finds nothing in two of them.

test('PFA-2: isDrawdownAccessible is NOT the penalty-free rule — the measured table', () => {
  const at    = new Date('2030-01-01T00:00:00Z');       // age 50: under every gate
  const state = { people: { primary: { birthDate: BIRTH } }, primaryPersonKey: 'primary' };
  const w     = wrappers();

  const expected = [
    // account,     isDrawdownAccessible, isAgeEligible, penaltyFreeAvailable
    ['k401',  w.k401,  true,  false, 0],
    ['roth',  w.roth,  true,  false, 30_000],
    ['ira',   w.ira,   true,  false, 0],
    ['super', w.super, false, false, 0],
  ];

  for (const [name, a, accessible, eligible, amount] of expected) {
    assert.equal(isDrawdownAccessible(a, state, at), accessible, `${name}: isDrawdownAccessible`);
    assert.equal(isAgeEligible(a, BIRTH, at),        eligible,   `${name}: isAgeEligible`);
    assert.equal(penaltyFreeAvailable(a, { birthDate: BIRTH, asOf: at }), amount, `${name}: amount`);
  }

  // The headline: the boolean says the whole US wrapper book is reachable; the draw finds the
  // Roth basis and nothing else.
  const byBoolean = [w.k401, w.roth, w.ira]
    .filter(a => isDrawdownAccessible(a, state, at))
    .reduce((s, a) => s + a.balance, 0);
  const byDraw = [w.k401, w.roth, w.ira]
    .reduce((s, a) => s + penaltyFreeAvailable(a, { birthDate: BIRTH, asOf: at }), 0);
  assert.equal(byBoolean, 3 * BAL);
  assert.equal(byDraw,    30_000);
});

test('PFA-2b: past every gate the two agree again — the divergence is the GATE, not the type', () => {
  const at    = new Date('2045-01-01T00:00:00Z');       // age 65: past 59.5 and 60
  const state = { people: { primary: { birthDate: BIRTH } }, primaryPersonKey: 'primary' };
  for (const [name, a] of Object.entries(wrappers())) {
    assert.equal(isDrawdownAccessible(a, state, at), true, `${name}: accessible`);
    assert.equal(isAgeEligible(a, BIRTH, at),        true, `${name}: eligible`);
    assert.equal(penaltyFreeAvailable(a, { birthDate: BIRTH, asOf: at }), BAL, `${name}: whole`);
  }
});

// ─── PFA-3 ───────────────────────────────────────────────────────────────────

test('PFA-3: an account with no age gate is always eligible', () => {
  const brokerage = new BrokerageAccount(BAL, { ownerId: 'primary' });
  assert.equal(hasAgeGate(brokerage), false);
  assert.equal(isAgeEligible(brokerage, BIRTH, new Date('2000-01-01Z')), true);
  // A cleared gate reads the same as an absent one.
  const cleared = new FourOhOneKAccount(BAL, { ownerId: 'primary', minimumAge: null });
  assert.equal(hasAgeGate(cleared), false);
  assert.equal(isAgeEligible(cleared, BIRTH, new Date('2000-01-01Z')), true);
});

test('PFA-3b: the 59.5 decimal gate flips within the half year', () => {
  const k401 = new FourOhOneKAccount(BAL, { ownerId: 'primary' });
  assert.equal(k401.minimumAge, 59.5);
  // 1980-01-01 + 59.5 * 365.25d ≈ 2039-07-02.
  assert.equal(isAgeEligible(k401, BIRTH, new Date('2039-06-01T00:00:00Z')), false);
  assert.equal(isAgeEligible(k401, BIRTH, new Date('2039-08-01T00:00:00Z')), true);
});

test('PFA-3c: exactly at the gate is eligible — the comparison is >=, not >', () => {
  const ira  = new TraditionalIRAAccount(BAL, { ownerId: 'primary' });
  const open = unlocksAt(ira, BIRTH);
  assert.equal(isAgeEligible(ira, BIRTH, open), true);
  assert.equal(isAgeEligible(ira, BIRTH, new Date(open.getTime() - 1)), false);
});

// ─── PFA-4 ───────────────────────────────────────────────────────────────────

test('PFA-4: below the gate only a Roth yields, and only its contribution basis', () => {
  const at = new Date('2030-01-01T00:00:00Z');
  const w  = wrappers();
  assert.equal(penaltyFreeAvailable(w.roth,  { birthDate: BIRTH, asOf: at }), 30_000);
  assert.equal(penaltyFreeAvailable(w.k401,  { birthDate: BIRTH, asOf: at }), 0);
  assert.equal(penaltyFreeAvailable(w.ira,   { birthDate: BIRTH, asOf: at }), 0);
  assert.equal(penaltyFreeAvailable(w.super, { birthDate: BIRTH, asOf: at }), 0);
});

test('PFA-4b: the Roth basis is capped by the drawable balance, never above it', () => {
  const at   = new Date('2030-01-01T00:00:00Z');
  // A basis larger than what is left in the account — reachable after a market fall.
  const roth = Object.assign(new RothAccount(10_000, { ownerId: 'primary' }),
    { contributionBasis: 30_000 });
  assert.equal(penaltyFreeAvailable(roth, { birthDate: BIRTH, asOf: at }), 10_000);
});

test('PFA-4c: the minimumBalance floor is honoured on both branches', () => {
  const savings = new SavingsAccount(10_000, { ownerId: 'primary', minimumBalance: 2_000 });
  assert.equal(drawableBalance(savings), 8_000);
  // No gate ⇒ eligible ⇒ the drawable balance, not the balance.
  assert.equal(penaltyFreeAvailable(savings, { birthDate: BIRTH, asOf: new Date('2030-01-01Z') }), 8_000);

  // And on the ineligible-Roth branch: the basis is capped by DRAWABLE, not by balance.
  const roth = Object.assign(new RothAccount(10_000, { ownerId: 'primary', minimumBalance: 4_000 }),
    { contributionBasis: 9_000 });
  assert.equal(penaltyFreeAvailable(roth, { birthDate: BIRTH, asOf: new Date('2030-01-01Z') }), 6_000);
});

test('PFA-4d: a balance below its floor yields 0, never a negative', () => {
  const savings = new SavingsAccount(500, { ownerId: 'primary', minimumBalance: 2_000 });
  assert.equal(drawableBalance(savings), 0);
  assert.equal(penaltyFreeAvailable(savings, { birthDate: BIRTH, asOf: new Date('2030-01-01Z') }), 0);
});

// ─── PFA-5 ───────────────────────────────────────────────────────────────────

test('PFA-5: unlocksAt is null without a gate, and is the instant the gate flips', () => {
  assert.equal(unlocksAt(new BrokerageAccount(BAL, {}), BIRTH), null);

  for (const a of Object.values(wrappers())) {
    const open = unlocksAt(a, BIRTH);
    assert.ok(open instanceof Date, 'a gated account has an unlock date');
    // The inverse of the gate, to the millisecond — §24.3 shows this date on the panel next
    // to a cover figure the draw produces, so a day of drift is a visible contradiction.
    assert.equal(isAgeEligible(a, BIRTH, new Date(open.getTime() - 1)), false);
    assert.equal(isAgeEligible(a, BIRTH, open), true);
  }
});

test('PFA-5b: unlocksAt is a property of the gate and the owner, not of today', () => {
  const ira = new TraditionalIRAAccount(BAL, { ownerId: 'primary' });
  // Returned unchanged long after the gate has opened — the caller decides what to do with a
  // past date. A function that returned null once the gate opened could not be used to label
  // the date it opened ON.
  assert.deepEqual(unlocksAt(ira, BIRTH), unlocksAt(ira, BIRTH));
  assert.ok(unlocksAt(ira, BIRTH) < new Date('2045-01-01Z'));
});

test('PFA-5c: an unusable birth date yields no unlock date rather than a bogus one', () => {
  const ira = new TraditionalIRAAccount(BAL, { ownerId: 'primary' });
  assert.equal(unlocksAt(ira, null), null);
  assert.equal(unlocksAt(ira, undefined), null);
  assert.equal(unlocksAt(ira, 'not a date'), null);
});

// ─── PFA-6 ───────────────────────────────────────────────────────────────────
// Two edge cases the extraction PRESERVED rather than fixed, so that step 1 is provably
// behaviour-neutral. Both are pinned here so the fix in §24.3 is a visible, deliberate
// change to this file rather than an invisible one to a run.

test('PFA-6: minimumAge undefined reads as PERMANENTLY GATED (§24.2 Q1)', () => {
  // `'minimumAge' in account` holds, and the value is not null, so it falls through to the
  // comparison — where `age >= undefined` is false at every age. Not what anyone would
  // intend; exactly what `isWithdrawalEligible` has always done.
  const odd = new FourOhOneKAccount(BAL, { ownerId: 'primary' });
  odd.minimumAge = undefined;
  assert.equal(hasAgeGate(odd), true);
  assert.equal(isAgeEligible(odd, BIRTH, new Date('2090-01-01Z')), false);
});

test('PFA-6b: a null birth date OPENS a gated account (§24.2 Q1 — unreachable today)', () => {
  // `asOfDate - null` coerces to the epoch, so the computed age is the date itself. Today no
  // drawdown path can reach this: `eligibleOf` resolves the owner with `?? birthDate` and the
  // walk is entered with a real person. §24.3 makes it reachable — a pool claim can name an
  // account whose ownerId matches nobody — and fixes it there, with its own test.
  const ira = new TraditionalIRAAccount(BAL, { ownerId: 'nobody' });
  assert.equal(isAgeEligible(ira, null, new Date('2030-01-01Z')), true);
  // …whereas undefined reads the conservative way, which is the inconsistency itself.
  assert.equal(isAgeEligible(ira, undefined, new Date('2030-01-01Z')), false);
});
