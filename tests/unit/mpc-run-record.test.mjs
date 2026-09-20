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
 * mpc-run-record.test.mjs
 *
 * DESIGN 81 phase 4 — RECORD. The decision log becomes a bag entry; the controller stops
 * solving against its own future; a study says so when an axis is pinned.
 *
 * MRR-1  D5 — the recorder writes STABLE keys, never the index the log carries
 * MRR-2  `source` is provenance the picker can label, and `derivedFrom` is a parent pointer
 * MRR-3  Dedupe is LOSSLESS — both forms replay to the same decisions in force
 * MRR-4  `saveRunToScenario` writes ONE store, upserts the bag, and selects
 * MRR-5  D9/F1 — promotion goes through the design 80 feasibility gate
 * MRR-6  **D8** — a rollout seeded at "now" sees only rows STRICTLY before it
 * MRR-7  D8 in the controller: `advise` / `apply` / `advance` all compile truncated params
 * MRR-8  D11 second half — a study axis over a pinned param reports; `mpcActiveRun` does not
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  decisionsFromRecords, buildRunEntry, describeRunSource, makeRunKey,
  saveRunToScenario, checkRunFeasibility,
} from '../../src/finance/mpc/run-record.js';
import { resolveActiveMpcRun, activeDecisionsAt, truncateActiveRunAt }
  from '../../src/finance/mpc/run-schedule.js';
import { pinnedParamsOf, runAxisProblems, RUN_AXIS_PROBLEM_KIND }
  from '../../src/finance/mpc/run-axis-hygiene.js';
import { COCKPIT_CONTROLS, CockpitController } from '../../src/finance/mpc/cockpit-controller.js';
import { allocWeightKey } from '../../src/scenarios/params/lever-weights.js';

const D = (y) => new Date(Date.UTC(y, 0, 1)).toISOString();
const MS = (y) => Date.UTC(y, 0, 1);

/**
 * A two-lever log in the shape `readDecisionRecords` returns: `controlKeys` says which levers
 * were live, `controlVars` carries the descriptors, `controlParams` the committed values.
 */
const rec = (year, { band, alloc }) => ({
  id: `mpc:${year}`, asOfDate: D(year), runId: 'cockpit:1',
  controlKeys: ['SPENDING', 'ALLOCATION_MIX'],
  controlVars: [
    { paramKey: 'spendingExpenseBands[19].monthlyAmount', _startAge: 69, _controlKey: 'SPENDING' },
    { paramKey: allocWeightKey('EQUITY'), _class: 'EQUITY', _controlKey: 'ALLOCATION_MIX' },
  ],
  controlParams: {
    'spendingExpenseBands[19].monthlyAmount': band,
    [allocWeightKey('EQUITY')]: alloc,
  },
  goalMetric: { key: 'finalNetLiquidity', label: 'Terminal liquid' },
});

const LOG = [
  rec(2030, { band: 4000, alloc: 0.6 }),
  rec(2031, { band: 4000, alloc: 0.6 }),   // re-decides the SAME values
  rec(2032, { band: 9000, alloc: 0.6 }),   // spending changes; allocation does not
];

const OPTS = { controlsByKey: COCKPIT_CONTROLS };

// ─── MRR-1 ───────────────────────────────────────────────────────────────────

test('MRR-1: the recorder writes the STABLE key, never the index the log carries (D5)', () => {
  const { decisions } = decisionsFromRecords(LOG, OPTS);
  // The log says `spendingExpenseBands[19].monthlyAmount`. An index is a position in the table
  // AS IT STOOD DURING THAT RUN — edit the table and every recorded decision silently points
  // somewhere else. The row stores the age anchor the lever already stamped.
  assert.equal(decisions.some(d => d.key.includes('[')), false,
    `no row may carry an index: ${JSON.stringify(decisions)}`);
  assert.deepEqual(decisions.filter(d => d.lever === 'SPENDING').map(d => [d.date, d.key, d.value]),
    [[D(2030), 'band@69', 4000], [D(2032), 'band@69', 9000]]);
  // An identity lever keeps its own key.
  assert.deepEqual(decisions.filter(d => d.lever === 'ALLOCATION_MIX').map(d => d.key),
    [allocWeightKey('EQUITY')]);
});

