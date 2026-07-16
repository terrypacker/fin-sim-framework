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

import { isParamVisible, indexParamSchema, resolveSweepVariables, visibleWhenControllers }
  from '../../src/finance/param-schema-utils.js';
import { IntlRetirementScenario, INTL_RETIREMENT_PARAM_ALIASES,
         DRAWDOWN_WEIGHT_ROLES, drawdownWeightKey, presentDrawdownWeightRoles,
         ALLOC_WEIGHT_CLASSES, allocWeightKey, ALLOCATION_OPTIMIZED_MODE }
  from '../../src/scenarios/intl-retirement-scenario.js';
import { ACCOUNT_ROLES }      from '../../src/finance/state/account-roles.js';
import { ScenarioParamGenerator } from '../../src/scenarios/params/scenario-param-generator.js';
import { ScenarioLoader, synthesizeWeightedPriorities } from '../../src/scenarios/scenario-loader.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { ServiceRegistry }    from '../../src/services/service-registry.js';
import { DEFAULT_MC_VARIABLE_CONFIGS } from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { DEFAULT_OPTIMIZATION_CONFIGS, buildOptVariables }
  from '../../src/finance/optimization/intl-retirement-opt-config.js';

// Every curated MC/Opt variable now keys on a real toolset or generated per-record param.
// The *Balance MC levers alias to the hidden, compile-only `acct.<stateKey>.balanceTarget`
// (design 55 §13), which the generator emits for every holdings-bearing account — so once
// the eligibility index is built from the COMPILED config (below), there are no orphans.
const KNOWN_ORPHANS = new Set([]);

