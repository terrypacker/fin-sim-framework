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
 * evt-rental-income.test.mjs — Rental income on real property (design 48).
 *
 * EVT-RENT-1  US rental: net cash credited, taxable net accrued to usOrdinaryIncomeYTD
 * EVT-RENT-2  US rental negative gearing: interest + depreciation drive a taxable loss
 * EVT-RENT-3  AU rental (resident): both auOrdinaryIncomeYTD and usOrdinaryIncomeYTD accrue
 * EVT-RENT-4  Occupancy scales the effective rent / cash
 * EVT-RENT-5  Off by default: no rental series scheduled
 * EVT-RENT-6  Round-trip: rental fields survive serialize → deserialize
 * EVT-RENT-7  Depreciation accrues into accumulatedDepreciation
 * EVT-RENT-8  At sale, accumulated depreciation reduces the tax basis (larger gain)
 * EVT-RENT-9  Rent is indexed to the effective inflation accumulator (design 48 §4.6)
 *
 * Run with: node --test tests/unit/evt-rental-income.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry }    from '../../src/services/service-registry.js';
import { ScenarioLoader }     from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }       from '../../src/index.js';
import { RealProperty }       from '../../src/finance/assets/real-property.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';

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

const findDiff = (entry, field) => entry.stateDiff.find(d => d.field === field);
const approx   = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

const FEB_2026 = new Date(Date.UTC(2026, 1, 15));   // after the Jan month-end
const JAN_2027 = new Date(Date.UTC(2027, 0, 10));   // after 12 month-ends of 2026
const FEB_2027 = new Date(Date.UTC(2027, 1, 15));   // after the first annual advance + a 2027 month-end
const MAR_2027 = new Date(Date.UTC(2027, 2, 1));    // after a Jan 15 2027 sale

const primary = {
  __type: 'Person', id: 'primary', name: 'Primary',
  birthDate: '1975-04-15', lifeExpectancy: 90,
  monthlyWage: 0, retirementDate: '2025-01-01', socialSecurityMonthly: 0,
};

function usConfig(rentalOverrides = {}, propOverrides = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'US_REAL_PROPERTY'],
    simStart: '2026-01-01', simEnd: '2041-01-01',
    parameters: {},
    persons: [{ ...primary, citizen: ['US'], residency: 'US' }],
    accounts: [{
      __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings',
      type: 'savings', role: 'us-savings', stateKey: 'usSavingsAccount',
      initialValue: 5000, ownershipType: 'sole', ownerId: 'primary',
      minimumBalance: 2000, country: 'US', currency: { code: 'USD', symbol: '$' },
    }],
    realProperties: [{
      __type: 'RealProperty', id: 're1', name: 'US Rental', country: 'US',
      appreciationRate: 0, costBasis: 800000, value: 1000000,
      mortgageBalance: 0, monthlyMortgage: 0, isPrimaryResidence: false,
      ownerId: 'primary', owners: [], ownershipType: 'sole',
      plannedSaleYear: null, saleDestinationAccount: 'usSavingsAccount',
      stateKey: 'usHouseProperty',
      rentalEnabled: true, monthlyRent: 3000, occupancyRate: 0.9,
      rentalExpenseRatio: 0.25, mortgageInterestRate: 0, landValueRatio: 0.2,
      annualDepreciationOverride: 12000,
      ...propOverrides,
      ...rentalOverrides,
    }],
  };
}

function auConfig(propOverrides = {}) {
  return {
    toolsets: ['AU_RETIREMENT', 'AU_REAL_PROPERTY', 'US_TAX'],
    simStart: '2026-01-01', simEnd: '2041-01-01',
    parameters: {},
    persons: [{ ...primary, citizen: ['AU'], residency: 'AU' }],
    accounts: [{
      __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings',
      type: 'savings', role: 'au-savings', stateKey: 'auSavingsAccount',
      initialValue: 5000, ownershipType: 'sole', ownerId: 'primary',
      minimumBalance: 2000, country: 'AU', currency: { code: 'AUD', symbol: '$' },
    }],
    realProperties: [{
      __type: 'RealProperty', id: 're1', name: 'AU Rental', country: 'AU',
      appreciationRate: 0, costBasis: 800000, value: 1000000,
      mortgageBalance: 0, monthlyMortgage: 0, isPrimaryResidence: false,
      ownerId: 'primary', owners: [], ownershipType: 'sole',
      plannedSaleYear: null, saleDestinationAccount: 'auSavingsAccount',
      stateKey: 'auHouseProperty',
      rentalEnabled: true, monthlyRent: 3000, occupancyRate: 0.9,
      rentalExpenseRatio: 0.25, mortgageInterestRate: 0, landValueRatio: 0.2,
      annualDepreciationOverride: 12000,
      ...propOverrides,
    }],
  };
}

