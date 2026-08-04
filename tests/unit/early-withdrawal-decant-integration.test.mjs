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
 * early-withdrawal-decant-integration.test.mjs — design 45 Phase 1.
 *
 * Drives the scheduled decant lever through the REAL compile → schedule → run
 * engine (not the isolated reducer), covering what the unit tests can't:
 *   A. the toolset → EarlyWithdrawalPolicyHandler → ScheduledEarlyWithdrawalApplyReducer
 *      → tax-chain path actually fires and lands net cash in brokerage;
 *   B. Q2 same-date ordering — a Roth conversion and an early withdrawal in the
 *      same pre-move year apply conversion-FIRST (the withdrawal draws against
 *      the post-conversion IRA), proven by the brokerage net it produces;
 *   C. the §2 amplification end to end — decant lands at market basis, grows
 *      while US-resident, and the AU residency step-up forgives that pre-move
 *      gain at a moveYear-driven CHANGE_RESIDENCY.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

function loadToolsetScenario(config) {
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(config.simStart),
    simEnd:   new Date(config.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(structuredClone(config), services);
  return { scenario, sim: scenario.sim };
}

/**
 * Primary is 47 in 2027 (born 1980) → below every age gate, so the 10% penalty
 * applies. IRA 100k (40k contrib / 60k earnings), empty Roth + brokerage.
 */
function makeConfig({
  earlyWithdrawalSchedule = [],
  rothConversionEnabled   = false,
  rothConversionSchedule  = [],
  brokerageGrowthRate     = 0,
  moveYear                = null,
  simEnd                  = '2028-01-01',
  monthlyExpenses         = 0,
  checkingInitial         = 20_000,
  brokerageInitial        = 0,
  brokerageEarningsBasis  = 0,
  earlyWithdrawalBeforeBrokerage = false,
  earlyWithdrawalStartYear = null,
  earlyWithdrawalEndYear   = null,
} = {}) {
  return {
    toolsets: ['US_EARLY_WITHDRAWAL', 'US_ROTH_CONVERSION', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER'],
    simStart: '2026-01-01',
    simEnd,
    parameters: {
      monthlyExpenses, inflationAdjust: false, inflationRate: 0,
      rothGrowthRate: 0, iraGrowthRate: 0, k401GrowthRate: 0,
      brokerageGrowthRate, brokerageDividendRate: 0, fixedIncomeInterestRate: 0,
      usSavingsInterestRate: 0, auSavingsInterestRate: 0,
      superGrowthRate: 0, auStockGrowthRate: 0, auStockDividendRate: 0,
      startingResidency: 'US',
      moveYear,
      // TAXABLE_FIRST triggers the accountPriority cascade so every account gets a
      // role-based drawdownPriority (IRA reachable as a drawdown source, not null).
      drawdownStrategy: 'TAXABLE_FIRST',
      rothConversionEnabled, rothConversionSchedule, rothConversionOwner: 'primary',
      earlyWithdrawalEnabled: true, earlyWithdrawalOwner: 'primary', earlyWithdrawalSchedule,
      earlyWithdrawalBeforeBrokerage,
      earlyWithdrawalStartYear, earlyWithdrawalEndYear,
    },
    persons: [{
      __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1980-01-01',
      citizen: ['US'], lifeExpectancy: 90, monthlyWage: 0,
      retirementDate: '2025-01-01', socialSecurityMonthly: 0,
    }],
    accounts: [
      {
        __type: 'SavingsAccount', id: 'checking', name: 'Checking',
        role: 'us-savings', stateKey: 'checkingAccount',
        initialValue: checkingInitial, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
      },
      {
        __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings',
        role: 'au-savings', stateKey: 'auSavingsAccount',
        initialValue: 0, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: '$' },
      },
      {
        __type: 'TraditionalIRAAccount', id: 'ira', name: 'IRA',
        role: 'ira', stateKey: 'iraAccount',
        initialValue: 100_000, contributionBasis: 40_000, earningsBasis: 60_000,
        ownershipType: 'sole', ownerId: 'primary',
        country: 'US', currency: { code: 'USD', symbol: '$' },
      },
      {
        __type: 'RothAccount', id: 'roth', name: 'Roth IRA',
        role: 'roth-ira', stateKey: 'rothAccount',
        initialValue: 0, contributionBasis: 0, earningsBasis: 0,
        rolloverContribBasis: 0, rolloverEarningsBasis: 0,
        ownershipType: 'sole', ownerId: 'primary',
        country: 'US', currency: { code: 'USD', symbol: '$' },
      },
      {
        __type: 'BrokerageAccount', id: 'stock', name: 'US Stock',
        type: 'brokerage', role: 'us-stock', stateKey: 'usStockAccount',
        initialValue: brokerageInitial, contributionBasis: brokerageInitial - brokerageEarningsBasis,
        earningsBasis: brokerageEarningsBasis, loanBalance: 0,
        ownershipType: 'sole', ownerId: 'primary',
        country: 'US', currency: { code: 'USD', symbol: '$' }, drawdownPriority: 2,
      },
    ],
  };
}

const near = (a, b, eps = 1) => Math.abs(a - b) < eps;

// ── A. Engine wiring: schedule → handler → reducer → tax chain ──────────────────

test('integration: a scheduled decant draws the IRA and lands net cash in brokerage', () => {
  const { sim } = loadToolsetScenario(makeConfig({
    earlyWithdrawalSchedule: [{ year: 2027, taxDeferredAmount: 50_000 }],
  }));
  // Mid-December: after the Dec 1 draw, before the Dec 31 settle resets the YTD.
  sim.stepTo(new Date('2027-12-15'));

  // 50k gross from the IRA; net 45k (10% penalty) into brokerage.
  assert.ok(near(sim.state.iraAccount.balance,    50_000), `IRA ${sim.state.iraAccount.balance}`);
  assert.ok(near(sim.state.usStockAccount.balance, 45_000), `brokerage ${sim.state.usStockAccount.balance}`);
  // The whole traditional-IRA draw was recognized as US ordinary income (tax chain fired).
  assert.ok(sim.state.usOrdinaryIncomeYTD > 0, 'IRA withdrawal recognized as ordinary income');
  // Cash landed at cost: holdings back the balance with zero unrealized gain (design 53 §2;
  // basis ledger retired, holdings are the CGT source).
  const brok = sim.state.usStockAccount;
  const mv = brok.holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
  const cb = brok.holdings.reduce((s, h) => s + (h?.costBasis ?? 0), 0);
  assert.ok(near(mv, brok.balance), `Σmv ${mv} == balance ${brok.balance}`);
  assert.ok(near(mv - cb, 0), `unrealized gain ${mv - cb} should be ~0`);
});

// ── B. Q2 ordering: conversion applies before the same-date withdrawal ──────────

test('integration: a same-year conversion applies BEFORE the withdrawal (Q2 ordering)', () => {
  const { sim } = loadToolsetScenario(makeConfig({
    rothConversionEnabled:  true,
    rothConversionSchedule: [{ year: 2027, incomeTarget: 60_000 }],   // converts 60k IRA→Roth
    earlyWithdrawalSchedule: [{ year: 2027, taxDeferredAmount: 60_000 }],
  }));
  sim.stepTo(new Date('2027-12-31'));

  // Conversion-first: IRA 100k → 40k (convert 60k) → 0 (withdraw the remaining 40k,
  // capped to the post-conversion balance). Net of the 40k draw = 36k to brokerage.
  // Were the order reversed, the withdrawal would take 60k first and the brokerage
  // would hold 54k — so 36k uniquely proves conversion ran first.
  assert.ok(near(sim.state.rothAccount.balance,   60_000), `Roth ${sim.state.rothAccount.balance}`);
  assert.ok(near(sim.state.iraAccount.balance,         0), `IRA ${sim.state.iraAccount.balance}`);
  assert.ok(near(sim.state.usStockAccount.balance, 36_000), `brokerage ${sim.state.usStockAccount.balance}`);
});

// ── C. §2 amplification end to end: decant → grow → AU step-up forgives gain ─────

test('integration: pre-move growth on the decant is forgiven by the AU step-up at the move', () => {
  const { sim } = loadToolsetScenario(makeConfig({
    earlyWithdrawalSchedule: [{ year: 2027, taxDeferredAmount: 50_000 }],
    brokerageGrowthRate:     0.10,
    moveYear:                2028,           // CHANGE_RESIDENCY fires Jul 1 2028
    simEnd:                  '2029-01-01',
  }));
  sim.stepTo(new Date('2028-12-31'));

  const brok = sim.state.usStockAccount;
  // The 45k decant grew while US-resident, so there is a real pre-move gain...
  assert.ok(brok.balance > 45_000, `brokerage grew past the 45k decant: ${brok.balance}`);
  // ...and the AU residency cost-base step-up forgave it (design 36 §12.2). Under the
  // per-lot mechanism (design 53 P1) the step-up stamps each lot's AU base up to market
  // value at the move, so the AU basis exceeds the (original) US cost basis.
  const auBase  = brok.holdings.reduce((s, h) => s + (h.costBaseByCountry?.AU ?? 0), 0);
  const usBasis = brok.holdings.reduce((s, h) => s + (h.costBasis ?? 0), 0);
  assert.ok(auBase > usBasis, `AU step-up basis (${auBase}) exceeds US cost basis (${usBasis}) → pre-move gain forgiven for AU`);
});

// ── (B) drawdown-ordering variant through the engine (design 45 §7) ─────────────

/** Real spending deficit (48k/yr expenses, 6k cash) with a 40k taxable brokerage
 *  and a 100k IRA; the person (47) is below the age gate. */
function deficitConfig(earlyWithdrawalBeforeBrokerage) {
  return makeConfig({
    monthlyExpenses: 4_000, checkingInitial: 6_000,
    brokerageInitial: 40_000, brokerageEarningsBasis: 10_000,
    earlyWithdrawalBeforeBrokerage,
  });
}

test('integration (B): default — a deficit sells taxable brokerage, sparing the IRA', () => {
  const { sim } = loadToolsetScenario(deficitConfig(false));
  sim.stepTo(new Date('2027-12-15'));   // ~a year of deficits, before the year-end settle

  // Brokerage is liquidated first (Phase 1) and exhausted; the IRA covers only the
  // remainder, so a large IRA balance survives.
  assert.ok(sim.state.usStockAccount.balance <  5_000, `brokerage sold first: ${sim.state.usStockAccount.balance}`);
  assert.ok(sim.state.iraAccount.balance      > 30_000, `IRA only partly drawn: ${sim.state.iraAccount.balance}`);
});

test('integration (B): flag on — the same deficit draws the IRA early, sparing brokerage', () => {
  const { sim } = loadToolsetScenario(deficitConfig(true));
  sim.stepTo(new Date('2027-12-15'));

  // Penalty early withdrawal runs first and exhausts the IRA; the taxable brokerage
  // is held back and only lightly tapped as the Phase-3 backstop — the mirror image.
  assert.ok(sim.state.usStockAccount.balance > 25_000, `brokerage largely spared: ${sim.state.usStockAccount.balance}`);
  assert.ok(sim.state.iraAccount.balance      <  5_000, `IRA drawn first: ${sim.state.iraAccount.balance}`);
});

// ── A↔B precedence: the scheduled decant and the fallback ordering compose (Q3) ──

test('integration (A+B): scheduled decant and the (B) fallback compose without double-draw', () => {
  const { sim } = loadToolsetScenario(makeConfig({
    earlyWithdrawalSchedule: [{ year: 2027, taxDeferredAmount: 30_000 }], // (A) deliberate decant
    earlyWithdrawalBeforeBrokerage: true,                                 // (B) penalty before brokerage
    monthlyExpenses: 2_000, checkingInitial: 6_000,
    brokerageInitial: 5_000, brokerageEarningsBasis: 0,
  }));
  sim.stepTo(new Date('2027-12-15'));

  // (A) lands its 30k decant net (~27k) in brokerage; (B) covers the year's deficits
  // from the IRA first, sparing the small brokerage. The IRA is therefore drawn by
  // BOTH — well past A's 30k alone — and the two never double-draw the same dollars
  // because (B) is deficit-sized against the balance (A) already lowered (§9 Q3).
  assert.ok(sim.state.usStockAccount.balance > 30_000, `A's decant landed + spared by B: ${sim.state.usStockAccount.balance}`);
  assert.ok(sim.state.iraAccount.balance      < 60_000, `IRA drawn by both A and B: ${sim.state.iraAccount.balance}`);
});

// ── (Phase 3) the opt-in window seeds tunable placeholder events in the live queue ─

test('integration (Phase 3): the optimization window seeds 0-amount placeholder events the cockpit can tune', () => {
  const { sim } = loadToolsetScenario(makeConfig({
    earlyWithdrawalStartYear: 2027, earlyWithdrawalEndYear: 2028,
  }));
  // Before stepping, the compiled queue holds a placeholder per window year — what
  // the EARLY_WITHDRAWAL cockpit lever re-targets (snapshot rollouts can only tune
  // EXISTING events). No explicit schedule ⇒ they start at 0 (handler no-ops).
  const ew = sim.queue.data.filter(e => e.type === 'SCHEDULED_EARLY_WITHDRAWAL');
  assert.deepStrictEqual(ew.map(e => new Date(e.date).getUTCFullYear()).sort(), [2027, 2028]);
  assert.ok(ew.every(e => e.data.taxDeferredAmount === 0 && e.data.rothAmount === 0));
});

// ── D. Design 84 G9: a decant deep enough to reach converted principal ──────────

test('integration: decanting converted principal reports it as a conversion, not as earnings', () => {
  // 2027 converts 60k IRA→Roth. The IRA holds 40k contributions and 60k earnings, so
  // pro-rata (design 84 Option 2b) sends 36k across as Roth EARNINGS and 24k as Roth
  // corpus. The 36k is trust income s99B(2)(a) refuses the corpus exemption to. 2028
  // then empties the wrapper. Before design 84 G9 the ledger had no idea the rollover
  // buckets existed: it capped the draw at contributionBasis + earningsBasis (both
  // zero here), so the whole 60k left the Roth with no basis reduction and no tax
  // action at all.
  const { sim } = loadToolsetScenario(makeConfig({
    rothConversionEnabled:   true,
    rothConversionSchedule:  [{ year: 2027, incomeTarget: 60_000 }],
    earlyWithdrawalSchedule: [{ year: 2028, rothAmount: 60_000 }],
    moveYear:                2027,          // AU-resident by the 2028 decant
    simEnd:                  '2029-01-01',
  }));
  sim.stepTo(new Date('2028-12-15'));

  const roth = sim.state.rothAccount;
  assert.ok(near(roth.balance, 0), `Roth emptied: ${roth.balance}`);
  // The ledger emptied with it — the leak was that it did not.
  assert.ok(near(roth.rolloverContribBasis ?? 0, 0), `rolloverContribBasis ${roth.rolloverContribBasis}`);
  assert.strictEqual((roth.rolloverConversions ?? []).length, 0, 'the conversion lot was consumed');

  // Primary is 48 in 2028 and the conversion was 2027, so the corpus leg is inside
  // the §408A(d)(3)(F) five-year window and is recaptured at 10%; the earnings leg
  // carries §72(t) at the same 10%. Either way the whole 60k is penalised once.
  assert.ok(sim.state.usPenaltyYTD > 0, 'the recapture penalty reached the US return');
  assert.ok(near(sim.state.usPenaltyYTD, 6_000, 10), `penalty ${sim.state.usPenaltyYTD}`);
  // The charge is attributed to the wrapper's owner (design 76), so it lands in the
  // per-person map rather than the household total — the same place the AU return
  // reads it from. 36k USD of IRA-earnings-sourced money, converted to AUD.
  const perPerson = sim.state.auPersonOrdinaryIncomeYTD ?? {};
  const s99b = perPerson.primary ?? 0;
  assert.ok(s99b > 0, `the s99B charge reached the AU return: ${JSON.stringify(perPerson)}`);
  const audPerUsd = s99b / 36_000;
  assert.ok(audPerUsd > 1 && audPerUsd < 2.5, `assessed the 36k IRA-earnings share at ${audPerUsd} AUD/USD`);
  // The corpus leg raised nothing — that is the half s99B(2)(a) exempts.
  assert.ok(near(sim.state.rothAccount.rolloverEarningsBasis ?? 0, 0));
});

test('integration: the same decant while still US-resident raises no Australian income', () => {
  // The control. Same wrapper, same lot, same age — only the residency differs. This
  // is the gap the whole design 84 study turns on, so it is worth pinning that the
  // engine charges it on residency and nothing else.
  const { sim } = loadToolsetScenario(makeConfig({
    rothConversionEnabled:   true,
    rothConversionSchedule:  [{ year: 2027, incomeTarget: 60_000 }],
    earlyWithdrawalSchedule: [{ year: 2028, rothAmount: 60_000 }],
    moveYear:                null,
    simEnd:                  '2029-01-01',
  }));
  sim.stepTo(new Date('2028-12-15'));

  assert.ok(near(sim.state.rothAccount.balance, 0), 'the wrapper still empties');
  assert.ok(near(sim.state.usPenaltyYTD, 6_000, 10), 'the US recapture is unchanged');
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0, 'Australia charges nothing');
  assert.strictEqual((sim.state.auPersonOrdinaryIncomeYTD ?? {}).primary ?? 0, 0);
});
