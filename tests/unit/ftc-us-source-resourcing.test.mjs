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
 * ftc-us-source-resourcing.test.mjs — design 83 G3/G4.
 *
 * **This file replaces `ftc-us-source-not-creditable.test.mjs`, whose premise design
 * 83 G3 reversed.** That file asserted that AU tax on US-source income must never be
 * staged as creditable US foreign tax, on the reasoning that §904 exists to stop
 * exactly that. The reasoning was right about §904 and wrong about the treaty: for a
 * US citizen resident in Australia, Art. 27(1)(c) re-sources that income to foreign
 * *"to the extent necessary"* to give effect to Art. 22(4), so it stops being
 * US-source for limitation purposes and the AU tax on it becomes creditable in its
 * ordinary basket.
 *
 * What design 71 §14 actually caught was a real over-relief leak, and the leak is
 * still closed — but by a different mechanism. Previously the AU tax was excluded
 * from the creditable base outright, then re-admitted (design 72) through a third
 * "re-sourced by treaty" §904 basket. Both moves are now gone:
 *
 *   - the third basket should never have existed for this taxpayer —
 *     Reg. §1.904-4(k)(1)(iv)(A) disapplies ¶(k)(1) for relief *"solely applicable to
 *     U.S. citizens who are residents of the other Contracting State"*, which is
 *     Art. 22(4)'s opening clause;
 *   - so the whole AU liability is creditable, apportioned across two baskets that
 *     now include the re-sourced income as their own limitation room.
 *
 * The guard against over-relief is therefore no longer "the pool must stay small".
 * It is the §904 limitation itself, plus the invariants `_assertFtcInvariants`
 * enforces at every settle: two baskets partitioning one taxpayer's income cannot
 * claim more than 100% of it, and the credit cannot exceed the tax it offsets.
 *
 * Run with: node --test tests/unit/ftc-us-source-resourcing.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  AuTaxSettleApplyReducer,
  UsTaxSettleApplyReducer,
} from '../../src/finance/tax/tax-settle-classes.js';
import { UsTaxRates2025 }          from '../../src/finance/tax/us/us-tax-rates-2025.js';
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

const usPeriod2025 = { US: { startMs: Date.UTC(2025, 0, 1) } };
const rate1 = { USD_AUD: 1 };

// ─── Funding: the whole AU liability is creditable ───────────────────────────

test('RS-1: AU tax on US-source income IS creditable — nothing is withheld', () => {
  // The fact pattern the old FTC-US-1 was built on: a big US-source capital gain,
  // AU assesses 100k of tax on it, FITO relieves only 10k (all the US tax there was
  // to relieve), 5k of genuine AU-source tax alongside. The old rule staged 15,000;
  // the treaty stages the lot, because Art. 27(1)(c) has re-sourced the gain and the
  // §904 limitation — not an up-front exclusion — is what bounds the credit.
  const action = {
    tax: 105_000,
    personTaxDetails: [person(105_000, /* fitoLimit */ 100_000, /* fito */ 10_000)],
  };
  const patch = stage(baseState(), action);
  assert.equal(patch.ftcCurrentPassive, 105_000);
  assert.equal(patch.ftcCurrentGeneral, 0);
});

test('RS-2: the third "re-sourced by treaty" basket is not produced at all', () => {
  const patch = stage(baseState(), {
    tax: 105_000,
    personTaxDetails: [person(105_000, 100_000, 10_000)],
  });
  assert.equal(patch.ftcCurrentResourced, undefined,
    'Reg. §1.904-4(k)(1)(iv)(A) disapplies the separate category for Art. 22(4) relief');
  assert.deepEqual(Object.keys(patch).sort(), ['ftcCurrentGeneral', 'ftcCurrentPassive']);
});

test('RS-3: the base splits across the two baskets by basket income share', () => {
  const patch = stage(
    baseState({ foreignGeneralIncomeYTD: 3_000, foreignPassiveIncomeYTD: 1_000 }),
    { tax: 105_000, personTaxDetails: [person(105_000, 100_000, 10_000)] });
  assert.equal(patch.ftcCurrentGeneral, 105_000 * 0.75);
  assert.equal(patch.ftcCurrentPassive, 105_000 * 0.25);
});

