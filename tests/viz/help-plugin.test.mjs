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
 * help-plugin.test.mjs
 * The in-app help panel (design 108 §8, phase 5).
 *
 * These run against the REAL index, built by the real generator, for the same reason
 * every other design-108 test does: a fixture index would be a second copy of the
 * registries, which is the failure mode (§2.1) the whole design exists to remove. The
 * cost is one `buildHelpIndex()` per file, shared across the tests.
 *
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';

import { HelpPlugin }        from '../../src/visualization/workbench/plugins/finance/help-plugin.js';
import { WorkbenchRuntime, WB_EVENTS } from '../../src/visualization/workbench/workbench-runtime.js';
import { ScenarioTabView }   from '../../src/visualization/scenario/scenario-tab-view.js';
import { buildHelpIndex }    from '../../scripts/lib/help-index.mjs';
import { FINANCE_PLUGINS, FINANCE_DEFAULT_LAYOUT }
  from '../../src/visualization/workbench/plugins/finance/finance-plugin-package.js';

let INDEX;
beforeAll(async () => { INDEX = await buildHelpIndex(); }, 120_000);

/** A mounted panel, wired to a runtime, with the real index already in hand. */
function mountPanel() {
  const runtime = new WorkbenchRuntime();
  const plugin  = new HelpPlugin(runtime, { index: INDEX });
  const host    = document.createElement('div');
  document.body.appendChild(host);
  plugin.mount(host);
  return { runtime, plugin, host, body: () => host.querySelector('[data-id="body"]'),
           crumb: () => host.querySelector('[data-id="crumb"]').textContent };
}

/** The panel paints through a resolved promise, so every assertion waits one turn. */
const settle = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => { document.body.innerHTML = ''; });

/* ─────────────────────────── following the tabs ─────────────────────────── */

test('HELP-P1: TAB_ACTIVATED renders that panel\'s topic', async () => {
  const { runtime, body, crumb } = mountPanel();

  runtime.bus.publish({ type: WB_EVENTS.TAB_ACTIVATED, tab: 'spending', pane: 'center' });
  await settle();

  const topic = INDEX.topics.find(t => t.kind === 'panel' && t.panels.includes('spending'));
  assert.ok(topic, 'the gate guarantees a panel topic for every registered panel');
  assert.equal(crumb(), topic.title);
  assert.ok(body().querySelector('.help-topic'), 'the topic body should be rendered');
  // Pre-rendered at BUILD time (D2): what arrives is HTML, not markdown to be parsed here.
  assert.ok(body().querySelectorAll('.help-topic p').length >= 2,
    'marked output should reach the DOM as elements, not as literal markdown text');
  assert.ok(!body().textContent.includes('](') , 'no unrendered markdown links');
});

test('HELP-P2: every registered panel resolves to a topic — the gate\'s promise, checked in the UI', async () => {
  const { runtime, body } = mountPanel();

  for (const p of FINANCE_PLUGINS) {
    runtime.bus.publish({ type: WB_EVENTS.TAB_ACTIVATED, tab: p.id, pane: 'left' });
    await settle();
    assert.ok(body().querySelector('.help-topic'),
      `panel "${p.id}" should render a topic, not the fallback`);
  }
});

test('HELP-P3: a tab with no topic renders the fallback, not a throw', async () => {
  const { runtime, body } = mountPanel();

  // A panel the registry has never heard of — the state a new plugin is in between the
  // commit that adds it and the commit that writes its topic.
  runtime.bus.publish({ type: WB_EVENTS.TAB_ACTIVATED, tab: 'not-a-panel', pane: 'left' });
  await settle();

  assert.ok(body().querySelector('.help-empty'), 'should say there is nothing, plainly');
  assert.ok(body().textContent.includes('not-a-panel'));
});

test('HELP-P4: activating Help itself does not clobber what Help was asked to show', async () => {
  const { runtime, body, crumb } = mountPanel();

  runtime.bus.publish({ type: WB_EVENTS.HELP_OPEN, param: 'inflationRate' });
  await settle();
  const asked = crumb();

  // This is the event the `?` affordance's own activatePlugin('help') fires.
  runtime.bus.publish({ type: WB_EVENTS.TAB_ACTIVATED, tab: 'help', pane: 'right' });
  await settle();

  assert.equal(crumb(), asked, 'the param must survive the panel being brought to front');
  assert.ok(body().querySelector('.help-param-desc'));
});

/* ───────────────────────────── the ? affordance ──────────────────────────── */

test('HELP-P5: the ? renders the LONGEST description in the schema, in full', async () => {
  const longest = [...INDEX.params].sort((a, b) => b.description.length - a.description.length)[0];
  assert.ok(longest.description.length > 1000, 'the schema really does carry one this long');

  const { runtime, body } = mountPanel();
  runtime.bus.publish({ type: WB_EVENTS.HELP_OPEN, param: longest.key });
  await settle();

  const desc = body().querySelector('.help-param-desc');
  assert.ok(desc, 'a param card should be rendered');
  // Character for character: the tooltip this replaces truncated, and a panel that also
  // truncated would be the same bug with more markup.
  assert.equal(desc.textContent.replace(/\s+/g, ' ').trim(),
    longest.description.replace(/\s+/g, ' ').trim());
});

test('HELP-P6: the param card carries the tier-1 facts a tooltip cannot', async () => {
  const p = INDEX.params.find(x => x.mc && x.opt && x.description);
  const { runtime, body } = mountPanel();
  runtime.bus.publish({ type: WB_EVENTS.HELP_OPEN, param: p.key });
  await settle();

  const facts = body().querySelector('.help-facts').textContent;
  assert.ok(facts.includes('Monte Carlo') && facts.includes('optimizer'), 'sweepability');
  assert.ok(facts.includes(p.contributedBy), 'the owning toolset');
  assert.ok(body().textContent.includes(p.key), 'the key itself');
});

