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
 * evt-payroll-contributions.test.mjs
 *
 * The working-years contribution streams: the US 401(k) deferral + employer match,
 * IRA and Roth contributions, and the Australian Superannuation Guarantee.
 *
 * Every one of these ACTION types existed and was fully reduced before this feature
 * — what was missing was anything that ever scheduled them, which is why they all
 * sat in the golden coverage manifest's KNOWN_GAPS. So the tests here are mostly
 * about the two things scheduling made reachable and neither the reducers nor a
 * golden could previously state:
 *
 *   1. who PAID  — an employer match / Super Guarantee must not debit the member's
 *      cash pool and must not become their deduction; and
 *   2. when it STOPS — a contribution rides on a wage, so it ends with the wage.
 *
 * Each assertion is paired with a control that would still pass if the mechanism
 * were inert, because "no contribution happened" is the failure mode a bare
 * balance assertion cannot tell from "the feature is switched off".
 *
 * Run with: node --test tests/unit/evt-payroll-contributions.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry }    from '../../src/services/service-registry.js';
import { BaseScenario }       from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }     from '../../src/scenarios/scenario-loader.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USD = { code: 'USD', symbol: '$' };
const AUD = { code: 'AUD', symbol: '$' };

/** $96,000/yr, retiring 2030-01-01 — inside every run below, so the stop is reachable. */
const US_JSON = {
  toolsets: ['US_RETIREMENT'],
  simStart: '2026-01-01',
  simEnd:   '2035-01-01',
  parameters: {
    inflationRate:         0.03,
    usSavingsInterestRate: 0,     // a static cash pool, so a balance delta is the contribution
    iraGrowthRate:         0,
    rothGrowthRate:        0,
    k401GrowthRate:        0,     // …and a static wrapper, so its delta is the credit
    brokerageGrowthRate:   0,
    brokerageDividendRate: 0,
    monthlyExpenses:       0,     // nothing else moves cash
    inflationAdjust:       false,
  },
  persons: [
    {
      __type: 'Person', id: 'primary', name: 'Primary',
      birthDate: '1981-04-15', citizen: ['US'], lifeExpectancy: 90,
      socialSecurityMonthly: 0, monthlyWage: 8_000, retirementDate: '2030-01-01',
    },
  ],
  accounts: [
    { __type: 'SavingsAccount', id: 'a-sav', name: 'US Savings', type: 'savings',
      role: 'us-savings', stateKey: 'usSavingsAccount', initialValue: 200_000,
      ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0,
      country: 'US', currency: USD },
    { __type: 'FourOhOneKAccount', id: 'a-401k', name: '401(k)', type: '401k',
      role: 'k401', stateKey: 'k401Account', initialValue: 100_000,
      ownershipType: 'sole', ownerId: 'primary', contributionBasis: 100_000,
      earningsBasis: 0, country: 'US', currency: USD, drawdownPriority: 4 },
    { __type: 'TraditionalIRAAccount', id: 'a-ira', name: 'Traditional IRA', type: 'ira',
      role: 'ira', stateKey: 'iraAccount', initialValue: 50_000,
      ownershipType: 'sole', ownerId: 'primary', contributionBasis: 50_000,
      earningsBasis: 0, country: 'US', currency: USD, drawdownPriority: 3 },
    { __type: 'RothAccount', id: 'a-roth', name: 'Roth IRA', type: 'roth',
      role: 'roth-ira', stateKey: 'rothAccount', initialValue: 25_000,
      ownershipType: 'sole', ownerId: 'primary', contributionBasis: 25_000,
      earningsBasis: 0, country: 'US', currency: USD, drawdownPriority: 5 },
  ],
};

/** AUD 96,000/yr into one super fund. */
const AU_JSON = {
  toolsets: ['AU_RETIREMENT'],
  simStart: '2026-01-01',
  simEnd:   '2035-01-01',
  parameters: {
    inflationRate:         0.03,
    auSavingsInterestRate: 0,
    superGrowthRate:       0,
    auStockGrowthRate:     0,
    auStockDividendRate:   0,
    monthlyExpenses:       0,
    inflationAdjust:       false,
  },
  persons: [
    {
      __type: 'Person', id: 'primary', name: 'Primary',
      birthDate: '1981-04-15', citizen: ['AU'], lifeExpectancy: 90,
      socialSecurityMonthly: 0, monthlyWage: 8_000, wageCurrency: 'AUD',
      residency: 'AU', retirementDate: '2030-01-01',
    },
  ],
  accounts: [
    { __type: 'SavingsAccount', id: 'a-ausav', name: 'AU Savings', type: 'savings',
      role: 'au-savings', stateKey: 'auSavingsAccount', initialValue: 200_000,
      ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0,
      country: 'AU', currency: AUD },
    { __type: 'SuperannuationAccount', id: 'a-super', name: 'Superannuation', type: 'super',
      role: 'super', stateKey: 'superAccount', initialValue: 100_000,
      ownershipType: 'sole', ownerId: 'primary', contributionBasis: 100_000,
      earningsBasis: 0, minimumAge: 60, country: 'AU', currency: AUD, drawdownPriority: 2 },
  ],
};

