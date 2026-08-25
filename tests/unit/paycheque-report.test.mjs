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
 * paycheque-report.test.mjs — design 95 §17 phase 10, G4/G5/G6.
 *
 * The paycheque view is ASSEMBLY, not computation, so the properties worth pinning
 * are the ones where assembly can still get an honest number wrong:
 *
 *   - a journal entry is one REDUCER execution, so the same action appearing twice
 *     must not be counted twice;
 *   - the wage's four figures mean four different things — the package is
 *     `amount + sacrificed`, and `netAmount` is absent when nothing was withheld;
 *   - employer money never reduces take-home, and the member's own contributions do;
 *   - IRA and Roth actions carry NO personKey, so they attribute by account owner or
 *     not at all — never to whoever came first;
 *   - a carry-forward is a figure FOR THE YEAR restated monthly, so summing it would
 *     multiply the relief by twelve.
 *
 * Run with: node --test tests/unit/paycheque-report.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  listPaycheques, buildPaycheque, buildContributionsByYear, buildSuperCapRows,
  monthKeyOf,
} from '../../src/finance/payroll/paycheque-report.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let _seq = 0;
let _inst = 0;

/** One journal entry. `dup` replays the SAME action instance, as a second reducer would. */
function entry(dateIso, type, data, { dup = false } = {}) {
  if (!dup) _inst++;
  return {
    seq:  _seq++,
    date: new Date(dateIso),
    action: { type, instanceId: `i${_inst}`, data },
  };
}

function journalOf(entries) { _seq = 0; return { journal: entries }; }

const STATE = {
  people: {
    p1: { id: 'p1', name: 'Alice', wageCurrency: 'USD', selfEmployed: false },
    p2: { id: 'p2', name: 'Bob',   wageCurrency: 'AUD', selfEmployed: false },
  },
  usSavingsAccount: { stateKey: 'usSavingsAccount', name: 'US Checking' },
  usStockAccount:   { stateKey: 'usStockAccount',   name: 'US Brokerage' },
  k401Account:      { stateKey: 'k401Account',      name: 'Alice 401(k)', ownerId: 'p1' },
  iraAccount:       { stateKey: 'iraAccount',       name: 'Alice IRA',    ownerId: 'p1' },
  rothAccount:      { stateKey: 'rothAccount',      name: 'Bob Roth',     ownerId: 'p2' },
  superAccount:     { stateKey: 'superAccount',     name: 'Bob Super',    ownerId: 'p2' },
};

// ─── The month key ────────────────────────────────────────────────────────────

test('monthKeyOf is UTC, and pads the month', () => {
  assert.equal(monthKeyOf(new Date('2030-03-01T00:00:00Z')), '2030-03');
  assert.equal(monthKeyOf(new Date('2030-12-31T00:00:00Z')), '2030-12');
});

// ─── Listing ──────────────────────────────────────────────────────────────────

test('listPaycheques yields one entry per person per month, oldest first', () => {
  const j = journalOf([
    entry('2030-01-01', 'WAGES_INCOME_APPLY',    { amount: 10000, personKey: 'p1' }),
    entry('2030-01-01', 'AU_WAGES_INCOME_APPLY', { amount:  8000, personKey: 'p2' }),
    entry('2030-02-01', 'WAGES_INCOME_APPLY',    { amount: 10000, personKey: 'p1' }),
  ]);
  const list = listPaycheques(j, STATE);
  assert.deepEqual(list.map(r => `${r.name}|${r.monthKey}`),
    ['Alice|2030-01', 'Bob|2030-01', 'Alice|2030-02']);
});

test('a month with a contribution but no wage is not a paycheque', () => {
  const j = journalOf([
    entry('2030-01-01', 'IRA_CONTRIBUTION_APPLY', { amount: 583, stateKey: 'iraAccount' }),
  ]);
  assert.deepEqual(listPaycheques(j, STATE), []);
});

// ─── One paycheque ────────────────────────────────────────────────────────────

test('the four stages read off the wage action, package first', () => {
  const j = journalOf([
    entry('2030-01-01', 'AU_WAGES_INCOME_APPLY', {
      amount: 9500, sacrificed: 500, personKey: 'p2', targetKey: 'auSavings',
    }),
  ]);
  const p = buildPaycheque({ journal: j, personKey: 'p2', monthKey: '2030-01', state: STATE });
  // `amount` is ALREADY net of the sacrifice, so the package adds it back.
  assert.equal(p.salaryPackage, 10000);
  assert.equal(p.sacrificed,      500);
  assert.equal(p.assessable,     9500);
  // Nothing withheld ⇒ `netAmount` is absent, and the net is the assessable wage.
  // Reading an absent netAmount as 0 would show a month with no take-home at all.
  assert.equal(p.withheld, 0);
  assert.equal(p.netPay, 9500);
});

