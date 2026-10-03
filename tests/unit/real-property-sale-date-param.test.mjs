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
 * real-property-sale-date-param.test.mjs — design 117 phase 2.
 *
 * A house sale is a DATE (`prop.<sk>.plannedSaleDate`), and it reaches the sim through
 * every path a sale year used to:
 *
 *   1. buildAndCompile → the sale fires on its day — including a day that is not 15 Jan,
 *      which a year could never say;
 *   2. a legacy `usHouseSaleYear` override / saved param still sells, on 15 Jan of that
 *      year, the date it always meant (design 117 D3);
 *   3. the MC runner carries the date (or a legacy year, converted) into every iteration.
 *
 * Run with: node --test tests/unit/real-property-sale-date-param.test.mjs
 */

import { test }        from 'node:test';
import assert          from 'node:assert/strict';

import { ServiceRegistry }           from '../../src/services/service-registry.js';
import { BaseScenario }              from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario }    from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }        from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }            from '../../src/scenarios/scenario-loader.js';
import { IntlRetirementMcRunner }    from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { IntlRetirementMcConfig }    from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';

const US_SALE = 'prop.usHouseProperty.plannedSaleDate';
const AU_SALE = 'prop.auHouseProperty.plannedSaleDate';

function buildScenario(params = {}) {
  ServiceRegistry.resetAll();
  const scenario = IntlRetirementScenario.buildAndCompile({ params });
  return { scenario, sim: scenario.sim };
}

/** The cash in `key` the day before `day` and on it. */
function cashAround(sim, key, day) {
  const d = new Date(`${day}T00:00:00Z`);
  sim.stepTo(new Date(d.getTime() - 86_400_000));
  const before = sim.state[key]?.balance ?? 0;
  sim.stepTo(d);
  return { before, after: sim.state[key]?.balance ?? 0 };
}

// ── 1. The sale fires on its date ──────────────────────────────────────────────

test('a US house sale date fires the sale on that day', () => {
  const { sim } = buildScenario({ [US_SALE]: '2030-01-15' });
  const { before, after } = cashAround(sim, 'usSavingsAccount', '2030-01-15');
  assert.ok(after > before + 500_000, `usSavingsAccount should jump by ~$1M; was ${before}, now ${after}`);
});

test('a sale dated mid-year fires mid-year — not on 15 Jan of its year', () => {
  const { sim } = buildScenario({ [US_SALE]: '2030-07-01' });
  const jan = cashAround(sim, 'usSavingsAccount', '2030-01-15');
  assert.ok(jan.after < jan.before + 500_000, 'nothing is sold in January');
  const jul = cashAround(sim, 'usSavingsAccount', '2030-07-01');
  assert.ok(jul.after > jul.before + 500_000, `the sale lands on 1 Jul; was ${jul.before}, now ${jul.after}`);
  assert.ok((sim.state.usHouseProperty?.value ?? 0) < 1, 'the house is gone');
});

test('without a sale date no sale fires', () => {
  const { sim } = buildScenario({});
  const { before, after } = cashAround(sim, 'usSavingsAccount', '2030-01-15');
  assert.ok(after < before + 500_000, `no $500K+ jump without a sale; was ${before}, now ${after}`);
});

test('an AU house sale date fires the AU sale on that day', () => {
  const { sim } = buildScenario({ [AU_SALE]: '2033-01-15' });
  const { before, after } = cashAround(sim, 'auSavingsAccount', '2033-01-15');
  assert.ok(after > before + 500_000, `auSavingsAccount should jump by ~$1M; was ${before}, now ${after}`);
});

// ── 2. A legacy sale YEAR still sells, on 15 Jan ──────────────────────────────

test('a legacy usHouseSaleYear override sells on 15 Jan of that year', () => {
  const { sim } = buildScenario({ usHouseSaleYear: 2030 });
  const { before, after } = cashAround(sim, 'usSavingsAccount', '2030-01-15');
  assert.ok(after > before + 500_000, `the legacy year still sells; was ${before}, now ${after}`);
});

test('a saved scenario carrying a usHouseSaleYear param loads as the sale date', () => {
  ServiceRegistry.resetAll();
  const simStart = new Date(Date.UTC(2026, 0, 1));
  const simEnd   = new Date(Date.UTC(2041, 0, 1));
  const cfg = ScenarioSerializer.serializeScenario(
    IntlRetirementScenario.buildDefaultConfig({}, simStart, simEnd));
  // A scenario saved before design 117: the retired static param, as a year.
  cfg.params = [...(cfg.params ?? []).filter(p => p.name !== US_SALE), {
    name: 'usHouseSaleYear', type: 'Number', value: 2031,
    node: { type: 'realProperty', stateKey: 'usHouseProperty', field: 'plannedSaleYear' },
  }];

  const registry = ServiceRegistry.getInstance();
  new BaseScenario({ context: registry.simulationContext, simStart, simEnd }).buildSim();
  new ScenarioLoader().load(cfg, registry);

  const usHouse = registry.realPropertyService.getAll().find(p => p.stateKey === 'usHouseProperty');
  assert.strictEqual(usHouse.plannedSaleDate, '2031-01-15');
  assert.strictEqual(cfg.params.find(p => p.name === US_SALE)?.value, '2031-01-15');
  assert.ok(!cfg.params.some(p => p.name === 'usHouseSaleYear'), 'the retired key is gone');
});

// ── 3. The MC runner ──────────────────────────────────────────────────────────

for (const [label, baseParams] of [
  ['a sale date',               { [US_SALE]: '2030-01-15' }],
  ['a legacy sale year (converted)', { usHouseSaleYear: 2030 }],
]) {
  test(`MC runner with ${label} in baseParams carries the date into every iteration`, async () => {
    ServiceRegistry.resetAll();
    const simStart = new Date(Date.UTC(2026, 0, 1));
    const simEnd   = new Date(Date.UTC(2032, 0, 1));
    const cfgTemplate = ScenarioSerializer.serializeScenario(
      IntlRetirementScenario.buildDefaultConfig({ [US_SALE]: '2030-01-15' }, simStart, simEnd));
    const runner = new IntlRetirementMcRunner({
      n: 1, mcConfig: new IntlRetirementMcConfig(), simStart, simEnd, cfgTemplate,
    });
    const { runs } = await runner.run(baseParams);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].params[US_SALE], '2030-01-15');
    assert.strictEqual(runs[0].params.usHouseSaleYear, undefined, 'no dead year key in the run');
    assert.strictEqual(runs[0].scenarioFailed, false, 'the $1M sale keeps the plan solvent');
  });
}
