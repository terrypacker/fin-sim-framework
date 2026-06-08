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
 * real-property-sale-year-param.test.mjs
 *
 * Verifies that usHouseSaleYear / auHouseSaleYear params correctly override
 * the plannedSaleYear on the matching real property through every path:
 *
 *   1. buildAndCompile (fresh scenario via params) → sale fires in simulation
 *   2. ScenarioLoader cascade (saved-scenario load) → plannedSaleYear in cfg
 *   3. applyRealPropertySaleYearParams helper → direct cfg patch
 *   4. MC runner → perturbed sale year reaches the toolset via cfg.realProperties
 *
 * Run with: node --test tests/unit/real-property-sale-year-param.test.mjs
 */

import { test }        from 'node:test';
import assert          from 'node:assert/strict';

import { ServiceRegistry }           from '../../src/services/service-registry.js';
import { BaseScenario }              from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario, applyRealPropertySaleYearParams }
                                     from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }        from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }            from '../../src/scenarios/scenario-loader.js';
import { IntlRetirementMcRunner }    from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { IntlRetirementMcConfig }    from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildScenario(params = {}) {
  ServiceRegistry.resetAll();
  const scenario = IntlRetirementScenario.buildAndCompile({ params });
  return { scenario, sim: scenario.sim };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. buildAndCompile path: usHouseSaleYear param fires a sale in simulation
// ═════════════════════════════════════════════════════════════════════════════

test('usHouseSaleYear param causes US house sale event to fire in simulation', () => {
  const saleYear = 2030;
  const { sim } = buildScenario({ usHouseSaleYear: saleYear });

  // Verify the sale is scheduled: a US_HOUSE_SALE event should be in the queue
  // (date Jan 15 of the sale year — set by US_REAL_PROPERTY toolset schedules()).
  const saleDate = new Date(Date.UTC(saleYear, 0, 15));

  // Step up to the day before the sale — savings balance before the sale.
  const dayBefore = new Date(Date.UTC(saleYear, 0, 14));
  sim.stepTo(dayBefore);
  const balanceBefore = sim.state.usSavingsAccount?.balance ?? 0;

  // Step through the sale date. The US_HOUSE_SALE event credits salePrice ($1M)
  // to usSavingsAccount (default destination when no saleDestinationAccount is set).
  sim.stepTo(saleDate);
  const balanceAfter = sim.state.usSavingsAccount?.balance ?? 0;

  assert.ok(
    balanceAfter > balanceBefore + 500_000,
    `usSavingsAccount should jump by ~$1M on sale date; was ${balanceBefore}, now ${balanceAfter}`
  );
});

test('without usHouseSaleYear param no sale fires (no jump in savings balance)', () => {
  const { sim } = buildScenario({});  // no sale year set

  const saleDate = new Date(Date.UTC(2030, 0, 15));
  sim.stepTo(new Date(Date.UTC(2030, 0, 14)));
  const balanceBefore = sim.state.usSavingsAccount?.balance ?? 0;
  sim.stepTo(saleDate);
  const balanceAfter = sim.state.usSavingsAccount?.balance ?? 0;

  // Without a planned sale, no large jump should occur.
  assert.ok(
    balanceAfter < balanceBefore + 500_000,
    `usSavingsAccount should NOT jump by $500K+ without a sale; was ${balanceBefore}, now ${balanceAfter}`
  );
});

test('auHouseSaleYear param causes AU house sale event to fire in simulation', () => {
  const saleYear = 2033;
  const { sim } = buildScenario({ auHouseSaleYear: saleYear });

  const saleDate = new Date(Date.UTC(saleYear, 0, 15));
  sim.stepTo(new Date(Date.UTC(saleYear, 0, 14)));
  const balanceBefore = sim.state.auSavingsAccount?.balance ?? 0;

  sim.stepTo(saleDate);
  const balanceAfter = sim.state.auSavingsAccount?.balance ?? 0;

  assert.ok(
    balanceAfter > balanceBefore + 500_000,
    `auSavingsAccount should jump by ~$1M on AU house sale date; was ${balanceBefore}, now ${balanceAfter}`
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. ScenarioLoader cascade: saved-scenario load via cfg.params
// ═════════════════════════════════════════════════════════════════════════════

test('ScenarioLoader cascades usHouseSaleYear from cfg.params into cfg.realProperties', () => {
  ServiceRegistry.resetAll();
  const simStart = new Date(Date.UTC(2026, 0, 1));
  const simEnd   = new Date(Date.UTC(2041, 0, 1));

  // Build a declarative cfg with the sale year set in defaults.
  const raw = IntlRetirementScenario.buildDefaultConfig({}, simStart, simEnd);
  const cfg  = ScenarioSerializer.serializeScenario(raw);

  // Simulate a save/reload: set usHouseSaleYear in the params array with the
  // node declaration — mirrors what a persisted scenario looks like.
  const saleYear = 2031;
  cfg.params = (cfg.params ?? []).map(p =>
    p.name === 'usHouseSaleYear' ? { ...p, value: saleYear } : p
  );
  if (!cfg.params.some(p => p.name === 'usHouseSaleYear')) {
    cfg.params.push({
      name: 'usHouseSaleYear', type: 'Number', value: saleYear,
      node: { type: 'realProperty', stateKey: 'usHouseProperty', field: 'plannedSaleYear' },
    });
  }

  // ScenarioLoader requires a Simulation to already exist in the registry.
  const registry = ServiceRegistry.getInstance();
  new BaseScenario({
    context: registry.simulationContext,
    simStart, simEnd,
  }).buildSim();

  new ScenarioLoader().load(cfg, registry);

  // After load, the US house property must have plannedSaleYear === saleYear.
  const props = registry.realPropertyService.getAll();
  const usHouse = props.find(p => p.stateKey === 'usHouseProperty');
  assert.ok(usHouse, 'usHouseProperty should exist after load');
  assert.strictEqual(
    usHouse.plannedSaleYear, saleYear,
    `plannedSaleYear should be ${saleYear} after ScenarioLoader cascade`
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. applyRealPropertySaleYearParams helper
// ═════════════════════════════════════════════════════════════════════════════

test('applyRealPropertySaleYearParams patches usHouseProperty plannedSaleYear', () => {
  const cfg = {
    realProperties: [
      { stateKey: 'usHouseProperty', plannedSaleYear: null, country: 'US' },
      { stateKey: 'auHouseProperty', plannedSaleYear: null, country: 'AU' },
    ],
  };
  applyRealPropertySaleYearParams(cfg, { usHouseSaleYear: 2032 });
  assert.strictEqual(cfg.realProperties[0].plannedSaleYear, 2032);
  assert.strictEqual(cfg.realProperties[1].plannedSaleYear, null, 'AU house should be unchanged');
});

test('applyRealPropertySaleYearParams patches auHouseProperty plannedSaleYear', () => {
  const cfg = {
    realProperties: [
      { stateKey: 'usHouseProperty', plannedSaleYear: null },
      { stateKey: 'auHouseProperty', plannedSaleYear: null },
    ],
  };
  applyRealPropertySaleYearParams(cfg, { auHouseSaleYear: 2035 });
  assert.strictEqual(cfg.realProperties[0].plannedSaleYear, null, 'US house should be unchanged');
  assert.strictEqual(cfg.realProperties[1].plannedSaleYear, 2035);
});

test('applyRealPropertySaleYearParams rounds floating-point year from MC sampling', () => {
  const cfg = {
    realProperties: [{ stateKey: 'usHouseProperty', plannedSaleYear: null }],
  };
  applyRealPropertySaleYearParams(cfg, { usHouseSaleYear: 2031.73 });
  assert.strictEqual(cfg.realProperties[0].plannedSaleYear, 2032);
});

test('applyRealPropertySaleYearParams does not override when param is null', () => {
  const cfg = {
    realProperties: [{ stateKey: 'usHouseProperty', plannedSaleYear: 2029 }],
  };
  applyRealPropertySaleYearParams(cfg, { usHouseSaleYear: null });
  assert.strictEqual(
    cfg.realProperties[0].plannedSaleYear, 2029,
    'null param should not clobber a user-set plannedSaleYear'
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. MC runner: perturbed usHouseSaleYear reaches cfg.realProperties
// ═════════════════════════════════════════════════════════════════════════════

test('MC runner with usHouseSaleYear in baseParams patches cfg.realProperties per iteration', async () => {
  ServiceRegistry.resetAll();

  const simStart = new Date(Date.UTC(2026, 0, 1));
  const simEnd   = new Date(Date.UTC(2032, 0, 1));
  const saleYear = 2030;

  // Build a cfg template with the sale year so cfgTemplate carries it.
  const rawTemplate = IntlRetirementScenario.buildDefaultConfig({ usHouseSaleYear: saleYear }, simStart, simEnd);
  const cfgTemplate = ScenarioSerializer.serializeScenario(rawTemplate);

  const mcConfig = new IntlRetirementMcConfig();
  // Disable all MC variables so every iteration uses the baseParam value exactly.
  const runner = new IntlRetirementMcRunner({
    n:           1,
    mcConfig,
    simStart,
    simEnd,
    cfgTemplate,
  });

  const baseParams = { usHouseSaleYear: saleYear };
  const { runs } = await runner.run(baseParams);
  assert.strictEqual(runs.length, 1);

  // The single run's params should carry the sale year.
  assert.strictEqual(
    runs[0].params.usHouseSaleYear, saleYear,
    'MC run params should contain usHouseSaleYear'
  );

  // The scenario must not have failed — a house sale of $1M should keep it solvent.
  assert.strictEqual(
    runs[0].scenarioFailed, false,
    'Scenario should not fail when house sale proceeds are credited'
  );
});