test('withholding reduces the net but not the assessable wage', () => {
  const j = journalOf([
    entry('2030-01-01', 'WAGES_INCOME_APPLY', {
      amount: 10000, netAmount: 9235, personKey: 'p1', targetKey: 'usSavingsAccount',
    }),
    entry('2030-01-01', 'WAGES_WITHHELD_APPLY', {
      amount: 765, personKey: 'p1', alreadyNetted: true,
    }),
  ]);
  const p = buildPaycheque({ journal: j, personKey: 'p1', monthKey: '2030-01', state: STATE });
  assert.equal(p.assessable, 10000);
  assert.equal(p.withheld,     765);
  assert.equal(p.netPay,      9235);
});

test('a re-reduced action is counted once', () => {
  // A journal entry is one REDUCER execution. Two reducers on one contribution is
  // two entries carrying the SAME instanceId, and summing them would double the
  // deferral — the whole paycheque would then fail to foot.
  const dup = { amount: 1000, stateKey: 'k401Account', personKey: 'p1' };
  const j = journalOf([
    entry('2030-01-01', 'WAGES_INCOME_APPLY', { amount: 10000, personKey: 'p1' }),
    entry('2030-01-01', 'K401_CONTRIBUTION_APPLY', dup),
    entry('2030-01-01', 'K401_CONTRIBUTION_APPLY', dup, { dup: true }),
  ]);
  const p = buildPaycheque({ journal: j, personKey: 'p1', monthKey: '2030-01', state: STATE });
  assert.equal(p.member.length, 1);
  assert.equal(p.memberTotal, 1000);
});

test('employer money is listed apart and never reduces take-home', () => {
  const j = journalOf([
    entry('2030-01-01', 'WAGES_INCOME_APPLY', { amount: 10000, personKey: 'p1' }),
    entry('2030-01-01', 'K401_CONTRIBUTION_APPLY', { amount: 1000, stateKey: 'k401Account', personKey: 'p1' }),
    entry('2030-01-01', 'K401_CONTRIBUTION_APPLY', { amount: 400, stateKey: 'k401Account', personKey: 'p1', employerFunded: true }),
    entry('2030-01-01', 'K401_CONTRIBUTION_APPLY', { amount: 300, stateKey: 'k401Account', personKey: 'p1', employerFunded: true, nonElective: true }),
  ]);
  const p = buildPaycheque({ journal: j, personKey: 'p1', monthKey: '2030-01', state: STATE });
  assert.deepEqual(p.member.map(r => r.label),   ['401(k) Deferral']);
  assert.deepEqual(p.employer.map(r => r.label), ['401(k) Match', '401(k) Non-Elective']);
  assert.equal(p.memberTotal,   1000);
  assert.equal(p.employerTotal,  700);
  // An employer match never passed through the paycheque, so it cannot reduce it.
  assert.equal(p.takeHome, 9000);
});

test('IRA and Roth attribute by account owner — they carry no personKey', () => {
  const j = journalOf([
    entry('2030-01-01', 'WAGES_INCOME_APPLY', { amount: 10000, personKey: 'p1' }),
    entry('2030-01-01', 'IRA_CONTRIBUTION_APPLY',  { amount: 583, stateKey: 'iraAccount'  }),
    entry('2030-01-01', 'ROTH_CONTRIBUTION_APPLY', { amount: 500, stateKey: 'rothAccount' }),
  ]);
  const p = buildPaycheque({ journal: j, personKey: 'p1', monthKey: '2030-01', state: STATE });
  // Alice's IRA, not Bob's Roth — attributing by "first person seen" would take both.
  assert.deepEqual(p.member.map(r => r.label), ['Traditional IRA']);
  assert.equal(p.memberTotal, 583);
});

test('with no state to read, an unattributable contribution is left out rather than guessed', () => {
  const j = journalOf([
    entry('2030-01-01', 'WAGES_INCOME_APPLY', { amount: 10000, personKey: 'p1' }),
    entry('2030-01-01', 'IRA_CONTRIBUTION_APPLY', { amount: 583, stateKey: 'iraAccount' }),
  ]);
  const p = buildPaycheque({ journal: j, personKey: 'p1', monthKey: '2030-01' });
  assert.deepEqual(p.member, []);
});

