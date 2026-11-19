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
 * import-farm (design 134 §8.3, step 4c): an operator's slice of a farm export becomes a
 * household plan's business-income row and its MC path table.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { FarmScenario } from '../../src/scenarios/farm-scenario.js';
import { runFarm }      from '../../src/finance/farm/farm-run.js';
import { FarmMcRunner, FarmMcConfig } from '../../src/finance/farm/farm-mc.js';
import { buildFarmExport, fullYearRow } from '../../src/finance/farm/farm-export.js';
import { buildFarmImport, applyFarmImport } from '../../scripts/lib/farm-import.mjs';
import { validateBusinessIncomePaths } from '../../src/finance/payroll/business-income.js';
import { GOLDEN_SPECS } from '../helpers/golden-specs.js';
import { buildGoldenCfg, runGolden } from '../helpers/golden-harness.js';

const plan = () => {
  const cfg = buildGoldenCfg(GOLDEN_SPECS.find(s => s.name === 'us-single-homeowner'));
  return cfg;
};

async function farmExport() {
  const cfg = FarmScenario.buildDefaultConfig();
  const mcConfig = new FarmMcConfig();
  mcConfig.applyOverride('farm.price.pc-harvest.shock', { enabled: true });
  const mc = await new FarmMcRunner({ n: 5, cfgTemplate: cfg, mcConfig }).run();
  return buildFarmExport({ source: 'demo', det: runFarm(cfg), mc });
}

describe('import-farm (design 134 step 4c)', async () => {
  const doc = await farmExport();

  test('the crop year becomes one row, and each MC path one path row', () => {
    const imp = buildFarmImport(doc, { operatorId: 'opA', personId: 'primary', plan: plan() });
    assert.deepStrictEqual(imp.errors, []);
    const full = fullYearRow(doc.deterministic.operators.opA, 2027);
    assert.strictEqual(imp.row.id, 'farm-opA');
    assert.strictEqual(imp.row.personId, 'primary');
    assert.strictEqual(imp.row.kind, 'SCHEDULE_F');
    assert.strictEqual(imp.row.startDate, '2027-01-01');
    assert.strictEqual(imp.row.net, full.net);
    assert.strictEqual(imp.row.neCommunityCollegeTax, 680);
    assert.strictEqual(imp.paths.length, 5);
    imp.paths.forEach((p, i) => {
      assert.strictEqual(p.businessIncomeId, 'farm-opA');
      assert.strictEqual(p.seed, doc.mc.paths[i].seed);
      assert.strictEqual(p.net, fullYearRow(doc.mc.paths[i].operators.opA, 2027).net);
    });
    assert.strictEqual(imp.summary.paths, 5);
  });

  test('an unknown operator or person is an error, not a guess', () => {
    assert.match(buildFarmImport(doc, { operatorId: 'nope', personId: 'primary', plan: plan() }).errors.join(),
      /operator "nope" is not in the export/);
    assert.match(buildFarmImport(doc, { operatorId: 'opA', personId: 'nope', plan: plan() }).errors.join(),
      /person "nope" is not in the plan/);
  });

  test('a community-college tax for a non-Nebraska resident is warned about', () => {
    const p = plan();
    p.persons[0] = { ...p.persons[0], residencyState: 'SD' };
    const imp = buildFarmImport(doc, { operatorId: 'opA', personId: 'primary', plan: p });
    assert.match(imp.warnings.join(), /not a Nebraska resident/);
  });

  test('a re-import replaces its own row and paths and nothing else', () => {
    const p = plan();
    p.businessIncome = [{ id: 'other', personId: 'primary', kind: 'SCHEDULE_F', startDate: '2030-01-01', net: 1 }];
    const imp = buildFarmImport(doc, { operatorId: 'opA', personId: 'primary', plan: p });
    const once = applyFarmImport(p, imp);
    const twice = applyFarmImport(once, imp);
    assert.deepStrictEqual(twice.businessIncome.map(r => r.id), ['other', 'farm-opA']);
    assert.strictEqual(twice.businessIncomePaths.length, 5);
    assert.strictEqual(p.businessIncomePaths, undefined, 'the input plan is not mutated');
  });

  test('the imported plan loads and pays the row every year from the crop year', () => {
    const base = GOLDEN_SPECS.find(x => x.name === 'us-single-homeowner');
    const spec = {
      ...base, simEnd: new Date(Date.UTC(2030, 0, 1)),
      mutateCfg: (cfg) => {
        base.mutateCfg?.(cfg);
        const imp = buildFarmImport(doc, { operatorId: 'opA', personId: 'primary', plan: cfg });
        Object.assign(cfg, applyFarmImport(cfg, imp));
      },
    };
    const { sim } = runGolden(spec);
    const paid = sim.journal.journal.filter(e => e.action?.type === 'BUSINESS_INCOME_APPLY')
      .map(e => [new Date(e.date).toISOString().slice(0, 10), (e.action.data ?? e.action).amount]);
    assert.deepStrictEqual(paid.map(p => p[0]), ['2027-12-15', '2028-12-15', '2029-12-15']);
    assert.strictEqual(paid[0][1], fullYearRow(doc.deterministic.operators.opA, 2027).net);
  });

  test('a path naming no row is a load error', () => {
    assert.match(validateBusinessIncomePaths([{ businessIncomeId: 'gone', net: 1 }], []).join(),
      /"gone", which is not a businessIncome row/);
    assert.match(validateBusinessIncomePaths([{ businessIncomeId: 'a' }], [{ id: 'a' }]).join(),
      /net must be a number/);
  });
});

