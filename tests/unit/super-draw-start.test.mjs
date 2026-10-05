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
 * super-draw-start.test.mjs — design 119 phase 3: each super account has a draw date, and
 * pension phase (0% earnings tax) starts when the account starts paying rather than at 60.
 *
 *   SDS-1: the draw start is the release date, or a later chosen date; an earlier one moves
 *   SDS-2: the gate and the unlock date follow the draw date
 *   SDS-3: the earnings tax rate is 15% before the draw start and 0% from it
 *   SDS-4: still working at 61: the fund stays in accumulation (the age-60 proxy did not)
 *   SDS-5: the field survives save/load and reaches the run's state entry
 *   SDS-6: `acct.<key>.drawStartDate` is a generated Opt lever, and it moves the run
 *
 * Run with: node --test tests/unit/super-draw-start.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { auSuperDrawStartMs, superDrawStartIn } from '../../src/finance/account-rules/au/super-release.js';
import { isAgeEligible, unlocksAt }   from '../../src/finance/account-rules/penalty-free-availability.js';
import { superEarningsTaxRate, SUPER_TAX_RATE } from '../../src/finance/tax/au/super-tax-rate.js';
import { superFundTaxRateOn }        from '../../src/finance/account-rules/au/au-super-classes.js';
import { buildSpells }               from '../../src/finance/payroll/employment.js';
import { SuperannuationAccount }     from '../../src/finance/assets/investment-account.js';
import { ScenarioSerializer }        from '../../src/scenarios/scenario-serializer.js';
import { accountToStatePlain }       from '../../src/scenarios/toolsets/account-state-projection.js';
import { ScenarioParamGenerator }    from '../../src/scenarios/params/scenario-param-generator.js';
import { ServiceRegistry }           from '../../src/services/service-registry.js';
import { ScenarioLoader }            from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }              from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

const D   = (y, m, d) => Date.UTC(y, m - 1, d);
const iso = ms => new Date(ms).toISOString().slice(0, 10);

/** Born 10 Mar 1975 (preservation age 60), with the given jobs (`[start, end|null]`). */
function person(jobs = []) {
  const p = { id: 'primary', birthDate: new Date(D(1975, 3, 10)), wageCurrency: 'AUD' };
  if (jobs.length === 0) return p;
  const spells = buildSpells(jobs.map(([s, e], i) => ({
    id: `j${i}`, personId: 'primary', startDate: s, endDate: e, monthlyWage: 10_000 })),
  p, new Date(D(2026, 1, 1)));
  return { ...p, spells };
}

const superAcct = (drawStartDate = null) =>
  ({ type: 'super', minimumAge: 60, ownerId: 'primary', ...(drawStartDate ? { drawStartDate } : {}) });

test('SDS-1 the draw start is the release date, or a later chosen date', () => {
  const retired = person();
  assert.equal(iso(auSuperDrawStartMs(superAcct(), retired)), '2035-03-10', 'blank: released at 60');
  assert.equal(iso(auSuperDrawStartMs(superAcct('2040-07-01'), retired)), '2040-07-01', 'a later date is kept');
  assert.equal(iso(auSuperDrawStartMs(superAcct('2030-01-01'), retired)), '2035-03-10',
    'a date before release moves to it');
  assert.equal(auSuperDrawStartMs(superAcct('2040-07-01'), { id: 'primary' }), null, 'no birth date');

  const state = { people: { primary: retired } };
  assert.equal(iso(superDrawStartIn(state, superAcct('2040-07-01'))), '2040-07-01');
});

test('SDS-2 the gate and the unlock date follow the draw date', () => {
  const retired = person();
  const acct    = superAcct('2040-07-01');
  const born    = retired.birthDate;
  assert.equal(isAgeEligible(acct, born, new Date(D(2038, 1, 1)), retired), false,
    'released, but the household has not started drawing');
  assert.equal(isAgeEligible(acct, born, new Date(D(2040, 7, 1)), retired), true);
  assert.equal(iso(unlocksAt(acct, born, retired)), '2040-07-01');
});

test('SDS-3 the earnings tax rate is 15% before the draw start and 0% from it', () => {
  const start = D(2040, 7, 1);
  assert.equal(superEarningsTaxRate(start, new Date(D(2040, 6, 30))), SUPER_TAX_RATE);
  assert.equal(superEarningsTaxRate(start, new Date(start)), 0);
  assert.equal(superEarningsTaxRate(null, new Date(start)), SUPER_TAX_RATE, 'no start: accumulation');

  const state = { people: { primary: person() }, superAccount: superAcct('2040-07-01') };
  assert.equal(superFundTaxRateOn(state, state.superAccount, new Date(D(2037, 1, 1))), SUPER_TAX_RATE,
    'aged 61: the age-60 proxy would have said 0%');
  assert.equal(superFundTaxRateOn(state, state.superAccount, new Date(D(2041, 1, 1))), 0);
});

