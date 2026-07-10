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
 * evt-prime-loans.test.mjs
 *
 * Design 56 Phase 3 — loans track Prime.
 *
 * A mortgage with a `mortgagePrimeSpread` synthesizes a loan whose effective rate is
 * `Prime(country,t) + primeSpread`, read live by LoanPaymentHandler from
 * `state.effectiveInterestRates[PRIME_{country}]`. So a variable-rate mortgage's monthly
 * interest rises when the central bank moves mid-run (time-varying Prime comes free from
 * Phase 2b, which keeps PRIME_* current in the effective map). A spread-less mortgage is
 * the pre-56 fixed loan.
 *
 *   PRIME-LOAN-1: a spread-linked mortgage's effective rate = Prime + spread at t0.
 *   PRIME-LOAN-2: a mid-run PRIME_US hike raises the loan's effective rate and its balance
 *                 (more of each fixed payment goes to interest → slower paydown).
 *   PRIME-LOAN-3: a spread-less (fixed) mortgage is unchanged by the Prime hike.
 *   PRIME-LOAN-U1..2: resolveLoanRate() unit postconditions (Prime-linked vs fixed fallback).
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { resolveLoanRate }        from '../../src/finance/account-rules/loan-classes.js';

const SS = new Date(Date.UTC(2026, 0, 1));
const SE = new Date(Date.UTC(2032, 0, 1));

const US_PRIME = 0.045;
const MORTGAGE_ABS = 0.06;                       // the rate the bank quotes
const SPREAD = MORTGAGE_ABS - US_PRIME;          // value-preserving spread = 0.015
const LOAN_KEY = 'usHousePropertyLoan';

/** Add a Prime-linked (or fixed) mortgage to the prebuilt US house. */
function mortgageUsHouse(cfg, { linked }) {
  const prop = cfg.realProperties.find(p => p.stateKey === 'usHouseProperty');
  prop.mortgageBalance      = 500_000;
  prop.monthlyMortgage      = 3_000;
  prop.mortgageInterestRate = MORTGAGE_ABS;
  prop.mortgagePrimeSpread  = linked ? SPREAD : null;
}

/** A permanent (L-profile) mid-run PRIME_US hike, authored as a custom shock. */
function primeHike(delta, startDate = '2028-01-01') {
  return {
    shockId: 'PRIME_HIKE', name: 'Prime Hike', startDate,
    regime: { interestRateAdjustment: { PRIME_US: delta } },
    recovery: { profile: 'L', durationMonths: 600 },
  };
}

/** Build default config, apply mutate(cfg), run to SE, return sim.state. */
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

test('PRIME-LOAN-1: a spread-linked mortgage earns Prime + spread at t0', () => {
  const state = run(cfg => mortgageUsHouse(cfg, { linked: true }));
  const loan  = state[LOAN_KEY];
  assert.ok(loan, 'the mortgaged property must synthesize a loan');
  assert.strictEqual(loan.primeSpread, SPREAD, 'the loan carries the mortgage prime spread');
  // effective = Prime(US, t0) + spread = the absolute the bank quoted (value-preserving).
  assert.ok(Math.abs(resolveLoanRate(state, loan) - MORTGAGE_ABS) < 1e-9,
    `linked loan must resolve to Prime + spread = ${MORTGAGE_ABS}, got ${resolveLoanRate(state, loan)}`);
});

test('PRIME-LOAN-2: a mid-run PRIME_US hike raises the loan rate and its balance', () => {
  const base = run(cfg => mortgageUsHouse(cfg, { linked: true }));
  const hike = run(cfg => { mortgageUsHouse(cfg, { linked: true }); cfg.parameters.shocks = [primeHike(0.03)]; });

  // The live effective rate tracks the hiked Prime (+3%).
  assert.ok(Math.abs(resolveLoanRate(hike, hike[LOAN_KEY]) - (MORTGAGE_ABS + 0.03)) < 1e-9,
    `hiked loan rate must be ${MORTGAGE_ABS + 0.03}, got ${resolveLoanRate(hike, hike[LOAN_KEY])}`);
  // Higher rate on a fixed payment ⇒ more interest, less principal ⇒ a higher ending balance.
  assert.ok(hike[LOAN_KEY].balance > base[LOAN_KEY].balance + 1,
    `a Prime hike must slow paydown (higher ending balance): base ${base[LOAN_KEY].balance}, hike ${hike[LOAN_KEY].balance}`);
});

test('PRIME-LOAN-3: a spread-less (fixed) mortgage is unchanged by the Prime hike', () => {
  const base = run(cfg => mortgageUsHouse(cfg, { linked: false }));
  const hike = run(cfg => { mortgageUsHouse(cfg, { linked: false }); cfg.parameters.shocks = [primeHike(0.03)]; });

  // Fixed loan: rate stays the absolute mortgage rate regardless of Prime.
  assert.ok(Math.abs(resolveLoanRate(hike, hike[LOAN_KEY]) - MORTGAGE_ABS) < 1e-9,
    `a fixed loan must stay at ${MORTGAGE_ABS}, got ${resolveLoanRate(hike, hike[LOAN_KEY])}`);
  // And its amortization is byte-for-byte identical with or without the hike.
  assert.ok(Math.abs(hike[LOAN_KEY].balance - base[LOAN_KEY].balance) < 1e-6,
    'a fixed loan balance must be identical with or without the Prime hike');
});

// ── resolveLoanRate() isolated postconditions ──────────────────────────────────

test('PRIME-LOAN-U1: resolveLoanRate = Prime + spread for a linked loan', () => {
  const state = { effectiveInterestRates: { PRIME_US: 0.065, PRIME_AU: 0.05 } };
  assert.ok(Math.abs(resolveLoanRate(state, { country: 'US', primeSpread: 0.015, interestRate: 0.06 }) - 0.08) < 1e-12,
    'US linked loan = PRIME_US + spread');
  assert.ok(Math.abs(resolveLoanRate(state, { country: 'AU', primeSpread: 0.02, interestRate: 0.055 }) - 0.07) < 1e-12,
    'AU linked loan = PRIME_AU + spread (independent series)');
});

test('PRIME-LOAN-U2: resolveLoanRate falls back to the absolute rate when unlinked or Prime absent', () => {
  const state = { effectiveInterestRates: { PRIME_US: 0.065 } };
  // No spread → fixed absolute.
  assert.strictEqual(resolveLoanRate(state, { country: 'US', primeSpread: null, interestRate: 0.06 }), 0.06);
  // Spread set but no Prime series → fixed absolute (defensive back-compat).
  assert.strictEqual(resolveLoanRate({ effectiveInterestRates: {} }, { country: 'US', primeSpread: 0.01, interestRate: 0.06 }), 0.06);
});
