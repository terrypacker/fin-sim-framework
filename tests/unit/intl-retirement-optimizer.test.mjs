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

import { OPT_PARAM_TYPES, OPTIMIZATION_OBJECTIVES }
  from '../../src/finance/optimization/optimization-objectives.js';
import { IntlRetirementOptimizer }
  from '../../src/finance/optimization/intl-retirement-optimizer.js';
import { valuesForConfig }
  from '../../src/finance/optimization/opt-values.js';
import { DEFAULT_OPTIMIZATION_CONFIGS }
  from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { INTL_RETIREMENT_PARAM_SCHEMA, IntlRetirementScenario }
  from '../../src/scenarios/intl-retirement-scenario.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ToolsetRegistry } from '../../src/scenarios/toolsets/toolset-registry.js';
import { US_BANKING }      from '../../src/scenarios/toolsets/us-banking-toolset.js';
import { US_TAX }          from '../../src/scenarios/toolsets/us-tax-toolset.js';
import { US_STATE_TAX }    from '../../src/scenarios/toolsets/us-state-tax-toolset.js';
import { US_RETIREMENT }   from '../../src/scenarios/toolsets/us-retirement-toolset.js';
import { US_INCOME }       from '../../src/scenarios/toolsets/us-income-toolset.js';
import { US_BROKERAGE }    from '../../src/scenarios/toolsets/us-brokerage-toolset.js';
import { US_REAL_PROPERTY } from '../../src/scenarios/toolsets/us-real-property-toolset.js';
import { US_COLLECTIBLES } from '../../src/scenarios/toolsets/us-collectibles-toolset.js';
import { US_ROTH_CONVERSION } from '../../src/scenarios/toolsets/us-roth-conversion-toolset.js';
import { US_EARLY_WITHDRAWAL } from '../../src/scenarios/toolsets/us-early-withdrawal-toolset.js';
import { AU_BANKING }      from '../../src/scenarios/toolsets/au-banking-toolset.js';
import { AU_TAX }          from '../../src/scenarios/toolsets/au-tax-toolset.js';
import { AU_RETIREMENT }   from '../../src/scenarios/toolsets/au-retirement-toolset.js';
import { AU_INCOME }       from '../../src/scenarios/toolsets/au-income-toolset.js';
import { AU_BROKERAGE }    from '../../src/scenarios/toolsets/au-brokerage-toolset.js';
import { AU_REAL_PROPERTY } from '../../src/scenarios/toolsets/au-real-property-toolset.js';
import { US_AU_CROSS_BORDER } from '../../src/scenarios/toolsets/us-au-cross-border-toolset.js';
import { ECONOMIC_REGIMES }  from '../../src/scenarios/toolsets/economic-regimes-toolset.js';

/**
 * Build the same combined schema (scenario + toolsets) that ScenarioLoader
 * presents to the UI. Scenario entries win on key collision.
 */
function buildCombinedSchema() {
  const registry = new ToolsetRegistry();
  for (const t of [
    US_BANKING, US_TAX, US_STATE_TAX, US_RETIREMENT, US_INCOME, US_BROKERAGE,
    US_REAL_PROPERTY, US_COLLECTIBLES, US_ROTH_CONVERSION, US_EARLY_WITHDRAWAL,
    AU_BANKING, AU_TAX, AU_RETIREMENT, AU_INCOME, AU_BROKERAGE,
    AU_REAL_PROPERTY, US_AU_CROSS_BORDER, ECONOMIC_REGIMES,
  ]) registry.register(t);

  const toolsetEntries = IntlRetirementScenario.getToolsets()
    .flatMap(id => registry.get(id).paramSchema?.({}) ?? []);

  const scenarioKeys = new Set(INTL_RETIREMENT_PARAM_SCHEMA.map(s => s.key));
  return [
    ...INTL_RETIREMENT_PARAM_SCHEMA,
    ...toolsetEntries.filter(t => !scenarioKeys.has(t.key)),
  ];
}

const COMBINED_SCHEMA = buildCombinedSchema();

// ─── valuesForConfig ──────────────────────────────────────────────────────────

