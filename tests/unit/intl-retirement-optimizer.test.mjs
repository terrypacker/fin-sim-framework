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
import { valuesForConfig, IntlRetirementOptimizer }
  from '../../src/finance/optimization/intl-retirement-optimizer.js';
import { DEFAULT_OPTIMIZATION_CONFIGS }
  from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { INTL_RETIREMENT_PARAM_SCHEMA }
  from '../../src/scenarios/intl-retirement-scenario.js';

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

// ─── INTL_RETIREMENT_PARAM_SCHEMA mc/opt flags ───────────────────────────────

describe('INTL_RETIREMENT_PARAM_SCHEMA mc/opt flags', () => {
  test('every entry has boolean mc and opt fields', () => {
    for (const entry of INTL_RETIREMENT_PARAM_SCHEMA) {
      assert.strictEqual(typeof entry.mc,  'boolean', `${entry.key}: mc must be boolean`);
      assert.strictEqual(typeof entry.opt, 'boolean', `${entry.key}: opt must be boolean`);
    }
  });

  test('rothConversionMaxBracket has opt:true', () => {
    const entry = INTL_RETIREMENT_PARAM_SCHEMA.find(e => e.key === 'rothConversionMaxBracket');
    assert.ok(entry, 'rothConversionMaxBracket entry must exist');
    assert.strictEqual(entry.opt, true);
  });

  test('rothConversionStartYear has opt:true', () => {
    const entry = INTL_RETIREMENT_PARAM_SCHEMA.find(e => e.key === 'rothConversionStartYear');
    assert.ok(entry);
    assert.strictEqual(entry.opt, true);
  });

  test('rothConversionEndYear has opt:true', () => {
    const entry = INTL_RETIREMENT_PARAM_SCHEMA.find(e => e.key === 'rothConversionEndYear');
    assert.ok(entry);
    assert.strictEqual(entry.opt, true);
  });

  test('rothConversionEnabled has mc:false and opt:false', () => {
    const entry = INTL_RETIREMENT_PARAM_SCHEMA.find(e => e.key === 'rothConversionEnabled');
    assert.ok(entry);
    assert.strictEqual(entry.mc,  false);
    assert.strictEqual(entry.opt, false);
  });

  test('growth rates have mc:true and opt:false', () => {
    const rateKeys = ['rothGrowthRate', 'iraGrowthRate', 'usStockGrowthRate'];
    for (const k of rateKeys) {
      const entry = INTL_RETIREMENT_PARAM_SCHEMA.find(e => e.key === k);
      assert.ok(entry, `${k} must be in schema`);
      assert.strictEqual(entry.mc,  true,  `${k}: mc should be true`);
      assert.strictEqual(entry.opt, false, `${k}: opt should be false (market rate, not a decision)`);
    }
  });

  test('usSavingsMinBalance and auSavingsMinBalance have mc:false, opt:true', () => {
    for (const k of ['usSavingsMinBalance', 'auSavingsMinBalance']) {
      const entry = INTL_RETIREMENT_PARAM_SCHEMA.find(e => e.key === k);
      assert.ok(entry);
      assert.strictEqual(entry.mc,  false);
      assert.strictEqual(entry.opt, true);
    }
  });

  test('no description contains legacy (MC) or (Opt) text markers', () => {
    for (const entry of INTL_RETIREMENT_PARAM_SCHEMA) {
      assert.ok(
        !entry.description.includes('(MC') && !entry.description.includes('(Opt'),
        `${entry.key}: description should not contain legacy (MC)/(Opt) markers`
      );
    }
  });

  test('DEFAULT_OPTIMIZATION_CONFIGS only contains opt:true schema params', () => {
    const optKeys = new Set(
      INTL_RETIREMENT_PARAM_SCHEMA.filter(e => e.opt).map(e => e.key)
    );
    for (const cfg of DEFAULT_OPTIMIZATION_CONFIGS) {
      assert.ok(
        optKeys.has(cfg.paramKey),
        `${cfg.paramKey} in DEFAULT_OPTIMIZATION_CONFIGS must have opt:true in schema`
      );
    }
  });
});
