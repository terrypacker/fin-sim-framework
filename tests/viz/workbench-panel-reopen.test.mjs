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
 * workbench-panel-reopen.test.mjs — a closed panel has to be able to come back.
 *
 * Closing a tab used to be one-way: nothing called `layout.addTab`, so the only route
 * back was resetting the whole layout. Worse, `activatePlugin()` returned false for a
 * closed panel and did nothing, so every route INTO a panel — the toolbar `?`, journal
 * drill-downs, an MC replay landing on the Timeline — went silently dead once that
 * panel's tab had been closed. And a close was never saved, so whether it stuck across a
 * reload depended on whatever unrelated layout change happened next.
 */

import assert from 'node:assert/strict';
import { WorkbenchShell }     from '../../src/visualization/workbench/workbench-shell.js';
import { WorkbenchComponent } from '../../src/visualization/workbench/component.js';
import { PanelMenu }          from '../../src/visualization/workbench/panel-menu.js';

globalThis.structuredClone ??= (v) => JSON.parse(JSON.stringify(v));

const KEY = 'test.workbench.reopen';

let constructed;
function stub(id) {
  return class extends WorkbenchComponent {
    constructor() { super(); constructed.push(id); this.renders = 0; }
    render() {
      this.renders++;
      const el = document.createElement('div');
      el.dataset.plugin = id;
      return el;
    }
  };
}

const PLUGINS = [
  { id: 'scenario', title: 'Scenario', component: stub('scenario'), category: 'configuration' },
  { id: 'chart',    title: 'Chart',    component: stub('chart'),    category: 'simulation' },
  { id: 'timeline', title: 'Timeline', component: stub('timeline'), category: 'simulation' },
  { id: 'help',     title: 'Help',     component: stub('help'),     category: 'system' },
  { id: 'journal',  title: 'Journal',  component: stub('journal'),  category: 'debug' },
];

const DEFAULT = {
  sizes: [1, 2, 1],
  left:   { tabs: ['scenario'], active: 'scenario' },
  center: { tabs: ['chart', 'timeline'], active: 'chart' },
  right:  { tabs: ['help'], active: 'help' },
  bottom: { tabs: ['journal'], active: 'journal' },
  bottomSize: 110, bottomCollapsed: false,
  centerSplit: false, centerSplitDir: 'h', centerInnerSizes: [1, 1],
  'center-a': { tabs: [], active: null },
  'center-b': { tabs: [], active: null },
};

function boot() {
  document.body.innerHTML = '<button id="btn"></button><div id="root"></div>';
  const shell = new WorkbenchShell({ defaultLayout: DEFAULT, plugins: PLUGINS, storageKey: KEY });
  shell.init(document.getElementById('root'));
  return shell;
}

const tabEl  = (id) => document.querySelector(`.wb-tab[data-tab="${id}"]`);
const viewOf = (id) => document.querySelector(`[data-plugin="${id}"]`);
const saved  = () => JSON.parse(localStorage.getItem(KEY));

beforeEach(() => { localStorage.clear(); constructed = []; });

test('closing a panel saves at once, and a reload keeps it closed', () => {
  const shell = boot();
  assert.equal(shell.closePlugin('chart'), true);
  assert.equal(tabEl('chart'), null);
  assert.deepEqual(saved().closedTabs, ['chart']);

  boot();
  assert.equal(tabEl('chart'), null, 'a saved close survives the reload');
});

test('re-opening returns the SAME instance, in its default pane, active and saved', () => {
  const shell = boot();
  const before = shell.instances.get('chart');
  shell.closePlugin('chart');
  shell.openPlugin('chart');

  assert.equal(shell.instances.get('chart'), before, 'state survives a close/re-open');
  assert.equal(before.renders, 1, 'not re-rendered from scratch');
  assert.equal(shell.paneOf('chart'), 'center');
  assert.ok(tabEl('chart').classList.contains('active'));
  assert.equal(viewOf('chart').style.display, '');
  assert.equal(viewOf('timeline').style.display, 'none');
  assert.deepEqual(saved().closedTabs, [], 're-opening revokes the closed record');
});

test('activatePlugin re-opens a closed panel instead of silently doing nothing', () => {
  const shell = boot();
  shell.closePlugin('help');
  assert.equal(shell.activatePlugin('help'), true);
  assert.equal(shell.paneOf('help'), 'right');
  assert.ok(tabEl('help').classList.contains('active'));
  assert.equal(shell.activatePlugin('no-such-panel'), false);
});

test('a panel closed since boot is constructed on first re-open', () => {
  boot();
  boot().closePlugin('timeline');
  constructed = [];
  const shell = boot();
  assert.ok(!constructed.includes('timeline'), 'a closed panel is not built at boot');

  constructed = [];
  shell.openPlugin('timeline');
  assert.deepEqual(constructed, ['timeline']);
  assert.ok(viewOf('timeline'), 'and it mounts');
});

