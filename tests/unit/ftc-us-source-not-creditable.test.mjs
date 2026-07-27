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
 * ftc-us-source-not-creditable.test.mjs — design 71 §14.
 *
 * AU tax paid on **US-source** income must not be staged as creditable US foreign
 * tax. §904 exists to stop exactly that, and the US is the source country here — AU
 * relieves the double tax from its side, through FITO.
 *
 * The leak this guards: `AuTaxSettleApplyReducer` used to stage the whole post-FITO
 * AU liability (less super tax) as current-year foreign tax, on the assumption that
 * FITO had already removed the US-source part. That holds only while FITO fully
 * relieves — i.e. while the US tax on the US-source income is at least the AU tax on
 * it. On a large capital gain (AU ~45% against US 15–20% LTCG) most of the AU tax
 * survives FITO. The §904 limitation then refused to credit it *that year*, but it
 * banked as a 10-year carryforward vintage and was drawn down in later years against
 * genuinely foreign income — over-relief deferred, not prevented.
 *
 * `fitoLimit` is the AU tax attributable to US-source income (the ATO
 * "step 1 − step 2" marginal calculation), so `fitoLimit − fito` is the unrelieved
 * part that must be excluded.
 *
 * Run with: node --test tests/unit/ftc-us-source-not-creditable.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AuTaxSettleApplyReducer } from '../../src/finance/tax/tax-settle-classes.js';
import { ServiceRegistry }         from '../../src/services/service-registry.js';
import { IntlRetirementScenario }  from '../../src/scenarios/intl-retirement-scenario.js';

/** State with a 1:1 FX rate so AUD→USD conversion does not obscure the arithmetic. */
function baseState(overrides = {}) {
  return {
    auSuperTaxYTD: 0,
    foreignGeneralIncomeYTD: 0,
    foreignPassiveIncomeYTD: 1_000,   // all AU-source income is passive here
    exchangeRates: { AUD: { USD: 1 } },
    effectiveExchangeRates: { AUD_USD: 1, USD_AUD: 1 },
    ...overrides,
  };
}

const person = (netLiability, fitoLimit, fito) =>
  ({ personKey: 'p', taxDetail: { netLiability, fitoLimit, fito, inputs: {} } });

/** Run the reducer's funding patch for a settle action. */
function stage(state, action) {
  return new AuTaxSettleApplyReducer()._extraStatePatches(state, action);
}

// ─── The leak ────────────────────────────────────────────────────────────────

test('FTC-US-1: AU tax on US-source income is excluded from the creditable base', () => {
  // A big US-source capital gain: AU assesses 100k of tax on it, FITO relieves only
  // 10k (that is all the US tax there was to relieve), and 5k of genuine AU-source
  // tax sits alongside. Only the 5k may be staged as creditable foreign tax.
  const action = {
    tax: 105_000,
    personTaxDetails: [person(105_000, /* fitoLimit */ 100_000, /* fito */ 10_000)],
  };
  const patch = stage(baseState(), action);

  // 105,000 − 0 super − (100,000 − 10,000) = 15,000.
  // Note this is not 5,000: FITO already reduced the liability by the 10,000 it
  // relieved, so that 10,000 is not in `tax` and must not be subtracted twice.
  assert.equal(patch.ftcCurrentPassive, 15_000);
  assert.equal(patch.ftcCurrentGeneral, 0);
});

test('FTC-US-2: a fully-relieved year is unaffected', () => {
  // FITO covered the whole US-source liability, so nothing extra is removed and the
  // pre-fix behavior stands: this is the case the old assumption was written for.
  const action = {
    tax: 5_000,
    personTaxDetails: [person(5_000, /* fitoLimit */ 8_000, /* fito */ 8_000)],
  };
  assert.equal(stage(baseState(), action).ftcCurrentPassive, 5_000);
});

test('FTC-US-3: a purely domestic AU year is untouched', () => {
  const action = { tax: 5_000, personTaxDetails: [person(5_000, 0, 0)] };
  assert.equal(stage(baseState(), action).ftcCurrentPassive, 5_000);
});

