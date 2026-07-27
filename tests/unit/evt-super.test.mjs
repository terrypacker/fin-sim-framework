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
 * evt-super.test.mjs
 * Tests for Superannuation events: EVT-20 through EVT-23
 *
 * EVT-20  Super Contribution          +contribution  out of AU cash pool  AU: always super tax (15%), no US tax, no FTC
 * EVT-21  Super Withdrawal-Contrib    -contribution  into AU cash pool    min age 60 (enforced, no numeric penalty),
 *                                                                          no US tax, no AU tax
 * EVT-22  Super Withdrawal-Earnings   -earnings      into AU cash pool    min age 60 (enforced),
 *                                                                          US: ordinary income, no AU tax
 * EVT-23  Super Earnings              +earnings      stays in account     AU: always super tax, no US tax, no FTC
 *
 * Run with: node --test tests/unit/evt-super.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

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

function makeSuperConfig({
  initialChecking    = 20000,
  initialAuSavings   = 50000,
  superBalance       = 0,
  superContribBasis  = 0,
  superEarningsBasis = 0,
  superGrowthRate    = 0,
  birthDate          = '1966-01-01', // turns 60 on 2026-01-01
} = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER'],
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
    parameters: {
      monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
      rothGrowthRate: 0, iraGrowthRate: 0, k401GrowthRate: 0,
      brokerageGrowthRate: 0, brokerageDividendRate: 0, fixedIncomeInterestRate: 0,
      usSavingsInterestRate: 0, auSavingsInterestRate: 0,
      superGrowthRate, auStockGrowthRate: 0, auStockDividendRate: 0,
    },
    persons: [{
      __type: 'Person', id: 'primary', name: 'Primary', birthDate,
      citizen: ['AU'], lifeExpectancy: 90, monthlyWage: 0,
      retirementDate: '2025-01-01', socialSecurityMonthly: 0,
    }],
    accounts: [
      {
        __type: 'SavingsAccount', id: 'checking', name: 'Checking',
        role: 'us-savings', stateKey: 'checkingAccount',
        initialValue: initialChecking, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
      },
      {
        __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings',
        role: 'au-savings', stateKey: 'auSavingsAccount',
        initialValue: initialAuSavings, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: '$' },
      },
      {
        __type: 'SuperannuationAccount', id: 'super', name: 'Super',
        role: 'super', stateKey: 'superAccount',
        initialValue: superBalance, contributionBasis: superContribBasis,
        earningsBasis: superEarningsBasis,
        ownershipType: 'sole', ownerId: 'primary',
        country: 'AU', currency: { code: 'AUD', symbol: '$' },
      },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-20: Superannuation Contribution
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-20: Super contribution credits the balance NET of the 15% contributions tax', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({ initialAuSavings: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // Design 77 §5.2 — the fund deducts the Div 295 contributions tax on receipt, so
  // 5,000 gross contributed lands as 4,250. Pre-77 the full 5,000 was credited and
  // the 750 was later taken out of the member's own AU cash at the annual settle.
  assert.strictEqual(sim.state.superAccount.balance, 4250);
  assert.strictEqual(sim.state.superAccount.contributionBasis, 4250);
  assert.strictEqual(sim.state.superAccount.earningsBasis, 0);
});

