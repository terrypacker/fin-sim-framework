/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * evt-fx-transfer-section-988.test.mjs — design 87 phase 3, first disposition emitter.
 *
 * `FX_TRANSFER` was the THIRD conversion path and the only one that never realized §988.
 * `INTL_TRANSFER_APPLY` (G1) and the inline sweep in `replenishSavings` (G2) both did, so
 * the §988 total silently depended on which transfer path a scenario happened to use.
 *
 *   FX988-1  AUD→USD realizes, and the gain has the sign the FX move implies.
 *   FX988-2  the WORKING-DETECTOR control: same conversion, unmoved rate ⇒ nothing.
 *   FX988-3  USD→AUD realizes nothing — acquiring currency establishes basis.
 *   FX988-4  the personal share is CAPITAL, not ordinary §988 (G10).
 *   FX988-5  a personal LOSS is disallowed outright, at any size.
 *   FX988-6  basis accumulated across MANY credits is what the conversion measures (G8).
 *
 * Run with: node --test tests/unit/evt-fx-transfer-section-988.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

function loadFxScenario(config) {
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

/**
 * `auBasisRate` is the pool's authored acquisition rate — AUD per USD, so a HIGHER
 * number is a WEAKER AUD. Authoring it is what makes phases 1–3 non-inert: an unstamped
 * pool is stamped at the rate of its first movement and thereafter measures that rate
 * against itself (design 87 §10).
 */
function makeFxConfig({ auSavingsBalance = 100000, exchangeRate = 1.55, auBasisRate = null } = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER'],
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
    parameters: {
      monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0, auInflationRate: 0,
      rothGrowthRate: 0, iraGrowthRate: 0, k401GrowthRate: 0,
      brokerageGrowthRate: 0, brokerageDividendRate: 0, fixedIncomeInterestRate: 0,
      usSavingsInterestRate: 0, auSavingsInterestRate: 0,
      superGrowthRate: 0, auStockGrowthRate: 0, auStockDividendRate: 0,
      exchangeRateUsdToAud: exchangeRate,
      intlTransferFeeUsd:   0,
    },
    persons: [{
      __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1966-01-01',
      citizen: ['US', 'AU'], lifeExpectancy: 90, monthlyWage: 0,
      retirementDate: '2025-01-01', socialSecurityMonthly: 0,
    }],
    accounts: [
      {
        __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings',
        role: 'us-savings', stateKey: 'usSavingsAccount',
        initialValue: 1000, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
      },
      {
        __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings',
        role: 'au-savings', stateKey: 'auSavingsAccount',
        initialValue: auSavingsBalance, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: '$' },
        ...(auBasisRate != null ? { fxBasisRate: auBasisRate } : {}),
      },
    ],
  };
}

/** Every SECTION_988_GAIN the run journaled. */
function gains(sim) {
  return sim.journal.journal
    .filter(e => e.action?.type === 'SECTION_988_GAIN')
    .map(e => e.action.data ?? e.action);
}

function convert(sim, amount, when = new Date(2026, 5, 15)) {
  sim.schedule({ date: when, type: 'FX_TRANSFER', data: { from: 'AUD', to: 'USD', amount } });
  sim.stepTo(new Date(2026, 6, 31));
}

// ══════════════════════════════════════════════════════════════════════════════

test('FX988-1 an AUD→USD conversion realizes §988, with the sign the FX move implies', () => {
  // Acquired at 1.30 (strong AUD), converted at 1.55 (weak AUD): the AUD bought fewer
  // dollars than its basis, so this is a LOSS.
  const { sim } = loadFxScenario(makeFxConfig({
    auSavingsBalance: 100000, exchangeRate: 1.55, auBasisRate: 1.30,
  }));
  convert(sim, 50000);

  const g = gains(sim);
  assert.equal(g.length, 1, 'exactly one disposition');
  // 50,000 AUD: basis 50000/1.30 = 38,461.54 USD, proceeds 50000/1.55 = 32,258.06 USD.
  const expected = 50000 / 1.55 - 50000 / 1.30;
  assert.ok(Math.abs(g[0].gross - expected) < 0.01,
    `gross ${g[0].gross} should be ${expected}`);
  assert.ok(g[0].gross < 0, 'a weakening AUD is a loss to a USD taxpayer');
});

