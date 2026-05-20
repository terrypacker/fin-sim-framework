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

import { TimelineView } from '../../../src/visualization/timeline/timeline-view.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFilterTemplate() {
  //Setup Template
  const timelineFilterTemplate = document.createElement('template');
  timelineFilterTemplate.id = 'tpl-timeline-filter-bar';
  timelineFilterTemplate.innerHTML = `<div class = "tl-filter-bar">
    <div class="tl-filter-group">
      <label class="tl-filter-label" for="tl-ev-select">Event</label>
      <div class="reducer-chip-grid" id="tl-ev-select"></div>
    </div>
    <div class="tl-filter-group">
      <label class="tl-filter-label" for="tl-act-select">Action</label>
      <div class="reducer-chip-grid" id="tl-act-select"></div>
    </div>
    <div class="tl-filter-group">
      <label class="tl-filter-label" for="tl-date-start">From</label>
      <input class="tl-filter-date" type="date" id="tl-date-start">
    </div>
    <div class="tl-filter-group">
      <label class="tl-filter-label" for="tl-date-end">To</label>
      <input class="tl-filter-date" type="date" id="tl-date-end">
    </div>
    <button class="btn btn-sm"    id="tl-filter-clear"    title="Clear all filters">✕</button>
    <button class="btn btn-sm"   id="tl-download-csv"   title="Download visible rows as CSV">⬇ CSV</button>
  </div>`;
  document.body.appendChild(timelineFilterTemplate);
}

function makeContainer({ scrollHeight = 400, scrollTop = 320, clientHeight = 100 } = {}) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  el.scrollTop = scrollTop;
  return el;
}

let _seq = 0;
function makeEntry({
  date       = new Date(2025, 0, 1),
  eventType  = 'TEST_EVENT',
  actionType = 'TEST_ACTION',
  reducer    = { name: 'Test Reducer' },
} = {}) {
  const seq = _seq++;
  return {
    seq,
    date,
    executionId: null,
    event:  { nodeId: null, type: eventType,  name: eventType,  color: null },
    action: { instanceId: `inst-${seq}`, parentId: null, rootId: null, siblingIndex: 0, nodeId: null, type: actionType, name: actionType, data: {} },
    reducer,
    stateDiff:          [],
    emittedInstanceIds: [],
    emittedTypes:       [],
  };
}

function makeView(containerOpts = {}) {
  makeFilterTemplate();
  const container = makeContainer(containerOpts);
  return new TimelineView({ container });
}

// Builds the groups Map that would normally come from TimelineController.groups()
function makeGroups(entries, formatDate = d => d.toDateString()) {
  const map = new Map();
  entries.forEach((entry, idx) => {
    const d = formatDate(entry.date);
    if (!map.has(d)) map.set(d, new Map());
    const byEv = map.get(d);
    if (!byEv.has(entry.event.type)) byEv.set(entry.event.type, []);
    byEv.get(entry.event.type).push({ entry, idx, sum: '' });
  });
  return map;
}

const emptyOptions = { events: [], actions: [] };

// Builds the causalGroups Map (rootNode[]) from the TimelineController.causalGroups() shape
function makeCausalGroups(entries, formatDate = d => d.toDateString()) {
  const byId  = new Map();
  const roots = new Map();
  entries.forEach(entry => byId.set(entry.action.instanceId, { entry, children: [] }));
  for (const [, node] of byId) {
    const { entry } = node;
    const parentNode = entry.action.parentId ? byId.get(entry.action.parentId) : null;
    if (parentNode) {
      parentNode.children.push(node);
    } else {
      const d = formatDate(entry.date);
      if (!roots.has(d)) roots.set(d, new Map());
      const byEv = roots.get(d);
      if (!byEv.has(entry.event.type)) byEv.set(entry.event.type, []);
      byEv.get(entry.event.type).push(node);
    }
  }
  return roots;
}

function renderView(view, {
  entries        = [],
  expanded       = new Set(),
  filterEvents   = new Set(),
  filterActions  = new Set(),
  filterDateStart = null,
  filterDateEnd   = null,
  hasRewind      = false,
} = {}) {
  const groups      = makeGroups(entries);
  const causalGroups = makeCausalGroups(entries);
  view.render({ groups, causalGroups, options: emptyOptions, filterEvents, filterActions, filterDateStart, filterDateEnd, expanded, hasRewind });
}

// ─── Constructor ──────────────────────────────────────────────────────────────

