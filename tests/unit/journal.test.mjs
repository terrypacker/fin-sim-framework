/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Journal, JournalEntry } from '../../src/simulation-framework/journal.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides = {}) {
  return new JournalEntry({
    id:          overrides.id          ?? crypto.randomUUID(),
    date:        overrides.date        ?? new Date(2025, 0, 1),
    executionId: overrides.executionId ?? null,
    event:       overrides.event       ?? { nodeId: null, type: 'TICK', name: 'Tick', color: null },
    action:      overrides.action      ?? {
      instanceId:   crypto.randomUUID(),
      parentId:     null,
      rootId:       null,
      siblingIndex: 0,
      nodeId:       null,
      type:         'INCREMENT',
      name:         'Increment',
      data:         { amount: 10 },
    },
    reducer:             overrides.reducer             ?? { nodeId: null, name: 'MyReducer' },
    stateDiff:           overrides.stateDiff           ?? [],
    emittedInstanceIds:  overrides.emittedInstanceIds  ?? [],
    emittedTypes:        overrides.emittedTypes        ?? [],
  });
}

// ─── JournalEntry construction ────────────────────────────────────────────────

test('JournalEntry: all fields are assigned correctly', () => {
  const id     = crypto.randomUUID();
  const date   = new Date(2025, 5, 15);
  const event  = { nodeId: 'ev1', type: 'SOURCE_EVENT', name: 'Source Event', color: '#f00' };
  const action = {
    instanceId: 'a1', parentId: null, rootId: null, siblingIndex: 0,
    nodeId: 'act1', type: 'FOO', name: 'Foo', data: { amount: 99 },
  };
  const reducer = { nodeId: 'r1', name: 'R1' };
  const diff    = [{ field: 'x', before: 0, after: 99, delta: 99 }];
  const emittedIds   = ['uuid-bar'];
  const emittedTypes = ['BAR'];

  const entry = new JournalEntry({
    id, date, executionId: 'e1.1:h1.1:a1.1:r1.1',
    event, action, reducer,
    stateDiff: diff,
    emittedInstanceIds: emittedIds,
    emittedTypes,
  });

  assert.strictEqual(entry.id,                  id);
  assert.strictEqual(entry.date,                date);
  assert.strictEqual(entry.executionId,         'e1.1:h1.1:a1.1:r1.1');
  assert.strictEqual(entry.event.type,          'SOURCE_EVENT');
  assert.strictEqual(entry.event.color,         '#f00');
  assert.strictEqual(entry.action.type,         'FOO');
  assert.strictEqual(entry.action.data.amount,  99);
  assert.strictEqual(entry.reducer.name,        'R1');
  assert.strictEqual(entry.stateDiff,           diff);
  assert.deepStrictEqual(entry.emittedInstanceIds, emittedIds);
  assert.deepStrictEqual(entry.emittedTypes,       emittedTypes);
});

// ─── Journal construction ──────────────────────────────────────────────────────

test('Journal: enabled flag is set from constructor option', () => {
  assert.strictEqual(new Journal({ enabled: true  }).enabled, true);
  assert.strictEqual(new Journal({ enabled: false }).enabled, false);
});

test('Journal: starts with an empty journal array', () => {
  const j = new Journal({ enabled: true });
  assert.strictEqual(j.journal.length, 0);
});

// ─── addEntry + seq ───────────────────────────────────────────────────────────

test('Journal.addEntry: adds entry to journal array', () => {
  const j = new Journal({ enabled: true });
  j.addEntry(makeEntry());
  assert.strictEqual(j.journal.length, 1);
});

test('Journal.addEntry: assigns monotonically increasing seq', () => {
  const j = new Journal({ enabled: true });
  const e1 = makeEntry();
  const e2 = makeEntry();
  const e3 = makeEntry();
  j.addEntry(e1);
  j.addEntry(e2);
  j.addEntry(e3);
  assert.strictEqual(e1.seq, 0);
  assert.strictEqual(e2.seq, 1);
  assert.strictEqual(e3.seq, 2);
});

