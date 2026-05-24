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
 * indexed-min-heap.test.mjs
 * Tests for IndexedMinHeap
 * Run with: node --test tests/indexed-min-heap.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IndexedMinHeap } from '../src/simulation-framework/indexed-min-heap.js';

// Mirrors how Simulation uses the heap:
//   compareFn: (a, b) => a.date - b.date
//   keyFn:     item => item.instanceId
//   typeFn:    item => item.type
const dateCmp  = (a, b) => a.date - b.date;
const keyFn    = item => item.instanceId;
const typeFn   = item => item.type;

function makeHeap() {
  return new IndexedMinHeap(dateCmp, keyFn, typeFn);
}

// Helper — creates a minimal event object matching the Simulation pattern
let nextId = 0;
function evt(date, type, extra = {}) {
  return { instanceId: nextId++, date: new Date(date), type, ...extra };
}

// Reset the counter before each group so tests are independent
function resetId() { nextId = 0; }

// ─── Empty heap ───────────────────────────────────────────────────────────────

test('IndexedMinHeap: empty heap has size 0', () => {
  resetId();
  const h = makeHeap();
  assert.strictEqual(h.size(), 0);
});

test('IndexedMinHeap: peek on empty heap returns null', () => {
  resetId();
  const h = makeHeap();
  assert.strictEqual(h.peek(), null);
});

test('IndexedMinHeap: pop on empty heap returns null', () => {
  resetId();
  const h = makeHeap();
  assert.strictEqual(h.pop(), null);
});

test('IndexedMinHeap: has() returns false on empty heap', () => {
  resetId();
  const h = makeHeap();
  assert.strictEqual(h.has(0), false);
});

// ─── push / size / peek ───────────────────────────────────────────────────────

test('IndexedMinHeap: push one item — size becomes 1', () => {
  resetId();
  const h = makeHeap();
  h.push(evt('2026-01-01', 'salary'));
  assert.strictEqual(h.size(), 1);
});

test('IndexedMinHeap: peek returns the min item without removing it', () => {
  resetId();
  const h = makeHeap();
  const e1 = evt('2026-06-01', 'rent');
  const e2 = evt('2026-01-01', 'salary');
  h.push(e1);
  h.push(e2);
  assert.strictEqual(h.peek(), e2);       // earlier date wins
  assert.strictEqual(h.size(), 2);        // not consumed
});

test('IndexedMinHeap: has() returns true after push', () => {
  resetId();
  const h = makeHeap();
  const e = evt('2026-01-01', 'salary');
  h.push(e);
  assert.strictEqual(h.has(e.instanceId), true);
});

test('IndexedMinHeap: push duplicate key throws', () => {
  resetId();
  const h = makeHeap();
  const e = evt('2026-01-01', 'salary');
  h.push(e);
  // Build an item with the same instanceId
  const dup = { ...e };
  assert.throws(() => h.push(dup), /Duplicate key/);
});

// ─── pop ordering ────────────────────────────────────────────────────────────

test('IndexedMinHeap: pop returns items in ascending date order', () => {
  resetId();
  const h = makeHeap();
  const d1 = new Date('2026-03-01');
  const d2 = new Date('2026-01-01');
  const d3 = new Date('2026-06-01');

  const e1 = evt(d1, 'rent');
  const e2 = evt(d2, 'salary');
  const e3 = evt(d3, 'dividend');

  h.push(e1);
  h.push(e2);
  h.push(e3);

  assert.strictEqual(h.pop(), e2);  // Jan
  assert.strictEqual(h.pop(), e1);  // Mar
  assert.strictEqual(h.pop(), e3);  // Jun
  assert.strictEqual(h.size(), 0);
});

test('IndexedMinHeap: pop removes the item from indexMap and typeMap', () => {
  resetId();
  const h = makeHeap();
  const e = evt('2026-01-01', 'salary');
  h.push(e);
  h.pop();
  assert.strictEqual(h.has(e.instanceId), false);
  assert.strictEqual(h.size(), 0);
});

test('IndexedMinHeap: pop on single-item heap leaves it clean', () => {
  resetId();
  const h = makeHeap();
  const e = evt('2026-01-01', 'salary');
  h.push(e);
  h.pop();
  assert.strictEqual(h.size(), 0);
  assert.strictEqual(h.peek(), null);
});

// ─── removeByKey ──────────────────────────────────────────────────────────────

test('IndexedMinHeap: removeByKey removes a known key and returns true', () => {
  resetId();
  const h = makeHeap();
  const e = evt('2026-01-01', 'salary');
  h.push(e);
  const result = h.removeByKey(e.instanceId);
  assert.strictEqual(result, true);
  assert.strictEqual(h.size(), 0);
  assert.strictEqual(h.has(e.instanceId), false);
});

test('IndexedMinHeap: removeByKey returns false for unknown key', () => {
  resetId();
  const h = makeHeap();
  assert.strictEqual(h.removeByKey(9999), false);
});

