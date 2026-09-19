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
 * pool-shape-schedule.test.mjs
 *
 * DESIGN 109 — time-varying pool shapes, step 2: the params, the resolver and the selector.
 * No consumer reads any of this yet, which is the point of the step: it is authorable,
 * fully validated, and cannot change a run.
 *
 * PSS-1  Absent ⇒ null ⇒ nothing exists (the gate on the whole design, §13 case 1)
 * PSS-2  The resolved step function — the base graph opens it, rows follow in year order
 * PSS-3  `activeGraphAt` — before, exactly on, between, after, and the degenerate inputs
 * PSS-4  Every shape compiles at BUILD, with the shape named (§5 rule 1)
 * PSS-5  Validation §12 — duplicate year, unknown shape, malformed rows
 * PSS-6  The warnings §12 rules 3 and 4 — an unscheduled shape, a resurrected pool
 * PSS-7  `liquidityGraphEnabled: false` makes it inert, and problems are still reported
 * PSS-8  The two-authorities rule reaches every shape
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  resolveLiquidityGraphSchedule, activeGraphAt, resolveLiquidityGraph,
  collectAuthoredGraphProblems, compileToDrawdownSequence,
} from '../../src/finance/pools/liquidity-graph.js';
import { ACCOUNT_TYPE } from '../../src/finance/assets/account.js';

const ACCOUNTS = [
  { stateKey: 'usSavingsAccount', type: ACCOUNT_TYPE.SAVINGS },
  { stateKey: 'auSavingsAccount', type: ACCOUNT_TYPE.SAVINGS },
  { stateKey: 'usStockAccount',   type: ACCOUNT_TYPE.BROKERAGE },
];

// A targeted pool may claim only ONE allocation class (§12.2 — a size target has no unique
// split across classes), so every `bonds` below is a single-sleeve pool.

/** The base graph — what governs before the first scheduled row. */
const BASE = {
  pools: [
    { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'bonds',  spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH'] }] },
  ],
};

/** The bridge shape — the same pools, with the reserve sized. */
const BRIDGE = {
  pools: [
    { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'bonds',  spendOrder: 20, target: { mode: 'YEARS_OF_SPEND', value: 5 },
      claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH'] }] },
  ],
};

/** A third shape that drops `bonds` entirely — its sleeve folds into growth. */
const LATE = {
  pools: [
    { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'growth', spendOrder: 40,
      claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH', 'BOND'] }] },
  ],
};

const paramsOf = (over = {}) => ({ liquidityGraph: BASE, ...over });

/** Captures `console.warn` for the cases whose whole content is a warning. */
function capturingWarnings(fn) {
  const seen = [];
  const real = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try { fn(); } finally { console.warn = real; }
  return seen;
}

const JAN = (y) => Date.UTC(y, 0, 1);

// ─── PSS-1 ───────────────────────────────────────────────────────────────────

test('PSS-1: no schedule ⇒ null — the design adds nothing to a scenario that does not use it', () => {
  assert.equal(resolveLiquidityGraphSchedule(paramsOf(), ACCOUNTS), null);
  assert.equal(resolveLiquidityGraphSchedule({}, ACCOUNTS), null);
  // Shapes without a schedule are also inert: they are authorable drafts until a row selects
  // one, which is what makes §12 rule 3 a warning rather than an error.
  const warns = capturingWarnings(() =>
    assert.equal(resolveLiquidityGraphSchedule(paramsOf({ liquidityShapes: { bridge: BRIDGE } }), ACCOUNTS), null));
  assert.deepEqual(warns, [], 'and nothing is resolved, so nothing is warned about');
});

test('PSS-1b: an EMPTY schedule is the same as no schedule, not an empty step function', () => {
  assert.equal(resolveLiquidityGraphSchedule(paramsOf({ liquidityGraphSchedule: [] }), ACCOUNTS), null);
});

test('PSS-1c: the base graph is untouched — `resolveLiquidityGraph` does not learn about shapes', () => {
  const p = paramsOf({ liquidityShapes: { bridge: BRIDGE }, liquidityGraphSchedule: [{ year: 2040, shape: 'bridge' }] });
  const base = resolveLiquidityGraph(p, ACCOUNTS);
  assert.deepEqual(base.pools.map(x => x.id).sort(), ['bonds', 'cash', 'growth']);
  assert.equal(base.pools.find(x => x.id === 'bonds').target, null, 'the BASE graph, not the bridge');
});

// ─── PSS-2 ───────────────────────────────────────────────────────────────────

test('PSS-2: the resolved step function opens with the base graph and follows in YEAR order', () => {
  const sched = resolveLiquidityGraphSchedule(paramsOf({
    liquidityShapes: { bridge: BRIDGE, late: LATE },
    // Deliberately out of order: the resolver sorts, so the authored order is not the answer.
    liquidityGraphSchedule: [{ year: 2050, shape: 'late' }, { year: 2035, shape: 'bridge' }],
  }), ACCOUNTS);

  assert.equal(sched.length, 3);
  assert.deepEqual(sched.map(e => e.shapeId), [null, 'bridge', 'late']);
  assert.deepEqual(sched.map(e => e.year),    [null, 2035, 2050]);
  assert.equal(sched[0].fromMs, -Infinity, 'the base graph governs every instant before row 1');
  assert.equal(sched[1].fromMs, JAN(2035));
  assert.equal(sched[2].fromMs, JAN(2050));
});

test('PSS-2b: each entry carries a fully NORMALIZED graph, not the authored value', () => {
  const sched = resolveLiquidityGraphSchedule(paramsOf({
    liquidityShapes: { bridge: BRIDGE },
    liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }],
  }), ACCOUNTS);

  const bonds = sched[1].graph.pools.find(p => p.id === 'bonds');
  // Normalized, not the authored value: `spendBasis` is filled in by the compiler.
  assert.deepEqual(bonds.target, { mode: 'YEARS_OF_SPEND', value: 5, spendBasis: 'LIVE' });
  assert.equal(bonds.access.mode, 'PENALTY_FREE', 'normalized, so the §24.5 default is present');
  // And it compiles, like any graph.
  assert.deepEqual(compileToDrawdownSequence(sched[1].graph).map(e => e.key),
    ['usSavingsAccount', 'usStockAccount', 'usStockAccount']);
});

test('PSS-2c: with NO base graph the run simply has no pools until the first row', () => {
  const sched = resolveLiquidityGraphSchedule({
    liquidityShapes: { bridge: BRIDGE },
    liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }],
  }, ACCOUNTS);
  assert.equal(sched[0].graph, null, 'legal, and it means the drawdownPriority walk');
  assert.ok(sched[1].graph);
});