test('Journal.addEntry: multiple entries accumulate in order', () => {
  const j  = new Journal({ enabled: true });
  const e1 = makeEntry({ action: { instanceId: 'i1', parentId: null, rootId: null, siblingIndex: 0, nodeId: null, type: 'A', name: 'A', data: {} } });
  const e2 = makeEntry({ action: { instanceId: 'i2', parentId: null, rootId: null, siblingIndex: 0, nodeId: null, type: 'B', name: 'B', data: {} } });
  const e3 = makeEntry({ action: { instanceId: 'i3', parentId: null, rootId: null, siblingIndex: 0, nodeId: null, type: 'C', name: 'C', data: {} } });

  j.addEntry(e1);
  j.addEntry(e2);
  j.addEntry(e3);

  assert.strictEqual(j.journal.length, 3);
  assert.strictEqual(j.journal[0].action.type, 'A');
  assert.strictEqual(j.journal[1].action.type, 'B');
  assert.strictEqual(j.journal[2].action.type, 'C');
});

// ─── getActions ───────────────────────────────────────────────────────────────

test('Journal.getActions: returns only entries matching the action type', () => {
  const j = new Journal({ enabled: true });

  j.addEntry(makeEntry({ action: { instanceId: 'i1', parentId: null, rootId: null, siblingIndex: 0, nodeId: null, type: 'INC', name: 'Inc', data: { amount: 1 } } }));
  j.addEntry(makeEntry({ action: { instanceId: 'i2', parentId: null, rootId: null, siblingIndex: 0, nodeId: null, type: 'DEC', name: 'Dec', data: { amount: 1 } } }));
  j.addEntry(makeEntry({ action: { instanceId: 'i3', parentId: null, rootId: null, siblingIndex: 0, nodeId: null, type: 'INC', name: 'Inc', data: { amount: 2 } } }));

  const results = j.getActions('INC');
  assert.strictEqual(results.length, 2);
  assert.ok(results.every(e => e.action.type === 'INC'));
});

test('Journal.getActions: returns empty array when no entries match', () => {
  const j = new Journal({ enabled: true });
  j.addEntry(makeEntry({ action: { instanceId: 'i1', parentId: null, rootId: null, siblingIndex: 0, nodeId: null, type: 'INC', name: 'Inc', data: {} } }));

  assert.deepStrictEqual(j.getActions('UNKNOWN'), []);
});

test('Journal.getActions: returns all entries when all match', () => {
  const j = new Journal({ enabled: true });
  j.addEntry(makeEntry({ action: { instanceId: 'i1', parentId: null, rootId: null, siblingIndex: 0, nodeId: null, type: 'INC', name: 'Inc', data: {} } }));
  j.addEntry(makeEntry({ action: { instanceId: 'i2', parentId: null, rootId: null, siblingIndex: 0, nodeId: null, type: 'INC', name: 'Inc', data: {} } }));

  assert.strictEqual(j.getActions('INC').length, 2);
});

// ─── getStateTimeline ─────────────────────────────────────────────────────────

test('Journal.getStateTimeline: returns array of {date, value} for each entry', () => {
  const j  = new Journal({ enabled: true });
  const d1 = new Date(2025, 0, 1);
  const d2 = new Date(2026, 0, 1);

  j.addEntry(makeEntry({ date: d1, stateDiff: [{ field: 'counter', before: 0,  after: 10, delta: 10 }] }));
  j.addEntry(makeEntry({ date: d2, stateDiff: [{ field: 'counter', before: 10, after: 20, delta: 10 }] }));

  const timeline = j.getStateTimeline('counter');
  assert.strictEqual(timeline.length, 2);
  assert.strictEqual(timeline[0].date,  d1);
  assert.strictEqual(timeline[0].value, 10);
  assert.strictEqual(timeline[1].date,  d2);
  assert.strictEqual(timeline[1].value, 20);
});

