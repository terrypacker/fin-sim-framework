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
 * msbs-preserved.test.mjs — design 119 phase 4: a preserved MSBS benefit, before the
 * election.
 *
 *   MSB-1: the draw window opens at the later of 55 and leaving the ADF, and closes at 65
 *   MSB-2: the account starts paying on its election, or its release if that is later
 *   MSB-3: r 61A indexation never falls, and rounds to a tenth of a per cent (r 61E(3))
 *   MSB-4: the funded sleeve earns its mix's return, less 15% on income
 *   MSB-5: the family law value interpolates Table 1 by month (Approval Sch 1 Pt 4 item 2.1)
 *   MSB-6: contributions never reach an MSBS account
 *   MSB-7: the account survives save/load and projects its employer benefit into state
 *   MSB-8: net worth counts the funded part, and the allocation cube ties to it
 *   MSB-9: in the AU Single Homeowner plan, the benefit is indexed and grown until the election
 *   MSB-10: the two reducers are pure, ignore a missing target, and stop at the election
 *
 * Run with: node --test tests/unit/msbs-preserved.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { msbsDrawWindow, msbsElectionMs, indexUnfundedBenefit, fundedSleeveReturn,
  msbsPreservedValue, msbsTotalSuperBalance, fundedSleeveParts, isMsbs,
  MSBS_DEFAULT_FUNDED_ALLOCATION } from '../../src/finance/account-rules/au/msbs.js';
import { auSuperDrawStartMs }   from '../../src/finance/account-rules/au/super-release.js';
import { auSuperKeyFor }        from '../../src/finance/account-rules/au/super-fund-key.js';
import { validateJobs }         from '../../src/finance/payroll/employment.js';
import { superFundOptions }     from '../../src/visualization/people/jobs-section.js';
import { MsbsAccount }          from '../../src/finance/assets/investment-account.js';
import { ScenarioSerializer }   from '../../src/scenarios/scenario-serializer.js';
import { accountToStatePlain }  from '../../src/scenarios/toolsets/account-state-projection.js';
import { computeNetWorth }      from '../../src/finance/derived-metrics/net-worth.js';
import { buildAllocationCube }  from '../../src/finance/allocation-reporting/allocation-cube.js';
import { MsbsFundedEarningsApplyReducer, MsbsUnfundedIndexReducer }
  from '../../src/finance/account-rules/au/msbs-classes.js';
import { GOLDEN_SPECS }         from '../helpers/golden-specs.js';
import { runGolden }            from '../helpers/golden-harness.js';

const D   = (y, m, d) => Date.UTC(y, m - 1, d);
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const BORN = '1981-07-01';

test('MSB-1 the draw window opens at the later of 55 and leaving the ADF, and closes at 65', () => {
  const left30 = msbsDrawWindow({ serviceEndDate: '2014-06-30' }, BORN);
  assert.equal(iso(left30.openMs), '2036-07-01', 'left long before 55: opens at 55 (r 52(1))');
  assert.equal(iso(left30.closeMs), '2046-07-01', 'closes at 65 (r 53(1))');
  const left58 = msbsDrawWindow({ serviceEndDate: '2039-12-31' }, BORN);
  assert.equal(iso(left58.openMs), '2039-12-31', 'served past 55: opens on leaving (r 52(1A))');

  const acct = d => ({ serviceEndDate: '2014-06-30', drawStartDate: d });
  assert.equal(iso(msbsElectionMs(acct(null), BORN)), '2036-07-01', 'blank: the window\'s start');
  assert.equal(iso(msbsElectionMs(acct('2030-01-01'), BORN)), '2036-07-01', 'too early: clamped up');
  assert.equal(iso(msbsElectionMs(acct('2041-07-01'), BORN)), '2041-07-01');
  assert.equal(iso(msbsElectionMs(acct('2050-01-01'), BORN)), '2046-07-01', 'too late: the 65th birthday');
});

test('MSB-2 the account starts paying on its election, or its release if that is later', () => {
  const retired = { id: 'primary', birthDate: new Date(BORN) };
  const msbs = d => ({ scheme: 'MSBS', serviceEndDate: '2014-06-30', drawStartDate: d });
  // Preservation age 60 (born after June 1964), no job: released 1 Jul 2041.
  assert.equal(iso(auSuperDrawStartMs(msbs(null), retired)), '2041-07-01',
    'an election at 55 still waits for release');
  assert.equal(iso(auSuperDrawStartMs(msbs('2043-01-01'), retired)), '2043-01-01');
  assert.equal(iso(auSuperDrawStartMs(msbs('2050-01-01'), retired)), '2046-07-01', 'never past 65');
});

