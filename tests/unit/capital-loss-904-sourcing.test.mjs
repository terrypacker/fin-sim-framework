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
 * capital-loss-904-sourcing.test.mjs — the U.S. capital loss adjustment (design 90 §4.5).
 *
 * **Why this file exists and the golden fixtures do not cover it.** A capital loss reduces
 * total gross income through §1211/§1212 netting; the §904 basket accumulators are summed
 * during the year and cannot see that. Before design 90 §4.5 the baskets kept the gross
 * gain while `grossIncomeAllSources` kept the net one, and `_assertFtcInvariants` failed by
 * exactly the absorbed loss.
 *
 * It went unnoticed through three steps because **the deterministic reference plan never
 * forms a capital-loss pool** (design 90 §4: both pools end empty; §1.1: losses are 0.006%
 * of gross gains). An invariant that cannot fire is not a check, so every case here
 * constructs the loss deliberately — this is design 90 §10's working-detector control
 * applied to an assertion rather than to a behaviour.
 *
 * Authority, transcribed on disk:
 *   `docs/us-tax/IRS-Pub-514-Foreign-Tax-Credit-2025.txt` p.28, *Adjustments to Foreign
 *   Source Capital Gains and Losses* — the U.S. capital loss adjustment and its pro-rata
 *   apportionment "based on the amount of net capital gain in each separate category".
 *
 * Run with: node --test tests/unit/capital-loss-904-sourcing.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { _computeCapitalLossBasketAdjustment, _computeCapitalLossLimitation }
  from '../../src/finance/tax/us/us-tax-rates-base.js';
import { basketCapGainPatch } from '../../src/finance/tax/capital-gain-character.js';
import { withoutUsSourceIncome } from '../../src/finance/tax/tax-settle-classes.js';

/** The four post-netting gain figures, as `_computeCapitalLossLimitation` reports them. */
const worldwide = (o = {}) => ({
  shortTermGain: 0, longTermGain: 0, collectibleGain: 0, unrecaptured1250Gain: 0, ...o,
});

// ─── Pub 514's own worked example ────────────────────────────────────────────
//
// Every number here is from the publication, which is why it is the fixture: it is the
// only two-category case available, and the live model books all capital gain to passive
// (see the "structurally passive" test at the bottom) so nothing else exercises the
// apportionment at all.
//
//   foreign passive gain \$300 · foreign general gain \$1,000 · foreign general loss \$400
//   · US-source capital loss \$150
//   foreign source capital gain = (1,000 + 300) - 400 = 900
//   worldwide capital gain      = (1,000 + 300) - (400 + 150) = 750
//   U.S. capital loss adjustment = 900 - 750 = 150
//   apportioned: passive 150 x 300/900 = 50 ; general 150 x 600/900 = 100

describe('Pub 514 p.28 — the worked example', () => {
  const state = {
    foreignGeneralCapGainsYTD: 1_000 - 400,   // signed: the category nets its own loss first
    foreignPassiveCapGainsYTD: 300,
  };
  const capLoss = worldwide({ longTermGain: 750 });

  test('the adjustment is foreign source capital gain less worldwide capital gain', () => {
    const r = _computeCapitalLossBasketAdjustment(state, capLoss);
    assert.equal(r.foreignSourceCapGain, 900);
    assert.equal(r.worldwideCapGain, 750);
    assert.equal(r.adjustment, 150);
  });

  test('it apportions pro rata by NET CAPITAL GAIN per category, not by total income', () => {
    const r = _computeCapitalLossBasketAdjustment(state, capLoss);
    assert.equal(r.passive, 50,  'Alfie: 150 x 300/900');
    assert.equal(r.general, 100, 'Alfie: 150 x 600/900');
    assert.equal(r.general + r.passive, r.adjustment, 'the whole adjustment is placed');
  });

  test('the resulting line 1a figures are the publication\'s', () => {
    const r = _computeCapitalLossBasketAdjustment(state, capLoss);
    assert.equal(state.foreignPassiveCapGainsYTD - r.passive, 250);
    assert.equal(state.foreignGeneralCapGainsYTD - r.general, 500);
  });
});

// ─── the partition, which is the property the whole design turns on ──────────

