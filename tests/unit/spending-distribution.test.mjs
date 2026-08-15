/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * spending-distribution.test.mjs — design 89 §11.1 phase 6.
 *
 * Spending as a distribution rather than a path. Most of this file is about the ways an
 * aggregate can be quietly wrong rather than loudly absent: a percentile taken over paths
 * that produced nothing, a category averaged only across the paths that fired it, a
 * "0% of paths" that actually means "no paths were measured".
 *
 *   SUM-1..5    `summarizeSpendingForRun` — the compact record, both units, the shortfall,
 *               and the unclassified types it carries so the band has an address.
 *   PCT-1..3    `percentiles` — interpolation, null handling, empty samples.
 *   AGG-1..6    `aggregateSpendingRuns` — skipped paths, absent-vs-zero categories,
 *               `firedRate`, and the unclassified roll-up.
 *   EXC-1..2    `exceedanceRate` — and why it returns null rather than 0.
 *   CLS-E1..2   the earnings family the phase-6 sweep found, pinned so it stays classified.
 *
 * Run with: node --test tests/unit/spending-distribution.test.mjs
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { BaseScenario }    from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { buildSpendingCube } from '../../src/finance/spending-reporting/spending-cube.js';
import { summarizeSpendingForRun, aggregateSpendingRuns, percentiles,
         exceedanceRate, describeSpendingDistribution, TAX_CATEGORIES }
  from '../../src/finance/spending-reporting/spending-distribution.js';
import { classifyDebit, REPORT_CATEGORY, SPEND_TIER }
  from '../../src/finance/spending-reporting/spending-classification.js';

const USD = { code: 'USD', symbol: '$' };

function planConfig() {
  return {
    toolsets: ['US_RETIREMENT', 'US_TAX'],
    simStart: '2026-01-01', simEnd: '2032-01-01',
    parameters: { monthlyExpenses: 9_000 },
    persons: [{
      __type: 'Person', id: 'primary', name: 'P', birthDate: '1960-04-15',
      // A WAGE, and a retirement date partway through the run. Measured: without taxable
      // income this fixture produces only LIVING and INTERNAL — no tax at all — and every
      // taxShare assertion below is 0/x, trivially satisfied and testing nothing. Caught
      // by SUM-2's own non-vacuity guard, which is the third time in this design.
      lifeExpectancy: 95, citizen: ['US'], residency: 'US', monthlyWage: 9_000,
      retirementDate: '2029-06-01', socialSecurityMonthly: 0,
    }],
    accounts: [
      { __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings', type: 'savings',
        role: 'us-savings', stateKey: 'usSavingsAccount', initialValue: 300_000,
        ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0, country: 'US', currency: USD },
      { __type: 'BrokerageAccount', id: 'us-stock', name: 'US Brokerage', type: 'brokerage',
        role: 'us-taxable', stateKey: 'usStockAccount', initialValue: 900_000,
        ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0,
        drawdownPriority: 1, country: 'US', currency: USD },
    ],
    realProperties: [],
  };
}

let _cube = null;
function cube() {
  if (!_cube) {
    const config = planConfig();
    ServiceRegistry.resetAll();
    const services = ServiceRegistry.getInstance();
    const scenario = new BaseScenario({
      context:  services.simulationContext,
      simStart: new Date(config.simStart),
      simEnd:   new Date(config.simEnd),
    });
    scenario.buildSim();
    new ScenarioLoader().load(structuredClone(config), services);
    scenario.sim.stepTo(new Date('2031-12-31'));
    _cube = buildSpendingCube({
      journal: scenario.sim.journal, state: scenario.sim.state, services,
    });
  }
  return _cube;
}

