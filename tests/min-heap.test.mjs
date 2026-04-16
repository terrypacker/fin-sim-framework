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
 * min-heap.test.mjs
 * Tests for MinHeap
 * Run with: node --test tests/min-heap.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { MinHeap } from '../assets/js/simulation-framework/min-heap.js';

// Numeric comparator — the same style used by Simulation's event queue
const numCmp = (a, b) => a - b;

// ─── Empty heap ───────────────────────────────────────────────────────────────

test('MinHeap: empty heap has size 0', () => {
  const h = new MinHeap(numCmp);
  assert.strictEqual(h.size(), 0);
});

test('MinHeap: peek on empty heap returns null', () => {
  const h = new MinHeap(numCmp);
  assert.strictEqual(h.peek(), null);
});

test('MinHeap: pop on empty heap returns null', () => {
  const h = new MinHeap(numCmp);
  assert.strictEqual(h.pop(), null);
});

// ─── Single element ───────────────────────────────────────────────────────────

test('MinHeap: push one element — size becomes 1', () => {
  const h = new MinHeap(numCmp);
  h.push(42);
  assert.strictEqual(h.size(), 1);
});

test('MinHeap: peek returns the single element without removing it', () => {
  const h = new MinHeap(numCmp);
  h.push(7);
  assert.strictEqual(h.peek(), 7);
  assert.strictEqual(h.size(), 1, 'peek should not change size');
});

test('MinHeap: pop returns the single element and size drops to 0', () => {
  const h = new MinHeap(numCmp);
  h.push(7);
  assert.strictEqual(h.pop(), 7);
  assert.strictEqual(h.size(), 0);
});

// ─── Ordering ─────────────────────────────────────────────────────────────────

test('MinHeap: elements are popped in ascending order', () => {
  const h = new MinHeap(numCmp);
  h.push(5);
  h.push(1);
  h.push(3);
  h.push(2);
  h.push(4);

  const result = [];
  while (h.size() > 0) result.push(h.pop());

  assert.deepStrictEqual(result, [1, 2, 3, 4, 5]);
});

test('MinHeap: already-sorted input still pops in order', () => {
  const h = new MinHeap(numCmp);
  [1, 2, 3, 4, 5].forEach(n => h.push(n));

  const result = [];
  while (h.size() > 0) result.push(h.pop());

  assert.deepStrictEqual(result, [1, 2, 3, 4, 5]);
});

test('MinHeap: reverse-sorted input pops in ascending order', () => {
  const h = new MinHeap(numCmp);
  [5, 4, 3, 2, 1].forEach(n => h.push(n));

  const result = [];
  while (h.size() > 0) result.push(h.pop());

  assert.deepStrictEqual(result, [1, 2, 3, 4, 5]);
});

// ─── Peek vs pop ──────────────────────────────────────────────────────────────

test('MinHeap: peek always returns the current minimum without consuming it', () => {
  const h = new MinHeap(numCmp);
  h.push(10);
  h.push(3);
  h.push(7);

  assert.strictEqual(h.peek(), 3);
  assert.strictEqual(h.peek(), 3);  // still 3
  assert.strictEqual(h.size(), 3);  // unchanged
});

test('MinHeap: pop updates the peek to the next minimum', () => {
  const h = new MinHeap(numCmp);
  h.push(10);
  h.push(3);
  h.push(7);

  h.pop();  // removes 3
  assert.strictEqual(h.peek(), 7);
});

// ─── Size tracking ────────────────────────────────────────────────────────────

test('MinHeap: size increments with each push', () => {
  const h = new MinHeap(numCmp);
  assert.strictEqual(h.size(), 0);
  h.push(1); assert.strictEqual(h.size(), 1);
  h.push(2); assert.strictEqual(h.size(), 2);
  h.push(3); assert.strictEqual(h.size(), 3);
});

test('MinHeap: size decrements with each pop', () => {
  const h = new MinHeap(numCmp);
  h.push(1); h.push(2); h.push(3);
  h.pop(); assert.strictEqual(h.size(), 2);
  h.pop(); assert.strictEqual(h.size(), 1);
  h.pop(); assert.strictEqual(h.size(), 0);
});

// ─── Duplicate values ─────────────────────────────────────────────────────────

test('MinHeap: duplicate values are all returned', () => {
  const h = new MinHeap(numCmp);
  h.push(5);
  h.push(5);
  h.push(5);

  assert.strictEqual(h.pop(), 5);
  assert.strictEqual(h.pop(), 5);
  assert.strictEqual(h.pop(), 5);
  assert.strictEqual(h.size(), 0);
});

test('MinHeap: mixed duplicates and uniques pop in non-decreasing order', () => {
  const h = new MinHeap(numCmp);
  [3, 1, 3, 2, 1].forEach(n => h.push(n));

  const result = [];
  while (h.size() > 0) result.push(h.pop());

  assert.deepStrictEqual(result, [1, 1, 2, 3, 3]);
});

// ─── Object elements (simulating event queue) ─────────────────────────────────

test('MinHeap: objects compared by date field pop in chronological order', () => {
  const cmp = (a, b) => a.date - b.date;
  const h   = new MinHeap(cmp);

  const d1 = new Date(2025, 0, 1);
  const d2 = new Date(2025, 3, 1);
  const d3 = new Date(2026, 0, 1);

  h.push({ date: d3, type: 'C' });
  h.push({ date: d1, type: 'A' });
  h.push({ date: d2, type: 'B' });

  assert.strictEqual(h.pop().type, 'A');
  assert.strictEqual(h.pop().type, 'B');
  assert.strictEqual(h.pop().type, 'C');
});
