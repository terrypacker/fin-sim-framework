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
 * Replay fidelity: "Replay This Run" must reproduce the Monte Carlo iteration it names.
 *
 * Two things make an MC iteration, and the old replay carried neither completely:
 *
 *   1. THE PARAM BAG. The replay walked `cfg.params` matching `params[p.name]`, which
 *      dropped every aliased key (the account balances, the wages, the house sale years),
 *      every nested key (`shocks[N].severity`, `people.<key>.lifeExpectancy`) and every
 *      key with no typed entry. `applyParamBagToConfig` is now shared with the runner.
 *   2. THE SEED. Every in-loop stochastic process draws from `sim.rng`, so replaying an
 *      MC path at the scenario's own seed reproduces the path's SCALARS on a DIFFERENT
 *      random world. The last test here is the one with teeth: it asserts that dropping
 *      the seed actually changes the answer, so a future regression cannot pass by
 *      accident on a scenario where the seed happens not to bite.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { IntlRetirementMcRunner, computeNetWorthUsd }
                                   from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { IntlRetirementMcConfig }  from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { IntlRetirementScenario }  from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }          from '../../src/scenarios/scenario-loader.js';
import { ScenarioSerializer }      from '../../src/scenarios/scenario-serializer.js';
import { applyParamBagToConfig }   from '../../src/scenarios/scenario-param-apply.js';
import { ServiceRegistry }         from '../../src/services/service-registry.js';

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2028, 1, 1));

// ─── applyParamBagToConfig: the three classes of key the old replay dropped ───────

/** A cfg shaped like a LOADED record: typed params already renamed by the alias pass. */
function makeLoadedCfg() {
  return {
    scenarioClass: IntlRetirementScenario,
    params: [
      // Already renamed from the legacy `stockBalance` by ScenarioLoader._applyParamAliases.
      { name: 'acct.usStockAccount.balanceTarget', value: 100_000, type: 'Number' },
      { name: 'inflationRate',                     value: 0.03,    type: 'Number' },
    ],
    parameters: {},
    accounts:   [{ stateKey: 'usStockAccount', balance: 100_000 }],
    realProperties: [{ stateKey: 'usHouseProperty', plannedSaleDate: '2030-01-15' }],
  };
}

test('applyParamBagToConfig: an ALIASED bag key reaches its renamed typed entry', () => {
  const cfg = makeLoadedCfg();
  applyParamBagToConfig(cfg, { stockBalance: 777_000 });

  const entry = cfg.params.find(p => p.name === 'acct.usStockAccount.balanceTarget');
  assert.strictEqual(entry.value, 777_000,
    'legacy `stockBalance` must land on the generated key the loader renamed it to — '
    + 'matching p.name alone is what silently dropped every account balance');
  assert.strictEqual(cfg.parameters.stockBalance, 777_000,
    'and stay in the flat map, which is where the loader\'s alias pass reads it');
});

test('applyParamBagToConfig: NESTED bag keys reach the flat map', () => {
  const cfg = makeLoadedCfg();
  applyParamBagToConfig(cfg, {
    shocks: [{ preset: 'GFC', severity: 0.71 }],
    people: { primary: { lifeExpectancy: 91 } },
  });

  assert.strictEqual(cfg.parameters.shocks[0].severity, 0.71);
  assert.strictEqual(cfg.parameters.people.primary.lifeExpectancy, 91);
});

test('applyParamBagToConfig: a recorded house sale YEAR reaches cfg.realProperties as its date', () => {
  // An MC run recorded before design 117 carries a sampled sale year; replaying it must
  // still move the sale. The year (rounded, as the old patch did) becomes 15 Jan.
  const cfg = IntlRetirementScenario.buildDefaultConfig({});
  applyParamBagToConfig(cfg, { usHouseSaleYear: 2034.4 });
  assert.strictEqual(cfg.parameters['prop.usHouseProperty.plannedSaleDate'], '2034-01-15');
  assert.strictEqual(cfg.parameters.usHouseSaleYear, undefined, 'no dead year key is left behind');

  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  new IntlRetirementScenario({ context: services.simulationContext, params: {},
    simStart: SIM_START, simEnd: SIM_END }).buildSim();
  new ScenarioLoader().load(cfg, services);
  const house = cfg.realProperties.find(p => p.stateKey === 'usHouseProperty');
  assert.strictEqual(house.plannedSaleDate, '2034-01-15',
    'the cascade carries it onto the record the real-property toolset reads');
});

test('applyParamBagToConfig: a typed entry still wins its own key', () => {
  const cfg = makeLoadedCfg();
  applyParamBagToConfig(cfg, { inflationRate: 0.055, someUntypedKey: 42 });

  assert.strictEqual(cfg.params.find(p => p.name === 'inflationRate').value, 0.055,
    'the loader syncs cfg.params OVER cfg.parameters, so a bag value that only reached '
    + 'the flat map would be clobbered back to the scenario\'s own value');
  assert.strictEqual(cfg.parameters.someUntypedKey, 42,
    'a key with no typed entry has only the flat map to travel in');
});

// ─── Alias pairs: a lever base carries BOTH names; the one a lever moved wins ────

/** A loaded cfg whose US house sells in `plan` (typed entry under the generated key). */
function makeLoadedSaleCfg(plan) {
  // A LOADED cfg today: the typed entry and the record both hold the sale DATE.
  return {
    scenarioClass: IntlRetirementScenario,
    params: [{ name: 'prop.usHouseProperty.plannedSaleDate', value: plan, type: 'Date',
      node: { type: 'realProperty', stateKey: 'usHouseProperty', field: 'plannedSaleDate' } }],
    parameters: {},
    realProperties: [{ stateKey: 'usHouseProperty', plannedSaleDate: plan }],
  };
}

