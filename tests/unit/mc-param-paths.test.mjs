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

import { get, set } from '../../src/finance/monte-carlo/mc-param-paths.js';

// ── get ───────────────────────────────────────────────────────────────────────

test('get: top-level key', () => {
  assert.strictEqual(get({ a: 1 }, 'a'), 1);
});

test('get: dot-separated path', () => {
  assert.strictEqual(get({ a: { b: { c: 42 } } }, 'a.b.c'), 42);
});

test('get: bracketed array index', () => {
  assert.strictEqual(get({ shocks: [{ severity: 0.4 }, { severity: 0.3 }] }, 'shocks[0].severity'), 0.4);
  assert.strictEqual(get({ shocks: [{ severity: 0.4 }, { severity: 0.3 }] }, 'shocks[1].severity'), 0.3);
});

test('get: mixed deep path', () => {
  const obj = { shocks: [{ recovery: { durationMonths: 18 } }] };
  assert.strictEqual(get(obj, 'shocks[0].recovery.durationMonths'), 18);
});

test('get: missing intermediate returns undefined', () => {
  assert.strictEqual(get({ a: {} }, 'a.b.c'), undefined);
  assert.strictEqual(get({}, 'shocks[0].severity'), undefined);
});

test('get: null intermediate returns undefined (no throw)', () => {
  assert.strictEqual(get({ a: null }, 'a.b'), undefined);
});

test('get: array index out of bounds returns undefined', () => {
  assert.strictEqual(get({ shocks: [{ severity: 0.4 }] }, 'shocks[5].severity'), undefined);
});

test('get: top-level path that does not exist returns undefined', () => {
  assert.strictEqual(get({ a: 1 }, 'b'), undefined);
});

// ── set ───────────────────────────────────────────────────────────────────────

test('set: top-level key', () => {
  const obj = { a: 1 };
  set(obj, 'a', 99);
  assert.strictEqual(obj.a, 99);
});

test('set: dot-separated path', () => {
  const obj = { a: { b: { c: 0 } } };
  set(obj, 'a.b.c', 42);
  assert.strictEqual(obj.a.b.c, 42);
});

test('set: bracketed array index', () => {
  const obj = { shocks: [{ severity: 0.4 }, { severity: 0.3 }] };
  set(obj, 'shocks[0].severity', 0.6);
  assert.strictEqual(obj.shocks[0].severity, 0.6);
  assert.strictEqual(obj.shocks[1].severity, 0.3); // sibling unaffected
});

test('set: mixed deep path', () => {
  const obj = { shocks: [{ recovery: { durationMonths: 18 } }] };
  set(obj, 'shocks[0].recovery.durationMonths', 24);
  assert.strictEqual(obj.shocks[0].recovery.durationMonths, 24);
});

test('set: no-op when intermediate is missing', () => {
  const obj = { a: {} };
  set(obj, 'a.b.c', 42); // a.b does not exist
  assert.deepStrictEqual(obj, { a: {} }); // unchanged
});

test('set: no-op when array index is out of bounds', () => {
  const obj = { shocks: [] };
  set(obj, 'shocks[0].severity', 0.5);
  assert.deepStrictEqual(obj.shocks, []); // no entry created
});

test('set: does not mutate a sibling array entry', () => {
  const obj = { shocks: [{ severity: 0.4 }, { severity: 0.3 }] };
  set(obj, 'shocks[0].severity', 0.7);
  assert.strictEqual(obj.shocks[1].severity, 0.3);
});

test('set: structuredClone isolation — original untouched after clone+set', () => {
  const original = { shocks: [{ severity: 0.4 }] };
  const clone    = structuredClone(original);
  set(clone, 'shocks[0].severity', 0.9);
  assert.strictEqual(original.shocks[0].severity, 0.4); // original unchanged
  assert.strictEqual(clone.shocks[0].severity,    0.9);
});