test('FX988-2 CONTROL — the same conversion at an unmoved rate realizes nothing', () => {
  // Without this, FX988-1 would pass equally well against an emitter that fired on
  // everything, and FX988-3/5 would pass against one that fired on nothing. Design 87 §7
  // trap 5: FX-pinned is not a zero control unless the ACQUISITION rate is pinned to it
  // too, because §988 measures acquisition → disposition, not the rate of change.
  const { sim } = loadFxScenario(makeFxConfig({
    auSavingsBalance: 100000, exchangeRate: 1.55, auBasisRate: 1.55,
  }));
  convert(sim, 50000);

  const g = gains(sim);
  assert.equal(g.length, 0, 'basis rate == disposition rate ⇒ no gain to book');
});

test('FX988-3 a USD→AUD conversion realizes nothing — it ACQUIRES currency', () => {
  const { sim } = loadFxScenario(makeFxConfig({
    auSavingsBalance: 0, exchangeRate: 1.55, auBasisRate: null,
  }));
  sim.schedule({ date: new Date(2026, 5, 15), type: 'FX_TRANSFER', data: { from: 'USD', to: 'AUD', amount: 500 } });
  sim.stepTo(new Date(2026, 6, 31));

  assert.equal(gains(sim).length, 0);
  // ...but it DID establish basis, which is the half that makes a later disposal correct.
  const au = sim.state.auSavingsAccount;
  assert.ok(au.balance > 0, 'AUD arrived');
  assert.ok(Math.abs(au.fxBasisRate - 1.55) < 1e-6, `stamped at the acquisition rate, got ${au.fxBasisRate}`);
});

test('FX988-4 the personal share is CAPITAL, not ordinary §988 — design 87 G10', () => {
  // Converting your own savings to your home currency has no expenses properly allocable
  // to a trade or business, so §988(e)(3) makes it personal and §1.988-1(a)(9) puts it
  // outside §988 entirely. Character falls back to §1001/§1221 — currency is a capital
  // asset. A GAIN here must therefore appear as capital, with `amount` (ordinary) zero.
  const { sim } = loadFxScenario(makeFxConfig({
    auSavingsBalance: 100000, exchangeRate: 1.30, auBasisRate: 1.55,   // AUD strengthened ⇒ gain
  }));
  convert(sim, 50000);

  const g = gains(sim);
  assert.equal(g.length, 1);
  assert.ok(g[0].gross > 0, 'a strengthening AUD is a gain');
  assert.equal(g[0].amount, 0, 'nothing ordinary: the business share is zero');
  assert.ok(g[0].capitalGain > 0, `the personal share is capital, got ${g[0].capitalGain}`);
  assert.ok(Math.abs(g[0].capitalGain - g[0].gross) < 0.01, 'and it is the whole gain');
});

test('FX988-5 a personal LOSS is disallowed outright — §165(c), Quijano', () => {
  const { sim } = loadFxScenario(makeFxConfig({
    auSavingsBalance: 100000, exchangeRate: 1.55, auBasisRate: 1.30,   // AUD weakened ⇒ loss
  }));
  convert(sim, 50000);

  const g = gains(sim);
  assert.equal(g.length, 1);
  assert.equal(g[0].amount, 0, 'no ordinary deduction');
  assert.equal(g[0].capitalGain, 0, 'a loss is not a capital GAIN');
  assert.ok(g[0].disallowedLoss > 0, 'it is disallowed, not merely deferred');
  // The asymmetry that costs real money: the $200 floor is written for gain only, so a
  // personal loss gets no relief at any size while a personal gain under $200 vanishes.
  assert.equal(g[0].deMinimis, 0);
});

