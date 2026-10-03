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
 * evt-job-sweeps.test.mjs — design 116 phase 4: the `job.` levers, proven LIVE on a
 * loaded scenario.
 *
 * Every earlier dead lever (design 98 W0, the toolset-forwarding drop, the legacy-alias
 * drop, the zero-base axis) passed a hand-written flat-bag test. So each lever here is set
 * the way an MC iteration or an optimizer candidate sets it — `set()` into a bag, then
 * `applyParamBagToConfig` onto a serialized cfg, then `ScenarioLoader.load` — and the test
 * asserts the EFFECT: the wage the sim actually credits.
 *
 *   JSW-1: one monthlyWage and one realGrowth lever per job, no date levers (Q2 is open)
 *   JSW-2: set() writes a `job.` key flat (it is a generated namespace)
 *   JSW-3: job.<id>.monthlyWage moves the credited wage
 *   JSW-4: job.<id>.realGrowth moves the wage after the first anniversary
 *   JSW-5: the MC harvest centres each lever on its job's value
 *   JSW-6: a Jobs-table edit is not clobbered by a saved param on the next load
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { ScenarioParamGenerator } from '../../src/scenarios/params/scenario-param-generator.js';
import { applyParamBagToConfig, resolveRecordCenters } from '../../src/scenarios/scenario-param-apply.js';
import { replacePersonJobs }      from '../../src/scenarios/scenario-jobs.js';
import { set }                    from '../../src/finance/monte-carlo/mc-param-paths.js';

const D  = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const SS = D(2026, 1, 1);

const JOBS = [
  { id: 'primary-job-1', personId: 'primary', endDate: '2026-07-01', monthlyWage: 8000,
    wageCurrency: 'USD' },
  { id: 'primary-job-2', personId: 'primary', startDate: '2026-07-01', monthlyWage: 9000,
    realGrowth: 0, wageCurrency: 'USD' },
];

function baseCfg(simEnd) {
  const cfg = ScenarioSerializer.serializeScenario(
    IntlRetirementScenario.buildDefaultConfig({ fxProcessModel: 'NONE' }, SS, simEnd));
  cfg.jobs = structuredClone(JOBS);
  return cfg;
}

/** Load `cfg`, run to `simEnd`, return { month → primary wage }. */
function primaryWages(cfg, simEnd) {
  ServiceRegistry.resetAll();
  const reg = ServiceRegistry.getInstance();
  const sc  = new IntlRetirementScenario({ context: reg.simulationContext, simStart: SS, simEnd });
  sc.buildSim();
  new ScenarioLoader().load(cfg, reg);
  sc.sim.silent = true;
  sc.sim.stepTo(simEnd);
  const out = {};
  for (const e of sc.sim.journal.journal) {
    const d = e.action?.data ?? e.action ?? {};
    if (e.action?.type !== 'WAGES_INCOME_APPLY' || d.personKey !== 'primary') continue;
    const dt = new Date(e.date);
    out[`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`] = d.amount;
  }
  return { wages: out, cfg, sim: sc.sim };
}

test('JSW-1: one wage and one real-growth lever per job, and no date lever', () => {
  const entries = ScenarioParamGenerator.generate(baseCfg(D(2027, 1, 1)))
    .filter(e => e.key.startsWith('job.'));
  assert.deepEqual(entries.map(e => e.key).sort(), [
    'job.primary-job-1.monthlyWage', 'job.primary-job-1.realGrowth',
    'job.primary-job-2.monthlyWage', 'job.primary-job-2.realGrowth',
  ]);
  const growth = entries.find(e => e.key === 'job.primary-job-2.realGrowth');
  assert.equal(growth.mc, 'rate', 'an additive rate centred on 0 is named, not inferred');
  assert.deepEqual(growth.node, { type: 'job', id: 'primary-job-2', field: 'realGrowth' });
});

test('JSW-2: set() writes a job. key flat', () => {
  const bag = {};
  set(bag, 'job.primary-job-1.monthlyWage', 123);
  assert.equal(bag['job.primary-job-1.monthlyWage'], 123);
});

test('JSW-3: job.<id>.monthlyWage moves the wage the sim credits', () => {
  const end = D(2026, 9, 1);
  const base = primaryWages(baseCfg(end), end).wages;
  assert.equal(base['2026-03'], 8000);
  assert.equal(base['2026-08'], 9000);

  const bag = {};
  set(bag, 'job.primary-job-2.monthlyWage', 12000);
  const moved = primaryWages(applyParamBagToConfig(baseCfg(end), bag), end).wages;
  assert.equal(moved['2026-03'], 8000, 'the other job is untouched');
  assert.equal(moved['2026-08'], 12000);
});

test('JSW-4: job.<id>.realGrowth compounds from the job\'s first anniversary', () => {
  const end = D(2027, 9, 1);
  const bag = {};
  set(bag, 'job.primary-job-2.realGrowth', 0.05);
  const { wages, sim } = primaryWages(applyParamBagToConfig(baseCfg(end), bag), end);
  const idx = sim.state.wageIndex.US;
  assert.equal(wages['2027-06'], 9000 * idx, 'before the anniversary: no growth');
  assert.equal(wages['2027-07'], 9000 * idx * 1.05, 'from 1 Jul 2027: one year of growth');
});

test('JSW-5: the MC harvest centres each lever on its job\'s value', () => {
  const centers = resolveRecordCenters(baseCfg(D(2027, 1, 1)));
  assert.equal(centers['job.primary-job-1.monthlyWage'], 8000);
  assert.equal(centers['job.primary-job-2.realGrowth'], 0);
});

test('JSW-6: a Jobs-table edit survives a saved param at the old value', () => {
  const end = D(2026, 9, 1);
  // First load materializes the generated params into cfg.params (as a saved scenario has).
  const { cfg } = primaryWages(baseCfg(end), end);
  assert.ok(cfg.params.some(p => p.name === 'job.primary-job-2.monthlyWage'));
  replacePersonJobs(cfg, 'primary', cfg.jobs.map(j =>
    (j.id === 'primary-job-2' ? { ...j, monthlyWage: 9500 } : j)));
  const { wages } = primaryWages(cfg, end);
  assert.equal(wages['2026-08'], 9500);
});