test('TimelineView: constructor sets container', () => {
  const container = makeContainer();
  const view = new TimelineView({ container });
  assert.strictEqual(view.container, container);
});

test('TimelineView: constructor initialises _listEl to null', () => {
  assert.strictEqual(makeView()._listEl, null);
});

test('TimelineView: constructor initialises _filterBarEl to null', () => {
  assert.strictEqual(makeView()._filterBarEl, null);
});

test('TimelineView: constructor initialises all callbacks to null', () => {
  const view = makeView();
  assert.strictEqual(view.onFilterEvents,    null);
  assert.strictEqual(view.onFilterActions,   null);
  assert.strictEqual(view.onFilterDateStart, null);
  assert.strictEqual(view.onFilterDateEnd,   null);
  assert.strictEqual(view.onClearFilters,    null);
  assert.strictEqual(view.onToggle,          null);
  assert.strictEqual(view.onDetail,          null);
  assert.strictEqual(view.onRewind,          null);
});

// ─── render: DOM structure ────────────────────────────────────────────────────

test('TimelineView.render: creates filter bar and list elements', () => {
  const view = makeView();
  renderView(view);
  assert.ok(view._filterBarEl !== null, '_filterBarEl should be set after render');
  assert.ok(view._listEl      !== null, '_listEl should be set after render');
});

test('TimelineView.render: does not recreate DOM on second call', () => {
  const view = makeView();
  renderView(view);
  const firstListEl = view._listEl;
  renderView(view);
  assert.strictEqual(view._listEl, firstListEl, '_listEl should be the same element');
});

test('TimelineView.render: filter bar contains multi-select for events and actions', () => {
  const view = makeView();
  renderView(view);
  assert.ok(view._filterBarEl.querySelector(`#tl-ev-select`)  !== null, 'event select should exist');
  assert.ok(view._filterBarEl.querySelector(`#tl-act-select`) !== null, 'action select should exist');
});

test('TimelineView.render: filter bar contains date range inputs', () => {
  const view = makeView();
  renderView(view);
  assert.ok(view._filterBarEl.querySelector(`#tl-date-start`) !== null, 'start date input should exist');
  assert.ok(view._filterBarEl.querySelector(`#tl-date-end`)   !== null, 'end date input should exist');
});

// ─── render: filter bar options ───────────────────────────────────────────────

// Available event/action options are now managed by the presenter (not the view).
// See timeline-presenter.test.mjs for option-population coverage.

/** I'm not sure we want this to happen, it breaks the UI?
test('TimelineView.render: previously selected event options are marked selected', () => {
  const view = makeView();
  const groups = makeGroups([makeEntry({ eventType: 'SELL_ASSET' })]);
  view.render({
    groups,
    options:         { events: [{id: 'SALARY', name: 'SALARY'}, {id: 'SELL_ASSET', name: 'SELL_ASSET'}], actions: [] },
    filterEvents:    new Set([{id: 'SELL_ASSET', name: 'SELL_ASSET'}]),
    filterActions:   new Set(),
    filterDateStart: null,
    filterDateEnd:   null,
    expanded:        new Set(),
    hasRewind:       false,
  });
  const selected = [...view._eventSelectFilter._selectedMap.values()].map(o => o.name);
  assert.ok(selected.includes('SELL_ASSET'), 'SELL_ASSET should be selected');
  assert.ok(!selected.includes('SALARY'),    'SALARY should not be selected');
});
*/

test('TimelineView.render: date inputs reflect filterDateStart and filterDateEnd', () => {
  const view = makeView();
  const start = new Date(2025, 0, 15);  // Jan 15
  const end   = new Date(2025, 5, 30);  // Jun 30
  view.render({
    groups:          new Map(),
    options:         emptyOptions,
    filterEvents:    new Set(),
    filterActions:   new Set(),
    filterDateStart: start,
    filterDateEnd:   end,
    expanded:        new Set(),
    hasRewind:       false,
  });
  const startIn  = view._filterBarEl.querySelector(`#tl-date-start`);
  const endIn    = view._filterBarEl.querySelector(`#tl-date-end`);
  assert.strictEqual(startIn.value, '2025-01-15');
  assert.strictEqual(endIn.value,   '2025-06-30');
});

test('TimelineView.render: clear button hidden when no filters are active', () => {
  const view = makeView();
  renderView(view, { filterEvents: new Set(), filterActions: new Set() });
  const clearBtn = view._filterBarEl.querySelector(`#tl-filter-clear`);
  assert.strictEqual(clearBtn.style.display, 'none');
});

