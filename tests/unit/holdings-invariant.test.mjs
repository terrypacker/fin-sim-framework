/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';

/**
 * Walk every Account-shaped state entry and verify that
 *   account.balance === Σ holdings[i].marketValue   (rounded to cents)
 * holds. Tolerance is 1 cent to absorb floating-point rounding.
 */
function assertHoldingsInvariant(state, label) {
  for (const [k, v] of Object.entries(state)) {
    if (!v || typeof v !== 'object') continue;
    if (typeof v.balance !== 'number') continue;
    if (!Array.isArray(v.holdings)) continue;
    const sumMv = v.holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
    assert.ok(
      Math.abs(sumMv - v.balance) <= 1.0,
      `[${label}] ${k}: balance=${v.balance.toFixed(2)} but Σholdings=${sumMv.toFixed(2)} ` +
      `(diff=${(sumMv - v.balance).toFixed(2)})`
    );
  }
}

function setupScenario(simStart, simEnd) {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const scenario = new IntlRetirementScenario({
    context:  registry.simulationContext,
    simStart, simEnd,
  });
  scenario.buildSim();
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, simStart, simEnd);
  new ScenarioLoader().load(cfg, registry);
  return scenario.sim;
}

// ─── §4.4 invariant — boot ────────────────────────────────────────────────────

test('Holdings invariant: holds at scenario boot for every account', () => {
  const sim = setupScenario(new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2030, 0, 1)));
  assertHoldingsInvariant(sim.state, 'boot');
});

// ─── §4.4 invariant — after simulation runs ──────────────────────────────────

test('Holdings invariant: holds after 5 years of IntlRetirementScenario', () => {
  const simStart = new Date(Date.UTC(2025, 0, 1));
  const simEnd   = new Date(Date.UTC(2030, 0, 1));
  const sim      = setupScenario(simStart, simEnd);
  sim.stepTo(simEnd);
  assertHoldingsInvariant(sim.state, '5yr');
});

test('Holdings invariant: holds after 10 years of IntlRetirementScenario', () => {
  const simStart = new Date(Date.UTC(2025, 0, 1));
  const simEnd   = new Date(Date.UTC(2035, 0, 1));
  const sim      = setupScenario(simStart, simEnd);
  sim.stepTo(simEnd);
  assertHoldingsInvariant(sim.state, '10yr');
});

// ─── Default holdings bootstrap ──────────────────────────────────────────────

test('Holdings bootstrap: every registered account has exactly one default holding at boot', () => {
  const sim = setupScenario(new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
  let accountCount = 0;
  for (const [k, v] of Object.entries(sim.state)) {
    if (!v || typeof v !== 'object') continue;
    if (typeof v.balance !== 'number') continue;
    if (!Array.isArray(v.holdings)) continue;
    accountCount++;
    assert.equal(v.holdings.length, 1, `${k} should have exactly 1 default holding after bootstrap`);
    assert.equal(v.holdings[0].marketValue, v.balance, `${k} default holding marketValue must equal balance`);
    assert.ok(v.holdings[0].allocation, `${k} default holding must carry an ALLOCATION`);
    assert.ok(v.holdings[0].rateKey, `${k} default holding must carry a rateKey`);
  }
  assert.ok(accountCount >= 10, `expected ≥10 production accounts, got ${accountCount}`);
});

// ─── Allocation & rateKey resolution per role ────────────────────────────────

test('Holdings bootstrap: FIXED_INCOME role → BOND allocation + FIXED_INCOME_US rateKey', () => {
  const sim = setupScenario(new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
  const fi = sim.state.fixedIncomeAccount;
  assert.ok(fi);
  assert.equal(fi.holdings[0].allocation, 'BOND');
  assert.equal(fi.holdings[0].rateKey, 'FIXED_INCOME_US');
});

test('Holdings bootstrap: AU_FIXED_INCOME role → BOND + FIXED_INCOME_AU', () => {
  const sim = setupScenario(new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
  const fi = sim.state.auFixedIncomeAccount;
  assert.ok(fi);
  assert.equal(fi.holdings[0].allocation, 'BOND');
  assert.equal(fi.holdings[0].rateKey, 'FIXED_INCOME_AU');
});

test('Holdings bootstrap: SUPER role → EQUITY + EQUITY_AU', () => {
  const sim = setupScenario(new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
  const su = sim.state.superAccount;
  assert.ok(su);
  assert.equal(su.holdings[0].allocation, 'EQUITY');
  assert.equal(su.holdings[0].rateKey, 'EQUITY_AU');
});

test('Holdings bootstrap: US_SAVINGS role → CASH + SAVINGS_US', () => {
  const sim = setupScenario(new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
  const sv = sim.state.usSavingsAccount;
  assert.ok(sv);
  assert.equal(sv.holdings[0].allocation, 'CASH');
  assert.equal(sv.holdings[0].rateKey, 'SAVINGS_US');
});
