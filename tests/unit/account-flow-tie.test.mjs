/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * account-flow-tie.test.mjs — design 89 phase 4, §7(b).
 *
 *     openingBalance + Σ credits − Σ debits === closingBalance     per account, per year
 *
 * The invariant design 89 calls the one worth the most: it is what makes the spending
 * chart and design 82's allocation chart one picture rather than two plausible ones.
 *
 * On a healthy run both checks pass trivially, which is exactly why most of this file is
 * about making them FAIL. A green invariant proves nothing until you have watched it go
 * red for the right reason — so every check here is paired with a fabricated break, and
 * the real-run tests assert their own fixture is non-vacuous before believing it.
 *
 *   SAMP-1..2   the sampler snapshots, and rides design 82's cadence.
 *   FLOW-1..4   `buildAccountFlows` — sign split, year bucketing, the opening seed.
 *   CONT-1..3   continuity: a journal that is a complete account of itself, and one that isn't.
 *   TIE-1..6    the identity on a real run, the first year, and four ways to break it.
 *
 * Run with: node --test tests/unit/account-flow-tie.test.mjs
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { BaseScenario }    from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { createBalanceSampler, buildAccountFlows, checkJournalContinuity,
         checkFlowTiesToStock, checkFlowInvariant }
  from '../../src/finance/spending-reporting/account-flow-tie.js';

const USD = { code: 'USD', symbol: '$' };

/** A journal stub carrying only the shape these functions read. */
const journalOf = (entries) => ({
  journal: entries.map(([date, actionType, diffs]) => ({
    date: new Date(date),
    action: { type: actionType },
    stateDiff: diffs.map(([field, before, after]) => ({ field, before, after, delta: after - before })),
  })),
});

/**
 * A plan with several accounts, a mortgage and real drawdown, so the grid has cells that
 * carry money in both directions. A single-account fixture would tie perfectly while
 * testing almost nothing — the invariant is about accounts DISAGREEING.
 */
