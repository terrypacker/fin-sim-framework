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
 * `replayDecisions` — the A′ term (design/80 F6, §2.11).
 *
 * Replay is the MPC loop with the solve deleted: apply the value the controller
 * actually committed, roll to the next epoch, repeat. It is what separates "the
 * run was bad" from "the BAKE of the run was bad", and it is the tool that found
 * the answer in design/80 §2.11 after four reconstructions got it wrong.
 *
 * These tests stub the rollout so they pin the DRIVER — epoch ordering, the
 * accumulation of committed params, and the roll-to-simEnd on the final epoch —
 * without paying for real simulations.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { replayDecisions } from '../../src/finance/mpc/replay.js';
import { OptimizationProblem } from '../../src/finance/optimization/optimization-problem.js';
import { OPTIMIZATION_OBJECTIVES } from '../../src/finance/optimization/optimization-objectives.js';

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2030, 0, 1));

const rec = (year, controlParams) => ({
  asOfDate: new Date(Date.UTC(year, 0, 1)).toISOString(),
  controlParams, runId: 'r1',
});

/**
 * Swap the two expensive methods for recorders. Returns the call log so a test can
 * assert on what the driver asked for, in order.
 */
function instrument() {
  const calls = [];
  const origRoll = OptimizationProblem.prototype.rollToSnapshot;
  const origEval = OptimizationProblem.prototype.evaluate;

  OptimizationProblem.prototype.rollToSnapshot = function (candidate, toDate) {
    calls.push({ kind: 'roll', to: new Date(toDate), base: JSON.parse(JSON.stringify(this.baseParams)) });
    return { date: new Date(toDate), state: { cumulativeDeficit: 0 }, queue: [], rngState: 0 };
  };
  OptimizationProblem.prototype.evaluate = function () {
    calls.push({ kind: 'evaluate', base: JSON.parse(JSON.stringify(this.baseParams)) });
    return { result: { finalNetWorthUsd: 42, cumulativeDeficit: 0, scenarioFailed: false }, score: 42 };
  };
  return {
    calls,
    restore() {
      OptimizationProblem.prototype.rollToSnapshot = origRoll;
      OptimizationProblem.prototype.evaluate = origEval;
    },
  };
}

describe('replayDecisions', () => {
  test('applies each epoch in date order and evaluates once, at the end', () => {
    const spy = instrument();
    try {
      const out = replayDecisions(
        // Deliberately out of order: the log is a store, not a queue.
        [rec(2028, { a: 3 }), rec(2026, { a: 1 }), rec(2027, { a: 2 })],
        { baseParams: { a: 0 }, simStart: SIM_START, simEnd: SIM_END,
          objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH });

      assert.equal(out.epochs.length, 3);
      assert.deepEqual(out.epochs.map(e => e.asOfDate.getUTCFullYear()), [2026, 2027, 2028]);
      assert.equal(spy.calls.filter(c => c.kind === 'evaluate').length, 1,
        'exactly one terminal evaluation');
      assert.equal(spy.calls[spy.calls.length - 1].kind, 'evaluate',
        'the evaluation is last');
    } finally { spy.restore(); }
  });

  test('the final epoch rolls to simEnd, so the result is the REALIZED terminal', () => {
    // If the last epoch stopped at its own date the result would be one more
    // projection, not the path the decisions actually produced — the whole point
    // of A′ (design/80 §2.11).
    const spy = instrument();
    try {
      replayDecisions([rec(2026, { a: 1 }), rec(2027, { a: 2 })],
        { baseParams: {}, simStart: SIM_START, simEnd: SIM_END,
          objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH });
      const rolls = spy.calls.filter(c => c.kind === 'roll');
      // seed-to-first-epoch, then epoch1 → epoch2. Epoch 2 evaluates instead.
      assert.deepEqual(rolls.map(r => r.to.getUTCFullYear()), [2026, 2027]);
    } finally { spy.restore(); }
  });

  test('committed params ACCUMULATE across epochs', () => {
    // Each epoch commits only its own controls; everything decided earlier has to
    // persist, exactly as `apply()` accumulates into `this.committed`.
    const spy = instrument();
    try {
      replayDecisions([rec(2026, { a: 1 }), rec(2027, { b: 2 }), rec(2028, { a: 9 })],
        { baseParams: { z: 0 }, simStart: SIM_START, simEnd: SIM_END,
          objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH });
      const final = spy.calls[spy.calls.length - 1].base;
      assert.deepEqual(final, { z: 0, a: 9, b: 2 }, 'later epochs override, earlier survive');
    } finally { spy.restore(); }
  });

  test('writes through nested paths without aliasing the caller', () => {
    // `set()` mutates containers, so a shallow copy would rewrite the caller's band
    // table in place — the aliasing trap the cockpit's _deepCopyParams exists for.
    const spy = instrument();
    const caller = { spendingExpenseBands: [{ startAge: 45, monthlyAmount: 5500 }] };
    try {
      replayDecisions([rec(2026, { 'spendingExpenseBands[0].monthlyAmount': 9000 })],
        { baseParams: caller, simStart: SIM_START, simEnd: SIM_END,
          objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH });
      assert.equal(caller.spendingExpenseBands[0].monthlyAmount, 5500,
        'the caller\'s params must be untouched');
      const final = spy.calls[spy.calls.length - 1].base;
      assert.equal(final.spendingExpenseBands[0].monthlyAmount, 9000,
        'the replay\'s own copy took the write');
    } finally { spy.restore(); }
  });

  test('filters to one runId — exploratory runs must not blend', () => {
    const spy = instrument();
    try {
      const out = replayDecisions(
        [{ ...rec(2026, { a: 1 }), runId: 'r1' }, { ...rec(2027, { a: 2 }), runId: 'other' }],
        { baseParams: {}, simStart: SIM_START, simEnd: SIM_END, runId: 'r1',
          objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH });
      assert.equal(out.epochs.length, 1);
    } finally { spy.restore(); }
  });

  test('an empty log throws rather than returning a meaningless terminal', () => {
    assert.throws(() => replayDecisions([], { simStart: SIM_START, simEnd: SIM_END }),
      /no records to replay/);
  });
});
