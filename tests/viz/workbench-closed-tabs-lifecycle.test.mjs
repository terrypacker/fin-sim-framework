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
 * workbench-closed-tabs-lifecycle.test.mjs — a closed tab must survive the whole session,
 * not just boot.
 *
 * `workbench-boot-with-closed-tabs.test.mjs` pins that the app BOOTS with any tab closed.
 * This is the same bug class one step further: after boot, the session keeps reaching for
 * panel DOM. It steps the sim, rebuilds, and imports a scenario, and each of those wrote
 * into a panel's element found with `getElementById`. With the panel closed that element
 * is `null` (a plugin's `render()` runs on first MOUNT), or detached (a runtime-owned
 * host is not in the document while its tab is closed).
 *
 * The failure that found it: importing a scenario JSON with the State tab closed. The
 * import stored the scenario, then the rebuild threw on `currentStateContent` before the
 * scenario dropdown was redrawn. The new scenario was saved but invisible until a reload,
 * and the throw was an unhandled promise rejection that nothing on screen reported.
 *
 * Errors are collected from every channel, not just the call stack. Most of these writes
 * happen in a throttled render (requestAnimationFrame) or behind an un-awaited async
 * handler, where a throw never reaches the caller, so `expect(fn).not.toThrow()` alone
 * would pass while the app was broken.
 */

import { loadHtml } from '../helpers/viz-utils.js';
import { SimulationWorkbench } from '../../src/apps/simulation-workbench.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { FINANCE_DEFAULT_LAYOUT } from '../../src/visualization/workbench/plugins/finance/finance-plugin-package.js';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
globalThis.structuredClone ??= (v) => JSON.parse(JSON.stringify(v));

const PANES = ['left', 'center', 'right', 'bottom'];
const ALL_TABS = PANES.flatMap(p => FINANCE_DEFAULT_LAYOUT[p]?.tabs ?? []);

function layoutWithout(closed) {
  const closedSet = new Set([].concat(closed ?? []));
  const layout = { sizes: [1, 2, 1], closedTabs: [...closedSet] };
  for (const pane of PANES) {
    const kept = (FINANCE_DEFAULT_LAYOUT[pane]?.tabs ?? []).filter(t => !closedSet.has(t));
    layout[pane] = { tabs: kept, active: kept[0] ?? null };
  }
  return layout;
}

/** Every error the session raises, on any channel — thrown, timer-thrown, or rejected. */
function collectErrors() {
  const errors = [];
  const onError = (e) => { errors.push(e.error ?? e.message); e.preventDefault?.(); };
  const onRejection = (reason) => errors.push(reason);
  window.addEventListener('error', onError);
  process.on('unhandledRejection', onRejection);
  return {
    errors,
    stop() {
      window.removeEventListener('error', onError);
      process.off('unhandledRejection', onRejection);
    },
  };
}

const settle = () => new Promise(r => setTimeout(r, 20));

function boot(closed) {
  HTMLCanvasElement.prototype.getContext = () => null;
  loadHtml('../../index.html');
  localStorage.clear();
  if (closed) localStorage.setItem('sim-workbench-layout-prod', JSON.stringify(layoutWithout(closed)));
  ServiceRegistry.resetAll?.();
  const app = new SimulationWorkbench();
  app.initView();
  app.initScenario();
  return app;
}

/** Boot → step → rebuild → import a scenario JSON → step again. Returns every error. */
async function session(closed) {
  const sink = collectErrors();
  try {
    const app = boot(closed);
    await settle();

    for (let i = 0; i < 3; i++) app.timeControls.stepForward();
    await settle();

    app.destroyScenario();
    app.initScenario();
    await settle();

    // The real upload path: the presenter's handler, fed a File through the view's reader.
    const presenter = app.scenarioTabPresenter;
    const record = ScenarioSerializer.serializeScenario(presenter._activeScenario);
    delete record.id;
    record.name = 'Imported copy';
    record.active = true;
    const file = new File([JSON.stringify({ scenarios: [record] })], 'import.json', { type: 'application/json' });
    await presenter._view.onUploadJson(file);
    await settle();

    const names = [...document.getElementById('scenarioSelect')?.options ?? []].map(o => o.textContent);

    app.timeControls.stepForward();
    await settle();
    return { errors: sink.errors, names };
  } catch (e) {
    return { errors: [...sink.errors, e], names: [] };
  } finally {
    sink.stop();
  }
}

const describeErrors = (errors) => errors.map(e => String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '));

test('the default layout survives a full session', async () => {
  // The control: if this fails, every row below fails for a reason unrelated to layout.
  const { errors, names } = await session(null);
  expect(describeErrors(errors)).toEqual([]);
  expect(names).toContain('Imported copy');
});

test.each(ALL_TABS)('a session with the %s tab closed raises nothing', async (tab) => {
  const { errors, names } = await session(tab);
  expect(describeErrors(errors)).toEqual([]);
  // The symptom the user saw: the import stored the scenario but the dropdown never showed
  // it. The dropdown is part of the Scenario tab, so there is nothing to check without it.
  if (tab !== 'scenario') expect(names).toContain('Imported copy');
});

test('a session with EVERY tab closed raises nothing', async () => {
  const { errors } = await session(ALL_TABS);
  expect(describeErrors(errors)).toEqual([]);
});

/**
 * The quieter half of the class: a view that WIRES its panel's controls once at boot.
 * With the tab closed at boot there was nothing to wire, so opening the tab later showed
 * controls that did nothing: an empty scenario dropdown, a dead Download JSON, a State
 * filter that filtered nothing. No error anywhere. The panels are now runtime-owned, so
 * reopening one must give working controls.
 */
describe('a tab closed at boot works once it is opened', () => {
  test('Scenario: the dropdown lists scenarios and Download JSON fires', async () => {
    const app = boot('scenario');
    app._wbShell.openPlugin('scenario');
    app._wbShell.activatePlugin('scenario');
    let downloaded = false;
    app._scenarioTabView.onDownloadJson = () => { downloaded = true; };
    document.getElementById('downloadJsonBtn').click();
    expect(downloaded).toBe(true);
    expect(document.getElementById('scenarioSelect').options.length).toBeGreaterThan(0);
  });

  test('Parameters: the filter is wired', () => {
    const app = boot('parameters');
    app._wbShell.openPlugin('parameters');
    app._wbShell.activatePlugin('parameters');
    const filter = document.getElementById('paramsFilter');
    filter.value = 'inflation';
    filter.dispatchEvent(new Event('input'));
    expect(app._scenarioTabView._paramFilter).toBeTruthy();
    expect(document.getElementById('paramsList').children.length).toBeGreaterThan(0);
  });

  test('State: the field filter is wired', () => {
    const app = boot('state-panel');
    app._wbShell.openPlugin('state-panel');
    app._wbShell.activatePlugin('state-panel');
    const filter = document.getElementById('lsp-panel-filter');
    filter.value = 'balance';
    filter.dispatchEvent(new Event('input'));
    expect(app._statePanelView._filterText).toBe('balance');
  });
});
