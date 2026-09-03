/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import { ActionDetailPlugin } from '../../src/visualization/workbench/plugins/finance/action-detail-plugin.js';
import { WorkbenchRuntime } from '../../src/visualization/workbench/workbench-runtime.js';

// ─── ActionDetailPlugin ────────────────────────────────────────────────────────
//
// The panel no longer MINTS its host — `WorkbenchRuntime.paneHost()` owns it and the
// panel adopts it, because a plugin's `render()` only runs on its first mount and the
// component that fills this div is built at `initScenario()` regardless. So these now
// pass a runtime; the markup assertions are unchanged, which is the point of keeping
// them — the ownership moved and the DOM did not.

test('ActionDetailPlugin.render: returns an element with wb-plugin-fill class', () => {
  const plugin = new ActionDetailPlugin(new WorkbenchRuntime());
  const el = plugin.render();
  assert.ok(el.classList.contains('wb-plugin-fill'), 'root should have wb-plugin-fill');
});

test('ActionDetailPlugin.render: creates a child with id="actionPanelDetails"', () => {
  const plugin = new ActionDetailPlugin(new WorkbenchRuntime());
  const el = plugin.render();
  const inner = el.querySelector('#actionPanelDetails');
  assert.ok(inner !== null, '#actionPanelDetails should exist inside the plugin root');
});

test('ActionDetailPlugin.render: actionPanelDetails has actionPanelDetails class', () => {
  const plugin = new ActionDetailPlugin(new WorkbenchRuntime());
  const inner = plugin.render().querySelector('#actionPanelDetails');
  assert.ok(inner.classList.contains('actionPanelDetails'), 'should have actionPanelDetails class');
});

test('ActionDetailPlugin.render: actionPanelDetails has wb-plugin-fill class', () => {
  const plugin = new ActionDetailPlugin(new WorkbenchRuntime());
  const inner = plugin.render().querySelector('#actionPanelDetails');
  assert.ok(inner.classList.contains('wb-plugin-fill'), 'should have wb-plugin-fill class');
});

test('the host is per-SESSION: shared within a runtime, distinct across runtimes', () => {
  // This replaces an assertion that every render() returned a FRESH element. That was the
  // right invariant while the panel owned its DOM; under `paneHost` the opposite is the
  // point — the app captured this element at `initScenario()`, so re-rendering the panel
  // must not hand it a different one, or the component would keep filling an orphan.
  const runtime = new WorkbenchRuntime();
  const el1 = new ActionDetailPlugin(runtime).render();
  const el2 = new ActionDetailPlugin(runtime).render();
  assert.equal(el1, el2, 'one session, one host');
  assert.equal(el1.querySelector('#actionPanelDetails'), el2.querySelector('#actionPanelDetails'));

  // A second runtime is a second session (a fresh app, or a test): its own element, so
  // nothing leaks between them.
  const other = new ActionDetailPlugin(new WorkbenchRuntime()).render();
  assert.notEqual(other, el1);
  assert.notEqual(other.querySelector('#actionPanelDetails'), el1.querySelector('#actionPanelDetails'));
});
