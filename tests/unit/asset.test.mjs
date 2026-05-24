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
 * asset.test.mjs
 * Tests for the lean Asset base class (ownership metadata only).
 * Run with: node --test tests/unit/asset.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Asset }        from '../../src/finance/assets/asset.js';
import { SimGraphNode } from '../../src/graph/sim-graph-node.js';

test('Asset: name is set via constructor', () => {
  const a = new Asset('AAPL');
  assert.strictEqual(a.name, 'AAPL');
});

test('Asset: default name is empty string', () => {
  const a = new Asset();
  assert.strictEqual(a.name, '');
});

test('Asset: default ownershipType is sole', () => {
  assert.strictEqual(new Asset('X').ownershipType, 'sole');
});

test('Asset: opts.ownershipType sets joint ownership', () => {
  const a = new Asset('X', { ownershipType: 'joint' });
  assert.strictEqual(a.ownershipType, 'joint');
});

test('Asset: default ownerId is null', () => {
  assert.strictEqual(new Asset().ownerId, null);
});

test('Asset: opts.ownerId is set', () => {
  const a = new Asset('X', { ownerId: 'p1' });
  assert.strictEqual(a.ownerId, 'p1');
});

test('Asset: default drawdownPriority is null', () => {
  assert.strictEqual(new Asset().drawdownPriority, null);
});

test('Asset: opts.drawdownPriority is set correctly', () => {
  const a = new Asset('House', { drawdownPriority: 10 });
  assert.strictEqual(a.drawdownPriority, 10);
});

test('Asset: id is null by default', () => {
  assert.strictEqual(new Asset().id, null);
});

test('Asset: opts.id is set', () => {
  const a = new Asset('X', { id: 'a-001' });
  assert.strictEqual(a.id, 'a-001');
});

test('Asset: kind is asset by default', () => {
  assert.strictEqual(new Asset().kind, 'asset');
});

test('Asset: opts.kind overrides default', () => {
  const a = new Asset('X', { kind: 'account' });
  assert.strictEqual(a.kind, 'account');
});

test('Asset: instanceof SimGraphNode', () => {
  assert.ok(new Asset('X') instanceof SimGraphNode);
});

test('Asset: is structuredClone-safe', () => {
  const a = new Asset('House', {
    ownershipType:    'joint',
    ownerId:          'p1',
    drawdownPriority: 10,
    id:               'a-001',
  });
  const a2 = structuredClone(a);
  assert.strictEqual(a2.name,             'House');
  assert.strictEqual(a2.ownershipType,    'joint');
  assert.strictEqual(a2.ownerId,          'p1');
  assert.strictEqual(a2.drawdownPriority, 10);
  assert.strictEqual(a2.id,              'a-001');
  assert.strictEqual(a2.kind,            'asset');
});
