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
 * mc-worker-pool.test.mjs — Monte Carlo on a worker pool (design 89 §21.7).
 *
 * The claim that justifies the whole change is stronger than "close enough":
 * iterations are INDEPENDENT and INDEX-SEEDED (`seed = i + 1` for the in-loop
 * stochastic path, `makeSeededRng(i + 1)` for the scalar draws), so sharding them
 * across workers is BIT-IDENTICAL to running them in order. These tests assert that
 * directly, against a real cross-thread run — Node worker_threads here, which uses
 * the same structured-clone serialization the browser does, so a context that
 * survives this survives `postMessage`.
 *
 * A short horizon and a small n keep the real sims fast enough for CI.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { IntlRetirementMcRunner } from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { IntlRetirementMcConfig } from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { McWorkerPool }           from '../../src/finance/monte-carlo/parallel/mc-worker-pool.js';
import { nodeMcSpawn }            from './helpers/node-mc-spawn.mjs';

const SIM_END = new Date(Date.UTC(2030, 0, 1));

/**
 * A short-horizon runner with a handful of scalar variables left ENABLED — the draws
 * are what a worker has to reproduce, so a run with everything disabled would prove
 * much less. FX is pinned so the only stochastic consumers are the ones under test.
 */
function runner({ n = 6, ...opts } = {}) {
  const cfgTemplate = IntlRetirementScenario.buildDefaultConfig(
    { fxProcessModel: 'NONE' }, undefined, SIM_END);
  return new IntlRetirementMcRunner({ n, simEnd: SIM_END, cfgTemplate, ...opts });
}

/** A pool backed by Node worker_threads (production injects `browserMcSpawn`). */
function nodePool(size = 3) {
  return new McWorkerPool({ size, spawn: nodeMcSpawn() });
}

describe('McWorkerPool (design 89 §21.7)', () => {
  test('a parallel MC batch is bit-identical to the serial one', async () => {
    const serial = await runner().run();

    const pool = nodePool();
    let par;
    try {
      par = await runner({ workerPool: pool }).run();
    } finally {
      pool.terminate();
    }

    // Whole-batch equality, not spot checks: every sampled param, every path's time
    // series, and the aggregate that is computed from them.
    assert.deepStrictEqual(par.runs, serial.runs);
    assert.deepStrictEqual(par.summary, serial.summary);
  });

  test('results land in ITERATION order, whatever order the workers finish in', async () => {
    // One worker per two paths and a batch big enough that completion order is not
    // input order. `runs[i]` is addressed by index downstream (the runs panel, the
    // replay button, `firstDecadeBelowMedian`), so this is load-bearing.
    const pool = nodePool(4);
    let par;
    try {
      par = await runner({ n: 8, workerPool: pool }).run();
    } finally {
      pool.terminate();
    }
    assert.deepStrictEqual(par.runs.map(r => r.seed), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('progress counts every completion exactly once', async () => {
    const seen = [];
    const pool = nodePool(3);
    try {
      await runner({ n: 5, workerPool: pool }).run({}, (done, total) => seen.push([done, total]));
    } finally {
      pool.terminate();
    }
    // Completion order, so the counter must still be 1..n with the right total —
    // the one observable that genuinely changes when the loop is sharded.
    assert.deepStrictEqual(seen, [[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]);
  });

  test('a subclass that overrides _perturb stays SERIAL rather than silently diverging', async () => {
    // `_OffsetSeedMcRunner` (decision-graph-runner.js) does exactly this to give each
    // leaf its own seed space. A worker perturbs from the shared `perturbParams` and
    // cannot see the override, so the pool must be declined — not used with the base
    // class's draws, which is the silent-wrong-answer case.
    class OffsetRunner extends IntlRetirementMcRunner {
      _perturb(base, i, variables) { return super._perturb(base, i + 100, variables); }
    }
    const cfgTemplate = IntlRetirementScenario.buildDefaultConfig(
      { fxProcessModel: 'NONE' }, undefined, SIM_END);
    const opts = { n: 2, simEnd: SIM_END, cfgTemplate };

    const serial = await new OffsetRunner(opts).run();

    const pool = nodePool(2);
    let asked;
    try {
      asked = await new OffsetRunner({ ...opts, workerPool: pool }).run();
    } finally {
      pool.terminate();
    }

    assert.deepStrictEqual(asked.runs, serial.runs);
    // And the offset really was applied — otherwise the assertion above would hold
    // for the wrong reason (both runs being the un-offset base draws).
    const plain = await new IntlRetirementMcRunner(opts).run();
    assert.notDeepStrictEqual(serial.runs[0].params, plain.runs[0].params);
  });

  test('the broadcast context survives structured clone (the postMessage contract)', async () => {
    // The context is built on the main thread and must cross a thread boundary
    // whole. `structuredClone` rejects functions and class refs, which is precisely
    // what `ScenarioSerializer.serializeScenario` exists to strip — assert it here so
    // a future field added to the context fails loudly instead of poisoning a pool.
    const { ctx } = runner()._prepare();
    assert.doesNotThrow(() => structuredClone(ctx));
    assert.ok(ctx.variables.length > 0, 'a context with no variables would prove nothing');
  });

  test('mcConfig overrides reach the workers', async () => {
    // The variable list is resolved ONCE on the main thread and travels in the
    // context; a worker that rebuilt it from defaults would quietly sample a
    // different world. Disabling every scalar variable makes that visible: the paths
    // must then be identical to each other.
    const build = (extra) => {
      const r = runner({ n: 3, ...extra });
      for (const v of IntlRetirementMcConfig.contributors[0]()) {
        r.mcConfig.applyOverride(v.paramKey, { enabled: false });
      }
      return r;
    };
    const pool = nodePool(3);
    let par;
    try {
      par = await build({ workerPool: pool }).run();
    } finally {
      pool.terminate();
    }
    assert.deepStrictEqual(par.runs, (await build({}).run()).runs);
  });
});
