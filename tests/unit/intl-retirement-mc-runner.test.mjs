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
import { IntlRetirementMcConfig,
         DEFAULT_MC_VARIABLE_CONFIGS } from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { DISTRIBUTION_TYPES }        from '../../src/simulation-framework/distributions.js';
import { INTL_RETIREMENT_DEFAULTS, IntlRetirementScenario }
                                     from '../../src/scenarios/intl-retirement-scenario.js';
import { ServiceRegistry }           from '../../src/services/service-registry.js';

// Short window: 2026-01-01 → 2028-01-01 (2 years — fast to run in tests)
const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2028, 1, 1));
const N         = 5;

function makeRunner(opts = {}) {
  // FX pinned by default. This file's subject is the PARAMETER SAMPLER — several
  // tests assert that a constant-only or all-disabled config yields n identical
  // runs, which holds only when nothing else varies per iteration. The scenario's
  // MEAN_REVERTING default is exactly such a per-iteration consumer. Callers that
  // pass their own cfgTemplate keep whatever it carries.
  const cfgTemplate = opts.cfgTemplate
    ?? IntlRetirementScenario.buildDefaultConfig({ fxProcessModel: 'NONE' }, SIM_START, SIM_END);
  return new IntlRetirementMcRunner({ n: N, simStart: SIM_START, simEnd: SIM_END, ...opts, cfgTemplate });
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
  const mcConfig = IntlRetirementMcConfig.fromVariableConfigs(constantConfigs);

  const runner = makeRunner({ mcConfig });
  const { runs } = await runner.run();

  const first = runs[0].finalNetWorthUsd;
  for (const r of runs) {
    assert.strictEqual(r.finalNetWorthUsd, first,
      `constant config should produce identical net worth, got ${r.finalNetWorthUsd} vs ${first}`);
  }
});

test('IntlRetirementMcRunner: all-disabled mcConfig produces n identical runs', async () => {
  // All vars disabled → no sampling → every run uses the same param values
  const allDisabled = DEFAULT_MC_VARIABLE_CONFIGS.map(c => ({ ...c, enabled: false }));
  const mcConfig = IntlRetirementMcConfig.fromVariableConfigs(allDisabled);
  const runner = makeRunner({ mcConfig });
  const { runs } = await runner.run();
  assert.strictEqual(runs.length, N);
  const first = runs[0].finalNetWorthUsd;
  for (const r of runs) assert.strictEqual(r.finalNetWorthUsd, first);
});

test('IntlRetirementMcRunner: a disabled balance lever does not reset a customized balance (design 55 §13)', async () => {
  // A holdings-bearing account's balance MC lever aliases to the compile-only
  // `balanceTarget`. A disabled lever must center on the template's live balance — not the
  // hardcoded template default — so it doesn't rescale the account's holdings on every run.
  const cfgTemplate = IntlRetirementScenario.buildDefaultConfig(
    { stockBalance: 600_000 }, SIM_START, SIM_END);
  const allDisabled = DEFAULT_MC_VARIABLE_CONFIGS.map(c => ({ ...c, enabled: false }));
  const mcConfig = IntlRetirementMcConfig.fromVariableConfigs(allDisabled);
  const runner = makeRunner({ mcConfig, cfgTemplate });
  const { runs } = await runner.run();

  for (const r of runs) {
    assert.strictEqual(r.params.stockBalance, 600_000,
      `disabled balance lever must keep the customized balance, got ${r.params.stockBalance}`);
  }
});

// ─── Centers follow the LOADED SCENARIO, not the framework defaults ───────────
//
// The runner seeds its base params from the cfgTemplate's own two param stores.
// Without that every variable centers on DEFAULT_MC_VARIABLE_CONFIGS' hardcoded
// mean: an enabled lever samples the wrong world, and a DISABLED one writes the
// framework default over the scenario's real value — both completely silently.

/** A cfg whose params differ from the framework defaults, in both param stores. */
function customizedTemplate(overrides) {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, SIM_START, SIM_END);
  cfg.parameters = { ...cfg.parameters, ...overrides };
  cfg.params = Object.entries(overrides).map(([name, value]) => ({ name, value }));
  return cfg;
}

