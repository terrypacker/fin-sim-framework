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
 * evt-company-sale.test.mjs
 * Tests for the CompanyEquity asset and its liquidity event (design 49):
 *
 * EVT-51  Company Sale   − basis   US: capital gain (LTCG)   AU: capital gain if resident
 *
 * The CompanyEquity asset sits on the balance sheet (kind: 'company'), appreciates
 * annually, and liquidates at plannedSaleYear via the COMPANY_SALE →
 * COMPANY_SALE_APPLY → COMPANY_SALE_TAX pathway owned by US_INCOME + US_TAX.
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';
import { computeNetWorth } from '../../src/finance/derived-metrics/net-worth.js';

beforeEach(() => ServiceRegistry.resetAll());

// ─── Scenario JSON configs ────────────────────────────────────────────────────

function usCompanyConfig(overrides = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'US_COMPANY_SALE'],
    simStart: '2026-01-01',
    simEnd:   '2041-01-01',
    parameters: {},
    persons: [
      {
        __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1975-04-15',
        citizen: ['US'], lifeExpectancy: 90, monthlyWage: 0,
        retirementDate: '2025-01-01', socialSecurityMonthly: 0,
      },
    ],
    accounts: [
      {
        __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings', type: 'savings',
        role: 'us-savings', stateKey: 'usSavingsAccount', initialValue: 5000,
        ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0,
        country: 'US', currency: { code: 'USD', symbol: '$' },
      },
    ],
    companyEquities: [
      {
        __type: 'CompanyEquity', id: 'com1', name: 'Startup Equity',
        value: 500_000, costBasis: 50_000, appreciationRate: 0,
        plannedSaleYear: 2027, ownershipType: 'sole', ownerId: 'primary',
        country: 'US', stateKey: 'companyEquityAccount',
        ...overrides,
      },
    ],
  };
}

function auCompanyConfig() {
  return {
    toolsets: ['AU_RETIREMENT', 'US_TAX', 'US_COMPANY_SALE'],
    simStart: '2026-01-01',
    simEnd:   '2041-01-01',
    parameters: {},
    persons: [
      {
        __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1975-04-15',
        citizen: ['AU'], lifeExpectancy: 90, monthlyWage: 0,
        retirementDate: '2025-01-01', socialSecurityMonthly: 0,
      },
    ],
    accounts: [
      {
        __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings', type: 'savings',
        role: 'au-savings', stateKey: 'auSavingsAccount', initialValue: 5000,
        ownershipType: 'sole', ownerId: 'primary', minimumBalance: 2000,
        country: 'AU', currency: { code: 'AUD', symbol: 'A$' },
      },
      {
        __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings', type: 'savings',
        role: 'us-savings', stateKey: 'usSavingsAccount', initialValue: 5000,
        ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0,
        country: 'US', currency: { code: 'USD', symbol: '$' },
      },
    ],
    companyEquities: [
      {
        __type: 'CompanyEquity', id: 'com1', name: 'Startup Equity',
        value: 500_000, costBasis: 50_000, appreciationRate: 0,
        plannedSaleYear: 2027, ownershipType: 'sole', ownerId: 'primary',
        country: 'US', stateKey: 'companyEquityAccount',
      },
    ],
  };
}

// ─── Helper ───────────────────────────────────────────────────────────────────

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

// Step past planned sale year 2027.
const Q1_2028 = new Date(Date.UTC(2028, 2, 31));

// ══════════════════════════════════════════════════════════════════════════════
// EVT-51: Company Sale — asset seeding + net worth
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-51: company equity seeds onto the balance sheet before sale', () => {
  const { sim } = loadToolsetScenario(usCompanyConfig());
  const eq = sim.state.companyEquityAccount;
  assert.ok(eq, 'companyEquityAccount should be seeded in state');
  assert.strictEqual(eq.kind, 'company');
  assert.strictEqual(eq.value, 500_000);
});

