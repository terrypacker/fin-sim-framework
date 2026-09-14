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
import { samplingSignature, mcEquityModel, mcInflationModel, perturbParams } from '../../src/finance/monte-carlo/parallel/mc-worker-core.js';
import { pairingMismatches }      from '../../src/finance/monte-carlo/mc-analysis.js';
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

// ── design 102 §7 Q3: Monte Carlo's own equity process, default HISTORICAL_BOOTSTRAP ──

test('MPR-4 mcEquityModel: bootstrap by default, SCENARIO defers, sequence risk off ⇒ null', () => {
  assert.equal(mcEquityModel({}), 'HISTORICAL_BOOTSTRAP', 'absent means the default');
  assert.equal(mcEquityModel({ equityReturnModel: 'WHITE_NOISE' }), 'HISTORICAL_BOOTSTRAP',
    'the single-run model does not leak into MC unless asked');
  assert.equal(mcEquityModel({ mcEquityReturnModel: 'SCENARIO', equityReturnModel: 'MEAN_REVERTING' }), 'MEAN_REVERTING');
  assert.equal(mcEquityModel({ mcEquityReturnModel: 'SCENARIO' }), 'WHITE_NOISE');
  assert.equal(mcEquityModel({ mcEquityReturnModel: 'WHITE_NOISE' }), 'WHITE_NOISE');
  assert.equal(mcEquityModel({ mcSequenceRisk: false, mcEquityReturnModel: 'WHITE_NOISE' }), null);
});

test('MPR-5 perturbParams writes the resolved model into each path, and only with sequence risk on', () => {
  const on  = perturbParams({ equityReturnModel: 'WHITE_NOISE' }, 0, []);
  assert.equal(on.equityReturnStochastic, true);
  assert.equal(on.equityReturnModel, 'HISTORICAL_BOOTSTRAP');
  const off = perturbParams({ equityReturnModel: 'WHITE_NOISE', mcSequenceRisk: false }, 0, []);
  assert.equal(off.equityReturnModel, 'WHITE_NOISE', 'a deterministic MC leaves the plan alone');
  assert.ok(!off.equityReturnStochastic);
});

test('MPR-6 a batch runs the bootstrap by default and records it on the pairing record', async () => {
  const cfgTemplate = IntlRetirementScenario.buildDefaultConfig({ fxProcessModel: 'NONE' }, SIM_START, SIM_END);
  const runner = () => new IntlRetirementMcRunner({
    n: 2, simStart: SIM_START, simEnd: SIM_END, cfgTemplate, mcConfig: new IntlRetirementMcConfig(),
  });
  const def = await runner().run();
  assert.equal(def.summary.pairing.equityModel, 'HISTORICAL_BOOTSTRAP');
  assert.ok(def.runs.every(r => r.params.equityReturnModel === 'HISTORICAL_BOOTSTRAP'));

  const scen = await runner().run({ mcEquityReturnModel: 'SCENARIO', equityReturnModel: 'WHITE_NOISE' });
  assert.equal(scen.summary.pairing.equityModel, 'WHITE_NOISE');
  // AUTO inflation follows the equity process (design 103 §6), so it changes too.
  assert.deepEqual(pairingMismatches(def.summary.pairing, scen.summary.pairing),
    ['equity process HISTORICAL_BOOTSTRAP vs WHITE_NOISE', 'inflation process HISTORICAL_JOINT vs GAUSSIAN']);
});

// ── design 103 §6: the inflation path, on by default, joint under the bootstrap ──

test('MPR-8 mcInflationModel: AUTO follows the equity process; SCENARIO defers; off ⇒ null', () => {
  assert.equal(mcInflationModel({}), 'HISTORICAL_JOINT', 'the default equity process is the bootstrap');
  assert.equal(mcInflationModel({ mcEquityReturnModel: 'WHITE_NOISE' }), 'GAUSSIAN');
  assert.equal(mcInflationModel({ mcSequenceRisk: false }), 'GAUSSIAN', 'no equity path ⇒ nothing to be joint with');
  assert.equal(mcInflationModel({ mcInflationModel: 'SCENARIO', inflationModel: 'HISTORICAL_JOINT' }), 'HISTORICAL_JOINT');
  assert.equal(mcInflationModel({ mcInflationModel: 'SCENARIO' }), 'GAUSSIAN');
  assert.equal(mcInflationModel({ mcInflationModel: 'GAUSSIAN' }), 'GAUSSIAN');
  assert.equal(mcInflationModel({ mcInflationPath: false }), null);
});

test('MPR-9 perturbParams turns the inflation path on with the resolved model', () => {
  const on = perturbParams({}, 0, []);
  assert.equal(on.inflationStochastic, true);
  assert.equal(on.inflationModel, 'HISTORICAL_JOINT');
  const off = perturbParams({ mcInflationPath: false }, 0, []);
  assert.ok(!off.inflationStochastic);
});

test('MPR-10 a batch records its inflation process, and a change is flagged as unpaired', async () => {
  const cfgTemplate = IntlRetirementScenario.buildDefaultConfig({ fxProcessModel: 'NONE' }, SIM_START, SIM_END);
  const runner = () => new IntlRetirementMcRunner({
    n: 2, simStart: SIM_START, simEnd: SIM_END, cfgTemplate, mcConfig: new IntlRetirementMcConfig(),
  });
  const def = await runner().run();
  assert.equal(def.summary.pairing.inflationModel, 'HISTORICAL_JOINT');
  assert.ok(def.runs.every(r => r.params.inflationStochastic === true && r.params.inflationModel === 'HISTORICAL_JOINT'));
  const off = await runner().run({ mcInflationPath: false });
  assert.equal(off.summary.pairing.inflationModel, null);
  // With no inflation path, AUTO prime has nothing to follow, so it drops to the schedule (design 104 §6).
  assert.deepEqual(pairingMismatches(def.summary.pairing, off.summary.pairing),
    ['inflation process HISTORICAL_JOINT vs off', 'prime rate mode INFLATION_LINKED vs SCHEDULE']);
});

test('MPR-7 a record from before the field existed is not called a process mismatch', () => {
  const base = { n: 1, seeds: [1], sampled: [], mcSequenceRisk: true };
  assert.deepEqual(pairingMismatches(base, { ...base, equityModel: 'HISTORICAL_BOOTSTRAP' }), []);
});
