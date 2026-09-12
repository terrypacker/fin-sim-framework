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
 * watchlist-controller.test.mjs — design 101 W2: the model drives the chart (active
 * list's charted entries), capture (every list), the State panel checkbox/picker, the
 * cfg, and WATCHLIST_CHANGED.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { WatchlistController } from '../../src/visualization/watchlist/watchlist-controller.js';
import { WB_EVENTS }           from '../../src/visualization/workbench/workbench-runtime.js';
import { EventBus }            from '../../src/simulation-framework/event-bus.js';

function rig(cfg = {}) {
  const chart      = { charted: null, syncActivePaths(paths) { this.charted = [...paths]; } };
  const capture    = { paths: null, setPaths(p) { this.paths = [...p]; } };
  const statePanel = { lists: null, activeId: null, renders: 0,
    setWatchlists(lists, activeId) { this.lists = lists; this.activeId = activeId; },
    render() { this.renders++; } };
  const bus    = new EventBus();
  const events = [];
  bus.subscribe(WB_EVENTS.WATCHLIST_CHANGED, e => events.push(e));
  const ctl = new WatchlistController({ cfg, chart, capture, statePanel, bus });
  ctl.start();
  return { ctl, cfg, chart, capture, statePanel, events };
}

test('start: syncs the seeded list everywhere, announces it, and writes nothing', () => {
  const { cfg, chart, capture, statePanel, events } = rig({});
  assert.deepEqual(chart.charted, ['metrics.netWorth']);
  assert.deepEqual(capture.paths, ['metrics.netWorth']);
  assert.deepEqual(statePanel.lists, [{ id: 'w1', name: 'Overview' }]);
  assert.equal(statePanel.activeId, 'w1');
  assert.deepEqual(events.map(e => e.reason), ['load']);
  assert.deepEqual(cfg, {}, 'an untouched scenario stays byte-identical');
});

test('checking a row adds a charted entry: charted, captured, persisted, announced (W-D4)', () => {
  const { ctl, cfg, chart, capture, events } = rig({});
  assert.equal(ctl.toggleWatched('acct.balance', true), true);
  assert.equal(ctl.isWatched('acct.balance'), true);
  assert.deepEqual(chart.charted, ['metrics.netWorth', 'acct.balance']);
  assert.deepEqual(capture.paths, ['metrics.netWorth', 'acct.balance']);
  assert.equal(cfg.activeWatchlistId, 'w1');
  assert.deepEqual(cfg.watchlists[0].entries.map(e => e.path), ['metrics.netWorth', 'acct.balance']);
  assert.deepEqual(events.at(-1), { type: WB_EVENTS.WATCHLIST_CHANGED, reason: 'add', watchlistId: 'w1', path: 'acct.balance' });
});

test('unchecking a row removes the entry', () => {
  const { ctl, chart, cfg } = rig({});
  ctl.toggleWatched('metrics.netWorth', false);
  assert.equal(ctl.isWatched('metrics.netWorth'), false);
  assert.deepEqual(chart.charted, []);
  assert.deepEqual(cfg.watchlists[0].entries, []);
});

test('chip ✕ un-charts but keeps the watch, which is still captured (W-D5, W-D2)', () => {
  const { ctl, chart, capture } = rig({});
  ctl.uncharted('metrics.netWorth');
  assert.deepEqual(chart.charted, []);
  assert.equal(ctl.isWatched('metrics.netWorth'), true, 'checkbox stays checked');
  assert.deepEqual(capture.paths, ['metrics.netWorth'], 'still buffered at full resolution');
});

test('selecting a list charts that list; capture covers every list', () => {
  const cfg = { activeWatchlistId: 'w1', watchlists: [
    { id: 'w1', name: 'A', entries: [{ path: 'a', charted: true }] },
    { id: 'w2', name: 'B', entries: [{ path: 'b', charted: true }, { path: 'c', charted: false }] },
  ] };
  const { ctl, chart, capture, statePanel } = rig(cfg);
  assert.deepEqual(chart.charted, ['a']);
  assert.deepEqual(capture.paths, ['a', 'b', 'c']);
  assert.equal(ctl.selectList('w2'), true);
  assert.deepEqual(chart.charted, ['b']);
  assert.equal(statePanel.activeId, 'w2');
  assert.equal(ctl.isWatched('a'), false, 'checkboxes follow the active list');
  assert.equal(cfg.activeWatchlistId, 'w2', 'the choice persists');
});

test('with every list deleted, checking a row creates one rather than doing nothing', () => {
  const { ctl, chart, cfg } = rig({ watchlists: [], activeWatchlistId: null });
  assert.deepEqual(chart.charted, [], 'empty stays empty (not re-seeded)');
  ctl.toggleWatched('acct.balance', true);
  assert.deepEqual(chart.charted, ['acct.balance']);
  assert.equal(cfg.watchlists[0].name, 'Watchlist');
});

test('facade: has / add / remove / active, the cross-panel contract (§8)', () => {
  const { ctl, chart } = rig({});
  const wl = ctl.facade();
  assert.equal(wl.has('metrics.netWorth'), true);
  assert.equal(wl.add('idx', { charted: false, label: 'Index' }), true);
  assert.equal(wl.has('idx'), true);
  assert.deepEqual(chart.charted, ['metrics.netWorth'], 'added uncharted');
  assert.equal(wl.active().entries.at(-1).label, 'Index');
  assert.equal(wl.remove('idx'), true);
  assert.equal(wl.has('idx'), false);
});

test('facade: maintenance, series, and the chart receives each charted entry\'s label/axis (W3)', () => {
  const { ctl, chart } = rig({});
  chart.meta = null;
  chart.applySeriesMeta = function (entries) { this.meta = entries.map(({ path, label, axis }) => ({ path, label, axis })); };
  const wl = ctl.facade();
  assert.deepEqual(wl.lists(), [{ id: 'w1', name: 'Overview', size: 1 }]);
  assert.equal(wl.setLabel('metrics.netWorth', 'NW'), true);
  assert.equal(wl.setAxis('metrics.netWorth', 'right'), true);
  assert.deepEqual(chart.meta, [{ path: 'metrics.netWorth', label: 'NW', axis: 'right' }]);

  const id = wl.create('Markets');
  assert.equal(wl.activeId(), id);
  assert.equal(wl.rename(id, 'Indices'), true);
  const copy = wl.duplicate(id);
  assert.equal(wl.delete(copy), true);
  assert.equal(wl.setActive('w1'), true);
  wl.add('a'); wl.add('b');
  assert.equal(wl.moveEntry(2, 0), true);
  assert.deepEqual(wl.active().entries.map(e => e.path), ['b', 'metrics.netWorth', 'a']);
  assert.equal(wl.setCharted('a', false), true);
  assert.deepEqual(wl.series('anything'), [], 'no store: an empty series, not a throw');
});

test('destroy: the controller stops reacting to the model', () => {
  const { ctl, chart } = rig({});
  ctl.destroy();
  ctl.model.add('late');
  assert.deepEqual(chart.charted, ['metrics.netWorth']);
});
