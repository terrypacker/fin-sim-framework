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
 * evt-bonuses.test.mjs — authored one-off bonuses (`cfg.bonuses`).
 *
 * BonusHandler and BonusApplyReducer were registered by US_INCOME in every plan, but no
 * toolset emitted a BONUS event, and a toolset plan rebuilds its events on load, so a
 * hand-added one was dropped. A bonus could not reach a run at all. Now each row is
 * compiled into a BONUS one-off, paid by the job the person holds on the date.
 *
 *   BON-1: validateBonuses — structure always; the job checks only with checkJobs
 *   BON-2: through the full load path, a bonus is paid once, in today's money
 *   BON-3: a bonus before the run, or with no USD job on its date, is not paid (and warns)
 *   BON-4: the loader throws on a malformed bonus rather than half-loading
 *   BON-5: bonuses round-trip; a scenario without any gains no key
 *   BON-6: the editor writer: ids, checks against the jobs being saved, delete with person
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { validateBonuses }        from '../../src/finance/payroll/employment.js';
import { replacePersonBonuses, listPersonBonuses, deletePersonJobs }
  from '../../src/scenarios/scenario-jobs.js';

const D  = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const SS = D(2026, 1, 1);

/** The spouse: a USD job to the end of 2027, then an AUD one. */
const JOBS = [
  { id: 'us', personId: 'spouse', endDate: '2028-01-01', monthlyWage: 5000, wageCurrency: 'USD' },
  { id: 'au', personId: 'spouse', startDate: '2028-01-01', monthlyWage: 6000,
    wageCurrency: 'AUD', workCountry: 'AU' },
];

function load({ bonuses, simEnd = D(2028, 6, 1), mutate } = {}) {
  ServiceRegistry.resetAll();
  const reg = ServiceRegistry.getInstance();
  const sc  = new IntlRetirementScenario({ context: reg.simulationContext, simStart: SS, simEnd });
  sc.buildSim();
  const cfg = ScenarioSerializer.serializeScenario(
    IntlRetirementScenario.buildDefaultConfig({ fxProcessModel: 'NONE' }, SS, simEnd));
  cfg.jobs = JOBS.map(j => ({ ...j }));
  if (bonuses) cfg.bonuses = bonuses;
  mutate?.(cfg);
  new ScenarioLoader().load(cfg, reg);
  sc.sim.silent = true;
  return { sim: sc.sim, cfg };
}

/** One entry per action (a multi-reducer action is journaled once per reducer). */
function applied(sim, type) {
  const byId = new Map();
  for (const e of sim.journal.journal) {
    if (e.action?.type !== type) continue;
    byId.set(e.action.instanceId ?? `${e.seq}`, { date: new Date(e.date), ...(e.action.data ?? e.action) });
  }
  return [...byId.values()];
}

/** Run `fn` with console.warn captured. */
function warnings(fn) {
  const seen = [];
  const orig = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try { return { result: fn(), seen }; } finally { console.warn = orig; }
}

test('BON-1: structure is always checked; the job checks only with checkJobs', () => {
  const persons = [{ id: 'spouse' }];
  const errs = validateBonuses([
    { id: 'a', personId: 'spouse', date: '2026-06-01', amount: 1000 },
    { id: 'a', personId: 'spouse', date: '2026-07-01', amount: 1000 },
    { id: 'b', personId: 'nobody', date: '2026-06-01', amount: 1000 },
    { id: 'c', personId: 'spouse', date: 'soon', amount: 1000 },
    { id: 'd', personId: 'spouse', date: '2026-06-01', amount: 0 },
    { id: 'e', personId: 'spouse', date: '2028-06-01', amount: 1000 },
  ], persons, JOBS);
  assert.ok(errs.some(e => /"a": duplicate id/.test(e)), errs.join('\n'));
  assert.ok(errs.some(e => /"b".*names no person/.test(e)));
  assert.ok(errs.some(e => /"soon" is not a date/.test(e)));
  assert.ok(errs.some(e => /"d": amount must be greater than 0/.test(e)));
  assert.ok(errs.some(e => /"e": the job on 2028-06-01 pays AUD/.test(e)));

  const se = validateBonuses([{ id: 'f', personId: 'spouse', date: '2026-06-01', amount: 1 }],
    persons, [{ id: 'x', personId: 'spouse', monthlyWage: 1, selfEmployed: true }]);
  assert.match(se[0], /self-employment/);
  const none = validateBonuses([{ id: 'g', personId: 'spouse', date: '2026-06-01', amount: 1 }],
    persons, [{ id: 'x', personId: 'spouse', startDate: '2027-01-01', monthlyWage: 1 }]);
  assert.match(none[0], /holds no paid job on 2026-06-01/);

  // A person with no jobs is paid through the flat fields, up to the retire date.
  const legacy = [{ id: 'p', monthlyWage: 4000, wageCurrency: 'USD', retirementDate: '2030-01-01' }];
  assert.deepEqual(validateBonuses([{ id: 'h', personId: 'p', date: '2029-12-01', amount: 1 }], legacy, []), []);
  assert.equal(validateBonuses([{ id: 'i', personId: 'p', date: '2030-01-01', amount: 1 }], legacy, []).length, 1);

  assert.deepEqual(validateBonuses([{ id: 'e', personId: 'spouse', date: '2028-06-01', amount: 1 }],
    persons, JOBS, { checkJobs: false }), [], 'the loader only warns about a job problem');
});