function planConfig() {
  return {
    toolsets: ['US_RETIREMENT', 'US_REAL_PROPERTY', 'US_TAX'],
    simStart: '2026-01-01', simEnd: '2032-01-01',
    parameters: { monthlyExpenses: 9_000 },
    persons: [{
      __type: 'Person', id: 'primary', name: 'P', birthDate: '1960-04-15',
      lifeExpectancy: 95, citizen: ['US'], residency: 'US', monthlyWage: 0,
      retirementDate: '2025-01-01', socialSecurityMonthly: 0,
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
    realProperties: [{
      __type: 'RealProperty', id: 're1', name: 'US Home', country: 'US',
      appreciationRate: 0.02, costBasis: 600_000, value: 900_000,
      mortgageBalance: 300_000, monthlyMortgage: 2_200, mortgageInterestRate: 0.055,
      isPrimaryResidence: true, ownerId: 'primary', owners: [], ownershipType: 'sole',
      plannedSaleYear: null, saleDestinationAccount: 'usSavingsAccount',
      stateKey: 'usHouseProperty', currency: USD,
      annualRunningCost: 14_000, runningCostValuePct: 0, runningCostGrowth: 0,
    }],
  };
}

let _run = null;
function run() {
  if (!_run) {
    const config = planConfig();
    ServiceRegistry.resetAll();
    const services = ServiceRegistry.getInstance();
    const scenario = new BaseScenario({
      context:  services.simulationContext,
      simStart: new Date(config.simStart),
      simEnd:   new Date(config.simEnd),
    });
    // The SAME seam design 82's allocation sampler uses — that is what makes §7(b) a
    // cross-check between two reports rather than between two nearly-identical clocks.
    scenario.buildSim({ sampler: createBalanceSampler(), samplerCadence: 'year-boundary' });
    new ScenarioLoader().load(structuredClone(config), services);
    scenario.sim.stepTo(new Date('2031-12-31'));
    _run = { sim: scenario.sim, services };
  }
  return _run;
}

// ─── the sampler ──────────────────────────────────────────────────────────────

describe('createBalanceSampler', () => {

  test('SAMP-1 snapshots primitives — a later mutation must not rewrite the record', () => {
    // `_recordSample` hands the sampler the LIVE state, which the run goes on mutating.
    // A record holding a reference into it becomes a reading of the present rather than
    // of the year end — silently, and only on the years that matter.
    const state = { a: { balance: 100 }, b: { balance: 50 } };
    const record = createBalanceSampler()(state, new Date('2030-12-31'));
    state.a.balance = 999;
    assert.equal(record.balances.a, 100, 'the record moved with the live state');
    assert.equal(record.year, 2030);
  });

  test('SAMP-2 captures balance-bearing entries only', () => {
    const record = createBalanceSampler()({
      cash:      { balance: 10 },
      property:  { value: 500 },            // no balance
      scalar:    42,
      nullish:   null,
      zeroed:    { balance: 0 },            // a real zero, not an absence
    }, new Date('2030-12-31'));
    assert.deepEqual(Object.keys(record.balances).sort(), ['cash', 'zeroed']);
    assert.equal(record.balances.zeroed, 0);
  });

  test('SAMP-3 a real run produces one record per calendar year, ascending', () => {
    const { sim } = run();
    const years = sim.samples.map(s => s.year);
    assert.ok(years.length >= 5, `only ${years.length} samples — the cadence is not firing`);
    assert.deepEqual(years, [...years].sort((a, b) => a - b));
    assert.equal(new Set(years).size, years.length, 'one record per year');
  });
});

// ─── buildAccountFlows ────────────────────────────────────────────────────────

describe('buildAccountFlows', () => {

  test('FLOW-1 splits by sign and buckets by calendar year', () => {
    const flows = buildAccountFlows(journalOf([
      ['2030-03-01', 'CREDIT', [['a.balance', 100, 160]]],
      ['2030-06-01', 'DEBIT',  [['a.balance', 160, 130]]],
      ['2031-02-01', 'DEBIT',  [['a.balance', 130,  90]]],
    ]));
    const y2030 = flows.byCell.get('a|2030');
    assert.equal(y2030.credits, 60);
    assert.equal(y2030.debits,  30);
    assert.equal(y2030.net,     30);
    assert.equal(flows.byCell.get('a|2031').debits, 40);
    assert.equal(flows.diffCount, 3);
  });

  test('FLOW-2 the opening seed is the FIRST `before`, never a later one', () => {
    // It is what lets the first sampled year be checked instead of skipped — and the plan's
    // opening year is often its largest.
    const flows = buildAccountFlows(journalOf([
      ['2030-03-01', 'X', [['a.balance', 100, 160]]],
      ['2030-06-01', 'X', [['a.balance', 160, 130]]],
    ]));
    assert.equal(flows.openingFromJournal.get('a'), 100);
  });

  test('FLOW-3 ignores non-balance paths and zero deltas', () => {
    const flows = buildAccountFlows(journalOf([
      ['2030-03-01', 'X', [['a.costBasis', 1, 2], ['a.balance', 100, 100]]],
    ]));
    assert.equal(flows.byCell.size, 0, 'a zero delta creates no cell');
    assert.equal(flows.diffCount, 1, 'but the balance diff is still counted and seeds the opening');
    assert.equal(flows.openingFromJournal.get('a'), 100);
  });

  test('FLOW-4 several accounts on one entry stay separate', () => {
    const flows = buildAccountFlows(journalOf([
      ['2030-03-01', 'TRANSFER', [['a.balance', 100, 40], ['b.balance', 0, 60]]],
    ]));
    assert.equal(flows.byCell.get('a|2030').debits,  60);
    assert.equal(flows.byCell.get('b|2030').credits, 60);
  });
});

// ─── continuity ───────────────────────────────────────────────────────────────

describe('checkJournalContinuity', () => {

  test('CONT-1 a chained journal passes, and reports what it checked', () => {
    const r = checkJournalContinuity(journalOf([
      ['2030-03-01', 'X', [['a.balance', 100, 160]]],
      ['2030-06-01', 'X', [['a.balance', 160, 130]]],
    ]));
    assert.equal(r.ok, true);
    assert.equal(r.diffCount, 2);
    assert.equal(r.worst, null);
  });

  test('CONT-2 a break is caught and named', () => {
    // The failure this exists for: the balance moved from 160 to 155 with no journal entry
    // saying so. Money the spending cube can never see, because the cube IS those diffs.
    const r = checkJournalContinuity(journalOf([
      ['2030-03-01', 'X',       [['a.balance', 100, 160]]],
      ['2030-06-01', 'MYSTERY', [['a.balance', 155, 130]]],
    ]));
    assert.equal(r.ok, false);
    assert.equal(r.breaks.length, 1);
    assert.equal(r.worst.stateKey, 'a');
    assert.equal(r.worst.expected, 160);
    assert.equal(r.worst.found, 155);
    assert.equal(r.worst.actionType, 'MYSTERY', 'names the entry that found the gap');
  });

  test('CONT-3 a real run is a complete account of itself', () => {
    const { sim } = run();
    const r = checkJournalContinuity(sim.journal);
    assert.ok(r.diffCount > 100, `only ${r.diffCount} balance diffs — the fixture is too thin`);
    assert.ok(r.ok, `${r.breaks.length} unjournalled movement(s), worst ` +
      `${r.worst?.gap} on ${r.worst?.stateKey} at ${r.worst?.date}`);
  });
});

// ─── the identity ─────────────────────────────────────────────────────────────

describe('checkFlowTiesToStock — §7(b)', () => {

  test('TIE-1 holds for every account in every year of a real run', () => {
    const { sim } = run();
    const r = checkFlowTiesToStock({ samples: sim.samples, journal: sim.journal });

    // Non-vacuity first: a grid of empty cells ties perfectly and means nothing. The
    // fixture is 3 accounts (savings, brokerage, the property's loan) x 6 years = 18.
    assert.ok(r.checked >= 15, `only ${r.checked} account-years`);
    const moved = r.cells.filter(c => c.credits > 0 || c.debits > 0);
    assert.ok(moved.length >= 12, `only ${moved.length} of ${r.checked} cells carry any flow`);
    assert.ok(new Set(r.cells.map(c => c.stateKey)).size >= 3, 'need several accounts');
    // Both directions must be exercised, or the identity is only tested on one sign.
    assert.ok(moved.some(c => c.credits > 0) && moved.some(c => c.debits > 0),
      'the fixture must produce both credits and debits');

    assert.ok(r.ok, r.worst
      ? `worst residual ${r.worst.residual} on ${r.worst.stateKey} in ${r.worst.year} ` +
        `(open ${r.worst.opening} + ${r.worst.credits} − ${r.worst.debits} ≠ ${r.worst.closing})`
      : '');
  });

  test('TIE-2 the FIRST year is checked, off the journal\'s opening', () => {
    // It has no prior boundary sample, so an implementation that simply skipped it would
    // still report ok — while leaving the plan's opening year, often its largest, as the
    // one year nothing checks.
    const { sim } = run();
    const r = checkFlowTiesToStock({ samples: sim.samples, journal: sim.journal });

    const firstYear = Math.min(...r.cells.map(c => c.year));
    const seeded    = r.cells.filter(c => c.year === firstYear && c.openingSource === 'journal');
    assert.ok(seeded.length > 0, 'the first year was skipped rather than seeded');
    assert.ok(seeded.some(c => c.opening !== 0),
      'every seeded opening is 0 — the seed is not being read from the journal');
    assert.ok(seeded.some(c => c.credits > 0 || c.debits > 0),
      'the first year carries no flow, so seeding it proves nothing');
  });

  test('TIE-3 a missing debit breaks it, and the residual names the account', () => {
    // Fabricated by deleting one debit from the flows the identity sees — the shape of a
    // real defect where an action moves money without a journalled stateDiff.
    const samples = [
      { year: 2030, balances: { a: 100 } },
      { year: 2031, balances: { a:  40 } },
    ];
    const journal = journalOf([['2031-05-01', 'X', [['a.balance', 100, 70]]]]);  // only −30 of the −60
    const r = checkFlowTiesToStock({ samples, journal });

    assert.equal(r.ok, false);
    assert.equal(r.failures.length, 1);
    assert.equal(r.worst.stateKey, 'a');
    assert.equal(r.worst.year, 2031);
    assert.equal(r.worst.residual, -30, 'closing is 30 lower than the journalled flow explains');
  });

  test('TIE-4 no samples is UNCHECKED, never a silent pass', () => {
    // A green tick over an empty set is the failure mode design 82 §3 and the payload
    // schema test both grew explicit guards for.
    const journal = journalOf([['2031-05-01', 'X', [['a.balance', 100, 70]]]]);
    for (const samples of [[], null, undefined]) {
      const r = checkFlowTiesToStock({ samples, journal });
      assert.equal(r.unchecked, true);
      assert.equal(r.checked, 0);
      const whole = checkFlowInvariant({ samples, journal });
      assert.equal(whole.ok, false, 'checkFlowInvariant must not report ok on an unchecked run');
      assert.match(whole.summary, /not checked/);
    }
  });

  test('TIE-5 an account appearing mid-run opens at zero and must be journalled', () => {
    const samples = [
      { year: 2030, balances: { a: 100 } },
      { year: 2031, balances: { a: 100, newLoan: 250 } },
    ];
    // Journalled creation: ties.
    const ok = checkFlowTiesToStock({
      samples, journal: journalOf([['2031-03-01', 'CREATE', [['newLoan.balance', 0, 250]]]]),
    });
    assert.equal(ok.ok, true);

    // Sprung into existence unjournalled: fails, which is the correct outcome rather than
    // a case to special-case away.
    const bad = checkFlowTiesToStock({ samples, journal: journalOf([]) });
    assert.equal(bad.ok, false);
    assert.equal(bad.worst.stateKey, 'newLoan');
    assert.equal(bad.worst.residual, 250);
  });

  test('TIE-6 the tolerance is absolute, so a big account cannot hide a break', () => {
    // A relative band would pass a $50 break on a $10m account — the account it matters on.
    const samples = [
      { year: 2030, balances: { big: 10_000_000 } },
      { year: 2031, balances: { big:  9_999_950 } },
    ];
    const r = checkFlowTiesToStock({ samples, journal: journalOf([]) });
    assert.equal(r.ok, false);
    assert.equal(r.worst.residual, -50);

    // …and a genuine sub-cent rounding difference still passes.
    const rounding = checkFlowTiesToStock({
      samples: [{ year: 2030, balances: { a: 100 } }, { year: 2031, balances: { a: 100.005 } }],
      journal: journalOf([]),
    });
    assert.equal(rounding.ok, true);
  });
});

// ─── the combined verdict ─────────────────────────────────────────────────────

describe('checkFlowInvariant', () => {

  test('INV-1 a real run passes both checks and says what it checked', () => {
    const { sim } = run();
    const r = checkFlowInvariant({ samples: sim.samples, journal: sim.journal });
    assert.equal(r.ok, true, r.summary);
    assert.match(r.summary, /ties across \d+ account-years and \d+ balance movements/);
    assert.ok(r.continuity.diffCount > 100);
    assert.ok(r.tie.checked >= 15);
  });

  test('INV-2 either check failing fails the verdict, and both are reported', () => {
    // Continuity broken AND the identity broken, from one fabricated journal: the summary
    // must name both rather than stopping at the first.
    const samples = [
      { year: 2030, balances: { a: 100 } },
      { year: 2031, balances: { a:  10 } },
    ];
    const journal = journalOf([
      ['2031-02-01', 'X',       [['a.balance', 100, 80]]],
      ['2031-05-01', 'MYSTERY', [['a.balance',  70, 50]]],   // 80 ≠ 70: a break
    ]);
    const r = checkFlowInvariant({ samples, journal });
    assert.equal(r.ok, false);
    assert.match(r.summary, /unjournalled balance movement/);
    assert.match(r.summary, /do not tie/);
  });
});