describe('the §904 partition', () => {
  test('a CARRYFORWARD drawdown reaches the baskets — the defect that fired in practice', () => {
    // The measured failure: a prior-year pool nets this year's gain down inside
    // `_computeCapitalLossLimitation`, long after the basket was accumulated. The
    // shortfall equalled the opening pool to the cent.
    const state = {
      usCapitalGainsYTD: 50_000,
      usLongTermCapitalLossCarryforward: 6_500,
      foreignPassiveCapGainsYTD: 50_000,
    };
    const capLoss = _computeCapitalLossLimitation(state);
    assert.equal(capLoss.longTermGain, 43_500, 'the pool is absorbed into the year');

    const r = _computeCapitalLossBasketAdjustment(state, capLoss);
    assert.equal(r.adjustment, 6_500, 'and the basket has to give up exactly that much');
    assert.equal(r.passive, 6_500);
    assert.equal(50_000 - r.passive, capLoss.longTermGain,
      'basket capital gain now equals the capital gain in gross income — the partition');
  });

  test('a SAME-YEAR loss needs no adjustment, because the signed accumulator already took it', () => {
    // Defect 1's fix works at the classifier, not here: the basket was booked signed, so
    // the netting and the accumulator moved together and there is nothing left to place.
    const state = {
      usCapitalGainsYTD: 40_000 - 15_000,
      foreignPassiveCapGainsYTD: 40_000 - 15_000,
    };
    const capLoss = _computeCapitalLossLimitation(state);
    const r = _computeCapitalLossBasketAdjustment(state, capLoss);
    assert.equal(r.adjustment, 0);
    assert.equal(state.foreignPassiveCapGainsYTD, capLoss.longTermGain);
  });

  test('a net loss year drives the basket capital component to zero, not negative', () => {
    const state = {
      usCapitalGainsYTD: -20_000,
      foreignPassiveCapGainsYTD: -20_000,
    };
    const capLoss = _computeCapitalLossLimitation(state);
    const r = _computeCapitalLossBasketAdjustment(state, capLoss);
    assert.equal(r.foreignSourceCapGain, 0, 'a category with no net capital gain has none');
    assert.equal(r.adjustment, 0, 'and nothing to apportion — Pub 514 is explicit');
    assert.equal(r.passive, 0);
  });

  test('gains alone leave every basket untouched', () => {
    const state = { usCapitalGainsYTD: 80_000, foreignPassiveCapGainsYTD: 80_000 };
    const capLoss = _computeCapitalLossLimitation(state);
    const r = _computeCapitalLossBasketAdjustment(state, capLoss);
    assert.equal(r.adjustment, 0);
    assert.equal(r.general, 0);
    assert.equal(r.passive, 0);
  });

  test('the four gain buckets all count as worldwide capital gain', () => {
    // Flooring on `longTermGain` alone would over-adjust a year whose gain is collectible
    // or §1250 — both are capital gain in gross income and both belong in the comparison.
    const capLoss = worldwide({ collectibleGain: 10_000, unrecaptured1250Gain: 5_000, shortTermGain: 2_000 });
    const r = _computeCapitalLossBasketAdjustment({ foreignPassiveCapGainsYTD: 17_000 }, capLoss);
    assert.equal(r.worldwideCapGain, 17_000);
    assert.equal(r.adjustment, 0);
  });
});

// ─── the FITO counterfactual ─────────────────────────────────────────────────