describe('valuesForConfig', () => {
  test('ENUM returns values array unchanged', () => {
    const cfg = { type: OPT_PARAM_TYPES.ENUM, values: [0.10, 0.22, 0.35] };
    assert.deepStrictEqual(valuesForConfig(cfg), [0.10, 0.22, 0.35]);
  });

  test('ENUM does not mutate original array', () => {
    const vals = [1, 2, 3];
    const cfg  = { type: OPT_PARAM_TYPES.ENUM, values: vals };
    const out  = valuesForConfig(cfg);
    out.push(999);
    assert.deepStrictEqual(vals, [1, 2, 3]);
  });

  test('INTEGER generates inclusive range with step 1', () => {
    const cfg = { type: OPT_PARAM_TYPES.INTEGER, min: 2026, max: 2028, step: 1 };
    assert.deepStrictEqual(valuesForConfig(cfg), [2026, 2027, 2028]);
  });

  test('INTEGER generates range with step 2', () => {
    const cfg = { type: OPT_PARAM_TYPES.INTEGER, min: 0, max: 6, step: 2 };
    assert.deepStrictEqual(valuesForConfig(cfg), [0, 2, 4, 6]);
  });

  test('INTEGER rounds values to integers', () => {
    const cfg = { type: OPT_PARAM_TYPES.INTEGER, min: 10_000, max: 30_000, step: 10_000 };
    const out = valuesForConfig(cfg);
    assert.ok(out.every(v => Number.isInteger(v)), 'all values should be integers');
    assert.deepStrictEqual(out, [10_000, 20_000, 30_000]);
  });

  test('CONTINUOUS generates range with decimal step', () => {
    const cfg = { type: OPT_PARAM_TYPES.CONTINUOUS, min: 0.01, max: 0.03, step: 0.01 };
    const out = valuesForConfig(cfg).map(v => +v.toFixed(4));
    assert.deepStrictEqual(out, [0.01, 0.02, 0.03]);
  });
});

// ─── OPTIMIZATION_OBJECTIVES ─────────────────────────────────────────────────

describe('OPTIMIZATION_OBJECTIVES', () => {
  const result = {
    finalNetWorthUsd:  500_000,
    rothFinalBalance:  120_000,
    cumulativeDeficit: 15_000,
  };

  test('MAX_NET_WORTH evaluates finalNetWorthUsd', () => {
    assert.strictEqual(OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH.evaluate(result), 500_000);
    assert.strictEqual(OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH.direction, 'maximize');
  });

  test('MAX_ROTH_BALANCE evaluates rothFinalBalance', () => {
    assert.strictEqual(OPTIMIZATION_OBJECTIVES.MAX_ROTH_BALANCE.evaluate(result), 120_000);
    assert.strictEqual(OPTIMIZATION_OBJECTIVES.MAX_ROTH_BALANCE.direction, 'maximize');
  });

  test('MIN_DEFICIT evaluates cumulativeDeficit', () => {
    assert.strictEqual(OPTIMIZATION_OBJECTIVES.MIN_DEFICIT.evaluate(result), 15_000);
    assert.strictEqual(OPTIMIZATION_OBJECTIVES.MIN_DEFICIT.direction, 'minimize');
  });
});

// ─── Registry isolation ──────────────────────────────────────────────────────
//
// 4.1 (design/inconsistencies.md): the optimizer must not mutate the
// singleton ServiceRegistry. Mirror of the MC isolation test.

describe('IntlRetirementOptimizer registry isolation', () => {
  test('run() does not mutate the singleton ServiceRegistry', async () => {
    ServiceRegistry.resetAll();
    const before = ServiceRegistry.getInstance();
    const eventsBefore   = before.eventService.getAll().length;
    const accountsBefore = before.accountService.getAll().length;
    const configNodesBefore = before.graph.getNodes()
      .filter(n => n.layer === 'config').length;

    const opt = new IntlRetirementOptimizer({
      optimizationConfigs: [
        { paramKey: 'rothConversionMaxBracket', type: OPT_PARAM_TYPES.ENUM,
          values: [0.22, 0.24], enabled: true },
      ],
      simStart: new Date(Date.UTC(2026, 0, 1)),
      simEnd:   new Date(Date.UTC(2028, 1, 1)),
    });
    await opt.run();

    const after = ServiceRegistry.getInstance();
    assert.strictEqual(after, before, 'singleton instance must not be replaced');
    assert.strictEqual(after.eventService.getAll().length,   eventsBefore);
    assert.strictEqual(after.accountService.getAll().length, accountsBefore);
    assert.strictEqual(
      after.graph.getNodes().filter(n => n.layer === 'config').length,
      configNodesBefore,
      'optimizer must not touch the singleton config-layer graph'
    );
    assert.strictEqual(after.simulationRegistry.getPrimary(), null);
  });
});

// ─── IntlRetirementOptimizer._generateCandidates ─────────────────────────────

