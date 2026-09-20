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
 * mpc-run-levers.test.mjs
 *
 * DESIGN 81 phase 2 — the six levers beyond SPENDING: the four drawdown levers (2a) and
 * the two reducer-resident ones (2b). Phase 1's selectors, reducer arithmetic and SPENDING
 * hooks are in `mpc-run-schedule.test.mjs`; the end-to-end absent/present gates are in
 * `mpc-run-absent.test.mjs`.
 *
 * MRL-1  The categorical levers stamp their one state field — and REFUSE an illegal mode
 * MRL-2  DRAWDOWN_SLEEVE rebuilds the weight map from the authored base and stamps WEIGHTED
 * MRL-3  DRAWDOWN_WEIGHTS re-stamps per-account `drawdownPriority`, with owner banding
 * MRL-4  **D7** — `actuate` and `applyAt` produce the SAME priorities, because they are one
 *        function. This is the test the consolidation exists for.
 * MRL-5  ALLOCATION_MIX synthesizes the mix the cockpit's own `describe`/`actuate` synthesize
 * MRL-6  The two reducer accessors read state-or-self, so absent ⇒ today's behaviour
 * MRL-7  One period, many levers: the reducer stamps them all and names them all
 * MRL-8  The import-cycle guard — the leaf rule `lever-schedule.js` lives under (§16.5)
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  LEVER_SCHEDULE, drawdownPriorityPatch, presentRolesFromState,
} from '../../src/finance/mpc/lever-schedule.js';
import { MpcDecisionScheduleReducer } from '../../src/finance/mpc/mpc-decision-schedule-reducer.js';
import { resolveActiveMpcRun }        from '../../src/finance/mpc/run-schedule.js';
import { COCKPIT_CONTROLS }           from '../../src/finance/mpc/cockpit-controller.js';
import {
  DRAWDOWN_WEIGHT_ROLES, drawdownWeightKey, allocWeightKey, synthesizeTargetAllocation,
} from '../../src/scenarios/params/lever-weights.js';
import { DRAWDOWN_SLEEVE_CLASSES, sleeveWeightKey } from '../../src/finance/holdings/holdings-selection.js';
import { ACCOUNT_ROLES }            from '../../src/finance/state/account-roles.js';
import { RebalanceToTargetReducer } from '../../src/finance/behavioral/rebalance-to-target-reducer.js';
import { BondLadderReducer }        from '../../src/finance/behavioral/bond-ladder-reducer.js';

const row = (key, value) => ({ key, value });

// ─── MRL-1 ───────────────────────────────────────────────────────────────────

test('MRL-1: DRAWDOWN_XBORDER / DRAWDOWN_WITHINTIER stamp the one field `actuate` writes', () => {
  assert.deepEqual(
    LEVER_SCHEDULE.DRAWDOWN_XBORDER.applyAt({ rows: [row('crossBorderDrawdown', 'GLOBAL')] }),
    { crossBorderDrawdown: 'GLOBAL' });
  assert.deepEqual(
    LEVER_SCHEDULE.DRAWDOWN_WITHINTIER.applyAt({ rows: [row('withinTierDraw', 'PROPORTIONAL')] }),
    { withinTierDraw: 'PROPORTIONAL' });
});

test('MRL-1: an illegal mode stamps NOTHING rather than writing a value nobody chose', () => {
  // A recorded run is data on disk and can be hand-edited. `replenishSavings` reads these
  // fields with a default branch, so a typo'd mode would not fail — it would quietly play
  // back a different plan, which is the one failure design 81 exists to make impossible.
  assert.equal(LEVER_SCHEDULE.DRAWDOWN_XBORDER.applyAt({ rows: [row('crossBorderDrawdown', 'GLOBAI')] }), null);
  assert.equal(LEVER_SCHEDULE.DRAWDOWN_WITHINTIER.applyAt({ rows: [row('withinTierDraw', 'PRO_RATA')] }), null);
  assert.equal(LEVER_SCHEDULE.DRAWDOWN_XBORDER.applyAt({ rows: [] }), null);
});

