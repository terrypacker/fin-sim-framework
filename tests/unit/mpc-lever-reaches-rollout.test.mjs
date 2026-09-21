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
 * mpc-lever-reaches-rollout.test.mjs
 *
 * DESIGN 39 §14.9.5 — does an MPC rollout START from the plan the candidate describes?
 *
 * `lever-reaches-loaded-sim` (LRS-2) asks whether a lever moves a COMPILED sim. Every lever here
 * passes that and some of them still cannot steer the controller, because a rollout does not
 * compile from t₀: it compiles, then `OptimizationProblem._injectSnapshot` replaces `sim.state`
 * and `sim.queue` with a snapshot's. Anything the compile DERIVED from the candidate and wrote
 * into state or the queue is discarded, and the rollout prices the old plan.
 *
 * ─── why this is STRUCTURAL and not a comparison of terminals ────────────────────
 *
 * §14.9.5 first proposed the invariant `compileDelta === snapshotDelta` on terminal wealth. That
 * is wrong, and writing this test is what showed it: a compile applies an undated policy from t₀,
 * so its delta legitimately includes the realized past, while a rollout can only apply it forward.
 * On the SPENDING control the two differed by nearly 2× for that reason alone, with nothing broken.
 *
 * The honest question has no economics in it: **is the fact the candidate changes present in the
 * sim the rollout is about to step?** So each case names a PROBE — a slice of state, or the queue
 * filtered to one event type — and the test compares the probe on a compiled sim against the same
 * probe on a snapshot-seeded sim. Both come from the same params, so equality is the whole
 * invariant, and it is exact rather than economic.
 *
 * That also catches the failures a numeric check cannot:
 *
 *   **HALF-LIVE** — a pool size target reaches the rebalancer, whose `poolGraph` is captured in
 *   its constructor at compile and therefore survives injection, while `state.liquidityGraph` and
 *   `state.drawdownSequence` stay stale. The rollout moves by ~76% of the real effect: a moving
 *   fan of plausible numbers, wrong by a quarter. A "does it move at all" check passes it.
 *   **AMOUNT-ONLY** — `_seededSim` carries forward-effective shims for the two queue levers
 *   (`retargetRothConversionEvents`, `retargetEarlyWithdrawalEvents`) which rewrite the AMOUNTS on
 *   queued events. They cannot add or remove events, so a decision that changes which events
 *   EXIST is lost while one that changes a number is honoured — from the same lever. Both halves
 *   are asserted: ROTH_AMOUNT reaches, ROTH_EVENT_SET is lost.
 *
 * ─── the known-broken list ───────────────────────────────────────────────────────
 *
 * Three probes fail today. `KNOWN_BROKEN` names them and the test asserts they are STILL failing,
 * so the suite stays green while the boundary (§14.9.4) is unfixed and the list self-destructs:
 * fix one and this test fails telling you to strike it, rather than quietly passing.
 *
 * MLR-1  the candidate is a REAL lever — it changes the probe on a compiled sim
 * MLR-2  the probe survives into a snapshot-seeded rollout
 * MLR-2b SPENDING, the control — live in a rollout precisely because it is NOT a derived artifact
 * MLR-3  the known-broken probes are still lost, and the list has no stale entries
 * MLR-4  **seeding a rollout must not MUTATE the snapshot** — the aliasing defect §14.9.4 found
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { OptimizationProblem }     from '../../src/finance/optimization/optimization-problem.js';
import { OPTIMIZATION_OBJECTIVES } from '../../src/finance/optimization/optimization-objectives.js';

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2060, 0, 1));
/** Retirement-side, so the drawdown machinery is running where the snapshot is taken. */
const AS_OF     = new Date(Date.UTC(2045, 0, 1));
const OBJECTIVE = OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH;

/**
 * A pool graph over accounts `buildDefaultConfig` actually has, shaped like a real one: a cash
 * pool, a sized bond buffer, an equity growth pool, wrappers last. A sized target claims a single
 * class, which design 97 §12.2 requires.
 */