test('MRR-1: a lever the build no longer registers warns once and skips its rows', () => {
  const stale = [{ ...rec(2030, { band: 1, alloc: 1 }), controlKeys: ['LEVER_FROM_THE_FUTURE'] }];
  const { decisions, warnings } = decisionsFromRecords(stale, OPTS);
  assert.equal(decisions.length, 0);
  assert.match(warnings.join('\n'), /LEVER_FROM_THE_FUTURE/);
});

// ─── MRR-2 ───────────────────────────────────────────────────────────────────

test('MRR-2: `source` is provenance the picker can label', () => {
  const { entry } = buildRunEntry(LOG, { ...OPTS, runId: 'cockpit:1', solver: 'CEM/128',
                                         recordedAt: D(2026), baseScenarioId: 'die-with' });
  assert.deepEqual(entry.source.levers.sort(), ['ALLOCATION_MIX', 'SPENDING']);
  assert.equal(entry.source.epochs, 3);
  assert.equal(entry.source.first, D(2030));
  assert.equal(entry.source.last, D(2032));
  assert.equal(entry.source.baseScenarioId, 'die-with');
  assert.equal(entry.source.goal.key, 'finalNetLiquidity');
  // §8 — a raw run id is not a choice anyone can make.
  assert.equal(describeRunSource(entry.source), '2 levers · CEM/128 · 2026-01-01 · 3 epochs');
});

test('MRR-2: `derivedFrom` is a PARENT POINTER, not a graph edge (§4.3)', () => {
  // `DecisionRecordStorage.save` persists nodes WITHOUT edges, so an edge-based lineage tree
  // does not survive a page refresh. A parent pointer inside the entry travels with the export.
  const { entry } = buildRunEntry(LOG, { ...OPTS, derivedFrom: 'run:2026-09-01' });
  assert.equal(entry.source.derivedFrom, 'run:2026-09-01');
});

test('MRR-2: a log that decided nothing creates no entry, and says so', () => {
  const { entry, warnings } = buildRunEntry([], OPTS);
  assert.equal(entry, null);
  assert.match(warnings.join('\n'), /decided nothing/);
});

test('MRR-2: `makeRunKey` does not collide with an entry already in the bag', () => {
  const source = { recordedAt: D(2026) };
  assert.equal(makeRunKey(source, {}), 'run:2026-01-01');
  assert.equal(makeRunKey(source, { 'run:2026-01-01': {} }), 'run:2026-01-01#2');
});

// ─── MRR-3 ───────────────────────────────────────────────────────────────────

test('MRR-3: dedupe drops only RESTATEMENTS, and is lossless for playback', () => {
  const kept    = decisionsFromRecords(LOG, { ...OPTS, dedupeUnchanged: false }).decisions;
  const deduped = decisionsFromRecords(LOG, { ...OPTS, dedupeUnchanged: true  }).decisions;
  assert.equal(kept.length, 6);       // 3 epochs × 2 levers
  assert.equal(deduped.length, 3);    // two opening decisions + the one change

  // The claim that matters: at every instant, the two forms have the same decisions in force.
  // This is NOT the POINT collapse D2 warns about — that keeps one value for the whole run and
  // discards the time dimension. This keeps every CHANGE and discards only restatements.
  const inForce = (decisions, year) => {
    const run = resolveActiveMpcRun({ mpcActiveRun: 'r', mpcRuns: { r: { decisions } } });
    const at  = activeDecisionsAt(run, MS(year));
    return JSON.stringify([...(at?.byLever ?? new Map())].map(([l, rows]) =>
      [l, rows.map(r => [r.key, r.value])]).sort());
  };
  for (const year of [2029, 2030, 2031, 2032, 2033, 2040]) {
    assert.equal(inForce(deduped, year), inForce(kept, year), `in force at ${year}`);
  }
});

// ─── MRR-4 ───────────────────────────────────────────────────────────────────

test('MRR-4: `saveRunToScenario` writes ONE store, upserts the bag, and selects', () => {
  const { entry } = buildRunEntry(LOG, OPTS);
  const scenario = { params: [{ name: 'mpcRuns', type: 'MpcRuns', value: { 'run:old': { decisions: [] } } }] };

  const res = saveRunToScenario(scenario, { runId: 'run:new', entry });
  assert.deepEqual(res, { runId: 'run:new', created: true, selected: true });

  const by = (k) => scenario.params.find(p => (p.key ?? p.name) === k)?.value;
  // Upsert, not replace: an existing run in the bag survives.
  assert.deepEqual(Object.keys(by('mpcRuns')).sort(), ['run:new', 'run:old']);
  assert.equal(by('mpcActiveRun'), 'run:new');
  // Selecting a run whose switch is off would look like a no-op and read as a bug.
  assert.equal(by('mpcRunEnabled'), true);
  // ONE store — `cfg.parameters` is the loader's job on Rebuild, and writing both is how the
  // two stores drift.
  assert.equal('parameters' in scenario, false);
});