/** A per-run record with only the fields the aggregation reads. */
const rec = (over = {}) => ({
  years: 10,
  spendingReal: 100, spendingNominal: 130, notSpendingReal: 50,
  totalReal: 150, totalNominal: 200,
  overstatement: 0.5, inflationFactor: 1.3,
  taxReal: 30, taxNominal: 40, taxShare: 0.3,
  shortfallReal: 0, wentShort: false,
  byCategoryReal: { LIVING: 70, TAX_AU: 30, INTERNAL: 50 },
  byCategoryNominal: { LIVING: 90, TAX_AU: 40, INTERNAL: 70 },
  unclassifiedReal: 0, unclassifiedTypes: [],
  ...over,
});

// ─── the per-run summary ──────────────────────────────────────────────────────

describe('summarizeSpendingForRun', () => {

  test('SUM-1 reduces a real cube to a compact record in BOTH units', () => {
    const s = summarizeSpendingForRun(cube());
    assert.ok(s, 'the fixture must produce a cube');
    assert.ok(s.spendingReal > 0 && s.spendingNominal > 0);
    assert.ok(s.spendingNominal >= s.spendingReal, 'nominal is the larger under inflation');
    assert.ok(Math.abs(s.spendingReal + s.notSpendingReal - s.totalReal) < 1e-6,
      'the tiers must partition the real total');

    // Compact by design: n cubes is hundreds of megabytes, which is the whole reason an
    // MC iteration records metrics rather than state.
    const bytes = JSON.stringify(s).length;
    assert.ok(bytes < 4_000, `record is ${bytes} bytes — too large to keep per path`);
  });

  test('SUM-2 taxShare is a ratio of ONE unit, not a mix of two', () => {
    // The defect this design keeps finding: real over nominal looks plausible and is
    // wrong by the deflator. Reconstructed here from the record's own parts.
    const s = summarizeSpendingForRun(cube());
    assert.ok(s.taxReal > 0, 'the fixture must produce tax or this proves nothing');
    assert.ok(Math.abs(s.taxShare - s.taxReal / s.spendingReal) < 1e-12);
    assert.notEqual(s.taxReal, s.taxNominal, 'the fixture must actually inflate');
    // The wrong pairing, spelled out: real-over-nominal is plausible-looking and off by
    // the deflator. It must NOT equal the reported share.
    assert.notEqual(s.taxShare, s.taxReal / s.spendingNominal);
  });

  test('SUM-3 an empty cube yields null, so a failed path is visibly absent', () => {
    // Not a zero record: counting a path that produced nothing as $0 spending would drag
    // every percentile toward a number no path experienced.
    for (const c of [null, undefined, { rows: [] }]) {
      assert.equal(summarizeSpendingForRun(c), null);
    }
  });

  test('SUM-4 the shortfall is carried, so a path that ran dry cannot read as CHEAP', () => {
    const s = summarizeSpendingForRun(cube());
    assert.ok(Number.isFinite(s.shortfallReal));
    assert.equal(s.wentShort, s.shortfallReal > 1);
    assert.equal(s.wentShort, false, 'this fixture is solvent');
  });

  test('SUM-5 unclassified types are NAMED, not just totalled', () => {
    // An alarm with no address is not actionable, and the MC sweep is exactly where a
    // type nobody classified surfaces (§8.0).
    const real = cube();
    assert.deepEqual(summarizeSpendingForRun(real).unclassifiedTypes, [],
      'the fixture should classify cleanly');

    const withUnknown = {
      ...real,
      rows: [...real.rows, {
        year: 2030, category: REPORT_CATEGORY.UNCLASSIFIED, tier: SPEND_TIER.NOT_SPENDING,
        amount: 10, amountReal: 10, actionType: 'QUANTUM_DIVIDEND_APPLY',
        intent: null, intentReal: null,
      }],
      byCategory: new Map([...real.byCategory, [REPORT_CATEGORY.UNCLASSIFIED, 10]]),
    };
    assert.deepEqual(summarizeSpendingForRun(withUnknown).unclassifiedTypes,
      ['QUANTUM_DIVIDEND_APPLY']);
  });
});