// ─── MRL-2 ───────────────────────────────────────────────────────────────────

const SLEEVE_BASE = Object.fromEntries(
  DRAWDOWN_SLEEVE_CLASSES.map((cls, i) => [sleeveWeightKey(cls), 0.1 * (i + 1)]));

test('MRL-2: DRAWDOWN_SLEEVE rebuilds from the authored base and stamps the WEIGHTED mode', () => {
  const [first, second] = DRAWDOWN_SLEEVE_CLASSES;
  const patch = LEVER_SCHEDULE.DRAWDOWN_SLEEVE.applyAt({
    rows: [row(sleeveWeightKey(second), 0.99)], baseParams: SLEEVE_BASE,
  });
  // Weights the run never decided come from the BASE, not from whatever state held.
  assert.equal(patch.drawdownSleeveWeights[first], SLEEVE_BASE[sleeveWeightKey(first)]);
  assert.equal(patch.drawdownSleeveWeights[second], 0.99);
  // Weights the selector never consults are not a decision — the mode is stamped with them,
  // so the recorded run is self-contained rather than dependent on the base still saying
  // WEIGHTED (the §16.3 staleness failure mode, avoided here for free).
  assert.equal(patch.drawdownSleeveOrder, 'WEIGHTED');
});

test('MRL-2: the rebuild is idempotent and order-independent — a pure function of (base, rows)', () => {
  const rows = [row(sleeveWeightKey(DRAWDOWN_SLEEVE_CLASSES[1]), 0.99),
                row(sleeveWeightKey(DRAWDOWN_SLEEVE_CLASSES[0]), 0.02)];
  const a = LEVER_SCHEDULE.DRAWDOWN_SLEEVE.applyAt({ rows, baseParams: SLEEVE_BASE });
  const b = LEVER_SCHEDULE.DRAWDOWN_SLEEVE.applyAt({ rows: [...rows].reverse(), baseParams: SLEEVE_BASE });
  assert.deepEqual(a, b);
  assert.equal(LEVER_SCHEDULE.DRAWDOWN_SLEEVE.applyAt({ rows: [row('nope', 1)], baseParams: SLEEVE_BASE }), null);
});

// ─── MRL-3 / MRL-4 ───────────────────────────────────────────────────────────

const ACCOUNTS = () => ({
  rothAccount: { role: ACCOUNT_ROLES.ROTH,         ownerId: 'primary', drawdownPriority: 99, balance: 1 },
  fiAccount:   { role: ACCOUNT_ROLES.FIXED_INCOME, ownerId: 'primary', drawdownPriority: 99, balance: 1 },
  spouseRoth:  { role: ACCOUNT_ROLES.ROTH,         ownerId: 'spouse',  drawdownPriority: 99, balance: 1 },
  notAnAccount: { some: 'object' },
});

/** Roth drawn first, fixed income last — the order both paths must reproduce. */
const ROTH_FIRST_ROWS = [
  row(drawdownWeightKey(ACCOUNT_ROLES.ROTH), 0.01),
  row(drawdownWeightKey(ACCOUNT_ROLES.FIXED_INCOME), 0.99),
];

test('MRL-3: DRAWDOWN_WEIGHTS re-stamps per-account priority, with owner banding', () => {
  const state = ACCOUNTS();
  const patch = LEVER_SCHEDULE.DRAWDOWN_WEIGHTS.applyAt({
    state, rows: ROTH_FIRST_ROWS, baseParams: { drawdownOwnerOrdering: 'PRIMARY_FIRST' },
  });
  assert.ok(patch.rothAccount.drawdownPriority < patch.fiAccount.drawdownPriority);
  assert.equal(patch.spouseRoth.drawdownPriority, patch.rothAccount.drawdownPriority + 100);
  // Entries that are not accounts are untouched — the patch is a map of ACCOUNT keys, which
  // is what makes it a legal shallow-merge reducer patch.
  assert.equal('notAnAccount' in patch, false);
});