test('TimelineView.render: clear button visible when event filter is active', () => {
  const view = makeView();
  renderView(view, { filterEvents: new Set(['SELL_ASSET']) });
  const clearBtn = view._filterBarEl.querySelector(`#tl-filter-clear`);
  assert.notStrictEqual(clearBtn.style.display, 'none');
});

test('TimelineView.render: clear button visible when date filter is active', () => {
  const view = makeView();
  renderView(view, { filterDateStart: new Date(2025, 0, 1) });
  const clearBtn = view._filterBarEl.querySelector(`#tl-filter-clear`);
  assert.notStrictEqual(clearBtn.style.display, 'none');
});

// ─── render: empty state ──────────────────────────────────────────────────────

test('TimelineView.render: empty groups with no filter shows "step forward" message', () => {
  const view = makeView();
  renderView(view, { entries: [] });
  assert.ok(view.container.innerHTML.includes('Step the simulation forward'));
});

test('TimelineView.render: empty groups with active event filter shows "no match" message', () => {
  const view = makeView();
  renderView(view, { entries: [], filterEvents: new Set(['SELL']) });
  assert.ok(view.container.innerHTML.includes('No entries match'));
});

test('TimelineView.render: empty groups with active date filter shows "no match" message', () => {
  const view = makeView();
  renderView(view, { entries: [], filterDateStart: new Date(2025, 0, 1) });
  assert.ok(view.container.innerHTML.includes('No entries match'));
});

// ─── render: list content ─────────────────────────────────────────────────────

test('TimelineView.render: non-empty groups renders date header', () => {
  const view = makeView();
  const d    = new Date(2025, 0, 1);
  renderView(view, { entries: [makeEntry({ date: d })] });
  assert.ok(view.container.innerHTML.includes(d.toDateString()));
  assert.ok(!view.container.innerHTML.includes('tl-empty'));
});

test('TimelineView.render: badge shows correct event and action counts', () => {
  const view = makeView();
  const d    = new Date(2025, 0, 1);
  renderView(view, {
    entries: [
      makeEntry({ date: d, eventType: 'SELL_ASSET',     actionType: 'REALIZE_GAIN'  }),
      makeEntry({ date: d, eventType: 'MONTHLY_SALARY', actionType: 'SALARY_CREDIT' }),
    ],
  });
  assert.ok(view.container.innerHTML.includes('2 events'));
  assert.ok(view.container.innerHTML.includes('2 actions'));
});

test('TimelineView.render: collapsed date group does not show event rows', () => {
  const view = makeView();
  renderView(view, { entries: [makeEntry()], expanded: new Set() });
  assert.ok(!view.container.innerHTML.includes('tl-ev-hdr'));
});

test('TimelineView.render: expanded date group shows event rows', () => {
  const view = makeView();
  const d    = new Date(2025, 0, 1);
  renderView(view, {
    entries:  [makeEntry({ date: d, eventType: 'SELL_ASSET' })],
    expanded: new Set([d.toDateString()]),
  });
  assert.ok(view.container.innerHTML.includes('tl-ev-hdr'));
  assert.ok(view.container.innerHTML.includes('SELL_ASSET'));
});

test('TimelineView.render: expanded event group shows action rows with detail button', () => {
  const view    = makeView();
  const d       = new Date(2025, 0, 1);
  const dateKey = d.toDateString();
  renderView(view, {
    entries:  [makeEntry({ date: d, eventType: 'SELL_ASSET', actionType: 'REALIZE_GAIN' })],
    expanded: new Set([dateKey, `${dateKey}::SELL_ASSET`]),
  });
  assert.ok(view.container.innerHTML.includes('REALIZE_GAIN'));
  assert.ok(view.container.innerHTML.includes('tl-det'));
});

test('TimelineView.render: event color from entry.event.color is applied to event type label', () => {
  const view  = makeView();
  const d     = new Date(2025, 0, 1);
  const entry = makeEntry({ date: d, eventType: 'SELL_ASSET' });
  entry.event.color = '#ff0000';
  renderView(view, {
    entries:  [entry],
    expanded: new Set([d.toDateString()]),
  });
  assert.ok(view.container.innerHTML.includes('color:#ff0000'), 'event color should appear in style attribute');
});

