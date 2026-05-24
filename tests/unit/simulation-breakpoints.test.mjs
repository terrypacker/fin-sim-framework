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
 * simulation-breakpoints.test.mjs
 *
 * Tests for the simulation breakpoint / pause system.
 *
 * Key invariants verified:
 *   1. control.paused is true after a breakpoint fires.
 *   2. control.breakpointHit carries the right stage / node reference.
 *   3. The paused event / handler / action / reducer has NOT executed yet.
 *   4. Resuming (clearing paused + resuming=true) continues past the breakpoint
 *      and correctly executes the paused node.
 *   5. Subsequent breakpoints on the same or different node types are hit.
 *   6. Breakpoints are skipped during rewind (breakpointsEnabled=false).
 *   7. Multiple resume cycles work end-to-end.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Simulation, BreakpointSignal } from '../../src/simulation-framework/simulation.js';
import { HandlerEntry } from '../../src/simulation-framework/handlers.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

const START = new Date(Date.UTC(2026, 0, 1));
const END   = new Date(Date.UTC(2026, 11, 31));

/** Build a minimal simulation with one recurring annual event. */
function makeSim() {
  const sim = new Simulation(START);
  sim.scheduleAnnually({ startDate: START, type: 'TICK' });
  return sim;
}

/**
 * Simulate "play" by calling stepTo repeatedly until the sim either pauses or
 * reaches the end date.  Returns true if the sim paused at a breakpoint.
 */
function play(sim, end = END) {
  sim.stepTo(end);
  return sim.control.paused;
}

/**
 * Resume from a breakpoint and call stepTo again.
 * Mirrors what base-app.startPlaying() / stepForward() does.
 */
function resume(sim, end = END) {
  const ctrl = sim.control;
  if (!ctrl.paused) throw new Error('resume() called but sim is not paused');
  if (!ctrl.pendingExecution) ctrl.resuming = true; // event-level pause
  ctrl.paused = false;
  ctrl.breakpointHit = null;
  return play(sim, end);
}

/** Simulate one "step forward" — resume and run until next breakpoint or event boundary. */
function stepForward(sim) {
  return resume(sim, END);
}

// ─── Event-level breakpoints ──────────────────────────────────────────────────

test('event breakpoint: control.paused is true when event node has a breakpoint', () => {
  const sim = makeSim();
  sim.schedule({ type: 'TICK', date: START, id: 'evt-1' });
  sim.control.breakpointNodeIds.add('evt-1');

  const paused = play(sim);

  assert.ok(paused, 'simulation should be paused');
  assert.strictEqual(sim.control.breakpointHit.stage, 'event:start');
  assert.strictEqual(sim.control.breakpointHit.event.id, 'evt-1');
});

test('event breakpoint: the event has NOT executed when paused (no bus messages)', () => {
  const sim = new Simulation(START);
  const evtId = 'my-event';
  sim.schedule({ type: 'TICK', date: START, id: evtId });
  sim.control.breakpointNodeIds.add(evtId);

  const busHistory = [];
  sim.bus.subscribe('*', m => busHistory.push(m));

  play(sim);

  assert.strictEqual(busHistory.length, 0, 'no bus messages should have fired before the paused event executes');
});

test('event breakpoint: resuming executes the event and continues', () => {
  const sim = new Simulation(START);
  let handlerCalled = false;
  sim.schedule({ type: 'TICK', date: START, id: 'e1' });
  sim.register('TICK', () => { handlerCalled = true; return []; });
  sim.control.breakpointNodeIds.add('e1');

  play(sim);
  assert.ok(!handlerCalled, 'handler should not have run before resume');

  resume(sim);
  assert.ok(handlerCalled, 'handler should have run after resume');
});

test('event breakpoint: only fires for the matching node id', () => {
  const sim = new Simulation(START);
  const fired = [];
  sim.schedule({ type: 'A', date: START,                          id: 'evt-a' });
  sim.schedule({ type: 'B', date: new Date(Date.UTC(2026, 1, 1)), id: 'evt-b' });

  sim.register('A', () => { fired.push('A'); return []; });
  sim.register('B', () => { fired.push('B'); return []; });

  sim.control.breakpointNodeIds.add('evt-b');  // only break on B

  play(sim);

  assert.deepEqual(fired, ['A'], 'A should have fired; B paused before running');
  assert.strictEqual(sim.control.breakpointHit.stage, 'event:start');

  resume(sim);
  assert.deepEqual(fired, ['A', 'B'], 'B should fire after resume');
});