test('MRL-3: POOLED drops the owner stride; SPOUSE_FIRST reverses it', () => {
  const state = ACCOUNTS();
  const pooled = LEVER_SCHEDULE.DRAWDOWN_WEIGHTS.applyAt({
    state, rows: ROTH_FIRST_ROWS, baseParams: { drawdownOwnerOrdering: 'POOLED' } });
  assert.equal(pooled.spouseRoth.drawdownPriority, pooled.rothAccount.drawdownPriority);

  const spouseFirst = LEVER_SCHEDULE.DRAWDOWN_WEIGHTS.applyAt({
    state, rows: ROTH_FIRST_ROWS, baseParams: { drawdownOwnerOrdering: 'SPOUSE_FIRST' } });
  assert.equal(spouseFirst.rothAccount.drawdownPriority,
               spouseFirst.spouseRoth.drawdownPriority + 100);
});

test('MRL-3: accounts whose priority is already right are left OUT of the patch', () => {
  const state = ACCOUNTS();
  const first = LEVER_SCHEDULE.DRAWDOWN_WEIGHTS.applyAt({
    state, rows: ROTH_FIRST_ROWS, baseParams: {} });
  const settled = { ...state, ...first };
  // Re-deciding the same thing changes nothing, so a re-entered period emits no journal diff.
  assert.equal(LEVER_SCHEDULE.DRAWDOWN_WEIGHTS.applyAt({
    state: settled, rows: ROTH_FIRST_ROWS, baseParams: {} }), null);
});

test('MRL-3: rows that name no weight key ⇒ null (the base alone is not a decision)', () => {
  assert.equal(LEVER_SCHEDULE.DRAWDOWN_WEIGHTS.applyAt({
    state: ACCOUNTS(), rows: [row('crossBorderDrawdown', 'GLOBAL')], baseParams: {} }), null);
});

test('MRL-4: D7 — `actuate` and `applyAt` produce IDENTICAL priorities (one cascade, two callers)', () => {
  // The whole point of pulling D7 forward (§16.2): the online commit and the recorded
  // playback of that same commit must agree, or an A/B between them measures the copy.
  const DW = COCKPIT_CONTROLS.DRAWDOWN_WEIGHTS;
  const vars = DW.buildVariables({ state: ACCOUNTS() });
  const candidate = Object.fromEntries(DRAWDOWN_WEIGHT_ROLES.map(r => [drawdownWeightKey(r), 0.5]));
  candidate[drawdownWeightKey(ACCOUNT_ROLES.ROTH)]         = 0.01;
  candidate[drawdownWeightKey(ACCOUNT_ROLES.FIXED_INCOME)] = 0.99;

  const sim = { state: ACCOUNTS() };
  DW.actuate({
    services: { simulationRegistry: { getPrimary: () => sim } },
    scenario: { params: [{ name: 'drawdownOwnerOrdering', value: 'PRIMARY_FIRST' }] },
    candidate, vars,
  });

  // The replay sees the same decision as `rows` — one row per searched variable, which is
  // exactly what the phase-4a recorder will write.
  const rows = vars.map(v => row(v.paramKey, candidate[v.paramKey]));
  const replayed = { ...ACCOUNTS(), ...LEVER_SCHEDULE.DRAWDOWN_WEIGHTS.applyAt({
    state: ACCOUNTS(), rows, baseParams: { drawdownOwnerOrdering: 'PRIMARY_FIRST' } }) };

  for (const k of ['rothAccount', 'fiAccount', 'spouseRoth']) {
    assert.equal(replayed[k].drawdownPriority, sim.state[k].drawdownPriority, k);
  }
});

test('MRL-4: `presentRolesFromState` is the shared design-58 build-time filter', () => {
  // It moved out of `cockpit-controller.js` so the online prune and the replay prune are one
  // rule (§16.2). A role no account backs must not appear in either.
  const roles = presentRolesFromState(ACCOUNTS());
  assert.deepEqual([...roles].sort(), [ACCOUNT_ROLES.FIXED_INCOME, ACCOUNT_ROLES.ROTH].sort());
  assert.equal(drawdownPriorityPatch({ state: {}, candidate: {}, baseParams: {} }), null);
});

