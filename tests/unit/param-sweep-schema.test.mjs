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
 * param-sweep-schema.test.mjs
 *
 * The param schema is the single source of identity (label / options /
 * visibleWhen). The MC and Opt variable overlays inherit from it by paramKey
 * and filter out hidden strategy knobs. These tests cover:
 *   - the shared isParamVisible / resolveSweepVariables helpers,
 *   - Opt variable list hides/show strategy knobs by the base strategy selection,
 *   - every curated overlay key is schema-eligible (the repurposed mc/opt flags).
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { isParamVisible, indexParamSchema, resolveSweepVariables }
  from '../../src/finance/param-schema-utils.js';
import { IntlRetirementScenario, INTL_RETIREMENT_PARAM_ALIASES }
  from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioParamGenerator } from '../../src/scenarios/params/scenario-param-generator.js';
import { DEFAULT_MC_VARIABLE_CONFIGS } from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { DEFAULT_OPTIMIZATION_CONFIGS, buildOptVariables }
  from '../../src/finance/optimization/intl-retirement-opt-config.js';

// Every curated MC/Opt variable now keys on a real toolset param — the old
// scenario-default aliases (usStockGrowthRate / stockDividendRate / usInflationRate)
// were renamed to their toolset keys once the per-account growth refactor made
// brokerageGrowthRate a live lever. Synthesized per-shock rows aren't in DEFAULT_*.
const KNOWN_ORPHANS = new Set();

// Design 55: per-record params (rothBalance, usHouseSaleYear, primaryMonthlyWage…)
// are generated from records rather than living in the static schema. Build the
// eligibility index the way the loader presents it — static schema + generated
// params — and resolve legacy alias keys to their generated equivalents.
function buildEligibilityIndex() {
  const defaultCfg = IntlRetirementScenario.buildDefaultConfig(
    {}, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2041, 0, 1)));
  return indexParamSchema([
    ...IntlRetirementScenario.buildFullParamSchema(),
    ...ScenarioParamGenerator.generate(defaultCfg),
  ]);
}
const resolveAlias = k => INTL_RETIREMENT_PARAM_ALIASES[k] ?? k;

// ── isParamVisible ─────────────────────────────────────────────────────────────

test('SWEEP-1: isParamVisible — no condition is always visible', () => {
  assert.strictEqual(isParamVisible({}, () => undefined), true);
  assert.strictEqual(isParamVisible({ visibleWhen: {} }, () => undefined), true);
});

test('SWEEP-2: isParamVisible — includes matches array membership', () => {
  const meta = { visibleWhen: { param: 'spendingStrategy', includes: 'AGE_BANDED' } };
  assert.strictEqual(isParamVisible(meta, () => ['FIXED', 'AGE_BANDED']), true);
  assert.strictEqual(isParamVisible(meta, () => ['FIXED']), false);
  assert.strictEqual(isParamVisible(meta, () => undefined), false);
});

test('SWEEP-3: isParamVisible — equals matches scalar', () => {
  const meta = { visibleWhen: { param: 'advanced', equals: true } };
  assert.strictEqual(isParamVisible(meta, () => true), true);
  assert.strictEqual(isParamVisible(meta, () => false), false);
});

// ── resolveSweepVariables ──────────────────────────────────────────────────────

test('SWEEP-4: resolveSweepVariables inherits visibleWhen from schema; label overlay-wins', () => {
  const schema = indexParamSchema([
    { key: 'k1', label: 'Schema Label', visibleWhen: { param: 'sel', includes: 'X' } },
  ]);
  const [out] = resolveSweepVariables(
    [{ paramKey: 'k1', label: 'Overlay Label', min: 0 }],
    schema,
    { sel: ['X'] },
  );
  assert.deepStrictEqual(out.visibleWhen, { param: 'sel', includes: 'X' }, 'visibleWhen from schema');
  assert.strictEqual(out.label, 'Overlay Label', 'overlay label wins');
  assert.strictEqual(out.min, 0, 'sweep metadata preserved');
});