test('BON-2: a bonus is paid once, in today\'s money, and taxed as wages', () => {
  const { sim } = load({ bonuses: [
    { id: 'b1', personId: 'spouse', date: '2026-06-15', amount: 20000 },
    { id: 'b2', personId: 'spouse', date: '2027-06-15', amount: 20000 },
  ] });
  sim.stepTo(D(2026, 12, 1));
  const ssWages = sim.state.usSsWagesByPersonYTD?.spouse ?? 0;
  sim.stepTo(D(2027, 6, 1));
  const cpi2027 = sim.state.inflationAccumulator.US;
  assert.ok(cpi2027 > 1, 'a year of US inflation has accrued by mid-2027');
  sim.stepTo(D(2027, 7, 1));

  const paid = applied(sim, 'BONUS_APPLY');
  assert.equal(paid.length, 2, 'each row fires exactly once');
  assert.ok(paid.every(p => p.personKey === 'spouse'), 'paid to the person the row names');
  assert.equal(paid[0].amount, 20000, 'before the first advance, today\'s money is nominal');
  assert.equal(paid[1].amount, 20000 * cpi2027, 'a year later it is scaled by US CPI');

  const taxed = applied(sim, 'BONUS_TAX');
  assert.equal(taxed.length, 2, 'and each is taxed');
  const control = load().sim;
  control.stepTo(D(2026, 12, 1));
  assert.equal(ssWages - (control.state.usSsWagesByPersonYTD?.spouse ?? 0), 20000,
    'the bonus counts toward the earner\'s Social Security wage base');
});

test('BON-3: a bonus before the run or with no USD job on its date is not paid', () => {
  const { result: { sim }, seen } = warnings(() => load({ bonuses: [
    { id: 'old', personId: 'spouse', date: '2025-12-15', amount: 9000 },
    { id: 'au',  personId: 'spouse', date: '2028-03-15', amount: 9000 },
  ] }));
  assert.ok(seen.some(w => /Bonus "au" is not paid: the job on 2028-03-15 pays AUD/.test(w)), seen.join('\n'));
  assert.ok(!seen.some(w => /Bonus "old"/.test(w)), 'a past bonus is history, not a problem');
  sim.stepTo(D(2028, 6, 1));
  assert.equal(applied(sim, 'BONUS_APPLY').length, 0);
});

test('BON-4: the loader throws on a malformed bonus', () => {
  assert.throws(() => load({ bonuses: [{ id: 'x', personId: 'nobody', date: '2026-06-01', amount: 1 }] }),
    /Scenario bonuses are invalid[\s\S]*names no person/);
});

test('BON-5: bonuses round-trip; a scenario without any gains no key', () => {
  const base = IntlRetirementScenario.buildDefaultConfig({}, SS, D(2027, 1, 1));
  assert.ok(!('bonuses' in ScenarioSerializer.serializeScenario(base)));
  const bonuses = [{ id: 'b', personId: 'spouse', date: '2026-06-15', amount: 20000 }];
  const out = ScenarioSerializer.serializeScenario({ ...base, bonuses });
  assert.deepEqual(out.bonuses, bonuses);
  assert.notEqual(out.bonuses[0], bonuses[0], 'copied, not aliased');
});

test('BON-6: the editor writer assigns ids, checks the jobs being saved, and deletes with the person', () => {
  const scenario = { bonuses: [{ id: 'primary-bonus-1', personId: 'primary', date: '2026-03-01', amount: 5 }] };
  const person = { id: 'spouse' };
  // The job is new in this edit — no id yet — and the bonus still checks against it.
  const jobs = [{ endDate: '2028-01-01', monthlyWage: 5000, wageCurrency: 'USD' }];
  replacePersonBonuses(scenario, person, [
    { date: '2026-06-15', amount: 100 }, { date: '2027-06-15', amount: 200 },
  ], jobs);
  assert.deepEqual(listPersonBonuses(scenario, 'spouse').map(b => b.id), ['spouse-bonus-1', 'spouse-bonus-2']);
  assert.equal(listPersonBonuses(scenario, 'primary').length, 1, 'another person\'s rows are kept');

  assert.throws(() => replacePersonBonuses(scenario, person, [{ date: '2029-01-01', amount: 1 }], jobs),
    /holds no paid job/);
  assert.equal(listPersonBonuses(scenario, 'spouse').length, 2, 'a refused edit commits nothing');

  deletePersonJobs(scenario, 'spouse');
  assert.equal(listPersonBonuses(scenario, 'spouse').length, 0, 'deleting the person removes their bonuses');
  assert.equal(listPersonBonuses(scenario, 'primary').length, 1);
});