test('EVT-RENT-1: US rental credits net cash and accrues taxable net to usOrdinaryIncomeYTD', () => {
  const { sim } = loadToolsetScenario(usConfig());
  assert.doesNotThrow(() => sim.stepTo(FEB_2026));

  // Cash: effectiveRent 3000*0.9=2700, opex 25% = 675, netCash = 2025
  const applies = sim.journal.getActions('US_RENTAL_INCOME_APPLY');
  assert.ok(applies.length > 0, 'US_RENTAL_INCOME_APPLY should fire');
  const cashDiff = findDiff(applies[0], 'usSavingsAccount.balance');
  assert.strictEqual(cashDiff.delta, 2025);

  // Tax: taxable = 2700 - 675 - 0 interest - 1000 depreciation(12000/12) = 1025
  const taxes = sim.journal.getActions('US_RENTAL_INCOME_TAX');
  assert.ok(taxes.length > 0, 'US_RENTAL_INCOME_TAX should fire');
  const ordDiff = findDiff(taxes[0], 'usOrdinaryIncomeYTD');
  assert.ok(ordDiff, 'usOrdinaryIncomeYTD diff should be recorded');
  assert.strictEqual(ordDiff.delta, 1025);
});

test('EVT-RENT-2: US rental negative gearing yields a taxable loss (offsets other income)', () => {
  // monthlyRent 1000, occ 1.0, opex 25%; mortgage 500k @ 6% => interest 2500/mo;
  // depreciation 12000/12 = 1000. taxable = 1000 - 250 - 2500 - 1000 = -2750.
  const { sim } = loadToolsetScenario(usConfig({
    monthlyRent: 1000, occupancyRate: 1.0, rentalExpenseRatio: 0.25,
    mortgageBalance: 500000, mortgageInterestRate: 0.06, monthlyMortgage: 0,
    annualDepreciationOverride: 12000,
  }));
  assert.doesNotThrow(() => sim.stepTo(FEB_2026));

  const applies = sim.journal.getActions('US_RENTAL_INCOME_APPLY');
  const cashDiff = findDiff(applies[0], 'usSavingsAccount.balance');
  assert.strictEqual(cashDiff.delta, 750);   // cash is still positive: 1000 - 250

  const taxes = sim.journal.getActions('US_RENTAL_INCOME_TAX');
  const ordDiff = findDiff(taxes[0], 'usOrdinaryIncomeYTD');
  assert.strictEqual(ordDiff.delta, -2750);  // taxable loss reduces ordinary income
});

test('EVT-RENT-3: AU rental (resident) accrues both AU and US ordinary income + FTC', () => {
  const { sim } = loadToolsetScenario(auConfig());
  assert.doesNotThrow(() => sim.stepTo(FEB_2026));

  const applies = sim.journal.getActions('AU_RENTAL_INCOME_APPLY');
  assert.ok(applies.length > 0, 'AU_RENTAL_INCOME_APPLY should fire');
  const cashDiff = findDiff(applies[0], 'auSavingsAccount.balance');
  assert.strictEqual(cashDiff.delta, 2025);

  const taxes = sim.journal.getActions('AU_RENTAL_INCOME_TAX');
  assert.ok(taxes.length > 0, 'AU_RENTAL_INCOME_TAX should fire');
  // taxable = 2700 - 675 - 1000 = 1025 (AU dep 12000/12 override)
  // Design 73 Gap 3 step 3: attributed to the property's owner rather than written
  // to the household scalar, which perPersonShare would have split evenly across
  // residents — taxing a solely-owned property half to each spouse.
  assert.strictEqual(findDiff(taxes[0], 'auPersonOrdinaryIncomeYTD.primary').delta, 1025);
  assert.strictEqual(findDiff(taxes[0], 'usOrdinaryIncomeYTD').delta, 1025);
  assert.strictEqual(findDiff(taxes[0], 'foreignPassiveIncomeYTD').delta, 1025);
});

test('EVT-RENT-4: occupancy rate scales the effective rent / cash', () => {
  const full = loadToolsetScenario(usConfig({
    monthlyRent: 2000, occupancyRate: 1.0, rentalExpenseRatio: 0.25, annualDepreciationOverride: 0,
  }));
  full.sim.stepTo(FEB_2026);
  const fullCash = findDiff(full.sim.journal.getActions('US_RENTAL_INCOME_APPLY')[0], 'usSavingsAccount.balance').delta;

  ServiceRegistry.resetAll();

  const half = loadToolsetScenario(usConfig({
    monthlyRent: 2000, occupancyRate: 0.5, rentalExpenseRatio: 0.25, annualDepreciationOverride: 0,
  }));
  half.sim.stepTo(FEB_2026);
  const halfCash = findDiff(half.sim.journal.getActions('US_RENTAL_INCOME_APPLY')[0], 'usSavingsAccount.balance').delta;

  assert.strictEqual(fullCash, 1500);   // 2000 * 1.0 * 0.75
  assert.strictEqual(halfCash, 750);    // 2000 * 0.5 * 0.75
});

