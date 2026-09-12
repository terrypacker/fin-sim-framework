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
 * watchlist-io.test.mjs — design 101 W4: definition export/import and the series CSV
 * (§8.1), plus WatchlistModel.importLists.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { toDefinition, parseDefinition, unresolvedPaths, buildSeriesCsv, WATCHLIST_FORMAT }
  from '../../src/visualization/watchlist/watchlist-io.js';
import { WatchlistModel } from '../../src/visualization/watchlist/watchlist-model.js';
import { UTF8_BOM }       from '../../src/utils/csv.js';

const LISTS = [
  { name: 'Markets', entries: [
    { path: 'marketIndex.EQUITY_US.price', label: null, charted: true, axis: 'right' },
    { path: 'usStockAccount.holdings[id=h1].marketValue', label: 'Employer', charted: false, axis: 'auto' },
  ] },
];

// ── Definition JSON ─────────────────────────────────────────────────────────

test('definition: round-trips names and entries, carries no ids', () => {
  const def = toDefinition(LISTS, { exportedAt: new Date('2026-09-12T00:00:00Z') });
  assert.equal(def.format, WATCHLIST_FORMAT);
  assert.equal(def.version, 1);
  assert.equal(def.exportedAt, '2026-09-12T00:00:00.000Z');
  assert.ok(!('id' in def.watchlists[0]), 'ids are per scenario; an import is given fresh ones');
  assert.deepEqual(parseDefinition(JSON.stringify(def)), LISTS);
});

test('definition: a BOM, a scenario cfg and the legacy string[] shape are all read', () => {
  assert.deepEqual(parseDefinition(UTF8_BOM + JSON.stringify(toDefinition(LISTS))), LISTS);
  const cfg = { name: 'Plan', activeWatchlistId: 'w3', watchlists: [{ id: 'w3', name: 'Mine', entries: ['a.b'] }] };
  assert.deepEqual(parseDefinition(cfg), [{ name: 'Mine', entries: ['a.b'] }]);
  assert.deepEqual(parseDefinition({ watchlists: ['metrics.netWorth', 'x.y'] }),
    [{ name: 'Watchlist', entries: ['metrics.netWorth', 'x.y'] }]);
});

test('definition: a bad file says what is wrong with it', () => {
  assert.throws(() => parseDefinition('{nope'), /not valid JSON/);
  assert.throws(() => parseDefinition({ format: 'finsim.scenarios', watchlists: [] }), /not a watchlist export/);
  assert.throws(() => parseDefinition({ format: WATCHLIST_FORMAT, version: 2, watchlists: [] }), /newer version/);
  assert.throws(() => parseDefinition({ scenarios: [] }), /no "watchlists" array/);
  assert.throws(() => parseDefinition({ watchlists: [] }), /no watchlists in it/);
});

test('unresolvedPaths: what another scenario names and this one lacks, once each', () => {
  const state = { marketIndex: { EQUITY_US: { price: 131 } }, usStockAccount: { holdings: [{ id: 'h2', marketValue: 5 }] } };
  const lists = [...LISTS, { name: 'Again', entries: ['usStockAccount.holdings[id=h1].marketValue', 'nan.value'] }];
  assert.deepEqual(unresolvedPaths(lists, { ...state, nan: { value: NaN } }),
    ['usStockAccount.holdings[id=h1].marketValue', 'nan.value']);
  assert.equal(unresolvedPaths(lists, null), null, 'no run: nothing to check against');
});

// ── WatchlistModel.importLists ──────────────────────────────────────────────

test('importLists: fresh ids, unique names, aliases, first one active, one event', () => {
  const m = WatchlistModel.fromCfg({ activeWatchlistId: 'w1', watchlists: [{ id: 'w1', name: 'Markets', entries: [] }] });
  const events = [];
  m.onChange(e => events.push(e));
  const ids = m.importLists([
    { name: 'Markets', entries: ['metrics.usSavingsAccount', { path: 'x.y', charted: false }, 'x.y'] },
    { name: '  ', entries: [] },
    'not a list',
  ], new Set(['usSavingsAccount']));

  assert.deepEqual(ids, ['w2', 'w3']);
  assert.deepEqual(m.lists.map(l => l.name), ['Markets', 'Markets (imported)', 'Watchlist']);
  assert.deepEqual(m.list('w2').entries.map(e => `${e.path}:${e.charted}`),
    ['usSavingsAccount.balance:true', 'x.y:false'], 'aliased, normalized, deduplicated');
  assert.equal(m.activeId, 'w2');
  assert.deepEqual(events, [{ reason: 'import', watchlistId: 'w2' }]);
  assert.deepEqual(m.importLists([]), [], 'nothing to import: no event');
  assert.equal(events.length, 1);

  m.importLists([{ name: 'Markets', entries: [] }]);
  assert.equal(m.lists.at(-1).name, 'Markets (imported 2)', 'not "Markets (2)", which the picker would print as "Markets (2) (0)"');
});

// ── Series CSV ──────────────────────────────────────────────────────────────

const day = (s, v) => ({ date: new Date(`${s}T00:00:00Z`), value: v });

test('series CSV: a row per day, a column per entry, the last value of a day wins', () => {
  const csv = buildSeriesCsv([
    { path: 'a', header: 'Net Worth (USD)', backfilled: false,
      series: [day('2026-01-01', 1), day('2026-01-01', 2), day('2026-02-01', 3)] },
    { path: 'b', header: 'EQUITY US · Price index', backfilled: false, series: [day('2026-02-01', 100.5)] },
  ]);
  assert.equal(csv, [
    'date,Net Worth (USD),EQUITY US · Price index,resolution',
    '2026-01-01,2,,full',
    '2026-02-01,3,100.5,full',
  ].join('\n'));
});

test('series CSV: resolution says full, snapshot or mixed, per row', () => {
  const csv = buildSeriesCsv([
    { path: 'live', header: 'Live', backfilled: false, series: [day('2026-01-01', 1), day('2027-01-01', 2)] },
    { path: 'late', header: 'Late', backfilled: true,  series: [day('2027-01-01', 9), day('2028-01-01', 8)] },
  ]).split('\n');
  assert.deepEqual(csv.slice(1).map(r => r.split(',').at(-1)), ['full', 'mixed', 'snapshot']);
});

test('series CSV: equal headers are told apart by path; a formula-like label is defused', () => {
  const csv = buildSeriesCsv([
    { path: 'p.one', header: 'Value', backfilled: false, series: [day('2026-01-01', 1)] },
    { path: 'p.two', header: 'Value', backfilled: false, series: [day('2026-01-01', 2)] },
    { path: 'p.three', header: '=HYPERLINK("x")', backfilled: false, series: [day('2026-01-01', -3)] },
  ]);
  assert.equal(csv.split('\n')[0], `date,Value [p.one],Value [p.two],"'=HYPERLINK(""x"")",resolution`);
  assert.equal(csv.split('\n')[1], '2026-01-01,1,2,-3,full', 'a negative NUMBER is not defused');
});

test('series CSV: nothing captured yet is null, not a header-only file', () => {
  assert.equal(buildSeriesCsv([{ path: 'a', header: 'A', backfilled: false, series: [] }]), null);
  assert.equal(buildSeriesCsv([]), null);
});
