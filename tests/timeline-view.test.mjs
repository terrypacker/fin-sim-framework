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
 * timeline-view.test.mjs
 * Tests for TimelineView
 * Run with: node --test tests/timeline-view.test.mjs
 */

import assert from 'node:assert/strict';

import { TimelineView } from '../src/visualization/timeline-view.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Returns a real DOM div with mocked scroll geometry so the jsdom environment
// supplies document.createElement / appendChild / querySelector while tests
// retain full control over scrollHeight / scrollTop / clientHeight.
function makeContainer({ scrollHeight = 400, scrollTop = 320, clientHeight = 100 } = {}) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  el.scrollTop = scrollTop;
  return el;
}

function makeEntry({
  date      = new Date(2025, 0, 1),
  eventType = 'TEST_EVENT',
  actionType = 'TEST_ACTION',
  reducer   = 'Test Reducer'
} = {}) {
  return { date, eventType, action: { type: actionType }, reducer };
}

function makeJournal(entries = []) {
  return { journal: entries };
}

function makeView(containerOpts = {}) {
  const container = makeContainer(containerOpts);
  const view = new TimelineView({ container, onDetail: () => {} });
  view.container = container;   // expose for assertions
  return view;
}

// ─── Constructor ──────────────────────────────────────────────────────────────

test('TimelineView: constructor initialises journal to null', () => {
  assert.strictEqual(makeView().journal, null);
});

test('TimelineView: constructor initialises expanded to an empty Set', () => {
  const view = makeView();
  assert.ok(view.expanded instanceof Set);
  assert.strictEqual(view.expanded.size, 0);
});

test('TimelineView: constructor sets _lastLen to 0', () => {
  assert.strictEqual(makeView()._lastLen, 0);
});

test('TimelineView: constructor sets _lastDate to null', () => {
  assert.strictEqual(makeView()._lastDate, null);
});

// ─── attach ───────────────────────────────────────────────────────────────────

test('TimelineView.attach: sets the journal reference', () => {
  const view    = makeView();
  const journal = makeJournal();
  view.attach(journal);
  assert.strictEqual(view.journal, journal);
});

test('TimelineView.attach: resets _lastLen to 0', () => {
  const view    = makeView();
  const journal = makeJournal([makeEntry()]);
  view.attach(journal);
  view._lastLen = 99;
  view.attach(makeJournal());
  assert.strictEqual(view._lastLen, 0);
});

test('TimelineView.attach: resets _lastDate to null', () => {
  const view = makeView();
  view._lastDate = 'Wed Jan 01 2025';
  view.attach(makeJournal());
  assert.strictEqual(view._lastDate, null);
});

test('TimelineView.attach: clears the expanded set', () => {
  const view = makeView();
  view.expanded.add('foo');
  view.expanded.add('bar');
  view.attach(makeJournal());
  assert.strictEqual(view.expanded.size, 0);
});

test('TimelineView.attach: renders immediately (sets container.innerHTML)', () => {
  const view = makeView();
  view.attach(makeJournal());
  assert.ok(view.container.innerHTML.length > 0,
    'innerHTML should be set after attach');
});

// ─── reset ────────────────────────────────────────────────────────────────────

test('TimelineView.reset: clears the expanded set', () => {
  const view = makeView();
  view.attach(makeJournal());
  view.expanded.add('foo');
  view.reset();
  assert.strictEqual(view.expanded.size, 0);
});

test('TimelineView.reset: resets _lastLen to 0', () => {
  const view = makeView();
  view.attach(makeJournal([makeEntry()]));
  view._lastLen = 5;
  view.reset();
  assert.strictEqual(view._lastLen, 0);
});

test('TimelineView.reset: resets _lastDate to null', () => {
  const view = makeView();
  view.attach(makeJournal([makeEntry()]));
  view._lastDate = 'Wed Jan 01 2025';
  view.reset();
  assert.strictEqual(view._lastDate, null);
});

// ─── update ───────────────────────────────────────────────────────────────────

test('TimelineView.update: does nothing when journal is null', () => {
  const view = makeView();
  assert.doesNotThrow(() => view.update());
});

test('TimelineView.update: is a no-op when journal length has not changed', () => {
  const view    = makeView();
  const journal = makeJournal([]);
  view.attach(journal);

  // Add an entry and let update sync _lastLen
  journal.journal.push(makeEntry({ date: new Date(2025, 0, 1) }));
  view.update();   // _lastLen advances to 1

  // Now intercept _render — a second update with no new entries should not call it
  let renderCalls = 0;
  const orig = view._render.bind(view);
  view._render = () => { renderCalls++; orig(); };

  view.update();
  assert.strictEqual(renderCalls, 0, '_render should not be called when nothing changed');
});

