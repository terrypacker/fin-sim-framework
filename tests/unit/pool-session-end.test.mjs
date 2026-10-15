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
 * pool-session-end.test.mjs
 *
 * DESIGN 123 — what a cockpit session's pool rows mean after the session.
 *
 * PSE-1  the advisory: a session's final row that departs from the plan's own rows, unmarked
 * PSE-2  never for an authored row, a marked row, or a session row equal to the authored value
 * PSE-3  End → hold marks the session's final rows, adds none, and silences the advisory
 * PSE-4  End → revert closes at the AUTHORED factor/shape (×1 only when the plan has no row)
 * PSE-5  a pool the plan's own row already governs at the closing year gets no closing row
 * PSE-6  ending twice replaces the first choice; a revert year before the last decision throws
 * PSE-7  `endPoolSession` writes scenario.params (one store) and leaves the rows' values on hold
 * PSE-8  the run record: no `end` ⇒ today's entry; revert ⇒ `source.end` + keyed closing rows
 * PSE-9  replay: the closing rows fold at compile and change the stamped target only from the
 *        closing year
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { sessionTails, describeSessionTail, endSessionRows, lastSessionYear, authoredFactorAt }
  from '../../src/finance/pools/pool-session-end.js';
import { COCKPIT_CONTROLS, endPoolSession } from '../../src/finance/mpc/cockpit-controller.js';
import { buildRunEntry }        from '../../src/finance/mpc/run-record.js';
import { foldQueueLeverRuns }   from '../../src/finance/mpc/run-compile-fold.js';
import { OptimizationProblem }  from '../../src/finance/optimization/optimization-problem.js';
import { OPTIMIZATION_OBJECTIVES } from '../../src/finance/optimization/optimization-objectives.js';

const RUN = 'run:1';
const session = (from, to, scale, pool = 'reserve') => {
  const out = [];
  for (let y = from; y <= to; y++) out.push({ year: y, pool, scale, by: RUN });
  return out;
};

// ─── PSE-1 / PSE-2 — the advisory ────────────────────────────────────────────

test('PSE-1: a session\'s final ×2 row holds past the session, and the advisory says so', () => {
  const tails = sessionTails({ targets: session(2030, 2035, 2) });
  assert.deepEqual(tails, [{ kind: 'target', pool: 'reserve', scale: 2, authored: 1, year: 2035, by: RUN }]);
  assert.equal(describeSessionTail(tails[0], { planEndYear: 2060 }),
    'Liquidity Pool Target: the session\'s last decision for reserve (×2, 2035) holds to 2060 — the '
    + 'controller priced it as held for the rest of the plan. End the session in the MPC cockpit to '
    + 'choose hold or revert.');
  assert.match(describeSessionTail(tails[0]), /holds to the end of the plan/, 'no end year ⇒ named generically');

  const shapes = [{ year: 2030, shape: 'bridge', by: RUN }];
  assert.deepEqual(sessionTails({ shapes }),
    [{ kind: 'shape', shape: 'bridge', authored: null, year: 2030, by: RUN }]);
});

test('PSE-2: no advisory for authored rows, marked rows, or a session equal to the plan', () => {
  assert.deepEqual(sessionTails({ targets: [{ year: 2030, pool: 'reserve', scale: 2 }] }), [],
    'an author who writes ×2 means it (§6 Q1)');
  const held = session(2030, 2035, 2); held[held.length - 1].end = 'hold';
  assert.deepEqual(sessionTails({ targets: held }), [], 'an explicit End choice silences it');
  assert.deepEqual(sessionTails({ targets: [{ year: 2025, pool: 'reserve', scale: 1.5 },
    ...session(2030, 2035, 1.5)] }), [], 'the session holds what the plan already held');
  assert.deepEqual(sessionTails({ targets: [...session(2030, 2035, 2),
    { year: 2040, pool: 'reserve', scale: 1 }] }), [], 'an authored row already ends the tail');
  assert.deepEqual(sessionTails({ targets: 'junk', shapes: [null, { year: 'x' }] }), [], 'never throws');
  // Per pool: one pool's tail does not hide or invent another's.
  const two = sessionTails({ targets: [...session(2030, 2031, 2, 'cash'), ...session(2030, 2031, 1, 'reserve')] });
  assert.deepEqual(two.map(t => t.pool), ['cash']);
});