test('SDS-4 still working at 61: the fund stays in accumulation', () => {
  const state = { people: { primary: person([['2020-01-01', '2038-01-01']]) }, superAccount: superAcct() };
  assert.equal(superFundTaxRateOn(state, state.superAccount, new Date(D(2036, 6, 1))), SUPER_TAX_RATE);
  assert.equal(superFundTaxRateOn(state, state.superAccount, new Date(D(2038, 1, 1))), 0,
    'pension phase from the day the job ends');
});

test('SDS-5 the field survives save/load and reaches the run\'s state entry', () => {
  const acct = new SuperannuationAccount(100_000, { ownerId: 'primary', drawStartDate: '2040-07-01' });
  const d    = ScenarioSerializer._serializeAccount(acct);
  assert.equal(d.drawStartDate, '2040-07-01');
  assert.equal(ScenarioSerializer._makeAccount(d).drawStartDate, '2040-07-01');
  assert.equal(accountToStatePlain(acct).drawStartDate, '2040-07-01');

  const blank = new SuperannuationAccount(100_000, { ownerId: 'primary' });
  assert.ok(!('drawStartDate' in ScenarioSerializer._serializeAccount(blank)), 'blank is not written');
  assert.ok(!('drawStartDate' in accountToStatePlain(blank)), 'nor projected');
});

// ─── end to end ──────────────────────────────────────────────────────────────

/** A retired member born 1 Jan 1962 (preservation age 57), so released before the run. */
function config(parameters = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER'],
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
    parameters: {
      monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
      usEquityGrowthRate: 0, intlExUsEquityGrowthRate: 0,
      usEquityDividendYield: 0, intlExUsEquityDividendYield: 0, fixedIncomeInterestRate: 0,
      usSavingsInterestRate: 0, auSavingsInterestRate: 0,
      auEquityGrowthRate: 0.07, auEquityDividendYield: 0.04,
      intlExAuEquityGrowthRate: 0.07, intlExAuEquityDividendYield: 0.04,
      superFrankedPercent: 0,
      ...parameters,
    },
    persons: [{
      __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1962-01-01',
      citizen: ['AU'], lifeExpectancy: 90, monthlyWage: 0,
      retirementDate: '2025-01-01', socialSecurityMonthly: 0,
    }],
    accounts: [
      {
        __type: 'SavingsAccount', id: 'checking', name: 'Checking',
        role: 'us-savings', stateKey: 'checkingAccount',
        initialValue: 20000, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
      },
      {
        __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings',
        role: 'au-savings', stateKey: 'auSavingsAccount',
        initialValue: 50000, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: '$' },
      },
      {
        __type: 'SuperannuationAccount', id: 'super', name: 'Super',
        role: 'super', stateKey: 'superAccount',
        initialValue: 100000, contributionBasis: 100000, earningsBasis: 0,
        ownershipType: 'sole', ownerId: 'primary',
        country: 'AU', currency: { code: 'AUD', symbol: '$' },
      },
    ],
  };
}

function run(cfg) {
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(cfg.simStart),
    simEnd:   new Date(cfg.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(structuredClone(cfg), services);
  scenario.sim.stepTo(new Date(2027, 0, 15));
  return scenario.sim.state;
}

test('SDS-6 acct.<key>.drawStartDate is a generated Opt lever, and it moves the run', () => {
  const entry = ScenarioParamGenerator.generate(config())
    .find(e => e.key === 'acct.superAccount.drawStartDate');
  assert.ok(entry, 'generated for a super account');
  assert.equal(entry.type, 'Date');
  assert.equal(entry.opt, true);
  assert.equal(entry.mc, false);

  const pension = run(config());
  // 7,000 of return, 4,000 of it dividends: 0% in pension phase, 600 of fund tax before it.
  assert.equal(pension.superAccount.balance, 107_000, 'released at 57: pension phase all year');

  const deferred = run(config({ 'acct.superAccount.drawStartDate': '2030-01-01T00:00:00.000Z' }));
  assert.equal(deferred.superAccount.drawStartDate, '2030-01-01', 'the cascade writes a day');
  assert.equal(deferred.superAccount.balance, 106_400, 'not drawing yet: accumulation, 15% on income');
  assert.equal(deferred.auPersonSuperTaxYTD.primary, 600);
});
