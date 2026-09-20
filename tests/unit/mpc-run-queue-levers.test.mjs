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
 * mpc-run-queue-levers.test.mjs
 *
 * DESIGN 81 phase 3 — the two levers that act on QUEUED EVENTS, and the refusal their
 * failure mode forced (§16.3, D11's first half, the case that settles Q5).
 *
 * MRQ-1  D5 — `scheduleKey` returns `year@<year>`, never the schedule INDEX
 * MRQ-2  The fold upserts year entries, preserves undecided ones, and sorts
 * MRQ-3  The fold reaches `context.parameters` — a run's conversions actually happen
 * MRQ-4  **The ORDER**, named rather than commented (§6.3's one load-order dependency)
 * MRQ-5  D11 — a run naming a disabled mechanic THROWS at load, and says which lever
 * MRQ-6  The refusal is general, and it is silent when there is nothing to refuse
 * MRQ-7  The reducer skips fold-at-compile levers SILENTLY, not with the missing-hook warning
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { LEVER_SCHEDULE, yearKey, yearKeyParts } from '../../src/finance/mpc/lever-schedule.js';
import { assertRunIsPlayable, foldQueueLeverRuns } from '../../src/finance/mpc/run-compile-fold.js';
import { MpcDecisionScheduleReducer } from '../../src/finance/mpc/mpc-decision-schedule-reducer.js';
import { resolveActiveMpcRun }        from '../../src/finance/mpc/run-schedule.js';
import { ScenarioCompiler }           from '../../src/scenarios/toolsets/scenario-compiler.js';
import { US_ROTH_CONVERSION }         from '../../src/scenarios/toolsets/us-roth-conversion-toolset.js';
import { loadScenarioSim }            from '../helpers/scenario-harness.js';

const D = (y) => new Date(Date.UTC(y, 0, 1)).toISOString();

/** A run that converts $80k in 2031 and decants in 2032. */
const QUEUE_RUN = {
  'run:q': {
    source: { recordedAt: '2026-09-20', levers: ['ROTH', 'EARLY_WITHDRAWAL'], epochs: 2 },
    decisions: [
      { date: D(2030), lever: 'ROTH',             key: yearKey(2031),                      value: 80_000 },
      { date: D(2031), lever: 'EARLY_WITHDRAWAL', key: yearKey(2032, 'taxDeferredAmount'), value: 25_000 },
      { date: D(2031), lever: 'EARLY_WITHDRAWAL', key: yearKey(2032, 'rothAmount'),        value: 10_000 },
    ],
  },
};

/** The same run with only the ROTH rows — so an A/B need not also enable decanting. */
const ROTH_ONLY_RUN = {
  'run:r': { decisions: QUEUE_RUN['run:q'].decisions.filter(d => d.lever === 'ROTH') },
};

const ROTH_ON = {
  mpcRuns: QUEUE_RUN, mpcActiveRun: 'run:q',
  rothConversionEnabled: true,
  earlyWithdrawalEnabled: true, earlyWithdrawalStartYear: 2030, earlyWithdrawalEndYear: 2035,
};

// ─── MRQ-1 ───────────────────────────────────────────────────────────────────

test('MRQ-1: `scheduleKey` is the YEAR, never the schedule index (D5, in its purest form)', () => {
  // Both levers' `buildVariables` emit an index found by searching the table for the year at
  // "now", and both `prepareBaseParams` APPEND a row and re-sort — so the index moves as the
  // run proceeds. The year is the anchor those very functions searched by.
  assert.equal(LEVER_SCHEDULE.ROTH.scheduleKey(
    { paramKey: 'rothConversionSchedule[7].incomeTarget', _year: 2031 }), 'year@2031');
  assert.equal(LEVER_SCHEDULE.EARLY_WITHDRAWAL.scheduleKey(
    { paramKey: 'earlyWithdrawalSchedule[7].rothAmount', _year: 2032 }), 'year@2032::rothAmount');

  assert.deepEqual(yearKeyParts('year@2031'), { year: 2031, field: null });
  assert.deepEqual(yearKeyParts('year@2032::rothAmount'), { year: 2032, field: 'rothAmount' });
  assert.equal(yearKeyParts('rothConversionSchedule[7].incomeTarget'), null);
});

// ─── MRQ-2 ───────────────────────────────────────────────────────────────────

test('MRQ-2: the fold upserts by year, preserves what the run never decided, and sorts', () => {
  const folded = foldQueueLeverRuns({
    ...ROTH_ON,
    rothConversionSchedule: [{ year: 2040, incomeTarget: 10_000 }, { year: 2031, incomeTarget: 1 }],
    earlyWithdrawalSchedule: [{ year: 2032, taxDeferredAmount: 0, rothAmount: 0,
                               destinationKey: 'usStockAccount' }],
  });

  assert.deepEqual(folded.rothConversionSchedule, [
    { year: 2031, incomeTarget: 80_000 },        // decided → overwritten
    { year: 2040, incomeTarget: 10_000 },        // never decided → preserved, and now sorted
  ]);
  // A field the run did not decide survives on an entry it DID decide — the fold is per
  // field, not per row, which is what lets one lever own two numbers per year.
  assert.deepEqual(folded.earlyWithdrawalSchedule, [
    { year: 2032, taxDeferredAmount: 25_000, rothAmount: 10_000, destinationKey: 'usStockAccount' },
  ]);
});

test('MRQ-2: the fold writes into NO param — the authored bag is untouched (D5)', () => {
  const authored = { ...ROTH_ON, rothConversionSchedule: [{ year: 2031, incomeTarget: 1 }] };
  const folded = foldQueueLeverRuns(authored);
  assert.equal(authored.rothConversionSchedule[0].incomeTarget, 1);
  assert.notEqual(folded, authored);
});

test('MRQ-2: no selected run ⇒ the SAME bag object back, so a scenario that does not use this is untouched', () => {
  const p = { rothConversionEnabled: true, rothConversionSchedule: [] };
  assert.equal(foldQueueLeverRuns(p), p);
  // A bag with entries but nothing selected is the D4 case: it folds nothing.
  const unselected = { ...p, mpcRuns: QUEUE_RUN, mpcActiveRun: null };
  assert.equal(foldQueueLeverRuns(unselected), unselected);
});

// ─── MRQ-3 / MRQ-4 ───────────────────────────────────────────────────────────

test('MRQ-3: the folded schedule reaches the toolset — it emits the run\u2019s conversion event', () => {
  // The claim is about the SEAM, so it is asserted at the seam: hand the real toolset the
  // folded bag and check the events it builds. A balance assertion would be a weaker test of
  // a longer chain — the reference scenario converts nothing in this window even from a
  // hand-authored schedule, so a balance A/B here would pass or fail for reasons that have
  // nothing to do with the fold.
  const folded = foldQueueLeverRuns({ ...ROTH_ON, mpcRuns: ROTH_ONLY_RUN, mpcActiveRun: 'run:r',
                                      rothConversionSchedule: [{ year: 2031, incomeTarget: 0 }] });
  const context = {
    parameters: folded,
    startDate: new Date(Date.UTC(2030, 0, 1)),
    people:   [{ id: 'primary', name: 'P', birthDate: '1978-04-15' }],
    accounts: [{ role: 'ira', ownerId: 'primary', stateKey: 'iraAccount' },
               { role: 'roth-ira', ownerId: 'primary', stateKey: 'rothAccount' }],
  };
  const events = US_ROTH_CONVERSION.schedules(context);
  const evaluate = events.filter(e => e.type === 'ROTH_CONVERSION_POLICY_EVALUATE');
  assert.equal(evaluate.length, 1, 'exactly the one year the run decided');
  assert.equal(new Date(evaluate[0].date).getUTCFullYear(), 2031);
  // The target is the run's 80k compounded to 2031 nominal by the toolset, so it must be
  // strictly greater than the authored 0 it replaced — and not the authored 0 itself.
  assert.ok(evaluate[0].data.targetIncome > 80_000, evaluate[0].data.targetIncome);

  // The control: without the run, the same base emits the same event at the authored 0.
  const unfolded = US_ROTH_CONVERSION.schedules({
    ...context, parameters: { ...ROTH_ON, mpcActiveRun: null,
                              rothConversionSchedule: [{ year: 2031, incomeTarget: 0 }] } });
  assert.equal(unfolded[0].data.targetIncome, 0);
});

test('MRQ-4: the fold runs BEFORE any toolset reads parameters (§6.3’s one load-order rule)', () => {
  // An outcome test passes for a fold that merely happens to run first today. This asserts
  // the ORDER directly: a probe toolset records what `context.parameters` held at the moment
  // its `schedules()` was called, which is the exact instant the real toolsets read it.
  let seenAtSchedules = null;
  const probe = {
    id: 'design81-order-probe',
    paramSchema: () => [],
    schedules: (context) => {
      seenAtSchedules = context.parameters.rothConversionSchedule;
      return [];
    },
  };
  const compiler = new ScenarioCompiler({ get: () => probe });
  const services = {
    typeRegistry: null,
    simulationRegistry: { getPrimary: () => ({ state: {} }) },
    eventService:   { register() {} },
    handlerService: { register() {} },
    reducerService: { register() {} },
  };
  compiler.compile({
    toolsets: ['design81-order-probe'],
    simStart: '2030-01-01', simEnd: '2033-01-01',
    parameters: { ...ROTH_ON, rothConversionSchedule: [] },
  }, services);

  assert.ok(Array.isArray(seenAtSchedules) && seenAtSchedules.some(e => e.year === 2031),
    'schedules() saw an UNFOLDED bag — the fold must happen before any toolset reads parameters');
});

// ─── MRQ-5 / MRQ-6 ───────────────────────────────────────────────────────────

test('MRQ-5: D11 — a run naming a DISABLED mechanic throws at load and names the lever', () => {
  // The §16.3 case. `us-roth-conversion-toolset.js` opens with `if (!p.rothConversionEnabled)
  // return []`, so without this refusal every ROTH row is dropped on the floor and the plan
  // quietly becomes a different plan.
  assert.throws(
    () => assertRunIsPlayable({ ...ROTH_ON, rothConversionEnabled: false }),
    (e) => /ROTH/.test(e.message)
        && /Enable Roth conversions/.test(e.message)
        && /run:q/.test(e.message));
});

test('MRQ-5: the refusal reaches the real load path, not just the helper', () => {
  assert.throws(() => loadScenarioSim({
    params: { rothConversionEnabled: false, earlyWithdrawalEnabled: false,
              mpcRuns: QUEUE_RUN, mpcActiveRun: 'run:q' },
    simStart: new Date(Date.UTC(2030, 0, 1)), simEnd: new Date(Date.UTC(2033, 0, 1)),
  }), /design 81 D11/);
});

test('MRQ-6: the refusal is general — every lever’s gate, not just the two queue ones', () => {
  // A SPENDING run against a base with no EXPLICIT_BANDS compiles no
  // `ExplicitBandsSpendingReducer`, so the band table is stamped and read by nobody: the same
  // shape of silent failure, one lever over.
  const spendingRun = { r: { decisions: [
    { date: D(2030), lever: 'SPENDING', key: 'band@60', value: 5000 }] } };
  assert.throws(
    () => assertRunIsPlayable({ mpcRuns: spendingRun, mpcActiveRun: 'r', spendingStrategy: ['FIXED'] }),
    /SPENDING.*EXPLICIT_BANDS/s);
  // …and it passes once the gate is satisfied.
  assert.doesNotThrow(() => assertRunIsPlayable(
    { mpcRuns: spendingRun, mpcActiveRun: 'r', spendingStrategy: ['EXPLICIT_BANDS'] }));
});

test('MRQ-6: nothing selected, or an ungated lever, refuses nothing', () => {
  assert.doesNotThrow(() => assertRunIsPlayable({}));
  assert.doesNotThrow(() => assertRunIsPlayable({ mpcRuns: QUEUE_RUN, mpcActiveRun: null }));
  assert.doesNotThrow(() => assertRunIsPlayable({ ...ROTH_ON, mpcRunEnabled: false }));
  // DRAWDOWN_XBORDER is `appliesTo: () => true` — inert only under a DATA condition a gate
  // cannot see, so it must never refuse.
  assert.doesNotThrow(() => assertRunIsPlayable({
    mpcActiveRun: 'r',
    mpcRuns: { r: { decisions: [
      { date: D(2030), lever: 'DRAWDOWN_XBORDER', key: 'crossBorderDrawdown', value: 'GLOBAL' }] } },
  }));
});

// ─── MRQ-7 ───────────────────────────────────────────────────────────────────

test('MRQ-7: the reducer skips fold-at-compile levers SILENTLY — no missing-hook warning', () => {
  const run = resolveActiveMpcRun({ mpcRuns: QUEUE_RUN, mpcActiveRun: 'run:q' });
  const seen = [];
  const real = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  let out;
  try {
    out = new MpcDecisionScheduleReducer({ run, baseParams: {} })
      .reduce({}, { type: 'US_PERIOD_ADVANCE', date: new Date(Date.UTC(2032, 0, 1)) }, null);
  } finally { console.warn = real; }

  // Their rows are someone else's job, already done at compile. A warning that fires on every
  // run that converts is a warning nobody reads.
  assert.equal(seen.join('\n'), '');
  assert.equal('mpcDecisionApplied' in out, false);
});
