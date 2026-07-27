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
 * optimization-presenter.test.mjs
 *
 * Where the Optimization tab gets the params it builds the SEARCH SPACE from. The
 * scenario INSTANCE carries a bag frozen at the last Rebuild; the ACTIVE CFG is the
 * live record the editor writes into. The distinction has teeth here: buildOptVariables
 * reads these params to synthesize the per-shock / expense-band / Roth-schedule axes
 * and to evaluate every variable's `visibleWhen`, so a stale snapshot drops whole
 * DIMENSIONS from the search rather than merely mis-labelling one.
 *
 * Run with: npm run test:viz
 */

import { OptimizationPresenter } from '../../src/visualization/optimization/optimization-presenter.js';
import { ServiceRegistry }       from '../../src/services/service-registry.js';

function makeView() {
  const pane = () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  };
  return { configPane: pane(), resultsPane: pane(), runsPane: pane(), destroy() {} };
}

function setActiveCfg(cfg) {
  ServiceRegistry.resetAll();
  ServiceRegistry.getInstance().scenarioService.getActive = () => cfg;
}

function makePresenter(scenario) {
  return new OptimizationPresenter({
    controller: { runOptimization: () => Promise.resolve({ candidates: [], best: null }) },
    view:       makeView(),
    scenario:   { simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2041, 0, 1)), ...scenario },
  });
}

describe('OptimizationPresenter — base params follow the live scenario', () => {
  afterEach(() => ServiceRegistry.resetAll());

  test('reads the active cfg typed params list, not just the instance bag', () => {
    setActiveCfg({ params: [{ name: 'moveYear', value: 2033 }] });
    const presenter = makePresenter({ params: { moveYear: 2029 } });

    expect(presenter._resolveBaseParams().moveYear).toBe(2033);

    presenter.destroy();
  });

  test('falls back to the scenario instance bag when there is no active cfg', () => {
    setActiveCfg(null);
    const presenter = makePresenter({ params: { moveYear: 2029 } });

    expect(presenter._resolveBaseParams().moveYear).toBe(2029);

    presenter.destroy();
  });

  test('a shock on the live cfg produces its per-shock search axes', () => {
    // The dimension only exists if `shocks` is in the resolved params — the
    // frozen-instance read is exactly how an axis goes missing without a warning.
    setActiveCfg({
      params: [{ name: 'shocks', value: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01' }] }],
    });
    const presenter = makePresenter({ params: {} });

    expect(presenter._resolveBaseParams().shocks).toHaveLength(1);

    presenter.destroy();
  });
});
