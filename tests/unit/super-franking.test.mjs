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
 * Design 90 §8.4 — franking credits inside super, under design 105's income-only tax.
 *
 * The fund's dividend is INCOME: taxed at the fund rate `t` as it is derived, with the
 * franking credit on an AU dividend (s202-60(2): cash × 30/70) added to the base and
 * offset against the tax, refundably (s207-20, s67-25). It is also kept in pension
 * phase (s207-110(2)(b)). Price growth is untaxed until a lot is sold (design 105). Per
 * lot, the member therefore keeps
 *
 *     (growth − dividend)  +  (dividend + credit) × (1 − t)
 *
 * and the fund books `t × (dividends + credits) − credits`, which can be negative.
 *
 * These configs carry no ECONOMIC_REGIMES, so the handler's AU fallback yield and total
 * reach EVERY lot (the same fallback growth has always used). The yields are set equal
 * so the arithmetic below says that plainly. The credit still arises on the AU lot only,
 * because franking keys off the lot's market, not its yield.
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

const YIELD        = 0.04;
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
      auEquityGrowthRate: total, auEquityDividendYield: YIELD,
      intlExAuEquityGrowthRate: total, intlExAuEquityDividendYield: YIELD,
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

const round2 = x => +x.toFixed(2);

/**
 * The fund's equity lots before any earnings, with each lot's dividend and credit worked
 * exactly as the handler works them (per lot, rounded to cents).
 */
function lots(sim, pct = 1) {
  const out = sim.state.superAccount.holdings
    .filter(h => h.allocation !== 'BOND' && h.allocation !== 'CASH')
    .map(h => {
      const dividend = round2(h.marketValue * YIELD);
      const isAu     = (h.rateKey ?? RATE_KEYS.EQUITY_AU) === RATE_KEYS.EQUITY_AU;
      const credit   = isAu ? round2(frankingCreditOn(dividend, { frankedPercent: pct })) : 0;
      return { mv: h.marketValue, dividend, credit, isAu };
    });
  assert.ok(out.some(l => l.isAu) && out.some(l => !l.isAu), 'super should bootstrap an AU and an ex-AU lot');
  return out;
}

/** Member's balance after one year at total `r` and fund rate `t`, lot by lot. */
function expectedBalance(ls, r, t) {
  return round2(ls.reduce((s, l) =>
    s + l.mv + round2(round2(l.mv * r) - l.dividend) + round2((l.dividend + l.credit) * (1 - t)), 0));
}

/** The fund tax the year books: t on (dividends + credits), less the credits. */
const expectedFundTax = (ls, t) => {
  const d = ls.reduce((s, l) => s + l.dividend, 0);
  const c = ls.reduce((s, l) => s + l.credit, 0);
  return d * t + c * t - c;
};

test('§8.4: accumulation — income taxed at 15%, the credit offsets it, price growth untaxed', () => {
  const sim = load(config({ birthDate: ACCUMULATION }));
  const ls  = lots(sim);
  sim.stepTo(new Date(2027, 0, 15)); // one year-end earnings accrual

  assert.strictEqual(sim.state.superAccount.balance, expectedBalance(ls, 0.07, 0.15));
  assert.ok(Math.abs(sim.state.auPersonSuperTaxYTD.primary - expectedFundTax(ls, 0.15)) < 1e-6);
});

test('§8.4: pension phase — the whole credit is paid, and the fund tax is a refund of it', () => {
  const sim    = load(config({ birthDate: PENSION }));
  const ls     = lots(sim);
  const credit = ls.reduce((s, l) => s + l.credit, 0);

  sim.stepTo(new Date(2027, 0, 15));

  assert.strictEqual(sim.state.superAccount.balance, round2(107000 + credit));
  assert.ok(Math.abs(sim.state.auPersonSuperTaxYTD.primary + credit) < 1e-6);
  // Only the AU lot franks: a credit worked on the whole 4,000 of dividends would be larger.
  assert.ok(credit < frankingCreditOn(4000));
});

test('§8.4: superFrankedPercent 0 leaves only the income tax (15% of the dividends)', () => {
  const sim = load(config({ birthDate: ACCUMULATION, frankedPercent: 0 }));
  sim.stepTo(new Date(2027, 0, 15));

  // 7,000 of return, 4,000 of it dividends: 600 of fund tax, none on the price growth.
  assert.strictEqual(sim.state.superAccount.balance, 106400);
  assert.strictEqual(sim.state.auPersonSuperTaxYTD.primary, 600);
});

test('§8.4: superFrankedPercent scales the credit (partial franking)', () => {
  const sim    = load(config({ birthDate: PENSION, frankedPercent: 0.5 }));
  const credit = lots(sim, 0.5).reduce((s, l) => s + l.credit, 0);

  sim.stepTo(new Date(2027, 0, 15));

  assert.strictEqual(sim.state.superAccount.balance, round2(107000 + credit));
});

test('§8.4: a loss year still taxes its dividends and pays its credit', () => {
  const sim = load(config({ birthDate: ACCUMULATION, total: -0.20 }));
  const ls  = lots(sim);

  sim.stepTo(new Date(2027, 0, 15));

  // The price fall carries no tax and no refund (design 105 — it is unrealised). The
  // dividends paid in the down year are income like any other.
  assert.strictEqual(sim.state.superAccount.balance, expectedBalance(ls, -0.20, 0.15));
  assert.ok(Math.abs(sim.state.auPersonSuperTaxYTD.primary - expectedFundTax(ls, 0.15)) < 1e-6);
});

test('§8.4: reinvested income carries cost base; price growth does not', () => {
  const sim    = load(config({ birthDate: PENSION }));
  const before = new Map(sim.state.superAccount.holdings.map(h => [h.id, h.costBasis]));
  const ls     = new Map(sim.state.superAccount.holdings.map(h => {
    const l = lots(sim).find(x => x.mv === h.marketValue);
    return [h.id, l];
  }));

  sim.stepTo(new Date(2027, 0, 15));

  for (const h of sim.state.superAccount.holdings) {
    const l = ls.get(h.id);
    if (!l) continue;
    // Pension phase: the whole dividend + credit is reinvested, and it is new money.
    assert.strictEqual(round2(h.costBasis - before.get(h.id)), round2(l.dividend + l.credit));
  }
});

test('§8.4: SuperEarningsHandler round-trips frankedPercent, defaulting to 1', () => {
  const h = new SuperEarningsHandler({ role: 'SUPER', frankedPercent: 0.6 });
  assert.strictEqual(h.toJSON().frankedPercent, 0.6);
  assert.strictEqual(SuperEarningsHandler.fromJSON({ ...h.toJSON() }, {}).frankedPercent, 0.6);
  const legacy = { ...h.toJSON() };
  delete legacy.frankedPercent;
  assert.strictEqual(SuperEarningsHandler.fromJSON(legacy, {}).frankedPercent, 1);
});