// ─── MRL-5 ───────────────────────────────────────────────────────────────────

test('MRL-5: ALLOCATION_MIX stamps the mix the cockpit itself synthesizes from those weights', () => {
  const AM = COCKPIT_CONTROLS.ALLOCATION_MIX;
  const vars = AM.buildVariables({});
  const candidate = Object.fromEntries(vars.map((v, i) => [v.paramKey, 0.5 - i * 0.1]));
  const rows = vars.map(v => row(v.paramKey, candidate[v.paramKey]));

  const patch = LEVER_SCHEDULE.ALLOCATION_MIX.applyAt({ rows, baseParams: {} });
  // The reference: the set `describe`/`actuate` pass — the classes the VARIABLES name.
  const expected = synthesizeTargetAllocation(candidate, new Set(vars.map(v => v._class)));
  assert.deepEqual(patch.mpcTargetAllocation, expected);
  // Stick-breaking over the narrowed set: the LAST searched class is the residual, so the
  // mix is whole across the classes the run actually searched.
  assert.equal(
    +Object.values(patch.mpcTargetAllocation).reduce((s, x) => s + x, 0).toFixed(6), 1);
});

test('MRL-5: rows carrying no allocation weight ⇒ null', () => {
  assert.equal(LEVER_SCHEDULE.ALLOCATION_MIX.applyAt({ rows: [row('bondLadderRungs', 4)], baseParams: {} }), null);
  assert.equal(LEVER_SCHEDULE.ALLOCATION_MIX.applyAt({ rows: [], baseParams: {} }), null);
});

test('MRL-5: BOND_LADDER carries the rung count and rounds, leaving the clamp in the reducer', () => {
  assert.deepEqual(LEVER_SCHEDULE.BOND_LADDER.applyAt({ rows: [row('bondLadderRungs', 7)] }),
    { mpcBondLadderRungs: 7 });
  assert.deepEqual(LEVER_SCHEDULE.BOND_LADDER.applyAt({ rows: [row('bondLadderRungs', '9.4')] }),
    { mpcBondLadderRungs: 9 });
  assert.equal(LEVER_SCHEDULE.BOND_LADDER.applyAt({ rows: [row('bondLadderRungs', null)] }), null);
});

// ─── MRL-6 ───────────────────────────────────────────────────────────────────

test('MRL-6: `_targetAllocationOf` reads state-or-self — absent ⇒ exactly today’s target', () => {
  const target = { EQUITY: 0.6, BOND: 0.4 };
  const r = new RebalanceToTargetReducer({ accounts: [], targetAllocation: target });
  assert.deepEqual(r._targetAllocationOf({}), target);
  assert.deepEqual(r._targetAllocationOf(undefined), target);
  const played = { EQUITY: 0.3, BOND: 0.3, CASH: 0.4 };
  assert.deepEqual(r._targetAllocationOf({ mpcTargetAllocation: played }), played);
});

test('MRL-6: a committed mix is the schedule ANCHOR under GLIDEPATH, not the target (§16.1)', () => {
  // Inherited behaviour, asserted so it cannot change by accident: `ALLOCATION_MIX.actuate`
  // has only ever written `targetAllocation`, which `interpolateGlidepath` treats as the
  // fallback. The replay reproduces that, deliberately. Whether the lever SHOULD be gated on
  // `scheduleMode === NONE` is a design 39 question.
  const r = new RebalanceToTargetReducer({
    accounts: [], targetAllocation: { EQUITY: 0.6, BOND: 0.4 },
    scheduleMode: 'GLIDEPATH', glidepath: [{ age: 50, weights: { EQUITY: 0.9, BOND: 0.1 } }],
  });
  const state = {
    mpcTargetAllocation: { EQUITY: 0.1, BOND: 0.9 },
    people: { p: { birthDate: '1975-01-01' } },
    currentPeriods: { US: { startMs: Date.UTC(2035, 0, 1) } },
  };
  const mix = r._scheduledMix(state, { type: 'US_PERIOD_ADVANCE' }, 0);
  // Age 60 is past the only anchor, so the glidepath clamps to it and governs — the
  // committed 10/90 does NOT appear.
  assert.equal(mix.EQUITY, 0.9);
});

