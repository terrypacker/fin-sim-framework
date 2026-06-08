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
 * Integration tests for IntlRetirementMcRunner.
 *
 * Uses a short 2-year simulation window and a small iteration count so
 * the test suite remains fast while still exercising the full run path.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { IntlRetirementMcRunner }    from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { DEFAULT_MC_VARIABLE_CONFIGS } from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { DISTRIBUTION_TYPES }        from '../../src/simulation-framework/distributions.js';
import { INTL_RETIREMENT_DEFAULTS, IntlRetirementScenario }
                                     from '../../src/scenarios/intl-retirement-scenario.js';
import { ServiceRegistry }           from '../../src/services/service-registry.js';

// Short window: 2026-01-01 → 2028-01-01 (2 years — fast to run in tests)
const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2028, 1, 1));
const N         = 5;

function makeRunner(opts = {}) {
  return new IntlRetirementMcRunner({ n: N, simStart: SIM_START, simEnd: SIM_END, ...opts });
}

// ─── Smoke test ───────────────────────────────────────────────────────────────

test('IntlRetirementMcRunner: run() completes without error', async () => {
  const { runs, summary } = await makeRunner().run();
  assert.ok(Array.isArray(runs), 'runs should be an array');
  assert.ok(typeof summary === 'object', 'summary should be an object');
});

test('IntlRetirementMcRunner: produces exactly n run results', async () => {
  const { runs } = await makeRunner().run();
  assert.strictEqual(runs.length, N);
});

// ─── Run shape ────────────────────────────────────────────────────────────────

test('IntlRetirementMcRunner: each run has required fields', async () => {
  const { runs } = await makeRunner().run();
  for (const r of runs) {
    assert.ok('seed' in r,              `run missing seed`);
    assert.ok('params' in r,            `run missing params`);
    assert.ok('finalNetWorthUsd' in r,  `run missing finalNetWorthUsd`);
    assert.ok('scenarioFailed' in r,    `run missing scenarioFailed`);
    assert.ok('outOfFundsDate' in r,    `run missing outOfFundsDate`);
    assert.ok('cumulativeDeficit' in r, `run missing cumulativeDeficit`);
    assert.ok('deficitMonths' in r,     `run missing deficitMonths`);
  }
});

test('IntlRetirementMcRunner: seeds are 1..n', async () => {
  const { runs } = await makeRunner().run();
  const seeds = runs.map(r => r.seed);
  for (let i = 0; i < N; i++) assert.strictEqual(seeds[i], i + 1);
});

test('IntlRetirementMcRunner: finalNetWorthUsd is a finite number', async () => {
  const { runs } = await makeRunner().run();
  for (const r of runs) {
    assert.ok(Number.isFinite(r.finalNetWorthUsd), `expected finite netWorth, got ${r.finalNetWorthUsd}`);
  }
});

test('IntlRetirementMcRunner: finalNetWorthUsd is positive with default params', async () => {
  const { runs } = await makeRunner().run();
  for (const r of runs) {
    assert.ok(r.finalNetWorthUsd > 0, `expected positive netWorth, got ${r.finalNetWorthUsd}`);
  }
});

// ─── Summary shape ────────────────────────────────────────────────────────────

test('IntlRetirementMcRunner: summary has required statistical fields', async () => {
  const { summary } = await makeRunner().run();
  const required = ['mean', 'p10', 'p50', 'p90', 'successRate', 'failureCount'];
  for (const f of required) {
    assert.ok(f in summary, `summary missing field: ${f}`);
  }
});

test('IntlRetirementMcRunner: successRate is in [0, 1]', async () => {
  const { summary } = await makeRunner().run();
  assert.ok(summary.successRate >= 0 && summary.successRate <= 1,
    `successRate out of range: ${summary.successRate}`);
});

test('IntlRetirementMcRunner: p10 <= p50 <= p90', async () => {
  const { summary } = await makeRunner().run();
  assert.ok(summary.p10 <= summary.p50, `p10 > p50`);
  assert.ok(summary.p50 <= summary.p90, `p50 > p90`);
});

test('IntlRetirementMcRunner: p50 is a positive finite number', async () => {
  const { summary } = await makeRunner().run();
  assert.ok(Number.isFinite(summary.p50) && summary.p50 > 0,
    `p50 should be positive finite, got ${summary.p50}`);
});

// ─── Parameter perturbation ───────────────────────────────────────────────────

test('IntlRetirementMcRunner: enabled params differ across runs', async () => {
  const { runs } = await makeRunner().run();
  // With Normal distributions on growth rates, values should differ across runs
  const rates = runs.map(r => r.params.rothGrowthRate);
  const allSame = rates.every(v => v === rates[0]);
  assert.ok(!allSame, 'enabled param rothGrowthRate should differ across runs');
});

test('IntlRetirementMcRunner: disabled params are constant across runs', async () => {
  const { runs } = await makeRunner().run();
  // rothBalance is disabled (ConstantDistribution) — should be unchanged
  const expected = INTL_RETIREMENT_DEFAULTS.rothBalance;
  for (const r of runs) {
    assert.strictEqual(r.params.rothBalance, expected,
      `disabled param rothBalance should equal default ${expected}, got ${r.params.rothBalance}`);
  }
});

// ─── Reproducibility ─────────────────────────────────────────────────────────