test('IndexedMinHeap: removeByKey mid-heap preserves order', () => {
  resetId();
  const h = makeHeap();
  const e1 = evt('2026-01-01', 'salary');
  const e2 = evt('2026-03-01', 'rent');
  const e3 = evt('2026-06-01', 'dividend');
  h.push(e1);
  h.push(e2);
  h.push(e3);

  h.removeByKey(e2.instanceId);   // remove the middle item

  assert.strictEqual(h.size(), 2);
  assert.strictEqual(h.pop(), e1);
  assert.strictEqual(h.pop(), e3);
});

test('IndexedMinHeap: removeByKey the minimum item — next peek is correct', () => {
  resetId();
  const h = makeHeap();
  const e1 = evt('2026-01-01', 'salary');
  const e2 = evt('2026-06-01', 'dividend');
  h.push(e1);
  h.push(e2);

  h.removeByKey(e1.instanceId);
  assert.strictEqual(h.peek(), e2);
});

test('IndexedMinHeap: removeByKey clears typeMap entry when last of that type', () => {
  resetId();
  const h = makeHeap();
  const e = evt('2026-01-01', 'salary');
  h.push(e);
  h.removeByKey(e.instanceId);
  // typeMap entry should be gone — verify via removeAllByType returning 0
  assert.strictEqual(h.removeAllByType('salary'), 0);
});

// ─── update ───────────────────────────────────────────────────────────────────

test('IndexedMinHeap: update returns false for unknown key', () => {
  resetId();
  const h = makeHeap();
  const ghost = evt('2026-01-01', 'salary');
  assert.strictEqual(h.update(ghost), false);
});

test('IndexedMinHeap: update (decrease-key) moves item to the top', () => {
  resetId();
  const h = makeHeap();
  const e1 = evt('2026-01-01', 'salary');
  const e2 = evt('2026-06-01', 'rent');
  h.push(e1);
  h.push(e2);

  // Move e2 earlier than e1
  const updated = { ...e2, date: new Date('2025-12-01') };
  h.update(updated);

  assert.strictEqual(h.peek().instanceId, e2.instanceId);
});

test('IndexedMinHeap: update (increase-key) sinks item down', () => {
  resetId();
  const h = makeHeap();
  const e1 = evt('2026-01-01', 'salary');
  const e2 = evt('2026-03-01', 'rent');
  const e3 = evt('2026-06-01', 'dividend');
  h.push(e1);
  h.push(e2);
  h.push(e3);

  // Push e1 to the back
  const updated = { ...e1, date: new Date('2027-01-01') };
  h.update(updated);

  assert.strictEqual(h.pop().instanceId, e2.instanceId);
  assert.strictEqual(h.pop().instanceId, e3.instanceId);
  assert.strictEqual(h.pop().instanceId, e1.instanceId);
});

test('IndexedMinHeap: update returns true and item is still in indexMap', () => {
  resetId();
  const h = makeHeap();
  const e = evt('2026-01-01', 'salary');
  h.push(e);
  const updated = { ...e, date: new Date('2026-06-01') };
  assert.strictEqual(h.update(updated), true);
  assert.strictEqual(h.has(e.instanceId), true);
});

// ─── removeAllByType ─────────────────────────────────────────────────────────

test('IndexedMinHeap: removeAllByType returns 0 for unknown type', () => {
  resetId();
  const h = makeHeap();
  assert.strictEqual(h.removeAllByType('ghost'), 0);
});

test('IndexedMinHeap: removeAllByType removes every item of that type', () => {
  resetId();
  const h = makeHeap();
  h.push(evt('2026-01-01', 'salary'));
  h.push(evt('2026-02-01', 'salary'));
  h.push(evt('2026-03-01', 'salary'));
  h.push(evt('2026-04-01', 'rent'));

  const removed = h.removeAllByType('salary');
  assert.strictEqual(removed, 3);
  assert.strictEqual(h.size(), 1);
  assert.strictEqual(h.peek().type, 'rent');
});

test('IndexedMinHeap: removeAllByType leaves heap valid for remaining types', () => {
  resetId();
  const h = makeHeap();
  const r1 = evt('2026-05-01', 'rent');
  const s1 = evt('2026-01-01', 'salary');
  const s2 = evt('2026-03-01', 'salary');
  const r2 = evt('2026-07-01', 'rent');

  h.push(r1); h.push(s1); h.push(s2); h.push(r2);
  h.removeAllByType('salary');

  assert.strictEqual(h.pop().instanceId, r1.instanceId);  // May
  assert.strictEqual(h.pop().instanceId, r2.instanceId);  // Jul
});

test('IndexedMinHeap: removeAllByType on the only type leaves heap empty', () => {
  resetId();
  const h = makeHeap();
  h.push(evt('2026-01-01', 'salary'));
  h.push(evt('2026-02-01', 'salary'));
  h.removeAllByType('salary');
  assert.strictEqual(h.size(), 0);
  assert.strictEqual(h.peek(), null);
});

