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
 * evt-shock-mc.test.mjs
 *
 * Verifies that IntlRetirementMcRunner produces spread outcomes when run
 * against a scenario that includes ECONOMIC_REGIMES + a configured shock.
 * ECONOMIC_REGIMES is in the default toolset list so buildDefaultConfig
 * includes it automatically.
 *
 *   EVT-SHOCK-MC-1: MC runner completes without error when shocks are in baseParams
 *   EVT-SHOCK-MC-2: Varying growth rates under a shock produce spread outcomes (p10 < p50 < p90)
 *   EVT-SHOCK-MC-3: Shock scenario p50 is lower than no-shock scenario p50
 *   EVT-SHOCK-MC-4: Variable shocks[0].severity as sole varying param produces spread outcomes
 *   EVT-SHOCK-MC-5: Variable shocks[0].startDate as sole varying param produces spread outcomes
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementMcRunner }      from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { IntlRetirementMcConfig }      from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { DISTRIBUTION_TYPES }          from '../../src/simulation-framework/distributions.js';

// Short window; shock fires well within it
const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2032, 0, 1));
const N         = 20;

// Shock fires in 2028 — within the simulation window; GFC-style −40% equity drop
const SHOCK_2028 = {
  preset:    'MARKET_CRASH_2008_LITE',
  startDate: '2028-06-01',
};

// Variable configs: vary equity growth rate with moderate spread
const GROWTH_VAR_CONFIGS = [
  {
    paramKey: 'rothGrowthRate',
    label:    'Roth IRA Growth Rate',
    type:     DISTRIBUTION_TYPES.NORMAL,
    mean:     0.07,
    stdDev:   0.03,
    enabled:  true,
  },
  {
    paramKey: 'iraGrowthRate',
    label:    'IRA Growth Rate',
    type:     DISTRIBUTION_TYPES.NORMAL,
    mean:     0.07,
    stdDev:   0.03,
    enabled:  true,
  },
];

function makeRunner(extraConfigs = []) {
  const mcConfig = IntlRetirementMcConfig.fromVariableConfigs([...GROWTH_VAR_CONFIGS, ...extraConfigs]);
  return new IntlRetirementMcRunner({
    n:        N,
    mcConfig,
    simStart: SIM_START,
    simEnd:   SIM_END,
  });
}

test('EVT-SHOCK-MC-1: MC runner completes without error when shocks are in baseParams', async () => {
  const { runs, summary } = await makeRunner().run({ shocks: [SHOCK_2028] });
  assert.ok(Array.isArray(runs),         'runs should be an array');
  assert.strictEqual(runs.length, N,     `expected ${N} runs`);
  assert.ok(typeof summary === 'object', 'summary should be an object');
  assert.ok('p10' in summary,            'summary should have p10');
  assert.ok('p50' in summary,            'summary should have p50');
  assert.ok('p90' in summary,            'summary should have p90');
  for (const r of runs) {
    assert.ok(Number.isFinite(r.finalNetWorthUsd), `run ${r.seed}: finalNetWorthUsd should be finite`);
  }
});

test('EVT-SHOCK-MC-2: Varying growth rates under shock produce spread outcomes (p10 < p50 < p90)', async () => {
  const { summary } = await makeRunner().run({ shocks: [SHOCK_2028] });
  assert.ok(
    summary.p10 < summary.p50,
    `p10 (${summary.p10.toFixed(0)}) should be < p50 (${summary.p50.toFixed(0)})`
  );
  assert.ok(
    summary.p50 < summary.p90,
    `p50 (${summary.p50.toFixed(0)}) should be < p90 (${summary.p90.toFixed(0)})`
  );
});

test('EVT-SHOCK-MC-3: Shock scenario p50 is lower than no-shock p50', async () => {
  const { summary: withShock }    = await makeRunner().run({ shocks: [SHOCK_2028] });
  const { summary: withoutShock } = await makeRunner().run();

  // A −40% equity drop in 2028 should measurably reduce the median net worth
  assert.ok(
    withShock.p50 < withoutShock.p50,
    `p50 with shock (${withShock.p50.toFixed(0)}) should be < p50 without shock (${withoutShock.p50.toFixed(0)})`
  );
});

