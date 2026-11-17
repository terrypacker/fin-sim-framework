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
 * au-fy-settle-attribution.test.mjs — issue #775.
 *
 * The AU settle fires on 30 June (order 100) and assesses the fiscal year that ends that day.
 * A calendar-year view of AU tax therefore reads the FY ending in June of that year, and
 * nothing else. These tests pin the boundary, so a per-year AU swing can be read as a real
 * change in when income arrived and not as an attribution artefact:
 *
 *  FY-ATTR-1  income booked on 30 June (before the settle) is assessed by that day's settle
 *  FY-ATTR-2  the same income on 1 July is assessed by the NEXT settle, a year later
 *  FY-ATTR-3  a one-day move across the boundary swings tax between the two settles, and each
 *             run's pair total is the base plus THAT FY's tax on the income: the 2027 settle
 *             rises by FY 2026–27's tax on it, the 2028 settle by FY 2027–28's. Each FY's tax is
 *             measured independently, from the same income at the FY's other end. The two
 *             differ (each FY has its own rate schedule), so the pair totals are NOT equal; a
 *             swing can only be attribution if this decomposition holds
 *  FY-ATTR-4  every settle's taxYear is the FY that starts on 1 July of the previous year
 *
 * Run with: node --test tests/unit/au-fy-settle-attribution.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry }    from '../../src/services/service-registry.js';
import { ScenarioLoader }     from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }       from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

// A single AU resident with no other income, so every FY starts from the same zero base and the
// injected amount is taxed identically whichever FY it falls in: the comparison is about
// attribution, not marginal-rate effects.
// Savings interest is zeroed: otherwise paying the extra tax on 30 June shrinks the balance and
// the next FY earns less interest, a real second-order effect that is not what these tests pin.
const CONFIG = {
  toolsets: ['AU_RETIREMENT', 'AU_REAL_PROPERTY', 'US_TAX'],   // AU_REAL_PROPERTY declares AU_RENTAL_INCOME_TAX
  simStart: '2026-01-01', simEnd: '2030-01-01',
  parameters: { auSavingsInterestRate: 0, usSavingsInterestRate: 0 },
  persons: [{
    __type: 'Person', id: 'primary', name: 'Primary',
    birthDate: '1975-04-15', lifeExpectancy: 90,
    monthlyWage: 0, retirementDate: '2025-01-01', socialSecurityMonthly: 0,
    citizen: ['AU'], residency: 'AU',
  }],
  accounts: [{
    __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings',
    type: 'savings', role: 'au-savings', stateKey: 'auSavingsAccount',
    initialValue: 500_000, ownershipType: 'sole', ownerId: 'primary',
    minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: '$' },
  }],
};

const INCOME = 60_000;

