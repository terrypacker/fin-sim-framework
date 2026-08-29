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
 * evt-shock-dotcom.test.mjs — the DOTCOM_2000_LITE preset (design 21 §14) and the
 * ARRAY form of `levelEffects.equityRevaluation` it introduced.
 *
 * DOTCOM-1: the array form emits ONE REVALUE_ASSET_APPLY per entry, each with its own
 *           multiplier — a US-led bust is not one number applied to every market
 * DOTCOM-2: severity re-scales the array PROPORTIONALLY (the asymmetry survives an MC sweep)
 * DOTCOM-3: 36-month U recovery — still ~2/3 strength at month 24, where a GFC is long gone
 * DOTCOM-4: the policy cut lands on PRIME_* and the fixed-income LEVEL, not on SAVINGS_*
 * DOTCOM-5: end-to-end — the level break marks a US equity account down ~35 %
 * DOTCOM-6: TWO LEGS on different clocks — the rate cut outlives the equity drag
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceRegistry }                from '../../src/services/service-registry.js';
import { ScenarioLoader }                 from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }                   from '../../src/index.js';
import { ECONOMIC_REGIMES }               from '../../src/scenarios/toolsets/economic-regimes-toolset.js';
import { SHOCK_LIBRARY }                  from '../../src/finance/economic-shocks/shock-library.js';
import { EconomicShockHandler }           from '../../src/finance/economic-regimes/economic-shock-handler.js';
import { RecoveryCurves }                 from '../../src/finance/economic-regimes/recovery-curves.js';

beforeEach(() => ServiceRegistry.resetAll());

const SIM_START = new Date('2026-01-01');
const SIM_END   = new Date('2029-01-01');

const BASE_CFG = {
  toolsets:   ['US_BANKING', 'US_TAX', 'US_RETIREMENT', 'ECONOMIC_REGIMES'],
  simStart:   '2026-01-01',
  simEnd:     '2029-01-01',
  parameters: {
    monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
    rothGrowthRate: 0.0, iraGrowthRate: 0, k401GrowthRate: 0,
    brokerageGrowthRate: 0, brokerageDividendRate: 0,
    fixedIncomeInterestRate: 0, usSavingsInterestRate: 0,
  },
  persons: [{
    __type: 'Person', id: 'primary', name: 'Primary',
    birthDate: '1975-04-15', citizen: ['US'], lifeExpectancy: 90,
    monthlyWage: 0, retirementDate: '2025-01-01', socialSecurityMonthly: 0,
  }],
  accounts: [
    {
      __type: 'SavingsAccount', id: 'checking', name: 'Checking',
      role: 'us-savings', stateKey: 'checkingAccount',
      initialValue: 50000, ownershipType: 'sole', ownerId: 'primary',
      minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
    },
    {
      __type: 'RothAccount', stateKey: 'rothAccount', role: 'roth-ira',
      name: 'Roth IRA', initialValue: 100000,
      contributionBasis: 0, ownerId: 'primary',
      drawdownPriority: 5, country: 'US', currency: { code: 'USD', symbol: '$' },
    },
  ],
};

function loadScenario(extraParams = {}, simEnd = SIM_END) {
  const cfg = structuredClone(BASE_CFG);
  cfg.parameters = { ...BASE_CFG.parameters, ...extraParams };
  cfg.simEnd = (simEnd instanceof Date ? simEnd : new Date(simEnd)).toISOString().slice(0, 10);
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context: services.simulationContext, simStart: SIM_START, simEnd: new Date(simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);
  return scenario.sim;
}