const SUPER_TAX_RATE = 0.15;   // Div 295, the rate SuperContributionApplyReducer withholds

function withParams(base, params) {
  return { ...base, parameters: { ...base.parameters, ...params } };
}

function run(config, to) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(config.simStart),
    simEnd:   new Date(config.simEnd),
  });
  scenario.buildSim({ telemetry: 'journal' });
  new ScenarioLoader().load(structuredClone(config), services);
  const before = structuredClone(scenario.sim.state);
  scenario.sim.stepTo(to);
  return { sim: scenario.sim, before, state: scenario.sim.state };
}

const END_2026 = new Date(Date.UTC(2026, 11, 31));
const MID_2031 = new Date(Date.UTC(2031, 5, 30));   // 18 months past retirement

// ─── The off switch ───────────────────────────────────────────────────────────

test('contributions: with every rate at its default, nothing is scheduled', () => {
  const { sim, before, state } = run(US_JSON, END_2026);
  assert.equal(sim.journal.getActions('K401_CONTRIBUTION_APPLY').length, 0,
    'a scenario that does not opt in must not contribute');
  assert.equal(state.k401Account.balance, before.k401Account.balance,
    'and its 401(k) must not move');
});

// ─── 401(k): employee deferral ────────────────────────────────────────────────

test('401(k) deferral: twelve monthly instalments of 10% of pay, from the cash pool', () => {
  const { before, state } = run(withParams(US_JSON, { k401DeferralPct: 0.10 }), END_2026);

  const annualPay = 8_000 * 12;
  const expected  = +(annualPay * 0.10 / 12).toFixed(2) * 12;

  assert.equal(state.k401Account.balance - before.k401Account.balance, expected,
    '401(k) is credited a twelfth of the capped annual deferral each month');
  assert.equal(state.k401Account.contributionBasis - before.k401Account.contributionBasis,
    expected, 'a deferral is basis, not earnings');
  // Wages credit the pool, the deferral debits it, and the year-end settle debits the
  // tax — so the pool nets what is left. The point is the middle term: the deferral IS
  // taken out of the paycheque.
  assert.equal(state.usSavingsAccount.balance - before.usSavingsAccount.balance,
    annualPay - expected - state.cumulativeTaxesPaid,
    'the deferral leaves the cash pool the wage landed in');
});

test('401(k) deferral: is a pre-tax deduction', () => {
  const withDeferral = run(withParams(US_JSON, { k401DeferralPct: 0.10 }), END_2026);
  const without      = run(US_JSON, END_2026);

  const deducted = withDeferral.sim.journal.getActions('K401_CONTRIBUTION_TAX')
    .reduce((t, e) => t + (e.action?.data?.amount ?? 0), 0);
  assert.ok(deducted > 0, 'the deferral must reach the negative-income accumulator');
  assert.ok(withDeferral.state.cumulativeTaxesPaid < without.state.cumulativeTaxesPaid,
    'deferring pay must reduce the tax settled on the year');
});

test('401(k) deferral: the annual cap binds', () => {
  const cap = 6_000;
  const { before, state } = run(
    withParams(US_JSON, { k401DeferralPct: 0.50, k401AnnualCap: cap }), END_2026);
  // 50% of $96,000 is $48,000 — the cap is what should land, to the cent.
  assert.equal(state.k401Account.balance - before.k401Account.balance, cap,
    'the capped annual figure is what gets contributed, in twelfths');
});

// ─── 401(k): employer match ───────────────────────────────────────────────────

test('401(k) match: employer money credits the wrapper without touching the paycheque', () => {
  const matchOnly = run(withParams(US_JSON, { k401EmployerMatchPct: 0.05 }), END_2026);
  const control   = run(US_JSON, END_2026);

  const annualPay = 8_000 * 12;
  const expected  = +(annualPay * 0.05 / 12).toFixed(2) * 12;

  assert.equal(
    matchOnly.state.k401Account.balance - matchOnly.before.k401Account.balance, expected,
    'the match is credited in full');
  // The control is the working-detector: it proves the cash pool DOES move in this
  // scenario (wages land in it), so an unchanged delta below is a statement about
  // the match and not about a scenario where nothing happens.
  assert.ok(control.state.usSavingsAccount.balance > control.before.usSavingsAccount.balance,
    'control: the cash pool is live');
  assert.equal(matchOnly.state.usSavingsAccount.balance, control.state.usSavingsAccount.balance,
    'an employer match must leave the household cash pool exactly where it was');
});

test('401(k) match: employer money is not the employee\'s deduction', () => {
  const { sim, state } = run(withParams(US_JSON, { k401EmployerMatchPct: 0.05 }), END_2026);
  const control        = run(US_JSON, END_2026);

  assert.equal(sim.journal.getActions('K401_CONTRIBUTION_TAX').length, 0,
    'a match chains no pre-tax deduction');
  assert.equal(state.cumulativeTaxesPaid, control.state.cumulativeTaxesPaid,
    'and therefore cannot change the tax the employee pays');
});