// ─── PSS-3 ───────────────────────────────────────────────────────────────────

test('PSS-3: activeGraphAt — before, exactly on the boundary, between, and after', () => {
  const sched = resolveLiquidityGraphSchedule(paramsOf({
    liquidityShapes: { bridge: BRIDGE, late: LATE },
    liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }, { year: 2050, shape: 'late' }],
  }), ACCOUNTS);

  assert.equal(activeGraphAt(sched, JAN(2026)).shapeId, null,     'before row 1: the base graph');
  assert.equal(activeGraphAt(sched, JAN(2035) - 1).shapeId, null, 'one ms before the boundary');
  assert.equal(activeGraphAt(sched, JAN(2035)).shapeId, 'bridge', 'ON the boundary it is live');
  assert.equal(activeGraphAt(sched, JAN(2042)).shapeId, 'bridge', 'and holds until the next row');
  assert.equal(activeGraphAt(sched, JAN(2050)).shapeId, 'late');
  assert.equal(activeGraphAt(sched, JAN(2099)).shapeId, 'late',   'the last row runs to the end');
});

test('PSS-3b: activeGraphAt on a single-row schedule, and on degenerate inputs', () => {
  const sched = resolveLiquidityGraphSchedule(paramsOf({
    liquidityShapes: { bridge: BRIDGE },
    liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }],
  }), ACCOUNTS);
  assert.equal(activeGraphAt(sched, JAN(2030)).shapeId, null);
  assert.equal(activeGraphAt(sched, JAN(2035)).shapeId, 'bridge');

  assert.equal(activeGraphAt(null, JAN(2035)), null);
  assert.equal(activeGraphAt([],   JAN(2035)), null);
});

// ─── PSS-4 ───────────────────────────────────────────────────────────────────

test('PSS-4: a shape that does not compile fails at BUILD, with the shape named', () => {
  // A percent authored as 100 rather than 1.0 — the same mistake the base graph already
  // refuses. The point is WHEN and WHERE it is reported: now, and against 'bridge'.
  const bad = { pools: [{ id: 'bonds', spendOrder: 20, target: { mode: 'PERCENT', value: 100 },
                          claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] }] };
  assert.throws(
    () => resolveLiquidityGraphSchedule(paramsOf({
      liquidityShapes: { bridge: bad },
      liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }],
    }), ACCOUNTS),
    /shape 'bridge':/);
});

test('PSS-4b: a shape that takes effect in twenty years still fails NOW', () => {
  // The whole reason shapes normalize at build: an error arriving from inside a period
  // advance nineteen simulated years in cannot be associated with the thing the author typed.
  const bad = { pools: [{ id: 'x', spendOrder: 10, claims: [{ key: 'noSuchAccount' }] }] };
  assert.throws(
    () => resolveLiquidityGraphSchedule(paramsOf({
      liquidityShapes: { future: bad },
      liquidityGraphSchedule: [{ year: 2099, shape: 'future' }],
    }), ACCOUNTS),
    /shape 'future':/);
});

test('PSS-4c: every shape validates against the SAME account list', () => {
  const ok = resolveLiquidityGraphSchedule(paramsOf({
    liquidityShapes: { late: LATE },
    liquidityGraphSchedule: [{ year: 2050, shape: 'late' }],
  }), ACCOUNTS);
  assert.ok(ok, 'a shape naming only live accounts resolves');
  assert.throws(
    () => resolveLiquidityGraphSchedule(paramsOf({
      liquidityShapes: { late: LATE },
      liquidityGraphSchedule: [{ year: 2050, shape: 'late' }],
    }), [{ stateKey: 'usSavingsAccount', type: ACCOUNT_TYPE.SAVINGS }]),
    /shape 'late':/);
});

// ─── PSS-5 ───────────────────────────────────────────────────────────────────

