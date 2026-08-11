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
 * evt-per-account-instance-rate.test.mjs
 *
 * Per-account-INSTANCE growth rates (design 55 §8 / Phase 2).
 *
 * Distinct from evt-per-account-growth (which covers per-account-TYPE keys):
 * two accounts of the SAME type can grow at DIFFERENT rates because each carries
 * its own `growthRate`, seeded into `effectiveGrowthRates` under a per-account key
 * `<memberKey>::<stateKey>`. A class-level regime shock still fans onto every
 * per-account key, so per-account rates coexist with regimes.
 *
 *   EVT-PAIR-1: two same-type accounts with different growthRate diverge
 *   EVT-PAIR-2: a class shock fans onto BOTH per-account keys (regime-aware)
 *   EVT-PAIR-3: setting the rate via the generated param cascades identically
 *   EVT-PAIR-4: unset growthRate ≡ the global rate (single-rate parity)
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';

const SS = new Date(Date.UTC(2026, 0, 1));
const SE = new Date(Date.UTC(2032, 0, 1));

/** Build the default config, apply `mutate(cfg)`, run to SE, return sim.state. */
function run(mutate) {
  ServiceRegistry.resetAll();
  const reg = ServiceRegistry.getInstance();
  const sc  = new IntlRetirementScenario({ context: reg.simulationContext, simStart: SS, simEnd: SE });
  sc.buildSim();
  const cfg = ScenarioSerializer.serializeScenario(IntlRetirementScenario.buildDefaultConfig({}, SS, SE));
  cfg.parameters = { ...(cfg.parameters ?? {}) };
  mutate(cfg);
  new ScenarioLoader().load(cfg, reg);
  sc.sim.silent = true; sc.sim.journal.enabled = false;
  sc.sim.stepTo(SE);
  return sc.sim.state;
}

/** Clone the default Roth into a second Roth account with its own stateKey. */
function addSecondRoth(cfg) {
  const roth  = cfg.accounts.find(a => a.stateKey === 'rothAccount');
  const clone = structuredClone(roth);
  clone.stateKey = 'rothAccount2';
  clone.id       = 'roth-account-2';
  clone.name     = 'Roth IRA (Second)';
  delete clone.holdings; // let AccountService re-bootstrap a fresh default holding
  cfg.accounts.push(clone);
  return { roth, clone };
}

const bal = (state, key) => Math.round(state[key]?.balance ?? -1);

test('EVT-PAIR-1: two same-type accounts with different growthRate diverge', () => {
  const state = run(cfg => {
    const { roth, clone } = addSecondRoth(cfg);
    roth.growthRate  = 0.02;
    clone.growthRate = 0.20;
  });

  const b1 = bal(state, 'rothAccount');
  const b2 = bal(state, 'rothAccount2');
  assert.ok(b2 > b1 * 1.5,
    `the 20% Roth (${b2}) should far outgrow the 2% Roth (${b1})`);

  // Each account seeded its own per-account rate key.
  const eff = state.effectiveGrowthRates ?? {};
  assert.ok(Math.abs((eff['EQUITY_US::rothAccount']  ?? NaN) - 0.02) < 1e-9);
  assert.ok(Math.abs((eff['EQUITY_US::rothAccount2'] ?? NaN) - 0.20) < 1e-9);
});

test('EVT-PAIR-2: a class-level shock fans onto BOTH per-account keys', () => {
  const base = run(cfg => {
    const { roth, clone } = addSecondRoth(cfg);
    roth.growthRate  = 0.06;
    clone.growthRate = 0.10;
  });
  const shock = run(cfg => {
    const { roth, clone } = addSecondRoth(cfg);
    roth.growthRate  = 0.06;
    clone.growthRate = 0.10;
    cfg.parameters.shocks = [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2028-01-01' }];
  });

  // The US-equity class shock depresses BOTH per-account Roths — per-account rates
  // do not make an account regime-immune.
  assert.ok(bal(shock, 'rothAccount')  < bal(base, 'rothAccount'),
    'shock should depress the 6% Roth');
  assert.ok(bal(shock, 'rothAccount2') < bal(base, 'rothAccount2'),
    'shock should depress the 10% Roth (fan-out reaches the second per-account key)');
});

test('EVT-PAIR-3: setting the rate via the generated param cascades identically', () => {
  // Set growthRate on the record directly...
  const viaRecord = run(cfg => {
    const { roth, clone } = addSecondRoth(cfg);
    roth.growthRate  = 0.03;
    clone.growthRate = 0.15;
  });
  // ...vs via the generated per-account params (the user-facing edit surface).
  const viaParam = run(cfg => {
    addSecondRoth(cfg); // records carry no explicit rate
    cfg.parameters['acct.rothAccount.growthRate']  = 0.03;
    cfg.parameters['acct.rothAccount2.growthRate'] = 0.15;
  });

  assert.strictEqual(bal(viaParam, 'rothAccount'),  bal(viaRecord, 'rothAccount'),
    'param edit must match a direct record edit for the first Roth');
  assert.strictEqual(bal(viaParam, 'rothAccount2'), bal(viaRecord, 'rothAccount2'),
    'param edit must match a direct record edit for the second Roth');
});

test('EVT-PAIR-5: per-account interestRate drives US savings interest (no dead wire)', () => {
  // UsSavingsInterestMonthlyHandler computes interest inline (not via
  // computeHoldingsGrowth), so it must consult the per-account key itself. The
  // savings balance is a transaction account (swamped by cash flows), so assert on
  // the credited-interest metric, which is a clean per-account signal.
  const interestMetric = (rate) => {
    const state = run(cfg => {
      const acct = cfg.accounts.find(a => a.stateKey === 'usSavingsAccount');
      // Design 56: the prebuilt US savings is Prime-linked (primeSpread), which
      // shadows the absolute interestRate. Un-link it to exercise the legacy
      // per-account interestRate wire this test guards.
      acct.primeSpread  = null;
      acct.interestRate = rate;
    });
    // Per-account key must be seeded distinctly from the shared class key.
    assert.ok(Math.abs((state.effectiveInterestRates?.['SAVINGS_US::usSavingsAccount'] ?? NaN) - rate) < 1e-9,
      'SAVINGS_US::usSavingsAccount must carry the per-account rate');
    return Math.round(state.metrics?.us_savings_interest?.value ?? state.metrics?.us_savings_interest ?? -1);
  };
  assert.ok(interestMetric(0.50) > interestMetric(0.001),
    'a higher per-account interestRate must credit more US savings interest');
});

test('EVT-PAIR-4: unset growthRate ≡ the global rate (single-rate parity)', () => {
  // A second Roth with no explicit rate must grow at the global rothGrowthRate,
  // identically to the primary Roth (same balance, same holdings) — proving the
  // per-account key inherits the shared baseline when unset.
  const state = run(cfg => {
    const { clone } = addSecondRoth(cfg);
    // Match the primary Roth's starting balance so equal rates ⇒ equal ending balance.
    const roth = cfg.accounts.find(a => a.stateKey === 'rothAccount');
    clone.balance = roth.balance;
    cfg.parameters.rothGrowthRate = 0.07;
  });
  assert.strictEqual(bal(state, 'rothAccount2'), bal(state, 'rothAccount'),
    'an unset second Roth grows identically to the primary at the global rate');
});