test('IntlRetirementMcRunner: same baseParams produces identical results on repeated runs', async () => {
  const runner = makeRunner();
  const [r1, r2] = await Promise.all([runner.run(), runner.run()]);

  // Same seeds → same perturbed params → same results
  for (let i = 0; i < N; i++) {
    assert.strictEqual(r1.runs[i].seed, r2.runs[i].seed);
    assert.strictEqual(r1.runs[i].params.rothGrowthRate, r2.runs[i].params.rothGrowthRate);
    assert.strictEqual(r1.runs[i].finalNetWorthUsd, r2.runs[i].finalNetWorthUsd);
  }
});

// ─── Custom variable configs ──────────────────────────────────────────────────

test('IntlRetirementMcRunner: constant-only config produces identical net worth across runs', async () => {
  // All params constant → all runs should yield the same result
  const constantConfigs = DEFAULT_MC_VARIABLE_CONFIGS.map(cfg => ({
    ...cfg,
    type:    DISTRIBUTION_TYPES.CONSTANT,
    value:   cfg.mean ?? cfg.value,
    enabled: true,
  }));

  const runner = makeRunner({ variableConfigs: constantConfigs });
  const { runs } = await runner.run();

  const first = runs[0].finalNetWorthUsd;
  for (const r of runs) {
    assert.strictEqual(r.finalNetWorthUsd, first,
      `constant config should produce identical net worth, got ${r.finalNetWorthUsd} vs ${first}`);
  }
});

test('IntlRetirementMcRunner: no variable configs produces n identical runs', async () => {
  const runner = makeRunner({ variableConfigs: [] });
  const { runs } = await runner.run();
  assert.strictEqual(runs.length, N);
  // With no perturbation every run is identical
  const first = runs[0].finalNetWorthUsd;
  for (const r of runs) assert.strictEqual(r.finalNetWorthUsd, first);
});

// ─── Registry isolation ──────────────────────────────────────────────────────
//
// 4.1 (design/inconsistencies.md): MC must not mutate the singleton
// ServiceRegistry. Before this fix, IntlRetirementMcRunner reset the singleton
// and cleared its config layer per iteration, leaving the user's Dashboard /
// Performance plugins disconnected from the live scenario.

test('IntlRetirementMcRunner: does not mutate the singleton ServiceRegistry', async () => {
  ServiceRegistry.resetAll();
  const before = ServiceRegistry.getInstance();
  const eventsBefore   = before.eventService.getAll().length;
  const accountsBefore = before.accountService.getAll().length;
  const configNodesBefore = before.graph.getNodes()
    .filter(n => n.layer === 'config').length;

  await makeRunner().run();

  const after = ServiceRegistry.getInstance();
  assert.strictEqual(after, before, 'singleton instance must not be replaced');
  assert.strictEqual(after.eventService.getAll().length,   eventsBefore);
  assert.strictEqual(after.accountService.getAll().length, accountsBefore);
  assert.strictEqual(
    after.graph.getNodes().filter(n => n.layer === 'config').length,
    configNodesBefore,
    'MC must not touch the singleton config-layer graph'
  );
  assert.strictEqual(after.simulationRegistry.getPrimary(), null);
});

// ─── Regression: template carrying functions/classes must not break clone ─────
//
// The ServiceRegistry-backed active scenario record carries `factory` (closure)
// and `scenarioClass` (class) — both unclonable by `structuredClone`. The
// runner must normalize the template before per-iteration cloning, otherwise
// every MC run from the UI throws `DataCloneError`.

test('IntlRetirementMcRunner: cfgTemplate with factory/scenarioClass does not break structuredClone', async () => {
  // Mirror what ScenarioRegistry.loadPrebuilt stores on each entry: the
  // declarative cfg + unclonable registry-metadata fields (factory closure,
  // scenarioClass reference). The runner must strip these before per-iteration
  // structuredClone, otherwise the UI's MC button throws DataCloneError.
  const cfgTemplate = {
    ...IntlRetirementScenario.buildDefaultConfig({}, SIM_START, SIM_END),
    id:            'p:test',
    name:          'Test',
    active:        true,
    prebuilt:      true,
    factory:       (_p, _i, _s, _e) => null,
    scenarioClass: IntlRetirementScenario,
  };
  const runner = makeRunner({ cfgTemplate, variableConfigs: [] });
  const { runs } = await runner.run();
  assert.strictEqual(runs.length, N, 'MC should complete despite unclonable fields on the template');
});

// ─── DEFAULT_MC_VARIABLE_CONFIGS structure ────────────────────────────────────

test('DEFAULT_MC_VARIABLE_CONFIGS: every entry has required fields', () => {
  for (const cfg of DEFAULT_MC_VARIABLE_CONFIGS) {
    assert.ok(cfg.paramKey, `entry missing paramKey: ${JSON.stringify(cfg)}`);
    assert.ok(cfg.label,    `entry missing label: ${cfg.paramKey}`);
    assert.ok(cfg.type,     `entry missing type: ${cfg.paramKey}`);
    assert.ok(cfg.group,    `entry missing group: ${cfg.paramKey}`);
    assert.ok(typeof cfg.enabled === 'boolean', `entry missing enabled: ${cfg.paramKey}`);
  }
});

test('DEFAULT_MC_VARIABLE_CONFIGS: enabled entries use Normal or LogNormal distribution', () => {
  const enabledTypes = DEFAULT_MC_VARIABLE_CONFIGS
    .filter(c => c.enabled)
    .map(c => c.type);
  const valid = new Set([DISTRIBUTION_TYPES.NORMAL, DISTRIBUTION_TYPES.LOG_NORMAL]);
  for (const t of enabledTypes) {
    assert.ok(valid.has(t), `enabled config should use Normal or LogNormal, got ${t}`);
  }
});