test('IntlRetirementMcRunner: an enabled lever samples around the SCENARIO value, not the library default', async () => {
  const cfgTemplate = customizedTemplate({ brokerageGrowthRate: 0.10 });
  assert.notStrictEqual(INTL_RETIREMENT_DEFAULTS.usStockGrowthRate, 0.10,
    'test is meaningless unless the scenario value differs from the framework default');

  const { runs } = await makeRunner({ n: 12, cfgTemplate }).run();
  const sampled = runs.map(r => r.params.brokerageGrowthRate);
  const mean = sampled.reduce((a, b) => a + b, 0) / sampled.length;

  // stdDev is 0.03, so a 12-sample mean sits well inside ±0.03 of the true center
  // while being nowhere near the 0.05 library default.
  assert.ok(Math.abs(mean - 0.10) < 0.03,
    `sampled mean ${mean} should center on the scenario's 0.10, not ${INTL_RETIREMENT_DEFAULTS.usStockGrowthRate}`);
});

test('IntlRetirementMcRunner: a disabled lever does not overwrite the scenario value with a framework default', async () => {
  const cfgTemplate = customizedTemplate({ monthlyExpenses: 12_345 });
  const { runs } = await makeRunner({ cfgTemplate }).run();
  for (const r of runs) {
    assert.strictEqual(r.params.monthlyExpenses, 12_345,
      `disabled lever must leave the scenario value alone, got ${r.params.monthlyExpenses}`);
  }
});

test('IntlRetirementMcRunner: shock variables build from the template without the caller passing shocks', async () => {
  // Previously buildShockMcConfigs saw no `shocks` unless run({ shocks }) was called,
  // so enabling a shock lever silently measured a world with no crash in it.
  const cfgTemplate = customizedTemplate({
    shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2026-06-01' }],
  });
  const mcConfig = new IntlRetirementMcConfig();
  mcConfig.applyOverride('shocks[0].severity', { enabled: true });
  const { runs, summary } = await makeRunner({ mcConfig, cfgTemplate }).run();

  const severities = runs.map(r => r.params.shocks?.[0]?.severity);
  assert.ok(severities.every(s => typeof s === 'number'), 'every run should carry a sampled shock severity');
  assert.ok(new Set(severities).size > 1, 'an enabled shock severity should actually vary across runs');
  // A preset entry's severity comes from the shock library, which is what the sim
  // would run at anyway — coherent, so it must not be flagged as synthetic.
  assert.deepStrictEqual(summary.provenance.syntheticCenters, []);
});

// ─── Provenance ──────────────────────────────────────────────────────────────

test('summarizeProvenance: reports scenario-centered variables as fromScenario', async () => {
  const cfgTemplate = customizedTemplate({ brokerageGrowthRate: 0.10 });
  const { summary } = await makeRunner({ cfgTemplate }).run();
  const p = summary.provenance;

  assert.ok(p, 'summary should carry provenance');
  assert.ok(p.centersBySource.scenario.includes('brokerageGrowthRate'));
  assert.deepStrictEqual(p.divergentCenters, []);
  assert.deepStrictEqual(p.syntheticCenters, []);
  assert.strictEqual(p.fromScenario, true);
});

test('summarizeProvenance: an explicit center override is reported as divergent', async () => {
  const cfgTemplate = customizedTemplate({ brokerageGrowthRate: 0.10 });
  const mcConfig = new IntlRetirementMcConfig();
  mcConfig.applyOverride('brokerageGrowthRate', { mean: 0.04 });

  const { summary } = await makeRunner({ mcConfig, cfgTemplate }).run();
  const p = summary.provenance;

  assert.ok(p.centersBySource.override.includes('brokerageGrowthRate'));
  assert.deepStrictEqual(p.divergentCenters,
    [{ paramKey: 'brokerageGrowthRate', center: 0.04, scenarioValue: 0.10 }]);
  assert.strictEqual(p.fromScenario, false, 'a center away from the plan must not read as "the plan"');
});