const GRAPH = {
  pools: [
    { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'buffer', spendOrder: 20, target: { mode: 'YEARS_OF_SPEND', value: 5 },
      claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    { id: 'wrappers', spendOrder: 60,
      claims: [{ key: 'iraAccount' }, { key: 'k401Account' }, { key: 'superAccount' }] },
  ],
};

const BASE = {
  spendingStrategy:     ['EXPLICIT_BANDS'],
  spendingExpenseBands: [{ startAge: 45, monthlyAmount: 9000 }],
  // The conversion window is PINNED. Left to its defaults it is derived from a birth date and an
  // RMD age, and then "which years have an event" depends on the base rather than on the case —
  // which makes the amount-vs-event-set split below unfalsifiable.
  rothConversionEnabled:  true,
  rothConversionStartYear: 2046, rothConversionEndYear: 2055,
  earlyWithdrawalEnabled: true,
  earlyWithdrawalStartYear: 2046, earlyWithdrawalEndYear: 2055,
  behavioralStrategies: ['TARGET_ALLOCATION', 'LIQUIDITY_POOLS'],
  liquidityGraph: GRAPH,
};

/** The same graph with one pool's field changed and everything else held. */
function graphWith(poolId, mutate) {
  const g = structuredClone(GRAPH);
  mutate(g.pools.find(p => p.id === poolId));
  return g;
}

/**
 * Every queued event of `type` still AHEAD of the snapshot, reduced to what a decision about it
 * would change.
 *
 * Future-only, and that is not a convenience: a snapshot rolled to `AS_OF` has already consumed
 * and popped everything before it, so a t₀ compile legitimately holds years the rollout does not.
 * Comparing the whole queue would fail on history rather than on the defect.
 */
const queueProbe = (type) => (sim) => sim.cloneQueue()
  .filter(e => e.type === type && e.date > AS_OF)
  .map(e => ({ date: e.date.toISOString().slice(0, 10), data: e.data }))
  .sort((a, b) => a.date.localeCompare(b.date) || JSON.stringify(a.data).localeCompare(JSON.stringify(b.data)));

const CASES = [
  {
    lever: 'ROTH_AMOUNT', expect: 'reaches',
    // The half of the ROTH lever the shim CAN express: a number on an event that exists. Held back
    // until §14.9.7's "missing sibling" was explained — it was the helpers compiling two different
    // plans (see `seededFrom`), and with that fixed the decided year matches event-for-event.
    params: { rothConversionSchedule: [{ year: 2050, incomeTarget: 250_000 }] },
    probe: (sim) => queueProbe('ROTH_CONVERSION_POLICY_EVALUATE')(sim)
      .filter(e => e.date.startsWith('2050'))
      .map(e => [e.data.iraKey, Math.round(e.data.targetIncome)]),
    probeName: 'the queued 2050 ROTH conversion target, per owner',
  },
  {
    lever: 'ROTH_EVENT_SET', expect: 'lost',
    // The same lever, deciding something the shim cannot express. `schedules()` returns early on
    // a non-empty schedule, so this row does not just retarget 2050 — it CANCELS the window
    // form's conversions for every other year. The shim rewrites amounts on events that exist and
    // can neither add nor remove one, so the rollout keeps every cancelled year.
    params: { rothConversionSchedule: [{ year: 2050, incomeTarget: 250_000 }] },
    probe: (sim) => queueProbe('ROTH_CONVERSION_POLICY_EVALUATE')(sim).map(e => e.date),
    probeName: 'WHICH years have a queued ROTH conversion',
  },
  {
    lever: 'EARLY_WITHDRAWAL_AMOUNT', expect: 'reaches',
    params: { earlyWithdrawalSchedule: [{ year: 2050, taxDeferredAmount: 150_000, rothAmount: 0 }] },
    probe: (sim) => queueProbe('SCHEDULED_EARLY_WITHDRAWAL')(sim)
      .filter(e => e.date.startsWith('2050'))
      .map(e => Math.round(e.data.taxDeferredAmount)),
    probeName: 'the queued 2050 early-withdrawal amount',
  },
  {
    lever: 'POOL_TARGET', expect: 'lost',
    // design 110 leg C's `pool.<id>.targetScale`, as the target it resolves to.
    params: { liquidityGraph: graphWith('buffer', p => { p.target.value = 1; }) },
    probe: (sim) => sim.state?.liquidityGraph?.pools?.map(p => [p.id, p.target?.value ?? null]),
    probeName: 'state.liquidityGraph\'s pool targets',
  },
  {
    lever: 'POOL_SPEND_ORDER', expect: 'lost',
    params: { liquidityGraph: graphWith('wrappers', p => { p.spendOrder = 5; }) },
    probe: (sim) => sim.state?.drawdownSequence?.map(e => e.key),
    probeName: 'state.drawdownSequence, the compiled spend order',
  },
];

/** The probes §14.9.4 measured as lost. Strike an entry when you fix it. */
const KNOWN_BROKEN = new Set(['ROTH_EVENT_SET', 'POOL_TARGET', 'POOL_SPEND_ORDER']);

const quiet = (fn) => {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; }
};