test('RS-4: with no basket income the tax banks in general, the residual category', () => {
  const patch = stage(
    baseState({ foreignGeneralIncomeYTD: 0, foreignPassiveIncomeYTD: 0 }),
    { tax: 4_000, personTaxDetails: [person(4_000, 0, 0)] });
  assert.equal(patch.ftcCurrentGeneral, 4_000);
  assert.equal(patch.ftcCurrentPassive, 0);
});

test('RS-5: a negative or absent liability stages nothing', () => {
  assert.equal(stage(baseState(), { tax: -100 }).ftcCurrentPassive, 0);
  assert.equal(stage(baseState(), {}).ftcCurrentPassive, 0);
});

// ─── G4: the deleted pool heals rather than vanishing ────────────────────────

test('RS-6: a saved state carrying the deleted re-sourced pool folds into general', () => {
  // Option A is "re-derive" — a simulator has no filed return to preserve. The fold
  // exists only so a state SAVED before G3 does not silently lose real balances.
  const r = new UsTaxRates2025().computeTax({
    usFilingSingle: false,
    effectiveExchangeRates: rate1,
    currentPeriods: usPeriod2025,
    usOrdinaryIncomeYTD: 100_000,
    foreignGeneralIncomeYTD: 100_000,
    ftcCurrentGeneral:   1_000,
    ftcPoolGeneral:      { 2020: 500 },
    // Pre-G3 leftovers.
    ftcCurrentResourced: 4_000,
    ftcPoolResourced:    { 2020: 2_000, 2022: 300 },
  });
  assert.equal(r.ftc.general.currentTax, 5_000, '1,000 + the stranded 4,000');
  assert.equal(r.ftc.general.poolTotal,  2_800, '500 + 2,000 + 300, merged by vintage');
  assert.equal(r.ftc.resourced, undefined, 'no third basket on the result either');
});

test('RS-7: the fold is idempotent — the settle clears the pool it folded', () => {
  const patches = new UsTaxSettleApplyReducer()._extraStatePatches(
    {}, { taxDetail: { ftc: { nextPoolGeneral: { 2025: 7 }, nextPoolPassive: {} } } });
  // Without this the same vintages would be folded in again at every later settle,
  // compounding a one-off migration into a growing phantom pool.
  assert.deepEqual(patches.ftcPoolResourced, {});
});

// ─── End to end: what actually bounds the credit now ─────────────────────────

test('RS-8: across the reference run the credit never exceeds the tax it offsets', () => {
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

  let settles = 0, peakFracSum = 0;
  for (const e of scenario.sim.journal.journal) {
    if (e.action?.type !== 'US_TAX_SETTLE_APPLY') continue;
    const d = e.action.data.taxDetail;
    const ftc = d?.ftc;
    if (!ftc) continue;
    settles++;

    // The replacement for the old "pool stays under 25k" bound. That bound was a
    // proxy for over-relief; these are the property itself.
    assert.ok(d.credits <= ftc.limitationBase + 0.01,
      `credit ${d.credits.toFixed(2)} exceeds the §904 limitation base ${ftc.limitationBase.toFixed(2)}`);
    const fracSum = ftc.general.frac + ftc.passive.frac;
    peakFracSum = Math.max(peakFracSum, fracSum);
    assert.ok(fracSum <= 1.0001,
      `§904 fractions sum to ${fracSum.toFixed(5)} — two baskets cannot claim more than the whole return`);
    assert.equal(ftc.resourced, undefined, 'the third basket is gone for good');

    // A pool can only ever hold foreign tax that was actually paid, so what it banks
    // this year cannot exceed what was available to bank.
    for (const b of [ftc.general, ftc.passive]) {
      assert.ok(b.carryforwardRemaining <= b.avail + 0.01,
        'carryforward cannot exceed the foreign tax available to bank');
    }
  }
  assert.ok(settles > 10, `expected a full run of settles, saw ${settles}`);
  assert.ok(peakFracSum > 0.5,
    `fractions peaked at ${peakFracSum.toFixed(5)} — the run has no cross-border activity, so it proves nothing`);
});