test('EVT-RENT-5: rental off by default schedules no rental series', () => {
  const { sim } = loadToolsetScenario(usConfig({ rentalEnabled: false }));
  assert.doesNotThrow(() => sim.stepTo(FEB_2026));
  assert.strictEqual(sim.journal.getActions('US_RENTAL_INCOME_APPLY').length, 0);
});

test('EVT-RENT-6: rental fields survive serialize → deserialize round-trip', () => {
  const prop = new RealProperty(1000000, {
    id: 're1', name: 'US Rental', country: 'US', costBasis: 800000,
    rentalEnabled: true, monthlyRent: 3200, occupancyRate: 0.6,
    rentalExpenseRatio: 0.35, mortgageInterestRate: 0.055, landValueRatio: 0.25,
    annualDepreciationOverride: 15000, accumulatedDepreciation: 4200,
  });
  const restored = ScenarioSerializer._makeRealProperty(ScenarioSerializer._serializeRealProperty(prop));
  assert.strictEqual(restored.rentalEnabled, true);
  assert.strictEqual(restored.monthlyRent, 3200);
  assert.strictEqual(restored.occupancyRate, 0.6);
  assert.strictEqual(restored.rentalExpenseRatio, 0.35);
  assert.strictEqual(restored.mortgageInterestRate, 0.055);
  assert.strictEqual(restored.landValueRatio, 0.25);
  assert.strictEqual(restored.annualDepreciationOverride, 15000);
  assert.strictEqual(restored.accumulatedDepreciation, 4200);
});

test('EVT-RENT-7: depreciation accrues into accumulatedDepreciation over 12 months', () => {
  const { sim } = loadToolsetScenario(usConfig({ annualDepreciationOverride: 12000 }));
  assert.doesNotThrow(() => sim.stepTo(JAN_2027));
  // 12 month-ends of 2026 × (12000/12) = 12000
  assert.ok(approx(sim.state.usHouseProperty.accumulatedDepreciation, 12000, 0.5),
    `expected ~12000, got ${sim.state.usHouseProperty.accumulatedDepreciation}`);
});

test('EVT-RENT-9: rent is indexed to the effective inflation accumulator', () => {
  // 10% annual inflation, no mortgage/depreciation noise. Month-1 (accumulator
  // 1.0) is un-indexed; after the first annual advance (accumulator 1.10) the
  // same base rent yields 10% more cash — the effective (regime-adjusted) rate
  // is what compounds inflationAccumulator, so this is regime-aware by construction.
  const config = usConfig(
    { monthlyRent: 3000, occupancyRate: 0.9, rentalExpenseRatio: 0.25, annualDepreciationOverride: 0 },
  );
  config.parameters = { inflationRate: 0.10 };
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(FEB_2027));

  const applies = sim.journal.getActions('US_RENTAL_INCOME_APPLY');
  assert.ok(applies.length >= 13, 'expected 12 (2026) + at least one 2027 month-end');

  // First month-end (Jan 2026): accumulator 1.0 → 3000*0.9*0.75 = 2025.
  const firstCash = findDiff(applies[0], 'usSavingsAccount.balance').delta;
  assert.strictEqual(firstCash, 2025);

  // After the Jan 2027 annual advance: accumulator 1.10 → 2025 * 1.10 = 2227.5.
  assert.ok(approx(sim.state.inflationAccumulator.US, 1.10, 1e-9),
    `accumulator should be 1.10, got ${sim.state.inflationAccumulator.US}`);
  const lastCash = findDiff(applies[applies.length - 1], 'usSavingsAccount.balance').delta;
  assert.ok(approx(lastCash, 2227.5, 0.01), `expected ~2227.5, got ${lastCash}`);
});