/** AU settles by date (YYYY-MM-DD) → { tax, taxYear, income } for a run with optional income on `incomeDate`. */
function runSettles(incomeDate) {
  ServiceRegistry.resetAll();   // each test compares two runs; services are per-run
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(CONFIG.simStart),
    simEnd:   new Date(CONFIG.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(structuredClone(CONFIG), services);
  const sim = scenario.sim;
  if (incomeDate) {
    // AU_RENTAL_INCOME_TAX is the simplest AU ordinary-income action: it accrues to the
    // owner's per-person ordinary income at the default order (0), i.e. before the settle.
    sim.register('TEST_AU_INCOME', () => [{
      type: 'AU_RENTAL_INCOME_TAX', amount: INCOME, ownershipType: 'sole', ownerId: 'primary',
    }]);
    sim.schedule({ date: incomeDate, type: 'TEST_AU_INCOME', data: {} });
  }
  sim.stepTo(new Date(CONFIG.simEnd));

  const out = {};
  const seen = new Set();
  for (const e of sim.journal.journal) {
    if (e.action?.type !== 'AU_TAX_SETTLE_APPLY' || seen.has(e.action.instanceId)) continue;
    seen.add(e.action.instanceId);
    const d = e.action.data ?? e.action;
    const p = (d.personTaxDetails ?? [])[0]?.taxDetail ?? {};
    out[new Date(e.date).toISOString().slice(0, 10)] = {
      tax: d.tax ?? 0, taxYear: p.taxYear, income: p.assessableIncome ?? 0,
    };
  }
  return out;
}

const JUN_30 = new Date(Date.UTC(2027, 5, 30));
const JUL_01 = new Date(Date.UTC(2027, 6, 1));

test('FY-ATTR-1: income on 30 June is assessed by that day\'s settle', () => {
  const base = runSettles(null);
  const s = runSettles(JUN_30);
  assert.ok(Math.abs((s['2027-06-30'].income - base['2027-06-30'].income) - INCOME) < 0.01,
    `30 June income should be in FY 2026–27: Δincome ${s['2027-06-30'].income - base['2027-06-30'].income}`);
  assert.ok(Math.abs(s['2028-06-30'].income - base['2028-06-30'].income) < 0.01,
    'and not in FY 2027–28');
});

test('FY-ATTR-2: income on 1 July is assessed by the next settle', () => {
  const base = runSettles(null);
  const s = runSettles(JUL_01);
  assert.ok(Math.abs(s['2027-06-30'].income - base['2027-06-30'].income) < 0.01,
    '1 July income should not be in FY 2026–27');
  assert.ok(Math.abs((s['2028-06-30'].income - base['2028-06-30'].income) - INCOME) < 0.01,
    `1 July income should be in FY 2027–28: Δincome ${s['2028-06-30'].income - base['2028-06-30'].income}`);
});

test('FY-ATTR-3: a one-day move swings tax between adjacent settles; the pair total is the two FY assessments', () => {
  const base = runSettles(null);
  const jun27 = runSettles(JUN_30);
  const jul27 = runSettles(JUL_01);
  // Each FY's tax on the income, from the same income at the other end of that FY.
  const fy2026 = runSettles(new Date(Date.UTC(2026, 6, 1)));    // FY 2026–27, first day
  const fy2027 = runSettles(new Date(Date.UTC(2027, 11, 31)));  // FY 2027–28, mid-year
  const d = (run, k) => run[k].tax - base[k].tax;
  const t26 = d(fy2026, '2027-06-30');
  const t27 = d(fy2027, '2028-06-30');
  assert.ok(t26 > 5_000 && t27 > 5_000, `each FY should tax the income: ${t26}, ${t27}`);

  // 30 June: the whole charge is FY 2026–27's, on the 2027 settle.
  assert.ok(Math.abs(d(jun27, '2027-06-30') - t26) < 1, `30 June: 2027 settle Δ ${d(jun27, '2027-06-30')} vs FY tax ${t26}`);
  assert.ok(Math.abs(d(jun27, '2028-06-30')) < 1, '30 June: 2028 settle unchanged');
  // 1 July: the whole charge is FY 2027–28's, on the 2028 settle.
  assert.ok(Math.abs(d(jul27, '2027-06-30')) < 1, '1 July: 2027 settle unchanged');
  assert.ok(Math.abs(d(jul27, '2028-06-30') - t27) < 1, `1 July: 2028 settle Δ ${d(jul27, '2028-06-30')} vs FY tax ${t27}`);

  // The pair total over the swing years is the base pair plus the two FY assessments.
  const pair = run => run['2027-06-30'].tax + run['2028-06-30'].tax;
  assert.ok(Math.abs(pair(jun27) - (pair(base) + t26)) < 1, 'June pair = base + FY 2026–27 assessment');
  assert.ok(Math.abs(pair(jul27) - (pair(base) + t27)) < 1, 'July pair = base + FY 2027–28 assessment');

  // No other settle moves.
  for (const k of Object.keys(base)) {
    if (k === '2027-06-30' || k === '2028-06-30') continue;
    assert.ok(Math.abs(jun27[k].tax - base[k].tax) < 0.01 && Math.abs(jul27[k].tax - base[k].tax) < 0.01,
      `settle ${k} should not move`);
  }
});

test('FY-ATTR-4: each 30 June settle\'s taxYear is the FY starting the previous 1 July', () => {
  const s = runSettles(null);
  const keys = Object.keys(s);
  assert.ok(keys.length >= 3, `expected several settles, got ${keys}`);
  for (const k of keys) {
    assert.ok(k.endsWith('-06-30'), `AU settle should be on 30 June, got ${k}`);
    assert.strictEqual(s[k].taxYear, Number(k.slice(0, 4)) - 1, `settle ${k}`);
  }
});