test('re-opening a center panel while the center is split lands in center-a', () => {
  const shell = boot();
  shell.closePlugin('chart');
  shell._toggleCenterSplit();
  shell.openPlugin('chart');
  assert.equal(shell.paneOf('chart'), 'center-a');
});

test('re-opening into a collapsed bottom pane expands it', () => {
  const shell = boot();
  shell._toggleBottomCollapse();
  shell.closePlugin('journal');
  shell.openPlugin('journal');
  assert.equal(shell.layout.isBottomCollapsed(), false);
});

test('the Panels menu lists every panel, ticks the open ones and toggles them', () => {
  const shell = boot();
  const btn = document.getElementById('btn');
  new PanelMenu({ shell, button: btn });
  btn.click();

  const item = (title) => [...document.querySelectorAll('.panel-menu-item')]
    .find(e => e.querySelector('span:last-child')?.textContent === title);

  assert.equal(document.querySelectorAll('[role="menuitemcheckbox"]').length, PLUGINS.length);
  assert.match(document.querySelector('.panel-menu-head').textContent, /5 of 5 open/);
  assert.deepEqual([...document.querySelectorAll('.panel-menu-label')].map(e => e.textContent),
    ['Setup', 'Simulation', 'Journal & Debug', 'System']);

  item('Chart').click();
  assert.equal(shell.paneOf('chart'), null);
  assert.equal(item('Chart').getAttribute('aria-checked'), 'false', 'the menu re-renders in place');

  item('Chart').click();
  assert.equal(shell.paneOf('chart'), 'center');
  assert.equal(item('Chart').getAttribute('aria-checked'), 'true');

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(document.querySelector('.panel-menu'), null);
});

// ── Templates ────────────────────────────────────────────────────────────────
//
// Applying a template ran the same backfill that adopts panels a SAVED layout predates,
// so every panel a built-in omitted was put straight back: all four built-ins opened
// every panel and differed only in order and which tab was in front.

const ANALYSIS = {
  sizes: [1, 2, 1],
  left:   { tabs: ['scenario'], active: 'scenario' },
  center: { tabs: ['chart'], active: 'chart' },
  right:  { tabs: [], active: null },
  bottom: { tabs: [], active: null },
};

const openIds = (shell) => shell.listPanels().filter(p => p.pane).map(p => p.id).sort();

test('a built-in template opens ONLY the panels it lists, and the menu agrees', () => {
  const shell = boot();
  shell.applyLayout(ANALYSIS, { exhaustive: true, template: 'builtin:Analysis' });
  assert.deepEqual(openIds(shell), ['chart', 'scenario']);
  assert.equal(tabEl('timeline'), null);
  assert.deepEqual(shell.layout.getTemplateState(), { template: 'builtin:Analysis', modified: false });

  boot();   // and a reload keeps it
  assert.equal(tabEl('timeline'), null);
});

test('without `exhaustive` a template still adopts panels it never heard of', () => {
  const shell = boot();
  shell.applyLayout(ANALYSIS);
  assert.equal(openIds(shell).length, PLUGINS.length);
});

test('opening, closing or moving a panel marks the template modified, and says so', () => {
  const shell = boot();
  const seen = [];
  shell.runtime.bus.subscribe('workbench.layout.changed', (e) => seen.push(e.modified));
  shell.applyLayout(ANALYSIS, { exhaustive: true, template: 'builtin:Analysis' });
  assert.deepEqual(seen, [false]);

  shell.openPlugin('help');
  assert.equal(shell.layout.getTemplateState().modified, true);
  assert.deepEqual(seen, [false, true]);

  shell.applyLayout(ANALYSIS, { exhaustive: true, template: 'builtin:Analysis' });
  assert.equal(shell.layout.getTemplateState().modified, false, 're-applying reverts');
});

test('a saved view keeps its closed panels, and becomes the current template', () => {
  const shell = boot();
  shell.closePlugin('timeline');
  shell.closePlugin('journal');
  shell.layout.saveTemplate('Mine');
  assert.deepEqual(shell.layout.getTemplateState(), { template: 'saved:Mine', modified: false });

  shell.applyLayout(ANALYSIS, { exhaustive: true, template: 'builtin:Analysis' });
  shell.applyLayout(shell.layout.loadTemplate('Mine'), { template: 'saved:Mine' });
  assert.deepEqual(openIds(shell), ['chart', 'help', 'scenario']);
});

test('the menu footer offers whatever actions the app supplies, and runs them', () => {
  const shell = boot();
  const btn = document.getElementById('btn');
  let ran = 0;
  new PanelMenu({ shell, button: btn, footerActions: () => [{ label: 'Revert', run: () => ran++ }] });
  btn.click();
  const revert = [...document.querySelectorAll('.panel-menu-foot .panel-menu-item')];
  assert.deepEqual(revert.map(e => e.textContent), ['Revert']);
  revert[0].click();
  assert.equal(ran, 1);
  assert.equal(document.querySelector('.panel-menu'), null, 'and the menu closes');
});
