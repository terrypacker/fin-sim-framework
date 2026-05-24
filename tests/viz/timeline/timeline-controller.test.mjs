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

import { TimelineController } from '../../../src/visualization/timeline/timeline-controller.js';

const fmtDate = d => d.toDateString();

function makeEntry({
  date      = new Date(2025, 0, 1),
  eventType = 'TEST_EVENT',
  actionType = 'TEST_ACTION',
  reducer   = { name: 'Test Reducer' },
} = {}) {
  return { date, eventType, action: { type: actionType }, reducer };
}

function makeJournal(entries = []) {
  return { journal: entries };
}

function makeController() {
  return new TimelineController();
}

// ─── Constructor ──────────────────────────────────────────────────────────────

test('TimelineController: constructor initialises journal to null', () => {
  assert.strictEqual(makeController().journal, null);
});

test('TimelineController: constructor initialises expanded to an empty Set', () => {
  const ctrl = makeController();
  assert.ok(ctrl.expanded instanceof Set);
  assert.strictEqual(ctrl.expanded.size, 0);
});

test('TimelineController: constructor sets _lastLen to 0', () => {
  assert.strictEqual(makeController()._lastLen, 0);
});


test('TimelineController: constructor initialises filterEvents and filterActions as empty Sets', () => {
  const ctrl = makeController();
  assert.ok(ctrl.filterEvents  instanceof Set && ctrl.filterEvents.size  === 0);
  assert.ok(ctrl.filterActions instanceof Set && ctrl.filterActions.size === 0);
});

test('TimelineController: constructor initialises filterDateStart and filterDateEnd to null', () => {
  const ctrl = makeController();
  assert.strictEqual(ctrl.filterDateStart, null);
  assert.strictEqual(ctrl.filterDateEnd,   null);
});

// ─── setJournal ───────────────────────────────────────────────────────────────

test('TimelineController.setJournal: sets the journal reference', () => {
  const ctrl    = makeController();
  const journal = makeJournal();
  ctrl.setJournal(journal);
  assert.strictEqual(ctrl.journal, journal);
});

test('TimelineController.setJournal: resets _lastLen to 0', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([makeEntry()]));
  ctrl._lastLen = 99;
  ctrl.setJournal(makeJournal());
  assert.strictEqual(ctrl._lastLen, 0);
});


test('TimelineController.setJournal: clears the expanded set', () => {
  const ctrl = makeController();
  ctrl.expanded.add('foo');
  ctrl.expanded.add('bar');
  ctrl.setJournal(makeJournal());
  assert.strictEqual(ctrl.expanded.size, 0);
});

// ─── reset ────────────────────────────────────────────────────────────────────

test('TimelineController.reset: clears the expanded set', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal());
  ctrl.expanded.add('foo');
  ctrl.reset();
  assert.strictEqual(ctrl.expanded.size, 0);
});

test('TimelineController.reset: resets _lastLen to 0', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([makeEntry()]));
  ctrl._lastLen = 5;
  ctrl.reset();
  assert.strictEqual(ctrl._lastLen, 0);
});


test('TimelineController.reset: does not clear filter state', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal());
  ctrl.filterEvents    = new Set(['SELL_ASSET']);
  ctrl.filterActions   = new Set(['REALIZE_GAIN']);
  ctrl.filterDateStart = new Date(2025, 0, 1);
  ctrl.filterDateEnd   = new Date(2025, 11, 31);
  ctrl.reset();
  assert.strictEqual(ctrl.filterEvents.size,  1, 'filterEvents should survive reset');
  assert.strictEqual(ctrl.filterActions.size, 1, 'filterActions should survive reset');
  assert.ok(ctrl.filterDateStart !== null, 'filterDateStart should survive reset');
  assert.ok(ctrl.filterDateEnd   !== null, 'filterDateEnd should survive reset');
});

// ─── update ───────────────────────────────────────────────────────────────────

test('TimelineController.update: returns false when journal is null', () => {
  assert.strictEqual(makeController().update(fmtDate), false);
});

test('TimelineController.update: returns false when journal length has not changed', () => {
  const ctrl    = makeController();
  const journal = makeJournal([]);
  ctrl.setJournal(journal);
  journal.journal.push(makeEntry({ date: new Date(2025, 0, 1) }));
  ctrl.update(fmtDate); // advances _lastLen to 1
  assert.strictEqual(ctrl.update(fmtDate), false);
});