test('EVT-SHOCK-MC-4: Variable shocks[0].severity produces spread outcomes', async () => {
  // Use shocks[0].severity as the sole varying param — spread comes entirely
  // from different severity draws via nested path, proving the set() path works end-to-end.
  const mcConfig = IntlRetirementMcConfig.fromVariableConfigs([
    {
      paramKey: 'shocks[0].severity',
      label:    'Shock Severity',
      type:     DISTRIBUTION_TYPES.NORMAL,
      mean:     0.40,
      stdDev:   0.15,
      enabled:  true,
    },
  ]);
  const runner = new IntlRetirementMcRunner({
    n:        N,
    mcConfig,
    simStart: SIM_START,
    simEnd:   SIM_END,
  });

  const { runs, summary } = await runner.run({ shocks: [SHOCK_2028] });

  // All runs should complete without error
  for (const r of runs) {
    assert.ok(Number.isFinite(r.finalNetWorthUsd), `run ${r.seed}: finalNetWorthUsd should be finite`);
  }

  // Varying severity should produce spread (higher severity → bigger equity drop → lower net worth)
  assert.ok(
    summary.p10 < summary.p50,
    `p10 (${summary.p10.toFixed(0)}) should be < p50 (${summary.p50.toFixed(0)})`
  );
  assert.ok(
    summary.p50 < summary.p90,
    `p50 (${summary.p50.toFixed(0)}) should be < p90 (${summary.p90.toFixed(0)})`
  );
});

test('EVT-SHOCK-MC-4b: baseParams.shocks unmutated after full run with severity sweep', async () => {
  const baseShocks = [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2028-06-01' }];
  const mcConfig = IntlRetirementMcConfig.fromVariableConfigs([
    { paramKey: 'shocks[0].severity', enabled: true, type: DISTRIBUTION_TYPES.NORMAL, mean: 0.40, stdDev: 0.15 },
  ]);
  const runner = new IntlRetirementMcRunner({ n: N, mcConfig, simStart: SIM_START, simEnd: SIM_END });
  const originalPreset = baseShocks[0].preset;
  await runner.run({ shocks: baseShocks });
  // structuredClone guarantee: baseParams.shocks must not be mutated
  assert.strictEqual(baseShocks[0].preset, originalPreset);
  assert.strictEqual(baseShocks[0].severity, undefined, 'baseShocks[0].severity must remain undefined');
});

test('EVT-SHOCK-MC-5: Variable shocks[0].startDate produces spread outcomes', async () => {
  const mcConfig = IntlRetirementMcConfig.fromVariableConfigs([
    {
      paramKey: 'shocks[0].startDate',
      label:    'Shock Start Date',
      type:     DISTRIBUTION_TYPES.UNIFORM_DATE,
      min:      '2027-01-01',
      max:      '2031-01-01',
      enabled:  true,
    },
  ]);
  const runner = new IntlRetirementMcRunner({
    n:        N,
    mcConfig,
    simStart: SIM_START,
    simEnd:   SIM_END,
  });

  const { runs, summary } = await runner.run({ shocks: [SHOCK_2028] });

  // All runs should complete without error regardless of when the shock fires
  for (const r of runs) {
    assert.ok(Number.isFinite(r.finalNetWorthUsd), `run ${r.seed}: finalNetWorthUsd should be finite`);
  }

  // Earlier shocks → more time under depressed returns → wider net-worth spread
  assert.ok(
    summary.p10 < summary.p50,
    `p10 (${summary.p10.toFixed(0)}) should be < p50 (${summary.p50.toFixed(0)})`
  );
  assert.ok(
    summary.p50 < summary.p90,
    `p50 (${summary.p50.toFixed(0)}) should be < p90 (${summary.p90.toFixed(0)})`
  );
});
