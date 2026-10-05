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
 * super-release.test.mjs — design 119 phase 2: super is released by preservation age and
 * retirement, or at 65, instead of at a fixed 60.
 *
 *   SRL-1: the reg 6.01(2) preservation-age table, at each boundary
 *   SRL-2: retired before preservation age ⇒ released at preservation age
 *   SRL-3: still working at 60 ⇒ released when that job ends
 *   SRL-4: a job ending at 60+ releases super even if another job follows (6.01(7)(b)(i))
 *   SRL-5: a job that never ends ⇒ released at 65
 *   SRL-6: an older cohort: a job ending before 60 with a later job does NOT release
 *   SRL-7: a legacy person (no jobs) works until retirementDate, and only if they earn
 *   SRL-8: the shared gate uses the release date for super, and only for super
 *   SRL-9: net liquidity and the unlock date agree with the gate
 *   SRL-10: the drawdown walk leaves a working 61-year-old's super alone, then draws it
 *
 * Run with: node --test tests/unit/super-release.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { preservationAge, auSuperReleaseMs } from '../../src/finance/account-rules/au/super-release.js';
import { isAgeEligible, unlocksAt }         from '../../src/finance/account-rules/penalty-free-availability.js';
import { isDrawdownAccessible }             from '../../src/finance/derived-metrics/net-liquidity.js';
import { buildSpells }                      from '../../src/finance/payroll/employment.js';
import { SavingsAccount, AUD }              from '../../src/finance/assets/account.js';
import { SuperannuationAccount }            from '../../src/finance/assets/investment-account.js';
import { AccountService }                   from '../../src/finance/services/account-service.js';
import { EventBus }                         from '../../src/simulation-framework/event-bus.js';
import { Graph }                            from '../../src/graph/graph.js';
import { GraphQueryApi }                    from '../../src/graph/graph-query-api.js';

const D   = (y, m, d) => Date.UTC(y, m - 1, d);
const iso = ms => new Date(ms).toISOString().slice(0, 10);

/** A person born on `born` with the given jobs (`[start, end|null]` pairs). */
function person(born, jobs = []) {
  const p = { id: 'primary', birthDate: new Date(born), wageCurrency: 'AUD' };
  if (jobs.length === 0) return p;
  const spells = buildSpells(jobs.map(([s, e], i) => ({
    id: `j${i}`, personId: 'primary', startDate: s, endDate: e, monthlyWage: 10_000 })),
  p, new Date(D(2026, 1, 1)));
  return { ...p, spells };
}

// ─── the table ───────────────────────────────────────────────────────────────

test('SRL-1 the preservation-age table, at each boundary (reg 6.01(2))', () => {
  assert.equal(preservationAge(D(1960, 6, 30)), 55, 'born before 1 July 1960');
  assert.equal(preservationAge(D(1960, 7, 1)),  56);
  assert.equal(preservationAge(D(1961, 6, 30)), 56);
  assert.equal(preservationAge(D(1961, 7, 1)),  57);
  assert.equal(preservationAge(D(1962, 7, 1)),  58);
  assert.equal(preservationAge(D(1964, 6, 30)), 59);
  assert.equal(preservationAge(D(1964, 7, 1)),  60, 'born after 30 June 1964');
  assert.equal(preservationAge(D(1980, 1, 1)),  60);
});

// ─── the release date ────────────────────────────────────────────────────────

test('SRL-2 retired before preservation age: released at preservation age', () => {
  const p = person(D(1975, 3, 10), [['2020-01-01', '2030-01-01']]);
  assert.equal(iso(auSuperReleaseMs(p)), '2035-03-10', 'the 60th birthday');
});

test('SRL-3 still working at 60: released when that job ends', () => {
  const p = person(D(1975, 3, 10), [['2020-01-01', '2037-07-01']]);
  assert.equal(iso(auSuperReleaseMs(p)), '2037-07-01',
    'not at 60, which is what the fixed gate gave');
});

test('SRL-4 a job ending at 60 or later releases super even if another follows', () => {
  // reg 6.01(7)(b)(i): an arrangement ended, and the member was 60 on or before it ended.
  const p = person(D(1975, 3, 10), [['2020-01-01', '2036-01-01'], ['2036-01-01', '2039-01-01']]);
  assert.equal(iso(auSuperReleaseMs(p)), '2036-01-01');
});

