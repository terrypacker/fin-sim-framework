/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * spending-grouping.test.mjs — design 89 phase 3 (§9, §11).
 *
 * The pivot and the deflator: everything between the classified cube and the chart. It
 * lives in `src/` so the lab page and the eventual workbench panel cannot disagree about
 * a share, which only means anything if the pivot itself is pinned.
 *
 *   PL-1..6     `JournalPriceLevels` — the opening seed, the lookup, and the refusal to
 *               invent a level it does not have.
 *   GRP-1..6    `buildSpendingSeries` — year gaps, canonical band order, the share view,
 *               and the forced axis two strips share.
 *   TIER-1..3   `bySpendingTier` — the two strips, on one axis, never summed.
 *   INT-1..4    `intentVsRealized` — including the null-vs-zero regression that drew a
 *               permanent phantom shortfall on a solvent plan, and a genuinely
 *               short plan where the gap must actually open.
 *
 * Run with: node --test tests/unit/spending-grouping.test.mjs
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { BaseScenario }    from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { JournalPriceLevels, PRICE_LEVEL_PATHS }
  from '../../src/finance/journal-reporting/journal-price-levels.js';
import { buildSpendingCube, spendingSummary, categoriesByValue }
  from '../../src/finance/spending-reporting/spending-cube.js';
import { buildSpendingSeries, bySpendingTier, intentVsRealized, CATEGORY_ORDER }
  from '../../src/finance/spending-reporting/spending-grouping.js';
import { REPORT_CATEGORY, SPEND_TIER }
  from '../../src/finance/spending-reporting/spending-classification.js';

// ─── fixtures ─────────────────────────────────────────────────────────────────

const day = (iso) => new Date(iso);

/** A journal stub: only the shape `JournalPriceLevels` reads. */
const priceJournal = (points) => ({
  journal: points.map(([date, before, after]) => ({
    date: day(date),
    stateDiff: [{ field: PRICE_LEVEL_PATHS.US, before, after }],
  })),
});

/** A cube row, with only the fields the pivot reads. */
const row = (year, category, amountReal, over = {}) => ({
  year, category, amountReal, amount: amountReal,
  tier: CATEGORY_ORDER.indexOf(category) < CATEGORY_ORDER.indexOf(REPORT_CATEGORY.INTERNAL)
    ? SPEND_TIER.SPENDING : SPEND_TIER.NOT_SPENDING,
  intent: null, intentReal: null,
  ...over,
});

const USD = { code: 'USD', symbol: '$' };

/**
 * A plan authored to RUN OUT. `monthlyExpenses` far exceeds what the accounts can fund,
 * so `ExpenseDebitReducer` caps the debit and the realized bands report an underspend
 * where the truth is a shortfall — the exact case §5's intent line exists for, and the
 * only case in which it draws anything at all.
 *
 * The brokerage account is not decoration. Without it the plan has a single cash pool,
 * nothing is ever drawn down or transacted, and **no tier-2 row exists** — which made
 * every real-vs-nominal tier assertion below vacuous. Caught by its own guard, which is
 * why the guard is there.
 */
function brokePlanConfig() {
  return {
    toolsets: ['US_RETIREMENT', 'US_TAX'],
    simStart: '2026-01-01', simEnd: '2031-01-01',
    parameters: { monthlyExpenses: 40_000 },
    persons: [{
      __type: 'Person', id: 'primary', name: 'P', birthDate: '1960-04-15',
      lifeExpectancy: 95, citizen: ['US'], residency: 'US', monthlyWage: 0,
      retirementDate: '2025-01-01', socialSecurityMonthly: 0,
    }],
    accounts: [
      {
        __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings', type: 'savings',
        role: 'us-savings', stateKey: 'usSavingsAccount', initialValue: 400_000,
        ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0, country: 'US', currency: USD,
      },
      {
        __type: 'BrokerageAccount', id: 'us-stock', name: 'US Brokerage', type: 'brokerage',
        role: 'us-taxable', stateKey: 'usStockAccount', initialValue: 500_000,
        ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0,
        drawdownPriority: 1, country: 'US', currency: USD,
      },
    ],
    realProperties: [],
  };
}