test('EVT-20: Super contribution debits AU cash pool (auSavingsAccount)', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({ initialAuSavings: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // Super contribution debits AU cash pool = auSavingsAccount ?? checkingAccount
  assert.strictEqual(sim.state.auSavingsAccount.balance, 5000);
  assert.strictEqual(sim.state.checkingAccount.balance, 20000); // unchanged
});

test('EVT-20: Super contribution is always AU super taxable (15%)', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({ initialAuSavings: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // In the toolset path, state.people and state.superAccount are non-null → per-person maps used
  assert.strictEqual(sim.state.auPersonSuperTaxYTD?.['primary'], 750); // 15% of 5000
});

test('EVT-20: Super contribution is not a US taxable event', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({ initialAuSavings: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-21: Super Withdrawal — Contributions
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-21: Super contribution withdrawal at age 60+ succeeds', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 20000,
    superContribBasis: 20000,
    birthDate: '1966-01-01', // age 60 in 2026
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'SUPER_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.superWithdrawalBlocked, false);
  // Withdrawal credits AU cash pool (auSavingsAccount)
  assert.strictEqual(sim.state.auSavingsAccount.balance, 10000);
  assert.strictEqual(sim.state.superAccount.balance, 15000);
});

test('EVT-21: Super contribution withdrawal before age 60 is blocked', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 20000,
    superContribBasis: 20000,
    birthDate: '1990-01-01', // age 36 in 2026
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.superWithdrawalBlocked, true);
  assert.strictEqual(sim.state.auSavingsAccount.balance, 5000); // unchanged
  assert.strictEqual(sim.state.superAccount.balance, 20000);    // unchanged
});

test('EVT-21: Super contribution withdrawal has no US or AU tax', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 20000,
    superContribBasis: 20000,
    birthDate: '1966-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'SUPER_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auPersonSuperTaxYTD?.['primary'], 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-22: Super Withdrawal — Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-22: Super earnings withdrawal at age 60+ succeeds', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 20000,
    superEarningsBasis: 20000,
    birthDate: '1966-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'SUPER_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.superWithdrawalBlocked, false);
  // Withdrawal credits AU cash pool (auSavingsAccount)
  assert.strictEqual(sim.state.auSavingsAccount.balance, 10000);
});

test('EVT-22: Super earnings withdrawal before age 60 is blocked', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 20000,
    superEarningsBasis: 20000,
    birthDate: '1990-01-01',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.superWithdrawalBlocked, true);
  assert.strictEqual(sim.state.auSavingsAccount.balance, 5000); // unchanged
});

test('EVT-22: Super earnings withdrawal is US ordinary income taxable', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 20000,
    superEarningsBasis: 20000,
    birthDate: '1966-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'SUPER_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 5000 / sim.state.effectiveExchangeRates.USD_AUD); // design 51: AUD-source → USD bucket
});

test('EVT-22: Super earnings withdrawal has no AU tax', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 20000,
    superEarningsBasis: 20000,
    birthDate: '1966-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'SUPER_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auPersonSuperTaxYTD?.['primary'], 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-23: Super Earnings
// ══════════════════════════════════════════════════════════════════════════════

// The default member in makeSuperConfig turns 60 on 2026-01-01, i.e. is already in
// pension phase. Design 77 extended the pension-phase gate to the DIRECT
// SUPER_EARNINGS path too (it previously applied only to the scheduled
// INTL_SUPER_EARNINGS path), so these accumulation-phase cases must say so.
const ACCUMULATION = { birthDate: '1990-01-01' };

test('EVT-23: Super earnings increase superAccount balance and earningsBasis, net of fund tax', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    superBalance: 100000, superContribBasis: 100000, ...ACCUMULATION,
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_EARNINGS', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // Design 77 §5.1 — 7,000 of gross fund earnings, less the 15% Div 295 earnings
  // tax the fund pays out of its own assets, credits 5,950 to the member.
  assert.strictEqual(sim.state.superAccount.balance, 105950);
  assert.strictEqual(sim.state.superAccount.earningsBasis, 5950);
  assert.strictEqual(sim.state.superAccount.contributionBasis, 100000); // unchanged
});