test('SRL-5 a job that never ends: released at 65', () => {
  const p = person(D(1975, 3, 10), [['2020-01-01', null]]);
  assert.equal(iso(auSuperReleaseMs(p)), '2040-03-10');
});

test('SRL-6 older cohort: a job ending before 60 with a later job does not release', () => {
  // Born Aug 1961, so preservation age 57 (Aug 2018). The first job ends at 58, but a
  // later one starts, so (a)'s "intends never to work again" fails. The later job ends at
  // 61, which (b)(i) releases.
  const p = person(D(1961, 8, 15), [['2010-01-01', '2019-09-01'], ['2020-01-01', '2022-09-01']]);
  assert.equal(iso(auSuperReleaseMs(p)), '2022-09-01');
  // Control: without the later job, preservation age and retirement release at 58.
  const q = person(D(1961, 8, 15), [['2010-01-01', '2019-09-01']]);
  assert.equal(iso(auSuperReleaseMs(q)), '2019-09-01');
});

test('SRL-7 a legacy person works until retirementDate, and only if they earn', () => {
  const base = { birthDate: new Date(D(1975, 3, 10)), retirementDate: new Date(D(2037, 7, 1)) };
  assert.equal(iso(auSuperReleaseMs({ ...base, monthlyWage: 9_000 })), '2037-07-01');
  assert.equal(iso(auSuperReleaseMs({ ...base, monthlyWage: 0 })), '2035-03-10',
    'a retirement date on someone with no wage is not employment');
});

// ─── the shared gate ─────────────────────────────────────────────────────────

const superAcct = { type: 'super', minimumAge: 60, balance: 500_000, drawdownPriority: 2, ownerId: 'primary' };
const at61 = new Date(D(2036, 6, 1));

test('SRL-8 the gate uses the release date for super, and only for super', () => {
  const working = person(D(1975, 3, 10), [['2020-01-01', '2038-01-01']]);
  const born    = working.birthDate;

  assert.equal(isAgeEligible(superAcct, born, at61, working), false,
    'still working at 61: not released');
  assert.equal(isAgeEligible(superAcct, born, new Date(D(2038, 1, 1)), working), true,
    'released the day the job ends');
  assert.equal(isAgeEligible(superAcct, born, at61), true,
    'control: without the owner record it is the old age-60 test');

  const ira = { type: 'ira', minimumAge: 59.5 };
  assert.equal(isAgeEligible(ira, born, at61, working), true,
    'a US account ignores the owner\'s job: its gate is an age');
});

test('SRL-9 net liquidity and the unlock date agree with the gate', () => {
  const working = person(D(1975, 3, 10), [['2020-01-01', '2038-01-01']]);
  const state   = { people: { primary: working } };

  assert.equal(isDrawdownAccessible(superAcct, state, at61), false);
  assert.equal(isDrawdownAccessible(superAcct, state, new Date(D(2038, 1, 2))), true);
  assert.equal(iso(unlocksAt(superAcct, working.birthDate, working)), '2038-01-01');
});

test('SRL-10 the drawdown walk leaves a working 61-year-old\'s super alone, then draws it', () => {
  const graph = new Graph();
  const svc   = new AccountService(graph, new GraphQueryApi(graph), new EventBus());
  const run = date => {
    const auSavings = new SavingsAccount(0, { country: 'AU', currency: AUD, ownerId: 'primary' });
    const superAcct = new SuperannuationAccount(100_000, {
      country: 'AU', currency: AUD, drawdownPriority: 1, ownerId: 'primary' });
    const state = {
      auSavings, superAcct,
      people: { primary: { ...person(D(1975, 3, 10), [['2020-01-01', '2038-01-01']]), residency: 'AU' } },
    };
    let threw = false;
    try { svc.replenishSavings(state, 'auSavings', 10_000, date); } catch { threw = true; }
    return { threw, balance: superAcct.balance };
  };

  const working = run(at61);
  assert.equal(working.threw, true, 'nothing else to draw, and super is still preserved');
  assert.equal(working.balance, 100_000, 'the fixed age-60 gate would have drawn it');

  const retired = run(new Date(D(2038, 2, 1)));
  assert.equal(retired.threw, false);
  assert.equal(retired.balance, 90_000, 'released once the job has ended');
});