test('MSB-3 r 61A indexation never falls, and rounds to a tenth of a per cent', () => {
  assert.deepEqual(indexUnfundedBenefit(100_000, 1.03, 1), { unfunded: 103_000, cpiPeak: 1.03, pct: 0.03 });
  assert.deepEqual(indexUnfundedBenefit(100_000, 0.99, 1), { unfunded: 100_000, cpiPeak: 1, pct: 0 },
    'a CPI fall leaves it, and the peak, alone');
  assert.equal(indexUnfundedBenefit(100_000, 1.02549, 1).pct, 0.025, '2.549% → 2.5%');
  assert.equal(indexUnfundedBenefit(100_000, 1.0255, 1).pct, 0.026, '2.55% → 2.6% (r 61E(3)(b))');
  assert.equal(indexUnfundedBenefit(100_000, 1.04, 1.02).pct, 0.020,
    'measured against the highest EARLIER level, not the start');
});

test('MSB-4 the funded sleeve earns its mix\'s return, less 15% on income', () => {
  const state = {
    effectiveGrowthRates:   { EQUITY_AU: 0.08, EQUITY_INTL_EX_AU: 0.10 },
    marketDividendYields:   { EQUITY_AU: 0.04, EQUITY_INTL_EX_AU: 0.02 },
    effectiveInterestRates: { FIXED_INCOME_AU: 0.05, SAVINGS_AU: 0.04 },
  };
  const want = 0.3725 * (0.08 - 0.15 * 0.04) + 0.3725 * (0.10 - 0.15 * 0.02)
    + 0.125 * 0.05 * 0.85 + 0.13 * 0.04 * 0.85;
  assert.ok(Math.abs(fundedSleeveReturn(state) - want) < 1e-12);
  assert.equal(Object.values(MSBS_DEFAULT_FUNDED_ALLOCATION).reduce((a, b) => a + b, 0).toFixed(6), '1.000000');
  assert.throws(() => fundedSleeveReturn({}), /no growth rate/, 'a missing rate is a wiring bug, not 0%');
});

test('MSB-5 the family law value interpolates Table 1 by month', () => {
  // Age 40 and 6 months, other ranks: FDBF = (1.2082 + 1.2054)/2, UDBF = (0.6804 + 0.7053)/2.
  const v = msbsPreservedValue({ member: 1000, funded: 100, unfunded: 100, years: 40, months: 6 });
  assert.ok(Math.abs(v - (1000 + 100 * (1.2082 + 1.2054) / 2 + 100 * (0.6804 + 0.7053) / 2)) < 1e-9);
  const officer = msbsPreservedValue({ funded: 100, years: 40, months: 0, officer: true });
  assert.ok(Math.abs(officer - 136.43) < 1e-9, 'the officer column');
  assert.ok(Math.abs(msbsPreservedValue({ unfunded: 100, years: 70 }) - 111.06) < 1e-9,
    'past the table: the 65 row');

  const entry = { balance: 50_000, employerBenefit: { funded: 20_000, unfunded: 100_000 } };
  const tsb = msbsTotalSuperBalance(entry, BORN, D(2026, 6, 30));
  // 30 Jun 2026: 44 completed years, 11 months.
  const f = (1.1971 * 1 + 1.1942 * 11) / 12, u = (0.7857 * 1 + 0.8144 * 11) / 12;
  assert.ok(Math.abs(tsb - (50_000 + 20_000 * f + 100_000 * u)) < 1e-6);
});

test('MSB-6 contributions never reach an MSBS account', () => {
  const state = {
    people: { primary: { id: 'primary' } },
    msbsAccount:  { role: 'super', scheme: 'MSBS', ownerId: 'primary', balance: 1 },
    superAccount: { role: 'super', ownerId: 'primary', balance: 1 },
  };
  const firstIsMsbs = { getStateKey: () => 'msbsAccount' };
  assert.equal(auSuperKeyFor({ state, stateRegistry: firstIsMsbs, personKey: 'primary' }), 'superAccount',
    'the person\'s first fund is MSBS: the next one takes the SG');
  assert.equal(auSuperKeyFor({ state, stateRegistry: firstIsMsbs, personKey: 'primary', preferredKey: 'msbsAccount' }),
    'superAccount', 'a stale job key naming MSBS is ignored');

  const accounts = [
    { stateKey: 'msbsAccount', __type: 'MsbsAccount', role: 'super', ownerId: 'primary', name: 'MSBS' },
    { stateKey: 'superAccount', __type: 'SuperannuationAccount', role: 'super', ownerId: 'primary', name: 'Fund' },
  ];
  const errors = validateJobs([{ id: 'j', personId: 'primary', superAccountKey: 'msbsAccount' }],
    [{ id: 'primary' }], accounts);
  assert.match(errors.join(), /preserved MSBS benefit/);
  assert.deepEqual(superFundOptions(accounts, 'primary').map(([k]) => k), ['', 'superAccount']);
});