test('TimelineController.update: returns true when new entries are added', () => {
  const ctrl    = makeController();
  const journal = makeJournal([]);
  ctrl.setJournal(journal);
  journal.journal.push(makeEntry({ date: new Date(2025, 0, 1) }));
  assert.strictEqual(ctrl.update(fmtDate), true);
});

test('TimelineController.update: advances _lastLen to match new journal length', () => {
  const ctrl    = makeController();
  const journal = makeJournal([]);
  ctrl.setJournal(journal);
  journal.journal.push(makeEntry());
  ctrl.update(fmtDate);
  assert.strictEqual(ctrl._lastLen, 1);
});

test('TimelineController.update: does not auto-expand any date group when entries arrive', () => {
  const ctrl    = makeController();
  const journal = makeJournal([]);
  ctrl.setJournal(journal);
  journal.journal.push(makeEntry({ date: new Date(2025, 0, 1) }));
  ctrl.update(fmtDate);
  assert.strictEqual(ctrl.expanded.size, 0, 'no date groups should be auto-expanded');
});

test('TimelineController.update: does not auto-expand when date changes to a new day', () => {
  const ctrl    = makeController();
  const journal = makeJournal([]);
  ctrl.setJournal(journal);
  journal.journal.push(makeEntry({ date: new Date(2025, 0, 1) }));
  ctrl.update(fmtDate);
  journal.journal.push(makeEntry({ date: new Date(2025, 1, 1) }));
  ctrl.update(fmtDate);
  assert.strictEqual(ctrl.expanded.size, 0, 'new date groups should not be auto-expanded');
});

// ─── groups ──────────────────────────────────────────────────────────────────

test('TimelineController.groups: returns empty map when journal is null', () => {
  assert.strictEqual(makeController().groups(fmtDate).size, 0);
});

test('TimelineController.groups: returns empty map for empty journal', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([]));
  assert.strictEqual(ctrl.groups(fmtDate).size, 0);
});

test('TimelineController.groups: single entry produces one date group', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([makeEntry({ date: new Date(2025, 0, 1) })]));
  assert.strictEqual(ctrl.groups(fmtDate).size, 1);
});

test('TimelineController.groups: entries on the same date are in the same date group', () => {
  const d    = new Date(2025, 0, 1);
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([
    makeEntry({ date: d, actionType: 'ACT_A' }),
    makeEntry({ date: d, actionType: 'ACT_B' }),
  ]));
  assert.strictEqual(ctrl.groups(fmtDate).size, 1);
});

test('TimelineController.groups: entries on different dates produce separate groups', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([
    makeEntry({ date: new Date(2025, 0, 1) }),
    makeEntry({ date: new Date(2025, 1, 1) }),
    makeEntry({ date: new Date(2025, 2, 1) }),
  ]));
  assert.strictEqual(ctrl.groups(fmtDate).size, 3);
});

test('TimelineController.groups: same date and eventType grouped into one event bucket', () => {
  const d    = new Date(2025, 0, 1);
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([
    makeEntry({ date: d, eventType: 'SELL_ASSET', actionType: 'REALIZE_GAIN' }),
    makeEntry({ date: d, eventType: 'SELL_ASSET', actionType: 'ADD_CASH'     }),
  ]));
  const byEvent = ctrl.groups(fmtDate).get(d.toDateString());
  assert.ok(byEvent, 'date group should exist');
  assert.strictEqual(byEvent.size, 1, 'both entries share the same event type');
  assert.strictEqual(byEvent.get('SELL_ASSET').length, 2);
});

test('TimelineController.groups: same date, different eventTypes produce separate event buckets', () => {
  const d    = new Date(2025, 0, 1);
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([
    makeEntry({ date: d, eventType: 'SELL_ASSET',     actionType: 'REALIZE_GAIN'  }),
    makeEntry({ date: d, eventType: 'MONTHLY_SALARY', actionType: 'SALARY_CREDIT' }),
  ]));
  const byEvent = ctrl.groups(fmtDate).get(d.toDateString());
  assert.strictEqual(byEvent.size, 2);
  assert.ok(byEvent.has('SELL_ASSET'));
  assert.ok(byEvent.has('MONTHLY_SALARY'));
});

