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
 * farm-scenario-upload.test.mjs — design 134 §17.5: a farm file opens as a farm, and the
 * demo's crop year moves the demo.
 *
 * Before: an uploaded farm with `scenarioId: 'us-farm'` (bare, as the importer writes it) or
 * none at all was built by the FIRST prebuilt's class, a household scenario.
 *
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';
import { jest }             from '@jest/globals';
import { ScenarioRegistry } from '../../src/scenarios/scenario-registry.js';
import { ScenarioStorage }  from '../../src/scenarios/scenario-storage.js';
import { ScenarioService }  from '../../src/services/scenario-service.js';
import { Graph }            from '../../src/graph/graph.js';
import { FarmScenario }     from '../../src/scenarios/farm-scenario.js';
import { serialize, deserialize } from 'node:v8';

// jsdom has no structuredClone; the scenario classes use it.
beforeAll(() => { globalThis.structuredClone ??= (v) => deserialize(serialize(v)); });

const START = new Date(Date.UTC(2026, 0, 1));
const END = new Date(Date.UTC(2041, 0, 1));
// A household prebuilt registered FIRST: the old fallback's choice.
const household = {
  scenarioId: () => 'household', scenarioName: () => 'Household', getParamSchema: () => [],
  buildDefaultConfig: () => null, instantiate: jest.fn(() => ({ kind: 'household' })),
};

function setup() {
  const registry = new ScenarioRegistry(new ScenarioStorage(), new Graph());
  registry.loadPrebuilt([
    { cls: household, order: 1, active: true, simStart: START, simEnd: END },
    { cls: FarmScenario, order: 2, simStart: '2026-01-01', simEnd: '2029-01-01' },
  ]);
  const service = new ScenarioService({}, registry);
  jest.spyOn(FarmScenario, 'instantiate').mockImplementation((params, s, e) => ({ kind: 'farm', params, s, e }));
  return { registry, service };
}

/** A farm file as the importer writes it: no prebuilt mark of its own. */
function farmFile(extra = {}) {
  const cfg = FarmScenario.buildDefaultConfig({ farm: FarmScenario.buildDefaultConfig({ farmDemoCropYear: 2020 }).farm });
  cfg.name = 'A farm file';
  return { ...cfg, ...extra, active: true };
}

beforeEach(() => { localStorage.clear(); jest.restoreAllMocks(); });

describe('an uploaded farm opens as a farm', () => {
  test.each([
    ['no scenarioId', {}],
    ['a bare id, as the importer writes it', { scenarioId: 'us-farm' }],
    ['the prebuilt id, as Copy stores it', { scenarioId: 'p:us-farm' }],
  ])('%s', (_, extra) => {
    const { registry, service } = setup();
    registry.upsertUserScenarios({ scenarios: [farmFile(extra)] });
    assert.equal(service.getActive().scenarioId, 'p:us-farm');
    assert.equal(service.createActiveScenario().kind, 'farm');
  });

  test('a record stored earlier with a bare id still builds as a farm', () => {
    const { registry, service } = setup();
    registry.upsertUserScenarios({ scenarios: [farmFile()] });
    service.getActive().scenarioId = 'us-farm';
    assert.equal(service.createActiveScenario().kind, 'farm');
  });

  test('a household file is not claimed by the farm', () => {
    const { registry, service } = setup();
    registry.upsertUserScenarios({ scenarios: [{ name: 'h', simStart: '2026-01-01', simEnd: '2041-01-01', active: true }] });
    assert.equal(service.getActive().scenarioId, null);
    assert.equal(service.createActiveScenario().kind, 'household');
  });

  test('a farm from a file is not the demo, so the demo crop year leaves it alone', () => {
    const rec = farmFile();
    assert.equal(rec.farmDemo, undefined);
    assert.equal(FarmScenario.prepareRecord(rec, { farmDemoCropYear: 2024 }), false);
    assert.equal(rec.farm.seasons[0].cropYear, 2020);
  });
});

describe('the demo crop year', () => {
  test('moves the demo farm and its window before the sim is built', () => {
    const { registry, service } = setup();
    const demo = registry.get('p:us-farm');
    assert.equal(demo.farmDemo, true);
    assert.equal(demo.farm.seasons[0].cropYear, FarmScenario.DEFAULT_CROP_YEAR);
    registry.save(demo, true);
    demo.params.find(p => p.name === 'farmDemoCropYear').value = 2024;
    const built = service.createActiveScenario();
    assert.equal(demo.farm.seasons[0].cropYear, 2024);
    assert.equal(demo.simStart, '2023-01-01');
    assert.equal(demo.simEnd, '2026-01-01');
    assert.equal(built.s.toISOString().slice(0, 10), '2023-01-01', 'the sim is built on the moved window');
    // Every dated record moved with it: it is the demo built for that year.
    assert.deepEqual(demo.farm, FarmScenario.buildDefaultConfig({ farmDemoCropYear: 2024 }).farm);
  });

  test('a year outside the published prices, or unchanged, changes nothing', () => {
    const rec = FarmScenario.buildDefaultConfig({});
    const before = JSON.stringify(rec);
    for (const y of [FarmScenario.MIN_DEMO_CROP_YEAR - 1, FarmScenario.DEFAULT_CROP_YEAR + 1, 2024.5, 'x',
      FarmScenario.DEFAULT_CROP_YEAR]) {
      assert.equal(FarmScenario.prepareRecord(rec, { farmDemoCropYear: y }), false, String(y));
    }
    assert.equal(JSON.stringify(rec), before);
  });

  test('the earliest year has a year of prices before it', () => {
    assert.equal(FarmScenario.MIN_DEMO_CROP_YEAR, 1976);
    const p = FarmScenario.getParamSchema().find(s => s.key === 'farmDemoCropYear');
    assert.equal(p.min, FarmScenario.MIN_DEMO_CROP_YEAR);
    assert.equal(p.max, FarmScenario.DEFAULT_CROP_YEAR);
  });

  test('Reset to Defaults brings the demo back to its default year', () => {
    const { registry, service } = setup();
    const demo = registry.get('p:us-farm');
    registry.save(demo, true);
    demo.params.find(p => p.name === 'farmDemoCropYear').value = 2024;
    service.createActiveScenario();
    service.resetToDefaults(demo);
    assert.equal(demo.farm.seasons[0].cropYear, FarmScenario.DEFAULT_CROP_YEAR);
    assert.equal(demo.params.find(p => p.name === 'farmDemoCropYear').value, FarmScenario.DEFAULT_CROP_YEAR);
    assert.equal(demo.simStart, `${FarmScenario.DEFAULT_CROP_YEAR - 1}-01-01`);
  });
});