let _broke = null;
function brokeRun() {
  if (!_broke) {
    const config = brokePlanConfig();
    ServiceRegistry.resetAll();
    const services = ServiceRegistry.getInstance();
    const scenario = new BaseScenario({
      context:  services.simulationContext,
      simStart: new Date(config.simStart),
      simEnd:   new Date(config.simEnd),
    });
    scenario.buildSim();
    new ScenarioLoader().load(structuredClone(config), services);
    scenario.sim.stepTo(new Date('2030-12-31'));
    _broke = { sim: scenario.sim, services };
  }
  return _broke;
}

// ─── JournalPriceLevels ───────────────────────────────────────────────────────

describe('JournalPriceLevels — design 89 §9.b.1', () => {

  test('PL-1 seeds the opening level from the first diff\'s `before`', () => {
    // The seed matters more here than it does for FX: the accumulator starts at exactly
    // 1.0 and every debit before the first increment belongs at that level. Without it
    // the earliest — and in real terms largest — bars are deflated by the level of the
    // FIRST INCREMENT instead, understating them.
    const p = new JournalPriceLevels(priceJournal([['2027-06-30', 1, 1.03]]));
    assert.equal(p.levelAt(day('2026-03-01').getTime()), 1, 'before any increment');
    assert.equal(p.levelAt(day('2027-06-30').getTime()), 1.03, 'on the increment');
    assert.equal(p.levelAt(day('2029-01-01').getTime()), 1.03, 'after the last increment');
  });

  test('PL-2 reads the last level at or before the timestamp', () => {
    const p = new JournalPriceLevels(priceJournal([
      ['2027-01-01', 1,    1.03],
      ['2028-01-01', 1.03, 1.07],
      ['2029-01-01', 1.07, 1.12],
    ]));
    assert.equal(p.levelAt(day('2027-06-01').getTime()), 1.03);
    assert.equal(p.levelAt(day('2028-06-01').getTime()), 1.07);
    assert.equal(p.levelAt(day('2030-06-01').getTime()), 1.12);
    assert.equal(p.terminalLevel(), 1.12);
  });

  test('PL-3 toReal divides, and null is null — never a silent pass-through', () => {
    const p = new JournalPriceLevels(priceJournal([['2027-01-01', 1, 2]]));
    assert.equal(p.toReal(200, day('2028-01-01').getTime()), 100);
    assert.equal(p.toReal(200, day('2026-01-01').getTime()), 200, 'base year is identity');

    // A journal with nothing recorded and no fallback must NOT return the nominal
    // amount: that is a nominal number wearing a real label, the defect this removes.
    const empty = new JournalPriceLevels({ journal: [] });
    assert.equal(empty.isEmpty, true);
    assert.equal(empty.levelAt(Date.now()), null);
    assert.equal(empty.toReal(200, Date.now()), null);
  });

  test('PL-4 the fallback is consulted only when the journal recorded nothing', () => {
    const withFallback = new JournalPriceLevels({ journal: [] }, { fallbackLevel: () => 1.5 });
    assert.equal(withFallback.toReal(300, Date.now()), 200);

    // …and never consulted when it did, or an inflation-off run would silently pick up
    // the live accumulator of whatever ran last.
    const recorded = new JournalPriceLevels(priceJournal([['2027-01-01', 1, 2]]),
                                            { fallbackLevel: () => 99 });
    assert.equal(recorded.levelAt(day('2028-01-01').getTime()), 2);
  });

  test('PL-5 countries are tracked separately', () => {
    const j = { journal: [
      { date: day('2027-01-01'), stateDiff: [{ field: PRICE_LEVEL_PATHS.US, before: 1, after: 1.02 }] },
      { date: day('2027-01-01'), stateDiff: [{ field: PRICE_LEVEL_PATHS.AU, before: 1, after: 1.09 }] },
    ] };
    const p = new JournalPriceLevels(j);
    assert.equal(p.levelAt(day('2028-01-01').getTime(), 'US'), 1.02);
    assert.equal(p.levelAt(day('2028-01-01').getTime(), 'AU'), 1.09);
    assert.deepEqual(p.countries().sort(), ['AU', 'US']);
  });

  test('PL-6 recovers a real run\'s history from its journal alone', () => {
    const { sim } = brokeRun();
    const p = new JournalPriceLevels(sim.journal);
    assert.equal(p.isEmpty, false, 'the accumulator must be diffed into the journal');
    const terminal = p.terminalLevel('US');
    assert.ok(terminal > 1, `terminal level ${terminal} should exceed the base year`);
    // Monotone: a cumulative index that ever fell would mean deflation was modelled, and
    // would break the "a later dollar is worth less" reading the whole chart rests on.
    let previous = 0;
    for (let y = 2026; y <= 2030; y++) {
      const level = p.levelAt(Date.UTC(y, 6, 1), 'US');
      assert.ok(level >= previous, `level fell at ${y}: ${level} < ${previous}`);
      previous = level;
    }
  });
});

