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
 * evt-employment-spells.test.mjs — design 116 phase 1: more than one job per person.
 *
 *   ESP-1: the resolver — in-force spell, exclusive end, gap, whole-year real growth
 *   ESP-2: a legacy person reads exactly as `isEarning` always did
 *   ESP-3: validateJobs rejects overlap, end ≤ start, an orphan personId, a duplicate id
 *   ESP-4: the loader throws on an invalid job set rather than half-loading
 *   ESP-5: the projection carries `spells` and none of the flat job fields; legacy is untouched
 *   ESP-6: a US→AU person is paid from the US stream, then the AU one, on a loaded scenario
 *   ESP-7: a gap between spells pays nothing
 *   ESP-8: base × wageIndex × (1+g)^n — index at AU CPI from t0, growth on the anniversary
 *   ESP-9: a person working past 67 draws a benefit and a wage in the same month
 *   ESP-10: jobs round-trip through serializeScenario; a scenario without jobs gains no key
 *   ESP-11: hasPayrollContributions sees a spell earner whose flat wage is 0
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { projectPerson }          from '../../src/finance/state/person-projection.js';
import { hasPayrollContributions, US_CONTRIBUTION_FIELDS }
  from '../../src/finance/handlers/payroll-handler.js';
import {
  spellAt, wageAt, earnerView, everEarns, lastWorkDate, wholeYearsSince,
  buildSpells, validateJobs,
} from '../../src/finance/payroll/employment.js';

const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const SS = D(2026, 1, 1);

const AU_SPOUSE_ACCOUNT = {
  __type: 'SavingsAccount', stateKey: 'spouseAuSavingsAccount', name: 'AU Savings (Spouse)',
  ownerId: 'spouse', role: 'au-savings', balance: 0, minimumBalance: 0,
  country: 'AU', currency: { code: 'AUD', symbol: 'A$' }, drawdownPriority: null,
};

/** Load the reference scenario with `jobs` (and any cfg edit), step to `stepTo`. */
function load({ jobs, simEnd, params = {}, mutate } = {}) {
  ServiceRegistry.resetAll();
  const reg = ServiceRegistry.getInstance();
  const sc  = new IntlRetirementScenario({ context: reg.simulationContext, simStart: SS, simEnd });
  sc.buildSim();
  const cfg = ScenarioSerializer.serializeScenario(
    IntlRetirementScenario.buildDefaultConfig({ fxProcessModel: 'NONE', ...params }, SS, simEnd));
  if (jobs) cfg.jobs = jobs;
  cfg.accounts.push({ ...AU_SPOUSE_ACCOUNT });
  mutate?.(cfg);
  new ScenarioLoader().load(cfg, reg);
  sc.sim.silent = true;
  return { sim: sc.sim, cfg };
}

/** The journaled payload of an action (design 101: it lives on `action.data`). */
const payload = e => e.action?.data ?? e.action ?? {};

/** One entry per action (a multi-reducer action is journaled once per reducer). */
function wagesOf(sim, personKey) {
  const types = ['WAGES_INCOME_APPLY', 'AU_WAGES_INCOME_APPLY', 'SE_INCOME_US_APPLY', 'SE_INCOME_AU_APPLY'];
  const byId = new Map();
  for (const e of sim.journal.journal) {
    if (!types.includes(e.action?.type) || payload(e).personKey !== personKey) continue;
    byId.set(e.action.instanceId ?? `${e.seq}`, e);
  }
  return [...byId.values()].map(e => ({ date: new Date(e.date), type: e.action.type,
                                        amount: payload(e).amount }));
}

const ym = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