test('TimelineView.render: no inline color style when entry.event.color is null', () => {
  const view  = makeView();
  const d     = new Date(2025, 0, 1);
  const entry = makeEntry({ date: d, eventType: 'SELL_ASSET' });
  // color is null by default in makeEntry
  renderView(view, {
    entries:  [entry],
    expanded: new Set([d.toDateString()]),
  });
  assert.ok(!view.container.innerHTML.includes('tl-ev-type" style'), 'no inline style when color is null');
});

test('TimelineView.render: right-pointing chevron for collapsed group', () => {
  const view = makeView();
  renderView(view, { entries: [makeEntry()], expanded: new Set() });
  assert.ok(view.container.innerHTML.includes('▶'));
});

test('TimelineView.render: down-pointing chevron for expanded group', () => {
  const view = makeView();
  const d    = new Date(2025, 0, 1);
  renderView(view, { entries: [makeEntry({ date: d })], expanded: new Set([d.toDateString()]) });
  assert.ok(view.container.innerHTML.includes('▼'));
});

// ─── render: scroll behaviour ─────────────────────────────────────────────────

test('TimelineView.render: does not scroll when not near the bottom', () => {
  // scrollHeight=500, scrollTop=0, clientHeight=100 → 500-0-100=400 ≥ 80 → atBottom=false
  const view = makeView({ scrollHeight: 500, scrollTop: 0, clientHeight: 100 });
  renderView(view, { entries: [makeEntry()] });
  assert.strictEqual(view.container.scrollTop, 0);
});

// ─── render: rewind button ────────────────────────────────────────────────────

test('TimelineView.render: rewind button absent when hasRewind is false', () => {
  const view = makeView();
  renderView(view, { entries: [makeEntry()], hasRewind: false });
  assert.ok(!view.container.innerHTML.includes('tl-rewind'));
});

test('TimelineView.render: rewind button present when hasRewind is true', () => {
  const view = makeView();
  renderView(view, { entries: [makeEntry()], hasRewind: true });
  assert.ok(view.container.innerHTML.includes('tl-rewind'));
});

// ─── render: CSV download button ──────────────────────────────────────────────

test('TimelineView: onDownloadCsv callback initialises to null', () => {
  assert.strictEqual(makeView().onDownloadCsv, null);
});

test('TimelineView.render: CSV download button is present in the filter bar', () => {
  const view = makeView();
  renderView(view);
  assert.ok(
    view._filterBarEl.querySelector(`#tl-download-csv`) !== null,
    'download CSV button should exist in the filter bar',
  );
});

test('TimelineView: clicking download CSV button fires onDownloadCsv', () => {
  let called = false;
  const view = makeView();
  renderView(view);
  view.onDownloadCsv = () => { called = true; };
  const csvBtn = view._filterBarEl.querySelector(`#tl-download-csv`);
  csvBtn.click();
  assert.ok(called, 'onDownloadCsv should be called when the button is clicked');
});

// ─── render: virtual scroll spacers (not inline padding) ─────────────────────

test('TimelineView._virtualRender: does not set inline paddingTop or paddingBottom', () => {
  // 20 collapsed date groups → totalH=720px, viewport fallback=400px → spacers are needed.
  // With border-box sizing, setting paddingTop+paddingBottom > element height forces the
  // element to expand beyond its flex allocation and triggers a second scrollbar in the
  // parent. The fix uses spacer divs instead of inline padding.
  const entries = [];
  for (let i = 0; i < 20; i++) {
    entries.push(makeEntry({ date: new Date(2025, 0, i + 1) }));
  }
  const view = makeView();
  renderView(view, { entries });
  assert.strictEqual(view._listEl.style.paddingTop,    '', 'paddingTop must not be set inline');
  assert.strictEqual(view._listEl.style.paddingBottom, '', 'paddingBottom must not be set inline');
});

test('TimelineView._virtualRender: bottom spacer div present when content exceeds viewport', () => {
  const entries = [];
  for (let i = 0; i < 20; i++) {
    entries.push(makeEntry({ date: new Date(2025, 0, i + 1) }));
  }
  const view = makeView();
  renderView(view, { entries });
  // Viewport fallback=400px; 20 groups × 36px = 720px total; groups past the visible
  // window are represented by a trailing spacer div rather than paddingBottom.
  const listChildren = [...view._listEl.children];
  const lastChild = listChildren[listChildren.length - 1];
  assert.ok(
    lastChild && lastChild.getAttribute('aria-hidden') === 'true' && parseInt(lastChild.style.height, 10) > 0,
    'last child should be a bottom spacer div with a positive height',
  );
});