test('PSS-5: §12 rule 1 — two rows for one year are refused, naming both shapes', () => {
  assert.throws(
    () => resolveLiquidityGraphSchedule(paramsOf({
      liquidityShapes: { bridge: BRIDGE, late: LATE },
      liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }, { year: 2035, shape: 'late' }],
    }), ACCOUNTS),
    /two rows for 2035 \('bridge' and 'late'\).*only one shape can be active/s);
});

test('PSS-5b: §12 rule 2 — an unknown shape id is refused, and the known ones are listed', () => {
  assert.throws(
    () => resolveLiquidityGraphSchedule(paramsOf({
      liquidityShapes: { bridge: BRIDGE },
      liquidityGraphSchedule: [{ year: 2035, shape: 'bridg' }],
    }), ACCOUNTS),
    /names shape 'bridg', which is not in `liquidityShapes` \('bridge'\)/);
});

test('PSS-5c: a schedule with no shapes at all says so rather than naming an empty list', () => {
  assert.throws(
    () => resolveLiquidityGraphSchedule(paramsOf({
      liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }],
    }), ACCOUNTS),
    /which is empty/);
});

test('PSS-5d: malformed rows and containers are refused with the row index', () => {
  const bad = (over) => () => resolveLiquidityGraphSchedule(paramsOf({
    liquidityShapes: { bridge: BRIDGE }, ...over }), ACCOUNTS);

  assert.throws(bad({ liquidityGraphSchedule: {} }), /has to be an array/);
  assert.throws(bad({ liquidityGraphSchedule: [null] }), /\[0\] is not a \{ year, shape \} row/);
  assert.throws(bad({ liquidityGraphSchedule: [{ year: 2035.5, shape: 'bridge' }] }), /is not a whole year/);
  assert.throws(bad({ liquidityGraphSchedule: [{ year: 'soon', shape: 'bridge' }] }), /is not a whole year/);
  assert.throws(bad({ liquidityGraphSchedule: [{ year: 2035 }] }), /names no shape/);
  assert.throws(
    () => resolveLiquidityGraphSchedule(paramsOf({
      liquidityShapes: [BRIDGE], liquidityGraphSchedule: [{ year: 2035, shape: '0' }] }), ACCOUNTS),
    /`liquidityShapes` has to be an object/);
});

// ─── PSS-6 ───────────────────────────────────────────────────────────────────

test('PSS-6: §12 rule 3 — a shape no row selects WARNS and governs nothing', () => {
  const warns = capturingWarnings(() => {
    const sched = resolveLiquidityGraphSchedule(paramsOf({
      liquidityShapes: { bridge: BRIDGE, forgotten: LATE },
      liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }],
    }), ACCOUNTS);
    assert.equal(sched.length, 2, 'the unselected shape is not an entry');
  });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /'forgotten' is not selected by any/);
});

test('PSS-6b: §12 rule 4 — a pool that disappears and comes back WARNS about its trailing high', () => {
  const warns = capturingWarnings(() => {
    resolveLiquidityGraphSchedule(paramsOf({
      // `bonds` is in the base graph, absent from `late`, and back in `bridge`.
      liquidityShapes: { late: LATE, bridge: BRIDGE },
      liquidityGraphSchedule: [{ year: 2035, shape: 'late' }, { year: 2050, shape: 'bridge' }],
    }), ACCOUNTS);
  });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /pool 'bonds' is absent from a shape and returns/);
  assert.match(warns[0], /trailing high resets to 0/);
  assert.match(warns[0], /the base graph → bridge/);
});

test('PSS-6c: a pool merely RETIRED, or merely added, is not warned about', () => {
  const warns = capturingWarnings(() => {
    resolveLiquidityGraphSchedule(paramsOf({
      liquidityShapes: { late: LATE },
      liquidityGraphSchedule: [{ year: 2050, shape: 'late' }],
    }), ACCOUNTS);
  });
  assert.deepEqual(warns, [], 'dropping a pool is ordinary authoring; coming BACK is the trap');
});

// ─── PSS-7 ───────────────────────────────────────────────────────────────────

test('PSS-7: liquidityGraphEnabled:false makes the schedule inert, like everything else', () => {
  const p = paramsOf({
    liquidityGraphEnabled: false,
    liquidityShapes: { bridge: BRIDGE },
    liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }],
  });
  assert.equal(resolveLiquidityGraphSchedule(p, ACCOUNTS), null);
  assert.equal(resolveLiquidityGraph(p, ACCOUNTS), null, 'and so is the base graph');
});

test('PSS-7b: a switched-off graph STILL reports its shape problems, localized to the shape', () => {
  // The switch is a run-time "ignore this", not an authoring-time "this is fine" — otherwise
  // flipping it back on surfaces an error the author was never shown.
  const bad = { pools: [{ id: 'x', spendOrder: 10, target: { mode: 'PERCENT', value: 100 },
                          claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] }] };
  const problems = collectAuthoredGraphProblems(paramsOf({
    liquidityGraphEnabled: false,
    liquidityShapes: { bridge: bad },
    liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }],
  }), ACCOUNTS);

  const hit = problems.find(x => x.param === 'liquidityShapes');
  assert.ok(hit, `expected a liquidityShapes problem, got ${JSON.stringify(problems)}`);
  assert.equal(hit.shape, 'bridge', 'named, or the author repairs the wrong table');
});

