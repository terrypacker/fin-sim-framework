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
 * mpc-run-absent.test.mjs
 *
 * DESIGN 81 phase 1, end to end — the registration gate and the equivalence it buys.
 *
 * MRA-1  D4 — no selection ⇒ no reducer. Including a BAG WITH ENTRIES and nothing selected,
 *        which is the case that makes the bag safe to accumulate.
 * MRA-2  D4 — absent is absent: a scenario carrying an unselected bag runs byte-identically
 *        to one that has never heard of design 81.
 * MRA-3  A selection registers the reducer, and `mpcRunEnabled: false` un-registers it
 *        without forgetting the selection.
 * MRA-4  **The headline.** A recorded SPENDING decision, played from t₀, reproduces the
 *        from-scratch run whose band table is date-keyed the same way — state for state.
 *        This is the `B ≡ A′` property with the bake permanently removed as a suspect.
 * MRA-5  The run drives the ENGINE, not just a state field: the realized expenses change.
 *
 * Primary is born 1978-04-15, so age 48 in 2026 and 55 on 2033-04-15 — a decision recorded
 * there is live at the 2034-01-01 advance, which is also the first advance at which
 * `bandForAge` reaches a startAge-55 band. That is what makes MRA-4 an exact comparison
 * rather than an approximate one.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { loadScenarioSim } from '../helpers/scenario-harness.js';

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2038, 0, 1));

const BASE_BANDS = [{ startAge: 48, monthlyAmount: 4000 }];
const FULL_BANDS = [{ startAge: 48, monthlyAmount: 4000 }, { startAge: 55, monthlyAmount: 9000 }];

/** The run: one SPENDING decision, recorded on the person's 55th birthday. */
const RUN = {
  'run:a': {
    source: { recordedAt: '2026-09-19', goal: 'test', levers: ['SPENDING'], epochs: 1 },
    decisions: [{ date: '2033-04-15T00:00:00.000Z', lever: 'SPENDING', key: 'band@55', value: 9000 }],
  },
};

const BASE = { spendingStrategy: ['EXPLICIT_BANDS'], spendingExpenseBands: BASE_BANDS };

function run(params, { stepTo = SIM_END } = {}) {
  return loadScenarioSim({ params: { ...BASE, ...params }, simStart: SIM_START, simEnd: SIM_END, stepTo });
}

const hasSwitch = services => (services.reducerService?.getAll?.() ?? [])
  .some(r => r?.constructor?.type === 'MpcDecisionScheduleReducer');

/**
 * The comparable state — everything but the two fields the switch itself writes. Those are
 * the marker (§5) and the band table; the claim under test is that everything DOWNSTREAM of
 * them is identical, which is a stronger statement than "the metrics match".
 */
function comparableState(sim) {
  const { mpcSpendingBands, mpcDecisionApplied, ...rest } = sim.state;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

// ─── MRA-1 / MRA-2 / MRA-3 ───────────────────────────────────────────────────

test('MRA-1: no active run ⇒ MpcDecisionScheduleReducer is not registered (D4)', () => {
  assert.equal(hasSwitch(run({}, { stepTo: null }).services), false);
});

test('MRA-1: a bag with entries and NOTHING selected ⇒ still not registered — the gate is the selection', () => {
  const { services } = run({ mpcRuns: RUN, mpcActiveRun: null }, { stepTo: null });
  assert.equal(hasSwitch(services), false);
});

test('MRA-2: absent is absent — an unselected bag changes no state at all', () => {
  const plain  = run({});
  const carried = run({ mpcRuns: RUN, mpcActiveRun: null });
  assert.equal(comparableState(carried.sim), comparableState(plain.sim));
  assert.equal('mpcSpendingBands'  in carried.sim.state, false);
  assert.equal('mpcDecisionApplied' in carried.sim.state, false);
});

test('MRA-3: a selection registers the switch; the OFF switch un-registers it, selection kept', () => {
  const on  = run({ mpcRuns: RUN, mpcActiveRun: 'run:a' }, { stepTo: null });
  assert.equal(hasSwitch(on.services), true);

  const off = run({ mpcRuns: RUN, mpcActiveRun: 'run:a', mpcRunEnabled: false });
  assert.equal(hasSwitch(off.services), false);
  assert.equal(comparableState(off.sim), comparableState(run({}).sim));
});

// ─── MRA-4 — the headline ────────────────────────────────────────────────────

test('MRA-4: a played run ≡ the from-scratch date-keyed plan, state for state', () => {
  // Ground truth: one run whose band table already says "9,000/mo from age 55".
  const reference = run({ spendingExpenseBands: FULL_BANDS });
  // Under test: the BASE table, plus the recorded decision that produces it.
  const played    = run({ mpcRuns: RUN, mpcActiveRun: 'run:a' });

  assert.equal(comparableState(played.sim), comparableState(reference.sim));

  // And the mechanism is visible rather than implicit: the marker names when it bit.
  assert.equal(played.sim.state.mpcDecisionApplied.runId, 'run:a');
  assert.deepEqual(played.sim.state.mpcDecisionApplied.levers, ['SPENDING']);
  assert.deepEqual(played.sim.state.mpcSpendingBands, FULL_BANDS);
});

// ─── MRA-5 ───────────────────────────────────────────────────────────────────

test('MRA-5: the run drives the engine — realized spending differs from the base plan', () => {
  const base   = run({});
  const played = run({ mpcRuns: RUN, mpcActiveRun: 'run:a' });
  // If this were equal, MRA-4 would be passing for the uninteresting reason that the
  // decision never reached `ExplicitBandsSpendingReducer` at all.
  assert.notEqual(played.sim.state.monthlyExpenses, base.sim.state.monthlyExpenses);
  assert.ok(played.sim.state.monthlyExpenses > base.sim.state.monthlyExpenses);
});
