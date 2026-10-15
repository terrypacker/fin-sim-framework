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
 * `buildArmPathSim` (what `mc-trace.mjs` replays) must rebuild an MC path EXACTLY: same
 * preparation, same perturbation, same iteration builder — only the telemetry differs, and
 * telemetry only records. If this drifts, a trace explains a world the batch never ran.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadBaseConfig } from '../../scripts/lib/scenario-source.mjs';
import { buildVariant } from '../../scripts/lib/variant.mjs';
import { buildMcConfig, runArm, buildArmPathSim, mergeArmLevers, stochasticFromFlags } from '../../scripts/lib/mc.mjs';
import { quiet } from '../../scripts/lib/run.mjs';
import { computeNetWorthUsd } from '../../src/finance/monte-carlo/mc-sampling.js';

test('MC-TRACE-1: a traced path at telemetry journal is the batch row, path for path', async () => {
  const base = loadBaseConfig({ file: null });
  const levers = mergeArmLevers({}, {});
  levers.stochastic = stochasticFromFlags({ paths: true });
  const cfg = buildVariant(base.cfg, levers);
  const { mcConfig, shocks } = buildMcConfig(cfg, { recentre: false });
  const { rows } = await runArm({ cfg, n: 3, mcConfig, shocks });

  for (const row of rows) {
    const { sim, simEnd } = buildArmPathSim({ cfg, mcConfig, shocks, seed: row.seed });
    quiet(() => sim.stepTo(simEnd));
    assert.equal(Math.round(computeNetWorthUsd(sim.state)), row.nw, `seed ${row.seed} net worth`);
    assert.equal(!!sim.state.scenarioFailed, row.failed, `seed ${row.seed} failed`);
    assert.ok(sim.journal.getActionTypes().length > 0, 'the journal is on');
  }
});

test('MC-TRACE-2: the seed is the 1-based row seed', () => {
  assert.throws(() => buildArmPathSim({ cfg: {}, mcConfig: {}, shocks: [], seed: 0 }), /1-based/);
});
