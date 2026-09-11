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
 * mc-telemetry-options.test.mjs — design 100 §4.
 *
 * `mix` and `spending` were runner flags with no UI (design 89 §21). These pin the two
 * opt-in checkboxes — off by default, with the cost on the label — and that the flags
 * actually reach the controller. A checkbox that is read and then dropped between the
 * panel and the runner would look like it works and record nothing.
 *
 * Run with: npm run test:viz
 */

import { McConfigPanel }       from '../../src/visualization/monte-carlo/mc-config-panel.js';
import { MonteCarloPresenter } from '../../src/visualization/monte-carlo/monte-carlo-presenter.js';
import { ServiceRegistry }     from '../../src/services/service-registry.js';

function makeConfigPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, panel: new McConfigPanel(container) };
}

describe('McConfigPanel — opt-in telemetry', () => {
  test('both options are off by default and getConfig says so', () => {
    const { panel } = makeConfigPanel();
    const cfg = panel.getConfig();
    expect(cfg.mix).toBe(false);
    expect(cfg.spending).toBe(false);
    panel.destroy();
  });

  test('the labels carry the cost', () => {
    const { panel, container } = makeConfigPanel();
    const text = container.querySelector('.mc-telemetry').textContent;
    expect(text).toContain('Record asset mix');
    expect(text).toContain('~1%');
    expect(text).toContain('Record spending');
    expect(text).toContain('7.5×');
    panel.destroy();
  });

  test('checking each option turns its flag on', () => {
    const { panel, container } = makeConfigPanel();
    container.querySelector('.mc-opt-mix').checked = true;
    expect(panel.getConfig()).toMatchObject({ mix: true, spending: false });
    container.querySelector('.mc-opt-spending').checked = true;
    expect(panel.getConfig()).toMatchObject({ mix: true, spending: true });
    panel.destroy();
  });
});

describe('MonteCarloPresenter — telemetry flags reach the controller', () => {
  const realRaf = global.requestAnimationFrame;
  beforeEach(() => {
    ServiceRegistry.resetAll();
    ServiceRegistry.getInstance().scenarioService.getActive = () => ({ params: [] });
    global.requestAnimationFrame = (cb) => cb();
  });
  afterEach(() => {
    ServiceRegistry.resetAll();
    global.requestAnimationFrame = realRaf;
  });

  function makePresenter(captured) {
    const pane = () => { const el = document.createElement('div'); document.body.appendChild(el); return el; };
    return new MonteCarloPresenter({
      controller: { runMonteCarlo: (opts) => { captured.push(opts); return Promise.resolve({ runs: [], summary: {} }); } },
      view:       { configPane: pane(), resultsPane: pane(), runsPane: pane(), destroy() {} },
      scenario:   { simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2041, 0, 1)) },
    });
  }

  test('mix and spending are passed through on run', () => {
    const captured = [];
    const presenter = makePresenter(captured);
    presenter._onRun({ n: 3, variableConfigs: [], mix: true, spending: true });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ n: 3, mix: true, spending: true });
  });

  test('a config without the flags runs with both off', () => {
    const captured = [];
    const presenter = makePresenter(captured);
    presenter._onRun({ n: 2, variableConfigs: [] });
    expect(captured[0]).toMatchObject({ mix: false, spending: false });
  });
});
