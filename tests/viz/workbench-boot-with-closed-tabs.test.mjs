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
 * workbench-boot-with-closed-tabs.test.mjs — the app must boot whatever the layout says.
 *
 * ### The bug class
 *
 * A workbench plugin's `render()` runs on its first MOUNT, so a tab the user has CLOSED
 * contributes no DOM. Most finance panels are thin shims whose only job is to mint an
 * id'd div; the real component is built by `WorkbenchApp.initScenario()`, which found it
 * with `getElementById`. Closing such a tab therefore handed `null` to a constructor that
 * dereferences it, and the throw was UNCAUGHT during boot — so everything after it was
 * skipped, including the scenario list. The app read as "no scenarios"; the cause was a
 * key in `localStorage`, which is nowhere near where anyone would look.
 *
 * When this test was written, **11 of the 31 default tabs bricked boot when closed**, and
 * a 12th (`config-graph`) had just been fixed the same way. The fix is
 * `WorkbenchRuntime.paneHost()`: the element's lifetime is the SESSION, not the panel's
 * visibility, and the panels adopt it instead of creating it.
 *
 * ### Why the whole app, and not a unit test per panel
 *
 * A unit test per panel pins the panels that exist today. This bug arrives by ADDING one:
 * write a new shim that mints its own div, read it from `initScenario()` with
 * `getElementById`, and every reader who has ever closed that tab is bricked — with no
 * test failing anywhere. Booting the real app once per closed tab is the only shape that
 * catches the next one, and it is cheap because a boot is a few milliseconds here.
 *
 * The oracle is deliberately weak: boot COMPLETES. This says nothing about whether a panel
 * renders correctly, and it should not — that belongs to each panel's own tests. It says
 * the layout cannot take the application down, which is the property that was violated.
 */

import { loadHtml } from '../helpers/viz-utils.js';
import { SimulationWorkbench } from '../../src/apps/simulation-workbench.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { FINANCE_DEFAULT_LAYOUT } from '../../src/visualization/workbench/plugins/finance/finance-plugin-package.js';

// jsdom supplies none of these; the app only needs them to exist.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
globalThis.structuredClone ??= (v) => JSON.parse(JSON.stringify(v));

const PANES = ['left', 'center', 'right', 'bottom'];
const ALL_TABS = PANES.flatMap(p => FINANCE_DEFAULT_LAYOUT[p]?.tabs ?? []);

/** A saved layout with `closed` (an id or a list) removed from every pane. */
function layoutWithout(closed) {
  const closedSet = new Set([].concat(closed ?? []));
  const layout = { sizes: [1, 2, 1], closedTabs: [...closedSet] };
  for (const pane of PANES) {
    const kept = (FINANCE_DEFAULT_LAYOUT[pane]?.tabs ?? []).filter(t => !closedSet.has(t));
    layout[pane] = { tabs: kept, active: kept[0] ?? null };
  }
  return layout;
}

function boot(closed) {
  // ECharts asks for a 2D context and jsdom has none. Returning null is what the panels'
  // own `_canvasAvailable()` probes expect, and it keeps the charts out of this test —
  // which is about DOM ownership, not rendering.
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

test('the default layout boots', () => {
  // The control. Without it, a change that broke EVERY boot would still pass the sweep
  // below by breaking it uniformly, and the failure would read as a layout problem.
  expect(() => boot(null)).not.toThrow();
});

test.each(ALL_TABS)('boots with the %s tab closed', (tab) => {
  expect(() => boot(tab)).not.toThrow();
});

test('boots with EVERY tab closed', () => {
  // The degenerate layout, which is also the strongest statement of the invariant: no
  // panel's DOM is a precondition of starting up.
  expect(() => boot(ALL_TABS)).not.toThrow();
});

test('every panel the app reaches for is owned by the runtime, not the document', () => {
  // The mechanism, not just the symptom. After a boot with everything closed, the hosts
  // the app captured are real elements that are NOT in the document — which is exactly
  // the state the old code could not represent, and the reason it passed `null` on.
  const app  = boot(ALL_TABS);
  const runtime = app._wbShell.runtime;
  const ids = ['graphRoot', 'configGroupNodes', 'graphNodeEditPane', 'graphNodeHistoryPane',
    'graphNodeLineagePane', 'mcConfigPane', 'mcResultsPane', 'mcRunsPane', 'optConfigPane',
    'optResultsPane', 'optRunsPane', 'dgConfigPane', 'dgResultsPane', 'scenarioComparePane',
    'chartContainer', 'timelineContainer'];
  for (const id of ids) {
    const { inner } = runtime.paneHost(id);
    expect(inner).toBeTruthy();
    expect(inner.id).toBe(id);
    expect(document.getElementById(id)).toBeNull();   // closed ⇒ not displayed…
    expect(inner.parentElement).toBeTruthy();         // …but still parented, so an
                                                      // insertBefore against it works
  }
});
