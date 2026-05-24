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
 * evt-collectible.test.mjs
 * Tests for Collectible events:
 *
 * EVT-36  Sale – Baseball Cards   − basis  US: Collectible gain (28%)  AU: Capital Gain if resident
 * EVT-45  Change in Value (BB)    +/− value  no tax                    no tax
 * EVT-46  Sale – Gold             − basis  US: Collectible gain (28%)  AU: Capital Gain if resident
 * EVT-47  Change in Value (Gold)  +/− value  no tax                    no tax
 *
 * EVT-36 and EVT-46 use the same COLLECTIBLE_SALE event type (different items, same mechanics).
 * EVT-45 and EVT-47 use the same COLLECTIBLE_VALUE_CHANGE event type.
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

// ─── Scenario JSON configs ────────────────────────────────────────────────────

const US_COLLECTIBLE_JSON = {
  toolsets: ['US_RETIREMENT', 'US_COLLECTIBLES'],
  simStart: '2026-01-01',
  simEnd:   '2041-01-01',
  parameters: {},
  persons: [
    {
      __type:                'Person',
      id:                    'primary',
      name:                  'Primary',
      birthDate:             '1975-04-15',
      citizen:               ['US'],
      lifeExpectancy:        90,
      monthlyWage:           0,
      retirementDate:        '2025-01-01',
      socialSecurityMonthly: 0,
    },
  ],
  accounts: [
    {
      __type:         'SavingsAccount',
      id:             'us-savings',
      name:           'US Savings',
      type:           'savings',
      role:           'us-savings',
      stateKey:       'usSavingsAccount',
      initialValue:   5000,
      ownershipType:  'sole',
      ownerId:        'primary',
      minimumBalance: 2_000,
      country:        'US',
      currency:       { code: 'USD', symbol: '$' },
    },
  ],
  collectibles: [
    {
      __type:           'Collectible',
      id:               'col1',
      name:             'Baseball Cards',
      value:            10000,
      costBasis:        7000,
      appreciationRate: 0,
      plannedSaleYear:  2027,
      ownershipType:    'sole',
      ownerId:          'primary',
      country:          'US',
      stateKey:         'collectibleAccount',
    },
  ],
};

// AU resident scenario — isAuResident: true is set by AU_RETIREMENT.
// Includes a US savings account so collectible proceeds have a destination.
const AU_COLLECTIBLE_JSON = {
  toolsets: ['AU_RETIREMENT', 'US_TAX', 'US_COLLECTIBLES'],
  simStart: '2026-01-01',
  simEnd:   '2041-01-01',
  parameters: {},
  persons: [
    {
      __type:                'Person',
      id:                    'primary',
      name:                  'Primary',
      birthDate:             '1975-04-15',
      citizen:               ['AU'],
      lifeExpectancy:        90,
      monthlyWage:           0,
      retirementDate:        '2025-01-01',
      socialSecurityMonthly: 0,
    },
  ],
  accounts: [
    {
      __type:         'SavingsAccount',
      id:             'au-savings',
      name:           'AU Savings',
      type:           'savings',
      role:           'au-savings',
      stateKey:       'auSavingsAccount',
      initialValue:   5000,
      ownershipType:  'sole',
      ownerId:        'primary',
      minimumBalance: 2_000,
      country:        'AU',
      currency:       { code: 'AUD', symbol: 'A$' },
    },
    {
      __type:         'SavingsAccount',
      id:             'us-savings',
      name:           'US Savings',
      type:           'savings',
      role:           'us-savings',
      stateKey:       'usSavingsAccount',
      initialValue:   5000,
      ownershipType:  'sole',
      ownerId:        'primary',
      minimumBalance: 0,
      country:        'US',
      currency:       { code: 'USD', symbol: '$' },
    },
  ],
  collectibles: [
    {
      __type:           'Collectible',
      id:               'col1',
      name:             'Baseball Cards',
      value:            10000,
      costBasis:        7000,
      appreciationRate: 0,
      plannedSaleYear:  2027,
      ownershipType:    'sole',
      ownerId:          'primary',
      country:          'US',
      stateKey:         'collectibleAccount',
    },
  ],
};

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
// EVT-36: Sale – Baseball Cards
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-36: collectible sale credits full sale price to savings', () => {
  const { sim } = loadToolsetScenario(US_COLLECTIBLE_JSON);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const applyEntries = sim.journal.getActions('COLLECTIBLE_SALE_APPLY');
  assert.ok(applyEntries.length > 0);
  const balanceDiff = applyEntries[0].stateDiff.find(d => d.field === 'usSavingsAccount.balance');
  assert.strictEqual(balanceDiff.delta, US_COLLECTIBLE_JSON.collectibles[0].value);
});