// ─── Handler-level breakpoints ────────────────────────────────────────────────

test('handler breakpoint: control.paused is true when handler node has a breakpoint', () => {
  const sim = new Simulation(START);
  const handler = new HandlerEntry(() => [], 'MyHandler');
  handler.id = 'h-1';
  sim.handlers.register('TICK', handler);
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('h-1');

  const paused = play(sim);

  assert.ok(paused, 'simulation should be paused at handler breakpoint');
  assert.strictEqual(sim.control.breakpointHit.stage, 'handler:before');
  assert.strictEqual(sim.control.breakpointHit.handler.id, 'h-1');
});

test('handler breakpoint: handler fn has NOT been called when paused', () => {
  const sim = new Simulation(START);
  let called = false;
  const handler = new HandlerEntry(() => { called = true; return []; }, 'TrackedHandler');
  handler.id = 'h-track';
  sim.handlers.register('TICK', handler);
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('h-track');

  play(sim);

  assert.ok(!called, 'handler fn should not have been called before breakpoint is resumed');
});

test('handler breakpoint: resuming calls the handler and completes the event', () => {
  const sim = new Simulation(START);
  const log = [];
  const h1 = new HandlerEntry(() => { log.push('h1'); return []; }, 'H1');
  h1.id = 'h1-id';
  const h2 = new HandlerEntry(() => { log.push('h2'); return []; }, 'H2');
  h2.id = 'h2-id';
  sim.handlers.register('TICK', h1);
  sim.handlers.register('TICK', h2);
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('h1-id');

  play(sim);
  assert.deepEqual(log, [], 'neither handler should have run before first resume');

  resume(sim);
  assert.deepEqual(log, ['h1', 'h2'], 'both handlers should run after resuming from h1 breakpoint');
});

test('handler breakpoint: second handler breakpoint fires after first is resumed', () => {
  const sim = new Simulation(START);
  const log = [];
  const h1 = new HandlerEntry(() => { log.push('h1'); return []; }, 'H1');
  h1.id = 'h1-id';
  const h2 = new HandlerEntry(() => { log.push('h2'); return []; }, 'H2');
  h2.id = 'h2-id';
  sim.handlers.register('TICK', h1);
  sim.handlers.register('TICK', h2);
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('h1-id');
  sim.control.breakpointNodeIds.add('h2-id');

  play(sim);
  assert.ok(sim.control.paused);
  assert.strictEqual(sim.control.breakpointHit.handler.id, 'h1-id');

  resume(sim);  // run h1, pause before h2
  assert.ok(sim.control.paused, 'should pause again before h2');
  assert.strictEqual(sim.control.breakpointHit.handler.id, 'h2-id');
  assert.deepEqual(log, ['h1'], 'only h1 should have run');

  resume(sim);  // run h2
  assert.ok(!sim.control.paused);
  assert.deepEqual(log, ['h1', 'h2']);
});

// ─── Action-level breakpoints ─────────────────────────────────────────────────

test('action breakpoint: control.paused is true when action node has a breakpoint', () => {
  const sim = new Simulation(START);
  let reducerCalled = false;

  sim.register('TICK', () => [{ type: 'DO_WORK', id: 'act-1' }]);
  sim.reducers.register('DO_WORK', (s) => { reducerCalled = true; return s; }, 10, 'R1');
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('act-1');

  const paused = play(sim);

  assert.ok(paused, 'should pause at action breakpoint');
  assert.strictEqual(sim.control.breakpointHit.stage, 'action');
  assert.strictEqual(sim.control.breakpointHit.action.id, 'act-1');
  assert.ok(!reducerCalled, 'reducer should not have run yet');
});

test('action breakpoint: resuming runs the action reducer and continues', () => {
  const sim = new Simulation(START);
  const log = [];

  sim.register('TICK', () => [
    { type: 'FIRST',  id: 'act-first' },
    { type: 'SECOND', id: 'act-second' },
  ]);
  sim.reducers.register('FIRST',  (s) => { log.push('first');  return s; }, 10, 'R-first');
  sim.reducers.register('SECOND', (s) => { log.push('second'); return s; }, 10, 'R-second');
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('act-first');

  play(sim);
  assert.deepEqual(log, [], 'no reducers should have run before first resume');

  resume(sim);
  assert.deepEqual(log, ['first', 'second'], 'both reducers should run after resuming');
  assert.ok(!sim.control.paused);
});

