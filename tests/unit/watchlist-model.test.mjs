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
 * watchlist-model.test.mjs — design 101 W1: migration, the Overview seed, the
 * metrics.<stateKey> alias, persistence round-trip, list/entry maintenance, events.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import {
  WatchlistModel, balanceCopyKeys, aliasWatchPath,
  OVERVIEW_NAME, LEGACY_LIST_NAME, OVERVIEW_SEED_PATH,
} from '../../src/visualization/watchlist/watchlist-model.js';

const entry = (path, extra = {}) => ({ path, label: null, charted: true, axis: 'auto', ...extra });

// ── Migration and the default seed (§5.4, §8.1) ─────────────────────────────

test('no watchlists key: seeds one "Overview" list charting net worth', () => {
  const m = WatchlistModel.fromCfg({});
  assert.deepEqual(m.lists, [{ id: 'w1', name: OVERVIEW_NAME, entries: [entry(OVERVIEW_SEED_PATH)] }]);
  assert.equal(m.activeId, 'w1');
  assert.deepEqual(m.chartedPaths(), ['metrics.netWorth']);
});

test('legacy empty array (no activeWatchlistId): seeded, as today', () => {
  const m = WatchlistModel.fromCfg({ watchlists: [] });
  assert.equal(m.lists.length, 1);
  assert.equal(m.lists[0].name, OVERVIEW_NAME);
});

test('legacy string[]: one "Watchlist" list, every entry charted, order kept', () => {
  const m = WatchlistModel.fromCfg({ watchlists: ['metrics.netWorth', 'effectiveExchangeRates.USD_AUD'] });
  assert.deepEqual(m.lists, [{ id: 'w1', name: LEGACY_LIST_NAME,
    entries: [entry('metrics.netWorth'), entry('effectiveExchangeRates.USD_AUD')] }]);
  assert.deepEqual(m.chartedPaths(), ['metrics.netWorth', 'effectiveExchangeRates.USD_AUD'],
    'an old scenario charts exactly what it charted before');
});

test('the seed is not written back: fromCfg never mutates the cfg', () => {
  const cfg = { watchlists: [] };
  WatchlistModel.fromCfg(cfg);
  assert.deepEqual(cfg, { watchlists: [] });
});

// ── Delete-last: an empty scenario stays empty ─────────────────────────────

test('deleting the last list leaves none, and a reload does not re-seed', () => {
  const m = WatchlistModel.fromCfg({});
  assert.equal(m.delete('w1'), true);
  assert.deepEqual(m.lists, []);
  assert.equal(m.activeId, null);
  assert.deepEqual(m.chartedPaths(), []);

  const cfg = m.applyTo({});
  assert.deepEqual(cfg, { watchlists: [], activeWatchlistId: null });
  const reloaded = WatchlistModel.fromCfg(cfg);
  assert.deepEqual(reloaded.lists, [], 'activeWatchlistId: null marks a deliberate empty');
  assert.equal(reloaded.activeId, null);
});

// ── The metrics.<stateKey> alias (§7) ──────────────────────────────────────

test('alias: a saved account balance copy rewrites to the account balance', () => {
  const cfg = {
    accounts: [{ stateKey: 'usSavingsAccount' }],
    watchlists: ['metrics.usSavingsAccount', 'metrics.netWorth', 'metrics.roth_earnings'],
  };
  assert.deepEqual(WatchlistModel.fromCfg(cfg).chartedPaths(),
    ['usSavingsAccount.balance', 'metrics.netWorth', 'metrics.roth_earnings'],
    'true metrics and flow amounts are left alone');
});

test('alias: a rewrite that collides with an existing entry is dropped, first kept', () => {
  const cfg = {
    accounts: [{ stateKey: 'usSavingsAccount' }],
    watchlists: ['usSavingsAccount.balance', 'metrics.usSavingsAccount'],
  };
  assert.deepEqual(WatchlistModel.fromCfg(cfg).chartedPaths(), ['usSavingsAccount.balance']);
});

test('alias: also covers new-shape entries, keeping their label/charted/axis', () => {
  const cfg = {
    accounts: [{ stateKey: 'iraAccount' }],
    activeWatchlistId: 'w1',
    watchlists: [{ id: 'w1', name: 'Mine', entries: [
      { path: 'metrics.iraAccount', label: 'IRA', charted: false, axis: 'right' },
    ] }],
  };
  assert.deepEqual(WatchlistModel.fromCfg(cfg).lists[0].entries,
    [entry('iraAccount.balance', { label: 'IRA', charted: false, axis: 'right' })]);
});