test('PSS-7c: a bad SCHEDULE is reported against the schedule, not against a shape', () => {
  const problems = collectAuthoredGraphProblems(paramsOf({
    liquidityShapes: { bridge: BRIDGE },
    liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }, { year: 2035, shape: 'bridge' }],
  }), ACCOUNTS);
  const hit = problems.find(x => x.param === 'liquidityGraphSchedule');
  assert.ok(hit);
  assert.equal(hit.shape, null);
});

test('PSS-7d: a clean graph and schedule report nothing', () => {
  assert.deepEqual(collectAuthoredGraphProblems(paramsOf({
    liquidityShapes: { bridge: BRIDGE },
    liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }],
  }), ACCOUNTS), []);
});

// ─── PSS-8 ───────────────────────────────────────────────────────────────────

test('PSS-8: the two-authorities rule reaches every shape, not just the base graph', () => {
  // Authoring a graph AND a hand-written drawdownSequence throws (§6). A shape is a graph, so
  // the same conflict has to be found in it — the options a shape normalizes under are the
  // base graph's, deliberately, or two shapes in one scenario would mean different things.
  assert.throws(
    () => resolveLiquidityGraphSchedule({
      drawdownSequence: [{ key: 'usSavingsAccount' }],
      liquidityShapes: { bridge: BRIDGE },
      liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }],
    }, ACCOUNTS),
    /shape 'bridge':.*drawdownSequence/s);
});

// ═════════════════════════════════════════════════════════════════════════════
// DESIGN 109 step 3 — `PoolShapeScheduleReducer`, the switch itself.
//
// PSS-9   A period that does not switch writes NOTHING (§13 case 2)
// PSS-10  The switch lands at the first advance on or after the boundary (§8)
// PSS-11  `drawdownSequence` — the half that actually moves money (§6.3)
// PSS-12  Pool identity across a switch (§9): continued, new, retired
// ═════════════════════════════════════════════════════════════════════════════

import { PoolShapeScheduleReducer } from '../../src/finance/pools/pool-shape-schedule-reducer.js';
import { diffStates } from '../../src/simulation-framework/state-utils.js';

const SCHEDULED = () => resolveLiquidityGraphSchedule(paramsOf({
  liquidityShapes: { bridge: BRIDGE, late: LATE },
  liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }, { year: 2050, shape: 'late' }],
}), ACCOUNTS);

const advance = (reducer, state, ms, type = 'US_PERIOD_ADVANCE') => {
  const { next, ...after } = reducer.reduce(state, { type, date: new Date(ms) }, new Date(ms));
  return after;
};

// ─── PSS-9 ───────────────────────────────────────────────────────────────────

test('PSS-9: a period that does not switch emits no diff at all', () => {
  const r = new PoolShapeScheduleReducer({ schedule: SCHEDULED() });
  const before = { liquidityShapeId: null };

  const after = advance(r, before, JAN(2030));
  assert.deepEqual(diffStates(before, after), [],
    'a non-switching period must be indistinguishable from having no schedule');
});

test('PSS-9b: a SECOND advance in the live shape is also silent', () => {
  const r = new PoolShapeScheduleReducer({ schedule: SCHEDULED() });
  const switched = advance(r, { liquidityShapeId: null }, JAN(2035));
  assert.equal(switched.liquidityShapeId, 'bridge');

  const again = advance(r, switched, Date.UTC(2035, 6, 1), 'AU_PERIOD_ADVANCE');
  assert.deepEqual(diffStates(switched, again), [], 'the shape is already live');
});

test('PSS-9c: an unstamped state in the OPENING shape writes nothing', () => {
  // `undefined` vs `null`: without the coalesce the first advance of every scheduled run
  // would emit a patch that changes nothing.
  const r = new PoolShapeScheduleReducer({ schedule: SCHEDULED() });
  const before = {};
  assert.deepEqual(diffStates(before, advance(r, before, JAN(2030))), []);
});

test('PSS-9d: no schedule ⇒ the reducer is a no-op even if one is constructed', () => {
  const before = { liquidityShapeId: null };
  for (const schedule of [null, []]) {
    const r = new PoolShapeScheduleReducer({ schedule });
    assert.deepEqual(diffStates(before, advance(r, before, JAN(2099))), []);
  }
});

// ─── PSS-10 ──────────────────────────────────────────────────────────────────

test('PSS-10: the switch lands on the first advance on or after 1 January of its year', () => {
  const r = new PoolShapeScheduleReducer({ schedule: SCHEDULED() });
  let s = { liquidityShapeId: null };

  s = advance(r, s, Date.UTC(2034, 6, 1));
  assert.equal(s.liquidityShapeId, null, 'an advance in the year BEFORE does not switch');

  s = advance(r, s, JAN(2035));
  assert.equal(s.liquidityShapeId, 'bridge');
});

test('PSS-10b: on a mid-year cadence the shape takes over LATE, deterministically', () => {
  // §8's stated consequence: a shape governs DECISIONS, and decisions are taken at advances.
  // A plan whose advances fall in July does not switch on 1 January — it switches in July.
  const r = new PoolShapeScheduleReducer({ schedule: SCHEDULED() });
  let s = { liquidityShapeId: null };

  s = advance(r, s, Date.UTC(2034, 6, 1), 'AU_PERIOD_ADVANCE');
  assert.equal(s.liquidityShapeId, null);
  s = advance(r, s, Date.UTC(2035, 6, 1), 'AU_PERIOD_ADVANCE');
  assert.equal(s.liquidityShapeId, 'bridge', 'six months after the row\'s year began');
});