// ─── buildSpendingSeries ──────────────────────────────────────────────────────

describe('buildSpendingSeries', () => {

  const rows = [
    row(2026, REPORT_CATEGORY.LIVING, 100), row(2026, REPORT_CATEGORY.TAX_AU, 50),
    row(2028, REPORT_CATEGORY.LIVING, 200), row(2028, REPORT_CATEGORY.INTERNAL, 400),
  ];

  test('GRP-1 an empty year is DRAWN, not skipped', () => {
    // 2027 has no debits. Compressing it out would make 2026 and 2028 read as adjacent
    // years — a chart of a flow must show the year in which nothing flowed.
    const s = buildSpendingSeries(rows);
    assert.deepEqual(s.years, [2026, 2027, 2028]);
    assert.equal(s.series[REPORT_CATEGORY.LIVING][1], 0, '2027 is a real zero');
  });

  test('GRP-2 bands keep the canonical order, not the magnitude order', () => {
    // A band that changes colour or position when a category drops to zero is actively
    // misleading on a chart whose entire job is comparison across years.
    const s = buildSpendingSeries(rows);
    assert.deepEqual(s.keys, [REPORT_CATEGORY.LIVING, REPORT_CATEGORY.TAX_AU, REPORT_CATEGORY.INTERNAL]);
    // INTERNAL is the largest single value (400) and still comes last.
    assert.ok(s.series[REPORT_CATEGORY.INTERNAL][2] > s.series[REPORT_CATEGORY.LIVING][2]);
  });

  test('GRP-3 the share view sums to 1 in a non-empty year and 0 in an empty one', () => {
    const s = buildSpendingSeries(rows, { normalize: true });
    const columnSum = i => s.keys.reduce((a, k) => a + s.series[k][i], 0);
    assert.ok(Math.abs(columnSum(0) - 1) < 1e-12);
    assert.equal(columnSum(1), 0, 'a zero year is a flat band, not a NaN hole');
    assert.ok(Math.abs(columnSum(2) - 1) < 1e-12);
  });

  test('GRP-4 a forced axis wins, so two strips can share an x-axis', () => {
    const s = buildSpendingSeries(rows, { years: [2025, 2026, 2027, 2028, 2029] });
    assert.deepEqual(s.years, [2025, 2026, 2027, 2028, 2029]);
    assert.equal(s.series[REPORT_CATEGORY.LIVING][0], 0, 'a year with no rows is zero-filled');
    assert.equal(s.series[REPORT_CATEGORY.LIVING][1], 100);
  });

  test('GRP-5 the value axis is a parameter — real is only the DEFAULT', () => {
    const mixed = [row(2026, REPORT_CATEGORY.LIVING, 100, { amount: 250 })];
    assert.equal(buildSpendingSeries(mixed).totals[0], 100, 'default is amountReal');
    assert.equal(buildSpendingSeries(mixed, { value: 'amount' }).totals[0], 250);
  });

  test('GRP-6 empty input returns an empty shape, not a throw', () => {
    for (const input of [[], null, undefined]) {
      const s = buildSpendingSeries(input);
      assert.deepEqual(s, { years: [], keys: [], series: {}, totals: [] });
    }
  });
});

// ─── bySpendingTier ───────────────────────────────────────────────────────────