test('summarizeProvenance: an untouched panel row keeps its declared source, so a synthetic center still reports', async () => {
  // The MC panel emits a center for EVERY row, so every UI run arrives as a full set
  // of "overrides". Rows the user never typed into say so and carry the source the
  // panel resolved; without honouring that, a variable centered on a framework
  // default reclassifies as a deliberate user choice the moment it goes through the
  // UI, and the results badge under-counts exactly the case it exists to catch.
  const cfgTemplate = customizedTemplate({ brokerageGrowthRate: 0.10 });
  const mcConfig = new IntlRetirementMcConfig();
  mcConfig.applyOverride('primaryMonthlyWage', {
    enabled: true, mean: 8000, stdDev: 500, centerDirty: false, centerSource: 'default',
  });
  mcConfig.applyOverride('brokerageGrowthRate', {
    enabled: true, mean: 0.10, stdDev: 0.03, centerDirty: false, centerSource: 'scenario',
  });

  const { summary } = await makeRunner({ mcConfig, cfgTemplate }).run();
  const p = summary.provenance;

  assert.deepStrictEqual(p.syntheticCenters, ['primaryMonthlyWage']);
  assert.ok(p.centersBySource.scenario.includes('brokerageGrowthRate'),
    'a copied-in scenario center is not a user override');
  assert.strictEqual(p.fromScenario, false);
});

test('summarizeProvenance: a hand-typed center is still an override', async () => {
  const cfgTemplate = customizedTemplate({ brokerageGrowthRate: 0.10 });
  const mcConfig = new IntlRetirementMcConfig();
  mcConfig.applyOverride('brokerageGrowthRate', {
    enabled: true, mean: 0.02, stdDev: 0.03, centerDirty: true, centerSource: 'scenario',
  });

  const { summary } = await makeRunner({ mcConfig, cfgTemplate }).run();
  assert.ok(summary.provenance.centersBySource.override.includes('brokerageGrowthRate'));
  assert.deepStrictEqual(summary.provenance.divergentCenters,
    [{ paramKey: 'brokerageGrowthRate', center: 0.02, scenarioValue: 0.10 }]);
});

test('summarizeProvenance: a key the scenario lacks falls back to the schema default, not a synthetic center', async () => {
  // `equityReturnVol` lives in the param schema but not in buildDefaultConfig's bag.
  // The schema default is what ScenarioLoader materializes and the sim runs at, so
  // it — not the MC template's own mean — must supply the center. (The spouse*
  // growth rates used to be the exemplar here; they are retired, §4.10.)
  const { summary } = await makeRunner().run();
  const p = summary.provenance;
  assert.ok(p.centersBySource.schema.includes('equityReturnVol'),
    `expected a schema-sourced center, got ${JSON.stringify(p.centersBySource.schema)}`);
  assert.deepStrictEqual(p.syntheticCenters, [],
    'nothing should be sampling around an unanchored framework default');
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

// ── Alias cleanup: the renamed dividend variable now actually perturbs the sim ─

test('IntlRetirementMcRunner: brokerageDividendRate perturbation reaches the sim (dead alias fixed)', async () => {
  // Enable only the US stock dividend at a wide stdDev; everything else off. The
  // toolset reads `brokerageDividendRate`, so the sampled value now affects net
  // worth across runs. Under the old `stockDividendRate` key this was a no-op.
  const configs = DEFAULT_MC_VARIABLE_CONFIGS.map(c => ({
    ...c,
    enabled: c.paramKey === 'brokerageDividendRate',
    stdDev:  c.paramKey === 'brokerageDividendRate' ? 0.05 : c.stdDev,
  }));
  const mcConfig = IntlRetirementMcConfig.fromVariableConfigs(configs);
  const { runs }  = await makeRunner({ n: 8, mcConfig }).run();

  const worths  = runs.map(r => r.finalNetWorthUsd);
  const allSame = worths.every(w => w === worths[0]);
  assert.ok(!allSame, 'brokerageDividendRate must now affect finalNetWorth across runs');
});
