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
 * workbench-layout-new-tabs.test.mjs — a newly registered panel has to become visible.
 *
 * The bug this pins was found shipping design 82's Allocation panel: a saved layout
 * backfilled only top-level KEYS, so a new default tab was invisible to everyone who
 * had ever used the app — and invisible in the worst way, because the plugin loads and
 * works and simply has no tab. That reads as "the feature is broken", not "your layout
 * predates it", so nobody reports it as a layout problem.
 *
 * The counterweight: a tab the user CLOSED must stay closed. Absence cannot distinguish
 * "never heard of it" from "not wanted", so closing records intent explicitly.
 */

import assert from 'node:assert/strict';
import { WorkbenchLayoutModel } from '../../src/visualization/workbench/layout-model.js';

const DEFAULT = {
  sizes: [1, 2, 1],
  left:   { tabs: ['scenario'], active: 'scenario' },
  center: { tabs: ['chart', 'allocation', 'holdings'], active: 'chart' },
  right:  { tabs: ['state-panel'], active: 'state-panel' },
};

const KEY = 'test.workbench.layout';

// This jsdom environment predates structuredClone, which layout-model uses on the
// no-saved-layout path. JSON round-trip is equivalent for a layout (plain data).
globalThis.structuredClone ??= (v) => JSON.parse(JSON.stringify(v));

function saveLayout(layout) {
  localStorage.setItem(KEY, JSON.stringify(layout));
}

beforeEach(() => localStorage.clear());

test('a default tab the saved layout has never seen is placed in its default pane', () => {
  // A layout saved before 'allocation' existed.
  saveLayout({
    sizes: [1, 2, 1],
    left:   { tabs: ['scenario'], active: 'scenario' },
    center: { tabs: ['chart', 'holdings'], active: 'chart' },
    right:  { tabs: ['state-panel'], active: 'state-panel' },
  });

  const model = new WorkbenchLayoutModel(DEFAULT);
  model.load(KEY);

  assert.ok(model.layout.center.tabs.includes('allocation'), 'the new tab must appear');
  // Placed, not activated over the user's choice.
  assert.equal(model.layout.center.active, 'chart');
  // And the rest of the saved layout is untouched.
  assert.deepEqual(model.layout.left.tabs, ['scenario']);
});

test('a tab the user closed is not helpfully restored on the next load', () => {
  const model = new WorkbenchLayoutModel(DEFAULT);
  model.load(KEY);                       // no saved layout ⇒ the default, with allocation
  assert.ok(model.layout.center.tabs.includes('allocation'));

  model.closeTab('center', 'allocation');
  assert.ok(!model.layout.center.tabs.includes('allocation'));
  model.save();

  const reloaded = new WorkbenchLayoutModel(DEFAULT);
  reloaded.load(KEY);
  assert.ok(!reloaded.layout.center.tabs.includes('allocation'),
    'closing a tab is an instruction, not an accident');
});

test('re-opening a closed tab revokes the record, so it survives the next load', () => {
  const model = new WorkbenchLayoutModel(DEFAULT);
  model.load(KEY);
  model.closeTab('center', 'allocation');
  model.addTab('center', 'allocation');
  model.save();

  const reloaded = new WorkbenchLayoutModel(DEFAULT);
  reloaded.load(KEY);
  assert.ok(reloaded.layout.center.tabs.includes('allocation'));
  assert.ok(!(reloaded.layout.closedTabs ?? []).includes('allocation'));
});

test('a tab already placed in a DIFFERENT pane is left where the user put it', () => {
  saveLayout({
    sizes: [1, 2, 1],
    left:   { tabs: ['scenario'], active: 'scenario' },
    center: { tabs: ['chart', 'holdings'], active: 'chart' },
    // The user dragged it to the right pane.
    right:  { tabs: ['state-panel', 'allocation'], active: 'state-panel' },
  });

  const model = new WorkbenchLayoutModel(DEFAULT);
  model.load(KEY);

  assert.ok(!model.layout.center.tabs.includes('allocation'), 'must not be duplicated');
  assert.ok(model.layout.right.tabs.includes('allocation'));
});