test('EVT-36: collectible sale zeroes out collectibleAccount value', () => {
  const { sim } = loadToolsetScenario(US_COLLECTIBLE_JSON);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const applyEntries = sim.journal.getActions('COLLECTIBLE_SALE_APPLY');
  assert.ok(applyEntries.length > 0);
  const valueDiff = applyEntries[0].stateDiff.find(d => d.field === 'collectibleAccount.value');
  assert.strictEqual(valueDiff.after, 0);
});

test('EVT-36: collectible sale records gain as usCollectibleGainsYTD (28% rate)', () => {
  const { sim } = loadToolsetScenario(US_COLLECTIBLE_JSON);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const taxEntries = sim.journal.getActions('COLLECTIBLE_SALE_TAX');
  assert.ok(taxEntries.length > 0);
  const gainsDiff = taxEntries[0].stateDiff.find(d => d.field === 'usCollectibleGainsYTD');
  const expectedGain = US_COLLECTIBLE_JSON.collectibles[0].value - US_COLLECTIBLE_JSON.collectibles[0].costBasis;
  assert.strictEqual(gainsDiff.delta, expectedGain);
});

test('EVT-36: collectible sale with no gain records zero collectible gain', () => {
  const config = structuredClone(US_COLLECTIBLE_JSON);
  config.collectibles[0].costBasis = config.collectibles[0].value;
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const taxEntries = sim.journal.getActions('COLLECTIBLE_SALE_TAX');
  assert.ok(taxEntries.length > 0);
  // gain = 0, usCollectibleGainsYTD stays 0 → no delta entry
  const gainsDiff = taxEntries[0].stateDiff.find(d => d.field === 'usCollectibleGainsYTD');
  assert.ok(gainsDiff == null || gainsDiff.delta === 0);
});

test('EVT-36: collectible sale records gain as AU capital gain if AU resident', () => {
  const { sim } = loadToolsetScenario(AU_COLLECTIBLE_JSON);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const taxEntries = sim.journal.getActions('COLLECTIBLE_SALE_TAX');
  assert.ok(taxEntries.length > 0);
  const auGainsDiff = taxEntries[0].stateDiff.find(d => d.field === 'auCapitalGainsYTD');
  const expectedGain = AU_COLLECTIBLE_JSON.collectibles[0].value - AU_COLLECTIBLE_JSON.collectibles[0].costBasis;
  assert.strictEqual(auGainsDiff.delta, expectedGain);
  const ftcDiff = taxEntries[0].stateDiff.find(d => d.field === 'ftcYTD');
  assert.ok(ftcDiff != null && ftcDiff.delta > 0, 'FTC should be recorded for AU resident');
});