test('splits are carried with their account names; their sum is the net pay', () => {
  const j = journalOf([
    entry('2030-01-01', 'WAGES_INCOME_APPLY', {
      amount: 10000, personKey: 'p1', targetKey: 'usSavingsAccount',
      splits: [{ targetKey: 'usStockAccount', amount: 2000 },
               { targetKey: 'usSavingsAccount', amount: 8000 }],
    }),
  ]);
  const p = buildPaycheque({ journal: j, personKey: 'p1', monthKey: '2030-01', state: STATE });
  assert.deepEqual(p.splits.map(s => s.account), ['US Brokerage', 'US Checking']);
  assert.equal(p.splits.reduce((a, s) => a + s.amount, 0), p.netPay);
});

test('clamps from every stream collect onto the month, once each', () => {
  const j = journalOf([
    entry('2030-01-01', 'AU_WAGES_INCOME_APPLY', { amount: 12000, personKey: 'p2' }),
    entry('2030-01-01', 'SUPER_CONTRIBUTION_APPLY', {
      amount: 1440, stateKey: 'superAccount', personKey: 'p2', employerFunded: true,
      clamps: ['Div 291 concessional cap'], carriedForward: 25000,
    }),
    entry('2030-01-01', 'SUPER_SACRIFICE_APPLY', {
      amount: 0, stateKey: 'superAccount', personKey: 'p2',
      clamps: ['Div 291 concessional cap'], carriedForward: 25000,
    }),
    entry('2030-01-01', 'AU_QUALIFYING_EARNINGS_APPLY', {
      amount: 12000, personKey: 'p2', clamps: ['s10A(5) maximum contributions base'],
    }),
  ]);
  const p = buildPaycheque({ journal: j, personKey: 'p2', monthKey: '2030-01', state: STATE });
  assert.deepEqual(p.clamps.sort(),
    ['Div 291 concessional cap', 's10A(5) maximum contributions base']);
  // Relief, not restriction — restated on every stream, so it is a level not a sum.
  assert.equal(p.carriedForward, 25000);
  // The accumulator moves no money and is not a contribution.
  assert.equal(p.qualifyingEarnings, 12000);
  assert.ok(!p.member.some(r => r.type === 'AU_QUALIFYING_EARNINGS_APPLY'));
  assert.ok(!p.employer.some(r => r.type === 'AU_QUALIFYING_EARNINGS_APPLY'));
});

test('a person with no wage that month has no paycheque', () => {
  const j = journalOf([
    entry('2030-01-01', 'WAGES_INCOME_APPLY', { amount: 10000, personKey: 'p1' }),
  ]);
  assert.equal(buildPaycheque({ journal: j, personKey: 'p2', monthKey: '2030-01', state: STATE }), null);
  assert.equal(buildPaycheque({ journal: j, personKey: 'p1', monthKey: '2030-02', state: STATE }), null);
});

test('the super streams keep their distinct labels', () => {
  const j = journalOf([
    entry('2030-01-01', 'AU_WAGES_INCOME_APPLY', { amount: 9500, sacrificed: 500, personKey: 'p2' }),
    entry('2030-01-01', 'SUPER_CONTRIBUTION_APPLY', { amount: 1200, stateKey: 'superAccount', personKey: 'p2', employerFunded: true }),
    entry('2030-01-01', 'SUPER_SACRIFICE_APPLY',    { amount:  500, stateKey: 'superAccount', personKey: 'p2' }),
    entry('2030-01-01', 'SUPER_CONTRIBUTION_APPLY', { amount:  667, stateKey: 'superAccount', personKey: 'p2', deductible: true }),
    entry('2030-01-01', 'SUPER_NON_CONCESSIONAL_APPLY', { amount: 1000, stateKey: 'superAccount', personKey: 'p2' }),
  ]);
  const p = buildPaycheque({ journal: j, personKey: 'p2', monthKey: '2030-01', state: STATE });
  assert.deepEqual(p.employer.map(r => r.label), ['Super Guarantee']);
  assert.deepEqual(p.member.map(r => r.label),
    ['Salary Sacrifice', 'Personal Deductible Super', 'Non-Concessional Super']);
});

// ─── Contributions by year (G5) ───────────────────────────────────────────────