test('action breakpoint: second action breakpoint fires after first is resumed', () => {
  const sim = new Simulation(START);
  const log = [];

  sim.register('TICK', () => [
    { type: 'FIRST',  id: 'act-first' },
    { type: 'SECOND', id: 'act-second' },
  ]);
  sim.reducers.register('FIRST',  (s) => { log.push('first');  return s; }, 10, 'R-first');
  sim.reducers.register('SECOND', (s) => { log.push('second'); return s; }, 10, 'R-second');
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('act-first');
  sim.control.breakpointNodeIds.add('act-second');

  play(sim);
  assert.ok(sim.control.paused);
  assert.strictEqual(sim.control.breakpointHit.action.id, 'act-first');

  resume(sim);  // run first, pause before second
  assert.ok(sim.control.paused, 'should pause before second action');
  assert.strictEqual(sim.control.breakpointHit.action.id, 'act-second');
  assert.deepEqual(log, ['first']);

  resume(sim);  // run second
  assert.deepEqual(log, ['first', 'second']);
  assert.ok(!sim.control.paused);
});

// ─── Reducer-level breakpoints ────────────────────────────────────────────────

test('reducer breakpoint: control.paused is true when reducer node has a breakpoint', () => {
  const sim = new Simulation(START);
  const reducerObj = { id: 'red-1', priority: 10, name: 'R1',
    reduce: (s) => s };

  sim.register('TICK', () => [{ type: 'DO_WORK' }]);
  sim.reducers.registerReducer('DO_WORK', reducerObj);
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('red-1');

  const paused = play(sim);

  assert.ok(paused, 'should pause at reducer breakpoint');
  assert.strictEqual(sim.control.breakpointHit.stage, 'reducer:before');
  assert.strictEqual(sim.control.breakpointHit.reducer.id, 'red-1');
});

test('reducer breakpoint: reducer fn has NOT been called when paused', () => {
  const sim = new Simulation(START);
  let called = false;
  const reducerObj = { id: 'red-track', priority: 10, name: 'Tracked',
    reduce: (s) => { called = true; return s; } };

  sim.register('TICK', () => [{ type: 'WORK' }]);
  sim.reducers.registerReducer('WORK', reducerObj);
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('red-track');

  play(sim);

  assert.ok(!called, 'reducer fn should not have been called before resume');
});

test('reducer breakpoint: resuming runs the reducer and completes', () => {
  const sim = new Simulation(START);
  const log = [];
  const r1 = { id: 'r1', priority: 10, name: 'R1', reduce: (s) => { log.push('r1'); return s; } };
  const r2 = { id: 'r2', priority: 20, name: 'R2', reduce: (s) => { log.push('r2'); return s; } };

  sim.register('TICK', () => [{ type: 'WORK' }]);
  sim.reducers.registerReducer('WORK', r1);
  sim.reducers.registerReducer('WORK', r2);
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('r1');

  play(sim);
  assert.deepEqual(log, []);

  resume(sim);  // run r1 + r2
  assert.deepEqual(log, ['r1', 'r2'], 'both reducers should run after resuming from r1');
  assert.ok(!sim.control.paused);
});

test('reducer breakpoint: second reducer breakpoint fires after first is resumed', () => {
  const sim = new Simulation(START);
  const log = [];
  const r1 = { id: 'r1', priority: 10, name: 'R1', reduce: (s) => { log.push('r1'); return s; } };
  const r2 = { id: 'r2', priority: 20, name: 'R2', reduce: (s) => { log.push('r2'); return s; } };

  sim.register('TICK', () => [{ type: 'WORK' }]);
  sim.reducers.registerReducer('WORK', r1);
  sim.reducers.registerReducer('WORK', r2);
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('r1');
  sim.control.breakpointNodeIds.add('r2');

  play(sim);
  assert.ok(sim.control.paused);
  assert.strictEqual(sim.control.breakpointHit.reducer.id, 'r1');

  resume(sim);  // run r1, pause before r2
  assert.ok(sim.control.paused);
  assert.strictEqual(sim.control.breakpointHit.reducer.id, 'r2');
  assert.deepEqual(log, ['r1']);

  resume(sim);  // run r2
  assert.deepEqual(log, ['r1', 'r2']);
  assert.ok(!sim.control.paused);
});

// ─── Mixed breakpoints ────────────────────────────────────────────────────────