test('EVT-36: collectible sale is not AU taxable if not AU resident', () => {
  const { sim } = loadToolsetScenario(US_COLLECTIBLE_JSON);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const taxEntries = sim.journal.getActions('COLLECTIBLE_SALE_TAX');
  assert.ok(taxEntries.length > 0);
  const auGainsDiff = taxEntries[0].stateDiff.find(d => d.field === 'auCapitalGainsYTD');
  assert.ok(auGainsDiff == null, 'no AU capital gain for non-AU resident');
  const ftcDiff = taxEntries[0].stateDiff.find(d => d.field === 'ftcYTD');
  assert.ok(ftcDiff == null, 'no FTC for non-AU resident');
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-45: Change in Value – Baseball Cards
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-45: collectible value increase updates collectibleAccount.value', () => {
  const config = structuredClone(US_COLLECTIBLE_JSON);
  config.collectibles[0].value = 5000;
  config.collectibles[0].plannedSaleYear = null;
  const { sim } = loadToolsetScenario(config);

  sim.schedule({ date: new Date(2026, 0, 15), type: 'COLLECTIBLE_VALUE_CHANGE', data: { change: 2000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.collectibleAccount.value, 7000);
});

test('EVT-45: collectible value decrease updates collectibleAccount.value', () => {
  const config = structuredClone(US_COLLECTIBLE_JSON);
  config.collectibles[0].value = 5000;
  config.collectibles[0].plannedSaleYear = null;
  const { sim } = loadToolsetScenario(config);

  sim.schedule({ date: new Date(2026, 0, 15), type: 'COLLECTIBLE_VALUE_CHANGE', data: { change: -1500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.collectibleAccount.value, 3500);
});

test('EVT-45: collectible value change is not a US or AU taxable event', () => {
  const config = structuredClone(US_COLLECTIBLE_JSON);
  config.collectibles[0].value = 5000;
  config.collectibles[0].plannedSaleYear = null;
  const { sim } = loadToolsetScenario(config);

  sim.schedule({ date: new Date(2026, 0, 15), type: 'COLLECTIBLE_VALUE_CHANGE', data: { change: 2000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usCollectibleGainsYTD, 0);
  assert.strictEqual(sim.state.auCapitalGainsYTD ?? 0, 0);
});

test('EVT-45: collectible value change does not affect savings balance', () => {
  const config = structuredClone(US_COLLECTIBLE_JSON);
  config.collectibles[0].value = 5000;
  config.collectibles[0].plannedSaleYear = null;
  const { sim } = loadToolsetScenario(config);

  sim.schedule({ date: new Date(2026, 0, 15), type: 'COLLECTIBLE_VALUE_CHANGE', data: { change: 2000 } });
  sim.stepTo(new Date(2026, 0, 31));

  const applyEntries = sim.journal.getActions('COLLECTIBLE_VALUE_CHANGE_APPLY');
  assert.ok(applyEntries.length > 0);
  const balanceDiff = applyEntries[0].stateDiff.find(d => d.field === 'usSavingsAccount.balance');
  assert.ok(balanceDiff == null, 'value change should not credit or debit the savings account');
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-46: Sale – Gold (same mechanics as EVT-36)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-46: gold collectible sale credits full sale price to savings', () => {
  const config = structuredClone(US_COLLECTIBLE_JSON);
  config.collectibles[0].name      = 'Gold';
  config.collectibles[0].value     = 50000;
  config.collectibles[0].costBasis = 30000;
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const applyEntries = sim.journal.getActions('COLLECTIBLE_SALE_APPLY');
  assert.ok(applyEntries.length > 0);
  const balanceDiff = applyEntries[0].stateDiff.find(d => d.field === 'usSavingsAccount.balance');
  assert.strictEqual(balanceDiff.delta, 50000);
});

test('EVT-46: gold collectible sale records gain as usCollectibleGainsYTD', () => {
  const config = structuredClone(US_COLLECTIBLE_JSON);
  config.collectibles[0].name      = 'Gold';
  config.collectibles[0].value     = 50000;
  config.collectibles[0].costBasis = 30000;
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const taxEntries = sim.journal.getActions('COLLECTIBLE_SALE_TAX');
  assert.ok(taxEntries.length > 0);
  const gainsDiff = taxEntries[0].stateDiff.find(d => d.field === 'usCollectibleGainsYTD');
  assert.strictEqual(gainsDiff.delta, 20000); // 50000 - 30000
});

test('EVT-46: gold collectible sale records AU capital gain if AU resident', () => {
  const config = structuredClone(AU_COLLECTIBLE_JSON);
  config.collectibles[0].name      = 'Gold';
  config.collectibles[0].value     = 50000;
  config.collectibles[0].costBasis = 30000;
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const taxEntries = sim.journal.getActions('COLLECTIBLE_SALE_TAX');
  assert.ok(taxEntries.length > 0);
  const auGainsDiff = taxEntries[0].stateDiff.find(d => d.field === 'auCapitalGainsYTD');
  assert.strictEqual(auGainsDiff.delta, 20000);
  const ftcDiff = taxEntries[0].stateDiff.find(d => d.field === 'ftcYTD');
  assert.ok(ftcDiff != null && ftcDiff.delta > 0, 'FTC should be recorded for AU resident');
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-47: Change in Value – Gold (same mechanics as EVT-45)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-47: gold collectible value appreciation updates collectibleAccount.value', () => {
  const config = structuredClone(US_COLLECTIBLE_JSON);
  config.collectibles[0].name           = 'Gold';
  config.collectibles[0].value          = 30000;
  config.collectibles[0].plannedSaleYear = null;
  const { sim } = loadToolsetScenario(config);

  sim.schedule({ date: new Date(2026, 0, 15), type: 'COLLECTIBLE_VALUE_CHANGE', data: { change: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.collectibleAccount.value, 35000);
});

test('EVT-47: gold collectible value change is not a US or AU taxable event', () => {
  const config = structuredClone(US_COLLECTIBLE_JSON);
  config.collectibles[0].name           = 'Gold';
  config.collectibles[0].value          = 30000;
  config.collectibles[0].plannedSaleYear = null;
  const { sim } = loadToolsetScenario(config);

  sim.schedule({ date: new Date(2026, 0, 15), type: 'COLLECTIBLE_VALUE_CHANGE', data: { change: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usCollectibleGainsYTD, 0);
  assert.strictEqual(sim.state.auCapitalGainsYTD ?? 0, 0);
  assert.strictEqual(sim.state.ftcYTD ?? 0, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// saleDestinationAccount routing (US + AU)
// ══════════════════════════════════════════════════════════════════════════════

const findDiff = (entry, field) => entry.stateDiff.find(d => d.field === field);

test('EVT-36: US collectible sale credits saleDestinationAccount instead of default cash pool', () => {
  const config = structuredClone(US_COLLECTIBLE_JSON);
  config.accounts.push({
    __type:         'CheckingAccount',
    id:             'us-checking',
    name:           'US Checking',
    type:           'checking',
    role:           'us-savings',
    stateKey:       'checkingAccount',
    initialValue:   1_000,
    ownershipType:  'sole',
    ownerId:        'primary',
    minimumBalance: 0,
    country:        'US',
    currency:       { code: 'USD', symbol: '$' },
  });
  config.collectibles[0].saleDestinationAccount = 'checkingAccount';
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const [apply] = sim.journal.getActions('COLLECTIBLE_SALE_APPLY');
  assert.ok(apply);

  const destDiff = findDiff(apply, 'checkingAccount.balance');
  assert.ok(destDiff, 'sale proceeds should land in checkingAccount (saleDestinationAccount)');
  assert.strictEqual(destDiff.delta, config.collectibles[0].value);

  const defaultDiff = findDiff(apply, 'usSavingsAccount.balance');
  assert.strictEqual(defaultDiff, undefined, 'default usSavingsAccount should not be touched');
});

test('EVT-36: AU-resident collectible sale credits saleDestinationAccount instead of default cash pool', () => {
  const config = structuredClone(AU_COLLECTIBLE_JSON);
  config.accounts.push({
    __type:         'CheckingAccount',
    id:             'au-checking',
    name:           'AU Checking',
    type:           'checking',
    role:           'au-savings',
    stateKey:       'checkingAccount',
    initialValue:   1_000,
    ownershipType:  'sole',
    ownerId:        'primary',
    minimumBalance: 0,
    country:        'AU',
    currency:       { code: 'AUD', symbol: 'A$' },
  });
  config.collectibles[0].saleDestinationAccount = 'checkingAccount';
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const [apply] = sim.journal.getActions('COLLECTIBLE_SALE_APPLY');
  assert.ok(apply);

  const destDiff = findDiff(apply, 'checkingAccount.balance');
  assert.ok(destDiff, 'sale proceeds should land in checkingAccount (saleDestinationAccount)');
  assert.strictEqual(destDiff.delta, config.collectibles[0].value);

  const defaultDiff = findDiff(apply, 'usSavingsAccount.balance');
  assert.strictEqual(defaultDiff, undefined, 'default usSavingsAccount should not be touched');
});

test('EVT-36: collectible sale with unknown saleDestinationAccount falls back to default cash pool', () => {
  const config = structuredClone(US_COLLECTIBLE_JSON);
  config.collectibles[0].saleDestinationAccount = 'nonexistentAccount';
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028));

  const [apply] = sim.journal.getActions('COLLECTIBLE_SALE_APPLY');
  assert.ok(apply);

  const defaultDiff = findDiff(apply, 'usSavingsAccount.balance');
  assert.ok(defaultDiff, 'should fall back to default usSavingsAccount');
  assert.strictEqual(defaultDiff.delta, config.collectibles[0].value);
});