test('TimelineView.update: calls _render when new entries are added', () => {
  const view    = makeView();
  const journal = makeJournal([]);
  view.attach(journal);

  let renderCalls = 0;
  const orig = view._render.bind(view);
  view._render = () => { renderCalls++; orig(); };

  journal.journal.push(makeEntry({ date: new Date(2025, 0, 1) }));
  view.update();

  assert.ok(renderCalls >= 1, '_render should be called when new entries arrive');
});

test('TimelineView.update: advances _lastLen to match new journal length', () => {
  const view    = makeView();
  const journal = makeJournal([]);
  view.attach(journal);

  journal.journal.push(makeEntry());
  view.update();
  assert.strictEqual(view._lastLen, 1);
});

test('TimelineView.update: auto-expands the date group of the latest entry', () => {
  const view    = makeView();
  const journal = makeJournal([]);
  view.attach(journal);

  const d = new Date(2025, 0, 1);
  journal.journal.push(makeEntry({ date: d }));
  view.update();

  assert.ok(view.expanded.has(d.toDateString()),
    'date group for the latest entry should be added to expanded');
});

test('TimelineView.update: does not re-expand a date the user has already collapsed', () => {
  const view    = makeView();
  const journal = makeJournal([]);
  view.attach(journal);

  const d = new Date(2025, 0, 1);
  journal.journal.push(makeEntry({ date: d }));
  view.update();
  view.expanded.delete(d.toDateString());   // simulate user collapsing

  // Second entry on the same date
  journal.journal.push(makeEntry({ date: d, actionType: 'SECOND' }));
  view.update();

  assert.ok(!view.expanded.has(d.toDateString()),
    'same date should not be re-expanded after user collapsed it');
});

test('TimelineView.update: auto-expands when the date changes to a new day', () => {
  const view    = makeView();
  const journal = makeJournal([]);
  view.attach(journal);

  journal.journal.push(makeEntry({ date: new Date(2025, 0, 1) }));
  view.update();

  const d2 = new Date(2025, 1, 1);
  journal.journal.push(makeEntry({ date: d2 }));
  view.update();

  assert.ok(view.expanded.has(d2.toDateString()),
    'new date group should be auto-expanded when date advances');
});

// ─── _groups ─────────────────────────────────────────────────────────────────

test('TimelineView._groups: returns empty map for empty journal', () => {
  const view = makeView();
  view.attach(makeJournal([]));
  assert.strictEqual(view._groups().size, 0);
});

test('TimelineView._groups: single entry produces one date group', () => {
  const view = makeView();
  view.attach(makeJournal([makeEntry({ date: new Date(2025, 0, 1) })]));
  assert.strictEqual(view._groups().size, 1);
});

test('TimelineView._groups: entries on the same date are in the same date group', () => {
  const d    = new Date(2025, 0, 1);
  const view = makeView();
  view.attach(makeJournal([
    makeEntry({ date: d, actionType: 'ACT_A' }),
    makeEntry({ date: d, actionType: 'ACT_B' }),
  ]));
  assert.strictEqual(view._groups().size, 1);
});

test('TimelineView._groups: entries on different dates produce separate groups', () => {
  const view = makeView();
  view.attach(makeJournal([
    makeEntry({ date: new Date(2025, 0, 1) }),
    makeEntry({ date: new Date(2025, 1, 1) }),
    makeEntry({ date: new Date(2025, 2, 1) }),
  ]));
  assert.strictEqual(view._groups().size, 3);
});

test('TimelineView._groups: same date and eventType grouped into one event bucket', () => {
  const d    = new Date(2025, 0, 1);
  const view = makeView();
  view.attach(makeJournal([
    makeEntry({ date: d, eventType: 'SELL_ASSET', actionType: 'REALIZE_GAIN' }),
    makeEntry({ date: d, eventType: 'SELL_ASSET', actionType: 'ADD_CASH'     }),
  ]));

  const byEvent = view._groups().get(d.toDateString());
  assert.ok(byEvent, 'date group should exist');
  assert.strictEqual(byEvent.size, 1, 'both entries share the same event type');
  assert.strictEqual(byEvent.get('SELL_ASSET').length, 2);
});

