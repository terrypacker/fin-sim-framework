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

function makeContainer({ scrollHeight = 400, scrollTop = 320, clientHeight = 100 } = {}) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  el.scrollTop = scrollTop;
  return el;
}

function makeEntry({
  date       = new Date(2025, 0, 1),
  eventType  = 'TEST_EVENT',
  actionType = 'TEST_ACTION',
  reducer    = { name: 'Test Reducer' },
} = {}) {
  return { date, eventType, action: { type: actionType }, reducer };
}

function makeView(containerOpts = {}) {
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
    if (!byEv.has(entry.eventType)) byEv.set(entry.eventType, []);
    byEv.get(entry.eventType).push({ entry, idx, sum: '' });
  });
  return map;
}

const emptyOptions = { events: [], actions: [] };

function renderView(view, { entries = [], expanded = new Set(), filterEvent = '', filterAction = '', hasRewind = false } = {}) {
  const groups = makeGroups(entries);
  view.render({ groups, options: emptyOptions, filterEvent, filterAction, expanded, hasRewind });
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
  assert.strictEqual(view.onFilterEvent,  null);
  assert.strictEqual(view.onFilterAction, null);
  assert.strictEqual(view.onClearFilters, null);
  assert.strictEqual(view.onToggle,       null);
  assert.strictEqual(view.onDetail,       null);
  assert.strictEqual(view.onRewind,       null);
});

test('TimelineView: _uid increments across instances', () => {
  const a = makeView();
  const b = makeView();
  assert.ok(b._uid > a._uid, '_uid should increase for each new instance');
});

// ─── render: DOM structure ────────────────────────────────────────────────────

test('TimelineView.render: creates filter bar and list elements', () => {
  const view = makeView();
  renderView(view);
  assert.ok(view._filterBarEl !== null, '_filterBarEl should be set after render');
  assert.ok(view._listEl      !== null, '_listEl should be set after render');
});

test('TimelineView.render: does not recreate DOM on second call (_ensureStructure guard)', () => {
  const view = makeView();
  renderView(view);
  const firstListEl = view._listEl;
  renderView(view);
  assert.strictEqual(view._listEl, firstListEl, '_listEl should be the same element');
});

test('TimelineView.render: empty groups shows empty-state element', () => {
  const view = makeView();
  renderView(view, { entries: [] });
  assert.ok(view.container.innerHTML.includes('tl-empty'),
    'should render tl-empty for an empty groups map');
});

test('TimelineView.render: empty groups with no filter shows "step forward" message', () => {
  const view = makeView();
  renderView(view, { entries: [] });
  assert.ok(view.container.innerHTML.includes('Step the simulation forward'));
});

test('TimelineView.render: empty groups with active filter shows "no match" message', () => {
  const view = makeView();
  renderView(view, { entries: [], filterEvent: 'SELL' });
  assert.ok(view.container.innerHTML.includes('No entries match'));
});

test('TimelineView.render: non-empty groups sets a non-empty innerHTML', () => {
  const view = makeView();
  renderView(view, { entries: [makeEntry({ date: new Date(2025, 0, 1) })] });
  assert.ok(view.container.innerHTML.length > 0);
  assert.ok(!view.container.innerHTML.includes('tl-empty'));
});

test('TimelineView.render: date header includes the date string', () => {
  const view = makeView();
  const d    = new Date(2025, 0, 1);
  renderView(view, { entries: [makeEntry({ date: d })] });
  assert.ok(view.container.innerHTML.includes(d.toDateString()));
});

// ─── render: badge counts ─────────────────────────────────────────────────────

test('TimelineView.render: badge shows correct event and action counts', () => {
  const view = makeView();
  const d    = new Date(2025, 0, 1);
  renderView(view, {
    entries: [
      makeEntry({ date: d, eventType: 'SELL_ASSET',     actionType: 'REALIZE_GAIN'  }),
      makeEntry({ date: d, eventType: 'MONTHLY_SALARY', actionType: 'SALARY_CREDIT' }),
    ],
  });
  assert.ok(view.container.innerHTML.includes('2 events'),  'badge should say "2 events"');
  assert.ok(view.container.innerHTML.includes('2 actions'), 'badge should say "2 actions"');
});

// ─── render: expand/collapse ──────────────────────────────────────────────────

test('TimelineView.render: collapsed date group does not show event rows', () => {
  const view = makeView();
  const d    = new Date(2025, 0, 1);
  renderView(view, {
    entries:  [makeEntry({ date: d, eventType: 'SELL_ASSET' })],
    expanded: new Set(), // collapsed
  });
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
  const evKey   = `${dateKey}::SELL_ASSET`;
  renderView(view, {
    entries:  [makeEntry({ date: d, eventType: 'SELL_ASSET', actionType: 'REALIZE_GAIN' })],
    expanded: new Set([dateKey, evKey]),
  });
  assert.ok(view.container.innerHTML.includes('REALIZE_GAIN'));
  assert.ok(view.container.innerHTML.includes('tl-det'));
});

test('TimelineView.render: right-pointing chevron for collapsed group', () => {
  const view = makeView();
  renderView(view, { entries: [makeEntry({ date: new Date(2025, 0, 1) })], expanded: new Set() });
  assert.ok(view.container.innerHTML.includes('▶'));
});

test('TimelineView.render: down-pointing chevron for expanded group', () => {
  const view = makeView();
  const d    = new Date(2025, 0, 1);
  renderView(view, {
    entries:  [makeEntry({ date: d })],
    expanded: new Set([d.toDateString()]),
  });
  assert.ok(view.container.innerHTML.includes('▼'));
});

// ─── render: scroll behaviour ─────────────────────────────────────────────────

test('TimelineView.render: scrolls to bottom when already near the bottom', () => {
  // scrollHeight=400, scrollTop=320, clientHeight=100 → 400-320-100=-20 < 80 → atBottom=true
  const view = makeView({ scrollHeight: 400, scrollTop: 320, clientHeight: 100 });
  renderView(view, { entries: [makeEntry()] });
  assert.strictEqual(view.container.scrollTop, view.container.scrollHeight);
});

test('TimelineView.render: does not scroll when not near the bottom', () => {
  // scrollHeight=500, scrollTop=0, clientHeight=100 → 500-0-100=400 ≥ 80 → atBottom=false
  const view = makeView({ scrollHeight: 500, scrollTop: 0, clientHeight: 100 });
  renderView(view, { entries: [makeEntry()] });
  assert.strictEqual(view.container.scrollTop, 0);
});

// ─── render: rewind button ────────────────────────────────────────────────────

test('TimelineView.render: rewind button not present when hasRewind is false', () => {
  const view = makeView();
  renderView(view, { entries: [makeEntry()], hasRewind: false });
  assert.ok(!view.container.innerHTML.includes('tl-rewind'));
});

test('TimelineView.render: rewind button present when hasRewind is true', () => {
  const view = makeView();
  renderView(view, { entries: [makeEntry()], hasRewind: true });
  assert.ok(view.container.innerHTML.includes('tl-rewind'));
});
