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
 * Design 90 §8.4 — franking credits inside super.
 *
 * The fund's AU dividend is inside the market total it grows at; the credit on it
 * (s202-60(2): cash × 30/70) is on top, refundable to a complying fund (s67-25) and
 * kept in pension phase (s207-110(2)(b)). Net to the member: `credit × (1 − t)`.
 * The fund's tax on it: `t × credit − credit` — negative, a refund.
 *
 * Expectations are derived from the AU lot the fund actually bootstraps (design 99
 * P5c splits un-authored super into AU and ex-AU lots), so these tests pin the
 * arithmetic, not the APRA mix.
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';
import { SuperEarningsHandler } from '../../src/finance/handlers/earnings-handlers.js';
import { RATE_KEYS }       from '../../src/finance/economic-regimes/rate-keys.js';
import { frankingCreditOn } from '../../src/finance/tax/au/franking.js';

beforeEach(() => ServiceRegistry.resetAll());

const AU_YIELD    = 0.04;
const EXAU_YIELD  = 0.02;
const ACCUMULATION = '1990-01-01';
const PENSION      = '1962-01-01';

function load(config) {
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

function config({ birthDate, total = 0.07, frankedPercent } = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER'],
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
    parameters: {
      monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
      usEquityGrowthRate: 0, intlExUsEquityGrowthRate: 0,
      usEquityDividendYield: 0, intlExUsEquityDividendYield: 0, fixedIncomeInterestRate: 0,
      usSavingsInterestRate: 0, auSavingsInterestRate: 0,
      auEquityGrowthRate: total, auEquityDividendYield: AU_YIELD,
      intlExAuEquityGrowthRate: total, intlExAuEquityDividendYield: EXAU_YIELD,
      ...(frankedPercent != null ? { superFrankedPercent: frankedPercent } : {}),
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

/** The fund's AU-equity market value before any earnings — the franked base. */
function auLotValue(sim) {
  const lots = sim.state.superAccount.holdings.filter(h =>
    (h.rateKey ?? RATE_KEYS.EQUITY_AU) === RATE_KEYS.EQUITY_AU
    && h.allocation !== 'BOND' && h.allocation !== 'CASH');
  assert.ok(lots.length > 0, 'super bootstrapped no AU equity lot');
  return lots.reduce((s, h) => s + h.marketValue, 0);
}

const creditOn = (auMv, pct = 1) => +frankingCreditOn(+(auMv * AU_YIELD).toFixed(2), { frankedPercent: pct }).toFixed(2);
const round2   = x => +x.toFixed(2);

test('§8.4: accumulation — the member keeps 85% of the credit; the fund books t·credit − credit', () => {
  const sim   = load(config({ birthDate: ACCUMULATION }));
  const auMv  = auLotValue(sim);
  const credit = creditOn(auMv);
  assert.ok(credit > 0);

  sim.stepTo(new Date(2027, 0, 15)); // one year-end earnings accrual

  const netCredit = round2(frankingCreditOn(round2(auMv * AU_YIELD)) * 0.85);
  assert.strictEqual(sim.state.superAccount.balance, round2(100000 + 7000 * 0.85 + netCredit));
  assert.ok(Math.abs(sim.state.auPersonSuperTaxYTD.primary - (1050 + credit * 0.15 - credit)) < 1e-6);
});

test('§8.4: pension phase — the whole credit is paid, and the fund tax is a refund of it', () => {
  const sim   = load(config({ birthDate: PENSION }));
  const credit = creditOn(auLotValue(sim));

  sim.stepTo(new Date(2027, 0, 15));

  assert.strictEqual(sim.state.superAccount.balance, round2(107000 + credit));
  assert.ok(Math.abs(sim.state.auPersonSuperTaxYTD.primary + credit) < 1e-6);
});

test('§8.4: superFrankedPercent 0 reproduces the pre-§8.4 model exactly', () => {
  const sim = load(config({ birthDate: ACCUMULATION, frankedPercent: 0 }));
  sim.stepTo(new Date(2027, 0, 15));

  assert.strictEqual(sim.state.superAccount.balance, 105950);
  assert.strictEqual(sim.state.auPersonSuperTaxYTD.primary, 1050);
});

test('§8.4: superFrankedPercent scales the credit (partial franking)', () => {
  const sim    = load(config({ birthDate: PENSION, frankedPercent: 0.5 }));
  const credit = creditOn(auLotValue(sim), 0.5);

  sim.stepTo(new Date(2027, 0, 15));

  assert.strictEqual(sim.state.superAccount.balance, round2(107000 + credit));
});

test('§8.4: a loss year still receives the credit (dividends are paid in a down year)', () => {
  const sim    = load(config({ birthDate: ACCUMULATION, total: -0.20 }));
  const credit = creditOn(auLotValue(sim));

  sim.stepTo(new Date(2027, 0, 15));

  // No Div 295 base on the loss (design 84 G12); the credit arrives whole and is the
  // fund's only tax item — a refund.
  assert.strictEqual(sim.state.superAccount.balance, round2(80000 + credit));
  assert.ok(Math.abs(sim.state.auPersonSuperTaxYTD.primary + credit) < 1e-6);
});

test('§8.4: only AU equity franks — an all-ex-AU fund gets no credit', () => {
  const cfg = config({ birthDate: PENSION });
  cfg.parameters.auEquityDividendYield = 0; // the AU lot pays nothing; ex-AU still yields 2%
  const sim = load(cfg);
  sim.stepTo(new Date(2027, 0, 15));

  assert.strictEqual(sim.state.superAccount.balance, 107000);
  assert.strictEqual(sim.state.auPersonSuperTaxYTD.primary, 0);
});

test('§8.4: SuperEarningsHandler round-trips frankedPercent, defaulting to 1', () => {
  const h = new SuperEarningsHandler({ role: 'SUPER', frankedPercent: 0.6 });
  assert.strictEqual(h.toJSON().frankedPercent, 0.6);
  assert.strictEqual(SuperEarningsHandler.fromJSON({ ...h.toJSON() }, {}).frankedPercent, 0.6);
  const legacy = { ...h.toJSON() };
  delete legacy.frankedPercent;
  assert.strictEqual(SuperEarningsHandler.fromJSON(legacy, {}).frankedPercent, 1);
});