test('TimelineView._groups: same date, different eventTypes produce separate event buckets', () => {
  const d    = new Date(2025, 0, 1);
  const view = makeView();
  view.attach(makeJournal([
    makeEntry({ date: d, eventType: 'SELL_ASSET',     actionType: 'REALIZE_GAIN'  }),
    makeEntry({ date: d, eventType: 'MONTHLY_SALARY', actionType: 'SALARY_CREDIT' }),
  ]));

  const byEvent = view._groups().get(d.toDateString());
  assert.strictEqual(byEvent.size, 2);
  assert.ok(byEvent.has('SELL_ASSET'));
  assert.ok(byEvent.has('MONTHLY_SALARY'));
});

test('TimelineView._groups: each item includes the original entry and its index', () => {
  const view  = makeView();
  const entry = makeEntry({ date: new Date(2025, 0, 1), eventType: 'EV' });
  view.attach(makeJournal([entry]));

  const items = view._groups()
    .get(entry.date.toDateString())
    .get('EV');

  assert.strictEqual(items[0].entry, entry);
  assert.strictEqual(items[0].idx,   0);
});

// ─── _sum ─────────────────────────────────────────────────────────────────────

test('TimelineView._sum: returns empty string for action with no known fields', () => {
  assert.strictEqual(makeView()._sum({ type: 'FOO' }), '');
});

test('TimelineView._sum: formats amount as a dollar value', () => {
  const s = makeView()._sum({ type: 'ADD_CASH', amount: 1000 });
  assert.ok(s.includes('$1,000.00'), `expected '$1,000.00' in "${s}"`);
});

test('TimelineView._sum: formats tax field with "tax" prefix', () => {
  const s = makeView()._sum({ type: 'CGT', tax: 500 });
  assert.ok(s.includes('tax'),      `expected "tax" in "${s}"`);
  assert.ok(s.includes('$500.00'),  `expected '$500.00' in "${s}"`);
});

test('TimelineView._sum: includes LT for long-term holds', () => {
  const s = makeView()._sum({ type: 'CGT', isLongTerm: true });
  assert.ok(s.includes('LT'), `expected "LT" in "${s}"`);
});

test('TimelineView._sum: includes ST for short-term holds', () => {
  const s = makeView()._sum({ type: 'CGT', isLongTerm: false });
  assert.ok(s.includes('ST'), `expected "ST" in "${s}"`);
});

test('TimelineView._sum: includes name field directly', () => {
  const s = makeView()._sum({ type: 'RECORD_METRIC', name: 'capital_gains_tax' });
  assert.ok(s.includes('capital_gains_tax'), `expected name in "${s}"`);
});

test('TimelineView._sum: formats a numeric value as a dollar string', () => {
  const s = makeView()._sum({ type: 'RECORD_METRIC', name: 'salary', value: 8000 });
  assert.ok(s.includes('$8,000.00'), `expected '$8,000.00' in "${s}"`);
});

test('TimelineView._sum: wraps a string value in double quotes', () => {
  const s = makeView()._sum({ type: 'RECORD_METRIC', name: 'assets_sold', value: 'Tech Stock' });
  assert.ok(s.includes('"Tech Stock"'), `expected '"Tech Stock"' in "${s}"`);
});

test('TimelineView._sum: joins multiple fields with " · "', () => {
  const s = makeView()._sum({ type: 'CGT', amount: 1200, isLongTerm: true });
  assert.ok(s.includes(' · '), `expected " · " separator in "${s}"`);
});

test('TimelineView._sum: handles action with all supported fields', () => {
  const s = makeView()._sum({ type: 'X', amount: 100, tax: 15, isLongTerm: true, name: 'foo', value: 200 });
  assert.ok(s.includes('$100.00'));
  assert.ok(s.includes('tax'));
  assert.ok(s.includes('LT'));
  assert.ok(s.includes('foo'));
  assert.ok(s.includes('$200.00'));
});

// ─── _render ─────────────────────────────────────────────────────────────────

test('TimelineView._render: does nothing when journal is null', () => {
  const container = makeContainer();
  const view      = new TimelineView({ container, onDetail: () => {} });
  assert.doesNotThrow(() => view._render());
  assert.strictEqual(container.innerHTML, '',
    'innerHTML should remain empty when journal is null');
});

test('TimelineView._render: empty journal shows the empty-state element', () => {
  const view = makeView();
  view.attach(makeJournal([]));
  assert.ok(view.container.innerHTML.includes('tl-empty'),
    'should render tl-empty element for an empty journal');
});