const problem = (params, initialState) => new OptimizationProblem({
  variables: [], baseParams: params, objective: OBJECTIVE,
  simStart: SIM_START, simEnd: SIM_END, initialState,
});

/**
 * The sim a rollout is about to step, seeded both ways from the SAME params.
 *
 * `_seededSim` is reached directly, and deliberately: it is the seam under test. Going through
 * `evaluate()` would answer with a terminal, which is the economic question this file exists to
 * stop asking (see the header), and `rollToSnapshot` would step past the thing being inspected.
 */
//
// Both helpers hand `_seededSim` the RESOLVED base, never the raw `params` — the params every
// production caller (`evaluate`, `rollToSnapshot`, `rolloutSeries`) compiles. The template's own
// values reach a compile ONLY through `_resolveBase()`: the default template is a flat
// `cfg.parameters` bag and `serializeScenario` keeps only the `cfg.params` list, so `_compile`
// sees none of them and the toolset schema defaults fill in instead. Passing raw `params` here
// once compiled `rothConversionOwner: 'both'` (schema) against a snapshot rolled with
// `'primary'` (template) — two conversions a year against one, read as a snapshot "missing" an
// event (design 39 §14.9.7). It was two plans, not a queue defect.
const seededFrom = (p) => p._seededSim({ ...p._resolveBase(), endDate: SIM_END });

const compiled = (params) =>
  quiet(() => seededFrom(problem(params, { kind: 'compile', cfgTemplate: null })));

const SNAPSHOT = quiet(() =>
  problem(BASE, { kind: 'compile', cfgTemplate: null }).rollToSnapshot({}, AS_OF));

const seeded = (params) =>
  quiet(() => seededFrom(problem(params, { kind: 'snapshot', snapshot: SNAPSHOT, cfgTemplate: null })));

/**
 * The probe on a compiled sim and on a snapshot-seeded one, for the base and the candidate.
 * `probe` may read state or the queue; both are JSON-able, so `deepEqual` is the comparison.
 */
function observe(c) {
  const params = { ...BASE, ...c.params };
  return {
    baseCompiled:  c.probe(compiled(BASE)),
    candCompiled:  c.probe(compiled(params)),
    candSeeded:    c.probe(seeded(params)),
    // The control for MLR-3: what a rollout of the BASE starts from. Compared against the
    // candidate's rollout, so both sides travel the same seeding path and a difference can only
    // be the candidate — rather than the history a t₀ compile still holds and a snapshot does not.
    baseSeeded:    c.probe(seeded(BASE)),
  };
}

const SEEN = new Map(CASES.map(c => [c.lever, observe(c)]));

// ─── MLR-1 ───────────────────────────────────────────────────────────────────

test('MLR-1: every candidate is a REAL lever — it changes the probe on a compiled sim', () => {
  // Without this, "lost" below could mean the candidate does nothing at all, which is §14.8's
  // failure and a different bug. This separates inert from unreachable.
  for (const c of CASES) {
    const { baseCompiled, candCompiled } = SEEN.get(c.lever);
    assert.notDeepEqual(candCompiled, baseCompiled,
      `${c.lever}: ${c.probeName} is unchanged by the candidate on a COMPILED sim — the case is `
      + 'inert, so this file is testing nothing');
  }
});

// ─── MLR-2 ───────────────────────────────────────────────────────────────────

test('MLR-2: every lever NOT in KNOWN_BROKEN starts its rollout from the candidate\'s plan', () => {
  for (const c of CASES.filter(x => x.expect === 'reaches')) {
    const { candCompiled, candSeeded } = SEEN.get(c.lever);
    assert.deepEqual(candSeeded, candCompiled,
      `${c.lever}: ${c.probeName} differs between the compiled plan and the rollout's own `
      + 'starting point, so the rollout is pricing a plan nobody chose');
  }
});

// ─── MLR-3 ───────────────────────────────────────────────────────────────────