// ─── Mode toggle ──────────────────────────────────────────────────────────────

test('TimelineView: mode toggle button is present after first render', () => {
  const view = makeView();
  renderView(view);
  assert.ok(view._filterBarEl.querySelector('#tl-mode-toggle') !== null);
});

test('TimelineView: mode toggle button starts with label "Tree"', () => {
  const view = makeView();
  renderView(view);
  const btn = view._filterBarEl.querySelector('#tl-mode-toggle');
  assert.equal(btn.textContent, 'Tree');
});

test('TimelineView: clicking mode toggle switches label to "Timeline"', () => {
  const view = makeView();
  renderView(view);
  const btn = view._filterBarEl.querySelector('#tl-mode-toggle');
  btn.click();
  assert.equal(btn.textContent, 'Timeline');
});

test('TimelineView: clicking mode toggle fires onToggle with null', () => {
  let received = 'NOT_CALLED';
  const view = makeView();
  renderView(view);
  view.onToggle = key => { received = key; };
  view._filterBarEl.querySelector('#tl-mode-toggle').click();
  assert.equal(received, null);
});

test('TimelineView: clicking mode toggle a second time switches label back to "Tree"', () => {
  const view = makeView();
  renderView(view);
  const btn = view._filterBarEl.querySelector('#tl-mode-toggle');
  btn.click();
  btn.click();
  assert.equal(btn.textContent, 'Tree');
});

// ─── Tree mode rendering ──────────────────────────────────────────────────────

test('TimelineView: tree mode renders action rows with tl-act--tree class', () => {
  const view   = makeView();
  const entry  = makeEntry();
  const groups = makeGroups([entry]);
  const causalGroups = makeCausalGroups([entry]);
  const expanded = new Set([entry.date.toDateString(), `${entry.date.toDateString()}::${entry.event.type}`]);
  // Switch to tree mode before render
  view._treeMode = true;
  view.render({ groups, causalGroups, filterEvents: new Set(), filterActions: new Set(), filterDateStart: null, filterDateEnd: null, expanded, hasRewind: false });
  assert.ok(view._listEl.querySelector('.tl-act--tree') !== null, 'tree node should have tl-act--tree class');
});

test('TimelineView: tree mode renders child nodes with increased padding-left', () => {
  const view   = makeView();
  const parent = makeEntry();
  const child  = makeEntry();
  child.action.parentId = parent.action.instanceId;
  const causalGroups = makeCausalGroups([parent, child]);
  const groups       = makeGroups([parent, child]);
  const dateStr      = parent.date.toDateString();
  const expanded     = new Set([dateStr, `${dateStr}::${parent.event.type}`]);
  view._treeMode = true;
  view.render({ groups, causalGroups, filterEvents: new Set(), filterActions: new Set(), filterDateStart: null, filterDateEnd: null, expanded, hasRewind: false });
  const treeNodes = view._listEl.querySelectorAll('.tl-act--tree');
  assert.equal(treeNodes.length, 2, 'parent and child both rendered');
  const parentPad = parseInt(treeNodes[0].style.paddingLeft, 10);
  const childPad  = parseInt(treeNodes[1].style.paddingLeft, 10);
  assert.ok(childPad > parentPad, 'child should have greater padding-left than parent');
});

// ─── onNavigateToNode ─────────────────────────────────────────────────────────

test('TimelineView: clicking cfg-link button fires onNavigateToNode with nodeId', () => {
  let received = null;
  const view  = makeView();
  const entry = makeEntry();
  entry.action.nodeId = 'node-abc';
  const groups   = makeGroups([entry]);
  const causalGroups = makeCausalGroups([entry]);
  const dateStr  = entry.date.toDateString();
  const expanded = new Set([dateStr, `${dateStr}::${entry.event.type}`]);
  view.onNavigateToNode = id => { received = id; };
  view.render({ groups, causalGroups, filterEvents: new Set(), filterActions: new Set(), filterDateStart: null, filterDateEnd: null, expanded, hasRewind: false });
  const cfgBtn = view._listEl.querySelector('.tl-cfg-link');
  assert.ok(cfgBtn !== null, 'cfg-link button should be present when nodeId is set');
  cfgBtn.click();
  assert.equal(received, 'node-abc');
});