// ─── percentiles ──────────────────────────────────────────────────────────────

describe('percentiles', () => {

  test('PCT-1 interpolates between order statistics', () => {
    const p = percentiles([0, 10, 20, 30, 40], [0, 0.5, 1]);
    assert.equal(p.p0,   0);
    assert.equal(p.p50, 20);
    assert.equal(p.p100, 40);
    assert.equal(percentiles([0, 100], [0.1]).p10, 10, 'interpolated, not snapped');
  });

  test('PCT-2 non-finite values are DROPPED, never counted as zero', () => {
    // A path with no spending figure has no spending figure. Treating it as 0 moves every
    // percentile toward a value nothing experienced.
    assert.equal(percentiles([10, null, 20, undefined, NaN, 30], [0.5]).p50, 20);
  });

  test('PCT-3 an empty sample is null, not a zero band', () => {
    for (const v of [[], null, undefined, [null, NaN]]) assert.equal(percentiles(v), null);
  });
});

// ─── the aggregate ────────────────────────────────────────────────────────────

describe('aggregateSpendingRuns', () => {

  test('AGG-1 skipped paths are counted and excluded, not silently dropped', () => {
    const agg = aggregateSpendingRuns([rec(), null, rec({ spendingReal: 200 }), null]);
    assert.equal(agg.n, 2);
    assert.equal(agg.nSkipped, 2);
    assert.equal(agg.spendingReal.p50, 150);
  });

  test('AGG-2 an all-null set reports n:0 rather than a band of zeros', () => {
    const agg = aggregateSpendingRuns([null, null]);
    assert.equal(agg.n, 0);
    assert.equal(agg.nSkipped, 2);
    assert.equal(agg.spendingReal, null);
    assert.equal(agg.wentShortRate, null, 'null, not 0 — nothing was measured');
    assert.match(describeSpendingDistribution(agg), /no paths produced a spending cube/);
  });

  test('AGG-3 a category ABSENT from a path counts as zero there', () => {
    // The opposite convention from a null spending figure, and deliberately so: a repair
    // model that fires in 30% of paths must show p10 = 0, not a p10 taken over only the
    // paths that had repairs — which would report the typical repair bill as the typical
    // path's repair bill.
    const agg = aggregateSpendingRuns([
      rec({ byCategoryReal: { LIVING: 70, HOUSING_REPAIR: 900 } }),
      rec({ byCategoryReal: { LIVING: 70 } }),
      rec({ byCategoryReal: { LIVING: 70 } }),
      rec({ byCategoryReal: { LIVING: 70 } }),
    ]);
    const repair = agg.byCategoryReal[REPORT_CATEGORY.HOUSING_REPAIR];
    assert.equal(repair.p10, 0, 'absent means zero for a category');
    assert.equal(repair.p50, 0);
    assert.equal(repair.firedRate, 0.25);
    assert.equal(agg.byCategoryReal[REPORT_CATEGORY.LIVING].firedRate, 1);
  });

  test('AGG-4 categories carry their tier, and are ordered by median', () => {
    const agg = aggregateSpendingRuns([rec(), rec()]);
    assert.deepEqual(agg.categories, ['LIVING', 'INTERNAL', 'TAX_AU']);
    assert.equal(agg.byCategoryReal.LIVING.tier,   SPEND_TIER.SPENDING);
    assert.equal(agg.byCategoryReal.INTERNAL.tier, SPEND_TIER.NOT_SPENDING);
  });

  test('AGG-5 wentShortRate is a fraction of measured paths', () => {
    const agg = aggregateSpendingRuns([
      rec({ wentShort: true, shortfallReal: 500 }), rec(), rec(), rec(),
    ]);
    assert.equal(agg.wentShortRate, 0.25);
    assert.equal(agg.shortfallReal.p90 > 0, true);
  });

  test('AGG-6 unclassified types roll up with a path count', () => {
    const agg = aggregateSpendingRuns([
      rec({ unclassifiedTypes: ['A_APPLY'] }),
      rec({ unclassifiedTypes: ['A_APPLY', 'B_APPLY'] }),
      rec(),
    ]);
    assert.deepEqual(agg.unclassifiedTypes, [
      { actionType: 'A_APPLY', paths: 2 },
      { actionType: 'B_APPLY', paths: 1 },
    ]);
  });
});

