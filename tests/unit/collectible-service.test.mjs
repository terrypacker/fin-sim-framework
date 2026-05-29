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
 * collectible-service.test.mjs
 * Unit tests for CollectibleService: CRUD, domain ops, and bus events.
 * Run with: node --test tests/unit/collectible-service.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { CollectibleService } from '../../src/finance/services/collectible-service.js';
import { Collectible } from '../../src/finance/assets/collectible.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ServiceActionEvent } from '../../src/simulation-framework/bus-messages.js';

beforeEach(() => ServiceRegistry.resetAll());

// ── CRUD helpers ──────────────────────────────────────────────────────────────

function captureEvents(work) {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const events = [];
  registry.bus.subscribe('SERVICE_ACTION', e => events.push(e));
  work(registry);
  return events;
}

// ── CRUD: createCollectible ───────────────────────────────────────────────────

test('CollectibleService: createCollectible assigns an id', () => {
  captureEvents(({ collectibleService }) => {
    const col = new Collectible(100_000, { name: 'Gold' });
    assert.ok(!col.id, 'id should be falsy before creation');
    collectibleService.createCollectible(col);
    assert.ok(col.id, 'id should be assigned after createCollectible');
  });
});

test('CollectibleService: createCollectible registers the collectible (get by id)', () => {
  captureEvents(({ collectibleService }) => {
    const col = new Collectible(100_000, { name: 'Gold' });
    collectibleService.createCollectible(col);
    assert.strictEqual(collectibleService.get(col.id), col);
  });
});

test('CollectibleService: createCollectible publishes a CREATE ServiceActionEvent', () => {
  const events = captureEvents(({ collectibleService }) => {
    collectibleService.createCollectible(new Collectible(100_000, { name: 'Gold' }));
  });
  assert.strictEqual(events.length, 1);
  assert.ok(events[0] instanceof ServiceActionEvent);
  assert.strictEqual(events[0].actionType, 'CREATE');
  assert.ok(events[0].item instanceof Collectible);
});

test('CollectibleService: createCollectible sets kind to collectible', () => {
  captureEvents(({ collectibleService }) => {
    const col = new Collectible(100_000, { name: 'Gold' });
    collectibleService.createCollectible(col);
    assert.strictEqual(col.kind, 'collectible');
  });
});

test('CollectibleService: getAll returns all created collectibles', () => {
  captureEvents(({ collectibleService }) => {
    collectibleService.createCollectible(new Collectible(100_000, { name: 'Gold' }));
    collectibleService.createCollectible(new Collectible(50_000,  { name: 'Art' }));
    assert.strictEqual(collectibleService.getAll().length, 2);
  });
});

// ── CRUD: updateCollectible ───────────────────────────────────────────────────

test('CollectibleService: updateCollectible mutates collectible in-place', () => {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const col = new Collectible(100_000, { name: 'Gold' });
  registry.collectibleService.createCollectible(col);

  registry.collectibleService.updateCollectible(col.id, { name: 'Gold Bar', value: 120_000 });

  assert.strictEqual(col.name, 'Gold Bar');
  assert.strictEqual(col.value, 120_000);
});

test('CollectibleService: updateCollectible publishes UPDATE event with originalItem', () => {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const col = new Collectible(100_000, { name: 'Gold' });
  registry.collectibleService.createCollectible(col);

  let updateEvt;
  registry.bus.subscribe('SERVICE_ACTION', e => { if (e.actionType === 'UPDATE') updateEvt = e; });
  registry.collectibleService.updateCollectible(col.id, { name: 'Gold Bar' });

  assert.ok(updateEvt, 'UPDATE event should be published');
  assert.strictEqual(updateEvt.item.name, 'Gold Bar');
  assert.strictEqual(updateEvt.originalItem.name, 'Gold');
});

test('CollectibleService: updateCollectible originalItem is a separate object from item', () => {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const col = new Collectible(100_000, { name: 'Gold' });
  registry.collectibleService.createCollectible(col);

  let updateEvt;
  registry.bus.subscribe('SERVICE_ACTION', e => { if (e.actionType === 'UPDATE') updateEvt = e; });
  registry.collectibleService.updateCollectible(col.id, { name: 'New' });

  assert.notStrictEqual(updateEvt.item, updateEvt.originalItem);
});

// ── CRUD: deleteCollectible ───────────────────────────────────────────────────

test('CollectibleService: deleteCollectible removes the collectible from the service', () => {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const col = new Collectible(100_000, { name: 'Gold' });
  registry.collectibleService.createCollectible(col);

  registry.collectibleService.deleteCollectible(col.id);

  assert.strictEqual(registry.collectibleService.getAll().length, 0);
});

