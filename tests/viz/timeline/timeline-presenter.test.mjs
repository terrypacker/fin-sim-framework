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
import { TimelineView }       from '../../../src/visualization/timeline/timeline-view.js';
import { TimelinePresenter }  from '../../../src/visualization/timeline/timeline-presenter.js';

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

function makeContainer({ scrollHeight = 400, scrollTop = 0, clientHeight = 100 } = {}) {
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

function makeJournal(entries = []) {
  return { journal: entries };
}

function makePresenter({ onDetail = () => {}, onRewind = null, containerOpts = {} } = {}) {
  makeFilterTemplate();
  const container  = makeContainer(containerOpts);
  const controller = new TimelineController();
  const view       = new TimelineView({ container });
  const presenter  = new TimelinePresenter({ controller, view, onDetail, onRewind });
  return { presenter, controller, view, container };
}

// ─── Constructor / wiring ─────────────────────────────────────────────────────

test('TimelinePresenter: constructor wires filter callbacks on the view', () => {
  const { view } = makePresenter();
  assert.ok(typeof view.onFilterEvents    === 'function', 'onFilterEvents should be wired');
  assert.ok(typeof view.onFilterActions   === 'function', 'onFilterActions should be wired');
  assert.ok(typeof view.onFilterDateStart === 'function', 'onFilterDateStart should be wired');
  assert.ok(typeof view.onFilterDateEnd   === 'function', 'onFilterDateEnd should be wired');
  assert.ok(typeof view.onClearFilters    === 'function', 'onClearFilters should be wired');
  assert.ok(typeof view.onToggle          === 'function', 'onToggle should be wired');
  assert.ok(typeof view.onDetail          === 'function', 'onDetail should be wired');
});

test('TimelinePresenter: does not store onDetail as a private field', () => {
  const { presenter } = makePresenter({ onDetail: () => {} });
  assert.strictEqual(presenter._onDetail, undefined,
    '_onDetail should not exist — the callback is used directly via view.onDetail');
});

test('TimelinePresenter: onRewind not wired when not provided', () => {
  const { view } = makePresenter({ onRewind: null });
  assert.strictEqual(view.onRewind, null);
});

test('TimelinePresenter: onRewind wired when provided', () => {
  const { view } = makePresenter({ onRewind: () => {} });
  assert.ok(typeof view.onRewind === 'function');
});

// ─── attach ───────────────────────────────────────────────────────────────────

test('TimelinePresenter.attach: sets journal on the controller', () => {
  const { presenter, controller } = makePresenter();
  const journal = makeJournal();
  presenter.attach(journal);
  assert.strictEqual(controller.journal, journal);
});

test('TimelinePresenter.attach: resets controller state', () => {
  const { presenter, controller } = makePresenter();
  controller._lastLen  = 99;
  controller._lastDate = 'old';
  controller.expanded.add('foo');
  presenter.attach(makeJournal());
  assert.strictEqual(controller._lastLen,  0);
  assert.strictEqual(controller._lastDate, null);
  assert.strictEqual(controller.expanded.size, 0);
});

test('TimelinePresenter.attach: renders immediately', () => {
  const { presenter, container } = makePresenter();
  presenter.attach(makeJournal());
  assert.ok(container.innerHTML.length > 0);
});

// ─── reset ────────────────────────────────────────────────────────────────────

test('TimelinePresenter.reset: clears controller expanded set', () => {
  const { presenter, controller } = makePresenter();
  presenter.attach(makeJournal());
  controller.expanded.add('foo');
  presenter.reset();
  assert.strictEqual(controller.expanded.size, 0);
});

test('TimelinePresenter.reset: resets _lastLen to 0', () => {
  const { presenter, controller } = makePresenter();
  presenter.attach(makeJournal([makeEntry()]));
  controller._lastLen = 5;
  presenter.reset();
  assert.strictEqual(controller._lastLen, 0);
});

test('TimelinePresenter.reset: resets _lastDate to null', () => {
  const { presenter, controller } = makePresenter();
  presenter.attach(makeJournal([makeEntry()]));
  controller._lastDate = 'Wed Jan 01 2025';
  presenter.reset();
  assert.strictEqual(controller._lastDate, null);
});

// ─── update ───────────────────────────────────────────────────────────────────

test('TimelinePresenter.update: does nothing when journal is null', () => {
  const { presenter } = makePresenter();
  assert.doesNotThrow(() => presenter.update());
});

test('TimelinePresenter.update: is a no-op when journal length has not changed', () => {
  const { presenter, view } = makePresenter();
  const journal = makeJournal([]);
  presenter.attach(journal);

  journal.journal.push(makeEntry({ date: new Date(2025, 0, 1) }));
  presenter.update(); // advances _lastLen to 1

  let renderCalls = 0;
  const orig = view.render.bind(view);
  view.render = (...args) => { renderCalls++; orig(...args); };

  presenter.update();
  assert.strictEqual(renderCalls, 0);
});

test('TimelinePresenter.update: calls view.render when new entries arrive', () => {
  const { presenter, view } = makePresenter();
  const journal = makeJournal([]);
  presenter.attach(journal);

  let renderCalls = 0;
  const orig = view.render.bind(view);
  view.render = (...args) => { renderCalls++; orig(...args); };

  journal.journal.push(makeEntry({ date: new Date(2025, 0, 1) }));
  presenter.update();
  assert.ok(renderCalls >= 1);
});

test('TimelinePresenter.update: auto-expands the latest date group', () => {
  const { presenter, controller } = makePresenter();
  const journal = makeJournal([]);
  presenter.attach(journal);
  const d = new Date(2025, 0, 1);
  journal.journal.push(makeEntry({ date: d }));
  presenter.update();
  assert.ok(controller.expanded.has(d.toDateString()));
});

// ─── filter callback wiring ───────────────────────────────────────────────────

test('TimelinePresenter: onFilterEvents updates controller.filterEvents', () => {
  const { presenter, controller, view } = makePresenter();
  presenter.attach(makeJournal([]));
  view.onFilterEvents(new Set(['SELL_ASSET', 'SALARY']));
  assert.ok(controller.filterEvents.has('SELL_ASSET'));
  assert.ok(controller.filterEvents.has('SALARY'));
  assert.strictEqual(controller.filterEvents.size, 2);
});

test('TimelinePresenter: onFilterActions updates controller.filterActions', () => {
  const { presenter, controller, view } = makePresenter();
  presenter.attach(makeJournal([]));
  view.onFilterActions(new Set(['REALIZE_GAIN']));
  assert.ok(controller.filterActions.has('REALIZE_GAIN'));
});

test('TimelinePresenter: onFilterDateStart parses string to local start-of-day Date', () => {
  const { presenter, controller, view } = makePresenter();
  presenter.attach(makeJournal([]));
  view.onFilterDateStart('2025-06-15');
  assert.ok(controller.filterDateStart instanceof Date);
  assert.strictEqual(controller.filterDateStart.getFullYear(), 2025);
  assert.strictEqual(controller.filterDateStart.getMonth(),    5);   // June = 5
  assert.strictEqual(controller.filterDateStart.getDate(),     15);
  assert.strictEqual(controller.filterDateStart.getHours(),    0);
});

test('TimelinePresenter: onFilterDateEnd parses string to local end-of-day Date', () => {
  const { presenter, controller, view } = makePresenter();
  presenter.attach(makeJournal([]));
  view.onFilterDateEnd('2025-06-15');
  assert.ok(controller.filterDateEnd instanceof Date);
  assert.strictEqual(controller.filterDateEnd.getFullYear(), 2025);
  assert.strictEqual(controller.filterDateEnd.getMonth(),    5);
  assert.strictEqual(controller.filterDateEnd.getDate(),     15);
  assert.strictEqual(controller.filterDateEnd.getHours(),    23);
});

test('TimelinePresenter: onFilterDateStart with empty string clears filterDateStart', () => {
  const { presenter, controller, view } = makePresenter();
  presenter.attach(makeJournal([]));
  view.onFilterDateStart('2025-06-15');
  view.onFilterDateStart('');
  assert.strictEqual(controller.filterDateStart, null);
});

test('TimelinePresenter: onFilterDateEnd with empty string clears filterDateEnd', () => {
  const { presenter, controller, view } = makePresenter();
  presenter.attach(makeJournal([]));
  view.onFilterDateEnd('2025-06-15');
  view.onFilterDateEnd('');
  assert.strictEqual(controller.filterDateEnd, null);
});

test('TimelinePresenter: onClearFilters resets all filter state', () => {
  const { presenter, controller, view } = makePresenter();
  presenter.attach(makeJournal([]));
  controller.filterEvents    = new Set(['SELL']);
  controller.filterActions   = new Set(['GAIN']);
  controller.filterDateStart = new Date(2025, 0, 1);
  controller.filterDateEnd   = new Date(2025, 11, 31);
  view.onClearFilters();
  assert.strictEqual(controller.filterEvents.size,  0);
  assert.strictEqual(controller.filterActions.size, 0);
  assert.strictEqual(controller.filterDateStart, null);
  assert.strictEqual(controller.filterDateEnd,   null);
});

test('TimelinePresenter: onToggle delegates to controller.toggleExpanded', () => {
  const { presenter, controller, view } = makePresenter();
  presenter.attach(makeJournal([]));
  view.onToggle('2025-01-01');
  assert.ok(controller.expanded.has('2025-01-01'));
  view.onToggle('2025-01-01');
  assert.ok(!controller.expanded.has('2025-01-01'));
});

// ─── detail callback ──────────────────────────────────────────────────────────

test('TimelinePresenter: onDetail fires callback with the correct journal entry', () => {
  let received = null;
  const entry   = makeEntry();
  const journal = makeJournal([entry]);
  const { presenter, view } = makePresenter({ onDetail: e => { received = e; } });
  presenter.attach(journal);
  view.onDetail(0);
  assert.strictEqual(received, entry);
});

// ─── _render guard ────────────────────────────────────────────────────────────

test('TimelinePresenter._render: does nothing when journal is null', () => {
  const { presenter, container } = makePresenter();
  assert.doesNotThrow(() => presenter._render());
  assert.strictEqual(container.innerHTML, '');
});

// ─── CSV download wiring ──────────────────────────────────────────────────────

// jsdom stubs needed for _triggerDownload
if (!global.URL.createObjectURL) global.URL.createObjectURL = () => 'blob:mock';
if (!global.URL.revokeObjectURL) global.URL.revokeObjectURL = () => {};

test('TimelinePresenter: onDownloadCsv is wired on the view', () => {
  const { view } = makePresenter();
  assert.ok(typeof view.onDownloadCsv === 'function', 'onDownloadCsv should be wired');
});

test('TimelinePresenter: onDownloadCsv calls controller.generateCsv', () => {
  const { presenter, controller, view } = makePresenter();
  presenter.attach(makeJournal([makeEntry()]));

  let generateCalled = false;
  const orig = controller.generateCsv.bind(controller);
  controller.generateCsv = (...args) => { generateCalled = true; return orig(...args); };

  view.onDownloadCsv();
  assert.ok(generateCalled, 'generateCsv should be called when download is triggered');
});

test('TimelinePresenter: onDownloadCsv does not trigger download when CSV is empty', () => {
  // Empty journal → generateCsv returns '' → _triggerDownload should NOT be called
  const { presenter, view } = makePresenter();
  presenter.attach(makeJournal([]));

  let triggerCalled = false;
  presenter._triggerDownload = () => { triggerCalled = true; };

  view.onDownloadCsv();
  assert.ok(!triggerCalled, '_triggerDownload should not be called for empty CSV');
});

// ─── causalGroups pass-through ────────────────────────────────────────────────

test('TimelinePresenter._render: passes causalGroups to view.render', () => {
  const { presenter, view } = makePresenter();
  let captured = undefined;
  const origRender = view.render.bind(view);
  view.render = args => { captured = args.causalGroups; origRender(args); };
  presenter.attach(makeJournal([makeEntry()]));
  assert.ok(captured instanceof Map, 'causalGroups should be a Map');
});

test('TimelinePresenter._render: causalGroups is an empty Map when journal is empty', () => {
  const { presenter, view } = makePresenter();
  let captured = undefined;
  const origRender = view.render.bind(view);
  view.render = args => { captured = args.causalGroups; origRender(args); };
  presenter.attach(makeJournal([]));
  assert.ok(captured instanceof Map);
  assert.equal(captured.size, 0);
});

// ─── onNavigateToNode wiring ──────────────────────────────────────────────────

test('TimelinePresenter: onNavigateToNode is wired to view when provided', () => {
  makeFilterTemplate();
  const container  = makeContainer();
  const controller = new TimelineController();
  const view       = new TimelineView({ container });
  let received     = null;
  const onNavigateToNode = id => { received = id; };
  const presenter  = new TimelinePresenter({ controller, view, onDetail: () => {}, onNavigateToNode });
  assert.strictEqual(view.onNavigateToNode, onNavigateToNode);
});

test('TimelinePresenter: onNavigateToNode defaults to null on view when not provided', () => {
  const { view } = makePresenter();
  assert.strictEqual(view.onNavigateToNode, null);
});

// ─── schemaRegistry setter ────────────────────────────────────────────────────

test('TimelinePresenter: schemaRegistry setter delegates to controller.schemaRegistry', () => {
  const { presenter, controller } = makePresenter();
  const fakeRegistry = { format: () => null };
  presenter.schemaRegistry = fakeRegistry;
  assert.strictEqual(controller.schemaRegistry, fakeRegistry);
});

test('TimelinePresenter: schemaRegistry setter coerces null/undefined to null on controller', () => {
  const { presenter, controller } = makePresenter();
  presenter.schemaRegistry = null;
  assert.strictEqual(controller.schemaRegistry, null);
});