test('ESP-1: the in-force spell, an exclusive end, a gap, and whole-year growth', () => {
  const person = { id: 'p', wageCurrency: 'USD' };
  const spells = buildSpells([
    { id: 'b', personId: 'p', startDate: '2028-01-01', monthlyWage: 9000, realGrowth: 0.05 },
    { id: 'a', personId: 'p', startDate: '2026-03-01', endDate: '2027-01-01', monthlyWage: 5000,
      wageCurrency: 'AUD', workCountry: 'AU', selfEmployed: true },
  ], person, SS);
  assert.deepEqual(spells.map(s => s.id), ['a', 'b'], 'sorted by start');
  const p = { ...person, spells };

  assert.equal(spellAt(p, D(2026, 2, 28)), null, 'before the first spell');
  assert.equal(spellAt(p, D(2026, 3, 1)).id, 'a', 'start is inclusive');
  assert.equal(spellAt(p, D(2027, 1, 1)), null, 'end is exclusive — and 2027 is a gap');
  assert.equal(spellAt(p, D(2040, 1, 1)).id, 'b', 'an open end runs on');

  const state = { wageIndex: { US: 1.5, AU: 2 } };
  assert.equal(wageAt(p, D(2026, 6, 30), state), 5000 * 2, 'AUD spell reads the AU index');
  assert.equal(wageAt(p, D(2027, 6, 30), state), 0, 'a gap pays nothing');
  assert.equal(wageAt(p, D(2028, 12, 31), state), 9000 * 1.5, 'no growth before the first anniversary');
  assert.equal(wageAt(p, D(2029, 1, 1), state), 9000 * 1.5 * 1.05);
  assert.equal(wageAt(p, D(2031, 6, 30), state), 9000 * 1.5 * Math.pow(1.05, 3));
  assert.equal(wholeYearsSince(D(2028, 3, 15).getTime(), D(2029, 3, 14).getTime()), 0);
  assert.equal(wholeYearsSince(D(2028, 3, 15).getTime(), D(2029, 3, 15).getTime()), 1);

  const v = earnerView(p, D(2026, 6, 30), state);
  assert.equal(v.wageCurrency, 'AUD');
  assert.equal(v.workCountry, 'AU');
  assert.equal(v.selfEmployed, true);
  assert.equal(v.spellId, 'a');
  assert.equal(earnerView(p, D(2027, 6, 30), state), null);

  assert.equal(lastWorkDate(p), null, 'an open-ended last spell never stops');
  assert.equal(lastWorkDate(p, null, { currency: 'AUD' }).getTime(), D(2027, 1, 1).getTime());
  assert.equal(lastWorkDate(p, null, { currency: 'GBP' }), undefined);
  assert.equal(everEarns(p), true);
});

test('ESP-2: a legacy person resolves exactly as isEarning did', () => {
  const p = { id: 'p', monthlyWage: 7000, retirementDate: D(2030, 1, 1), wageCurrency: 'USD' };
  assert.equal(earnerView(p, D(2029, 12, 31), {}), p, 'the SAME object, not a copy');
  assert.equal(earnerView(p, D(2030, 1, 1), {}), null);
  assert.equal(wageAt(p, D(2029, 1, 31), { wageIndex: { US: 9 } }), 7000, 'no index on legacy');
  assert.equal(earnerView({ ...p, monthlyWage: 0 }, D(2026, 1, 31), {}), null);
  assert.equal(lastWorkDate(p), p.retirementDate);
});

test('ESP-3: validateJobs rejects what cannot run', () => {
  const persons = [{ id: 'p' }];
  assert.deepEqual(validateJobs([], persons), []);
  assert.deepEqual(validateJobs([
    { id: 'a', personId: 'p', endDate: '2030-01-01' },
    { id: 'b', personId: 'p', startDate: '2030-01-01' },
  ], persons), [], 'a shared boundary is not an overlap');
  const errs = validateJobs([
    { id: 'a', personId: 'p', startDate: '2026-01-01', endDate: '2030-01-01' },
    { id: 'b', personId: 'p', startDate: '2029-01-01' },
    { id: 'c', personId: 'p', startDate: '2040-01-01', endDate: '2040-01-01' },
    { id: 'd', personId: 'nobody' },
    { id: 'd', personId: 'p', startDate: 'soon' },
  ], persons);
  assert.ok(errs.some(e => /"a" and "b".*overlap/.test(e)), errs.join('\n'));
  assert.ok(errs.some(e => /"c": endDate must be after startDate/.test(e)));
  assert.ok(errs.some(e => /names no person/.test(e)));
  assert.ok(errs.some(e => /duplicate id/.test(e)));
  assert.ok(errs.some(e => /"soon" is not a date/.test(e)));
});

test('ESP-4: the loader throws on overlapping jobs', () => {
  assert.throws(() => load({
    simEnd: D(2026, 3, 1),
    jobs: [
      { id: 'j1', personId: 'spouse', endDate: '2027-01-01', monthlyWage: 1 },
      { id: 'j2', personId: 'spouse', startDate: '2026-06-01', monthlyWage: 1 },
    ],
  }), /overlap/);
});

test('ESP-5: the projection carries spells and none of the flat job fields', () => {
  const person = { id: 'p', name: 'P', monthlyWage: 4000, wageCurrency: 'USD',
                   retirementDate: D(2040, 1, 1), selfEmployed: false, workCountry: null };
  const legacy = projectPerson(person);
  assert.ok(!('spells' in legacy));
  assert.equal(legacy.monthlyWage, 4000);
  const spells = buildSpells([{ id: 'j', personId: 'p', monthlyWage: 5000 }], person, SS);
  const withSpells = projectPerson(person, { spells });
  for (const f of ['monthlyWage', 'wageCurrency', 'workCountry', 'selfEmployed', 'retirementDate']) {
    assert.ok(!(f in withSpells), `${f} must not be projected for a person with spells`);
  }
  assert.equal(withSpells.spells[0].baseMonthlyWage, 5000);
  assert.equal(withSpells.spells[0].startMs, SS.getTime(), 'an empty start is the run start');
});