describe('withoutUsSourceIncome', () => {
  test('removes the capital slice with the bucket it slices', () => {
    // Design 83 G8's rule: everything the US-source income created goes with it. Leaving
    // the slice behind would compute the adjustment against foreign-source capital gain
    // the counterfactual return no longer contains.
    const state = {
      usSourcePassiveUsdYTD: 30_000, usSourcePassiveCapGainsUsdYTD: 30_000,
      usSourceGeneralCapGainsUsdYTD: 0, usSourceCapGainsUsdYTD: 30_000,
      usCapitalGainsYTD: 30_000, usOrdinaryIncomeYTD: 0, usSourceOrdinaryUsdYTD: 0,
    };
    const w = withoutUsSourceIncome(state);
    assert.equal(w.usSourcePassiveCapGainsUsdYTD, 0);
    assert.equal(w.usSourceGeneralCapGainsUsdYTD, 0);
    assert.equal(_computeCapitalLossBasketAdjustment(w, worldwide()).foreignSourceCapGain, 0,
      'no US-source gain left to adjust');
  });

  test('the treaty-capped pass keeps ordinary income but never capital gain', () => {
    // `keepTreatyCapped` retains dividends and interest, which are ordinary. A capital
    // slice surviving that pass would be income with no bucket to sit in.
    const state = {
      usSourceDividendsUsdYTD: 5_000, usSourceInterestUsdYTD: 1_000,
      usSourcePassiveUsdYTD: 36_000, usSourcePassiveCapGainsUsdYTD: 30_000,
      usSourceCapGainsUsdYTD: 30_000, usCapitalGainsYTD: 30_000,
      usOrdinaryIncomeYTD: 6_000, usSourceOrdinaryUsdYTD: 6_000,
    };
    const w = withoutUsSourceIncome(state, { keepTreatyCapped: true });
    assert.equal(w.usSourcePassiveUsdYTD, 6_000, 'the capped ordinary slice survives');
    assert.equal(w.usSourcePassiveCapGainsUsdYTD, 0, 'the capital slice does not');
  });
});

// ─── the accumulator idiom ───────────────────────────────────────────────────

describe('basketCapGainPatch', () => {
  test('does not create the key at zero', () => {
    // The usUnrecaptured1250GainYTD precedent. Creating it at 0 puts a state diff on every
    // gainless disposal — which is exactly what EVT-33 asserts must not happen, and what
    // the first cut of this design broke.
    assert.deepEqual(basketCapGainPatch({}, 'foreignPassiveCapGainsYTD', 0), {});
  });

  test('accumulates signed, from an absent or present key', () => {
    assert.deepEqual(basketCapGainPatch({}, 'k', 100), { k: 100 });
    assert.deepEqual(basketCapGainPatch({ k: 100 }, 'k', -30), { k: 70 });
    assert.deepEqual(basketCapGainPatch({ k: 10 }, 'k', -25), { k: -15 },
      'a loss must be able to take a basket negative; the floor belongs downstream');
  });
});

// ─── the invariant itself, end to end through computeTax ─────────────────────
//
// The helper tests above pin the arithmetic. This is the one that pins the BUG: it runs
// the real `computeTax`, which calls `_assertFtcInvariants`, on the shape the failure
// actually took. Mutation-verified — stubbing `capBasket` back to zeros makes both of
// these throw, which is the only evidence that they are testing anything.
//
// The shape, from the measured failure (design 90 §4.5; figures in the private runbook,
// proportions preserved): an AU-resident US citizen whose income is mostly foreign-source
// capital gain, carrying a §1212(b) pool from an earlier year into a year of gains.

describe('the §904 partition invariant, through computeTax', () => {
  const auResidentWithForeignGains = (o = {}) => ({
    people: { primary: { residency: 'AU' } },
    currentPeriods: { US: { startMs: Date.UTC(2032, 0, 1) } },
    usOrdinaryIncomeYTD: 41_800,
    usNegativeIncomeYTD: 0,
    usCapitalGainsYTD:   52_600,
    usCollectibleGainsYTD: 0,
    usPenaltyYTD: 0,
    // §865(a) sources personal-property gain by the seller's residence, so for this
    // taxpayer the whole gain is foreign passive (design 83 G10).
    foreignPassiveIncomeYTD:   52_600 + 38_800,
    foreignPassiveCapGainsYTD: 52_600,
    foreignGeneralIncomeYTD:   3_000,
    ftcCurrentPassive: 4_000,
    ...o,
  });

  test('a carryforward year computes without violating the partition', async () => {
    const { UsTaxRates2026 } = await import('../../src/finance/tax/us/us-tax-rates-2026.js');
    const state = auResidentWithForeignGains({ usLongTermCapitalLossCarryforward: 6_550 });
    assert.doesNotThrow(() => new UsTaxRates2026().computeTax(state));
  });

  test('and the baskets no longer claim limitation room the return does not contain', async () => {
    const { UsTaxRates2026 } = await import('../../src/finance/tax/us/us-tax-rates-2026.js');
    const state = auResidentWithForeignGains({ usLongTermCapitalLossCarryforward: 6_550 });
    const { ftc } = new UsTaxRates2026().computeTax(state);

    const basketGross = ftc.general.gross + ftc.passive.gross;
    assert.ok(basketGross <= ftc.grossIncomeAllSources + 0.01,
      `Σ basket gross ${basketGross.toFixed(2)} must not exceed gross income `
      + `${ftc.grossIncomeAllSources.toFixed(2)} — this is the partition`);
    assert.ok(ftc.general.frac + ftc.passive.frac <= 1.01, 'the §904 fractions partition one taxpayer');
  });

  test('a big net loss year is fine too — the direction the floor could get wrong', async () => {
    const { UsTaxRates2026 } = await import('../../src/finance/tax/us/us-tax-rates-2026.js');
    const state = auResidentWithForeignGains({
      usCapitalGainsYTD: -30_000,
      foreignPassiveIncomeYTD: 38_800 - 30_000,
      foreignPassiveCapGainsYTD: -30_000,
    });
    assert.doesNotThrow(() => new UsTaxRates2026().computeTax(state));
  });
});