// An MC run recorded before design 117 carries BOTH names of the sale, as years: the flat
// legacy key and the old generated key, one moved by the lever and one at the plan value.
// Replay must keep the one that moved, or every cell of a grid on the other runs the
// plan's sale (the inert-lever failure `reconcileAliasPairs` exists for).

test('applyParamBagToConfig: a lever on the LEGACY key beats the generated key at plan', () => {
  const cfg = makeLoadedSaleCfg('2030-01-15');
  applyParamBagToConfig(cfg, { usHouseSaleYear: 2034, 'prop.usHouseProperty.plannedSaleYear': 2030 });

  assert.strictEqual(cfg.params[0].value, '2034-01-15');
  assert.strictEqual(cfg.parameters['prop.usHouseProperty.plannedSaleDate'], '2034-01-15',
    'the flat map agrees, so the loader cannot sync the plan value back');
  assert.strictEqual(cfg.parameters.usHouseSaleYear, undefined, 'no dead year key is left behind');
});

test('applyParamBagToConfig: a lever on the GENERATED key beats the legacy key at plan', () => {
  const cfg = makeLoadedSaleCfg('2030-01-15');
  applyParamBagToConfig(cfg, { usHouseSaleYear: 2030, 'prop.usHouseProperty.plannedSaleYear': 2034 });

  assert.strictEqual(cfg.params[0].value, '2034-01-15');
});

test('applyParamBagToConfig: a legacy lever wins when the plan never sells (null)', () => {
  const cfg = makeLoadedSaleCfg(null);
  applyParamBagToConfig(cfg, { usHouseSaleYear: 2034, 'prop.usHouseProperty.plannedSaleYear': null });

  assert.strictEqual(cfg.params[0].value, '2034-01-15', 'a null plan value is still a plan value');
});

test('applyParamBagToConfig: a date lever on the new key reaches the record on its own day', () => {
  const cfg = makeLoadedSaleCfg('2030-01-15');
  applyParamBagToConfig(cfg, { 'prop.usHouseProperty.plannedSaleDate': '2033-07-01' });

  assert.strictEqual(cfg.params[0].value, '2033-07-01');
  assert.strictEqual(cfg.parameters['prop.usHouseProperty.plannedSaleDate'], '2033-07-01');
});

test('applyParamBagToConfig: reconciling never mutates the caller\'s bag', () => {
  const bag = { usHouseSaleYear: 2034, 'prop.usHouseProperty.plannedSaleYear': 2030 };
  applyParamBagToConfig(makeLoadedSaleCfg('2030-01-15'), bag);

  assert.deepStrictEqual(bag, { usHouseSaleYear: 2034, 'prop.usHouseProperty.plannedSaleYear': 2030 },
    'the bag is a run\'s recorded params; replay re-applies it');
});

// ─── End-to-end: an MC iteration replayed from its own (params, seed) ────────────

/**
 * Rebuild one simulation the way WorkbenchApp._replayMcRun does: the run's param bag
 * applied through the shared function, and the run's seed handed to buildSim.
 */
function replayRun(cfgTemplate, params, seed) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const scenario = new IntlRetirementScenario({
    context: services.simulationContext, params, simStart: SIM_START, simEnd: SIM_END,
  });
  // telemetry left at the workbench's default ('full') on purpose: a replay is watched in
  // the Timeline, and a result that only reproduces under MC's 'off' would not be a replay
  // of what the user sees.
  scenario.buildSim({ seed });

  const cfg = structuredClone(ScenarioSerializer.serializeScenario(cfgTemplate));
  applyParamBagToConfig(cfg, params);
  new ScenarioLoader().load(cfg, services);

  scenario.sim.stepTo(SIM_END);
  return scenario.sim;
}

test('replaying an MC run reproduces its net worth exactly', async () => {
  // The scenario's own MEAN_REVERTING FX, NOT pinned: this test's subject is whether a
  // stochastic world can be reproduced, and pinning FX would remove the thing being tested.
  const cfgTemplate = IntlRetirementScenario.buildDefaultConfig({}, SIM_START, SIM_END);
  const { runs } = await new IntlRetirementMcRunner({
    n: 3, simStart: SIM_START, simEnd: SIM_END, cfgTemplate,
    mcConfig: new IntlRetirementMcConfig(),
  }).run();

  const target = runs[2];
  const sim    = replayRun(cfgTemplate, target.params, target.seed);

  assert.strictEqual(computeNetWorthUsd(sim.state), target.finalNetWorthUsd,
    'the sim is bit-deterministic, so a replay carrying the run\'s params AND seed must '
    + 'land on the same number — not merely close to it');
  assert.strictEqual(sim.state.scenarioFailed ?? false, target.scenarioFailed,
    'a failing MC path must replay as a failing path — the whole reason to replay one');
});

test('dropping the seed changes the replayed world', async () => {
  const cfgTemplate = IntlRetirementScenario.buildDefaultConfig({}, SIM_START, SIM_END);
  const { runs } = await new IntlRetirementMcRunner({
    n: 3, simStart: SIM_START, simEnd: SIM_END, cfgTemplate,
    mcConfig: new IntlRetirementMcConfig(),
  }).run();

  const target = runs[2];
  // `seed: null` is what the workbench passed before this change — "caller said nothing",
  // resolving to the scenario's randomSeed or 1. Same params, different random path.
  const unseeded = replayRun(cfgTemplate, target.params, null);

  assert.notStrictEqual(computeNetWorthUsd(unseeded.state), target.finalNetWorthUsd,
    'if this ever passes, the seed no longer selects the random path and the test above '
    + 'has stopped proving anything');
});