test('EVT-51: company equity contributes to net worth before sale', () => {
  const { sim } = loadToolsetScenario(usCompanyConfig());
  // 5,000 savings + 500,000 stake
  assert.strictEqual(computeNetWorth(sim.state), 505_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-51: Company Sale — liquidity event
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-51: company sale credits full sale price to the destination account', () => {
  const { sim } = loadToolsetScenario(usCompanyConfig());
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const applyEntries = sim.journal.getActions('COMPANY_SALE_APPLY');
  assert.ok(applyEntries.length > 0);
  const balanceDiff = applyEntries[0].stateDiff.find(d => d.field === 'usSavingsAccount.balance');
  assert.strictEqual(balanceDiff.delta, 500_000);
});

test('EVT-51: company sale zeroes out the companyEquity value', () => {
  const { sim } = loadToolsetScenario(usCompanyConfig());
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const applyEntries = sim.journal.getActions('COMPANY_SALE_APPLY');
  assert.ok(applyEntries.length > 0);
  const valueDiff = applyEntries[0].stateDiff.find(d => d.field === 'companyEquityAccount.value');
  assert.strictEqual(valueDiff.after, 0);
});

test('EVT-51: company sale records gain as usCapitalGainsYTD (LTCG)', () => {
  const { sim } = loadToolsetScenario(usCompanyConfig());
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const taxEntries = sim.journal.getActions('COMPANY_SALE_TAX');
  assert.ok(taxEntries.length > 0);
  const gainsDiff = taxEntries[0].stateDiff.find(d => d.field === 'usCapitalGainsYTD');
  assert.strictEqual(gainsDiff.delta, 450_000); // 500,000 − 50,000
});

test('EVT-51: company sale with no gain records zero capital gain', () => {
  const { sim } = loadToolsetScenario(usCompanyConfig({ costBasis: 500_000 }));
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const taxEntries = sim.journal.getActions('COMPANY_SALE_TAX');
  assert.ok(taxEntries.length > 0);
  const gainsDiff = taxEntries[0].stateDiff.find(d => d.field === 'usCapitalGainsYTD');
  assert.ok(gainsDiff == null || gainsDiff.delta === 0);
});

test('EVT-51: company sale records gain as AU capital gain + FTC if AU resident', () => {
  const { sim } = loadToolsetScenario(auCompanyConfig());
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const taxEntries = sim.journal.getActions('COMPANY_SALE_TAX');
  assert.ok(taxEntries.length > 0);
  // Both the US federal and the additive AU dynamic reducer (design 57 §6.5) process
  // this action — search all entries rather than assuming the federal is [0].
  const allDiffs = taxEntries.flatMap(e => e.stateDiff);
  const auGainsDiff = allDiffs.find(d => d.field === 'auCapitalGainsYTD');
  assert.strictEqual(auGainsDiff.delta, 450_000);
  const ftcDiff = allDiffs.find(d => d.field === 'usSourceCapGainsUsdYTD');
  assert.ok(ftcDiff != null && ftcDiff.delta > 0, 'FTC should be recorded for AU resident');
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-51: Company Sale — appreciation lifts the sale price
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-51: company equity appreciates before the sale year', () => {
  // No sale — verify the stake grows year over year.
  const { sim } = loadToolsetScenario(usCompanyConfig({ appreciationRate: 0.10, plannedSaleYear: null }));
  assert.doesNotThrow(() => sim.stepTo(new Date(Date.UTC(2029, 0, 31))));
  assert.ok(sim.state.companyEquityAccount.value > 500_000,
    'appreciating stake should exceed its initial value after several years');
});

test('EVT-51: an appreciated company sale sells at the grown value (gain > nominal)', () => {
  const { sim } = loadToolsetScenario(usCompanyConfig({ appreciationRate: 0.10, plannedSaleYear: 2030 }));
  assert.doesNotThrow(() => sim.stepTo(new Date(Date.UTC(2031, 0, 31))));

  const applyEntries = sim.journal.getActions('COMPANY_SALE_APPLY');
  assert.ok(applyEntries.length > 0);
  const salePrice = applyEntries[0].action.data.salePrice;
  assert.ok(salePrice > 500_000, 'appreciated sale price should exceed the initial 500,000 value');

  const taxEntries = sim.journal.getActions('COMPANY_SALE_TAX');
  const gainsDiff = taxEntries[0].stateDiff.find(d => d.field === 'usCapitalGainsYTD');
  assert.strictEqual(gainsDiff.delta, salePrice - 50_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// Design 72 §2: the chosen sale destination must actually receive the proceeds
//
// The asset editors persist `saleDestinationAccount` as `stateKey ?? id`, so a
// destination chosen before the account had a stateKey — every UI-created
// account — is stored as a bare account **id**. Runtime state carries stateKey
// but not id, so an unnormalized id silently missed and the proceeds fell back
// to the country cash pool, where they earned the savings rate instead of the
// chosen account's returns for the rest of the run (Gap 2).
// ══════════════════════════════════════════════════════════════════════════════

function usCompanyConfigWithBrokerage(saleDestinationAccount) {
  const cfg = usCompanyConfig({ saleDestinationAccount });
  cfg.toolsets = ['US_RETIREMENT', 'US_BROKERAGE', 'US_COMPANY_SALE'];
  cfg.accounts.push({
    __type: 'BrokerageAccount', id: 'ac45', name: 'Shared Brokerage', type: 'brokerage',
    role: 'us-stock', stateKey: 'sharedBrokerageAccount', initialValue: 100_000, balance: 100_000,
    ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0, drawdownPriority: 2,
    country: 'US', currency: { code: 'USD', symbol: '$' },
  });
  return cfg;
}

/** Balance delta the COMPANY_SALE_APPLY entry wrote to `key`. */
function saleCreditTo(sim, key) {
  const [entry] = sim.journal.getActions('COMPANY_SALE_APPLY');
  assert.ok(entry, 'expected a COMPANY_SALE_APPLY journal entry');
  return entry.stateDiff.find(d => d.field === `${key}.balance`)?.delta ?? 0;
}

test('D72-2: sale destination given as a stateKey credits that account', () => {
  const { sim } = loadToolsetScenario(usCompanyConfigWithBrokerage('sharedBrokerageAccount'));
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  assert.strictEqual(saleCreditTo(sim, 'sharedBrokerageAccount'), 500_000);
  assert.strictEqual(saleCreditTo(sim, 'usSavingsAccount'), 0);
});

test('D72-2: sale destination given as an account id credits that account, not cash', () => {
  const { sim } = loadToolsetScenario(usCompanyConfigWithBrokerage('ac45'));
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  assert.strictEqual(saleCreditTo(sim, 'sharedBrokerageAccount'), 500_000);
  assert.strictEqual(saleCreditTo(sim, 'usSavingsAccount'), 0);
});

test('D72-2: an unresolvable sale destination still falls back to the cash pool', () => {
  const { sim } = loadToolsetScenario(usCompanyConfigWithBrokerage('no-such-account'));
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  assert.strictEqual(saleCreditTo(sim, 'usSavingsAccount'), 500_000);
});