test('Journal.getStateTimeline: returns empty array when field has no diffs', () => {
  const j = new Journal({ enabled: true });
  j.addEntry(makeEntry({ stateDiff: [{ field: 'counter', before: 0, after: 5, delta: 5 }] }));

  const timeline = j.getStateTimeline('nonexistent');
  assert.strictEqual(timeline.length, 0);
});

// ─── traceEvent ───────────────────────────────────────────────────────────────

test('Journal.traceEvent: returns entries whose date matches exactly', () => {
  const j       = new Journal({ enabled: true });
  const target  = new Date(2025, 5, 15);
  const other   = new Date(2026, 0, 1);

  j.addEntry(makeEntry({ date: target, action: { instanceId: 'i1', parentId: null, rootId: null, siblingIndex: 0, nodeId: null, type: 'A', name: 'A', data: {} } }));
  j.addEntry(makeEntry({ date: other,  action: { instanceId: 'i2', parentId: null, rootId: null, siblingIndex: 0, nodeId: null, type: 'B', name: 'B', data: {} } }));
  j.addEntry(makeEntry({ date: target, action: { instanceId: 'i3', parentId: null, rootId: null, siblingIndex: 0, nodeId: null, type: 'C', name: 'C', data: {} } }));

  const results = j.traceEvent(target);
  assert.strictEqual(results.length, 2);
  assert.ok(results.every(e => e.date.getTime() === target.getTime()));
});

test('Journal.traceEvent: returns empty array when no entries match the date', () => {
  const j = new Journal({ enabled: true });
  j.addEntry(makeEntry({ date: new Date(2025, 0, 1) }));

  const results = j.traceEvent(new Date(2099, 0, 1));
  assert.deepStrictEqual(results, []);
});

// ─── addSnapshot / snapshotBefore ────────────────────────────────────────────

test('Journal.addSnapshot: stores snapshot for a date key', () => {
  const j = new Journal({ enabled: true });
  const state = { balance: 1000 };
  j.addSnapshot(new Date(Date.UTC(2025, 0, 1)), state);
  assert.strictEqual(j.snapshots.size, 1);
});

test('Journal.addSnapshot: first-write-wins for the same date', () => {
  const j = new Journal({ enabled: true });
  j.addSnapshot(new Date(Date.UTC(2025, 0, 1)), { balance: 1000 });
  j.addSnapshot(new Date(Date.UTC(2025, 0, 1)), { balance: 9999 });
  assert.strictEqual(j.snapshots.size, 1);
  // First snapshot wins
  const snap = [...j.snapshots.values()][0];
  assert.strictEqual(snap.state.balance, 1000);
});

test('Journal.snapshotBefore: returns nearest snapshot at or before seq', () => {
  const j = new Journal({ enabled: true });
  j.addEntry(makeEntry()); // seq 0
  j.addEntry(makeEntry()); // seq 1
  j.addSnapshot(new Date(Date.UTC(2025, 0, 1)), { balance: 100 }); // snap at seq=2
  j.addEntry(makeEntry()); // seq 2
  j.addEntry(makeEntry()); // seq 3

  const snap = j.snapshotBefore(3);
  assert.ok(snap !== null, 'should find a snapshot');
  assert.strictEqual(snap.state.balance, 100);
});

test('Journal.snapshotBefore: returns null when no snapshot exists at or before seq', () => {
  const j = new Journal({ enabled: true });
  j.addEntry(makeEntry()); // seq 0
  j.addSnapshot(new Date(Date.UTC(2025, 6, 1)), { balance: 500 }); // snap at seq=1

  const snap = j.snapshotBefore(0);
  assert.strictEqual(snap, null, 'snapshot was created after seq 0, should not be returned');
});
