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
 * evt-real-property.test.mjs
 * Tests for Real Property events: EVT-33 and EVT-34
 *
 * EVT-33  Australian House Sale  into checking  US: capital gain, AU: always NR withholding rate, FTC
 * EVT-34  US House Sale          into checking  US: capital gain after $500K exemption,
 *                                                AU: TODO (??) if resident, FTC
 *
 * Run with: node --test tests/unit/evt-real-property.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';
import { computeNetWorth } from '../../src/finance/derived-metrics/net-worth.js';

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

const US_HOUSE_JSON = {
  toolsets: ['US_RETIREMENT', 'US_REAL_PROPERTY'],
  simStart: '2026-01-01',
  simEnd:   '2041-01-01',
  parameters: {

  },
  persons: [
    {
      __type:         'Person',
      id:             'primary',
      name:           'Primary',
      birthDate:      '1975-04-15',
      citizen:        ['US'],
      lifeExpectancy: 90,
      monthlyWage:    0,
      retirementDate: '2025-01-01',
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
    }
  ],
  realProperties: [
    {
      __type: "RealProperty",
      id: "re1",
      name: "US House",
      appreciationRate: 0,
      costBasis: 800000,
      country: "US",
      drawdownPriority: null,
      isPrimaryResidence: true,
      monthlyMortgage: 0,
      mortgageBalance: 0,
      ownerId: "primary",
      owners: [],
      ownershipType: "joint",
      plannedSaleYear: 2027,
      saleDestinationAccount: "usSavingsAccount",
      stateKey: "usHouseProperty",
      value: 1000000
    }
  ]
};

const AU_HOUSE_JSON = {
  toolsets: ['AU_RETIREMENT', 'AU_REAL_PROPERTY', 'US_TAX'],
  simStart: '2026-01-01',
  simEnd:   '2041-01-01',
  parameters: {

  },
  persons: [
    {
      __type:         'Person',
      id:             'primary',
      name:           'Primary',
      birthDate:      '1975-04-15',
      citizen:        ['AU'],
      lifeExpectancy: 90,
      monthlyWage:    0,
      retirementDate: '2025-01-01',
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
    }
  ],
  realProperties: [
    {
      __type: "RealProperty",
      id: "re1",
      name: "AU House",
      appreciationRate: 0,
      costBasis: 800000,
      country: "AU",
      drawdownPriority: null,
      isPrimaryResidence: true,
      monthlyMortgage: 0,
      mortgageBalance: 0,
      ownerId: "primary",
      owners: [],
      ownershipType: "joint",
      plannedSaleYear: 2027,
      saleDestinationAccount: "auSavingsAccount",
      stateKey: "auHouseProperty",
      value: 1200000
    }
  ]
};

const CROSS_BORDER_HOUSE_JSON = {
  toolsets: ['AU_RETIREMENT', 'AU_REAL_PROPERTY', 'US_TAX', 'US_AU_CROSS_BORDER'],
  simStart: '2026-01-01',
  simEnd:   '2041-01-01',
  parameters: {

  },
  persons: [
    {
      __type:         'Person',
      id:             'primary',
      name:           'Primary',
      birthDate:      '1975-04-15',
      citizen:        ['AU'],
      lifeExpectancy: 90,
      monthlyWage:    0,
      retirementDate: '2025-01-01',
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
    }
  ],
  realProperties: [
    {
      __type: "RealProperty",
      id: "re1",
      name: "AU House",
      appreciationRate: 0,
      costBasis: 800000,
      country: "AU",
      drawdownPriority: null,
      isPrimaryResidence: true,
      monthlyMortgage: 0,
      mortgageBalance: 0,
      ownerId: "primary",
      owners: [],
      ownershipType: "joint",
      plannedSaleYear: 2027,
      saleDestinationAccount: "auSavingsAccount",
      stateKey: "auHouseProperty",
      value: 1200000
    }
  ]
};

// End of first quarter 2028 — 3 month-end events (Jan 31, Feb 28, Mar 31).
const Q1_2028 = new Date(Date.UTC(2028, 2, 31));