describe('IntlRetirementOptimizer._generateCandidates', () => {
  test('no enabled configs returns one empty candidate', () => {
    const opt = new IntlRetirementOptimizer({
      optimizationConfigs: [
        { paramKey: 'moveYear', type: OPT_PARAM_TYPES.INTEGER, min: 2026, max: 2028, step: 1, enabled: false },
      ],
    });
    assert.deepStrictEqual(opt._generateCandidates(), [{}]);
  });

  test('single ENUM config generates one candidate per value', () => {
    const opt = new IntlRetirementOptimizer({
      optimizationConfigs: [
        { paramKey: 'rothConversionMaxBracket', type: OPT_PARAM_TYPES.ENUM,
          values: [0.22, 0.24, 0.32], enabled: true },
      ],
    });
    assert.deepStrictEqual(opt._generateCandidates(), [
      { rothConversionMaxBracket: 0.22 },
      { rothConversionMaxBracket: 0.24 },
      { rothConversionMaxBracket: 0.32 },
    ]);
  });

  test('two configs produce Cartesian product', () => {
    const opt = new IntlRetirementOptimizer({
      optimizationConfigs: [
        { paramKey: 'rothConversionMaxBracket', type: OPT_PARAM_TYPES.ENUM,
          values: [0.22, 0.32], enabled: true },
        { paramKey: 'moveYear', type: OPT_PARAM_TYPES.INTEGER,
          min: 2026, max: 2027, step: 1, enabled: true },
      ],
    });
    const candidates = opt._generateCandidates();
    assert.strictEqual(candidates.length, 4); // 2 × 2
    assert.deepStrictEqual(candidates, [
      { rothConversionMaxBracket: 0.22, moveYear: 2026 },
      { rothConversionMaxBracket: 0.22, moveYear: 2027 },
      { rothConversionMaxBracket: 0.32, moveYear: 2026 },
      { rothConversionMaxBracket: 0.32, moveYear: 2027 },
    ]);
  });

  test('disabled configs are excluded from Cartesian product', () => {
    const opt = new IntlRetirementOptimizer({
      optimizationConfigs: [
        { paramKey: 'rothConversionMaxBracket', type: OPT_PARAM_TYPES.ENUM,
          values: [0.22, 0.32], enabled: true },
        { paramKey: 'moveYear', type: OPT_PARAM_TYPES.INTEGER,
          min: 2026, max: 2030, step: 1, enabled: false },
      ],
    });
    const candidates = opt._generateCandidates();
    assert.strictEqual(candidates.length, 2);
    assert.ok(candidates.every(c => !('moveYear' in c)));
  });
});

// ─── IntlRetirementOptimizer.candidateCount ───────────────────────────────────

describe('IntlRetirementOptimizer.candidateCount', () => {
  test('returns 1 when no configs enabled', () => {
    const opt = new IntlRetirementOptimizer({ optimizationConfigs: [] });
    assert.strictEqual(opt.candidateCount(), 1);
  });

  test('returns product of value counts for enabled configs', () => {
    const opt = new IntlRetirementOptimizer({
      optimizationConfigs: [
        { paramKey: 'rothConversionMaxBracket', type: OPT_PARAM_TYPES.ENUM,
          values: [0.22, 0.24, 0.32, 0.35], enabled: true },
        { paramKey: 'moveYear', type: OPT_PARAM_TYPES.INTEGER,
          min: 2026, max: 2030, step: 1, enabled: true },
      ],
    });
    // 4 bracket values × 5 years = 20
    assert.strictEqual(opt.candidateCount(), 20);
  });

  test('DEFAULT_OPTIMIZATION_CONFIGS with only maxBracket enabled = 6 candidates', () => {
    const opt = new IntlRetirementOptimizer({
      optimizationConfigs: DEFAULT_OPTIMIZATION_CONFIGS,
    });
    // Only rothConversionMaxBracket is enabled by default (6 bracket rates)
    assert.strictEqual(opt.candidateCount(), 6);
  });
});

// ─── Combined scenario + toolset schema mc/opt flags ─────────────────────────
//
// IntlRetirementScenario deliberately delegates non-binding params (rates,
// expenses, policy flags) to the toolsets that consume them. The UI/optimizer
// see the merged schema, so these assertions inspect that merged view.

