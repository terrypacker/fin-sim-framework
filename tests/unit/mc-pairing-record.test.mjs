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
 * mc-pairing-record.test.mjs — design 100 §5–6.
 *
 * The runner stamps each batch with the facts that define its random stream
 * (`summary.pairing`), so the app can CHECK that two batches are paired rather than
 * assume it. These pin the record and the draw counts it is built from.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementMcRunner } from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { IntlRetirementMcConfig } from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { samplingSignature }      from '../../src/finance/monte-carlo/parallel/mc-worker-core.js';
import { DISTRIBUTION_TYPES }     from '../../src/simulation-framework/distributions.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2028, 1, 1));

test('MPR-1 samplingSignature counts the draws each enabled variable takes, in order', () => {
  const sig = samplingSignature([
    { paramKey: 'a', enabled: true,  type: DISTRIBUTION_TYPES.NORMAL,  mean: 0.05, stdDev: 0.01 },
    { paramKey: 'b', enabled: false, type: DISTRIBUTION_TYPES.NORMAL,  mean: 0.05, stdDev: 0.01 },
    { paramKey: 'c', enabled: true,  type: DISTRIBUTION_TYPES.UNIFORM, min: 0, max: 1 },
    // A zero-spread Normal short-circuits and takes NO random numbers — the case that
    // makes a key-set comparison insufficient.
    { paramKey: 'd', enabled: true,  type: DISTRIBUTION_TYPES.NORMAL,  mean: 0.05, stdDev: 0 },
  ]);
  assert.deepEqual(sig, [{ key: 'a', draws: 2 }, { key: 'c', draws: 1 }, { key: 'd', draws: 0 }]);
});

test('MPR-2 a batch carries its pairing record on the summary', async () => {
  const cfgTemplate = IntlRetirementScenario.buildDefaultConfig({ fxProcessModel: 'NONE' }, SIM_START, SIM_END);
  const { summary } = await new IntlRetirementMcRunner({
    n: 3, simStart: SIM_START, simEnd: SIM_END, cfgTemplate, mcConfig: new IntlRetirementMcConfig(),
  }).run();

  const p = summary.pairing;
  assert.equal(p.n, 3);
  assert.deepEqual(p.seeds, [1, 2, 3]);
  assert.equal(p.mcSequenceRisk, true, 'MC runs the stochastic path unless opted out');
  assert.ok(p.sampled.length > 0, 'the default config samples some variables');
  assert.ok(p.sampled.every(s => typeof s.key === 'string' && Number.isInteger(s.draws)));
});

test('MPR-3 mcSequenceRisk:false is recorded', async () => {
  const cfgTemplate = IntlRetirementScenario.buildDefaultConfig({ fxProcessModel: 'NONE' }, SIM_START, SIM_END);
  const { summary } = await new IntlRetirementMcRunner({
    n: 1, simStart: SIM_START, simEnd: SIM_END, cfgTemplate, mcConfig: new IntlRetirementMcConfig(),
  }).run({ mcSequenceRisk: false });
  assert.equal(summary.pairing.mcSequenceRisk, false);
});