test('CollectibleService: deleteCollectible publishes DELETE event', () => {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const col = new Collectible(100_000, { name: 'Gold' });
  registry.collectibleService.createCollectible(col);

  let deleteEvt;
  registry.bus.subscribe('SERVICE_ACTION', e => { if (e.actionType === 'DELETE') deleteEvt = e; });
  registry.collectibleService.deleteCollectible(col.id);

  assert.ok(deleteEvt, 'DELETE event should be published');
  assert.ok(deleteEvt.item instanceof Collectible);
});

// ── Domain ops (no bus required; use bare service) ────────────────────────────

const svc = new CollectibleService();

// ── getPersonShare ────────────────────────────────────────────────────────────

test('CollectibleService.getPersonShare: sole ownership returns full value', () => {
  const col = { value: 100_000, ownershipType: 'sole' };
  assert.strictEqual(svc.getPersonShare(col), 100_000);
});

test('CollectibleService.getPersonShare: joint ownership returns half the value', () => {
  const col = { value: 100_000, ownershipType: 'joint' };
  assert.strictEqual(svc.getPersonShare(col), 50_000);
});

test('CollectibleService.getPersonShare: owners array uses pct for matching personId', () => {
  const col = {
    value: 100_000,
    ownershipType: 'joint',
    owners: [
      { personId: 'p1', ownershipPct: 70 },
      { personId: 'p2', ownershipPct: 30 },
    ],
  };
  assert.strictEqual(svc.getPersonShare(col, 'p1'), 70_000);
  assert.strictEqual(svc.getPersonShare(col, 'p2'), 30_000);
});

test('CollectibleService.getPersonShare: owners array returns 0 when personId not found', () => {
  const col = {
    value: 100_000,
    ownershipType: 'sole',
    owners: [{ personId: 'p1', ownershipPct: 100 }],
  };
  assert.strictEqual(svc.getPersonShare(col, 'unknown'), 0);
});

test('CollectibleService.getPersonShare: falls back to ownershipType when owners is empty', () => {
  const col = { value: 80_000, ownershipType: 'joint', owners: [] };
  assert.strictEqual(svc.getPersonShare(col, 'p1'), 40_000);
});

// ── recordResidencyChange ─────────────────────────────────────────────────────

test('CollectibleService.recordResidencyChange: snapshots current value when null', () => {
  const col = { value: 100_000, balanceAtResidencyChange: null };
  svc.recordResidencyChange(col);
  assert.strictEqual(col.balanceAtResidencyChange, 100_000);
});

test('CollectibleService.recordResidencyChange: does not overwrite existing snapshot', () => {
  const col = { value: 100_000, balanceAtResidencyChange: null };
  svc.recordResidencyChange(col);
  col.value = 150_000;
  svc.recordResidencyChange(col);
  assert.strictEqual(col.balanceAtResidencyChange, 100_000);
});

// ── applyAppreciation ─────────────────────────────────────────────────────────

test('CollectibleService.applyAppreciation: compounds value by (1 + rate) for 1 year', () => {
  const col = { value: 100_000, appreciationRate: 0.03 };
  svc.applyAppreciation(col, 1);
  assert.ok(Math.abs(col.value - 103_000) < 0.01, `expected ~103000, got ${col.value}`);
});

test('CollectibleService.applyAppreciation: default period is 1 year', () => {
  const col = { value: 100_000, appreciationRate: 0.03 };
  svc.applyAppreciation(col);
  assert.ok(Math.abs(col.value - 103_000) < 0.01, `expected ~103000, got ${col.value}`);
});

test('CollectibleService.applyAppreciation: fractional years compound correctly', () => {
  const col = { value: 100_000, appreciationRate: 0.03 };
  svc.applyAppreciation(col, 0.5);
  const expected = 100_000 * Math.pow(1.03, 0.5);
  assert.ok(Math.abs(col.value - expected) < 0.01, `expected ~${expected.toFixed(2)}, got ${col.value}`);
});

test('CollectibleService.applyAppreciation: zero rate leaves value unchanged', () => {
  const col = { value: 100_000, appreciationRate: 0 };
  svc.applyAppreciation(col, 5);
  assert.strictEqual(col.value, 100_000);
});

// ── appraise ──────────────────────────────────────────────────────────────────

test('CollectibleService.appraise: sets value to the new appraisal amount', () => {
  const col = { value: 100_000 };
  svc.appraise(col, 150_000);
  assert.strictEqual(col.value, 150_000);
});

test('CollectibleService.appraise: can set value to zero (total loss)', () => {
  const col = { value: 100_000 };
  svc.appraise(col, 0);
  assert.strictEqual(col.value, 0);
});