test('SWEEP-5: resolveSweepVariables fills label from schema when overlay omits it', () => {
  const schema = indexParamSchema([{ key: 'k1', label: 'Schema Label' }]);
  const [out] = resolveSweepVariables([{ paramKey: 'k1' }], schema, {});
  assert.strictEqual(out.label, 'Schema Label');
});

test('SWEEP-6: resolveSweepVariables drops entries hidden by visibleWhen', () => {
  const schema = indexParamSchema([
    { key: 'shown',  visibleWhen: { param: 'sel', includes: 'A' } },
    { key: 'hidden', visibleWhen: { param: 'sel', includes: 'B' } },
  ]);
  const out = resolveSweepVariables(
    [{ paramKey: 'shown' }, { paramKey: 'hidden' }],
    schema,
    { sel: ['A'] },
  );
  assert.deepStrictEqual(out.map(o => o.paramKey), ['shown']);
});

test('SWEEP-7: resolveSweepVariables keeps orphan keys (no schema entry) as-is', () => {
  const out = resolveSweepVariables(
    [{ paramKey: 'shocks[0].severity', label: 'Shock 0 Severity' }],
    indexParamSchema([]),
    {},
  );
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].label, 'Shock 0 Severity');
});

// ── Opt integration: strategy knobs hide/show by base selection ────────────────

test('SWEEP-8: Opt hides strategy knobs when the strategy is not selected', () => {
  const vars = buildOptVariables({ spendingStrategy: ['FIXED'], behavioralStrategies: [] });
  const keys = vars.map(v => v.paramKey);
  assert.ok(!keys.includes('guardrailCutThreshold'), 'guardrail hidden under FIXED');
  assert.ok(!keys.includes('regimeAwareCutPct'),     'regime-aware hidden under FIXED');
  assert.ok(!keys.includes('panicFraction'),         'panic-sell hidden with no behavioral');
});

test('SWEEP-9: Opt shows strategy knobs (with inherited visibleWhen) when selected', () => {
  const vars = buildOptVariables({
    spendingStrategy:     ['GUARDRAIL'],
    behavioralStrategies: ['PANIC_SELL'],
  });
  const g = vars.find(v => v.paramKey === 'guardrailCutThreshold');
  const p = vars.find(v => v.paramKey === 'panicFraction');
  assert.ok(g, 'guardrail visible under GUARDRAIL');
  assert.deepStrictEqual(g.visibleWhen, { param: 'spendingStrategy', includes: 'GUARDRAIL' });
  assert.ok(p, 'panicFraction visible under PANIC_SELL');
  assert.deepStrictEqual(p.visibleWhen, { param: 'behavioralStrategies', includes: 'PANIC_SELL' });
});

// ── Validation: the repurposed mc:/opt: flags ──────────────────────────────────

test('SWEEP-10: every curated Opt variable is schema-eligible (opt:true) or a known orphan', () => {
  const byKey = buildEligibilityIndex();
  const offenders = DEFAULT_OPTIMIZATION_CONFIGS.filter(v => {
    if (KNOWN_ORPHANS.has(v.paramKey)) return false;
    const s = byKey.get(resolveAlias(v.paramKey));
    return !s || !s.opt;
  }).map(v => v.paramKey);
  assert.deepStrictEqual(offenders, [],
    `Opt variables must exist in the schema with opt:true — offenders: ${offenders.join(', ')}`);
});

test('SWEEP-11: every curated MC variable is schema-eligible (mc:true) or a known orphan', () => {
  const byKey = buildEligibilityIndex();
  const offenders = DEFAULT_MC_VARIABLE_CONFIGS.filter(v => {
    if (KNOWN_ORPHANS.has(v.paramKey)) return false;
    const s = byKey.get(resolveAlias(v.paramKey));
    return !s || !s.mc;
  }).map(v => v.paramKey);
  assert.deepStrictEqual(offenders, [],
    `MC variables must exist in the schema with mc:true — offenders: ${offenders.join(', ')}`);
});