test('PSS-10c: both advance cadences drive the switch', () => {
  for (const type of ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE']) {
    const r = new PoolShapeScheduleReducer({ schedule: SCHEDULED() });
    assert.equal(advance(r, { liquidityShapeId: null }, JAN(2035), type).liquidityShapeId, 'bridge');
  }
});

test('PSS-10d: a run that starts after several rows lands on the LAST one, not the first', () => {
  const r = new PoolShapeScheduleReducer({ schedule: SCHEDULED() });
  const s = advance(r, { liquidityShapeId: null }, JAN(2060));
  assert.equal(s.liquidityShapeId, 'late');
});

// ─── PSS-11 ──────────────────────────────────────────────────────────────────

test('PSS-11: the switch re-stamps drawdownSequence — the half that moves money', () => {
  // Design 109 §2: `state.liquidityGraph` is read by nothing in src/. The engine consults
  // `state.drawdownSequence`, so a switch that re-stamped only the graph would change nothing
  // and look like it changed everything.
  const r = new PoolShapeScheduleReducer({ schedule: SCHEDULED() });
  const before = {
    liquidityShapeId: null,
    drawdownSequence: compileToDrawdownSequence(SCHEDULED()[0].graph),
  };
  assert.equal(before.drawdownSequence.length, 3, 'cash, bonds, growth');

  const after = advance(r, before, JAN(2050));      // → `late`, which has no bonds pool
  assert.equal(after.liquidityShapeId, 'late');
  assert.deepEqual(after.drawdownSequence.map(e => e.key),
    ['usSavingsAccount', 'usStockAccount']);
  assert.deepEqual(after.drawdownSequence.at(-1).sleeves, ['EQUITY', 'GOLD', 'CASH', 'BOND']);

  // Both halves in ONE patch — the witness must never describe a shape the engine is not on.
  assert.deepEqual(after.liquidityGraph.pools.map(p => p.id), ['cash', 'growth']);
});

test('PSS-11b: a shape with no spend source at all clears the sequence rather than freezing it', () => {
  const idle = { pools: [{ id: 'vault', claims: [{ key: 'usSavingsAccount' }] }] };   // no spendOrder
  const sched = resolveLiquidityGraphSchedule(paramsOf({
    liquidityShapes: { idle },
    liquidityGraphSchedule: [{ year: 2040, shape: 'idle' }],
  }), ACCOUNTS);
  const r = new PoolShapeScheduleReducer({ schedule: sched });

  const after = advance(r, { liquidityShapeId: null, drawdownSequence: [{ key: 'x' }] }, JAN(2040));
  assert.equal(after.drawdownSequence, null,
    'a stale order left standing would keep spending on a shape that is gone');
});

// ─── PSS-12 ──────────────────────────────────────────────────────────────────

test('PSS-12: a CONTINUED pool keeps its history across the switch', () => {
  // §9 — the id is the handle. `cash` and `growth` are in both shapes, so their trailing high
  // and spend window survive; this is what an author means by "the bond pool gets bigger".
  const r = new PoolShapeScheduleReducer({ schedule: SCHEDULED() });
  const before = {
    liquidityShapeId: null,
    liquidityPools: {
      cash:   { balance: 50_000, high: 80_000, spendHistory: [100_000, 105_000] },
      bonds:  { balance: 200_000, high: 260_000 },
      growth: { balance: 900_000, high: 1_200_000 },
    },
  };
  const after = advance(r, before, JAN(2035));      // → `bridge`, which has all three

  assert.deepEqual(after.liquidityPools.cash, before.liquidityPools.cash);
  assert.deepEqual(after.liquidityPools.bonds, before.liquidityPools.bonds);
  assert.equal(after.liquidityPools.growth.high, 1_200_000);
});

test('PSS-12b: a RETIRED pool is dropped from the cube, not carried at its last value', () => {
  // Carried forward it would keep that value for the rest of the run and the panel would plot
  // a pool that no longer exists, flat, forever — `pool-history.js` carries a field forward
  // when there is no diff, so the key has to be removed explicitly.
  const r = new PoolShapeScheduleReducer({ schedule: SCHEDULED() });
  const before = {
    liquidityShapeId: null,
    liquidityPools: {
      cash:   { balance: 50_000 },
      bonds:  { balance: 200_000, high: 260_000 },
      growth: { balance: 900_000 },
    },
  };
  const after = advance(r, before, JAN(2050));      // → `late`, which drops `bonds`

  assert.deepEqual(Object.keys(after.liquidityPools).sort(), ['cash', 'growth']);
  assert.ok(diffStates(before, after).some(d => d.field.startsWith('liquidityPools')),
    'the removal rides the ordinary diff path, so the replay sees it');
});