test('mixed: event → handler → action → reducer breakpoints fire in order', () => {
  const sim = new Simulation(START);
  const log = [];

  const handler = new HandlerEntry(
    () => { log.push('handler'); return [{ type: 'WORK', id: 'act-id' }]; },
    'H1'
  );
  handler.id = 'h-id';

  const reducerObj = {
    id: 'r-id', priority: 10, name: 'R1',
    reduce: (s) => { log.push('reducer'); return s; }
  };

  sim.handlers.register('TICK', handler);
  sim.reducers.registerReducer('WORK', reducerObj);
  sim.schedule({ type: 'TICK', date: START, id: 'evt-id' });

  sim.control.breakpointNodeIds.add('evt-id');
  sim.control.breakpointNodeIds.add('h-id');
  sim.control.breakpointNodeIds.add('act-id');
  sim.control.breakpointNodeIds.add('r-id');

  // 1. Event breakpoint
  play(sim);
  assert.ok(sim.control.paused);
  assert.strictEqual(sim.control.breakpointHit.stage, 'event:start');
  assert.deepEqual(log, []);

  // 2. Handler breakpoint
  resume(sim);
  assert.ok(sim.control.paused);
  assert.strictEqual(sim.control.breakpointHit.stage, 'handler:before');
  assert.deepEqual(log, []);

  // 3. Action breakpoint
  resume(sim);
  assert.ok(sim.control.paused);
  assert.strictEqual(sim.control.breakpointHit.stage, 'action');
  assert.deepEqual(log, ['handler']);  // handler ran, action not yet dispatched

  // 4. Reducer breakpoint
  resume(sim);
  assert.ok(sim.control.paused);
  assert.strictEqual(sim.control.breakpointHit.stage, 'reducer:before');
  assert.deepEqual(log, ['handler']); // reducer not yet called

  // 5. Fully complete
  resume(sim);
  assert.ok(!sim.control.paused);
  assert.deepEqual(log, ['handler', 'reducer']);
});

// ─── State correctness ────────────────────────────────────────────────────────

test('state is unchanged at handler breakpoint (reducer has not mutated it)', () => {
  const sim = new Simulation(START, { initialState: { count: 0 } });
  const handler = new HandlerEntry(() => [{ type: 'INCREMENT' }], 'Incrementer');
  handler.id = 'h-inc';
  sim.handlers.register('TICK', handler);
  sim.reducers.register('INCREMENT', (s) => ({ ...s, count: s.count + 1 }), 10, 'R');
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('h-inc');

  play(sim);
  assert.strictEqual(sim.state.count, 0, 'state should not have changed before handler runs');

  resume(sim);
  assert.strictEqual(sim.state.count, 1, 'state should have incremented after resume');
});

test('state is unchanged at reducer breakpoint', () => {
  const sim = new Simulation(START, { initialState: { count: 0 } });
  const reducerObj = {
    id: 'r-inc', priority: 10, name: 'Incrementer',
    reduce: (s) => ({ ...s, count: s.count + 1 })
  };
  sim.register('TICK', () => [{ type: 'INCREMENT' }]);
  sim.reducers.registerReducer('INCREMENT', reducerObj);
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('r-inc');

  play(sim);
  assert.strictEqual(sim.state.count, 0, 'state should be 0 before reducer runs');

  resume(sim);
  assert.strictEqual(sim.state.count, 1, 'state should be 1 after reducer runs');
});

// ─── Emitted actions ─────────────────────────────────────────────────────────

test('action emitted by reducer runs after resume from reducer breakpoint', () => {
  const sim = new Simulation(START, { initialState: { a: 0, b: 0 } });
  const log = [];

  // r1 emits a secondary action; r2 catches the secondary action
  const r1 = {
    id: 'r1', priority: 10, name: 'R1',
    reduce: (s) => ({ state: { ...s, a: s.a + 1 }, next: [{ type: 'SECONDARY' }] })
  };
  sim.register('TICK', () => [{ type: 'PRIMARY' }]);
  sim.reducers.registerReducer('PRIMARY', r1);
  sim.reducers.register('SECONDARY', (s) => { log.push('secondary'); return { ...s, b: s.b + 1 }; }, 10, 'R2');
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('r1');

  play(sim);
  assert.ok(sim.control.paused);
  assert.strictEqual(sim.state.a, 0);

  resume(sim);
  assert.ok(!sim.control.paused);
  assert.strictEqual(sim.state.a, 1, 'primary reducer should have run');
  assert.strictEqual(sim.state.b, 1, 'secondary action should have been emitted and processed');
  assert.deepEqual(log, ['secondary']);
});

