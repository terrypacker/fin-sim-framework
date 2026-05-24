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

function makeContainer({ scrollHeight = 400, scrollTop = 0, clientHeight = 100 } = {}) {
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

function makeJournal(entries = []) {
  return { journal: entries };
}

function makePresenter({ onDetail = () => {}, onRewind = null, containerOpts = {} } = {}) {
  const container  = makeContainer(containerOpts);
  const controller = new TimelineController();
  const view       = new TimelineView({ container });
  const presenter  = new TimelinePresenter({ controller, view, onDetail, onRewind });
  return { presenter, controller, view, container };
}

// ─── Constructor / wiring ─────────────────────────────────────────────────────

test('TimelinePresenter: constructor wires view callbacks', () => {
  const { view } = makePresenter();
  assert.ok(typeof view.onFilterEvent  === 'function', 'onFilterEvent should be wired');
  assert.ok(typeof view.onFilterAction === 'function', 'onFilterAction should be wired');
  assert.ok(typeof view.onClearFilters === 'function', 'onClearFilters should be wired');
  assert.ok(typeof view.onToggle       === 'function', 'onToggle should be wired');
  assert.ok(typeof view.onDetail       === 'function', 'onDetail should be wired');
});

test('TimelinePresenter: onRewind not wired when not provided', () => {
  const { view } = makePresenter({ onRewind: null });
  assert.strictEqual(view.onRewind, null, 'onRewind should remain null when not supplied');
});

test('TimelinePresenter: onRewind wired when provided', () => {
  const { view } = makePresenter({ onRewind: () => {} });
  assert.ok(typeof view.onRewind === 'function', 'onRewind should be wired when supplied');
});

// ─── attach ───────────────────────────────────────────────────────────────────

test('TimelinePresenter.attach: sets journal on the controller', () => {
  const { presenter, controller } = makePresenter();
  const journal = makeJournal();
  presenter.attach(journal);
  assert.strictEqual(controller.journal, journal);
});

test('TimelinePresenter.attach: resets controller state (_lastLen, _lastDate, expanded)', () => {
  const { presenter, controller } = makePresenter();
  controller._lastLen  = 99;
  controller._lastDate = 'old';
  controller.expanded.add('foo');
  presenter.attach(makeJournal());
  assert.strictEqual(controller._lastLen, 0);
  assert.strictEqual(controller._lastDate, null);
  assert.strictEqual(controller.expanded.size, 0);
});

test('TimelinePresenter.attach: renders immediately (container gets innerHTML)', () => {
  const { presenter, container } = makePresenter();
  presenter.attach(makeJournal());
  assert.ok(container.innerHTML.length > 0, 'container should have content after attach');
});

// ─── reset ────────────────────────────────────────────────────────────────────

test('TimelinePresenter.reset: clears controller expanded set', () => {
  const { presenter, controller } = makePresenter();
  presenter.attach(makeJournal());
  controller.expanded.add('foo');
  presenter.reset();
  assert.strictEqual(controller.expanded.size, 0);
});

test('TimelinePresenter.reset: resets controller _lastLen to 0', () => {
  const { presenter, controller } = makePresenter();
  presenter.attach(makeJournal([makeEntry()]));
  controller._lastLen = 5;
  presenter.reset();
  assert.strictEqual(controller._lastLen, 0);
});

test('TimelinePresenter.reset: resets controller _lastDate to null', () => {
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
  assert.strictEqual(renderCalls, 0, 'view.render should not be called when nothing changed');
});

test('TimelinePresenter.update: calls view.render when new entries are added', () => {
  const { presenter, view } = makePresenter();
  const journal = makeJournal([]);
  presenter.attach(journal);

  let renderCalls = 0;
  const orig = view.render.bind(view);
  view.render = (...args) => { renderCalls++; orig(...args); };

  journal.journal.push(makeEntry({ date: new Date(2025, 0, 1) }));
  presenter.update();
  assert.ok(renderCalls >= 1, 'view.render should be called when new entries arrive');
});

test('TimelinePresenter.update: auto-expands the latest date group', () => {
  const { presenter, controller } = makePresenter();
  const journal = makeJournal([]);
  presenter.attach(journal);
  const d = new Date(2025, 0, 1);
  journal.journal.push(makeEntry({ date: d }));
  presenter.update();
  assert.ok(controller.expanded.has(d.toDateString()),
    'date group for the latest entry should be expanded after update');
});

// ─── filter callback wiring ───────────────────────────────────────────────────

test('TimelinePresenter: onFilterEvent updates controller.filterEvent', () => {
  const { presenter, controller, view } = makePresenter();
  presenter.attach(makeJournal([]));
  view.onFilterEvent('SELL');
  assert.strictEqual(controller.filterEvent, 'SELL');
});

test('TimelinePresenter: onFilterAction updates controller.filterAction', () => {
  const { presenter, controller, view } = makePresenter();
  presenter.attach(makeJournal([]));
  view.onFilterAction('REALIZE');
  assert.strictEqual(controller.filterAction, 'REALIZE');
});

test('TimelinePresenter: onClearFilters resets both filter values', () => {
  const { presenter, controller, view } = makePresenter();
  presenter.attach(makeJournal([]));
  controller.filterEvent  = 'SELL';
  controller.filterAction = 'REALIZE';
  view.onClearFilters();
  assert.strictEqual(controller.filterEvent,  '');
  assert.strictEqual(controller.filterAction, '');
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

test('TimelinePresenter: onDetail fires onDetail callback with the journal entry', () => {
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
