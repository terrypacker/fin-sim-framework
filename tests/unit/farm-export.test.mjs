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
 * The farm result export (design 134 §8.2, step 4a): what a household plan imports.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { FarmScenario } from '../../src/scenarios/farm-scenario.js';
import { runFarm }      from '../../src/finance/farm/farm-run.js';
import { FarmMcRunner, FarmMcConfig } from '../../src/finance/farm/farm-mc.js';
import { validateFarm } from '../../src/finance/farm/farm-records.js';
import {
  FARM_RESULT_VERSION, buildFarmExport, validateFarmExport, fullYearRow, communityCollegeTaxPaid,
} from '../../src/finance/farm/farm-export.js';

const cfg = () => FarmScenario.buildDefaultConfig();
const PRICE = 'farm.price.pc-harvest.shock';

describe('farm result export (design 134 step 4a)', () => {
  const det = runFarm(cfg());
  const doc = buildFarmExport({ source: 'demo', det });

  test('one row per operator and calendar year, carrying the cash report exactly', () => {
    assert.strictEqual(doc.farmResultVersion, FARM_RESULT_VERSION);
    assert.strictEqual(doc.cropYear, 2027);
    assert.deepStrictEqual(doc.operators.map(o => o.id), det.farm.operators.map(o => o.id));
    for (const row of det.cash) {
      const y = doc.deterministic.operators[row.operatorId].find(r => r.year === row.year);
      assert.ok(y, `${row.operatorId} ${row.year}`);
      assert.strictEqual(y.net, row.net);
      assert.strictEqual(y.partial, row.partial);
      assert.strictEqual(y.grossIncome, row.grossIncome);
      assert.strictEqual(y.totalExpenses, row.totalExpenses);
      assert.strictEqual(y.section464Deferred, row.section464.deferred ?? 0);
      assert.deepStrictEqual(y.income, row.income);
      assert.deepStrictEqual(y.expense, row.expense);
      // Schedule SE line 1a and QBI before the household's adjustments are the Schedule F net.
      assert.strictEqual(y.household.scheduleSeLine1a, row.net);
      assert.strictEqual(y.household.qbiBeforeAdjustments, row.net);
    }
  });

  test('the memo lines (received, not added) are named', () => {
    const a = fullYearRow(doc.deterministic.operators.opA, 2027);
    assert.ok(a.income['4a'] > 0, 'the demo farm has ARC on opA');
    assert.ok(a.memoLines.includes('4a'));
    assert.ok(!a.memoLines.includes('4b'));
  });

  test('the full year is the crop year; the years either side are partial', () => {
    for (const rows of Object.values(doc.deterministic.operators)) {
      assert.strictEqual(fullYearRow(rows, 2027).year, 2027);
      assert.ok(rows.filter(r => r.year !== 2027).every(r => r.partial));
    }
    assert.strictEqual(fullYearRow([{ year: 2027, partial: true }], 2027), null);
  });

  test('the community-college tax lands on the year the property tax is paid', () => {
    // The demo's owned fields carry 600 + 80 of community-college tax, both paid in 2027.
    assert.strictEqual(fullYearRow(doc.deterministic.operators.opA, 2027).household.neCommunityCollegeTaxPaid, 680);
    const credited = Object.values(doc.deterministic.operators).flat()
      .filter(r => r.household.neCommunityCollegeTaxPaid !== 0);
    assert.deepStrictEqual(credited, [fullYearRow(doc.deterministic.operators.opA, 2027)]);
    // Spread over the two halves in proportion: a half paid in another year carries its half.
    const c = cfg();
    c.farm.seasons[0].calendar = { ...(c.farm.seasons[0].calendar ?? {}), propertyTaxFirstDate: '2026-12-31' };
    const moved = runFarm(c);
    const paid = communityCollegeTaxPaid(moved.farm, moved.ledger);
    assert.strictEqual(paid.get('opA|2026') + paid.get('opA|2027'), 680);
    assert.ok(paid.get('opA|2026') > 0 && paid.get('opA|2027') > 0);
  });

  test('a community-college tax above the bill is refused', () => {
    const c = cfg();
    c.farm.fields[0] = { ...c.farm.fields[0], communityCollegeTax: c.farm.fields[0].propertyTax + 1 };
    assert.match(validateFarm(c.farm).join('\n'), /communityCollegeTax is part of the property tax bill/);
  });

  test('a wrong version is refused on import', () => {
    assert.throws(() => validateFarmExport({ ...doc, farmResultVersion: 99 }), /not a farm result export/);
    assert.strictEqual(validateFarmExport(doc), doc);
  });

  test('with nothing sampled, every MC path carries the deterministic rows', async () => {
    const mc = await new FarmMcRunner({ n: 2, cfgTemplate: cfg() }).run();
    const withMc = buildFarmExport({ source: 'demo', det, mc });
    assert.strictEqual(withMc.mc.n, 2);
    for (const p of withMc.mc.paths) {
      assert.deepStrictEqual(p.operators, doc.deterministic.operators);
      assert.deepStrictEqual(p.params, {}, 'only sampled params are kept, and none is');
    }
  });

  test('a sampled path carries its own Schedule F, matching its metric', async () => {
    const mcConfig = new FarmMcConfig();
    mcConfig.applyOverride(PRICE, { enabled: true });
    const mc = await new FarmMcRunner({ n: 4, cfgTemplate: cfg(), mcConfig }).run();
    const withMc = buildFarmExport({ source: 'demo', det, mc });
    const nets = withMc.mc.paths.map(p => fullYearRow(p.operators.opA, 2027).net);
    assert.strictEqual(new Set(nets).size, 4, 'each path has its own Schedule F');
    mc.runs.forEach((r, i) => {
      assert.strictEqual(nets[i], r.metrics['operator.opA.scheduleF']);
      assert.deepStrictEqual(Object.keys(withMc.mc.paths[i].params), [PRICE]);
      assert.strictEqual(withMc.mc.paths[i].seed, r.seed);
    });
  });
});