// ─── threshold questions ──────────────────────────────────────────────────────

describe('exceedanceRate', () => {

  test('EXC-1 answers "how often is X above t" as a fraction of paths', () => {
    const runs = [rec({ taxShare: 0.2 }), rec({ taxShare: 0.6 }), rec({ taxShare: 0.7 }), null];
    assert.equal(exceedanceRate(runs, 'taxShare', 0.5), 2 / 3);
    assert.equal(exceedanceRate(runs, 'taxShare', 0.9), 0);
  });

  test('EXC-2 an unmeasured field is null, not "never happens"', () => {
    // 0 and null read identically in a report and mean opposite things.
    assert.equal(exceedanceRate([], 'taxShare', 0.5), null);
    assert.equal(exceedanceRate([rec({ taxShare: null })], 'taxShare', 0.5), null);
    assert.notEqual(exceedanceRate([rec({ taxShare: 0.1 })], 'taxShare', 0.5), null);
  });
});

// ─── the family the sweep found ───────────────────────────────────────────────

describe('the earnings family (found by the phase 6 sweep)', () => {

  test('CLS-E1 growth applied to an account is a REVALUATION, not spending', () => {
    // These credit in a good year and DEBIT in a bad one, which is the only reason they
    // appear in a debit report at all. The reference plan never showed them because its
    // returns never go negative; 40 perturbed paths surfaced four of them.
    for (const actionType of [
      'STOCK_EARNINGS_APPLY', 'AU_STOCK_EARNINGS_APPLY', 'IRA_EARNINGS_APPLY',
      'ROTH_EARNINGS_APPLY', 'SUPER_EARNINGS_APPLY', 'FIXED_INCOME_EARNINGS_APPLY',
      'AU_FIXED_INCOME_EARNINGS_APPLY', 'AU_SAVINGS_EARNINGS_APPLY',
      'BOND_ACCRETION_APPLY', 'ASSET_APPRECIATE_APPLY',
    ]) {
      const [share] = classifyDebit({ actionType, stateKey: 'acct.balance' });
      assert.equal(share.category, REPORT_CATEGORY.REVALUATION, actionType);
      assert.equal(share.tier, SPEND_TIER.NOT_SPENDING, actionType);
    }
  });

  test('CLS-E2 the WITHDRAWAL/ROLLOVER siblings are transfers, not marks', () => {
    // Similar names, different thing: they move money out of a wrapper rather than mark
    // it. Pinned because the naming similarity makes them the likeliest mis-add.
    for (const actionType of [
      'IRA_WITHDRAWAL_EARNINGS_APPLY', 'ROTH_WITHDRAWAL_EARNINGS_APPLY',
      'ROTH_ROLLOVER_EARNINGS_APPLY', 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY',
      'SUPER_WITHDRAWAL_EARNINGS_APPLY',
    ]) {
      assert.equal(classifyDebit({ actionType, stateKey: 'acct.balance' })[0].category,
        REPORT_CATEGORY.INTERNAL, actionType);
    }
  });

  test('CLS-E3 TAX_CATEGORIES covers every tax the taxonomy names', () => {
    // A tax share computed over a subset of the tax categories is wrong in a way nothing
    // else here would catch.
    const taxes = Object.values(REPORT_CATEGORY).filter(c => c.startsWith('TAX_'));
    assert.deepEqual([...TAX_CATEGORIES].sort(), taxes.sort());
  });
});
