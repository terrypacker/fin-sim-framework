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
 * Business income (design 134 §8.3, step 4b): a person's Schedule F net, one signed amount a
 * year, repeated and indexed by US CPI from its first payment (§16.1).
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import {
  validateBusinessIncome, businessIncomeDates, businessIncomeAmounts,
} from '../../src/finance/payroll/business-income.js';
import { GOLDEN_SPECS } from '../helpers/golden-specs.js';
import { runGolden, buildGoldenCfg } from '../helpers/golden-harness.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { deletePersonJobs } from '../../src/scenarios/scenario-jobs.js';
import { ScenarioLoader } from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';

const PERSONS = [{ id: 'p' }];
const row = (over = {}) => ({ id: 'farm', personId: 'p', kind: 'SCHEDULE_F', startDate: '2027-01-01', net: 1000, ...over });
const SPEC = GOLDEN_SPECS.find(s => s.name === 'us-farm-operator');

describe('business-income records', () => {
  test('a valid row has no errors; an absent list is fine', () => {
    assert.deepStrictEqual(validateBusinessIncome([row()], PERSONS), []);
    assert.deepStrictEqual(validateBusinessIncome(undefined, PERSONS), []);
  });

  test('every reason a row cannot run is an error', () => {
    const errs = (r) => validateBusinessIncome([r], PERSONS).join('\n');
    assert.match(errs(row({ personId: 'nobody' })), /names no person/);
    assert.match(errs(row({ kind: 'W2' })), /kind must be one of SCHEDULE_F/);
    assert.match(errs(row({ startDate: '2027' })), /startDate must be a YYYY-MM-DD/);
    assert.match(errs(row({ endDate: '2026-01-01' })), /endDate is before startDate/);
    assert.match(errs(row({ paymentDay: '02-29' })), /paymentDay must be MM-DD/);
    assert.match(errs(row({ net: undefined })), /net must be a number/);
    assert.match(errs(row({ neCommunityCollegeTax: -1 })), /neCommunityCollegeTax must be 0 or more/);
    assert.match(validateBusinessIncome([row(), row()], PERSONS).join('\n'), /duplicate id/);
  });

  test('a loss is a valid row', () => {
    assert.deepStrictEqual(validateBusinessIncome([row({ net: -5000 })], PERSONS), []);
  });

  test('one payment a year, inside the row and the run', () => {
    const start = new Date(Date.UTC(2026, 0, 1)), end = new Date(Date.UTC(2031, 0, 1));
    const years = (r) => businessIncomeDates(r, start, end).map(d => d.date.toISOString().slice(0, 10));
    assert.deepStrictEqual(years(row()), ['2027-12-15', '2028-12-15', '2029-12-15', '2030-12-15']);
    assert.deepStrictEqual(years(row({ endDate: '2029-06-30' })), ['2027-12-15', '2028-12-15']);
    assert.deepStrictEqual(years(row({ startDate: '2027-12-20' })), ['2028-12-15', '2029-12-15', '2030-12-15']);
    assert.deepStrictEqual(years(row({ startDate: '2020-01-01', paymentDay: '03-01' })),
      ['2026-03-01', '2027-03-01', '2028-03-01', '2029-03-01', '2030-03-01']);
  });

  test('amounts are indexed from the first payment, not from sim start', () => {
    assert.deepStrictEqual(businessIncomeAmounts({ net: 100, neCommunityCollegeTax: 10 }, 1.05, null),
      { net: 100, neCommunityCollegeTax: 10, factor: 1 });
    const later = businessIncomeAmounts({ net: -100 }, 1.1, 1.0);
    assert.ok(Math.abs(later.net - -110) < 1e-9 && Math.abs(later.factor - 1.1) < 1e-12);
  });
});

describe('business income in a household run (golden us-farm-operator)', () => {
  const { sim } = runGolden(SPEC);
  const journal = sim.journal.journal;
  const applies = journal.filter(e => e.action?.type === 'BUSINESS_INCOME_APPLY')
    .map(e => ({ date: new Date(e.date).toISOString().slice(0, 10), ...(e.action.data ?? e.action) }));
  // One settle detail per tax year (the action has two reducers, design 101's trap).
  const seTaxByYear = new Map();
  for (const e of journal) {
    if (e.action?.type !== 'US_TAX_SETTLE_APPLY') continue;
    const d = e.action.data ?? e.action;
    const y = new Date(e.date).getUTCFullYear();   // settled on 31 December of the tax year
    if (d.taxDetail && !seTaxByYear.has(y)) seTaxByYear.set(y, d.taxDetail.selfEmploymentTax);
  }

  test('the first payment is the row as written; each later year is CPI-indexed from it', () => {
    const farm = applies.filter(a => a.businessIncomeId === 'farm');
    assert.deepStrictEqual(farm.map(a => a.date), ['2027-12-15', '2028-12-15', '2029-12-15']);
    assert.strictEqual(farm[0].amount, 48_000);
    const base = farm[0].indexBase;
    assert.ok(base > 1, 'the run started before the first payment, so the base is not 1');
    assert.ok(farm.every(a => a.indexBase === base), 'one base for the row');
    // The second row starts later and takes its own base.
    const loss = applies.find(a => a.businessIncomeId === 'hobby-loss');
    assert.strictEqual(loss.amount, -9_000);
    assert.ok(loss.indexBase > base);
  });

  test('the net is ordinary income and the SECA base', () => {
    const chained = journal.filter(e => e.action?.type === 'SE_INCOME_US_TAX' && /dynamic:US/.test(e.reducer?.name ?? ''))
      .map(e => (e.action.data ?? e.action).amount);
    assert.deepStrictEqual(chained, applies.map(a => a.amount));
    // A W-2 wage well under the Social Security base: SE tax = net × 92.35% × 15.3% (§1402).
    const factor = 0.9235 * 0.153;
    assert.ok(Math.abs(seTaxByYear.get(2027) - 48_000 * factor) < 1e-6);
    // 2029: the second operation's loss nets against the farm on Schedule SE.
    const net2029 = applies.filter(a => a.date.startsWith('2029')).reduce((s, a) => s + a.amount, 0);
    assert.ok(Math.abs(seTaxByYear.get(2029) - net2029 * factor) < 1e-6);
  });

  test('a row that cannot run stops the load', () => {
    const cfg = buildGoldenCfg(SPEC);
    cfg.businessIncome = [{ ...cfg.businessIncome[0], personId: 'nobody' }];
    ServiceRegistry.resetAll();
    assert.throws(() => new ScenarioLoader().load(cfg, ServiceRegistry.getInstance()),
      /Scenario business income is invalid:[\s\S]*names no person/);
  });

  test('the rows survive a save, and go with their person', () => {
    const cfg = buildGoldenCfg(SPEC);
    const saved = ScenarioSerializer.serializeScenario(cfg);
    assert.deepStrictEqual(saved.businessIncome, cfg.businessIncome);
    deletePersonJobs(saved, 'primary');
    assert.strictEqual(saved.businessIncome, undefined);
  });
});