test('MRR-4: `--no-select` writes the entry and leaves the selection alone', () => {
  const { entry } = buildRunEntry(LOG, OPTS);
  const scenario = { params: [] };
  saveRunToScenario(scenario, { runId: 'run:new', entry, select: false });
  assert.equal(scenario.params.some(p => (p.key ?? p.name) === 'mpcActiveRun'), false);
});

// ─── MRR-5 ───────────────────────────────────────────────────────────────────

/** The gates LOG's two levers need, so D11's refusal is not what is under test here. */
const GATES = {
  spendingStrategy: ['EXPLICIT_BANDS'],
  allocationStrategy: 'OPTIMIZED', behavioralStrategies: ['TARGET_ALLOCATION'],
};

test('MRR-5: D9/F1 — promotion folds the bag AND the selection, then runs the plan', () => {
  const { entry } = buildRunEntry(LOG, OPTS);
  let sawPlan = null;
  checkRunFeasibility({
    runId: 'run:new', entry,
    baseParams: { ...GATES, mpcRuns: { 'run:old': {} }, inflationRate: 0.03 },
    simStart: new Date(D(2026)), simEnd: new Date(D(2040)),
    check: (args) => { sawPlan = args; return { feasible: true }; },
  });
  const byKey = Object.fromEntries(sawPlan.plan.entries.map(e => [e.paramKey, e.to]));
  // The whole point of reusing `checkHarvestFeasibility`: the thing checked IS the thing saved.
  assert.deepEqual(Object.keys(byKey.mpcRuns).sort(), ['run:new', 'run:old']);
  assert.equal(byKey.mpcActiveRun, 'run:new');
  assert.equal(byKey.mpcRunEnabled, true);
  assert.equal(byKey.mpcRuns['run:new'], entry);
});

test('MRR-5: UNPLAYABLE is its own verdict, and the check never runs', () => {
  // Measured on a real 44-epoch log: `assertRunIsPlayable`'s throw, raised INSIDE the
  // feasibility check, came back as `feasible: null` — "could not verify" — and both callers
  // saved anyway. A refusal is a statement about the plan; `feasible: null` is a statement
  // about the checker, and a tool that conflates them writes a scenario that cannot load.
  const { entry } = buildRunEntry(LOG, OPTS);
  let ran = false;
  const f = checkRunFeasibility({
    runId: 'run:new', entry,
    baseParams: { ...GATES, spendingStrategy: ['FIXED'] },      // EXPLICIT_BANDS switched off
    simStart: new Date(D(2026)), simEnd: new Date(D(2040)),
    check: () => { ran = true; return { feasible: true }; },
  });
  assert.equal(f.playable, false);
  assert.equal(f.feasible, null);
  assert.match(f.error, /SPENDING.*EXPLICIT_BANDS/s);
  assert.equal(ran, false, 'there is nothing to check — the plan cannot load');
});

// ─── MRR-6 / MRR-7 ───────────────────────────────────────────────────────────

const PLAYED = {
  mpcActiveRun: 'r',
  mpcRuns: { r: { decisions: [
    { date: D(2030), lever: 'SPENDING', key: 'band@60', value: 4000 },
    { date: D(2032), lever: 'SPENDING', key: 'band@60', value: 9000 },
    { date: D(2034), lever: 'SPENDING', key: 'band@60', value: 7000 },
  ] } },
};

test('MRR-6: D8 — a rollout at "now" sees rows STRICTLY before it, never its own answer', () => {
  const at2032 = truncateActiveRunAt(PLAYED, new Date(D(2032)));
  // The 2032 row is the decision THIS epoch is about to make. Including it would seed the
  // search with its own answer.
  assert.deepEqual(at2032.mpcRuns.r.decisions.map(d => d.value), [4000]);
  // A later epoch sees its own committed past, which is exactly the realized plan.
  assert.deepEqual(truncateActiveRunAt(PLAYED, new Date(D(2034))).mpcRuns.r.decisions.map(d => d.value),
    [4000, 9000]);
  // Past the last row: nothing to truncate, so the SAME object comes back.
  assert.equal(truncateActiveRunAt(PLAYED, new Date(D(2040))), PLAYED);
});