test('HELP-P7: ScenarioTabView renders a ? per param and per group, and only when wired', () => {
  document.body.innerHTML = '<div id="paramsList"></div>';
  const scenario = { params: [
    { name: 'inflationRate', label: 'Inflation', type: 'Number', value: 0.03, group: 'Economic Shocks' },
  ] };

  // Not wired: no affordance at all. A `?` that opens nothing is worse than no `?`.
  const bare = new ScenarioTabView();
  bare._renderParamsList(scenario);
  assert.equal(document.querySelectorAll('.param-help-btn').length, 0);

  const seen = [];
  const view = new ScenarioTabView();
  view.onOpenHelp = (ref) => seen.push(ref);
  view._expandedGroups.add('Economic Shocks');
  view._renderParamsList(scenario);

  const paramBtn = document.querySelector('.param-row .param-help-btn');
  const groupBtn = document.querySelector('.param-group-header .param-help-btn');
  assert.ok(paramBtn, 'the param label should carry a ?');
  assert.ok(groupBtn, 'the group header should carry a ?');

  paramBtn.click();
  groupBtn.click();
  assert.deepEqual(seen, [{ param: 'inflationRate' }, { group: 'Economic Shocks' }]);
});

test('HELP-P8: the group ? does not also fold the group it was asked about', () => {
  document.body.innerHTML = '<div id="paramsList"></div>';
  const view = new ScenarioTabView();
  view.onOpenHelp = () => {};
  view._expandedGroups.add('Spending');
  view._renderParamsList({ params: [
    { name: 'spendingFloor', label: 'Floor', type: 'Number', value: 1, group: 'Spending' },
  ] });

  document.querySelector('.param-group-header .param-help-btn').click();
  assert.ok(view._expandedGroups.has('Spending'), 'the header click must not have fired');
});

/* ───────────────────────────── navigation ────────────────────────────────── */

test('HELP-P9: a param card links to the topics that explain it, and Back returns', async () => {
  const cited = INDEX.topics.find(t => t.kind === 'concept' && t.params.length);
  const key   = cited.params[0];

  const { runtime, host, body, crumb } = mountPanel();
  runtime.bus.publish({ type: WB_EVENTS.HELP_OPEN, param: key });
  await settle();
  const paramCrumb = crumb();

  const link = body().querySelector(`a[data-help-topic="${cited.id}"]`);
  assert.ok(link, 'the card should name the topic that explains the param');

  link.click();
  await settle();
  assert.equal(crumb(), cited.title);

  const back = host.querySelector('.help-back');
  assert.equal(back.disabled, false);
  back.click();
  assert.equal(crumb(), paramCrumb, 'back returns to the param');
});

test('HELP-P10: a relative *.md link between topics navigates in place', async () => {
  const { runtime, body, crumb } = mountPanel();
  runtime.bus.publish({ type: WB_EVENTS.TAB_ACTIVATED, tab: 'spending', pane: 'center' });
  await settle();

  const link = body().querySelector('.help-topic a[href$=".md"]');
  assert.ok(link, 'the topics do link to each other');
  const target = INDEX.topics.find(t => t.id === link.getAttribute('href').split('/').pop().replace(/\.md$/, ''));
  assert.ok(target, 'every authored link should resolve — ids match filenames');

  link.click();
  await settle();
  assert.equal(crumb(), target.title);
});

test('HELP-P11: following a tab does not push history — Back is for reading, not for tabs', async () => {
  const { runtime, host } = mountPanel();

  runtime.bus.publish({ type: WB_EVENTS.TAB_ACTIVATED, tab: 'spending',   pane: 'center' });
  await settle();
  runtime.bus.publish({ type: WB_EVENTS.TAB_ACTIVATED, tab: 'allocation', pane: 'center' });
  await settle();

  assert.equal(host.querySelector('.help-back').disabled, true);
});

test('HELP-P12: the group ? lists the group\'s params and the topics behind them', async () => {
  const group = 'Economic Shocks';
  const { runtime, body } = mountPanel();
  runtime.bus.publish({ type: WB_EVENTS.HELP_OPEN, group });
  await settle();

  const links = body().querySelectorAll('.help-param-list a[data-help-param]');
  assert.equal(links.length, INDEX.params.filter(p => p.group === group).length);
  // Q4 settled per-MECHANIC: this group is five of them, and they are reached through
  // what the topics cite rather than through a group→topic table nobody maintains.
  assert.ok(body().querySelectorAll('a[data-help-topic]').length > 1);
});

/* ───────────────────────────── the missing index ─────────────────────────── */

test('HELP-P13: with no index the panel says how to build one, rather than looking broken', async () => {
  const runtime = new WorkbenchRuntime();
  const plugin  = new HelpPlugin(runtime, { index: { topics: [], params: [], panels: [] } });
  plugin._index = null;
  plugin._loading = Promise.resolve(null);      // a fetch that found nothing

  const host = document.createElement('div');
  document.body.appendChild(host);
  plugin.mount(host);
  await settle();

  assert.match(host.querySelector('[data-id="body"]').textContent, /help:build/);
});

/* ───────────────────────────── registration ──────────────────────────────── */

test('HELP-P14: the panel is registered and opens by default', () => {
  const help = FINANCE_PLUGINS.find(p => p.id === 'help');
  assert.ok(help, 'help must be a registered plugin');
  assert.equal(help.component, HelpPlugin);
  assert.ok(FINANCE_DEFAULT_LAYOUT.right.tabs.includes('help'),
    'a help panel nobody can find is the tooltip problem again');
});