describe('bySpendingTier', () => {

  const rows = [
    row(2026, REPORT_CATEGORY.LIVING,   100),
    row(2027, REPORT_CATEGORY.INTERNAL, 400),
  ];

  test('TIER-1 both strips share one axis even where a tier is empty', () => {
    // The case where a misaligned axis is both most likely and most wrong: 2026 has only
    // spending and 2027 only transfers, so two independently-derived axes would be
    // length 1 each and the strips would draw different years in the same column.
    const t = bySpendingTier(rows);
    assert.deepEqual(t.years, [2026, 2027]);
    assert.deepEqual(t.spending.years, t.years);
    assert.deepEqual(t.notSpending.years, t.years);
  });

  test('TIER-2 neither strip carries the other\'s categories', () => {
    const t = bySpendingTier(rows);
    assert.deepEqual(t.spending.keys,    [REPORT_CATEGORY.LIVING]);
    assert.deepEqual(t.notSpending.keys, [REPORT_CATEGORY.INTERNAL]);
    assert.deepEqual(t.spending.totals,    [100, 0]);
    assert.deepEqual(t.notSpending.totals, [0, 400]);
  });

  test('TIER-3 on a real run the two strips partition the cube exactly', () => {
    // §7(a) again, this time through the pivot: the reduction that feeds the chart must
    // not lose or duplicate a dollar on its way there.
    const { sim, services } = brokeRun();
    const cube = buildSpendingCube({ journal: sim.journal, state: sim.state, services });
    const t    = bySpendingTier(cube.rows);
    const sum  = a => a.reduce((x, y) => x + y, 0);
    const pivoted = sum(t.spending.totals) + sum(t.notSpending.totals);
    assert.ok(Math.abs(pivoted - cube.totalReal) / cube.totalReal < 1e-9,
      `pivot totals ${pivoted} vs cube ${cube.totalReal}`);
  });
});

// ─── intentVsRealized ─────────────────────────────────────────────────────────

describe('intentVsRealized — design 89 §5', () => {

  test('INT-1 a row with NO intent contributes its realized amount, not zero', () => {
    // The regression. `Number(null)` is 0 and 0 is finite, so testing
    // `Number.isFinite(Number(x))` treats "this row has no intent" as "this row intended
    // nothing" — which drew every tax row as a total shortfall and put a permanent
    // phantom gap under the line on a perfectly solvent plan.
    const rows = [
      row(2026, REPORT_CATEGORY.TAX_AU, 500),                                  // intentReal null
      row(2026, REPORT_CATEGORY.LIVING, 100, { intentReal: 100, intent: 100 }),
    ];
    const iv = intentVsRealized(rows);
    assert.equal(iv.realized[0], 600);
    assert.equal(iv.intent[0],   600, 'the tax row must not be counted as intending 0');
    assert.equal(iv.shortfall[0], 0);
  });

  test('INT-2 a capped debit opens the gap', () => {
    const rows = [row(2026, REPORT_CATEGORY.LIVING, 40, { intentReal: 100, intent: 100 })];
    const iv = intentVsRealized(rows);
    assert.equal(iv.realized[0],  40);
    assert.equal(iv.intent[0],   100);
    assert.equal(iv.shortfall[0], 60);
  });

  test('INT-3 tier 2 is excluded — a transfer has no intent to fall short of', () => {
    const rows = [
      row(2026, REPORT_CATEGORY.LIVING,   100, { intentReal: 100 }),
      row(2026, REPORT_CATEGORY.INTERNAL, 900),
    ];
    const iv = intentVsRealized(rows);
    assert.equal(iv.realized[0], 100, 'the 900 transfer is not spending');
    assert.equal(iv.intent[0],   100);
  });

  test('INT-4 a plan that runs out actually draws a shortfall', () => {
    // The end-to-end case, and the one the line exists for: when the account empties the
    // debit shrinks, so the realized bands report "spent less" where the truth is "went
    // short". Without this the whole intent apparatus could be inert and every other
    // test here would still pass.
    const { sim, services } = brokeRun();
    const cube = buildSpendingCube({ journal: sim.journal, state: sim.state, services });
    const iv   = intentVsRealized(cube.rows);

    const shortfall = iv.shortfall.reduce((a, v) => a + v, 0);
    assert.ok(shortfall > 0,
      'the fixture stopped running out of money — this test proves nothing until it does');

    // And it must open only AFTER the money is gone: a shortfall in year one would mean
    // the intent figure is wrong rather than the plan being short.
    assert.equal(iv.shortfall[0], 0, 'year one is funded');
    const firstShort = iv.shortfall.findIndex(v => v > 0);
    assert.ok(firstShort > 0, 'the gap opens partway through, where the account empties');
    for (const i of iv.shortfall.keys()) {
      assert.ok(iv.intent[i] >= iv.realized[i] - 1e-6,
        `intent below realized in ${iv.years[i]} — realizedAmount is min(ask, balance)`);
    }
  });
});