test('TimelineController.groups: each item includes the original entry, its index, and sum', () => {
  const ctrl  = makeController();
  const entry = makeEntry({ date: new Date(2025, 0, 1), eventType: 'EV' });
  ctrl.setJournal(makeJournal([entry]));
  const items = ctrl.groups(fmtDate)
    .get(entry.date.toDateString())
    .get('EV');
  assert.strictEqual(items[0].entry, entry);
  assert.strictEqual(items[0].idx,   0);
  assert.ok('sum' in items[0], 'item should include precomputed sum');
});

// ─── groups: event/action filter (multi-select) ───────────────────────────────

test('TimelineController.groups: filterEvents excludes non-selected event types', () => {
  const d    = new Date(2025, 0, 1);
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([
    makeEntry({ date: d, eventType: 'SELL_ASSET' }),
    makeEntry({ date: d, eventType: 'SALARY'     }),
  ]));
  ctrl.filterEvents = new Set(['SELL_ASSET']);
  const groups = ctrl.groups(fmtDate);
  assert.strictEqual(groups.size, 1);
  assert.ok(groups.get(d.toDateString()).has('SELL_ASSET'));
  assert.ok(!groups.get(d.toDateString()).has('SALARY'));
});

test('TimelineController.groups: filterEvents allows multiple selections', () => {
  const d    = new Date(2025, 0, 1);
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([
    makeEntry({ date: d, eventType: 'SELL_ASSET' }),
    makeEntry({ date: d, eventType: 'SALARY'     }),
    makeEntry({ date: d, eventType: 'EXPENSE'    }),
  ]));
  ctrl.filterEvents = new Set(['SELL_ASSET', 'SALARY']);
  const byEvent = ctrl.groups(fmtDate).get(d.toDateString());
  assert.ok(byEvent.has('SELL_ASSET'));
  assert.ok(byEvent.has('SALARY'));
  assert.ok(!byEvent.has('EXPENSE'));
});

test('TimelineController.groups: empty filterEvents passes all event types', () => {
  const d    = new Date(2025, 0, 1);
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([
    makeEntry({ date: d, eventType: 'SELL_ASSET' }),
    makeEntry({ date: d, eventType: 'SALARY'     }),
  ]));
  ctrl.filterEvents = new Set(); // no filter
  const byEvent = ctrl.groups(fmtDate).get(d.toDateString());
  assert.strictEqual(byEvent.size, 2);
});

test('TimelineController.groups: filterActions excludes non-selected action types', () => {
  const d    = new Date(2025, 0, 1);
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([
    makeEntry({ date: d, actionType: 'REALIZE_GAIN' }),
    makeEntry({ date: d, actionType: 'ADD_CASH'     }),
  ]));
  ctrl.filterActions = new Set(['REALIZE_GAIN']);
  const byEvent = ctrl.groups(fmtDate).get(d.toDateString());
  assert.strictEqual(byEvent.get('TEST_EVENT').length, 1);
  assert.strictEqual(byEvent.get('TEST_EVENT')[0].entry.action.type, 'REALIZE_GAIN');
});

// ─── groups: date range filter ────────────────────────────────────────────────

test('TimelineController.groups: filterDateStart excludes entries before the start date', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([
    makeEntry({ date: new Date(2025, 0, 1) }),
    makeEntry({ date: new Date(2025, 5, 1) }),
    makeEntry({ date: new Date(2025, 11, 1) }),
  ]));
  ctrl.filterDateStart = new Date(2025, 5, 1, 0, 0, 0, 0); // June 1
  assert.strictEqual(ctrl.groups(fmtDate).size, 2, 'only June and December should pass');
});

test('TimelineController.groups: filterDateEnd excludes entries after the end date', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([
    makeEntry({ date: new Date(2025, 0, 1) }),
    makeEntry({ date: new Date(2025, 5, 1) }),
    makeEntry({ date: new Date(2025, 11, 1) }),
  ]));
  ctrl.filterDateEnd = new Date(2025, 5, 1, 23, 59, 59, 999); // end of June 1
  assert.strictEqual(ctrl.groups(fmtDate).size, 2, 'only January and June should pass');
});