// ─── the stochastic smoke sweep ──────────────────────────────────────────────

describe('stochastic seed sweep — the §904 invariant on paths that form pools', () => {
  // **Read what this does and does not do.** It is a SMOKE test, not the acceptance test
  // for design 90 §4.5. Measured: with the fix stubbed out it still passes, because the
  // partition only breaks when the foreign baskets are a large share of gross income and
  // the default plan's are not. The mutation-verified regression pin is the computeTax
  // block above; this is standing cover for the OTHER ways the partition has broken —
  // three so far, and design 83 §12.1 expects more.
  //
  // What earns it its place is the first assertion. Design 90 §10's original instruction
  // ("re-run the §904 invariants after step 3") was followed, passed, and proved nothing,
  // because on the deterministic path no capital-loss pool ever forms. So this sweep
  // asserts that pools DO form before asserting that nothing throws. A future change that
  // stops the sweep reaching losses fails loudly here instead of going quietly vacuous.
  //
  // Vol 0.30 and the raised expense line are both load-bearing: the default plan realizes
  // almost no disposals at all (3 in 24 years), so without forced drawdown there is
  // nothing to realize a loss on.
  const SEEDS = [1, 2, 3, 4, 5];

  test('pools form on every seed, and no seed violates the partition', async (t) => {
    const { ServiceRegistry } = await import('../../src/services/service-registry.js');
    const { BaseScenario }    = await import('../../src/scenarios/base-scenario.js');
    const { ScenarioLoader }  = await import('../../src/scenarios/scenario-loader.js');
    const { IntlRetirementScenario } = await import('../../src/scenarios/intl-retirement-scenario.js');

    const simStart = new Date(Date.UTC(2026, 0, 1));
    const simEnd   = new Date(Date.UTC(2050, 0, 1));
    const pooled = [];

    for (const randomSeed of SEEDS) {
      ServiceRegistry.resetAll();
      const services = ServiceRegistry.getInstance();
      const cfg = IntlRetirementScenario.buildDefaultConfig(
        { equityReturnStochastic: true, equityReturnVol: 0.30, monthlyExpenses: 25_000, randomSeed },
        simStart, simEnd);
      const scenario = new BaseScenario({
        context: services.simulationContext, initialState: cfg.initialState ?? {}, simStart, simEnd });
      scenario.buildSim({ telemetry: 'off' });
      new ScenarioLoader().load(cfg, services);

      let maxPool = 0;
      const { log, warn } = console;
      console.log = () => {}; console.warn = () => {};
      try {
        for (let y = simStart.getUTCFullYear(); y < simEnd.getUTCFullYear(); y++) {
          scenario.sim.stepTo(new Date(Date.UTC(y + 1, 0, 1)));
          maxPool = Math.max(maxPool,
            (scenario.sim.state.usLongTermCapitalLossCarryforward  ?? 0)
          + (scenario.sim.state.usShortTermCapitalLossCarryforward ?? 0));
        }
      } finally { console.log = log; console.warn = warn; }
      // A throw would have propagated: `_assertFtcInvariants` throws in dev/test.
      pooled.push(maxPool);
    }

    assert.equal(pooled.filter(p => p > 0).length, SEEDS.length,
      `every seed must actually FORM a capital-loss pool, or this sweep is testing nothing. `
      + `Got: ${pooled.map(Math.round).join(', ')}`);
  });
});
