/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { OptimizationProblem } from '../../src/finance/optimization/optimization-problem.js';
import { OPT_PARAM_TYPES, OPTIMIZATION_OBJECTIVES }
  from '../../src/finance/optimization/optimization-objectives.js';
import { computeNetWorth } from '../../src/finance/derived-metrics/net-worth.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';

/** Same algorithm as Simulation.createRNG / makeSeededRng. */
function makeRng(seed) {
  let s = seed;
  return () => {
    s = Math.trunc(s + 0x6D2B79F5);
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Mixed search space: ENUM (array-valued + scalar), INTEGER, CONTINUOUS.
const VARIABLES = [
  { paramKey: 'rothConversionMaxBracket', type: OPT_PARAM_TYPES.ENUM,
    values: [0.10, 0.12, 0.22, 0.24] },
  { paramKey: 'moveYear', type: OPT_PARAM_TYPES.INTEGER, min: 2026, max: 2030, step: 1 },
  { paramKey: 'regimeAwareCutPct', type: OPT_PARAM_TYPES.CONTINUOUS, min: 0.05, max: 0.40, step: 0.05 },
  { paramKey: 'spendingStrategy', type: OPT_PARAM_TYPES.ENUM,
    values: [['FIXED'], ['REGIME_AWARE'], ['GUARDRAIL']] },
];

function newProblem(overrides = {}) {
  return new OptimizationProblem({ variables: VARIABLES, ...overrides });
}

// ─── encode / decode ──────────────────────────────────────────────────────────

describe('OptimizationProblem.encode/decode', () => {
  test('encode maps candidate to vector (ENUM → index)', () => {
    const p = newProblem();
    const vec = p.encode({
      rothConversionMaxBracket: 0.22,
      moveYear: 2028,
      regimeAwareCutPct: 0.15,
      spendingStrategy: ['GUARDRAIL'],
    });
    assert.deepStrictEqual(vec, [2, 2028, 0.15, 2]);
  });

  test('decode inverts encode and snaps INTEGER/ENUM', () => {
    const p = newProblem();
    const candidate = {
      rothConversionMaxBracket: 0.24,
      moveYear: 2027,
      regimeAwareCutPct: 0.30,
      spendingStrategy: ['REGIME_AWARE'],
    };
    assert.deepStrictEqual(p.decode(p.encode(candidate)), candidate);
  });

  test('decode rounds INTEGER and clamps out-of-range to bounds', () => {
    const p = newProblem();
    const c = p.decode([1.4 /*round→idx1→0.12*/, 2028.7 /*→2029*/, 0.99 /*clamp 0.40*/, -5 /*clamp idx 0*/]);
    assert.strictEqual(c.rothConversionMaxBracket, 0.12);
    assert.strictEqual(c.moveYear, 2029);
    assert.strictEqual(c.regimeAwareCutPct, 0.40);
    assert.deepStrictEqual(c.spendingStrategy, ['FIXED']);
  });

  test('decode clamps ENUM index above the legal range', () => {
    const p = newProblem();
    const c = p.decode([99, 2026, 0.05, 99]);
    assert.strictEqual(c.rothConversionMaxBracket, 0.24);       // last bracket
    assert.deepStrictEqual(c.spendingStrategy, ['GUARDRAIL']);  // last strategy
  });
});

// ─── randomCandidate ──────────────────────────────────────────────────────────

describe('OptimizationProblem.randomCandidate', () => {
  test('respects bounds and yields legal ENUM values', () => {
    const p = newProblem();
    const rng = makeRng(7);
    for (let i = 0; i < 50; i++) {
      const c = p.randomCandidate(rng);
      assert.ok([0.10, 0.12, 0.22, 0.24].includes(c.rothConversionMaxBracket));
      assert.ok(c.moveYear >= 2026 && c.moveYear <= 2030 && Number.isInteger(c.moveYear));
      assert.ok(c.regimeAwareCutPct >= 0.05 && c.regimeAwareCutPct <= 0.40);
      assert.ok([['FIXED'], ['REGIME_AWARE'], ['GUARDRAIL']]
        .some(s => s[0] === c.spendingStrategy[0]));
    }
  });

  test('is deterministic for a given seed', () => {
    const p = newProblem();
    const a = p.randomCandidate(makeRng(42));
    const b = p.randomCandidate(makeRng(42));
    assert.deepStrictEqual(a, b);
  });
});

// ─── candidateCount ───────────────────────────────────────────────────────────

describe('OptimizationProblem.candidateCount', () => {
  test('is the product of per-variable value-set sizes', () => {
    // ENUM(4) × INTEGER(2026..2030 step1 = 5) × CONTINUOUS(0.05..0.40 step .05 = 8) × ENUM(3)
    assert.strictEqual(newProblem().candidateCount(), 4 * 5 * 8 * 3);
  });

  test('no variables → 1', () => {
    assert.strictEqual(new OptimizationProblem({ variables: [] }).candidateCount(), 1);
  });

  test('unbounded continuous variable → null (∞-safe)', () => {
    const p = new OptimizationProblem({
      variables: [{ paramKey: 'x', type: OPT_PARAM_TYPES.CONTINUOUS, min: 0, max: 1, step: 0 }],
    });
    assert.strictEqual(p.candidateCount(), null);
  });
});

// ─── evaluate: isolation + scoring ────────────────────────────────────────────

describe('OptimizationProblem.evaluate', () => {
  test('does not mutate the singleton ServiceRegistry', () => {
    ServiceRegistry.resetAll();
    const before = ServiceRegistry.getInstance();
    const eventsBefore   = before.eventService.getAll().length;
    const accountsBefore = before.accountService.getAll().length;
    const configNodesBefore = before.graph.getNodes().filter(n => n.layer === 'config').length;

    const p = new OptimizationProblem({
      variables: [{ paramKey: 'rothConversionMaxBracket', type: OPT_PARAM_TYPES.ENUM, values: [0.22, 0.24] }],
      simStart: new Date(Date.UTC(2026, 0, 1)),
      simEnd:   new Date(Date.UTC(2028, 0, 1)),
    });
    const { result, score } = p.evaluate({ rothConversionMaxBracket: 0.22 });
    assert.ok(Number.isFinite(result.finalNetWorthUsd));
    assert.strictEqual(score, result.finalNetWorthUsd); // MAX_NET_WORTH, maximize → sign +1

    const after = ServiceRegistry.getInstance();
    assert.strictEqual(after, before, 'singleton must not be replaced');
    assert.strictEqual(after.eventService.getAll().length,   eventsBefore);
    assert.strictEqual(after.accountService.getAll().length, accountsBefore);
    assert.strictEqual(
      after.graph.getNodes().filter(n => n.layer === 'config').length, configNodesBefore);
    assert.strictEqual(after.simulationRegistry.getPrimary(), null);
  });

  test('minimize objectives are sign-negated so higher score is better', () => {
    const p = new OptimizationProblem({
      variables: [],
      objective: OPTIMIZATION_OBJECTIVES.MIN_DEFICIT,
      simStart: new Date(Date.UTC(2026, 0, 1)),
      simEnd:   new Date(Date.UTC(2027, 0, 1)),
    });
    const { result, score } = p.evaluate({});
    assert.strictEqual(score, -result.cumulativeDeficit);
  });
});

// ─── deterministic compile across registries (the design-39 invariant) ────────

describe('OptimizationProblem — deterministic compile across registries', () => {
  test('same cfg → identical wiring + stateKey slot assignments', () => {
    const opts = { simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2028, 0, 1)) };
    const p = new OptimizationProblem({ variables: [], ...opts });

    const simA = p._compile({});
    const simB = p._compile({});

    // Wiring: identical reducer action-type and handler event-type keys.
    assert.deepStrictEqual(
      [...simA.reducers.map.keys()].sort(),
      [...simB.reducers.map.keys()].sort(),
      'reducer pipeline action types must match across registries');
    assert.deepStrictEqual(
      [...simA.handlers.map.keys()].sort(),
      [...simB.handlers.map.keys()].sort(),
      'handler event types must match across registries');

    // stateKey slots: identical initial state shape AND values (deterministic compile).
    assert.deepStrictEqual(
      Object.keys(simA.state).sort(),
      Object.keys(simB.state).sort(),
      'sim.state stateKey slots must match across registries');
    assert.deepStrictEqual(simA.state, simB.state,
      'compiled initial state must be byte-identical across fresh registries');
  });
});