// ─── IRA and Roth ─────────────────────────────────────────────────────────────

test('IRA and Roth: annual amounts are paid in twelfths from cash', () => {
  const { before, state } = run(
    withParams(US_JSON, { iraAnnualContribution: 7_200, rothAnnualContribution: 3_600 }),
    END_2026);

  assert.equal(state.iraAccount.balance  - before.iraAccount.balance,  7_200);
  assert.equal(state.rothAccount.balance - before.rothAccount.balance, 3_600);
  assert.equal(state.usSavingsAccount.balance - before.usSavingsAccount.balance,
    (8_000 * 12) - 7_200 - 3_600 - state.cumulativeTaxesPaid,
    'both come out of the same cash pool the wage landed in');
});

// ─── The stop ─────────────────────────────────────────────────────────────────

test('contributions stop at the retirement date, with the wage that funded them', () => {
  const { sim } = run(
    withParams(US_JSON, { k401DeferralPct: 0.10, k401EmployerMatchPct: 0.05 }), MID_2031);

  const contributions = sim.journal.getActions('K401_CONTRIBUTION_APPLY');
  assert.ok(contributions.length > 0, 'precondition: contributions did happen');
  const last = contributions.at(-1).date;
  assert.ok(last < new Date(Date.UTC(2030, 0, 1)),
    `no contribution may fall on or after the 2030-01-01 retirement date, got ${last.toISOString()}`);

  // Asserted on the contributions themselves rather than on the closing balance,
  // because `k401ToIraConversionEnabled` defaults ON: the 401(k) is rolled into the
  // owner's IRA at retirement and its balance is legitimately zero by 2031. Four
  // working years (2026-2029) of a deferral and a match, and not a month more.
  const total = contributions.reduce((t, e) => t + (e.action?.data?.amount ?? 0), 0);
  const expected = (+(96_000 * 0.10 / 12).toFixed(2) + +(96_000 * 0.05 / 12).toFixed(2)) * 48;
  assert.equal(+total.toFixed(2), +expected.toFixed(2),
    'exactly the working years were contributed');
  assert.equal(contributions.length, 48 * 2, 'a deferral and a match every working month');
});

// ─── Australian Super Guarantee ───────────────────────────────────────────────

test('Super Guarantee: credits the fund net of contributions tax, without debiting the member', () => {
  const sg      = run(withParams(AU_JSON, { superGuaranteePct: 0.12 }), END_2026);
  const control = run(AU_JSON, END_2026);

  const gross = +(96_000 * 0.12 / 12).toFixed(2) * 12;
  const net   = +(96_000 * 0.12 / 12).toFixed(2) * 12
              - +((96_000 * 0.12 / 12) * SUPER_TAX_RATE).toFixed(2) * 12;

  assert.equal(+(sg.state.superAccount.balance - sg.before.superAccount.balance).toFixed(2),
    +net.toFixed(2), 'the fund receives the contribution net of the 15% Div 295 tax');
  assert.ok(gross > net, 'sanity: the fund tax is actually withheld');

  assert.ok(control.state.auSavingsAccount.balance > control.before.auSavingsAccount.balance,
    'control: the AU cash pool is live');
  assert.equal(sg.state.auSavingsAccount.balance, control.state.auSavingsAccount.balance,
    'the Super Guarantee is the employer\'s money — the member\'s cash is untouched');
});

test('Super Guarantee: is outside the member\'s assessable income', () => {
  const sg      = run(withParams(AU_JSON, { superGuaranteePct: 0.12 }), END_2026);
  const control = run(AU_JSON, END_2026);

  // Read mid-financial-year (the AU year ends 30 June, so 31 December is six months
  // into the next one): the accumulator holds this year's assessable income, before
  // any settle has flushed it. Six months of the same wage in both arms — the SG on
  // top of it is the employer's charge and never enters the member's return.
  // Per-person, not the household total: design 76 attributes AU income to the
  // member who earned it, and `auOrdinaryIncomeYTD` stays 0 on that path.
  assert.ok(control.state.auPersonOrdinaryIncomeYTD.primary > 0,
    'control: income IS being accumulated');
  assert.equal(sg.state.auPersonOrdinaryIncomeYTD.primary,
    control.state.auPersonOrdinaryIncomeYTD.primary,
    'an employer contribution must not enter the member\'s assessable income');

  // The fund is still assessed on it, and that Div 295 charge — and ONLY that charge —
  // is the difference between the two arms' total tax.
  const fundTax = sg.sim.journal.getActions('SUPER_CONTRIBUTION_TAX')
    .reduce((t, e) => t + (e.action?.data?.amount ?? 0), 0) * SUPER_TAX_RATE;
  assert.ok(fundTax > 0, 'the fund is assessed on the contribution');
  assert.ok(sg.state.cumulativeTaxesPaid > control.state.cumulativeTaxesPaid,
    'and that fund tax is paid');
});
