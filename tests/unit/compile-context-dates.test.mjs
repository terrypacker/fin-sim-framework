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
 * compile-context-dates.test.mjs — the retirement toolsets read the PLAN's dates, not the wall
 * clock. The compile context names them `startDate` / `endDate`; three reads of `simStart` fell
 * back to `new Date()` and two of `simEnd` to null (macro-regimes study flag 17).
 *
 * CTX-1  GUARDRAIL, plan 2020→, retirement 2023 (both before today): no baseline at the start,
 *        RETIREMENT_DATE_REACHED captures it in 2023. With the wall clock, the person counted as
 *        retired at the start and the baseline was dated today.
 * CTX-2  GUARDRAIL, retired before the plan starts: the baseline is captured at the start and
 *        dated the plan start.
 * CTX-3  a late-life care window that begins before the plan ends still runs when the death
 *        falls after the end.
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

function loadScenario(config) {
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(config.simStart),
    simEnd:   new Date(config.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(structuredClone(config), services);
  return scenario.sim;
}

function makeConfig({ simStart, simEnd, retirementDate, parameters = {}, lifeExpectancy = 90 }) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER'],
    simStart, simEnd,
    parameters: {
      monthlyExpenses: 2000, inflationRate: 0, auInflationRate: 0,
      usSavingsInterestRate: 0, auSavingsInterestRate: 0,
      exchangeRateUsdToAud: 1.55, intlTransferFeeUsd: 15,
      ...parameters,
    },
    persons: [{
      __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1966-01-01',
      citizen: ['US'], lifeExpectancy, monthlyWage: 0,
      retirementDate, socialSecurityMonthly: 0,
    }],
    accounts: [
      {
        __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings',
        role: 'us-savings', stateKey: 'usSavingsAccount',
        initialValue: 1_000_000, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
        drawdownPriority: 1,
      },
      {
        __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings',
        role: 'au-savings', stateKey: 'auSavingsAccount',
        initialValue: 0, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: '$' },
      },
    ],
  };
}

const iso = d => (d == null ? null : new Date(d).toISOString().slice(0, 10));

test('CTX-1: a retirement between the plan start and today is scheduled, not assumed', () => {
  const sim = loadScenario(makeConfig({ simStart: '2020-01-01', simEnd: '2025-01-01',
    retirementDate: '2023-01-01', parameters: { spendingStrategy: ['GUARDRAIL'] } }));
  sim.stepTo(new Date('2022-12-01'));
  assert.equal(sim.state.guardrail?.initialWithdrawalRate ?? null, null, 'no baseline before retiring');
  sim.stepTo(new Date('2023-02-01'));
  assert.ok(sim.state.guardrail.initialWithdrawalRate > 0, 'captured at retirement');
  assert.equal(iso(sim.state.guardrail.baselineDate), '2023-01-01');
});

test('CTX-2: retired before the plan starts: baseline at the start, dated the start', () => {
  const sim = loadScenario(makeConfig({ simStart: '2020-01-01', simEnd: '2022-01-01',
    retirementDate: '2019-01-01', parameters: { spendingStrategy: ['GUARDRAIL'] } }));
  assert.ok(sim.state.guardrail.initialWithdrawalRate > 0);
  assert.equal(iso(sim.state.guardrail.baselineDate), '2020-01-01');
});

test('CTX-3: late-life care that starts inside the run still runs when the death is after it', () => {
  // born 1966-01-01, life expectancy 67 ⇒ death 2033-01-01; 24 months of care from 2031-01-01
  const sim = loadScenario(makeConfig({ simStart: '2026-01-01', simEnd: '2032-01-01',
    retirementDate: '2025-01-01', lifeExpectancy: 67,
    parameters: { lateLifeCareMonths: 24, lateLifeCareFactor: 2 } }));
  sim.stepTo(new Date('2030-12-01'));
  const before = sim.state.monthlyExpenses;
  sim.stepTo(new Date('2031-06-01'));
  assert.ok(Math.abs(sim.state.monthlyExpenses - 2 * before) < 0.01,
    `care doubles spending: ${before} → ${sim.state.monthlyExpenses}`);
});