test('contributions roll up per person, year and stream, with the clamps as a column', () => {
  const j = journalOf([
    entry('2030-01-01', 'K401_CONTRIBUTION_APPLY', { amount: 2000, stateKey: 'k401Account', personKey: 'p1' }),
    entry('2030-02-01', 'K401_CONTRIBUTION_APPLY', { amount: 2000, stateKey: 'k401Account', personKey: 'p1' }),
    entry('2030-03-01', 'K401_CONTRIBUTION_APPLY', { amount:  500, stateKey: 'k401Account', personKey: 'p1',
                                                     clamps: ['§402(g) elective deferral limit'] }),
    entry('2031-01-01', 'K401_CONTRIBUTION_APPLY', { amount: 2000, stateKey: 'k401Account', personKey: 'p1' }),
  ]);
  const { rows, years } = buildContributionsByYear({ journal: j, state: STATE });
  assert.deepEqual(years, [2030, 2031]);
  const y2030 = rows.find(r => r.year === 2030);
  assert.equal(y2030.amount, 4500);
  assert.equal(y2030.months, 3);
  // The year that clamped SAYS so — D8's promise, which was only half-kept while
  // this could be read solely by drilling the journal by hand.
  assert.deepEqual(y2030.clamps, ['§402(g) elective deferral limit']);
  assert.deepEqual(rows.find(r => r.year === 2031).clamps, []);
});

test('member and employer money are separate rows in the same year', () => {
  const j = journalOf([
    entry('2030-01-01', 'K401_CONTRIBUTION_APPLY', { amount: 1000, stateKey: 'k401Account', personKey: 'p1' }),
    entry('2030-01-01', 'K401_CONTRIBUTION_APPLY', { amount:  400, stateKey: 'k401Account', personKey: 'p1', employerFunded: true }),
  ]);
  const { rows } = buildContributionsByYear({ journal: j, state: STATE });
  assert.deepEqual(rows.map(r => [r.label, r.funded, r.amount]).sort(),
    [['401(k) Deferral', 'member', 1000], ['401(k) Match', 'employer', 400]].sort());
});

test('the carry-forward is a level for the year, not a monthly sum', () => {
  const j = journalOf([
    entry('2030-01-01', 'SUPER_CONTRIBUTION_APPLY', { amount: 1000, stateKey: 'superAccount', personKey: 'p2', carriedForward: 25000 }),
    entry('2030-02-01', 'SUPER_CONTRIBUTION_APPLY', { amount: 1000, stateKey: 'superAccount', personKey: 'p2', carriedForward: 25000 }),
    entry('2030-03-01', 'SUPER_CONTRIBUTION_APPLY', { amount: 1000, stateKey: 'superAccount', personKey: 'p2', carriedForward: 25000 }),
  ]);
  const { rows } = buildContributionsByYear({ journal: j, state: STATE });
  // Summed it would read 75,000 — three times the relief the member actually got.
  assert.equal(rows[0].carriedForward, 25000);
  assert.equal(rows[0].amount, 3000);
});

test('an unattributable contribution is named as such rather than dropped', () => {
  const j = journalOf([
    entry('2030-01-01', 'IRA_CONTRIBUTION_APPLY', { amount: 583, stateKey: 'unknownAccount' }),
  ]);
  const { rows } = buildContributionsByYear({ journal: j, state: STATE });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '— unattributed —');
});

// ─── Super cap state (G6) ─────────────────────────────────────────────────────

