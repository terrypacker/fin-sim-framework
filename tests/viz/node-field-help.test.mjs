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
 * node-field-help.test.mjs
 * Help on the node edit forms (design 111 §6).
 *
 * Against the REAL index and the REAL templates, for the reason every design-108 test
 * gives: a fixture index would be a second copy of the registries, which is the failure
 * this whole system exists to remove. What these pin is the seam between the two halves —
 * the generated description reaching the control the user is actually looking at.
 *
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';

import { decorateNodeFields }            from '../../src/visualization/help/node-field-help.js';
import { loadHelpIndex, _resetHelpIndex } from '../../src/visualization/help/help-index-source.js';
import { HelpPlugin }                    from '../../src/visualization/workbench/plugins/finance/help-plugin.js';
import { WorkbenchRuntime, WB_EVENTS }   from '../../src/visualization/workbench/workbench-runtime.js';
import { buildHelpIndex }                from '../../scripts/lib/help-index.mjs';
// Imported for its side effect as much as its value: the generator walks the toolsets
// with dynamic imports, and jest's ESM linker refuses those unless the shared
// simulation-framework graph has already been linked statically. `help-plugin.test.mjs`
// has depended on the same thing since it was written.
import '../../src/visualization/workbench/plugins/finance/finance-plugin-package.js';
import { readFileSync }                  from 'node:fs';
import { fileURLToPath }                 from 'node:url';

/**
 * The real editor templates, read straight off disk.
 *
 * Deliberately not `tests/helpers/viz-utils.js`: that helper pulls in the ECharts graph
 * renderer, and loading that module graph alongside the generator's dynamic toolset
 * imports trips jest's ESM linker. One `readFileSync` is the whole of what this file
 * needed from it.
 */
const loadHtml = () => {
  document.body.innerHTML = readFileSync(
    fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
};

let INDEX, RealPropertyEditor;
beforeAll(async () => {
  INDEX = await buildHelpIndex();
  ({ RealPropertyEditor } = await import('../../src/visualization/assets/real-property-editor.js'));
}, 120_000);

beforeEach(() => {
  loadHtml();                            // the real editor templates
  _resetHelpIndex();
  loadHelpIndex(INDEX);                  // seed the shared cache; jsdom has no fetch
});

const settle = () => new Promise(r => setTimeout(r, 0));

/** A rendered RealProperty editor, decorated, in a container attached to the document. */
async function renderProperty(opts = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  new RealPropertyEditor({ container, node: null, people: [], accounts: [] }).render();
  await decorateNodeFields(container, 'real-property', opts);
  return container;
}

/* ──────────────────────────── the decorator ──────────────────────────────── */

test('NFH-1: every described field on a real form gets the full description on hover', async () => {
  const container = await renderProperty();
  const node      = INDEX.nodes.find(n => n.kind === 'real-property');

  for (const f of node.fields) {
    const control = container.querySelector(`[data-id="${f.domId}"]`);
    assert.ok(control, `${f.field}: the form has no control — the inventory is wrong`);
    // Character for character. A panel that laid the description out while the tooltip
    // truncated it would be design 108 §2's bug with more markup on top.
    assert.equal(control.title, f.description,
      `${f.field}: the tooltip must be the description, whole`);
  }
});

test('NFH-2: the `?` publishes the field, and only where a handler was given', async () => {
  const opened = [];
  const container = await renderProperty({ onOpenHelp: (ref) => opened.push(ref) });

  const label = container.querySelector('[data-id="acquisitionDate"]')
    .closest('.node-field').querySelector('label');
  const btn = label.querySelector('.param-help-btn');
  assert.ok(btn, 'a described field gets the same ? the Parameters panel uses');

  btn.click();
  assert.deepEqual(opened, [{ node: 'real-property', field: 'acquisitionDate' }]);

  // No handler ⇒ tooltips only. The Nodes panel is usable without the workbench bus.
  const plain = await renderProperty();
  assert.equal(plain.querySelectorAll('.param-help-btn').length, 0);
});

test('NFH-3: decorating twice does not stack a second ? on the same label', async () => {
  const container = await renderProperty({ onOpenHelp: () => {} });
  const before    = container.querySelectorAll('.param-help-btn').length;
  await decorateNodeFields(container, 'real-property', { onOpenHelp: () => {} });
  assert.equal(container.querySelectorAll('.param-help-btn').length, before);
});

test('NFH-4: with no index the form renders undecorated rather than throwing', async () => {
  // A gitignored build artifact can legitimately be absent (design 108 D4), and an edit
  // form that threw because its documentation was missing would be the worse bug by far.
  _resetHelpIndex();
  const container = document.createElement('div');
  document.body.appendChild(container);
  new RealPropertyEditor({ container, node: null, people: [], accounts: [] }).render();

  const count = await decorateNodeFields(container, 'real-property', { onOpenHelp: () => {} });
  assert.equal(count, 0);
  assert.equal(container.querySelectorAll('.param-help-btn').length, 0);
  assert.equal(container.querySelector('[data-id="costBasis"]').title, '');
});

test('NFH-5: an unknown kind is a no-op, not a throw', async () => {
  const container = document.createElement('div');
  assert.equal(await decorateNodeFields(container, 'no-such-kind', {}), 0);
  assert.equal(await decorateNodeFields(null, 'real-property', {}), 0);
});

/* ───────────────────────── the panel's node views ────────────────────────── */

/** A mounted Help panel holding the real index. */
function mountPanel() {
  const runtime = new WorkbenchRuntime();
  const plugin  = new HelpPlugin(runtime, { index: INDEX });
  const host    = document.createElement('div');
  document.body.appendChild(host);
  plugin.mount(host);
  return { runtime, host, body: () => host.querySelector('[data-id="body"]'),
           crumb: () => host.querySelector('[data-id="crumb"]').textContent };
}

test('NFH-6: HELP_OPEN with a field renders that description, untruncated', async () => {
  const { runtime, body, crumb } = mountPanel();
  const field = INDEX.nodes.find(n => n.kind === 'real-property')
    .fields.find(f => f.field === 'acquisitionDate');

  runtime.bus.publish({ type: WB_EVENTS.HELP_OPEN, node: 'real-property', field: 'acquisitionDate' });
  await settle();

  assert.equal(crumb(), field.label);
  assert.ok(body().textContent.includes(field.description),
    'the whole description, which is the half a native tooltip cuts off');
});

test('NFH-7: HELP_OPEN with a kind renders the topic and every field of the form', async () => {
  const { runtime, body, crumb } = mountPanel();
  const node = INDEX.nodes.find(n => n.kind === 'real-property');

  runtime.bus.publish({ type: WB_EVENTS.HELP_OPEN, node: 'real-property' });
  await settle();

  assert.equal(crumb(), node.label);
  // The list comes from tier 1, so a control the topic has not caught up with is still
  // listed rather than quietly missing from the page.
  assert.equal(body().querySelectorAll('a[data-help-node-field]').length, node.fields.length);
});

test('NFH-8: a field page links back to its form, and the form through to a field', async () => {
  const { runtime, body, crumb } = mountPanel();

  runtime.bus.publish({ type: WB_EVENTS.HELP_OPEN, node: 'account', field: 'drawdownPriority' });
  await settle();
  body().querySelector('a[data-help-node]').click();
  await settle();
  assert.equal(crumb(), 'Accounts');

  body().querySelector('a[data-help-node-field]').click();
  await settle();
  assert.notEqual(crumb(), 'Accounts', 'a field link opens the field');
});