// ─── snapshot initial-state provider ──────────────────────────────────────────

describe('OptimizationProblem — snapshot rollout', () => {
  test('snapshot-seeded rollout reproduces continuing the same sim to simEnd', () => {
    const simStart = new Date(Date.UTC(2026, 0, 1));
    const midDate  = new Date(Date.UTC(2030, 0, 1));
    const simEnd   = new Date(Date.UTC(2033, 0, 1));

    // Reference: one continuous compile run. Step to mid, capture a snapshot,
    // then keep stepping the SAME sim to the end for the ground-truth terminal.
    const ref = new OptimizationProblem({ variables: [], simStart, simEnd });
    const sim = ref._compile({});
    sim.silent = true;
    sim.journal.enabled = false;
    sim.stepTo(midDate);

    const snapshot = {
      date:  new Date(sim.currentDate),
      state: structuredClone(sim.state),
      queue: sim.cloneQueue(),
    };

    sim.stepTo(simEnd);
    const referenceNetWorth = computeNetWorth(sim.state, 'USD');

    // Snapshot path: a fresh problem compiles wiring, injects the snapshot, and
    // steps forward from midDate. Must land on the same terminal net worth.
    const snapProblem = new OptimizationProblem({
      variables: [],
      simStart,
      simEnd,
      initialState: { kind: 'snapshot', snapshot, cfgTemplate: null },
    });
    const { result } = snapProblem.evaluate({});

    assert.ok(Number.isFinite(result.finalNetWorthUsd));
    const rel = Math.abs(result.finalNetWorthUsd - referenceNetWorth) /
      Math.max(1, Math.abs(referenceNetWorth));
    assert.ok(rel < 1e-9,
      `snapshot rollout (${result.finalNetWorthUsd}) must match continuation (${referenceNetWorth})`);
  });
});