// ─── PSE-3 — hold ────────────────────────────────────────────────────────────

test('PSE-3: End → hold marks the session\'s final rows, adds none, and silences the advisory', () => {
  const targets = [{ year: 2025, pool: 'cash', scale: 1.2 }, ...session(2030, 2035, 2)];
  const shapes  = [{ year: 2028, shape: 'early' }, { year: 2033, shape: 'bridge', by: RUN }];
  const out = endSessionRows({ targets, shapes, runId: RUN, policy: 'hold' });
  assert.equal(out.targets.length, targets.length, 'no rows added');
  assert.deepEqual(out.closing, []);
  assert.deepEqual(out.end, { policy: 'hold', afterYear: 2035 });
  assert.equal(out.targets.find(r => r.year === 2035).end, 'hold');
  assert.equal(out.targets.filter(r => r.end).length, 1, 'only the final row is marked');
  assert.equal(out.targets.find(r => r.pool === 'cash').end, undefined, 'an authored row is not marked');
  assert.equal(out.shapes.find(r => r.year === 2033).end, 'hold');
  assert.deepEqual(sessionTails(out), []);
  assert.equal(targets[targets.length - 1].end, undefined, 'the caller\'s rows are not mutated');
});

// ─── PSE-4 / PSE-5 — revert ──────────────────────────────────────────────────

test('PSE-4: End → revert closes at the factor the plan\'s own rows hold, not ×1', () => {
  const targets = [{ year: 2025, pool: 'reserve', scale: 1.5 }, ...session(2030, 2035, 2),
                   ...session(2031, 2035, 3, 'cash')];
  const shapes  = [{ year: 2028, shape: 'early' }, { year: 2033, shape: 'bridge', by: RUN }];
  const out = endSessionRows({ targets, shapes, runId: RUN, policy: 'revert' });
  assert.deepEqual(out.closing, [
    { lever: 'POOL_TARGET', year: 2036, pool: 'cash', value: 1 },
    { lever: 'POOL_TARGET', year: 2036, pool: 'reserve', value: 1.5 },
    { lever: 'POOL_SHAPE', year: 2036, value: 'early' },
  ]);
  assert.deepEqual(out.targets.filter(r => r.year === 2036), [
    { year: 2036, pool: 'cash', scale: 1, by: RUN, end: 'revert' },
    { year: 2036, pool: 'reserve', scale: 1.5, by: RUN, end: 'revert' },
  ]);
  assert.deepEqual(out.shapes.at(-1), { year: 2036, shape: 'early', by: RUN, end: 'revert' });
  assert.deepEqual(sessionTails(out), []);
  // Every session row is untouched: End only appends.
  const order = (rows) => [...rows].sort((a, b) => a.year - b.year || a.pool.localeCompare(b.pool));
  assert.deepEqual(out.targets.filter(r => r.by === RUN && !r.end), order(targets.filter(r => r.by === RUN)));
});

test('PSE-4b: revert after a later year closes the session from the year after it', () => {
  const out = endSessionRows({ targets: session(2030, 2035, 2), runId: RUN, policy: 'revert', afterYear: 2040 });
  assert.deepEqual(out.closing, [{ lever: 'POOL_TARGET', year: 2041, pool: 'reserve', value: 1 }]);
  assert.deepEqual(out.end, { policy: 'revert', afterYear: 2040 });
});