// ══════════════════════════════════════════════════════════════════════════════
// EVT-33: Australian House Sale
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-33: AU house sale credits full sale proceeds to savings', () => {
  const { sim } = loadToolsetScenario(AU_HOUSE_JSON);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('AU_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  const cashDiff = findDiff(journalEntry[0], 'auSavingsAccount.balance');
  assert.strictEqual(cashDiff.delta, AU_HOUSE_JSON.realProperties[0].value);
  const valueDiff = findDiff(journalEntry[0], 'auHouseProperty.value');
  assert.ok(valueDiff, 'property value diff should be recorded');
  assert.strictEqual(valueDiff.after, 0);
});

test('EVT-33: AU house sale records US capital gain (sale price - cost basis)', () => {
  const { sim } = loadToolsetScenario(AU_HOUSE_JSON);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('AU_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  const cashDiff = findDiff(journalEntry[0], 'auSavingsAccount.balance');
  assert.strictEqual(cashDiff.delta, AU_HOUSE_JSON.realProperties[0].value);

  const auTaxJournalEntry = sim.journal.getActions('AU_HOUSE_SALE_TAX');
  assert.ok(auTaxJournalEntry);
  assert.ok(auTaxJournalEntry.length > 0);
  //state.usCapitalGainsYTD
  const cgDiff = findDiff(auTaxJournalEntry[0], 'usCapitalGainsYTD');
  assert.ok(cgDiff, 'usCapitalGainsYTD diff should be recorded');
  assert.strictEqual(cgDiff.delta, AU_HOUSE_JSON.realProperties[0].value - AU_HOUSE_JSON.realProperties[0].costBasis);
});

test('EVT-33: AU house sale is always AU taxable at non-resident withholding rate', () => {
  const { sim } = loadToolsetScenario(CROSS_BORDER_HOUSE_JSON);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('AU_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  const cashDiff = findDiff(journalEntry[0], 'auSavingsAccount.balance');
  assert.strictEqual(cashDiff.delta, AU_HOUSE_JSON.realProperties[0].value);

  const auTaxJournalEntry = sim.journal.getActions('AU_HOUSE_SALE_TAX');
  assert.ok(auTaxJournalEntry);
  assert.ok(auTaxJournalEntry.length > 0);
  //state.auPersonNonResidentWithholdingYTD.primary
  const nrDiff = findDiff(auTaxJournalEntry[0], 'auPersonNonResidentWithholdingYTD.primary');
  assert.ok(nrDiff, 'auPersonNonResidentWithholdingYTD.primary diff should be recorded');
  assert.strictEqual(nrDiff.delta, AU_HOUSE_JSON.realProperties[0].value - AU_HOUSE_JSON.realProperties[0].costBasis);
});

test('EVT-33: AU house sale generates a Foreign Tax Credit', () => {

  const { sim } = loadToolsetScenario(CROSS_BORDER_HOUSE_JSON);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('AU_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  const cashDiff = findDiff(journalEntry[0], 'auSavingsAccount.balance');
  assert.strictEqual(cashDiff.delta, AU_HOUSE_JSON.realProperties[0].value);

  const auTaxJournalEntry = sim.journal.getActions('AU_HOUSE_SALE_TAX');
  assert.ok(auTaxJournalEntry);
  assert.ok(auTaxJournalEntry.length > 0);
  //state.ftcYTD
  const ftcDiff = findDiff(auTaxJournalEntry[0], 'ftcYTD');
  assert.ok(ftcDiff, 'ftcYTD diff should be recorded');
  // design 51: the AUD capital gain is normalized into the USD ftcYTD bucket.
  assert.strictEqual(ftcDiff.delta, (AU_HOUSE_JSON.realProperties[0].value - AU_HOUSE_JSON.realProperties[0].costBasis) / sim.state.effectiveExchangeRates.USD_AUD);
});

test('EVT-33: AU house sale with no gain has zero capital gains tax exposure', () => {
  const config = structuredClone(CROSS_BORDER_HOUSE_JSON);
  config.realProperties[0].costBasis = config.realProperties[0].value;

  const { sim } = loadToolsetScenario(config);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('AU_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  const cashDiff = findDiff(journalEntry[0], 'auSavingsAccount.balance');
  assert.strictEqual(cashDiff.delta, AU_HOUSE_JSON.realProperties[0].value);

  const auTaxJournalEntry = sim.journal.getActions('AU_HOUSE_SALE_TAX');
  assert.ok(auTaxJournalEntry);
  assert.ok(auTaxJournalEntry.length > 0);

  //Expect no tax changes applied
  assert.strictEqual(auTaxJournalEntry[0].stateDiff.length,0);

});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-34: US House Sale
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-34: US house sale credits full sale proceeds to savings', () => {
  const { sim } = loadToolsetScenario(US_HOUSE_JSON);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('US_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  const cashDiff = findDiff(journalEntry[0], 'usSavingsAccount.balance');
  assert.strictEqual(cashDiff.delta, US_HOUSE_JSON.realProperties[0].value);
  const valueDiff = findDiff(journalEntry[0], 'usHouseProperty.value');
  assert.ok(valueDiff, 'property value diff should be recorded');
  assert.strictEqual(valueDiff.after, 0);
});

test('EVT-34: US house sale applies $500K primary residence exemption to capital gain', () => {
  const config = structuredClone(US_HOUSE_JSON);
  config.realProperties[0].costBasis = config.realProperties[0].value - 600_000;
  const { sim } = loadToolsetScenario(config);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('US_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  const cashDiff = findDiff(journalEntry[0], 'usSavingsAccount.balance');
  assert.strictEqual(cashDiff.delta, config.realProperties[0].value);

  const usTaxJournalEntry = sim.journal.getActions('US_HOUSE_SALE_TAX');
  assert.ok(usTaxJournalEntry);
  assert.ok(usTaxJournalEntry.length > 0);
  //state.usCapitalGainsYTD
  const cgDiff = findDiff(usTaxJournalEntry[0], 'usCapitalGainsYTD');
  assert.ok(cgDiff, 'usCapitalGainsYTD diff should be recorded');
  assert.strictEqual(cgDiff.delta, (config.realProperties[0].value - config.realProperties[0].costBasis) - 500_000);
});

test('EVT-34: US house sale with gain under $500K has zero taxable capital gain', () => {
  const config = structuredClone(US_HOUSE_JSON);
  config.realProperties[0].costBasis = 500_000;
  config.realProperties[0].value = 600_000;
  const { sim } = loadToolsetScenario(config);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('US_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  const cashDiff = findDiff(journalEntry[0], 'usSavingsAccount.balance');
  assert.strictEqual(cashDiff.delta, config.realProperties[0].value);

  const usTaxJournalEntry = sim.journal.getActions('US_HOUSE_SALE_TAX');
  assert.ok(usTaxJournalEntry);
  assert.ok(usTaxJournalEntry.length > 0);
  //Expect no tax changes applied
  assert.strictEqual(usTaxJournalEntry[0].stateDiff.length,0);
});

test('EVT-34: US house sale with no gain has zero capital gains exposure', () => {
  const config = structuredClone(US_HOUSE_JSON);
  config.realProperties[0].costBasis = 500_000;
  config.realProperties[0].value = 500_000;
  const { sim } = loadToolsetScenario(config);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('US_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  const cashDiff = findDiff(journalEntry[0], 'usSavingsAccount.balance');
  assert.strictEqual(cashDiff.delta, config.realProperties[0].value);

  const usTaxJournalEntry = sim.journal.getActions('US_HOUSE_SALE_TAX');
  assert.ok(usTaxJournalEntry);
  assert.ok(usTaxJournalEntry.length > 0);
  //Expect no tax changes applied
  assert.strictEqual(usTaxJournalEntry[0].stateDiff.length,0);
});

// TODO (EVT-34): AU tax treatment for a US house sale when the person is an AU resident is
// unresolved (CSV: "??"). When clarified, add assertions here for auCapitalGainsYTD or
// auNonResidentWithholdingYTD as applicable.

// ══════════════════════════════════════════════════════════════════════════════
// Mortgage handling on sale (US + AU)
// ══════════════════════════════════════════════════════════════════════════════

const findDiff = (entry, field) => entry.stateDiff.find(d => d.field === field);

test('EVT-34: US house sale credits net proceeds (sale price − mortgage) and zeroes mortgage', () => {
  const config = structuredClone(US_HOUSE_JSON);
  const mortgage = 300_000;
  config.realProperties[0].mortgageBalance = mortgage;
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const [apply] = sim.journal.getActions('US_HOUSE_SALE_APPLY');
  assert.ok(apply);

  const cashDiff = findDiff(apply, 'usSavingsAccount.balance');
  assert.ok(cashDiff, 'should credit usSavingsAccount with net proceeds');
  assert.strictEqual(cashDiff.delta, config.realProperties[0].value - mortgage);

  // Design 54 P2: the mortgage is a linked Loan, so the sale pays off the loan
  // balance (the property's own mortgageBalance scalar is retired / already 0).
  const loanDiff = findDiff(apply, 'usHousePropertyLoan.balance');
  assert.ok(loanDiff, 'should record loan payoff to 0');
  assert.strictEqual(loanDiff.after, 0);
  assert.strictEqual(loanDiff.delta, -mortgage);
});

test('EVT-34: US house sale records the loan payoff into its metric series (chart shows 0)', () => {
  // Regression: the sale zeroes the loan in state, but the loan's metric series is
  // otherwise only recorded by LOAN_PAYMENT — which skips a zero-balance loan — so
  // without an explicit snapshot the chart froze at the pre-sale balance while the
  // real balance was 0. The sale handler now emits a RECORD_BALANCE for the loan.
  const config = structuredClone(US_HOUSE_JSON);
  config.realProperties[0].mortgageBalance = 300_000;
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  assert.strictEqual(sim.state.usHousePropertyLoan.balance, 0, 'loan state balance zeroed');
  assert.strictEqual(sim.state.metrics.usHousePropertyLoan, 0,
    'loan metric series should reflect the payoff, not freeze at the pre-sale balance');
});

test('EVT-34: US house sale taxable gain is unaffected by mortgage payoff', () => {
  const config = structuredClone(US_HOUSE_JSON);
  config.realProperties[0].costBasis       = config.realProperties[0].value - 600_000;
  config.realProperties[0].mortgageBalance = 250_000;
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const [tax] = sim.journal.getActions('US_HOUSE_SALE_TAX');
  assert.ok(tax);
  const cgDiff = findDiff(tax, 'usCapitalGainsYTD');
  assert.ok(cgDiff, 'should record taxable capital gain');
  // Gain still computed from salePrice − costBasis − $500K exemption (mortgage ignored).
  assert.strictEqual(cgDiff.delta, (config.realProperties[0].value - config.realProperties[0].costBasis) - 500_000);
});

test('EVT-33: AU house sale credits net proceeds (sale price − mortgage) and zeroes mortgage', () => {
  const config = structuredClone(AU_HOUSE_JSON);
  const mortgage = 400_000;
  config.realProperties[0].mortgageBalance = mortgage;
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const [apply] = sim.journal.getActions('AU_HOUSE_SALE_APPLY');
  assert.ok(apply);

  const cashDiff = findDiff(apply, 'auSavingsAccount.balance');
  assert.ok(cashDiff, 'should credit auSavingsAccount with net proceeds');
  assert.strictEqual(cashDiff.delta, config.realProperties[0].value - mortgage);

  // Design 54 P2: the mortgage is a linked Loan, so the sale pays off the loan
  // balance (the property's own mortgageBalance scalar is retired / already 0).
  const loanDiff = findDiff(apply, 'auHousePropertyLoan.balance');
  assert.ok(loanDiff, 'should record loan payoff to 0');
  assert.strictEqual(loanDiff.after, 0);
  assert.strictEqual(loanDiff.delta, -mortgage);
});

test('EVT-33: AU house sale records the loan payoff into its metric series (chart shows 0)', () => {
  const config = structuredClone(AU_HOUSE_JSON);
  config.realProperties[0].mortgageBalance = 400_000;
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  assert.strictEqual(sim.state.auHousePropertyLoan.balance, 0, 'loan state balance zeroed');
  assert.strictEqual(sim.state.metrics.auHousePropertyLoan, 0,
    'loan metric series should reflect the payoff, not freeze at the pre-sale balance');
});

test('EVT-33: AU house sale capital gain is unaffected by mortgage payoff', () => {
  const config = structuredClone(AU_HOUSE_JSON);
  config.realProperties[0].mortgageBalance = 350_000;
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const [tax] = sim.journal.getActions('AU_HOUSE_SALE_TAX');
  assert.ok(tax);
  const cgDiff = findDiff(tax, 'usCapitalGainsYTD');
  assert.ok(cgDiff, 'should record US capital gain');
  // Gain still computed from salePrice − costBasis (mortgage ignored).
  assert.strictEqual(cgDiff.delta, config.realProperties[0].value - config.realProperties[0].costBasis);
});

// ══════════════════════════════════════════════════════════════════════════════
// saleDestinationAccount routing (US + AU)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-34: US house sale credits saleDestinationAccount instead of default cash pool', () => {
  const config = structuredClone(US_HOUSE_JSON);
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
  config.realProperties[0].saleDestinationAccount = 'checkingAccount';
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const [apply] = sim.journal.getActions('US_HOUSE_SALE_APPLY');
  assert.ok(apply);

  const destDiff = findDiff(apply, 'checkingAccount.balance');
  assert.ok(destDiff, 'sale proceeds should land in checkingAccount (saleDestinationAccount)');
  assert.strictEqual(destDiff.delta, config.realProperties[0].value);

  const defaultDiff = findDiff(apply, 'usSavingsAccount.balance');
  assert.strictEqual(defaultDiff, undefined, 'default usSavingsAccount should not be touched');
});

test('EVT-33: AU house sale credits saleDestinationAccount instead of default cash pool', () => {
  const config = structuredClone(AU_HOUSE_JSON);
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
  config.realProperties[0].saleDestinationAccount = 'checkingAccount';
  const { sim } = loadToolsetScenario(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const [apply] = sim.journal.getActions('AU_HOUSE_SALE_APPLY');
  assert.ok(apply);

  const destDiff = findDiff(apply, 'checkingAccount.balance');
  assert.ok(destDiff, 'sale proceeds should land in checkingAccount (saleDestinationAccount)');
  assert.strictEqual(destDiff.delta, config.realProperties[0].value);

  const defaultDiff = findDiff(apply, 'auSavingsAccount.balance');
  assert.strictEqual(defaultDiff, undefined, 'default auSavingsAccount should not be touched');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-33/34: real-property state carries an FX currency so net worth converts it
//
// Regression: _propertyToStatePlain() omitted `currency`, so an AUD-denominated
// AU house was summed 1:1 as USD in computeNetWorth (and net-liquidity / spending
// guardrails), inflating net worth by the FX factor.
// ─────────────────────────────────────────────────────────────────────────────

test('EVT-33: AU house projects an AUD currency tag into state', () => {
  const { sim } = loadToolsetScenario(AU_HOUSE_JSON);
  assert.strictEqual(sim.state.auHouseProperty.currency?.code, 'AUD',
    'AU property state must carry an AUD currency so net worth FX-converts it');
});

test('EVT-34: US house projects a USD currency tag into state', () => {
  const { sim } = loadToolsetScenario(US_HOUSE_JSON);
  assert.strictEqual(sim.state.usHouseProperty.currency?.code, 'USD',
    'US property state must carry a USD currency');
});

test('EVT-33: AU house net-worth contribution is FX-converted to USD, not counted 1:1', () => {
  const { sim } = loadToolsetScenario(AU_HOUSE_JSON);
  const rate = 1.55; // AUD per USD
  // Isolate the property so the assertion is independent of other seeded accounts.
  const isolated = {
    auHouseProperty:        sim.state.auHouseProperty,
    effectiveExchangeRates: { USD_AUD: rate },
  };
  const value = AU_HOUSE_JSON.realProperties[0].value; // 1,200,000 AUD, no mortgage
  const expectedUsd = value / rate;
  const actual = computeNetWorth(isolated, 'USD');
  assert.ok(Math.abs(actual - expectedUsd) < 1,
    `AU house should contribute ${expectedUsd.toFixed(0)} USD (value/rate), got ${actual.toFixed(0)}`);
  assert.ok(actual < value,
    'converted USD contribution must be less than the raw AUD value (the bug counted it 1:1)');
});

test('EVT-34: US house net-worth contribution is its full USD value (no conversion)', () => {
  const { sim } = loadToolsetScenario(US_HOUSE_JSON);
  const isolated = {
    usHouseProperty:        sim.state.usHouseProperty,
    effectiveExchangeRates: { USD_AUD: 1.55 },
  };
  const value = US_HOUSE_JSON.realProperties[0].value; // 1,000,000 USD, no mortgage
  assert.ok(Math.abs(computeNetWorth(isolated, 'USD') - value) < 1,
    'US house should contribute its full USD value with no FX conversion');
});