test('TimelineController.groups: date range filter is inclusive on both ends', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([
    makeEntry({ date: new Date(2025, 0, 1) }),
    makeEntry({ date: new Date(2025, 5, 1) }),
    makeEntry({ date: new Date(2025, 11, 1) }),
  ]));
  ctrl.filterDateStart = new Date(2025, 0, 1, 0, 0, 0, 0);
  ctrl.filterDateEnd   = new Date(2025, 5, 1, 23, 59, 59, 999);
  assert.strictEqual(ctrl.groups(fmtDate).size, 2, 'January and June should both be included');
});

test('TimelineController.groups: null date filters pass all entries', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([
    makeEntry({ date: new Date(2025, 0, 1) }),
    makeEntry({ date: new Date(2025, 5, 1) }),
  ]));
  assert.strictEqual(ctrl.groups(fmtDate).size, 2);
});

// ─── sum ─────────────────────────────────────────────────────────────────────

test('TimelineController.sum: returns empty string for action with no known fields', () => {
  assert.strictEqual(makeController().sum({ type: 'FOO' }), '');
});

test('TimelineController.sum: formats amount as a dollar value', () => {
  const s = makeController().sum({ type: 'ADD_CASH', amount: 1000 });
  assert.ok(s.includes('$1,000.00'), `expected '$1,000.00' in "${s}"`);
});

test('TimelineController.sum: formats tax field with "tax" prefix', () => {
  const s = makeController().sum({ type: 'CGT', tax: 500 });
  assert.ok(s.includes('tax'),      `expected "tax" in "${s}"`);
  assert.ok(s.includes('$500.00'),  `expected '$500.00' in "${s}"`);
});

test('TimelineController.sum: includes LT for long-term holds', () => {
  const s = makeController().sum({ type: 'CGT', isLongTerm: true });
  assert.ok(s.includes('LT'), `expected "LT" in "${s}"`);
});

test('TimelineController.sum: includes ST for short-term holds', () => {
  const s = makeController().sum({ type: 'CGT', isLongTerm: false });
  assert.ok(s.includes('ST'), `expected "ST" in "${s}"`);
});

test('TimelineController.sum: includes name field directly', () => {
  const s = makeController().sum({ type: 'RECORD_METRIC', name: 'capital_gains_tax' });
  assert.ok(s.includes('capital_gains_tax'), `expected name in "${s}"`);
});

test('TimelineController.sum: formats a numeric value as a dollar string', () => {
  const s = makeController().sum({ type: 'RECORD_METRIC', name: 'salary', value: 8000 });
  assert.ok(s.includes('$8,000.00'), `expected '$8,000.00' in "${s}"`);
});

test('TimelineController.sum: wraps a string value in double quotes', () => {
  const s = makeController().sum({ type: 'RECORD_METRIC', name: 'assets_sold', value: 'Tech Stock' });
  assert.ok(s.includes('"Tech Stock"'), `expected '"Tech Stock"' in "${s}"`);
});

test('TimelineController.sum: joins multiple fields with " · "', () => {
  const s = makeController().sum({ type: 'CGT', amount: 1200, isLongTerm: true });
  assert.ok(s.includes(' · '), `expected " · " separator in "${s}"`);
});

test('TimelineController.sum: handles action with all supported fields', () => {
  const s = makeController().sum({ type: 'X', amount: 100, tax: 15, isLongTerm: true, name: 'foo', value: 200 });
  assert.ok(s.includes('$100.00'));
  assert.ok(s.includes('tax'));
  assert.ok(s.includes('LT'));
  assert.ok(s.includes('foo'));
  assert.ok(s.includes('$200.00'));
});

// ─── toggleExpanded ───────────────────────────────────────────────────────────

test('TimelineController.toggleExpanded: adds a key that is not present', () => {
  const ctrl = makeController();
  ctrl.toggleExpanded('2025-01-01');
  assert.ok(ctrl.expanded.has('2025-01-01'));
});

test('TimelineController.toggleExpanded: removes a key that is already present', () => {
  const ctrl = makeController();
  ctrl.expanded.add('2025-01-01');
  ctrl.toggleExpanded('2025-01-01');
  assert.ok(!ctrl.expanded.has('2025-01-01'));
});

// ─── generateCsv ─────────────────────────────────────────────────────────────

test('TimelineController.generateCsv: returns empty string when journal is null', () => {
  assert.strictEqual(makeController().generateCsv(fmtDate), '');
});

