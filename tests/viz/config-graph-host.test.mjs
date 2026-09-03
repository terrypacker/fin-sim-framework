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
 * config-graph-host.test.mjs — the config graph's DOM outlives its panel.
 *
 * The bug this pins: `#graphRoot` was minted inside `ConfigGraphPlugin.render()`, and a
 * workbench plugin's `render()` runs on its first MOUNT. So for anyone whose saved layout
 * had the Graph tab CLOSED, the element did not exist when `WorkbenchApp.initScenario()`
 * looked it up by id — and `ConfigGraphView` dereferences it immediately
 * (`graphRoot.parentElement`). The throw was uncaught at boot, so everything after it was
 * skipped, including the scenario list. The app read as "no scenarios"; the cause was the
 * layout, which is nowhere near where anyone would look.
 *
 * The fix moves ownership to the runtime, which outlives every mount and every Rebuild.
 * What is worth pinning is therefore not "the element exists" but the three properties
 * that make the crash unreachable again:
 *
 *  1. the host exists before ANY panel has mounted;
 *  2. the root always has a PARENT — `ConfigGraphView` inserts its filter bar with
 *     `panel.insertBefore(bar, graphRoot)`, so a bare detached div moves the same crash
 *     one line down rather than fixing it;
 *  3. it is the SAME element across mount / unmount / remount, because the graph
 *     renderer, the presenter and the animator all captured it at `initScenario()`.
 */

import assert from 'node:assert/strict';
import { WorkbenchRuntime } from '../../src/visualization/workbench/workbench-runtime.js';
import { ConfigGraphPlugin } from '../../src/visualization/workbench/plugins/finance/config-graph-plugin.js';

test('the host exists before any panel is mounted — the boot-order case', () => {
  const runtime = new WorkbenchRuntime();
  // Nothing has been mounted; this is the state `initScenario()` runs in when the user's
  // layout has the Graph tab closed.
  const { root } = runtime.graphHost();
  assert.ok(root, 'initScenario() must never receive null here');
  assert.equal(root.id, 'graphRoot');
});

test('the root has a parent even while detached', () => {
  const runtime = new WorkbenchRuntime();
  const { outer, root } = runtime.graphHost();
  // This is the exact dereference that used to throw, and the reason the host is a PAIR
  // rather than a single div.
  assert.equal(root.parentElement, outer);
  assert.ok(outer.classList.contains('wb-graph-outer'));
});

test('the same element survives mount, unmount and remount', () => {
  const runtime = new WorkbenchRuntime();
  const captured = runtime.graphHost().root;   // what initScenario() holds

  const plugin = new ConfigGraphPlugin(runtime);
  const pane   = document.createElement('div');
  document.body.appendChild(pane);

  plugin.mount(pane);
  assert.equal(pane.querySelector('#graphRoot'), captured, 'the panel adopts the host, it does not mint one');

  plugin.unmount();
  assert.equal(pane.querySelector('#graphRoot'), null, 'closing the tab still removes it from view');
  assert.equal(runtime.graphHost().root, captured, '…but the element the renderer holds is untouched');

  plugin.mount(pane);
  assert.equal(pane.querySelector('#graphRoot'), captured, 'reopening shows the SAME element back');
});

test('the runtime hands out one host, not one per call', () => {
  // Two callers — the app at initScenario(), the plugin at first mount — must agree on the
  // ELEMENT, or the graph renders into a div nobody is looking at. (Identity is asserted on
  // the elements, not on the returned wrapper: `graphHost()` is a view over the memoized
  // `paneHost` pair and may hand back a fresh object each call.)
  const runtime = new WorkbenchRuntime();
  assert.equal(runtime.graphHost().root,  runtime.graphHost().root);
  assert.equal(runtime.graphHost().outer, runtime.graphHost().outer);
  assert.notEqual(new WorkbenchRuntime().graphHost().root, runtime.graphHost().root,
    'but a second runtime is a second session, and gets its own');
});