test('MLR-3: the known-broken probes are still lost at the injection boundary', () => {
  for (const c of CASES.filter(x => x.expect === 'lost')) {
    assert.ok(KNOWN_BROKEN.has(c.lever), `${c.lever} expects 'lost' but is not in KNOWN_BROKEN`);
    const { candCompiled, candSeeded, baseSeeded } = SEEN.get(c.lever);

    assert.notDeepEqual(candSeeded, candCompiled,
      `${c.lever}: ${c.probeName} now survives injection. If you fixed the boundary (design 39 `
      + '§14.9.4), move this case to expect: \'reaches\' and strike it from KNOWN_BROKEN — do '
      + 'not relax this assertion.');
    // And what it DOES start from is the base's plan — the precise statement of the defect, and
    // what makes the fan a picture of a plan nobody chose.
    assert.deepEqual(candSeeded, baseSeeded,
      `${c.lever}: the rollout starts from neither the candidate NOR the base — investigate `
      + 'before trusting anything else in this file');
  }
});

test('MLR-3b: KNOWN_BROKEN has no stale entries', () => {
  const covered = new Set(CASES.map(c => c.lever));
  for (const lever of KNOWN_BROKEN) {
    assert.ok(covered.has(lever), `KNOWN_BROKEN names ${lever}, which no case measures`);
  }
});

// ─── MLR-2b ──────────────────────────────────────────────────────────────────

test('MLR-2b: SPENDING reaches the rollout — the control, and why it is not in CASES', () => {
  // SPENDING is the one lever §14.9 measured live end to end (A ≡ A′ over 2, 3 and 10 epochs), and
  // it is live for a reason that makes it unprobeable the way the others are: it configures a
  // REDUCER (which injection never touches) and `repinExpensesIfChanged` actuates the band active
  // at "now" straight into state AFTER injection. There is no compile-time derived artifact to
  // compare — on an unstepped compile at t₀ the bands have not been applied yet at all.
  const params = { ...BASE, spendingExpenseBands: [{ startAge: 45, monthlyAmount: 4000 }] };
  const baseline = Math.round(seeded(BASE).state.monthlyExpenses);
  const moved    = Math.round(seeded(params).state.monthlyExpenses);
  assert.notEqual(moved, baseline,
    'the forward re-pin must carry the decision into the rollout\'s own spend line');
  // And it lands on the decided amount, inflated to "now" — not on some partial patch.
  assert.ok(moved > 4000 && moved < baseline,
    `re-pinned spend ${moved} should be the decided 4000 compounded to ${AS_OF.getUTCFullYear()}`);
});

// ─── MLR-4 ───────────────────────────────────────────────────────────────────

test('MLR-4: seeding a rollout must not mutate the SNAPSHOT (§14.9.4)', () => {
  // The defect: `Simulation.cloneQueue()` and `_injectSnapshot` both copy events with `{ ...e }`,
  // a SHALLOW copy, so a restored event shares its `data` object with the snapshot's. The two
  // forward-effective re-target shims then rewrite `sim.queue.data` IN PLACE — and write straight
  // through into the controller's snapshot.
  //
  // The consequence is not cosmetic: the snapshot is the baseline for every other candidate in the
  // same fan and for the next epoch, so one rollout's committed amounts become the starting point
  // of the next. The search stops being a comparison of candidates against a fixed "now" and
  // becomes order-dependent.
  // Its OWN snapshot, deliberately. The module-level one has already been through `SEEN`, so a
  // second write of the same value would leave it looking untouched — the defect hiding itself.
  const snap = quiet(() =>
    problem(BASE, { kind: 'compile', cfgTemplate: null }).rollToSnapshot({}, AS_OF));
  const seededOn = (params) => quiet(() =>
    seededFrom(problem(params, { kind: 'snapshot', snapshot: snap, cfgTemplate: null })));

  const probe = () => (snap.queue ?? [])
    .filter(e => e.type === 'SCHEDULED_EARLY_WITHDRAWAL' && new Date(e.date) > AS_OF)
    .map(e => Math.round(e.data.taxDeferredAmount))
    .sort((a, b) => a - b);

  const before = probe();
  seededOn({ ...BASE,
    earlyWithdrawalSchedule: [{ year: 2050, taxDeferredAmount: 150_000, rothAmount: 0 }] });
  const after = probe();

  assert.deepEqual(after, before,
    'a rollout wrote its candidate into the shared snapshot. Fix the two shallow event copies '
    + '(deep-copy `data`), do not relax this test — and then re-check every arm measured against '
    + 'a contaminated snapshot.');
});