test('TimelineView._render: non-empty journal sets a non-empty innerHTML', () => {
  const view = makeView();
  view.attach(makeJournal([makeEntry({ date: new Date(2025, 0, 1) })]));
  assert.ok(view.container.innerHTML.length > 0);
  assert.ok(!view.container.innerHTML.includes('tl-empty'),
    'should not show empty state when entries exist');
});

test('TimelineView._render: date header includes the date string', () => {
  const view = makeView();
  const d    = new Date(2025, 0, 1);
  view.attach(makeJournal([makeEntry({ date: d })]));
  assert.ok(view.container.innerHTML.includes(d.toDateString()),
    'date string should appear in the rendered HTML');
});

test('TimelineView._render: badge shows correct event and action counts', () => {
  const view = makeView();
  const d    = new Date(2025, 0, 1);
  view.attach(makeJournal([
    makeEntry({ date: d, eventType: 'SELL_ASSET',    actionType: 'REALIZE_GAIN'  }),
    makeEntry({ date: d, eventType: 'MONTHLY_SALARY', actionType: 'SALARY_CREDIT' }),
  ]));
  // 2 distinct event types, 2 total actions
  assert.ok(view.container.innerHTML.includes('2 events'),  'badge should say "2 events"');
  assert.ok(view.container.innerHTML.includes('2 actions'), 'badge should say "2 actions"');
});

test('TimelineView._render: collapsed date group does not show event rows', () => {
  const view = makeView();
  const d    = new Date(2025, 0, 1);
  // attach clears expanded → date group is collapsed
  view.attach(makeJournal([makeEntry({ date: d, eventType: 'SELL_ASSET' })]));
  assert.ok(!view.container.innerHTML.includes('tl-ev-hdr'),
    'event header should not appear for a collapsed date group');
});

test('TimelineView._render: expanded date group shows event rows', () => {
  const view = makeView();
  const d    = new Date(2025, 0, 1);
  view.attach(makeJournal([makeEntry({ date: d, eventType: 'SELL_ASSET' })]));
  view.expanded.add(d.toDateString());
  view._render();
  assert.ok(view.container.innerHTML.includes('tl-ev-hdr'),
    'event header should appear for an expanded date group');
  assert.ok(view.container.innerHTML.includes('SELL_ASSET'),
    'event type name should appear in expanded view');
});

test('TimelineView._render: expanded event group shows action rows with detail button', () => {
  const view    = makeView();
  const d       = new Date(2025, 0, 1);
  const dateKey = d.toDateString();
  const evKey   = `${dateKey}::SELL_ASSET`;
  view.attach(makeJournal([
    makeEntry({ date: d, eventType: 'SELL_ASSET', actionType: 'REALIZE_GAIN' })
  ]));
  view.expanded.add(dateKey);
  view.expanded.add(evKey);
  view._render();
  assert.ok(view.container.innerHTML.includes('REALIZE_GAIN'),
    'action type should appear when event group is expanded');
  assert.ok(view.container.innerHTML.includes('tl-det'),
    'detail button should appear for each action row');
});

test('TimelineView._render: correct chevron shown for collapsed vs expanded date group', () => {
  const view = makeView();
  const d    = new Date(2025, 0, 1);

  // Collapsed
  view.attach(makeJournal([makeEntry({ date: d })]));
  assert.ok(view.container.innerHTML.includes('▶'),
    'right-pointing chevron should appear for collapsed group');

  // Expanded
  view.expanded.add(d.toDateString());
  view._render();
  assert.ok(view.container.innerHTML.includes('▼'),
    'down-pointing chevron should appear for expanded group');
});

test('TimelineView._render: scrolls to bottom when already near the bottom', () => {
  // scrollHeight=400, scrollTop=320, clientHeight=100 → 400-320-100=-20 < 80 → atBottom=true
  const container = makeContainer({ scrollHeight: 400, scrollTop: 320, clientHeight: 100 });
  const view = new TimelineView({ container, onDetail: () => {} });
  view.attach(makeJournal([makeEntry()]));
  assert.strictEqual(container.scrollTop, container.scrollHeight,
    'scrollTop should be set to scrollHeight when near the bottom');
});

test('TimelineView._render: does not scroll when not near the bottom', () => {
  // scrollHeight=500, scrollTop=0, clientHeight=100 → 500-0-100=400 ≥ 80 → atBottom=false
  const container = makeContainer({ scrollHeight: 500, scrollTop: 0, clientHeight: 100 });
  const view = new TimelineView({ container, onDetail: () => {} });
  view.attach(makeJournal([makeEntry()]));
  assert.strictEqual(container.scrollTop, 0,
    'scrollTop should not change when not near the bottom');
});