test('ESP-6/7: US job, gap, AU job — each paid from its own stream; the gap pays nothing', () => {
  const { sim } = load({
    simEnd: D(2027, 5, 1),
    jobs: [
      { id: 'us', personId: 'spouse', endDate: '2026-10-01', monthlyWage: 5000, wageCurrency: 'USD' },
      { id: 'au', personId: 'spouse', startDate: '2027-01-01', monthlyWage: 6000,
        wageCurrency: 'AUD', workCountry: 'AU' },
    ],
  });
  sim.stepTo(D(2027, 5, 1));
  const state = sim.state;
  assert.ok(Array.isArray(state.people.spouse.spells));
  assert.ok(!('monthlyWage' in state.people.spouse), 'the flat cfg wage (4000) is ignored');

  const wages = wagesOf(sim, 'spouse');
  const months = wages.map(w => `${ym(w.date)}:${w.type}`);
  assert.deepEqual(months, [
    ...['01', '02', '03', '04', '05', '06', '07', '08', '09'].map(m => `2026-${m}:WAGES_INCOME_APPLY`),
    ...['01', '02', '03', '04'].map(m => `2027-${m}:AU_WAGES_INCOME_APPLY`),
  ], 'Oct-Dec 2026 is a gap; the AU job pays from January');

  // The primary is legacy: paid every month at the flat wage, untouched by the spouse.
  assert.equal(wagesOf(sim, 'primary').length, 16);
  assert.equal(wagesOf(sim, 'primary')[0].amount, 8000);
  // AUD wages land in the spouse's AU account.
  assert.ok(state.spouseAuSavingsAccount.balance > 0);
});

test('ESP-8: base × wageIndex × (1+g)^n, with the AU index running from t0', () => {
  const { sim } = load({
    simEnd: D(2028, 3, 1),
    jobs: [{ id: 'au', personId: 'spouse', startDate: '2027-01-01', monthlyWage: 6000,
             realGrowth: 0.02, wageCurrency: 'AUD', workCountry: 'AU' }],
  });
  sim.stepTo(D(2027, 12, 15));
  const idx2027 = sim.state.wageIndex.AU;
  assert.ok(idx2027 > 1, 'the AU index advanced on the 2027 US period advance, pre-move');
  sim.stepTo(D(2028, 3, 1));
  const idx2028 = sim.state.wageIndex.AU;
  assert.ok(idx2028 > idx2027);

  const byMonth = Object.fromEntries(wagesOf(sim, 'spouse').map(w => [ym(w.date), w.amount]));
  assert.equal(byMonth['2027-12'], 6000 * idx2027, 'year one: base × index, no growth');
  assert.equal(byMonth['2028-01'], 6000 * idx2028 * 1.02, 'first anniversary: one year of growth');
  assert.equal(sim.state.wageIndex.US > 1, true);
});

test('ESP-9: a spell earner past 67 draws a benefit and a wage in the same month', () => {
  const { sim } = load({
    simEnd: D(2026, 8, 1),
    params: { primaryBirthDate: D(1959, 1, 15) },
    jobs: [{ id: 'late', personId: 'primary', monthlyWage: 3000, wageCurrency: 'USD' }],
  });
  sim.stepTo(D(2026, 8, 1));
  const ss = sim.journal.journal.filter(e => e.action?.type === 'SS_INCOME_APPLY'
                                          && payload(e).personKey === 'primary');
  const wageMonths = new Set(wagesOf(sim, 'primary').map(w => ym(w.date)));
  const both = ss.filter(e => wageMonths.has(ym(new Date(e.date))));
  assert.ok(both.length > 0, 'some month carries both a wage and a benefit');
});

test('ESP-10: jobs round-trip; a scenario without jobs gains no key', () => {
  const base = IntlRetirementScenario.buildDefaultConfig({}, SS, D(2027, 1, 1));
  assert.ok(!('jobs' in ScenarioSerializer.serializeScenario(base)));
  const jobs = [{ id: 'j', personId: 'spouse', startDate: '2027-01-01', monthlyWage: 6000,
                  realGrowth: 0.01, wageCurrency: 'AUD', workCountry: 'AU', selfEmployed: false }];
  const out = ScenarioSerializer.serializeScenario({ ...base, jobs });
  assert.deepEqual(out.jobs, jobs);
  assert.notEqual(out.jobs[0], jobs[0], 'copied, not aliased');
});

test('ESP-11: payroll gating sees a spell earner whose flat wage is 0', () => {
  const people = [{ id: 'p', monthlyWage: 0, k401DeferralPct: 0.1 }];
  assert.equal(hasPayrollContributions(people, {}, US_CONTRIBUTION_FIELDS), false);
  const spellsByPerson = { p: [{ id: 'j', startMs: 0, endMs: null, baseMonthlyWage: 5000 }] };
  assert.equal(hasPayrollContributions(people, {}, US_CONTRIBUTION_FIELDS, spellsByPerson), true);
});