test('TimelineController.generateCsv: returns empty string when no entries pass filter', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([makeEntry({ eventType: 'SALARY' })]));
  ctrl.filterEvents = new Set(['SELL_ASSET']); // nothing matches
  assert.strictEqual(ctrl.generateCsv(fmtDate), '');
});

test('TimelineController.generateCsv: returns non-empty string for a single entry', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([makeEntry()]));
  const csv = ctrl.generateCsv(fmtDate);
  assert.ok(csv.length > 0);
});

test('TimelineController.generateCsv: first line is the header row', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([makeEntry({ date: new Date(2025, 0, 1) })]));
  const header = ctrl.generateCsv(fmtDate).split('\n')[0];
  assert.ok(header.includes('date'),      'header should include date column');
  assert.ok(header.includes('eventType'), 'header should include eventType column');
  assert.ok(header.includes('action.type'), 'header should include action.type column');
});

test('TimelineController.generateCsv: second line is the data row', () => {
  const ctrl  = makeController();
  const d     = new Date(2025, 0, 1);
  ctrl.setJournal(makeJournal([makeEntry({ date: d, eventType: 'SELL_ASSET', actionType: 'REALIZE_GAIN' })]));
  const lines = ctrl.generateCsv(fmtDate).split('\n');
  assert.strictEqual(lines.length, 2, 'one header + one data row');
  assert.ok(lines[1].includes('SELL_ASSET'),   'data row should contain eventType');
  assert.ok(lines[1].includes('REALIZE_GAIN'), 'data row should contain action type');
  assert.ok(lines[1].includes(fmtDate(d)),     'data row should contain formatted date');
});

test('TimelineController.generateCsv: nested fields use parent.field naming', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([makeEntry()]));
  const header = ctrl.generateCsv(fmtDate).split('\n')[0];
  assert.ok(header.includes('action.type'),  'action fields should be prefixed with action.');
  assert.ok(header.includes('reducer.name'), 'reducer fields should be prefixed with reducer.');
});

test('TimelineController.generateCsv: action.amount column appears when entry has amount', () => {
  const ctrl  = makeController();
  const entry = makeEntry();
  entry.action.amount = 5000;
  ctrl.setJournal(makeJournal([entry]));
  const csv = ctrl.generateCsv(fmtDate);
  assert.ok(csv.includes('action.amount'), 'action.amount column should appear');
  assert.ok(csv.includes('5000'),          'amount value should appear');
});

test('TimelineController.generateCsv: columns span the union of all entry fields', () => {
  const ctrl   = makeController();
  const entry1 = makeEntry({ date: new Date(2025, 0, 1), actionType: 'ACT_A' });
  const entry2 = makeEntry({ date: new Date(2025, 0, 2), actionType: 'ACT_B' });
  entry1.action.amount = 100;
  entry2.action.tax    = 15;
  ctrl.setJournal(makeJournal([entry1, entry2]));
  const header = ctrl.generateCsv(fmtDate).split('\n')[0];
  assert.ok(header.includes('action.amount'), 'amount column from entry1 should appear');
  assert.ok(header.includes('action.tax'),    'tax column from entry2 should appear');
});

test('TimelineController.generateCsv: missing fields produce empty values in data rows', () => {
  const ctrl   = makeController();
  const entry1 = makeEntry({ date: new Date(2025, 0, 1) });
  const entry2 = makeEntry({ date: new Date(2025, 0, 2) });
  entry1.action.amount = 100; // only entry1 has amount
  ctrl.setJournal(makeJournal([entry1, entry2]));
  const lines = ctrl.generateCsv(fmtDate).split('\n');
  const header = lines[0].split(',');
  const amtIdx = header.indexOf('action.amount');
  const row2   = lines[2].split(',');
  assert.strictEqual(row2[amtIdx], '', 'missing amount should be empty in entry2 row');
});

test('TimelineController.generateCsv: respects active filterEvents', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([
    makeEntry({ eventType: 'SELL_ASSET' }),
    makeEntry({ eventType: 'SALARY'     }),
  ]));
  ctrl.filterEvents = new Set(['SELL_ASSET']);
  const lines = ctrl.generateCsv(fmtDate).split('\n');
  assert.strictEqual(lines.length, 2, 'only one data row should be generated');
  assert.ok(lines[1].includes('SELL_ASSET'));
});