test('MRL-6: `_targetRungsOf` reads state-or-self', () => {
  const r = new BondLadderReducer({ stateKey: 'acct', targetRungs: 5 });
  assert.equal(r._targetRungsOf({}), 5);
  assert.equal(r._targetRungsOf({ mpcBondLadderRungs: 9 }), 9);
});

// ─── MRL-7 ───────────────────────────────────────────────────────────────────

test('MRL-7: one crossed date, many levers — every patch lands and every lever is named', () => {
  const date = new Date(Date.UTC(2030, 0, 1)).toISOString();
  const run = resolveActiveMpcRun({
    mpcActiveRun: 'r',
    mpcRuns: { r: { decisions: [
      { date, lever: 'DRAWDOWN_XBORDER',    key: 'crossBorderDrawdown', value: 'GLOBAL' },
      { date, lever: 'DRAWDOWN_WITHINTIER', key: 'withinTierDraw',      value: 'EQUAL' },
      { date, lever: 'BOND_LADDER',         key: 'bondLadderRungs',     value: 8 },
      { date, lever: 'ALLOCATION_MIX',      key: allocWeightKey('EQUITY'), value: 0.4 },
      { date, lever: 'DRAWDOWN_WEIGHTS',    key: drawdownWeightKey(ACCOUNT_ROLES.ROTH), value: 0.01 },
    ] } },
  });
  const reducer = new MpcDecisionScheduleReducer({ run, baseParams: {} });
  const out = reducer.reduce(ACCOUNTS(), { type: 'US_PERIOD_ADVANCE', date: new Date(Date.UTC(2031, 0, 1)) }, null);

  assert.equal(out.crossBorderDrawdown, 'GLOBAL');
  assert.equal(out.withinTierDraw, 'EQUAL');
  assert.equal(out.mpcBondLadderRungs, 8);
  assert.ok(out.mpcTargetAllocation.EQUITY > 0);
  assert.notEqual(out.rothAccount.drawdownPriority, 99);
  assert.deepEqual([...out.mpcDecisionApplied.levers].sort(),
    ['ALLOCATION_MIX', 'BOND_LADDER', 'DRAWDOWN_WEIGHTS', 'DRAWDOWN_WITHINTIER', 'DRAWDOWN_XBORDER']);
});

// ─── MRL-8 ───────────────────────────────────────────────────────────────────

test('MRL-8: the import-cycle guard — every entry point phase 2 broke still loads (§16.5)', async () => {
  // `us-retirement-toolset.js` imports `MpcDecisionScheduleReducer`, which imports
  // `lever-schedule.js`. An import added to `lever-schedule.js` that reaches a toolset or
  // `intl-retirement-scenario.js` closes that loop, and it does NOT degrade gracefully:
  // phase 2 measured each of these dying with `Cannot access 'X' before initialization`.
  // The fix was to move the weight constants DOWN into `scenarios/params/lever-weights.js`,
  // a leaf. This test is what stops the next hook re-closing the loop.
  for (const m of [
    '../../src/scenarios/params/lever-weights.js',
    '../../src/finance/mpc/lever-schedule.js',
    '../../src/finance/mpc/mpc-decision-schedule-reducer.js',
    '../../src/finance/mpc/cockpit-controller.js',
    '../../src/scenarios/toolsets/us-retirement-toolset.js',
    '../../src/scenarios/intl-retirement-scenario.js',
    '../../src/scenarios/scenario-loader.js',
  ]) {
    await assert.doesNotReject(() => import(m), `${m} failed to import — an import cycle is back`);
  }
});