test('FX988-7 the capital share reaches the CAPITAL accumulators, not ordinary income', () => {
  // FX988-4 proves the payload is right; this proves the classifier routes it. A payload
  // nothing reads is exactly the failure [[payload-manifest-gate-unwired]] records.
  const { sim } = loadFxScenario(makeFxConfig({
    auSavingsBalance: 100000, exchangeRate: 1.30, auBasisRate: 1.55,
  }));
  const ordinaryBefore = sim.state.usOrdinaryIncomeYTD ?? 0;
  convert(sim, 50000);

  const g = gains(sim)[0];
  const shortTerm = sim.state.usShortTermCapitalGainsYTD ?? 0;
  assert.ok(Math.abs(shortTerm - g.capitalGain) < 0.01,
    `expected ${g.capitalGain} in usShortTermCapitalGainsYTD, got ${shortTerm}`);
  assert.equal(sim.state.usOrdinaryIncomeYTD ?? 0, ordinaryBefore,
    'the personal share must NOT touch ordinary income');
  // Pro-rata cannot state a holding period, so `longTerm` is nullish and the gain is
  // treated as short-term — the conservative reading, and precisely what FIFO would buy.
  // The emitted action carries `null`; the JOURNAL payload omits it entirely, so a
  // consumer must treat absent and null alike. What must never happen is reading either
  // as `false` meaning "known to be short-term" — it means "unknown".
  assert.ok(g.longTerm == null, `pro-rata reports no holding period, got ${g.longTerm}`);
});

test('FX988-8 a HANDLER-level top-up establishes basis before the conversion measures it', () => {
  // `FxTransferToHandler` calls `replenishSavings` to top up its source BEFORE emitting any
  // action, so the credit happens inside the handler with no reducer running. That move
  // once escaped the observer entirely, and the failure was silent in the worst way: the
  // pool rebuilt itself from the current balance and a STALE basis, pricing the topped-up
  // currency at a rate that never applied to it.
  //
  // Note the units invariant does NOT catch this — `readPool` seeds units from the
  // balance, so units always reconcile. Only basis moves, which is why this test asserts a
  // gain figure rather than a drift of zero.
  const { sim } = loadFxScenario(makeFxConfig({
    auSavingsBalance: 1000, exchangeRate: 1.55, auBasisRate: 1.30,
  }));
  sim.state.usSavingsAccount.balance = 100000;
  sim.state.usSavingsAccount.drawdownPriority = 1;

  convert(sim, 5000);   // only 1000 AUD present ⇒ 4000 topped up at 1.55 inside the handler

  const g = gains(sim);
  assert.equal(g.length, 1);
  // basis = 1000/1.30 + 4000/1.55 = 3349.88; proceeds = 5000/1.55 = 3225.81.
  const expected = 5000 / 1.55 - (1000 / 1.30 + 4000 / 1.55);
  assert.ok(Math.abs(g[0].gross - expected) < 0.05,
    `gross ${g[0].gross} should be ${expected} — the top-up must carry its OWN basis`);
  // The wrong answer this guards is -620.35: the whole 5000 priced at the pre-top-up rate.
  assert.ok(Math.abs(g[0].gross - (5000 / 1.55 - 5000 / 1.30)) > 100,
    'must not price the topped-up currency at the old rate');
});

test('FX988-6 the conversion measures basis accumulated across MANY credits — G8', () => {
  // The pool is fed by a USD→AUD conversion at one rate, then converted back at another.
  // Nothing authored: the basis is entirely what the ledger accumulated, which is the
  // capability phase 3 adds over a single authored `fxBasisRate` scalar.
  const { sim } = loadFxScenario(makeFxConfig({ auSavingsBalance: 0, exchangeRate: 1.30 }));

  sim.schedule({ date: new Date(2026, 1, 10), type: 'FX_TRANSFER', data: { from: 'USD', to: 'AUD', amount: 1000 } });
  sim.stepTo(new Date(2026, 2, 1));
  const acquired = sim.state.auSavingsAccount.balance;
  assert.ok(Math.abs(acquired - 1300) < 0.01, `1000 USD at 1.30 ⇒ 1300 AUD, got ${acquired}`);

  // Convert it all back at the SAME rate: a round trip at one rate realizes nothing.
  convert(sim, acquired, new Date(2026, 3, 10));
  assert.equal(gains(sim).length, 0, 'a round trip at one rate has no gain');
  assert.ok(Math.abs(sim.state.auSavingsAccount.balance) < 0.01, 'pool drained');
});