test('EVT-RENT-8: accumulated depreciation reduces the tax basis at sale (larger gain)', () => {
  const { sim } = loadToolsetScenario(auConfig({
    plannedSaleYear: 2027, annualDepreciationOverride: 12000,
  }));
  assert.doesNotThrow(() => sim.stepTo(MAR_2027));

  const accumDep = sim.state.auHouseProperty.accumulatedDepreciation;
  assert.ok(accumDep > 0, 'depreciation should have accrued before sale');

  const saleTax = sim.journal.getActions('AU_HOUSE_SALE_TAX');
  assert.ok(saleTax.length > 0, 'AU_HOUSE_SALE_TAX should fire');
  const cgDiff = findDiff(saleTax[0], 'usCapitalGainsYTD');
  // gain = value - (costBasis - accumulatedDepreciation) = 200000 + accumDep
  assert.ok(approx(cgDiff.delta, (1000000 - 800000) + accumDep, 0.5),
    `expected ${(1000000 - 800000) + accumDep}, got ${cgDiff.delta}`);
});

test('EVT-RENT-10: AU rental owned by a US resident still feeds the §904 passive basket', () => {
  // Design 73 Gap 3 step 1. Source follows the situs of the property (AU–US
  // treaty Art 6), not the owner's residency, so AU-situs rent is foreign-source
  // to the US whether or not the owner is an AU resident. Gating the basket
  // numerator on residency starved the passive limitation for exactly the
  // taxpayer who needs it: a US resident paying AU tax on AU rent.
  const cfg = auConfig();
  cfg.persons = [{ ...primary, citizen: ['US'], residency: 'US' }];
  const { sim } = loadToolsetScenario(cfg);
  assert.doesNotThrow(() => sim.stepTo(FEB_2026));

  const taxes = sim.journal.getActions('AU_RENTAL_INCOME_TAX');
  assert.ok(taxes.length > 0, 'AU_RENTAL_INCOME_TAX should fire');
  // Same taxable net as the resident case (EVT-RENT-3): 2700 - 675 - 1000 = 1025.
  assert.strictEqual(findDiff(taxes[0], 'usOrdinaryIncomeYTD').delta,     1025);
  assert.strictEqual(findDiff(taxes[0], 'foreignPassiveIncomeYTD').delta, 1025);
});

test('EVT-RENT-11: a US-resident landlord\'s AU rent IS assessed in Australia', () => {
  // Design 73 Gap 3 step 2. AU_RENTAL_INCOME_TAX had no non-resident branch at
  // all: the income reached usOrdinaryIncomeYTD and stopped, so a US resident with
  // an Australian rental property got a tax-free rent stream. Rental income is
  // sourced where the property is (treaty Art 6, which caps no rate at all on the
  // source state), and the ATO is explicit that a foreign resident earning
  // Australian rent lodges annually and declares NET rental income [R12].
  const cfg = auConfig();
  cfg.persons = [{ ...primary, citizen: ['US'], residency: 'US' }];
  const { sim } = loadToolsetScenario(cfg);
  assert.doesNotThrow(() => sim.stepTo(FEB_2026));

  const taxes = sim.journal.getActions('AU_RENTAL_INCOME_TAX');
  // Assessable in Australia at foreign-resident marginal rates, attributed to the
  // owner. This is the accumulator the NR bracket path reads.
  assert.strictEqual(findDiff(taxes[0], 'auPersonOrdinaryIncomeYTD.primary').delta, 1025);
  // ...and NOT treated as final withholding income: rent was never a withholding
  // category, only interest, unfranked dividends and royalties are.
  assert.strictEqual(findDiff(taxes[0], 'auPersonNrWithholdingInterestYTD.primary'), undefined);
  assert.strictEqual(findDiff(taxes[0], 'auPersonNonResidentWithholdingYTD.primary'), undefined);
});

test('EVT-RENT-12: a rental LOSS stays signed into the AU accumulator', () => {
  // The Math.max(0, ...) floor is correct for the §904 basket numerator alone —
  // a loss contributes zero limitation room. It must not reach the assessable
  // accumulator, where a negative net rent legitimately reduces taxable income.
  const cfg = auConfig({ mortgageBalance: 500000, mortgageInterestRate: 0.06, monthlyMortgage: 0 });
  cfg.persons = [{ ...primary, citizen: ['US'], residency: 'US' }];
  const { sim } = loadToolsetScenario(cfg);
  assert.doesNotThrow(() => sim.stepTo(FEB_2026));

  const taxes = sim.journal.getActions('AU_RENTAL_INCOME_TAX');
  // 2700 rent − 675 expenses − 1000 depreciation − 2500 interest = −1475.
  const auDelta = findDiff(taxes[0], 'auPersonOrdinaryIncomeYTD.primary').delta;
  assert.ok(auDelta < 0, `a geared property should book a negative net rent, got ${auDelta}`);
  assert.strictEqual(auDelta, -1475);
  // The basket numerator, by contrast, is floored at zero — so it records no change.
  assert.strictEqual(findDiff(taxes[0], 'foreignPassiveIncomeYTD'), undefined);
});