// ─── the two-unit contract ────────────────────────────────────────────────────

describe('real and nominal are two units of ONE quantity', () => {

  test('UNIT-1 the summary reports spending in both, and they differ by inflation alone', () => {
    // The defect this pins was a PRESENTATION one that survived every totality check: the
    // page paired nominal SPENDING against real ALL-DEBITS, two different quantities that
    // landed 3% apart on the reference plan — so the card read "inflation barely matters"
    // while the like-for-like ratio was 2.3x.
    const { sim, services } = brokeRun();
    const cube    = buildSpendingCube({ journal: sim.journal, state: sim.state, services });
    const summary = spendingSummary(cube);

    // Computed independently, per tier. An earlier version of this test only checked that
    // the two real figures SUM to the real total — which a bug setting `spendingReal` to
    // the whole total and `notSpendingReal` to zero satisfies perfectly. Verified by
    // mutation: that exact bug passed the sum check and failed nothing.
    const expect = tier => cube.rows.filter(r => r.tier === tier)
      .reduce((a, r) => a + r.amountReal, 0);
    const wantSpending    = expect(SPEND_TIER.SPENDING);
    const wantNotSpending = expect(SPEND_TIER.NOT_SPENDING);

    assert.ok(wantSpending > 0 && wantNotSpending > 0,
      'the fixture must produce both tiers or this proves nothing');
    assert.ok(Math.abs(summary.spendingReal    - wantSpending)    < 1e-6, 'real spending');
    assert.ok(Math.abs(summary.notSpendingReal - wantNotSpending) < 1e-6, 'real not-spending');
    assert.ok(Math.abs(summary.spendingReal + summary.notSpendingReal - cube.totalReal) < 1e-6,
      'and together they partition the real total');

    // The pair is ONE quantity in two units, so the ratio between them is the deflator —
    // not the tier split, and not the real/nominal ratio of some other quantity.
    assert.ok(summary.spending >= summary.spendingReal,
      'nominal must be the larger of the pair under positive inflation');
    assert.ok(summary.inflationFactor >= 1);
    assert.ok(Math.abs(summary.inflationFactor - summary.spending / wantSpending) < 1e-9);
  });

  test('UNIT-2 every category carries both units, ordered by the real one', () => {
    const { sim, services } = brokeRun();
    const cube = buildSpendingCube({ journal: sim.journal, state: sim.state, services });
    const cats = categoriesByValue(cube);

    // Computed independently per category, for the reason UNIT-1 records: a bug that
    // simply copies the nominal figure into `amountReal` satisfies every relational check
    // (real ≤ nominal, ordering monotone) while reporting the wrong unit. Verified by
    // mutation — it did.
    const wantReal = new Map();
    for (const r of cube.rows) wantReal.set(r.category, (wantReal.get(r.category) ?? 0) + r.amountReal);

    assert.ok(cats.length > 0);
    for (const c of cats) {
      assert.ok(Number.isFinite(c.amount) && Number.isFinite(c.amountReal), c.category);
      assert.ok(Math.abs(c.amountReal - wantReal.get(c.category)) < 1e-6, `${c.category} real`);
      assert.ok(c.amount >= c.amountReal - 1e-6, `${c.category} real exceeds nominal`);
    }
    for (let i = 1; i < cats.length; i++)
      assert.ok(cats[i - 1].amountReal >= cats[i].amountReal, 'ordered by the REAL amount');

    // At least one category must differ between the units, or the run had no inflation
    // and this test could not tell a deflated figure from an undeflated one.
    assert.ok(cats.some(c => c.amount - c.amountReal > 1),
      'no category differs between real and nominal — the fixture stopped inflating');
  });
});
