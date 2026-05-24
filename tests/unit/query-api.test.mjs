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

import { QueryApi } from '../../src/query/query-api.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeApi(items) {
  return new QueryApi({ getAll: () => items });
}

const FRUITS = [
  { id: '1', name: 'Apple',      kind: 'fruit', price: 1.5 },
  { id: '2', name: 'Banana',     kind: 'fruit', price: 0.8 },
  { id: '3', name: 'Carrot',     kind: 'veggie', price: 0.5 },
  { id: '4', name: 'Au Share',   kind: 'asset',  price: 120 },
  { id: '5', name: 'Au Savings', kind: 'asset',  price: 5000 },
];

function api() { return makeApi(FRUITS); }

// ─── Empty / identity query ───────────────────────────────────────────────────

test('QueryApi: empty string returns all items', async () => {
  const { items, total } = await api().search({ query: '', offset: 0, limit: 50 });
  assert.strictEqual(total, FRUITS.length);
});

test('QueryApi: empty string total equals items length', async () => {
  const { items, total } = await api().search({ query: '', offset: 0, limit: 50 });
  assert.strictEqual(items.length, total);
});

// ─── eq ───────────────────────────────────────────────────────────────────────

test('QueryApi eq: matches single item by field', async () => {
  const { items } = await api().search({ query: 'kind=fruit', offset: 0, limit: 50 });
  assert.strictEqual(items.length, 2);
  assert.ok(items.every(i => i.kind === 'fruit'));
});

test('QueryApi eq: no match returns empty', async () => {
  const { items, total } = await api().search({ query: 'kind=unknown', offset: 0, limit: 50 });
  assert.strictEqual(total, 0);
  assert.strictEqual(items.length, 0);
});

test('QueryApi eq: id shortcut — O(1) index lookup', async () => {
  const { items } = await api().search({ query: 'id=3', offset: 0, limit: 50 });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].name, 'Carrot');
});

test('QueryApi eq: name equality uses index', async () => {
  const { items } = await api().search({ query: 'name=Apple', offset: 0, limit: 50 });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].id, '1');
});

// ─── contains ─────────────────────────────────────────────────────────────────

test('QueryApi contains: matches substring (case-insensitive)', async () => {
  const { items } = await api().search({ query: 'contains(name,apple)', offset: 0, limit: 50 });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].name, 'Apple');
});

test('QueryApi contains: upper-case search term still matches', async () => {
  const { items } = await api().search({ query: 'contains(name,BANANA)', offset: 0, limit: 50 });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].name, 'Banana');
});

test('QueryApi contains: partial prefix matches multiple', async () => {
  const { items } = await api().search({ query: 'contains(name,Au)', offset: 0, limit: 50 });
  assert.strictEqual(items.length, 2);
});

test('QueryApi contains: value with space matches correctly', async () => {
  const { items } = await api().search({ query: 'contains(name,Au S)', offset: 0, limit: 50 });
  assert.strictEqual(items.length, 2);
  assert.ok(items.every(i => i.name.toLowerCase().includes('au s')));
});

test('QueryApi contains: quoted value with space matches correctly', async () => {
  const { items } = await api().search({ query: 'contains(name,"Au S")', offset: 0, limit: 50 });
  assert.strictEqual(items.length, 2);
  assert.ok(items.every(i => i.name.toLowerCase().includes('au s')));
});

test('QueryApi contains: single-quoted value with space matches correctly', async () => {
  const { items } = await api().search({ query: "contains(name,'Au S')", offset: 0, limit: 50 });
  assert.strictEqual(items.length, 2);
});

test('QueryApi contains: no match returns empty', async () => {
  const { items } = await api().search({ query: 'contains(name,xyz)', offset: 0, limit: 50 });
  assert.strictEqual(items.length, 0);
});

test('QueryApi contains: works on non-name fields', async () => {
  const { items } = await api().search({ query: 'contains(kind,veggie)', offset: 0, limit: 50 });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].name, 'Carrot');
});

// ─── gt / lt ──────────────────────────────────────────────────────────────────

test('QueryApi gt: returns items above threshold', async () => {
  const { items } = await api().search({ query: 'gt(price,1)', offset: 0, limit: 50 });
  assert.ok(items.length > 0);
  assert.ok(items.every(i => i.price > 1));
});

test('QueryApi lt: returns items below threshold', async () => {
  const { items } = await api().search({ query: 'lt(price,1)', offset: 0, limit: 50 });
  assert.ok(items.length > 0);
  assert.ok(items.every(i => i.price < 1));
});

