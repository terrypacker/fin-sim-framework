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

// ─── ActionDetailPlugin ────────────────────────────────────────────────────────

test('ActionDetailPlugin.render: returns an element with wb-plugin-fill class', () => {
  const plugin = new ActionDetailPlugin(null);
  const el = plugin.render();
  assert.ok(el.classList.contains('wb-plugin-fill'), 'root should have wb-plugin-fill');
});

test('ActionDetailPlugin.render: creates a child with id="actionPanelDetails"', () => {
  const plugin = new ActionDetailPlugin(null);
  const el = plugin.render();
  const inner = el.querySelector('#actionPanelDetails');
  assert.ok(inner !== null, '#actionPanelDetails should exist inside the plugin root');
});

test('ActionDetailPlugin.render: actionPanelDetails has actionPanelDetails class', () => {
  const plugin = new ActionDetailPlugin(null);
  const inner = plugin.render().querySelector('#actionPanelDetails');
  assert.ok(inner.classList.contains('actionPanelDetails'), 'should have actionPanelDetails class');
});

test('ActionDetailPlugin.render: actionPanelDetails has wb-plugin-fill class', () => {
  const plugin = new ActionDetailPlugin(null);
  const inner = plugin.render().querySelector('#actionPanelDetails');
  assert.ok(inner.classList.contains('wb-plugin-fill'), 'should have wb-plugin-fill class');
});

test('ActionDetailPlugin: each render() call produces a fresh independent element', () => {
  const p1 = new ActionDetailPlugin(null);
  const p2 = new ActionDetailPlugin(null);
  const el1 = p1.render();
  const el2 = p2.render();
  assert.notEqual(el1, el2, 'each render() call should return a new element');
  assert.notEqual(
    el1.querySelector('#actionPanelDetails'),
    el2.querySelector('#actionPanelDetails'),
    'inner containers should be distinct',
  );
});