describe('household draws a farm path per year (design 134 step 4d)', async () => {
  const doc = await farmExport();
  const base = GOLDEN_SPECS.find(x => x.name === 'us-single-homeowner');
  const spec = (params = {}, simEnd = 2035) => ({
    ...base, simEnd: new Date(Date.UTC(simEnd, 0, 1)), params: { ...(base.params ?? {}), ...params },
    mutateCfg: (cfg) => {
      base.mutateCfg?.(cfg);
      Object.assign(cfg, applyFarmImport(cfg, buildFarmImport(doc, { operatorId: 'opA', personId: 'primary', plan: cfg })));
    },
  });
  const paid = (s) => runGolden(s).sim.journal.journal
    .filter(e => e.action?.type === 'BUSINESS_INCOME_APPLY')
    .map(e => e.action.data ?? e.action);
  const pathNets = new Map(doc.mc.paths.map(p => [p.seed, fullYearRow(p.operators.opA, 2027).net]));

  test('off (a single run\'s default): every year pays the deterministic net', () => {
    const rows = paid(spec());
    assert.ok(rows.every(r => r.farmPathSeed == null));
    assert.strictEqual(rows[0].amount, fullYearRow(doc.deterministic.operators.opA, 2027).net);
  });

  test('on: each year pays one drawn path, and the run replays', () => {
    const rows = paid(spec({ businessIncomeFarmPaths: true, randomSeed: 7 }));
    assert.strictEqual(rows.length, 8);
    assert.ok(rows.every(r => pathNets.has(r.farmPathSeed)), 'every year names a path of the export');
    assert.ok(new Set(rows.map(r => r.farmPathSeed)).size > 1, 'years draw different seasons');
    // The first year is paid as drawn; later years are that path's net indexed by CPI.
    assert.strictEqual(rows[0].amount, pathNets.get(rows[0].farmPathSeed));
    const again = paid(spec({ businessIncomeFarmPaths: true, randomSeed: 7 }));
    assert.deepStrictEqual(again.map(r => r.farmPathSeed), rows.map(r => r.farmPathSeed));
    const other = paid(spec({ businessIncomeFarmPaths: true, randomSeed: 8 }));
    assert.notDeepStrictEqual(other.map(r => r.farmPathSeed), rows.map(r => r.farmPathSeed));
  });

  test('Monte Carlo turns the draw on in every path, unless mcFarmPaths is off', async () => {
    const { applyMcPaths } = await import('../../src/finance/monte-carlo/parallel/mc-worker-core.js');
    assert.strictEqual(applyMcPaths({}).businessIncomeFarmPaths, true);
    assert.strictEqual(applyMcPaths({ mcFarmPaths: false }).businessIncomeFarmPaths, undefined);
  });
});