describe('IntlRetirement combined param schema mc/opt flags', () => {
  test('every combined entry has boolean mc and opt fields', () => {
    for (const entry of COMBINED_SCHEMA) {
      assert.strictEqual(typeof entry.mc,  'boolean', `${entry.key}: mc must be boolean`);
      assert.strictEqual(typeof entry.opt, 'boolean', `${entry.key}: opt must be boolean`);
    }
  });

  test('rothConversionMaxBracket has opt:true', () => {
    const entry = COMBINED_SCHEMA.find(e => e.key === 'rothConversionMaxBracket');
    assert.ok(entry, 'rothConversionMaxBracket entry must exist');
    assert.strictEqual(entry.opt, true);
  });

  test('rothConversionStartYear has opt:true', () => {
    const entry = COMBINED_SCHEMA.find(e => e.key === 'rothConversionStartYear');
    assert.ok(entry);
    assert.strictEqual(entry.opt, true);
  });

  test('rothConversionEndYear has opt:true', () => {
    const entry = COMBINED_SCHEMA.find(e => e.key === 'rothConversionEndYear');
    assert.ok(entry);
    assert.strictEqual(entry.opt, true);
  });

  test('rothConversionEnabled has mc:false and opt:false', () => {
    const entry = COMBINED_SCHEMA.find(e => e.key === 'rothConversionEnabled');
    assert.ok(entry);
    assert.strictEqual(entry.mc,  false);
    assert.strictEqual(entry.opt, false);
  });

  test('growth rates have mc:true and opt:true', () => {
    // After deduplication these live in US_RETIREMENT and AU_RETIREMENT, which
    // set opt:true (the toolset-level defaults). brokerageGrowthRate replaces
    // the prior scenario-level usStockGrowthRate alias.
    const rateKeys = ['rothGrowthRate', 'iraGrowthRate', 'brokerageGrowthRate'];
    for (const k of rateKeys) {
      const entry = COMBINED_SCHEMA.find(e => e.key === k);
      assert.ok(entry, `${k} must be in combined schema`);
      assert.strictEqual(entry.mc,  true,  `${k}: mc should be true`);
      assert.strictEqual(entry.opt, true,  `${k}: opt should be true at the toolset level`);
    }
  });

  test('usSavingsMinBalance and auSavingsMinBalance have mc:false, opt:true', () => {
    for (const k of ['usSavingsMinBalance', 'auSavingsMinBalance']) {
      const entry = COMBINED_SCHEMA.find(e => e.key === k);
      assert.ok(entry);
      assert.strictEqual(entry.mc,  false);
      assert.strictEqual(entry.opt, true);
    }
  });

  test('no description contains legacy (MC) or (Opt) text markers', () => {
    for (const entry of COMBINED_SCHEMA) {
      assert.ok(
        !entry.description.includes('(MC') && !entry.description.includes('(Opt'),
        `${entry.key}: description should not contain legacy (MC)/(Opt) markers`
      );
    }
  });

  test('DEFAULT_OPTIMIZATION_CONFIGS only contains opt:true combined-schema params', () => {
    const optKeys = new Set(COMBINED_SCHEMA.filter(e => e.opt).map(e => e.key));
    for (const cfg of DEFAULT_OPTIMIZATION_CONFIGS) {
      // Nested path keys (e.g. shocks[0].severity) resolve into structured params
      // rather than flat schema entries — skip the flat-schema check for them.
      if (cfg.paramKey.includes('[')) continue;
      assert.ok(
        optKeys.has(cfg.paramKey),
        `${cfg.paramKey} in DEFAULT_OPTIMIZATION_CONFIGS must have opt:true in combined schema`
      );
    }
  });

  test('scenario schema does not duplicate any toolset paramSchema key (drift guard)', () => {
    // Catch future regressions where someone redeclares a toolset param at the
    // scenario level. Such drift caused the original missing-params-in-UI bug.
    const registry = new ToolsetRegistry();
    for (const t of [
      US_BANKING, US_TAX, US_STATE_TAX, US_RETIREMENT, US_INCOME, US_BROKERAGE,
      US_REAL_PROPERTY, US_COLLECTIBLES, US_ROTH_CONVERSION, US_EARLY_WITHDRAWAL,
      AU_BANKING, AU_TAX, AU_RETIREMENT, AU_INCOME, AU_BROKERAGE,
      AU_REAL_PROPERTY, US_AU_CROSS_BORDER, ECONOMIC_REGIMES,
    ]) registry.register(t);

    const toolsetKeys = new Set(
      IntlRetirementScenario.getToolsets()
        .flatMap(id => registry.get(id).paramSchema?.({}) ?? [])
        .map(e => e.key)
    );

    const duplicates = INTL_RETIREMENT_PARAM_SCHEMA
      .filter(s => toolsetKeys.has(s.key))
      .map(s => s.key);

    assert.deepStrictEqual(duplicates, [],
      `scenario must not redeclare toolset-owned keys; duplicates: ${duplicates.join(', ')}`);
  });
});
