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
 * workbench-view-templates.test.mjs — the built-in views name real panels, once each.
 *
 * The views are exhaustive (a panel not listed is closed), so a typo or a renamed panel id
 * does not fail loudly: the panel just never opens in that view, and the tab group skips
 * the unknown id with a console warning nobody reads. The old built-ins drifted exactly
 * this way — written before half the panels existed, and never revisited.
 */

import assert from 'node:assert/strict';
import {
  FINANCE_PLUGINS, FINANCE_DEFAULT_LAYOUT, FINANCE_VIEW_TEMPLATES, FINANCE_INITIAL_VIEW,
} from '../../src/visualization/workbench/plugins/finance/finance-plugin-package.js';

const PANES = ['left', 'center', 'right', 'bottom'];
const REGISTERED = new Set(FINANCE_PLUGINS.map(p => p.id));

test('Everything is the default layout, and the default opens every registered panel', () => {
  assert.equal(FINANCE_VIEW_TEMPLATES.Everything, FINANCE_DEFAULT_LAYOUT);
  const placed = PANES.flatMap(p => FINANCE_DEFAULT_LAYOUT[p].tabs).sort();
  assert.deepEqual(placed, [...REGISTERED].sort());
});

test('the first-visit view is one of the built-ins', () => {
  assert.ok(FINANCE_VIEW_TEMPLATES[FINANCE_INITIAL_VIEW]);
});

for (const [name, view] of Object.entries(FINANCE_VIEW_TEMPLATES)) {
  test(`${name}: every panel is registered, placed once, and each active tab is in its pane`, () => {
    const seen = [];
    for (const pane of PANES) {
      const cfg = view[pane];
      assert.ok(cfg, `${name} has no ${pane} pane`);
      for (const id of cfg.tabs) assert.ok(REGISTERED.has(id), `${name}.${pane}: unknown panel '${id}'`);
      assert.ok(cfg.active === null ? cfg.tabs.length === 0 : cfg.tabs.includes(cfg.active),
        `${name}.${pane}: active '${cfg.active}' is not one of its tabs`);
      seen.push(...cfg.tabs);
    }
    assert.equal(new Set(seen).size, seen.length, `${name} lists a panel twice`);
    assert.ok(seen.includes('help'), `${name} has no Help panel`);
  });
}
