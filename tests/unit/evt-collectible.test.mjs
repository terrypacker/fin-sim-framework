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

import { Account } from '../../src/finance/assets/account.js';
import { FinancialState } from '../../src/finance/state/financial-state.js';
import { Simulation } from '../../src/simulation-framework/simulation.js';
import { TaxService } from '../../src/finance/tax-service.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { PeriodService } from '../../src/finance/period/period-service.js';
import { buildUsCalendarYear, applyTo } from '../../src/finance/period/period-builder.js';

beforeEach(() => ServiceRegistry.reset());

function buildUsPeriodService(year) {
  const ps = new PeriodService();
  applyTo(ps, buildUsCalendarYear(year));
  return ps;
}

const START_DATE = new Date(2026, 0, 1);

function buildCollectibleSim({
  initialChecking        = 5000,
  collectibleValue       = 10000,
  collectibleCostBasis   = 7000,
  isAuResident           = false,
} = {}) {
  const registry = ServiceRegistry.getInstance();
  const sim = new Simulation(START_DATE, { initialState: new FinancialState({
    checkingAccount: new Account(initialChecking),
    collectibleAccount: { value: collectibleValue, costBasis: collectibleCostBasis },
    isAuResident,
    usCollectibleGainsYTD: 0,
    auCapitalGainsYTD:     0,
    ftcYTD:                0,
  }) });
  registry.simulationRegistry.register('primary', sim);
  registry.simulationSync.setSimStart(START_DATE);
  const taxService = new TaxService();
  taxService.setup(sim, ['US'], buildUsPeriodService(2026));
  taxService.registerHandlersAndReducers(registry, ['US']);
  return { sim };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-36: Sale – Baseball Cards
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-36: collectible sale credits full sale price to checking', () => {
  const { sim } = buildCollectibleSim({ initialChecking: 5000, collectibleValue: 10000 });
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'COLLECTIBLE_SALE',
    data: { salePrice: 10000, costBasis: 7000 },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 15000); // 5000 + 10000
});

test('EVT-36: collectible sale zeroes out collectibleAccount value', () => {
  const { sim } = buildCollectibleSim({ collectibleValue: 10000 });
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'COLLECTIBLE_SALE',
    data: { salePrice: 10000, costBasis: 7000 },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.collectibleAccount.value, 0);
});

test('EVT-36: collectible sale records gain as usCollectibleGainsYTD (28% rate)', () => {
  const { sim } = buildCollectibleSim();
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'COLLECTIBLE_SALE',
    data: { salePrice: 10000, costBasis: 7000 },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usCollectibleGainsYTD, 3000); // 10000 - 7000
});

test('EVT-36: collectible sale with no gain records zero collectible gain', () => {
  const { sim } = buildCollectibleSim({ collectibleValue: 7000 });
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'COLLECTIBLE_SALE',
    data: { salePrice: 7000, costBasis: 7000 },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usCollectibleGainsYTD, 0);
});

test('EVT-36: collectible sale records gain as AU capital gain if AU resident', () => {
  const { sim } = buildCollectibleSim({ isAuResident: true });
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'COLLECTIBLE_SALE',
    data: { salePrice: 10000, costBasis: 7000 },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auCapitalGainsYTD, 3000);
  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded for AU resident');
});

test('EVT-36: collectible sale is not AU taxable if not AU resident', () => {
  const { sim } = buildCollectibleSim({ isAuResident: false });
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'COLLECTIBLE_SALE',
    data: { salePrice: 10000, costBasis: 7000 },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auCapitalGainsYTD, 0);
  assert.strictEqual(sim.state.ftcYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-45: Change in Value – Baseball Cards
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-45: collectible value increase updates collectibleAccount.value', () => {
  const { sim } = buildCollectibleSim({ collectibleValue: 5000 });
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'COLLECTIBLE_VALUE_CHANGE',
    data: { change: 2000 },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.collectibleAccount.value, 7000);
});

test('EVT-45: collectible value decrease updates collectibleAccount.value', () => {
  const { sim } = buildCollectibleSim({ collectibleValue: 5000 });
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'COLLECTIBLE_VALUE_CHANGE',
    data: { change: -1500 },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.collectibleAccount.value, 3500);
});

test('EVT-45: collectible value change is not a US or AU taxable event', () => {
  const { sim } = buildCollectibleSim({ collectibleValue: 5000, isAuResident: true });
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'COLLECTIBLE_VALUE_CHANGE',
    data: { change: 2000 },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usCollectibleGainsYTD, 0);
  assert.strictEqual(sim.state.auCapitalGainsYTD, 0);
});

test('EVT-45: collectible value change does not affect checking balance', () => {
  const { sim } = buildCollectibleSim({ initialChecking: 5000, collectibleValue: 5000 });
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'COLLECTIBLE_VALUE_CHANGE',
    data: { change: 2000 },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-46: Sale – Gold (same mechanics as EVT-36)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-46: gold collectible sale credits full sale price to checking', () => {
  const { sim } = buildCollectibleSim({ initialChecking: 1000, collectibleValue: 50000 });
  sim.schedule({
    date: new Date(2026, 1, 1),
    type: 'COLLECTIBLE_SALE',
    data: { salePrice: 50000, costBasis: 30000 },
  });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.checkingAccount.balance, 51000); // 1000 + 50000
});

test('EVT-46: gold collectible sale records gain as usCollectibleGainsYTD', () => {
  const { sim } = buildCollectibleSim({ collectibleValue: 50000 });
  sim.schedule({
    date: new Date(2026, 1, 1),
    type: 'COLLECTIBLE_SALE',
    data: { salePrice: 50000, costBasis: 30000 },
  });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usCollectibleGainsYTD, 20000); // 50000 - 30000
});

test('EVT-46: gold collectible sale records AU capital gain if AU resident', () => {
  const { sim } = buildCollectibleSim({ collectibleValue: 50000, isAuResident: true });
  sim.schedule({
    date: new Date(2026, 1, 1),
    type: 'COLLECTIBLE_SALE',
    data: { salePrice: 50000, costBasis: 30000 },
  });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auCapitalGainsYTD, 20000);
  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded for AU resident');
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-47: Change in Value – Gold (same mechanics as EVT-45)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-47: gold collectible value appreciation updates collectibleAccount.value', () => {
  const { sim } = buildCollectibleSim({ collectibleValue: 30000 });
  sim.schedule({
    date: new Date(2026, 1, 1),
    type: 'COLLECTIBLE_VALUE_CHANGE',
    data: { change: 5000 },
  });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.collectibleAccount.value, 35000);
});

test('EVT-47: gold collectible value change is not a US or AU taxable event', () => {
  const { sim } = buildCollectibleSim({ collectibleValue: 30000, isAuResident: true });
  sim.schedule({
    date: new Date(2026, 1, 1),
    type: 'COLLECTIBLE_VALUE_CHANGE',
    data: { change: 5000 },
  });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usCollectibleGainsYTD, 0);
  assert.strictEqual(sim.state.auCapitalGainsYTD, 0);
  assert.strictEqual(sim.state.ftcYTD, 0);
});