test('MSB-7 the account survives save/load and projects its employer benefit into state', () => {
  const acct = new MsbsAccount(60_000, {
    ownerId: 'primary', unfundedEmployerBenefit: 140_000, fundedEmployerBenefit: 25_000,
    serviceEndDate: '2014-06-30', officerOnExit: true, drawStartDate: '2041-07-01',
  });
  assert.equal(acct.type, 'super');
  const d = ScenarioSerializer._serializeAccount(acct);
  assert.equal(d.__type, 'MsbsAccount');
  const back = ScenarioSerializer._makeAccount(d);
  assert.ok(back instanceof MsbsAccount);
  for (const f of ['unfundedEmployerBenefit', 'fundedEmployerBenefit', 'serviceEndDate', 'officerOnExit', 'drawStartDate']) {
    assert.equal(back[f], acct[f], f);
  }
  const plain = accountToStatePlain(back);
  assert.ok(isMsbs(plain));
  assert.deepEqual(plain.employerBenefit, { funded: 25_000, unfunded: 140_000, fundedAllocation: null, cpiPeak: 1 });
});

test('MSB-8 net worth counts the funded part, and the allocation cube ties to it', () => {
  const state = {
    msbsAccount: { type: 'super', scheme: 'MSBS', currency: { code: 'AUD' }, balance: 60_000,
      employerBenefit: { funded: 25_000.01, unfunded: 140_000 } },
  };
  assert.equal(computeNetWorth(state, 'AUD'), 85_000.01, 'member + funded; never the unfunded part');
  const parts = fundedSleeveParts(state.msbsAccount.employerBenefit);
  assert.equal(+parts.reduce((s, p) => s + p.value, 0).toFixed(2), 25_000.01);
  assert.deepEqual(parts.map(p => p.allocation), ['EQUITY', 'EQUITY', 'BOND', 'CASH']);
  const cube = buildAllocationCube(state, { baseCurrency: 'AUD' });
  assert.equal(+cube.reduce((s, r) => s + r.marketValue, 0).toFixed(2), 85_000.01);
});

test('MSB-9 in the AU Single Homeowner plan, the benefit is indexed and grown until the election', () => {
  const spec = GOLDEN_SPECS.find(s => s.name === 'au-single-homeowner');
  const { state, cfg } = runGolden(spec);
  const msbs = cfg.accounts.find(a => a.stateKey === 'msbsAccount');
  assert.equal(msbs.drawStartDate, '2041-07-01', 'the example draws at 60');
  assert.deepEqual(cfg.jobs.map(j => j.superAccountKey), ['superAccount', 'secondSuperAccount'],
    'each job pays its own fund');
  assert.ok(state.secondSuperAccount.balance > 0, 'the second job\'s SG reached the second fund');

  const eb = state.msbsAccount.employerBenefit;
  assert.ok(eb.unfunded > 140_000 && eb.funded > 25_000, 'indexed and grown');
  // Frozen at the election (phase 5 pays it): the AU CPI kept rising after 2041.
  assert.ok(eb.cpiPeak < state.cpiAccumulator.AU, 'no indexation after the election');
});

test('MSB-10 the two reducers are pure, ignore a missing target, and stop at the election', () => {
  const state = () => ({
    people: { primary: { id: 'primary', birthDate: BORN } },
    cpiAccumulator: { AU: 1.05 },
    msbsAccount: { scheme: 'MSBS', role: 'super', ownerId: 'primary', balance: 1,
      serviceEndDate: '2014-06-30', drawStartDate: '2041-07-01',
      employerBenefit: { funded: 100, unfunded: 1000, fundedAllocation: null, cpiPeak: 1 } },
  });
  const freeze = s => JSON.stringify(s);

  const idx = new MsbsUnfundedIndexReducer();
  const before = state(), snap = freeze(before);
  const after = idx.reduce(before, { type: 'AU_PERIOD_ADVANCE' }, new Date(D(2030, 7, 1)));
  assert.equal(freeze(before), snap, 'I1: the input is untouched');
  assert.deepEqual(after.msbsAccount.employerBenefit, { funded: 100, unfunded: 1050, fundedAllocation: null, cpiPeak: 1.05 });
  const elected = idx.reduce(state(), { type: 'AU_PERIOD_ADVANCE' }, new Date(D(2041, 7, 1)));
  assert.equal(elected.msbsAccount.employerBenefit.unfunded, 1000, 'from the election, phase 5 owns it');

  const apply = new MsbsFundedEarningsApplyReducer();
  const b2 = state(), snap2 = freeze(b2);
  const grown = apply.reduce(b2, { type: 'MSBS_FUNDED_EARNINGS_APPLY', stateKey: 'msbsAccount', amount: 6.5 });
  assert.equal(freeze(b2), snap2, 'I1');
  assert.equal(grown.msbsAccount.employerBenefit.funded, 106.5);
  const loss = apply.reduce(state(), { type: 'MSBS_FUNDED_EARNINGS_APPLY', stateKey: 'msbsAccount', amount: -500 });
  assert.equal(loss.msbsAccount.employerBenefit.funded, 0, 'I4: never below zero');
  const none = apply.reduce(state(), { type: 'MSBS_FUNDED_EARNINGS_APPLY', stateKey: 'nope', amount: 1 });
  assert.equal(none.msbsAccount.employerBenefit.funded, 100, 'I7: a missing target is a no-op');
});
