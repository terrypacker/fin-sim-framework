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
 * mc-shadowed-axes.test.mjs — design 98 W5 (F5): a role-level MC row that a
 * per-account field overrides is tagged `shadowedBy` / `shadowedAll`, from the one
 * ROLE_PARAM_OVERRIDES table. The config-dependent liveness gate itself (the tag must
 * PREDICT the deadness) lives in mc-axis-liveness.test.mjs, MC-LIVE-6.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { IntlRetirementMcConfig } from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { summarizeProvenance }    from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { ROLE_PARAM_OVERRIDES }   from '../../src/scenarios/toolsets/economic-regimes-toolset.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { paramSchemaDefaults, scenarioParamValues } from '../../src/finance/param-schema-utils.js';

function reference(extra = {}) {
  const cfg  = IntlRetirementScenario.buildDefaultConfig({});
  const base = { ...paramSchemaDefaults(IntlRetirementScenario.buildFullParamSchema()),
    ...scenarioParamValues(cfg), ...extra };
  return new IntlRetirementMcConfig().buildVariables(base, { cfg });
}
const row = (vars, k) => vars.find(v => v.paramKey === k);

test('W5-1: nothing pinned — no row is tagged', () => {
  assert.deepEqual(reference().filter(v => v.shadowedBy).map(v => v.paramKey), []);
});

test('W5-2: pinning the only US brokerage makes brokerageGrowthRate dead', () => {
  const r = row(reference({ 'acct.usStockAccount.growthRate': 0.06 }), 'brokerageGrowthRate');
  assert.deepEqual(r.shadowedBy, ['usStockAccount']);
  assert.equal(r.shadowedAll, true);
});

test('W5-3: pinning one of two Roth accounts shadows the axis but does not kill it', () => {
  const r = row(reference({ 'acct.rothAccount.growthRate': 0.09 }), 'rothGrowthRate');
  assert.deepEqual(r.shadowedBy, ['rothAccount']);
  assert.equal(r.shadowedAll, false, 'spouseRothAccount still hears rothGrowthRate');
});

test('W5-4: a pinned brokerage dividendRate leaves brokerageDividendRate live via the IRA/Roth/401(k) yield fallback', () => {
  const r = row(reference({ 'acct.usStockAccount.dividendRate': 0.03 }), 'brokerageDividendRate');
  assert.deepEqual(r.shadowedBy, ['usStockAccount']);
  assert.equal(r.shadowedAll, false);
});

test('W5-5: a record-level override counts too, not only a bag param', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({});
  cfg.accounts.find(a => a.stateKey === 'auStockAccount').dividendRate = 0.05;
  const base = { ...paramSchemaDefaults(IntlRetirementScenario.buildFullParamSchema()),
    ...scenarioParamValues(cfg) };
  const r = row(new IntlRetirementMcConfig().buildVariables(base, { cfg }), 'auStockDividendRate');
  assert.equal(r.shadowedAll, true);
});

test('W5-6: the run provenance carries the tags', () => {
  const vars = reference({ 'acct.usStockAccount.growthRate': 0.06 });
  const { shadowed } = summarizeProvenance(vars);
  const s = shadowed.find(x => x.paramKey === 'brokerageGrowthRate');
  assert.deepEqual([s.shadowedBy, s.shadowedAll, s.enabled], [['usStockAccount'], true, true]);
});

test('W5-7: the table covers every role growth param the seeder reads', () => {
  const growth = ROLE_PARAM_OVERRIDES.filter(r => r.field === 'growthRate').map(r => r.param);
  assert.deepEqual(growth.sort(), ['auStockGrowthRate', 'brokerageGrowthRate', 'iraGrowthRate',
    'k401GrowthRate', 'rothGrowthRate', 'superGrowthRate']);
});
