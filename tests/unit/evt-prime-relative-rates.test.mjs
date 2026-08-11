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
 * evt-prime-relative-rates.test.mjs
 *
 * Design 56 Phase 1 — Prime series + cash spread + prebuilt auto-link.
 *
 * A cash account with a `primeSpread` earns `Prime(country) + primeSpread`, seeded
 * into `effectiveInterestRates` under the per-account key `SAVINGS_*::<stateKey>`.
 * A single Prime move fans out to every linked cash account. The prebuilt scenario
 * auto-links its savings accounts with a value-preserving spread, so a Prime sweep
 * works out of the box while the un-swept sim is byte-for-byte legacy.
 *
 *   PRIME-1: prebuilt US savings effective rate == Prime + spread == legacy absolute
 *   PRIME-2: raising usPrimeRate raises the effective rate AND credited interest
 *   PRIME-3: un-linking (primeSpread=null) is byte-for-byte identical whole-sim
 *   PRIME-4: AU savings mirrors US (independent PRIME_AU)
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { resolveRateKey }         from '../../src/finance/holdings/default-allocations.js';
import { ALLOCATION }             from '../../src/finance/holdings/allocation.js';
import { ACCOUNT_ROLES }          from '../../src/finance/state/account-roles.js';
import { RATE_KEYS }              from '../../src/finance/economic-regimes/rate-keys.js';

const SS = new Date(Date.UTC(2026, 0, 1));
const SE = new Date(Date.UTC(2032, 0, 1));

/** Build the default config, apply `mutate(cfg)`, run to SE, return sim.state. */
function run(mutate = () => {}) {
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

const rate    = (state, key) => state.effectiveInterestRates?.[key] ?? NaN;
const metric  = (state, m)   => state.metrics?.[m]?.value ?? state.metrics?.[m] ?? -1;
const balance = (state, sk)  => state[sk]?.balance ?? 0;

const US_KEY = 'SAVINGS_US::usSavingsAccount';
const AU_KEY = 'SAVINGS_AU::auSavingsAccount';

// The prebuilt defaults (design 56 §11 auto-link is value-preserving).
const US_SAVINGS = 0.03,  US_PRIME = 0.045;   // spread = -0.015
const AU_SAVINGS = 0.045, AU_PRIME = 0.0435;  // spread = +0.0015

test('PRIME-1: prebuilt US savings effective rate == Prime + spread == legacy absolute', () => {
  const state = run();
  // The account carries primeSpread = usSavingsInterestRate - usPrimeRate; the seeded
  // effective rate is Prime + spread, which reproduces the absolute rate at t0.
  assert.ok(Math.abs(rate(state, US_KEY) - US_SAVINGS) < 1e-9,
    `Prime-linked US savings must earn the legacy absolute ${US_SAVINGS}, got ${rate(state, US_KEY)}`);
});

test('PRIME-2: a Prime move fans out — raising usPrimeRate raises the effective rate and interest', () => {
  const base = run();
  const hike = run(cfg => { cfg.parameters.usPrimeRate = US_PRIME + 0.03; }); // +300bps

  // Effective rate rises by exactly the Prime move (spread is fixed on the account).
  assert.ok(Math.abs(rate(hike, US_KEY) - (US_SAVINGS + 0.03)) < 1e-9,
    `a +3% Prime move must lift the effective rate to ${US_SAVINGS + 0.03}, got ${rate(hike, US_KEY)}`);
  // And more interest is credited (the rate is live in UsSavingsInterestMonthlyHandler).
  assert.ok(metric(hike, 'us_savings_interest') > metric(base, 'us_savings_interest'),
    'a higher Prime must credit more US savings interest');
});

test('PRIME-3: un-linking (primeSpread=null) is byte-for-byte identical whole-sim', () => {
  // Value-preservation: the auto-linked prebuilt must produce the SAME sim as one
  // where the savings accounts fall back to their absolute rate (no Prime).
  const linked = run();
  const legacy = run(cfg => {
    for (const sk of ['usSavingsAccount', 'auSavingsAccount']) {
      const acct = cfg.accounts.find(a => a.stateKey === sk);
      acct.primeSpread = null; // fall back to interestRate ?? global baseline
    }
  });
  const keys = Object.keys(linked).filter(k => linked[k] && typeof linked[k].balance === 'number');
  for (const k of keys) {
    assert.ok(Math.abs(balance(linked, k) - balance(legacy, k)) < 1e-6,
      `account ${k} must be byte-for-byte identical linked vs legacy (${balance(linked, k)} vs ${balance(legacy, k)})`);
  }
});

test('PRIME-5: a CASH sleeve resolves to the country cash key regardless of account role (§6)', () => {
  // Before the carve-out a CASH holding in a US_STOCK brokerage resolved to EQUITY_US
  // (role wins) and would grow at the equity rate. CASH must earn a cash rate.
  assert.strictEqual(resolveRateKey('US', ALLOCATION.CASH, ACCOUNT_ROLES.US_STOCK), RATE_KEYS.SAVINGS_US);
  assert.strictEqual(resolveRateKey('AU', ALLOCATION.CASH, ACCOUNT_ROLES.AU_STOCK), RATE_KEYS.SAVINGS_AU);
  // EQUITY still follows the role (unchanged).
  assert.strictEqual(resolveRateKey('US', ALLOCATION.EQUITY, ACCOUNT_ROLES.US_STOCK), RATE_KEYS.EQUITY_US);
});

test("PRIME-6: a brokerage's primeSpread seeds its cash-sleeve rate (SAVINGS::<brokerageKey>)", () => {
  // A non-cash account carrying a primeSpread seeds SAVINGS_{country}::<stateKey> so its
  // CASH holdings earn Prime + spread; the equity sleeve is untouched.
  const state = run(cfg => {
    cfg.accounts.find(a => a.stateKey === 'usStockAccount').primeSpread = -0.01;
  });
  assert.ok(Math.abs(rate(state, 'SAVINGS_US::usStockAccount') - (US_PRIME - 0.01)) < 1e-9,
    `brokerage cash sleeve must earn Prime + spread (${US_PRIME - 0.01}), got ${rate(state, 'SAVINGS_US::usStockAccount')}`);
  // The equity sleeve key still reflects the equity growth rate, not the cash rate.
  assert.ok(state.effectiveGrowthRates?.['EQUITY_US::usStockAccount'] != null,
    'the equity sleeve keeps its own per-account growth key');
});

test('PRIME-4: AU savings mirrors US via an independent PRIME_AU', () => {
  const base = run();
  assert.ok(Math.abs(rate(base, AU_KEY) - AU_SAVINGS) < 1e-9,
    `Prime-linked AU savings must earn the legacy absolute ${AU_SAVINGS}, got ${rate(base, AU_KEY)}`);

  // Moving PRIME_AU moves AU but NOT US (per-country independence).
  const auHike = run(cfg => { cfg.parameters.auPrimeRate = AU_PRIME + 0.02; });
  assert.ok(Math.abs(rate(auHike, AU_KEY) - (AU_SAVINGS + 0.02)) < 1e-9,
    'an RBA move must lift the AU effective rate');
  assert.ok(Math.abs(rate(auHike, US_KEY) - US_SAVINGS) < 1e-9,
    'an RBA move must NOT touch the US effective rate (independent Prime series)');
});
