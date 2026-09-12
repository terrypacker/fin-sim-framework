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
 * watch-capture.test.mjs — design 101 W2: every watched path is buffered at full
 * resolution from the sim bus, charted or not.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { WatchCapture }     from '../../src/visualization/watchlist/watch-capture.js';
import { FieldSeriesStore } from '../../src/visualization/state/field-series-store.js';
import { EventBus }         from '../../src/simulation-framework/event-bus.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../src/simulation-framework/bus-messages.js';

const END = `EXECUTION_${EXECUTION_PHASES.END}`;
const msg = (date, state, kind = EXECUTION_KINDS.EVENT) =>
  ({ type: END, kind, date: new Date(date).toISOString(), stateSnapshot: state });

function wired(paths) {
  const store   = new FieldSeriesStore();
  const bus     = new EventBus();
  const capture = new WatchCapture({ fieldStore: store });
  capture.setPaths(paths);
  capture.wireSimBus(bus);
  return { store, bus, capture };
}

const values = (store, path) => (store.get(path) ?? []).map(p => p.value);

test('every event appends each watched path, synchronously', () => {
  const { store, bus } = wired(['acct.balance', 'acct.holdings[id=h1].marketValue']);
  bus.publish(msg('2030-01-01', { acct: { balance: 1, holdings: [{ id: 'h1', marketValue: 10 }] } }));
  bus.publish(msg('2030-02-01', { acct: { balance: 2, holdings: [{ id: 'h1', marketValue: 11 }] } }));
  assert.deepEqual(values(store, 'acct.balance'), [1, 2]);
  assert.deepEqual(values(store, 'acct.holdings[id=h1].marketValue'), [10, 11]);
});

test('only EXECUTION_END(EVENT) is captured, not handler/action ends', () => {
  const { store, bus } = wired(['x']);
  bus.publish(msg('2030-01-01', { x: 1 }, EXECUTION_KINDS.HANDLER));
  assert.equal(store.get('x'), null);
});

test('a path absent at a date is skipped, then captured once it appears', () => {
  const { store, bus } = wired(['acct.holdings[id=new].marketValue']);
  bus.publish(msg('2030-01-01', { acct: { holdings: [] } }));
  bus.publish(msg('2035-01-01', { acct: { holdings: [{ id: 'new', marketValue: 7 }] } }));
  assert.deepEqual(values(store, 'acct.holdings[id=new].marketValue'), [7]);
});

test('setPaths replaces the capture set from the next event, deduplicated', () => {
  const { store, bus, capture } = wired(['a']);
  bus.publish(msg('2030-01-01', { a: 1, b: 1 }));
  capture.setPaths(['b', 'b']);
  assert.deepEqual(capture.paths, ['b']);
  bus.publish(msg('2030-02-01', { a: 2, b: 2 }));
  assert.deepEqual(values(store, 'a'), [1]);
  assert.deepEqual(values(store, 'b'), [2]);
});

test('destroy unsubscribes; re-wiring drops the previous bus', () => {
  const { store, bus, capture } = wired(['a']);
  const bus2 = new EventBus();
  capture.wireSimBus(bus2);
  bus.publish(msg('2030-01-01', { a: 1 }));
  bus2.publish(msg('2030-02-01', { a: 2 }));
  capture.destroy();
  bus2.publish(msg('2030-03-01', { a: 3 }));
  assert.deepEqual(values(store, 'a'), [2]);
});