test('TimelineController.generateCsv: respects active date range filter', () => {
  const ctrl = makeController();
  ctrl.setJournal(makeJournal([
    makeEntry({ date: new Date(2025, 0, 1) }),
    makeEntry({ date: new Date(2025, 5, 1) }),
    makeEntry({ date: new Date(2025, 11, 1) }),
  ]));
  ctrl.filterDateEnd = new Date(2025, 5, 1, 23, 59, 59, 999); // up to June 1
  const lines = ctrl.generateCsv(fmtDate).split('\n');
  assert.strictEqual(lines.length, 3, 'two data rows for January and June');
});

test('TimelineController.generateCsv: escapes values containing commas', () => {
  const ctrl  = makeController();
  const entry = makeEntry();
  entry.action.name = 'stocks, bonds';
  ctrl.setJournal(makeJournal([entry]));
  const csv = ctrl.generateCsv(fmtDate);
  assert.ok(csv.includes('"stocks, bonds"'), 'comma-containing values should be quoted');
});

test('TimelineController.generateCsv: escapes values containing double quotes', () => {
  const ctrl  = makeController();
  const entry = makeEntry();
  entry.action.name = 'He said "sell"';
  ctrl.setJournal(makeJournal([entry]));
  const csv = ctrl.generateCsv(fmtDate);
  assert.ok(csv.includes('"He said ""sell"""'), 'double quotes should be escaped');
});

// ─── generateCsv / _flattenObject: circular reference handling ───────────────

test('TimelineController.generateCsv: does not throw when action has a self-reference', () => {
  const ctrl  = makeController();
  const entry = makeEntry();
  entry.action.self = entry.action; // action.self → action (direct cycle)
  ctrl.setJournal(makeJournal([entry]));
  assert.doesNotThrow(() => ctrl.generateCsv(fmtDate));
});

test('TimelineController.generateCsv: does not throw when action references its parent entry', () => {
  const ctrl  = makeController();
  const entry = makeEntry();
  entry.action.parent = entry; // entry → action → entry (mutual cycle)
  ctrl.setJournal(makeJournal([entry]));
  assert.doesNotThrow(() => ctrl.generateCsv(fmtDate));
});

test('TimelineController.generateCsv: does not throw when an array field contains a circular object', () => {
  const ctrl  = makeController();
  const entry = makeEntry();
  const circ  = {};
  circ.self   = circ;           // self-referencing object inside an array
  entry.action.items = [circ];
  ctrl.setJournal(makeJournal([entry]));
  assert.doesNotThrow(() => ctrl.generateCsv(fmtDate));
});

test('TimelineController.generateCsv: circular array field renders as [circular]', () => {
  const ctrl  = makeController();
  const entry = makeEntry();
  const circ  = {};
  circ.self   = circ;
  entry.action.items = [circ];
  ctrl.setJournal(makeJournal([entry]));
  const csv = ctrl.generateCsv(fmtDate);
  assert.ok(csv.includes('[circular]'), 'circular array value should render as [circular]');
});

test('TimelineController.generateCsv: primitive fields still appear alongside circular references', () => {
  const ctrl  = makeController();
  const entry = makeEntry({ eventType: 'SELL_ASSET', actionType: 'REALIZE_GAIN' });
  entry.action.self = entry.action; // circular on action
  entry.action.amount = 9999;       // primitive alongside the cycle
  ctrl.setJournal(makeJournal([entry]));
  const csv = ctrl.generateCsv(fmtDate);
  assert.ok(csv.includes('SELL_ASSET'),   'eventType should still appear');
  assert.ok(csv.includes('REALIZE_GAIN'), 'action.type should still appear');
  assert.ok(csv.includes('9999'),         'action.amount should still appear');
});

test('TimelineController._flattenObject: diamond reference flattens correctly on both paths', () => {
  // shared is reachable via two paths; with backtracking it should appear on both
  const ctrl   = makeController();
  const shared = { x: 42 };
  const obj    = { a: shared, b: shared };
  const result = ctrl._flattenObject(obj);
  assert.strictEqual(result['a.x'], 42, 'first path to shared should be flattened');
  assert.strictEqual(result['b.x'], 42, 'second path to shared should also be flattened');
});