test('PSE-5: a pool the plan\'s own row governs at the closing year gets no closing row', () => {
  const targets = [...session(2030, 2035, 2), { year: 2036, pool: 'reserve', scale: 1.25 }];
  const out = endSessionRows({ targets, runId: RUN, policy: 'revert' });
  assert.deepEqual(out.closing, []);
  assert.equal(out.targets.length, targets.length);
  // And no closing row where the session already holds the authored value.
  const same = endSessionRows({ targets: [{ year: 2020, pool: 'reserve', scale: 2 }, ...session(2030, 2031, 2)],
    runId: RUN, policy: 'revert' });
  assert.deepEqual(same.closing, []);
});

// ─── PSE-6 — idempotence and the year rule ──────────────────────────────────

test('PSE-6: ending twice replaces the first choice rather than stacking', () => {
  const first  = endSessionRows({ targets: session(2030, 2035, 2), runId: RUN, policy: 'revert' });
  const again  = endSessionRows({ targets: first.targets, runId: RUN, policy: 'revert', afterYear: 2037 });
  assert.equal(again.targets.filter(r => r.end === 'revert').length, 1, 'one closing row');
  assert.equal(again.targets.find(r => r.end === 'revert').year, 2038);
  const held = endSessionRows({ targets: again.targets, runId: RUN, policy: 'hold' });
  assert.equal(held.targets.filter(r => r.end === 'revert').length, 0, 'hold removes the closing row');
  assert.equal(held.targets.at(-1).end, 'hold');
  const back = endSessionRows({ targets: held.targets, runId: RUN, policy: 'revert' });
  assert.equal(back.targets.filter(r => r.end === 'hold').length, 0, 'revert strips the hold mark');
  assert.equal(lastSessionYear(back, RUN), 2035, 'a closing row is not a decision');
});

test('PSE-6b: a revert year before the session\'s last decision is refused, and so is no session', () => {
  assert.throws(() => endSessionRows({ targets: session(2030, 2035, 2), runId: RUN, policy: 'revert', afterYear: 2033 }),
    /cannot revert after 2033 — the session decided 2035/);
  assert.throws(() => endSessionRows({ targets: [{ year: 2030, pool: 'reserve', scale: 2 }], runId: RUN, policy: 'hold' }),
    /wrote no pool rows/);
  assert.throws(() => endSessionRows({ targets: session(2030, 2030, 2), runId: RUN, policy: 'stop' }), /neither/);
  assert.equal(authoredFactorAt(session(2030, 2035, 2), 'reserve', 2036, RUN), 1);
});

// ─── PSE-7 — the scenario writer ─────────────────────────────────────────────

test('PSE-7: endPoolSession writes scenario.params; hold leaves every value as it was', () => {
  const rows = session(2030, 2032, 2);
  const scenario = { params: [{ name: 'liquidityTargetSchedule', value: rows }] };
  const held = endPoolSession({ scenario, runId: RUN, policy: 'hold' });
  assert.equal(held.restamped, false, 'nothing to restamp: no row changed value');
  const after = scenario.params[0].value;
  assert.deepEqual(after.map(({ end, ...r }) => r), rows);   // eslint-disable-line no-unused-vars
  assert.equal(after.at(-1).end, 'hold');

  const rev = endPoolSession({ scenario, runId: RUN, policy: 'revert' });
  assert.deepEqual(rev.closing, [{ lever: 'POOL_TARGET', year: 2033, pool: 'reserve', value: 1 }]);
  assert.equal(scenario.params[0].value.at(-1).end, 'revert');
});