test('balanceCopyKeys: accounts, property loans and inherited accounts, not inherited assets', () => {
  const keys = balanceCopyKeys({
    accounts:       [{ stateKey: 'usSavingsAccount' }, { stateKey: null }],
    realProperties: [{ stateKey: 'auHouseProperty' }],
    bequests: [{ assets: [
      { stateKey: 'inheritedBrokerageAccount', __type: 'InvestmentAccount' },
      { stateKey: 'inheritedHomeProperty',     __type: 'RealProperty' },
    ] }],
  });
  assert.deepEqual([...keys].sort(),
    ['auHousePropertyLoan', 'inheritedBrokerageAccount', 'usSavingsAccount']);
});

test('aliasWatchPath: only a bare metrics.<key> naming a balance copy is rewritten', () => {
  const keys = new Set(['acct']);
  assert.equal(aliasWatchPath('metrics.acct', keys), 'acct.balance');
  assert.equal(aliasWatchPath('metrics.acct.x', keys), 'metrics.acct.x');
  assert.equal(aliasWatchPath('metrics.other', keys), 'metrics.other');
  assert.equal(aliasWatchPath('acct.balance', keys), 'acct.balance');
});

// ── Round-trip and normalization ────────────────────────────────────────────

test('round-trip: toCfg → fromCfg reproduces lists, entries and the active id', () => {
  const m = WatchlistModel.fromCfg({});
  m.add('usStockAccount.holdings[id=h1].marketValue', { label: 'Tech lot', charted: false, axis: 'left' });
  const second = m.create('Markets');
  m.add('effectiveGrowthRates.EQUITY_US');
  m.setActive('w1');

  const again = WatchlistModel.fromCfg(JSON.parse(JSON.stringify(m.toCfg())));
  assert.deepEqual(again.toCfg(), m.toCfg());
  assert.equal(again.activeId, 'w1');
  assert.equal(again.list(second).name, 'Markets');
});

test('toCfg and reads return copies: mutating them does not reach the model', () => {
  const m = WatchlistModel.fromCfg({});
  m.toCfg().watchlists[0].entries.push(entry('x'));
  m.lists[0].entries[0].charted = false;
  m.active().name = 'Changed';
  assert.deepEqual(m.chartedPaths(), ['metrics.netWorth']);
  assert.equal(m.active().name, OVERVIEW_NAME);
});

test('normalize: bad entries dropped, duplicate paths dropped, axis/label/charted defaulted', () => {
  const m = WatchlistModel.fromCfg({
    activeWatchlistId: 'w1',
    watchlists: [{ id: 'w1', name: '  Mine  ', entries: [
      { path: 'a', axis: 'sideways', label: '   ' }, { path: '' }, null, 42, { path: 'a' }, { path: 'b', charted: false },
    ] }],
  });
  assert.deepEqual(m.lists[0], { id: 'w1', name: 'Mine', entries: [entry('a'), entry('b', { charted: false })] });
});

test('normalize: missing and duplicate ids are reassigned uniquely; a blank name falls back', () => {
  const m = WatchlistModel.fromCfg({
    activeWatchlistId: 'w2',
    watchlists: [{ id: 'w2', name: 'A', entries: [] }, { id: 'w2', name: 'B', entries: [] }, { name: '', entries: [] }],
  });
  const ids = m.lists.map(l => l.id);
  assert.equal(new Set(ids).size, 3, `unique ids: ${ids}`);
  assert.equal(ids[0], 'w2');
  assert.equal(m.lists[2].name, LEGACY_LIST_NAME);
  assert.equal(m.activeId, 'w2');
});

test('normalize: an activeWatchlistId naming no list falls back to the first list', () => {
  const m = WatchlistModel.fromCfg({ activeWatchlistId: 'gone', watchlists: [{ id: 'w7', name: 'A', entries: [] }] });
  assert.equal(m.activeId, 'w7');
});

// ── Entries ─────────────────────────────────────────────────────────────────