test('EVT-23: the DIRECT earnings path is pension-phase exempt too (member ≥ 60)', () => {
  // Default birthDate — member is 60. Design 77 §5.1: the direct path used to tax
  // this at 15% while the scheduled path exempted it, so the same member got a
  // different answer depending on which event fired.
  const { sim } = loadToolsetScenario(makeSuperConfig({ superBalance: 100000, superContribBasis: 100000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_EARNINGS', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auPersonSuperTaxYTD?.['primary'], 0);
  assert.strictEqual(sim.state.superAccount.balance, 107000); // full gross, untaxed
});

test('EVT-23: Super earnings stay in account — no cash pool transaction', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 100000,
    superContribBasis: 100000,
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_EARNINGS', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auSavingsAccount.balance, 5000); // unchanged
  assert.strictEqual(sim.state.checkingAccount.balance, 20000); // unchanged
});

test('EVT-23: Super earnings are AU super taxable (15%) in accumulation phase', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    superBalance: 100000, superContribBasis: 100000, ...ACCUMULATION,
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_EARNINGS', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // In the toolset path, state.people and state.superAccount are non-null → per-person maps used.
  // The accrual is on the GROSS earnings even though only the net was credited.
  assert.strictEqual(sim.state.auPersonSuperTaxYTD?.['primary'], 1050); // 15% of 7000
});

test('EVT-23: Super earnings are not US taxable', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({ superBalance: 100000, superContribBasis: 100000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_EARNINGS', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-23: Pension-phase exemption (design/36 §12.1)
//
// Super fund earnings are taxed 15% in accumulation phase, but 0% once the
// member reaches pension/retirement phase (age ≥ 60, condition-of-release proxy).
// These exercise the real scheduled INTL_SUPER_EARNINGS → SuperEarningsHandler
// path (the toolset wires it year-end, startOffset 1, so the first accrual lands
// in the second sim year, ~end of 2027).
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-23: super earnings taxed at 15% in accumulation phase (member < 60)', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    superBalance: 100000, superContribBasis: 100000,
    superGrowthRate: 0.07,
    birthDate: '1990-01-01', // age ~37 — accumulation phase
  }));
  // Sample after exactly one year-end earnings event. Earnings now accrue from
  // the first sim year-end (2026-12-31, startOffset 0), so step to early 2027 to
  // capture a single year of 7% growth (the prior startOffset(1) fired at 2027).
  sim.stepTo(new Date(2027, 0, 15));

  // 7000 of GROSS earnings accrued, the fund paid 1050 of Div 295 tax out of them,
  // and 5950 reached the member (design 77 §5.1).
  assert.strictEqual(sim.state.superAccount.balance, 105950);
  assert.strictEqual(sim.state.auPersonSuperTaxYTD?.['primary'], 1050); // 15% of 7000
});

test('EVT-23: the fund earnings tax never touches the member’s own cash (design 77)', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 50000,
    superBalance: 100000, superContribBasis: 100000,
    superGrowthRate: 0.07,
    birthDate: '1990-01-01', // accumulation phase — tax is actually levied
  }));
  const before = sim.state.auSavingsAccount.balance;
  // Step past the AU FY settle (30 June) that follows the first year-end accrual,
  // which is where the pre-77 code turned auSuperTaxYTD into an AU_TAX_PAYMENT_DEBIT.
  sim.stepTo(new Date(2027, 7, 1));

  // The whole point of design 77: super fund tax is withheld inside the fund, so it
  // is invisible to AU savings. The balance can only have moved by ordinary interest.
  assert.ok(
    sim.state.auSavingsAccount.balance >= before,
    `AU savings fell from ${before} to ${sim.state.auSavingsAccount.balance} — the super `
    + `fund tax is being debited from the member's cash again`,
  );
});

test('EVT-23: super earnings tax-free in pension phase (member ≥ 60)', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    superBalance: 100000, superContribBasis: 100000,
    superGrowthRate: 0.07,
    birthDate: '1962-01-01', // age ~65 — pension/retirement phase
  }));
  // One year-end earnings event (startOffset 0 → first accrual 2026-12-31).
  sim.stepTo(new Date(2027, 0, 15));

  // Earnings still accrue and compound...
  assert.strictEqual(sim.state.superAccount.balance, 107000);
  // ...but attract NO super earnings tax (pension-phase exemption).
  assert.strictEqual(sim.state.auPersonSuperTaxYTD?.['primary'], 0);
});