test('the super cap ring is read off state, oldest financial year first', () => {
  const rows = buildSuperCapRows({
    ...STATE,
    auSuperCapsByPerson: {
      p2: {
        concessionalYTD: 12000, sgYTD: 9000, nonConcessionalYTD: 0,
        qualifyingEarningsYTD: 150000, tsbAtFyStart: 480000,
        unusedByFy: { 2028: 5000, 2026: 7000, 2027: 0 },
        bringForward: { startFy: 2029, cap: 360000, used: 100000 },
      },
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Bob');
  assert.deepEqual(rows[0].unusedByFy.map(r => r.fy), [2026, 2027, 2028]);
  assert.equal(rows[0].tsbAtFyStart, 480000);
  assert.deepEqual(rows[0].bringForward, { startFy: 2029, cap: 360000, used: 100000 });
});

test('a scenario with no super has no cap table at all', () => {
  assert.deepEqual(buildSuperCapRows(STATE), []);
  assert.deepEqual(buildSuperCapRows(null), []);
});

test('a match and a non-elective contribution are separate rows, not one merged total', () => {
  // Both are K401_CONTRIBUTION_APPLY with employerFunded:true, so a rollup keyed on
  // (type, funded) adds them together and labels the sum as whichever arrived first.
  // Found on a real compiled run: a 4% match reported as 6% of pay, and its twelve
  // months as twenty-four. Neither figure was flagged by anything.
  const j = journalOf([
    entry('2030-01-01', 'K401_CONTRIBUTION_APPLY', { amount: 320, stateKey: 'k401Account', personKey: 'p1', employerFunded: true }),
    entry('2030-01-01', 'K401_CONTRIBUTION_APPLY', { amount: 160, stateKey: 'k401Account', personKey: 'p1', employerFunded: true, nonElective: true }),
    entry('2030-02-01', 'K401_CONTRIBUTION_APPLY', { amount: 320, stateKey: 'k401Account', personKey: 'p1', employerFunded: true }),
    entry('2030-02-01', 'K401_CONTRIBUTION_APPLY', { amount: 160, stateKey: 'k401Account', personKey: 'p1', employerFunded: true, nonElective: true }),
  ]);
  const { rows } = buildContributionsByYear({ journal: j, state: STATE });
  assert.deepEqual(rows.map(r => [r.label, r.amount, r.months]).sort(),
    [['401(k) Match', 640, 2], ['401(k) Non-Elective', 320, 2]].sort());
});

test('the SG and a personal deductible contribution do not merge either', () => {
  // Same action type (SUPER_CONTRIBUTION_APPLY), different funder AND different
  // stream — `deductible` is the discriminator on the member side.
  const j = journalOf([
    entry('2030-01-01', 'SUPER_CONTRIBUTION_APPLY', { amount: 1200, stateKey: 'superAccount', personKey: 'p2', employerFunded: true }),
    entry('2030-01-01', 'SUPER_CONTRIBUTION_APPLY', { amount:  667, stateKey: 'superAccount', personKey: 'p2', deductible: true }),
  ]);
  const { rows } = buildContributionsByYear({ journal: j, state: STATE });
  assert.deepEqual(rows.map(r => [r.label, r.amount]).sort(),
    [['Personal Deductible Super', 667], ['Super Guarantee', 1200]].sort());
});

test('months counts distinct MONTHS, not actions', () => {
  const j = journalOf([
    entry('2030-01-01', 'SUPER_CONTRIBUTION_APPLY', { amount: 600, stateKey: 'superAccount', personKey: 'p2', employerFunded: true }),
    entry('2030-01-15', 'SUPER_CONTRIBUTION_APPLY', { amount: 600, stateKey: 'superAccount', personKey: 'p2', employerFunded: true }),
  ]);
  const { rows } = buildContributionsByYear({ journal: j, state: STATE });
  assert.equal(rows[0].months, 1);
  assert.equal(rows[0].amount, 1200);
});

test('AU streams roll up by FINANCIAL year; US streams by calendar year', () => {
  // Every cap in the clamps column is annual, and the two countries mean different
  // years by it. Rolled up by calendar year, a member whose SG stopped in month five
  // of the financial year shows two half-years added together — a figure ABOVE the
  // cap, in a row whose own clamp says the cap bound. Found on a real A$480k run.
  const j = journalOf([
    // 2026-05 is FY 2025-26; 2026-08 is FY 2026-27. One calendar year, two FYs.
    entry('2026-05-01', 'SUPER_CONTRIBUTION_APPLY', { amount: 3000, stateKey: 'superAccount', personKey: 'p2', employerFunded: true }),
    entry('2026-08-01', 'SUPER_CONTRIBUTION_APPLY', { amount: 3000, stateKey: 'superAccount', personKey: 'p2', employerFunded: true }),
    entry('2026-05-01', 'K401_CONTRIBUTION_APPLY',  { amount: 1000, stateKey: 'k401Account', personKey: 'p1' }),
    entry('2026-08-01', 'K401_CONTRIBUTION_APPLY',  { amount: 1000, stateKey: 'k401Account', personKey: 'p1' }),
  ]);
  const { rows } = buildContributionsByYear({ journal: j, state: STATE });

  const su = rows.filter(r => r.country === 'AU');
  assert.equal(su.length, 2, 'the two halves must not be added together');
  assert.deepEqual(su.map(r => [r.year, r.period, r.amount]),
    [[2025, '2025–26 FY', 3000], [2026, '2026–27 FY', 3000]]);
  assert.equal(su[0].periodBasis, 'financialYear');

  // The US stream stays on the calendar year, which is the individual's taxable year.
  const us = rows.filter(r => r.country === 'US');
  assert.equal(us.length, 1);
  assert.deepEqual([us[0].year, us[0].period, us[0].amount, us[0].periodBasis],
    [2026, '2026', 2000, 'calendar']);
});