test('MRR-6: a fresh run sees nothing — the selection is cleared, not left empty', () => {
  const fresh = truncateActiveRunAt(PLAYED, new Date(D(2026)));
  // An empty `decisions` array resolves to null WITH a warning, and a warning on every rollout
  // of every fresh run is noise nobody can act on.
  assert.equal(fresh.mpcActiveRun, null);
  assert.equal(resolveActiveMpcRun(fresh), null);
});

test('MRR-6: truncation is NON-DESTRUCTIVE — "now" moves forward and rows must survive', () => {
  truncateActiveRunAt(PLAYED, new Date(D(2031)));
  assert.equal(PLAYED.mpcRuns.r.decisions.length, 3,
    'truncating in place would delete rows a later epoch is entitled to see');
});

test('MRR-7: the controller compiles TRUNCATED params on every rollout seam (D8)', () => {
  const c = new CockpitController({
    simStart: new Date(D(2026)), simEnd: new Date(D(2040)),
    baseParams: PLAYED, control: COCKPIT_CONTROLS.SPENDING,
  });
  // No snapshot ⇒ no "now" to truncate against, so the params pass through untouched. Every
  // seam that uses them (`advise` / `apply` / `advance`) throws without a snapshot anyway.
  assert.equal(c._rolloutParams(), c.committed);

  c.setSnapshot({ date: D(2033), state: {}, queue: [] });
  const p = c._rolloutParams();
  assert.deepEqual(p.mpcRuns.r.decisions.map(d => d.value), [4000, 9000]);
  // `committed` itself is untouched, so the next epoch still sees the whole run.
  assert.equal(c.committed.mpcRuns.r.decisions.length, 3);
});

// ─── MRR-8 ───────────────────────────────────────────────────────────────────

test('MRR-8: D11 second half — the params a run pins, by lever shape', () => {
  const params = { mpcActiveRun: 'r', mpcRuns: { r: { decisions: [
    { date: D(2030), lever: 'SPENDING',       key: 'band@60', value: 4000 },
    { date: D(2030), lever: 'ALLOCATION_MIX', key: allocWeightKey('EQUITY'), value: 0.5 },
  ] } } };
  // A lever that addresses a TABLE by anchor pins the whole table, because the axis a study
  // would sweep is `spendingExpenseBands[3].monthlyAmount` — an index the run never stores.
  // A lever whose decision key IS a param key pins exactly that key.
  assert.deepEqual([...pinnedParamsOf(params)].sort(),
    [allocWeightKey('EQUITY'), 'spendingExpenseBands']);
});

test('MRR-8: a pinned axis reports and never repairs; `mpcActiveRun` is never flagged', () => {
  const params = { mpcActiveRun: 'r', mpcRuns: { r: { decisions: [
    { date: D(2030), lever: 'ALLOCATION_MIX', key: allocWeightKey('EQUITY'), value: 0.5 },
    { date: D(2030), lever: 'SPENDING',       key: 'band@60', value: 4000 },
  ] } } };
  const problems = runAxisProblems(params, [
    allocWeightKey('EQUITY'),
    'spendingExpenseBands[3].monthlyAmount',
    'bondLadderRungs',
    'mpcActiveRun',                       // §4.2 — the axis this design EXISTS to enable
  ]);
  assert.deepEqual(problems.map(p => p.param),
    [allocWeightKey('EQUITY'), 'spendingExpenseBands[3].monthlyAmount']);
  assert.equal(problems[0].severity, 'warn');   // must never stop a Rebuild or a launch
  assert.equal(problems[0].kind, RUN_AXIS_PROBLEM_KIND.PINNED);
  assert.match(problems[0].message, /re-stamps/);

  // No run selected ⇒ nothing to say, on any axis.
  assert.deepEqual(runAxisProblems({ mpcRuns: params.mpcRuns }, [allocWeightKey('EQUITY')]), []);
  assert.deepEqual(runAxisProblems({ ...params, mpcRunEnabled: false }, [allocWeightKey('EQUITY')]), []);
});