test('add: charted by default, rejects duplicates and blanks, targets the active list', () => {
  const m = WatchlistModel.fromCfg({});
  assert.equal(m.add('cash'), true);
  assert.equal(m.add('cash'), false, 'no duplicate');
  assert.equal(m.add('  '), false, 'no blank path');
  assert.equal(m.has('cash'), true);
  assert.deepEqual(m.chartedPaths(), ['metrics.netWorth', 'cash']);
});

test('setCharted / setLabel / setAxis / remove update one entry', () => {
  const m = WatchlistModel.fromCfg({});
  assert.equal(m.setCharted('metrics.netWorth', false), true);
  assert.deepEqual(m.chartedPaths(), [], 'watched but not charted (W-D1)');
  assert.equal(m.has('metrics.netWorth'), true);
  assert.equal(m.setLabel('metrics.netWorth', 'NW'), true);
  assert.equal(m.setAxis('metrics.netWorth', 'right'), true);
  assert.equal(m.setAxis('metrics.netWorth', 'up'), false, 'invalid axis');
  assert.deepEqual(m.active().entries, [entry('metrics.netWorth', { label: 'NW', charted: false, axis: 'right' })]);
  assert.equal(m.remove('metrics.netWorth'), true);
  assert.equal(m.remove('metrics.netWorth'), false);
});

test('moveEntry reorders within the list; out-of-range is a no-op', () => {
  const m = WatchlistModel.fromCfg({ watchlists: ['a', 'b', 'c'] });
  assert.equal(m.moveEntry(0, 2), true);
  assert.deepEqual(m.chartedPaths(), ['b', 'c', 'a']);
  assert.equal(m.moveEntry(0, 9), false);
});

test('chartedPaths is the active list only; capturePaths is every list, deduplicated (W-D2)', () => {
  const m = WatchlistModel.fromCfg({ watchlists: ['a', 'b'] });
  m.setCharted('b', false);
  m.create('Other');
  m.add('b'); m.add('c', { charted: false });
  assert.deepEqual(m.chartedPaths(), ['b']);
  assert.deepEqual(m.capturePaths(), ['a', 'b', 'c']);
});

// ── Lists ───────────────────────────────────────────────────────────────────

test('create / duplicate activate the new list; rename rejects blanks', () => {
  const m = WatchlistModel.fromCfg({});
  const id = m.create('Markets');
  assert.equal(m.activeId, id);
  m.add('effectiveGrowthRates.EQUITY_US');
  const copy = m.duplicate(id);
  assert.equal(m.activeId, copy);
  assert.deepEqual(m.lists.map(l => l.name), [OVERVIEW_NAME, 'Markets', 'Markets copy']);
  assert.deepEqual(m.list(copy).entries, m.list(id).entries);
  assert.equal(m.rename(copy, ' '), false);
  assert.equal(m.rename(copy, 'Indices'), true);
  assert.equal(m.list(copy).name, 'Indices');
});

test('delete: removing the active list activates the next, or the previous when last', () => {
  const m = WatchlistModel.fromCfg({});
  const b = m.create('B');
  const c = m.create('C');
  m.setActive(b);
  m.delete(b);
  assert.equal(m.activeId, c, 'the list that took its place');
  m.delete(c);
  assert.equal(m.activeId, 'w1', 'the one before, when it was last');
  assert.equal(m.delete('nope'), false);
});

test('ids stay unique after a delete: a new list never reuses a deleted id', () => {
  const m = WatchlistModel.fromCfg({});
  const b = m.create('B');
  m.delete(b);
  assert.notEqual(m.create('C'), b);
});

test('moveList reorders lists', () => {
  const m = WatchlistModel.fromCfg({});
  m.create('B');
  assert.equal(m.moveList(1, 0), true);
  assert.deepEqual(m.lists.map(l => l.name), ['B', OVERVIEW_NAME]);
});

// ── Events ──────────────────────────────────────────────────────────────────

test('onChange: fires with reason/id/path on change, not on a no-op; unsubscribes', () => {
  const m = WatchlistModel.fromCfg({});
  const seen = [];
  const off = m.onChange(e => seen.push(e));
  m.add('cash');
  m.add('cash');                              // no-op
  m.setCharted('cash', true);                 // no-op: already charted
  m.setCharted('cash', false);
  m.setActive('w1');                          // no-op: already active
  off();
  m.remove('cash');
  assert.deepEqual(seen, [
    { reason: 'add',     watchlistId: 'w1', path: 'cash' },
    { reason: 'charted', watchlistId: 'w1', path: 'cash' },
  ]);
});