// ─── typeMap integrity ────────────────────────────────────────────────────────

test('IndexedMinHeap: typeMap tracks multiple types independently', () => {
  resetId();
  const h = makeHeap();
  h.push(evt('2026-01-01', 'salary'));
  h.push(evt('2026-02-01', 'rent'));
  h.push(evt('2026-03-01', 'dividend'));

  h.removeAllByType('rent');
  assert.strictEqual(h.size(), 2);

  // salary and dividend still present
  const popped = [h.pop(), h.pop()];
  const types = popped.map(e => e.type).sort();
  assert.deepStrictEqual(types, ['dividend', 'salary']);
});

// ─── Large / stress ───────────────────────────────────────────────────────────

test('IndexedMinHeap: 100 random-order items pop in sorted date order', () => {
  resetId();
  const h = makeHeap();
  const base = new Date('2026-01-01').getTime();
  const DAY  = 86400000;

  // Push days 99..0 (reverse order)
  for (let i = 99; i >= 0; i--) {
    h.push(evt(new Date(base + i * DAY), 'salary'));
  }

  assert.strictEqual(h.size(), 100);

  let prev = null;
  while (h.size() > 0) {
    const item = h.pop();
    if (prev !== null) {
      assert.ok(item.date >= prev, `${item.date} should be >= ${prev}`);
    }
    prev = item.date;
  }
});

// ─── restoreData ─────────────────────────────────────────────────────────────

test('IndexedMinHeap: restoreData rebuilds indexMap so pop actually removes items', () => {
  resetId();
  const h = makeHeap();
  h.push(evt('2026-01-01', 'salary'));
  h.push(evt('2026-03-01', 'rent'));
  h.push(evt('2026-06-01', 'dividend'));

  // Simulate what restoreSnapshot does: grab a snapshot of data, then restore
  const snapshot = h.data.map(e => ({ ...e, date: new Date(e.date) }));
  h.restoreData(snapshot);

  // Without the fix, pop() returns the min but never removes it → infinite loop
  const popped = [];
  while (h.size() > 0) popped.push(h.pop());

  assert.strictEqual(popped.length, 3);
});

test('IndexedMinHeap: restoreData — items pop in correct date order after restore', () => {
  resetId();
  const h = makeHeap();
  const e1 = evt('2026-01-01', 'salary');
  const e2 = evt('2026-03-01', 'rent');
  const e3 = evt('2026-06-01', 'dividend');
  h.push(e3); h.push(e1); h.push(e2);  // push out of order

  const snapshot = h.data.map(e => ({ ...e, date: new Date(e.date) }));
  h.restoreData(snapshot);

  assert.strictEqual(h.pop().instanceId, e1.instanceId);
  assert.strictEqual(h.pop().instanceId, e2.instanceId);
  assert.strictEqual(h.pop().instanceId, e3.instanceId);
});

test('IndexedMinHeap: restoreData — has() reflects restored contents', () => {
  resetId();
  const h = makeHeap();
  const e1 = evt('2026-01-01', 'salary');
  const e2 = evt('2026-06-01', 'rent');
  h.push(e1); h.push(e2);

  const snapshot = h.data.map(e => ({ ...e, date: new Date(e.date) }));

  // Clear the heap, then restore
  h.restoreData([]);
  assert.strictEqual(h.size(), 0);

  h.restoreData(snapshot);
  assert.strictEqual(h.has(e1.instanceId), true);
  assert.strictEqual(h.has(e2.instanceId), true);
});

test('IndexedMinHeap: restoreData — removeAllByType works after restore', () => {
  resetId();
  const h = makeHeap();
  h.push(evt('2026-01-01', 'salary'));
  h.push(evt('2026-02-01', 'salary'));
  h.push(evt('2026-03-01', 'rent'));

  const snapshot = h.data.map(e => ({ ...e, date: new Date(e.date) }));
  h.restoreData(snapshot);

  assert.strictEqual(h.removeAllByType('salary'), 2);
  assert.strictEqual(h.size(), 1);
  assert.strictEqual(h.peek().type, 'rent');
});

// ─── Simulation-style usage (combined workflow) ───────────────────────────────

test('IndexedMinHeap: schedule → unschedule one type, remainder fires in order', () => {
  resetId();
  const h = makeHeap();

  // Mix of salary (recurring) and rent events
  h.push(evt('2026-01-01', 'salary'));
  h.push(evt('2026-01-15', 'rent'));
  h.push(evt('2026-02-01', 'salary'));
  h.push(evt('2026-02-15', 'rent'));
  h.push(evt('2026-03-01', 'salary'));

  // Cancel all salary events (like sim.unschedule())
  h.removeAllByType('salary');

  const fired = [];
  while (h.size() > 0) fired.push(h.pop().type);

  assert.deepStrictEqual(fired, ['rent', 'rent']);
});