test('DOTCOM-1: array levelEffects emit one revaluation per entry, each with its own multiplier', () => {
  const handler = new EconomicShockHandler({
    rateKeyToStateKeys:  {},
    allAccountStateKeys: ['rothAccount'],
  });
  const shock = { ...SHOCK_LIBRARY.DOTCOM_2000_LITE, startDate: new Date('2030-01-01') };
  const actions = handler.call({ data: { shock } });

  const revals = actions.filter(a => a.type === 'REVALUE_ASSET_APPLY');
  const byKey  = Object.fromEntries(revals.map(a => [a.rateKey, a.multiplier]));

  // Four equity markets, three distinct depths — US-led, AU shallow.
  assert.equal(revals.length, 4, `one action per rate key, got ${revals.length}`);
  assert.equal(byKey.EQUITY_US,         -0.35);
  assert.equal(byKey.EQUITY_INTL_EX_AU, -0.35);
  assert.equal(byKey.EQUITY_INTL_EX_US, -0.32);
  assert.equal(byKey.EQUITY_AU,         -0.18);
  assert.ok(byKey.EQUITY_AU > byKey.EQUITY_US, 'AU must fall LESS than the US — that is the preset');
});

test('DOTCOM-2: severity re-scales the array proportionally, preserving the market asymmetry', () => {
  const events = ECONOMIC_REGIMES.schedules({
    parameters: { shocks: [{ preset: 'DOTCOM_2000_LITE', startDate: '2030-01-01', severity: 0.50 }] },
    accounts:   [],
  });
  const shock = events.find(e => e.type === 'ECONOMIC_SHOCK').data.shock;
  const lv    = shock.levelEffects.equityRevaluation;
  assert.ok(Array.isArray(lv), 'array form must survive severity application');

  const byKey = {};
  for (const e of lv) for (const k of e.rateKeys) byKey[k] = e.multiplier;

  // Deepest market takes the headline severity; the rest keep their ratio to it.
  const k = 0.50 / 0.35;
  assert.ok(Math.abs(byKey.EQUITY_US - (-0.50)) < 1e-9, `US takes the headline, got ${byKey.EQUITY_US}`);
  assert.ok(Math.abs(byKey.EQUITY_AU - (-0.18 * k)) < 1e-9, `AU scales with it, got ${byKey.EQUITY_AU}`);
  assert.ok(Math.abs(byKey.EQUITY_AU / byKey.EQUITY_US - 0.18 / 0.35) < 1e-9, 'ratio preserved');
});

test('DOTCOM-3: 36-month U recovery still bites at month 24, where a GFC has fully faded', () => {
  const dot = SHOCK_LIBRARY.DOTCOM_2000_LITE;
  const gfc = SHOCK_LIBRARY.MARKET_CRASH_2008_LITE;
  assert.equal(dot.recovery.profile, 'U');
  assert.equal(dot.recovery.durationMonths, 36);

  const dotAt24 = RecoveryCurves[dot.recovery.profile](24, dot.recovery.durationMonths);
  const gfcAt24 = RecoveryCurves[gfc.recovery.profile](24, gfc.recovery.durationMonths);
  assert.ok(Math.abs(dotAt24 - 2 / 3) < 1e-9, `dot-com at month 24 should be 2/3 strength, got ${dotAt24}`);
  assert.equal(gfcAt24, 0, 'the GFC preset is fully recovered by month 24');

  // Flat for the first 18 months — the stretch a two-year bond bucket has to outlast.
  assert.equal(RecoveryCurves.U(17, 36), 1);
});