// ─── AND / OR / NOT ───────────────────────────────────────────────────────────

test('QueryApi AND: both conditions must hold', async () => {
  const { items } = await api().search({ query: 'kind=asset & contains(name,Savings)', offset: 0, limit: 50 });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].name, 'Au Savings');
});

test('QueryApi OR: either condition sufficient', async () => {
  const { items } = await api().search({ query: 'kind=fruit | kind=veggie', offset: 0, limit: 50 });
  assert.strictEqual(items.length, 3);
});

test('QueryApi NOT: excludes matching items', async () => {
  const { items } = await api().search({ query: '!kind=fruit', offset: 0, limit: 50 });
  assert.ok(items.every(i => i.kind !== 'fruit'));
});

test('QueryApi grouping: parentheses control precedence', async () => {
  const { items } = await api().search({
    query: 'kind=asset & (contains(name,Share) | contains(name,Savings))',
    offset: 0, limit: 50
  });
  assert.strictEqual(items.length, 2);
  assert.ok(items.every(i => i.kind === 'asset'));
});

test('QueryApi AND with space in value: compound query with spaced value', async () => {
  const { items } = await api().search({
    query: 'kind=asset & contains(name,Au S)',
    offset: 0, limit: 50
  });
  assert.strictEqual(items.length, 2);
});

// ─── Pagination ───────────────────────────────────────────────────────────────

test('QueryApi pagination: limit restricts returned items', async () => {
  const { items, total } = await api().search({ query: '', offset: 0, limit: 2 });
  assert.strictEqual(total, FRUITS.length);
  assert.strictEqual(items.length, 2);
});

test('QueryApi pagination: offset skips items', async () => {
  const { items: page1 } = await api().search({ query: '', offset: 0, limit: 2 });
  const { items: page2 } = await api().search({ query: '', offset: 2, limit: 2 });
  const ids1 = page1.map(i => i.id);
  const ids2 = page2.map(i => i.id);
  assert.ok(ids1.every(id => !ids2.includes(id)));
});

test('QueryApi pagination: offset beyond total returns empty', async () => {
  const { items } = await api().search({ query: '', offset: 100, limit: 10 });
  assert.strictEqual(items.length, 0);
});

// ─── Sort ─────────────────────────────────────────────────────────────────────

test('QueryApi sort: ascending by name', async () => {
  const { items } = await api().search({
    query: '', sort: [{ field: 'name', dir: 'asc' }], offset: 0, limit: 50
  });
  const names = items.map(i => i.name);
  assert.deepStrictEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test('QueryApi sort: descending by name', async () => {
  const { items } = await api().search({
    query: '', sort: [{ field: 'name', dir: 'desc' }], offset: 0, limit: 50
  });
  const names = items.map(i => i.name);
  assert.deepStrictEqual(names, [...names].sort((a, b) => b.localeCompare(a)));
});

test('QueryApi sort: ascending by numeric price', async () => {
  const { items } = await api().search({
    query: '', sort: [{ field: 'price', dir: 'asc' }], offset: 0, limit: 50
  });
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i].price >= items[i - 1].price);
  }
});

// ─── getById / getByName ──────────────────────────────────────────────────────

test('QueryApi.getById: returns item for known id', () => {
  const item = api().getById('2');
  assert.strictEqual(item.name, 'Banana');
});

test('QueryApi.getById: returns null for unknown id', () => {
  assert.strictEqual(api().getById('999'), null);
});

test('QueryApi.getByName: returns bucket for exact name', () => {
  const bucket = api().getByName('apple');
  assert.ok(Array.isArray(bucket));
  assert.strictEqual(bucket[0].name, 'Apple');
});

test('QueryApi.getByName: returns null for unknown name', () => {
  assert.strictEqual(api().getByName('nope'), null);
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

test('QueryApi: item with null field is excluded from contains match', async () => {
  const items = [
    { id: '1', name: null,    kind: 'x' },
    { id: '2', name: 'Alpha', kind: 'x' },
  ];
  const { items: result } = await makeApi(items).search({ query: 'contains(name,alpha)', offset: 0, limit: 50 });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, '2');
});

test('QueryApi: data source with zero items returns empty result', async () => {
  const { items, total } = await makeApi([]).search({ query: '', offset: 0, limit: 50 });
  assert.strictEqual(total, 0);
  assert.strictEqual(items.length, 0);
});
