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
 * monte-carlo-presenter.test.mjs
 *
 * Covers where the MC panel gets its variable CENTERS from. The scenario INSTANCE
 * carries a param bag frozen at the last Rebuild; the ACTIVE CFG is the live record
 * the scenario editor writes into. Reading the frozen one is how a run ends up
 * describing a plan the user has already edited away from, so the presenter must
 * prefer the active cfg — including its typed `params` list, which is the store the
 * editor actually mutates.
 *
 * Run with: npm run test:viz
 */

import { MonteCarloPresenter } from '../../src/visualization/monte-carlo/monte-carlo-presenter.js';
import { ServiceRegistry }     from '../../src/services/service-registry.js';

function makeView() {
  const pane = () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  };
  return { configPane: pane(), resultsPane: pane(), runsPane: pane(), destroy() {} };
}

/** Point the singleton's scenarioService at a fixed active cfg. */
function setActiveCfg(cfg) {
  ServiceRegistry.resetAll();
  ServiceRegistry.getInstance().scenarioService.getActive = () => cfg;
}

function makePresenter(scenario) {
  return new MonteCarloPresenter({
    controller: { runMonteCarlo: () => Promise.resolve({ runs: [], summary: {} }) },
    view:       makeView(),
    scenario:   { simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2041, 0, 1)), ...scenario },
  });
}

describe('MonteCarloPresenter — variable centers follow the live scenario', () => {
  afterEach(() => ServiceRegistry.resetAll());

  test('reads the active cfg typed params list, not just the instance bag', () => {
    setActiveCfg({ params: [{ name: 'brokerageGrowthRate', value: 0.11 }], accounts: [] });
    const presenter = makePresenter({ params: { brokerageGrowthRate: 0.04 } });

    expect(presenter._scenarioCenters().get('brokerageGrowthRate')).toBeCloseTo(0.11);

    presenter.destroy();
  });

  test('falls back to the scenario instance bag when there is no active cfg', () => {
    setActiveCfg(null);
    const presenter = makePresenter({ params: { brokerageGrowthRate: 0.04 } });

    expect(presenter._scenarioCenters().get('brokerageGrowthRate')).toBeCloseTo(0.04);

    presenter.destroy();
  });

  test('tags each variable with the layer its center came from', () => {
    // `brokerageGrowthRate` is on the cfg; `spouseRothGrowthRate` is a schema key the
    // cfg doesn't carry, so its center is the schema default — the value the sim will
    // run at, which is why it must resolve rather than fall through to the MC
    // template's own mean.
    setActiveCfg({ params: [{ name: 'brokerageGrowthRate', value: 0.11 }], accounts: [] });
    const presenter = makePresenter({ params: {} });

    const bySource = new Map(presenter._resolveVariables().map(v => [v.paramKey, v.centerSource]));
    expect(bySource.get('brokerageGrowthRate')).toBe('scenario');
    expect(bySource.get('spouseRothGrowthRate')).toBe('schema');
    // A balance lever's value lives on the ACCOUNT, and this cfg has none — so its
    // center really is a framework default and says so.
    expect(bySource.get('stockBalance')).toBe('default');
    // A wage lever's value lives on the PERSON record, which is in neither param
    // store nor the schema — so these read `default` even for a complete plan.
    expect(bySource.get('primaryMonthlyWage')).toBe('default');

    presenter.destroy();
  });

  test('wiring the account moves its balance lever from default to scenario', () => {
    setActiveCfg({ params: [], accounts: [{ stateKey: 'usStockAccount', balance: 750_000 }] });
    const presenter = makePresenter({ params: {} });

    const v = presenter._resolveVariables().find(x => x.paramKey === 'stockBalance');
    expect(v.centerSource).toBe('scenario');
    expect(v.defaultValue).toBe(750_000);

    presenter.destroy();
  });

  test('an account balance beats the params bag (a holdings-bearing balance is derived)', () => {
    setActiveCfg({
      params:   [{ name: 'stockBalance', value: 111_111 }],
      accounts: [{ stateKey: 'usStockAccount', balance: 750_000 }],
    });
    const presenter = makePresenter({ params: {} });

    expect(presenter._scenarioCenters().get('stockBalance')).toBe(750_000);

    presenter.destroy();
  });
});