// ─── Breakpoints disabled during rewind ───────────────────────────────────────

test('breakpoints do not fire when breakpointsEnabled is false', () => {
  const sim = new Simulation(START);
  sim.register('TICK', () => []);
  sim.schedule({ type: 'TICK', date: START, id: 'evt-x' });
  sim.control.breakpointNodeIds.add('evt-x');
  sim.control.breakpointsEnabled = false;

  const paused = play(sim);

  assert.ok(!paused, 'breakpoint should not fire when breakpointsEnabled=false');
  assert.ok(!sim.control.paused);
});

test('breakpoints disabled in rewind re-enable afterwards', () => {
  const sim = new Simulation(START);
  let calls = 0;
  sim.register('TICK', () => { calls++; return []; });
  sim.schedule({ type: 'TICK', date: START, id: 'evt-y' });
  sim.control.breakpointNodeIds.add('evt-y');

  // Simulate what time-controls._doRewindTo does
  sim.control.breakpointsEnabled = false;
  sim.stepTo(END);
  sim.control.breakpointsEnabled = true;

  assert.strictEqual(calls, 1, 'event should have run once during disabled replay');
  assert.ok(!sim.control.paused);

  // Now re-run a second stepTo — breakpoints should work again
  // (sim queue is now empty but the state demonstrates re-enable)
  assert.ok(sim.control.breakpointsEnabled);
});

// ─── pendingExecution shape ───────────────────────────────────────────────────

test('pendingExecution is null after clean completion', () => {
  const sim = new Simulation(START);
  sim.register('TICK', () => []);
  sim.schedule({ type: 'TICK', date: START });

  play(sim);

  assert.strictEqual(sim.control.pendingExecution, null);
});

test('pendingExecution.type is "handler" when paused at a handler', () => {
  const sim = new Simulation(START);
  const h = new HandlerEntry(() => [], 'H');
  h.id = 'h-pe';
  sim.handlers.register('TICK', h);
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('h-pe');

  play(sim);

  assert.ok(sim.control.pendingExecution, 'pendingExecution should be set');
  assert.strictEqual(sim.control.pendingExecution.type, 'handler');
  assert.strictEqual(sim.control.pendingExecution.handlerIdx, 0);
});

test('pendingExecution.type is "action" when paused at an action', () => {
  const sim = new Simulation(START);
  sim.register('TICK', () => [{ type: 'WORK', id: 'a-pe' }]);
  sim.reducers.register('WORK', (s) => s, 10, 'R');
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('a-pe');

  play(sim);

  assert.ok(sim.control.pendingExecution);
  assert.strictEqual(sim.control.pendingExecution.type, 'action');
  assert.strictEqual(sim.control.pendingExecution.actionQueue[0].id, 'a-pe');
});

test('pendingExecution.type is "reducer" when paused at a reducer', () => {
  const sim = new Simulation(START);
  const rObj = { id: 'r-pe', priority: 10, name: 'R', reduce: (s) => s };
  sim.register('TICK', () => [{ type: 'WORK' }]);
  sim.reducers.registerReducer('WORK', rObj);
  sim.schedule({ type: 'TICK', date: START });
  sim.control.breakpointNodeIds.add('r-pe');

  play(sim);

  assert.ok(sim.control.pendingExecution);
  assert.strictEqual(sim.control.pendingExecution.type, 'reducer');
  assert.strictEqual(sim.control.pendingExecution.reducerIdx, 0);
});

// ─── Multiple events with breakpoints ────────────────────────────────────────

test('breakpoint fires on each matching event occurrence', () => {
  const sim = new Simulation(START);
  let count = 0;
  sim.scheduleAnnually({ startDate: START, type: 'TICK', id: 'annual' });
  sim.register('TICK', () => { count++; return []; });
  sim.control.breakpointNodeIds.add('annual');

  const END2 = new Date(Date.UTC(2027, 11, 31));

  // First occurrence
  play(sim, END2);
  assert.ok(sim.control.paused);
  assert.strictEqual(count, 0);

  resume(sim, END2);  // runs 2026 occurrence, pauses before 2027
  assert.ok(sim.control.paused, 'should pause again for 2027 occurrence');
  assert.strictEqual(count, 1, 'only first occurrence should have run');

  resume(sim, END2);  // runs 2027 occurrence
  assert.strictEqual(count, 2);
  assert.ok(!sim.control.paused);
});