test('PSS-12c: a NEW pool is simply absent — it is seeded cold by the flow reducer', () => {
  const fresh = {
    pools: [
      { id: 'cash',    spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'newbie',  spendOrder: 15, claims: [{ key: 'auSavingsAccount' }] },
      { id: 'growth',  spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH', 'BOND'] }] },
    ],
  };
  const sched = resolveLiquidityGraphSchedule(paramsOf({
    liquidityShapes: { fresh },
    liquidityGraphSchedule: [{ year: 2040, shape: 'fresh' }],
  }), ACCOUNTS);
  const r = new PoolShapeScheduleReducer({ schedule: sched });

  const after = advance(r, {
    liquidityShapeId: null,
    liquidityPools: { cash: { balance: 1 }, bonds: { balance: 2 }, growth: { balance: 3 } },
  }, JAN(2040));

  assert.deepEqual(Object.keys(after.liquidityPools).sort(), ['cash', 'growth']);
  assert.equal(after.liquidityPools.newbie, undefined, 'no cube entry is invented for it');
});

test('PSS-12d: a state with no cube at all is left without one', () => {
  const r = new PoolShapeScheduleReducer({ schedule: SCHEDULED() });
  const after = advance(r, { liquidityShapeId: null }, JAN(2035));
  assert.equal('liquidityPools' in after, false, 'absent stays absent — no empty object');
});

// ═════════════════════════════════════════════════════════════════════════════
// PSS-13 — through a REAL scenario load. The seam the unit cases cannot reach:
// the reducer has to be registered, reach the pipeline, and fire on the run's own
// advances against the run's own state.
// ═════════════════════════════════════════════════════════════════════════════

import { loadScenarioSim } from '../helpers/scenario-harness.js';

/** The scenario's real account keys, which are not the synthetic ones above. */
const LIVE_ACCOUNTS = ['usSavingsAccount', 'usStockAccount'];

const LIVE_BASE = {
  pools: [
    { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'bonds',  spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH'] }] },
  ],
};
const LIVE_LATE = {
  pools: [
    { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'growth', spendOrder: 40,
      claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH', 'BOND'] }] },
  ],
};

test('PSS-13: no schedule ⇒ the reducer is not in the pipeline at all', () => {
  const { sim } = loadScenarioSim({
    params: { behavioralStrategies: ['LIQUIDITY_POOLS'], liquidityGraph: LIVE_BASE },
    simStart: '2026-01-01', simEnd: '2026-06-01',
  });
  const types = [...sim.reducers.map.values()].flat()
    .map(e => e.reducer?.constructor?.type);
  assert.ok(!types.includes('PoolShapeScheduleReducer'),
    'a scenario without a schedule must have an identical reducer list');
  assert.equal(sim.state.liquidityShapeId, undefined, 'and no state field');
});

test('PSS-13b: with a schedule the reducer is registered and the opening shape is the base graph', () => {
  const { sim } = loadScenarioSim({
    params: {
      behavioralStrategies: ['LIQUIDITY_POOLS'],
      liquidityGraph: LIVE_BASE,
      liquidityShapes: { late: LIVE_LATE },
      liquidityGraphSchedule: [{ year: 2030, shape: 'late' }],
    },
    simStart: '2026-01-01', simEnd: '2026-06-01',
  });
  const types = [...sim.reducers.map.values()].flat()
    .map(e => e.reducer?.constructor?.type);
  assert.ok(types.includes('PoolShapeScheduleReducer'));

  // Before the row's year: the projection's own compile, untouched.
  assert.deepEqual(sim.state.drawdownSequence.map(e => e.key),
    ['usSavingsAccount', 'usStockAccount', 'usStockAccount']);
});

test('PSS-13c: stepping past the boundary re-stamps the order the draw actually reads', () => {
  const { sim } = loadScenarioSim({
    params: {
      behavioralStrategies: ['LIQUIDITY_POOLS'],
      liquidityGraph: LIVE_BASE,
      liquidityShapes: { late: LIVE_LATE },
      liquidityGraphSchedule: [{ year: 2030, shape: 'late' }],
    },
    simStart: '2026-01-01', simEnd: '2032-01-01', stepTo: '2031-06-01',
  });

  assert.equal(sim.state.liquidityShapeId, 'late');
  // Two entries now, not three — `bonds` is gone and its sleeve folded into growth.
  assert.deepEqual(sim.state.drawdownSequence.map(e => e.key),
    ['usSavingsAccount', 'usStockAccount']);
  assert.deepEqual(sim.state.drawdownSequence.at(-1).sleeves,
    ['EQUITY', 'GOLD', 'CASH', 'BOND']);
  assert.deepEqual(sim.state.liquidityGraph.pools.map(p => p.id), ['cash', 'growth']);
});

test('PSS-13d: a schedule whose row names a shape equal to the base graph moves nothing', () => {
  // §13 case 2 — the reducer fires every advance, finds a different SHAPE ID, and stamps a
  // sequence identical to the one already there. The id changes; the order does not.
  const { sim } = loadScenarioSim({
    params: {
      behavioralStrategies: ['LIQUIDITY_POOLS'],
      liquidityGraph: LIVE_BASE,
      liquidityShapes: { same: LIVE_BASE },
      liquidityGraphSchedule: [{ year: 2030, shape: 'same' }],
    },
    simStart: '2026-01-01', simEnd: '2032-01-01', stepTo: '2031-06-01',
  });
  assert.equal(sim.state.liquidityShapeId, 'same');
  assert.deepEqual(sim.state.drawdownSequence.map(e => e.key),
    ['usSavingsAccount', 'usStockAccount', 'usStockAccount']);
});

test('PSS-13e: a shape that does not compile fails the LOAD, not a period nineteen years in', () => {
  assert.throws(() => loadScenarioSim({
    params: {
      behavioralStrategies: ['LIQUIDITY_POOLS'],
      liquidityGraph: LIVE_BASE,
      liquidityShapes: { broken: { pools: [{ id: 'x', spendOrder: 10, claims: [{ key: 'notAnAccount' }] }] } },
      liquidityGraphSchedule: [{ year: 2099, shape: 'broken' }],
    },
    simStart: '2026-01-01', simEnd: '2026-06-01',
  }), /shape 'broken':/);
});

// ═════════════════════════════════════════════════════════════════════════════
// DESIGN 109 step 4 — the three instance-held consumers follow the active shape.
//
// PSS-14  PoolFlowReducer evaluates the live shape's pools and edges
// PSS-15  PoolFlowApplyReducer resolves the PLAN's shape, never its own
// PSS-16  The rebalancer reads the live graph off state
// ═════════════════════════════════════════════════════════════════════════════

import { PoolFlowReducer } from '../../src/finance/pools/pool-flow-reducer.js';
import { PoolFlowApplyReducer } from '../../src/finance/pools/pool-flow-apply-reducer.js';
import { RebalanceToTargetReducer } from '../../src/finance/behavioral/rebalance-to-target-reducer.js';

/** A state the flow reducer can evaluate: two claimed accounts and a spend line. */
const flowState = (asOfMs) => ({
  usSavingsAccount: { balance: 50_000,  currency: { code: 'USD' }, type: 'savings' },
  usStockAccount:   { balance: 900_000, currency: { code: 'USD' }, type: 'brokerage',
    holdings: [
      { allocation: 'BOND',   marketValue: 300_000, rateKey: 'BOND_US' },
      { allocation: 'EQUITY', marketValue: 600_000, rateKey: 'EQUITY_US' },
    ] },
  monthlyExpenses: 10_000,
  effectiveExchangeRates: { USD_AUD: 1 },
  currentPeriods: { US: { startMs: asOfMs } },
});

// ─── PSS-14 ──────────────────────────────────────────────────────────────────

test('PSS-14: the flow reducer stamps the LIVE shape\'s pools, not the opening one', () => {
  const schedule = SCHEDULED();          // base(cash,bonds,growth) → 2035 bridge → 2050 late
  const r = new PoolFlowReducer({ graph: schedule[0].graph, schedule, expensesCurrency: 'USD' });

  const early = r.reduce(flowState(JAN(2030)),
    { type: 'US_PERIOD_ADVANCE', date: new Date(JAN(2030)) }, new Date(JAN(2030)));
  assert.deepEqual(Object.keys(early.liquidityPools).sort(), ['bonds', 'cash', 'growth']);

  // `late` drops `bonds` — so the cube it stamps has two pools, from the same reducer.
  const later = r.reduce(flowState(JAN(2055)),
    { type: 'US_PERIOD_ADVANCE', date: new Date(JAN(2055)) }, new Date(JAN(2055)));
  assert.deepEqual(Object.keys(later.liquidityPools).sort(), ['cash', 'growth']);
});

test('PSS-14b: a pool SIZED only in a later shape is unsized before it and sized after', () => {
  const schedule = SCHEDULED();
  const r = new PoolFlowReducer({ graph: schedule[0].graph, schedule, expensesCurrency: 'USD' });

  const early = r.reduce(flowState(JAN(2030)),
    { type: 'US_PERIOD_ADVANCE', date: new Date(JAN(2030)) }, new Date(JAN(2030)));
  assert.equal(early.liquidityPools.bonds.target, null, 'the base graph does not size it');

  const bridged = r.reduce(flowState(JAN(2036)),
    { type: 'US_PERIOD_ADVANCE', date: new Date(JAN(2036)) }, new Date(JAN(2036)));
  // 5 years of a 120k spend line.
  assert.equal(bridged.liquidityPools.bonds.target, 600_000);
});

test('PSS-14c: without a schedule the reducer is on its single graph, exactly as before', () => {
  const r = new PoolFlowReducer({ graph: SCHEDULED()[0].graph, expensesCurrency: 'USD' });
  for (const ms of [JAN(2030), JAN(2055)]) {
    const out = r.reduce(flowState(ms), { type: 'US_PERIOD_ADVANCE', date: new Date(ms) }, new Date(ms));
    assert.deepEqual(Object.keys(out.liquidityPools).sort(), ['bonds', 'cash', 'growth']);
  }
});

// ─── PSS-15 ──────────────────────────────────────────────────────────────────

test('PSS-15: the apply reducer resolves the PLAN\'s shape, not one of its own choosing', () => {
  // It has no date — it reads from/to off the action — so re-resolving would let the pair
  // disagree across a boundary and move money between pools that were never both live.
  const schedule = SCHEDULED();
  const r = new PoolFlowApplyReducer({
    accountService: { replenishSavings: () => ({ drawnKeys: [], pendingTaxActions: [] }) },
    graph: schedule[0].graph, schedule,
    accounts: [{ stateKey: 'usSavingsAccount', type: ACCOUNT_TYPE.SAVINGS },
               { stateKey: 'usStockAccount',   type: ACCOUNT_TYPE.BROKERAGE }],
  });

  assert.equal(r._graphForPlan({ shapeId: null }),     schedule[0].graph);
  assert.equal(r._graphForPlan({ shapeId: 'bridge' }), schedule[1].graph);
  assert.equal(r._graphForPlan({ shapeId: 'late' }),   schedule[2].graph);
});

test('PSS-15b: a plan naming a shape that is not in the schedule applies NOTHING', () => {
  const schedule = SCHEDULED();
  let called = false;
  const r = new PoolFlowApplyReducer({
    accountService: { replenishSavings: () => { called = true; return {}; } },
    graph: schedule[0].graph, schedule,
    accounts: [{ stateKey: 'usSavingsAccount', type: ACCOUNT_TYPE.SAVINGS }],
  });
  assert.equal(r._graphForPlan({ shapeId: 'gone' }), null);

  r.reduce({}, { type: 'POOL_FLOW_APPLY', from: 'growth', to: 'cash', amountBase: 1_000, shapeId: 'gone' },
    new Date(JAN(2040)));
  assert.equal(called, false, 'falling back would draw from a pool the author never wrote');
});

test('PSS-15c: with no schedule, and for an action with no shapeId, the behaviour is unchanged', () => {
  const schedule = SCHEDULED();
  const plain = new PoolFlowApplyReducer({ accountService: {}, graph: schedule[0].graph });
  assert.equal(plain._graphForPlan({ from: 'cash' }), schedule[0].graph);

  // A scheduled reducer handed a pre-design-109 action: it can only have come from the
  // opening shape.
  const scheduled = new PoolFlowApplyReducer({ accountService: {}, graph: schedule[0].graph, schedule });
  assert.equal(scheduled._graphForPlan({ from: 'cash' }), schedule[0].graph);
});

test('PSS-15d: the flow reducer stamps the shape on every plan it emits, and only when scheduled', () => {
  // A shape that actually FIRES an edge, or this test asserts nothing: `cash` is asked for two
  // years of spend, holds 50k of 240k, and is refilled from `growth` across accounts — which
  // is a TRANSFER, which is what emits a plan.
  const REFILLING = {
    pools: [
      { id: 'cash',   spendOrder: 10, target: { mode: 'YEARS_OF_SPEND', value: 2 },
        claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 40,
        claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH', 'BOND'] }] },
    ],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash',
              trigger: { below: { mode: 'YEARS_OF_SPEND', value: 2 } },
              amount: { toTarget: true } }],
  };
  const sched = resolveLiquidityGraphSchedule(paramsOf({
    liquidityShapes: { refilling: REFILLING },
    liquidityGraphSchedule: [{ year: 2035, shape: 'refilling' }],
  }), ACCOUNTS);

  const plansOf = (r, ms) => {
    const { next = [] } = r.reduce(flowState(ms),
      { type: 'US_PERIOD_ADVANCE', date: new Date(ms) }, new Date(ms));
    return next.filter(a => a.type === 'POOL_FLOW_APPLY');
  };

  const withSched = new PoolFlowReducer({ graph: sched[0].graph, schedule: sched, expensesCurrency: 'USD' });
  const scheduled = plansOf(withSched, JAN(2036));
  assert.equal(scheduled.length, 1, 'the edge fires under the live shape');
  assert.equal(scheduled[0].shapeId, 'refilling');

  // The same reducer BEFORE the row: the base graph has no flows, so nothing is emitted —
  // which is itself the shape-following behaviour.
  assert.deepEqual(plansOf(withSched, JAN(2030)), []);

  // And unscheduled, on the refilling graph directly: it fires, and carries no new key at all.
  const without = new PoolFlowReducer({ graph: sched[1].graph, expensesCurrency: 'USD' });
  const plain = plansOf(without, JAN(2036));
  assert.equal(plain.length, 1);
  assert.ok(!('shapeId' in plain[0]), 'an unscheduled run\'s action is byte-identical to before');
});

// ─── PSS-16 ──────────────────────────────────────────────────────────────────

test('PSS-16: the rebalancer reads the LIVE graph off state, with its own field as fallback', () => {
  const schedule = SCHEDULED();
  const r = new RebalanceToTargetReducer({ poolGraph: schedule[0].graph });

  // Design 109 §2 measured `state.liquidityGraph` as read by nothing; step 3 re-stamps it and
  // this is what makes that re-stamp load-bearing rather than decorative.
  assert.equal(r._poolGraphOf({ liquidityGraph: schedule[2].graph }), schedule[2].graph);
  // A hand-built state with no graph field falls back to the instance — every isolated
  // reducer test in the repo is that state.
  assert.equal(r._poolGraphOf({}), schedule[0].graph);
  assert.equal(r._poolGraphOf(null), schedule[0].graph);
});

test('PSS-16b: a plan whose pools only BEGIN at a later shape still gets its reducers', () => {
  // `poolGraph` is null at build here, so an instance-field reading would have left the
  // rebalancer permanently pool-blind on a plan that acquires pools in 2035.
  const r = new RebalanceToTargetReducer({ poolGraph: null });
  assert.equal(r._poolGraphOf({}), null);
  assert.ok(r._poolGraphOf({ liquidityGraph: SCHEDULED()[1].graph }));
});