test('FTC-US-4: super tax and US-source tax are both removed, and never below zero', () => {
  const action = {
    tax: 20_000,
    personTaxDetails: [person(20_000, /* fitoLimit */ 30_000, /* fito */ 0)],
  };
  // 20,000 − 3,000 super − 30,000 US-source ⇒ clamped at 0, not negative.
  const patch = stage(baseState({ auSuperTaxYTD: 3_000 }), action);
  assert.equal(patch.ftcCurrentPassive, 0);
  assert.equal(patch.ftcCurrentGeneral, 0);
});

test('FTC-US-5: the exclusion sums across per-person returns', () => {
  const action = {
    tax: 100_000,
    personTaxDetails: [
      person(60_000, 50_000, 5_000),   // 45,000 unrelieved
      person(40_000, 30_000, 5_000),   // 25,000 unrelieved
    ],
  };
  assert.equal(stage(baseState(), action).ftcCurrentPassive, 100_000 - 70_000);
});

test('FTC-US-6: the household (non per-person) settle path is covered too', () => {
  const action = { tax: 105_000, taxDetail: { fitoLimit: 100_000, fito: 10_000 } };
  assert.equal(stage(baseState(), action).ftcCurrentPassive, 15_000);
});

test('FTC-US-7: the de-minimis shortcut contributes nothing (limit not computed)', () => {
  // Under A$1,000 the ATO limit is deliberately skipped, so `fitoLimit` is null and
  // there is no measured US-source figure to remove. Amounts are trivially small.
  const action = {
    tax: 5_000,
    personTaxDetails: [{ personKey: 'p', taxDetail: { fitoLimit: null, fito: 800 } }],
  };
  assert.equal(stage(baseState(), action).ftcCurrentPassive, 5_000);
});

test('FTC-US-8: the creditable base still splits across §904 baskets by income share', () => {
  const action = {
    tax: 105_000,
    personTaxDetails: [person(105_000, 100_000, 10_000)],
  };
  const patch = stage(
    baseState({ foreignGeneralIncomeYTD: 3_000, foreignPassiveIncomeYTD: 1_000 }), action);
  assert.equal(patch.ftcCurrentGeneral, 15_000 * 0.75);
  assert.equal(patch.ftcCurrentPassive, 15_000 * 0.25);
});

// ─── End to end ──────────────────────────────────────────────────────────────

test('FTC-US-9: the carryforward pool stays bounded across the reference run', () => {
  ServiceRegistry.resetAll();
  // simEnd must be passed explicitly: the scenario's own default horizon is
  // 2041-01-01, and stepping past a sim's simEnd leaves recurring events unscheduled
  // (period advance stops while settles keep firing), so any assertion made out there
  // is about degenerate state rather than about the model.
  const scenario = IntlRetirementScenario.buildAndCompile({
    simEnd: new Date(Date.UTC(2050, 0, 1)),
  });
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { scenario.sim.stepTo(new Date(Date.UTC(2050, 0, 1))); }
  finally { console.log = log; console.warn = warn; }

  let peakPool = 0, peakCurrent = 0;
  for (const e of scenario.sim.journal.journal) {
    if (e.action?.type !== 'US_TAX_SETTLE_APPLY') continue;
    const p = e.action.data.taxDetail?.ftc?.passive;
    if (!p) continue;
    peakPool    = Math.max(peakPool,    p.carryforwardRemaining);
    peakCurrent = Math.max(peakCurrent, p.currentTax);
  }

  // Before the fix the 2033 company-sale year alone staged ~394k of "foreign tax"
  // and the pool peaked near ~536k, funding credits for another decade. The
  // household's genuine AU-source tax is three orders of magnitude smaller.
  assert.ok(peakCurrent < 10_000,
    `current-year foreign tax peaked at ${peakCurrent.toFixed(0)} — AU tax on US-source `
    + 'income is leaking into the creditable base again');
  assert.ok(peakPool < 25_000,
    `§904 carryforward pool peaked at ${peakPool.toFixed(0)} — a phantom pool of `
    + 'non-creditable tax is accumulating for later over-relief');
});
