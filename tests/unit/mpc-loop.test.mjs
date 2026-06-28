/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe }          from 'node:test';
import assert                      from 'node:assert/strict';
import { runMpc, makeInitialSnapshot } from '../../src/finance/mpc/mpc-controller.js';
import { OPT_PARAM_TYPES, OPTIMIZATION_OBJECTIVES } from '../../src/finance/optimization/optimization-objectives.js';

/*
 * Design 39 Step 3 — receding-horizon MPC loop.
 *
 * Part 1 drives the loop on a TOY problem with a known optimum (x* = 7), with
 * the real solver but injected (DI) problem + advance, so we can assert:
 *   - the loop converges to the optimal policy at every epoch, and
 *   - warm-starting each replan from the previous decision cuts evaluations.
 *
 * Part 2 is an end-to-end smoke through the REAL snapshot-seeded IntlRetirement
 * problem + rollToSnapshot advance, proving the wiring runs closed-loop.
 */

// ── Toy problem: maximize -Σ(xi-7)^2 over a 3-D box [0,10]^3 (optimum all 7s).
// 3-D so that walking in from a cold random start genuinely costs more
// evaluations than confirming convergence at a warm-started optimum.
const TOY_KEYS = ['x0', 'x1', 'x2'];
class ToyProblem {
  constructor() {
    this.variables = TOY_KEYS.map(k => ({ paramKey: k, type: OPT_PARAM_TYPES.CONTINUOUS, min: 0, max: 10, step: 0.05 }));
  }
  evaluate(candidate) {
    const score = -TOY_KEYS.reduce((s, k) => s + (((candidate[k] ?? 0) - 7) ** 2), 0);
    return { result: { ...candidate, value: score }, score };
  }
  encode(c) { return TOY_KEYS.map(k => c[k] ?? 0); }
  decode(v) { return Object.fromEntries(TOY_KEYS.map((k, i) => [k, Math.min(10, Math.max(0, v[i]))])); }
  randomCandidate(rng) { return Object.fromEntries(TOY_KEYS.map(k => [k, rng() * 10])); }
  candidateCount() { return null; }
}

const dummySnapshot = (date) => ({ date, state: {}, queue: [], rngState: 0 });

function runToy(warmStart) {
  const epochs = [
    new Date(Date.UTC(2026, 0, 1)),
    new Date(Date.UTC(2027, 0, 1)),
    new Date(Date.UTC(2028, 0, 1)),
  ];
  return runMpc({
    simStart:        epochs[0],
    simEnd:          new Date(Date.UTC(2030, 0, 1)),
    epochs,
    initialSnapshot: dummySnapshot(epochs[0]),
    buildVariables:  () => new ToyProblem().variables,
    solverKey:       'PATTERN_SEARCH',
    solverOptions:   { budget: 300, seed: 5, noImproveLimit: 25 },
    warmStart,
    buildProblem:    () => new ToyProblem(),
    advance:         (_problem, _candidate, toDate) => dummySnapshot(toDate),
  });
}

describe('MPC Step 3 — receding-horizon loop', () => {
  test('converges to the known optimal policy at every epoch', async () => {
    const { decisions, finalResult } = await runToy(true);
    assert.equal(decisions.length, 3);
    for (const d of decisions) {
      for (const k of TOY_KEYS) {
        assert.ok(Math.abs(d.candidate[k] - 7) < 0.6,
          `epoch decision ${k}=${d.candidate[k]} should converge to the optimum 7`);
      }
    }
    for (const k of TOY_KEYS) {
      assert.ok(Math.abs(finalResult[k] - 7) < 0.6, `final policy ${k} converges to the optimum`);
    }
  });

  test('warm-start cuts evaluations on later replans', async () => {
    const warm = await runToy(true);
    const cold = await runToy(false);

    const warmTotal = warm.decisions.reduce((s, d) => s + d.evaluations, 0);
    const coldTotal = cold.decisions.reduce((s, d) => s + d.evaluations, 0);
    assert.ok(warmTotal < coldTotal,
      `warm-start total evals (${warmTotal}) should be < cold (${coldTotal})`);

    // The later warm replans (seeded from the previous near-optimal decision)
    // should be cheaper than the cold first epoch's fresh search.
    const warmLater = warm.decisions[1].evaluations + warm.decisions[2].evaluations;
    const coldLater = cold.decisions[1].evaluations + cold.decisions[2].evaluations;
    assert.ok(warmLater < coldLater,
      `warm later-epoch evals (${warmLater}) should be < cold (${coldLater})`);
  });
});

describe('MPC Step 3 — end-to-end smoke (real snapshot-seeded problem)', () => {
  test('closed loop runs over the real scenario and produces a finite terminal', async () => {
    const simStart = new Date(Date.UTC(2026, 0, 1));
    const simEnd   = new Date(Date.UTC(2032, 0, 1));
    const epochs   = [new Date(Date.UTC(2028, 0, 1)), new Date(Date.UTC(2030, 0, 1))];

    const baseParams = {
      spendingStrategy:    ['EXPLICIT_BANDS'],
      spendingExpenseBands: [{ startAge: 48, monthlyAmount: 5000 }],
    };
    const KEY = 'spendingExpenseBands[0].monthlyAmount';

    const initialSnapshot = makeInitialSnapshot({
      simStart, simEnd, asOfDate: epochs[0], baseParams,
    });

    const { decisions, finalResult, committedParams } = await runMpc({
      simStart, simEnd, epochs, initialSnapshot, baseParams,
      buildVariables: () => [{ paramKey: KEY, type: OPT_PARAM_TYPES.INTEGER, min: 3000, max: 7000, step: 1000 }],
      objective:      OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
      solverKey:      'GRID',
    });

    assert.equal(decisions.length, 2, 'one decision per epoch');
    for (const d of decisions) {
      const x = d.candidate[KEY];
      assert.ok(Number.isInteger(x) && x >= 3000 && x <= 7000, `chosen band amount ${x} in range`);
      assert.ok(Number.isFinite(d.result.finalNetWorthUsd), 'each decision has a finite terminal');
    }
    assert.ok(Number.isFinite(finalResult.finalNetWorthUsd), 'final terminal is finite');
    assert.ok(committedParams[KEY] != null || committedParams.spendingExpenseBands?.[0]?.monthlyAmount != null,
      'the committed control is recorded forward');
  });
});