test('DOTCOM-4: the policy cut lands on PRIME_* and the fixed-income level, never on SAVINGS_*', () => {
  const rates = SHOCK_LIBRARY.DOTCOM_2000_LITE.legs.find(l => l.id === 'rates');
  const { regime } = rates;
  assert.equal(regime.interestRateAdjustment.PRIME_US, -0.045);
  assert.equal(regime.interestRateAdjustment.PRIME_AU, -0.015);
  // PrimeRelinkReducer ADDS the Prime delta to each linked account's savings key, so a
  // SAVINGS_* adjustment here would cut a Prime-linked account twice.
  assert.equal(regime.interestRateAdjustment.SAVINGS_US, undefined);
  assert.equal(regime.interestRateAdjustment.SAVINGS_AU, undefined);

  const sim = loadScenario({ shocks: [{ preset: 'DOTCOM_2000_LITE', startDate: '2026-03-01' }] });
  sim.stepTo(new Date('2026-05-01'));
  const eff  = sim.state.effectiveInterestRates ?? {};
  const base = sim.state.baseInterestRates ?? {};
  assert.ok(Math.abs((eff.PRIME_US - base.PRIME_US) - (-0.045)) < 1e-9,
    `PRIME_US should be cut 4.5pp, got ${eff.PRIME_US - base.PRIME_US}`);
  assert.ok(Math.abs((eff.FIXED_INCOME_US - base.FIXED_INCOME_US) - (-0.020)) < 1e-9,
    `the bond level should fall 2pp, got ${eff.FIXED_INCOME_US - base.FIXED_INCOME_US}`);
});

test('DOTCOM-5: the level break marks a US equity account down ~35 %', () => {
  const sim = loadScenario({ shocks: [{ preset: 'DOTCOM_2000_LITE', startDate: '2026-03-01' }] });
  sim.stepTo(new Date('2026-04-01'));
  const balance = sim.state.rothAccount.balance;
  assert.ok(balance > 60000 && balance < 70000, `Expected ~65000 after a −35 % break, got ${balance}`);
});


test('DOTCOM-6: the rate cut OUTLIVES the equity drag — two legs, two clocks', () => {
  // The reason the preset has legs at all (design 21 §18.6). On one shared 36-month curve the
  // rate cut round-tripped to zero exactly when the equity leg finished, so the bond sleeve
  // handed back its whole rally — the protection this episode is famous for, deleted by a
  // modelling convention. Assert the two legs decay independently, in the sim, not in the
  // library object.
  const dot = SHOCK_LIBRARY.DOTCOM_2000_LITE;
  assert.equal(dot.legs.length, 2);
  assert.equal(dot.legs.find(l => l.id === 'equity').recovery.durationMonths, 36);
  assert.equal(dot.legs.find(l => l.id === 'rates').recovery.durationMonths, 84);

  // A ten-year horizon: the rate leg alone runs seven, and stepping past simEnd throws.
  const sim = loadScenario({ shocks: [{ preset: 'DOTCOM_2000_LITE', startDate: '2026-02-01' }] },
    new Date('2036-01-01'));

  // Month ~40: the equity leg is spent (U/36 ⇒ factor 0), the rate leg is at full strength
  // (U/84 holds flat for 42 months). Both regimes must be live and carrying different factors.
  sim.stepTo(new Date('2029-06-01'));
  const live = sim.state.activeRegimes ?? [];
  const rateLeg = live.find(r => r.id.endsWith('-rates'));
  assert.ok(rateLeg, `the rate leg must still be active at month 40, got ${live.map(r => r.id).join(', ')}`);
  assert.ok(rateLeg.currentFactor > 0.9, `and at ~full strength, got ${rateLeg.currentFactor}`);

  const eff  = sim.state.effectiveInterestRates ?? {};
  const base = sim.state.baseInterestRates ?? {};
  assert.ok(Math.abs((eff.FIXED_INCOME_US - base.FIXED_INCOME_US) - (-0.020)) < 1e-9,
    `yields must still be 2pp below baseline at month 40, got ${eff.FIXED_INCOME_US - base.FIXED_INCOME_US}`);

  // Past the rate leg too (month ~90): everything is back to baseline.
  sim.stepTo(new Date('2033-09-01'));
  const eff2 = sim.state.effectiveInterestRates ?? {};
  assert.ok(Math.abs(eff2.FIXED_INCOME_US - base.FIXED_INCOME_US) < 1e-9,
    `and back to baseline once the rate leg expires, got ${eff2.FIXED_INCOME_US}`);
});