// ─── PSE-8 / PSE-9 — the run record and its replay ──────────────────────────

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2040, 0, 1));
const BASE = {
  spendingStrategy:     ['EXPLICIT_BANDS'],
  spendingExpenseBands: [{ startAge: 45, monthlyAmount: 9000 }],
  behavioralStrategies: ['TARGET_ALLOCATION', 'LIQUIDITY_POOLS'],
  liquidityGraph: { pools: [
    { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'buffer', spendOrder: 20, target: { mode: 'YEARS_OF_SPEND', value: 5 },
      claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
  ] },
};

/** Two epochs deciding buffer ×2 for 2031 and 2032. */
const RECORDS = [2030, 2031].map(y => {
  const v = { paramKey: 'liquidityTargetSchedule[0].scale', _year: y + 1, _pool: 'buffer', _controlKey: 'POOL_TARGET' };
  return { asOfDate: `${y}-12-31T00:00:00.000Z`, runId: RUN, controlKeys: ['POOL_TARGET'],
           controlVars: [v], controlParams: { [v.paramKey]: 2 } };
});

test('PSE-8: no End choice ⇒ the entry is exactly today\'s; revert ⇒ source.end + keyed closing rows', () => {
  const opts = { controlsByKey: COCKPIT_CONTROLS, runId: RUN, recordedAt: '2026-10-15T00:00:00.000Z' };
  const plain = buildRunEntry(RECORDS, opts).entry;
  assert.equal(plain.source.end, undefined);
  assert.deepEqual(buildRunEntry(RECORDS, { ...opts, end: null }).entry, plain);

  const held = buildRunEntry(RECORDS, { ...opts, end: { policy: 'hold', afterYear: 2032, closing: [] } }).entry;
  assert.deepEqual(held.source.end, { policy: 'hold', afterYear: 2032 });
  assert.deepEqual(held.decisions, plain.decisions, 'hold adds no decision');

  const closing = [{ lever: 'POOL_TARGET', year: 2033, pool: 'buffer', value: 1 }];
  const rev = buildRunEntry(RECORDS, { ...opts, end: { policy: 'revert', afterYear: 2032, closing } }).entry;
  assert.deepEqual(rev.source.end, { policy: 'revert', afterYear: 2032 });
  assert.deepEqual(rev.decisions.at(-1),
    { date: RECORDS[1].asOfDate, lever: 'POOL_TARGET', key: 'year@2033::buffer', value: 1, end: 'revert' });
  assert.equal(rev.source.rows, rev.decisions.length);

  const fold = (entry) => foldQueueLeverRuns({ ...BASE, mpcRuns: { [RUN]: entry }, mpcActiveRun: RUN })
    .liquidityTargetSchedule;
  assert.deepEqual(fold(rev), [...fold(plain), { year: 2033, pool: 'buffer', scale: 1 }]);
});

const quiet = (fn) => {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; }
};
const bufferAt = (params, asOf) => quiet(() => new OptimizationProblem({
  variables: [], baseParams: params, objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
  simStart: SIM_START, simEnd: SIM_END, initialState: { kind: 'compile', cfgTemplate: null },
}).rollToSnapshot({}, asOf)).state.liquidityGraph?.pools?.find(p => p.id === 'buffer')?.target?.value;

test('PSE-9: a revert replay changes the stamped target only from the closing year', () => {
  const opts = { controlsByKey: COCKPIT_CONTROLS, runId: RUN };
  const closing = [{ lever: 'POOL_TARGET', year: 2033, pool: 'buffer', value: 1 }];
  const plan = (entry) => ({ ...BASE, mpcRuns: { [RUN]: entry }, mpcActiveRun: RUN, mpcRunEnabled: true });
  const hold = plan(buildRunEntry(RECORDS, opts).entry);
  const rev  = plan(buildRunEntry(RECORDS, { ...opts, end: { policy: 'revert', afterYear: 2032, closing } }).entry);

  const mid32 = new Date(Date.UTC(2032, 5, 1));
  const mid33 = new Date(Date.UTC(2033, 5, 1));
  assert.equal(bufferAt(hold, mid32), 10, 'the session\'s ×2 is in force');
  assert.equal(bufferAt(rev,  mid32), 10, 'identical before the closing year');
  assert.equal(bufferAt(hold, mid33), 10, 'held: ×2 to the end of the plan');
  assert.equal(bufferAt(rev,  mid33), 5,  'reverted: the authored target from 2033');
});
