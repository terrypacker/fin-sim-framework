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
 *   JSW-1: wage + real-growth levers per job; date levers only where they are a fact
 *   JSW-2: set() writes a `job.` key flat (it is a generated namespace)
 *   JSW-3: job.<id>.monthlyWage moves the credited wage
 *   JSW-4: job.<id>.realGrowth moves the wage after the first anniversary
 *   JSW-5: the MC harvest centres each lever on its job's value
 *   JSW-6: a Jobs-table edit is not clobbered by a saved param on the next load
 *   JSW-7: Q2 — a shared boundary is ONE lever (the later start); a gap is two; reach splits room
 *   JSW-8: the optimizer's date row is clipped to that reach, in whole months
 *   JSW-9: moving a shared start moves the previous end with it, on a loaded scenario
 *   JSW-10: hand-widened ranges that can cross are caught before a run; defaults never are
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
import { jobDateLevers, jobDateRangeConflicts } from '../../src/finance/payroll/employment.js';
import { optRowFor }              from '../../src/finance/optimization/intl-retirement-opt-config.js';

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

test('JSW-1: wage and growth per job; the one shared boundary is one date lever', () => {
  const entries = ScenarioParamGenerator.generate(baseCfg(D(2027, 1, 1)))
    .filter(e => e.key.startsWith('job.'));
  // Job 1 starts blank (the run's start) and ends where job 2 starts; job 2 never ends.
  // So the only date that is a fact of its own is job 2's start.
  assert.deepEqual(entries.map(e => e.key).sort(), [
    'job.primary-job-1.monthlyWage', 'job.primary-job-1.realGrowth',
    'job.primary-job-2.monthlyWage', 'job.primary-job-2.realGrowth',
    'job.primary-job-2.startDate',
  ]);
  const start = entries.find(e => e.key === 'job.primary-job-2.startDate');
  assert.equal(start.mc, false, 'a career move is a decision: optimizer only');
  assert.equal(start.opt, true);
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

test('JSW-7: one lever per boundary; neighbours split the room between them', () => {
  const levers = jobDateLevers([
    { id: 'a', personId: 'p', startDate: '2027-01-01', endDate: '2030-01-01' },
    { id: 'b', personId: 'p', startDate: '2030-01-01', endDate: '2031-01-01' },  // shared start
    { id: 'c', personId: 'p', startDate: '2031-06-01', endDate: '2040-01-01' },  // after a gap
  ]).get('p');
  assert.deepEqual(levers.map(l => `${l.jobId}.${l.field}`),
    ['a.startDate', 'b.startDate', 'b.endDate', 'c.startDate', 'c.endDate'],
    'a.endDate is b.startDate — one lever, owned by the start');
  const at = k => levers.find(l => `${l.jobId}.${l.field}` === k);
  // a.start ↔ b.start: 36 months apart, 35 to share; capped at the ±24 default reach.
  assert.equal(at('a.startDate').up, 18);
  assert.equal(at('b.startDate').down, 17);
  // b.end ↔ c.start: a 5-month gap leaves 4 months to share, 2 each.
  assert.equal(at('b.endDate').up, 2);
  assert.equal(at('c.startDate').down, 2);
  assert.equal(at('a.startDate').down, 24, 'no neighbour before: the default reach');
  assert.equal(at('c.endDate').up, 24);
  // Every lever at its extreme toward a neighbour still leaves a month between them.
  for (let i = 1; i < levers.length; i++) {
    const m = d => { const x = new Date(d); return x.getUTCFullYear() * 12 + x.getUTCMonth(); };
    assert.ok(m(levers[i].date) - levers[i].down - (m(levers[i - 1].date) + levers[i - 1].up) >= 1);
  }
});

test('JSW-8: the optimizer\'s date row is clipped to the lever\'s reach', () => {
  const cfg = baseCfg(D(2027, 1, 1));
  cfg.jobs[1].endDate = '2026-10-31';     // a short second job: little room after its start
  const entries = ScenarioParamGenerator.generate(cfg);
  const start = entries.find(e => e.key === 'job.primary-job-2.startDate');
  const row = optRowFor('date', '2026-07-01', start);
  assert.equal(row.max, '2026-08-01', '3 months to its own end leaves 2 to share: 1 each way');
  assert.equal(row.min, '2024-07-01', 'no job before it starts: the ±2 year default');
  const end = entries.find(e => e.key === 'job.primary-job-2.endDate');
  assert.equal(optRowFor('date', '2026-10-31', end).min, '2026-09-30', 'the 31st clamps to the 30th');
});

test('JSW-9: moving a shared start moves the previous job\'s end with it', () => {
  const end = D(2026, 9, 1);
  const bag = {};
  set(bag, 'job.primary-job-2.startDate', '2026-04-01');
  const { wages, cfg } = primaryWages(applyParamBagToConfig(baseCfg(end), bag), end);
  assert.equal(cfg.jobs.find(j => j.id === 'primary-job-1').endDate, '2026-04-01');
  assert.equal(wages['2026-03'], 8000);
  assert.equal(wages['2026-04'], 9000, 'the new job pays from April, with no overlap');
});

test('JSW-10: crossing hand-widened ranges are caught; the defaults never cross', () => {
  const jobs = [
    { id: 'a', personId: 'p', startDate: '2027-01-01', endDate: '2028-01-01' },
    { id: 'b', personId: 'p', startDate: '2028-03-01' },
  ];
  const entries = ScenarioParamGenerator.generate({ persons: [{ id: 'p' }], jobs });
  const rows = entries.filter(e => e.key.startsWith('job.') && e.type === 'Date').map(e => ({
    paramKey: e.key, enabled: true, ...optRowFor('date', e.defaultValue, e) }));
  assert.deepEqual(jobDateRangeConflicts(rows, jobs), []);
  const widened = rows.map(r => (r.paramKey === 'job.a.endDate' ? { ...r, max: '2028-06-01' } : r));
  assert.deepEqual(jobDateRangeConflicts(widened, jobs),
    [{ earlier: 'job.a.endDate', later: 'job.b.startDate' }]);
  const off = widened.map(r => (r.paramKey === 'job.a.endDate' ? { ...r, enabled: false } : r));
  assert.deepEqual(jobDateRangeConflicts(off, jobs), [], 'a disabled row sits at its plan date');
});