// Design 55: per-record params (rothBalance→balanceTarget, usHouseSaleYear, primaryMonthlyWage…)
// are generated from records rather than living in the static schema, and the generator keys
// the swap off whether an account carries holdings. That is only true post-COMPILE (every
// account bootstraps a holding), so build the eligibility index from a compiled config —
// static schema + generated params — exactly as the loader presents it, then resolve legacy
// alias keys to their generated equivalents.
function buildEligibilityIndex() {
  const simStart = new Date(Date.UTC(2026, 0, 1));
  const simEnd   = new Date(Date.UTC(2041, 0, 1));
  const registry = new ServiceRegistry();
  const scenario = new IntlRetirementScenario({
    context: registry.simulationContext, params: {}, simStart, simEnd });
  scenario.buildSim();
  const cfg = ScenarioSerializer.serializeScenario(
    IntlRetirementScenario.buildDefaultConfig({}, simStart, simEnd));
  new ScenarioLoader().load(cfg, registry);   // compiles: bootstraps holdings on every account
  return indexParamSchema([
    ...IntlRetirementScenario.buildFullParamSchema(),
    ...ScenarioParamGenerator.generate(cfg),
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

// ── isParamVisible — composable DSL (design 61 usability pass) ──────────────────

test('SWEEP-3a: array of conditions is AND (all must pass)', () => {
  const vals = { strat: ['TARGET_ALLOCATION'], mode: 'LOCATED' };
  const meta = { visibleWhen: [
    { param: 'strat', includes: 'TARGET_ALLOCATION' },
    { param: 'mode',  equals:   'LOCATED' },
  ] };
  assert.strictEqual(isParamVisible(meta, k => vals[k]), true);
  // Either clause false ⇒ hidden.
  assert.strictEqual(isParamVisible(meta, k => ({ ...vals, strat: [] })[k]), false);
  assert.strictEqual(isParamVisible(meta, k => ({ ...vals, mode: 'PER_ACCOUNT' })[k]), false);
});

test('SWEEP-3b: allOf / anyOf / not compose', () => {
  const valueOf = k => ({ a: 5, b: 'x', list: ['p'] }[k]);
  assert.strictEqual(isParamVisible({ visibleWhen: { allOf: [{ param: 'a', gte: 5 }, { param: 'b', equals: 'x' }] } }, valueOf), true);
  assert.strictEqual(isParamVisible({ visibleWhen: { anyOf: [{ param: 'a', gt: 10 }, { param: 'b', equals: 'x' }] } }, valueOf), true);
  assert.strictEqual(isParamVisible({ visibleWhen: { not: { param: 'list', includes: 'p' } } }, valueOf), false);
});

test('SWEEP-3c: extended leaf operators (notEquals/in/exists/lt)', () => {
  const valueOf = k => ({ v: 3, s: 'b', empty: '' }[k]);
  assert.strictEqual(isParamVisible({ visibleWhen: { param: 's', notEquals: 'a' } }, valueOf), true);
  assert.strictEqual(isParamVisible({ visibleWhen: { param: 's', in: ['a', 'b'] } }, valueOf), true);
  assert.strictEqual(isParamVisible({ visibleWhen: { param: 'v', lt: 5 } }, valueOf), true);
  assert.strictEqual(isParamVisible({ visibleWhen: { param: 'empty', exists: true } }, valueOf), false);
  assert.strictEqual(isParamVisible({ visibleWhen: { param: 'v', exists: true } }, valueOf), true);
});

test('SWEEP-3d: visibleWhenControllers collects every referenced param (recursively)', () => {
  assert.deepStrictEqual(visibleWhenControllers({ visibleWhen: { param: 'x', equals: 1 } }), ['x']);
  assert.deepStrictEqual(
    visibleWhenControllers({ visibleWhen: [{ param: 'a', equals: 1 }, { param: 'b', includes: 'z' }] }).sort(),
    ['a', 'b']);
  assert.deepStrictEqual(
    visibleWhenControllers({ visibleWhen: { anyOf: [{ param: 'c' }, { not: { param: 'd', equals: 2 } }] } }).sort(),
    ['c', 'd']);
  assert.deepStrictEqual(visibleWhenControllers({}), []);
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

// ── Opt integration: Lever-B drawdown weights pruned to backed roles (design 58) ─

const WEIGHTED_BASE = {
  drawdownStrategy: 'WEIGHTED', spendingStrategy: ['FIXED'], behavioralStrategies: [],
};

test('SWEEP-12: no accounts arg → every drawdown-weight axis is present (back-compat)', () => {
  const keys = new Set(buildOptVariables(WEIGHTED_BASE).map(v => v.paramKey));
  for (const role of DRAWDOWN_WEIGHT_ROLES) {
    assert.ok(keys.has(drawdownWeightKey(role)), `expected weight axis for ${role}`);
  }
});

test('SWEEP-13: accounts arg prunes drawdown-weight axes to roles an account backs', () => {
  // Only IRA + Roth accounts exist — the other six weighted roles are phantom.
  const accounts = [
    { role: ACCOUNT_ROLES.IRA }, { role: ACCOUNT_ROLES.ROTH },
    { role: ACCOUNT_ROLES.US_SAVINGS },   // cash role: never a weight axis
  ];
  const swept = new Set(buildOptVariables(WEIGHTED_BASE, accounts).map(v => v.paramKey));
  const presentKeys = presentDrawdownWeightRoles(accounts.map(a => a.role)).map(drawdownWeightKey);

  // Exactly the two backed investment roles are swept…
  assert.deepStrictEqual(
    presentKeys.sort(),
    [drawdownWeightKey(ACCOUNT_ROLES.IRA), drawdownWeightKey(ACCOUNT_ROLES.ROTH)].sort());
  for (const k of presentKeys) assert.ok(swept.has(k), `expected swept axis ${k}`);
  // …and no phantom-role axis survives.
  for (const role of DRAWDOWN_WEIGHT_ROLES) {
    if (role === ACCOUNT_ROLES.IRA || role === ACCOUNT_ROLES.ROTH) continue;
    assert.ok(!swept.has(drawdownWeightKey(role)), `phantom weight axis leaked: ${role}`);
  }
});

test('SWEEP-14: synthesizeWeightedPriorities drops phantom roles yet keeps real order', () => {
  const node = {
    weightKeyPrefix: 'drawdownWeight', weightKeySep: '::',
    weightRoles: [ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.K401, ACCOUNT_ROLES.ROTH],
    cashRoles: [ACCOUNT_ROLES.US_SAVINGS],
    weightDefaults: {},
  };
  // Weights: Roth(0.2) < IRA(0.5) < 401k(0.8) → real draw order roth, ira (401k phantom).
  const params = {
    [drawdownWeightKey(ACCOUNT_ROLES.ROTH)]: 0.2,
    [drawdownWeightKey(ACCOUNT_ROLES.IRA)]:  0.5,
    [drawdownWeightKey(ACCOUNT_ROLES.K401)]: 0.8,
  };
  const present = new Set([ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.ROTH, ACCOUNT_ROLES.US_SAVINGS]);
  const pri = synthesizeWeightedPriorities(node, params, present);

  assert.ok(!(ACCOUNT_ROLES.K401 in pri), 'phantom 401k must not appear in the map');
  // Ranks are compressed (no gaps) and preserve the real relative order roth < ira.
  assert.strictEqual(pri[ACCOUNT_ROLES.US_SAVINGS], 0, 'cash drawn first');
  assert.ok(pri[ACCOUNT_ROLES.ROTH] < pri[ACCOUNT_ROLES.IRA], 'roth ranked before ira');
  assert.strictEqual(pri[ACCOUNT_ROLES.ROTH], 1);
  assert.strictEqual(pri[ACCOUNT_ROLES.IRA], 2);
});

// ── Opt integration: Lever-A allocation weights (design 61) ─────────────────────

// The allocWeight axes require BOTH the lever selected AND the OPTIMIZED strategy
// (the compound visibleWhen added with the Phase-4 visibility-leak fix).
const OPTIMIZED_ALLOC = {
  allocationStrategy: ALLOCATION_OPTIMIZED_MODE,
  drawdownStrategy: 'TAXABLE_FIRST', spendingStrategy: ['FIXED'],
  behavioralStrategies: ['TARGET_ALLOCATION'],
};

// Every non-residual class has an opt axis; the residual (last) class carries none.
const ALLOC_AXIS_KEYS = ALLOC_WEIGHT_CLASSES.slice(0, -1).map(allocWeightKey);

test('SWEEP-15: allocWeight axes are present under TARGET_ALLOCATION + OPTIMIZED', () => {
  const keys = new Set(buildOptVariables(OPTIMIZED_ALLOC).map(v => v.paramKey));
  for (const k of ALLOC_AXIS_KEYS) assert.ok(keys.has(k), `expected alloc axis ${k}`);
  // The residual class never gets an axis.
  assert.ok(!keys.has(allocWeightKey(ALLOC_WEIGHT_CLASSES.at(-1))), 'residual class must have no axis');
});

test('SWEEP-16: allocWeight axes are hidden when allocationStrategy is STATIC', () => {
  const keys = new Set(buildOptVariables({ ...OPTIMIZED_ALLOC, allocationStrategy: 'STATIC' })
    .map(v => v.paramKey));
  for (const k of ALLOC_AXIS_KEYS) assert.ok(!keys.has(k), `alloc axis ${k} leaked under STATIC`);
});

test('SWEEP-16b: allocWeight axes hidden when TARGET_ALLOCATION is unselected (leak guard)', () => {
  // Even with allocationStrategy=OPTIMIZED, the axes must NOT appear when the lever
  // itself isn't selected — the compound gate's first clause.
  const keys = new Set(buildOptVariables({ ...OPTIMIZED_ALLOC, behavioralStrategies: [] })
    .map(v => v.paramKey));
  for (const k of ALLOC_AXIS_KEYS) assert.ok(!keys.has(k), `alloc axis ${k} leaked without the lever`);
});

test('SWEEP-17: accounts arg keeps allocWeight axes reachable (all classes present in Phase 1)', () => {
  const accounts = [{ role: ACCOUNT_ROLES.IRA }, { role: ACCOUNT_ROLES.ROTH }];
  const keys = new Set(buildOptVariables(OPTIMIZED_ALLOC, accounts).map(v => v.paramKey));
  for (const k of ALLOC_AXIS_KEYS) assert.ok(keys.has(k), `expected alloc axis ${k} with accounts`);
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
