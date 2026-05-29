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
 * real-property-service.test.mjs
 * Unit tests for RealPropertyService: CRUD, domain ops, and bus events.
 * Run with: node --test tests/unit/real-property-service.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { RealPropertyService } from '../../src/finance/services/real-property-service.js';
import { RealProperty } from '../../src/finance/assets/real-property.js';
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

// ── CRUD: createProperty ──────────────────────────────────────────────────────

test('RealPropertyService: createProperty assigns an id', () => {
  captureEvents(({ realPropertyService }) => {
    const prop = new RealProperty(500_000, { name: 'Home' });
    assert.ok(!prop.id, 'id should be falsy before creation');
    realPropertyService.createProperty(prop);
    assert.ok(prop.id, 'id should be assigned after createProperty');
  });
});

test('RealPropertyService: createProperty registers the property (get by id)', () => {
  captureEvents(({ realPropertyService }) => {
    const prop = new RealProperty(500_000, { name: 'Home' });
    realPropertyService.createProperty(prop);
    assert.strictEqual(realPropertyService.get(prop.id), prop);
  });
});

test('RealPropertyService: createProperty publishes a CREATE ServiceActionEvent', () => {
  const events = captureEvents(({ realPropertyService }) => {
    realPropertyService.createProperty(new RealProperty(500_000, { name: 'Home' }));
  });
  assert.strictEqual(events.length, 1);
  assert.ok(events[0] instanceof ServiceActionEvent);
  assert.strictEqual(events[0].actionType, 'CREATE');
  assert.ok(events[0].item instanceof RealProperty);
});

test('RealPropertyService: createProperty sets kind to real-property', () => {
  captureEvents(({ realPropertyService }) => {
    const prop = new RealProperty(500_000, { name: 'Home' });
    realPropertyService.createProperty(prop);
    assert.strictEqual(prop.kind, 'real-property');
  });
});

test('RealPropertyService: getAll returns all created properties', () => {
  captureEvents(({ realPropertyService }) => {
    realPropertyService.createProperty(new RealProperty(100_000, { name: 'A' }));
    realPropertyService.createProperty(new RealProperty(200_000, { name: 'B' }));
    assert.strictEqual(realPropertyService.getAll().length, 2);
  });
});

// ── CRUD: updateProperty ──────────────────────────────────────────────────────

test('RealPropertyService: updateProperty mutates property in-place', () => {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const prop = new RealProperty(500_000, { name: 'Home' });
  registry.realPropertyService.createProperty(prop);

  registry.realPropertyService.updateProperty(prop.id, { name: 'Updated Home', value: 600_000 });

  assert.strictEqual(prop.name, 'Updated Home');
  assert.strictEqual(prop.value, 600_000);
});

test('RealPropertyService: updateProperty publishes UPDATE event with originalItem', () => {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const prop = new RealProperty(500_000, { name: 'Home' });
  registry.realPropertyService.createProperty(prop);

  let updateEvt;
  registry.bus.subscribe('SERVICE_ACTION', e => { if (e.actionType === 'UPDATE') updateEvt = e; });
  registry.realPropertyService.updateProperty(prop.id, { name: 'Renamed' });

  assert.ok(updateEvt, 'UPDATE event should be published');
  assert.strictEqual(updateEvt.item.name, 'Renamed');
  assert.strictEqual(updateEvt.originalItem.name, 'Home');
});

test('RealPropertyService: updateProperty originalItem is a separate object from item', () => {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const prop = new RealProperty(500_000, { name: 'Home' });
  registry.realPropertyService.createProperty(prop);

  let updateEvt;
  registry.bus.subscribe('SERVICE_ACTION', e => { if (e.actionType === 'UPDATE') updateEvt = e; });
  registry.realPropertyService.updateProperty(prop.id, { name: 'New' });

  assert.notStrictEqual(updateEvt.item, updateEvt.originalItem);
});

// ── CRUD: deleteProperty ──────────────────────────────────────────────────────

test('RealPropertyService: deleteProperty removes the property from the service', () => {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const prop = new RealProperty(500_000, { name: 'Home' });
  registry.realPropertyService.createProperty(prop);
  const id = prop.id;

  registry.realPropertyService.deleteProperty(id);

  assert.strictEqual(registry.realPropertyService.getAll().length, 0);
});

test('RealPropertyService: deleteProperty publishes DELETE event', () => {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const prop = new RealProperty(500_000, { name: 'Home' });
  registry.realPropertyService.createProperty(prop);

  let deleteEvt;
  registry.bus.subscribe('SERVICE_ACTION', e => { if (e.actionType === 'DELETE') deleteEvt = e; });
  registry.realPropertyService.deleteProperty(prop.id);

  assert.ok(deleteEvt, 'DELETE event should be published');
  assert.ok(deleteEvt.item instanceof RealProperty);
});

// ── Domain ops (no bus required; use plain objects or bare service) ────────────

const svc = new RealPropertyService();

// ── getPersonShare ────────────────────────────────────────────────────────────

test('RealPropertyService.getPersonShare: sole ownership returns full value', () => {
  const prop = { value: 800_000, ownershipType: 'sole' };
  assert.strictEqual(svc.getPersonShare(prop), 800_000);
});

test('RealPropertyService.getPersonShare: joint ownership returns half the value', () => {
  const prop = { value: 800_000, ownershipType: 'joint' };
  assert.strictEqual(svc.getPersonShare(prop), 400_000);
});

test('RealPropertyService.getPersonShare: owners array uses pct for matching personId', () => {
  const prop = {
    value: 1_000_000,
    ownershipType: 'joint',
    owners: [
      { personId: 'p1', ownershipPct: 60 },
      { personId: 'p2', ownershipPct: 40 },
    ],
  };
  assert.strictEqual(svc.getPersonShare(prop, 'p1'), 600_000);
  assert.strictEqual(svc.getPersonShare(prop, 'p2'), 400_000);
});

test('RealPropertyService.getPersonShare: owners array returns 0 when personId not found', () => {
  const prop = {
    value: 1_000_000,
    ownershipType: 'sole',
    owners: [{ personId: 'p1', ownershipPct: 100 }],
  };
  assert.strictEqual(svc.getPersonShare(prop, 'unknown'), 0);
});

test('RealPropertyService.getPersonShare: falls back to ownershipType when owners is empty', () => {
  const prop = { value: 600_000, ownershipType: 'joint', owners: [] };
  assert.strictEqual(svc.getPersonShare(prop, 'p1'), 300_000);
});

// ── recordResidencyChange ─────────────────────────────────────────────────────

test('RealPropertyService.recordResidencyChange: snapshots current value when null', () => {
  const prop = { value: 700_000, balanceAtResidencyChange: null };
  svc.recordResidencyChange(prop);
  assert.strictEqual(prop.balanceAtResidencyChange, 700_000);
});

test('RealPropertyService.recordResidencyChange: does not overwrite existing snapshot', () => {
  const prop = { value: 700_000, balanceAtResidencyChange: null };
  svc.recordResidencyChange(prop);
  prop.value = 900_000;
  svc.recordResidencyChange(prop);
  assert.strictEqual(prop.balanceAtResidencyChange, 700_000);
});

// ── takeMortgageLoan / repayMortgage ──────────────────────────────────────────

test('RealPropertyService.takeMortgageLoan: increases mortgageBalance', () => {
  const prop = { mortgageBalance: 0, value: 800_000 };
  svc.takeMortgageLoan(prop, 300_000);
  assert.strictEqual(prop.mortgageBalance, 300_000);
});

test('RealPropertyService.takeMortgageLoan: accumulates multiple draws', () => {
  const prop = { mortgageBalance: 100_000, value: 800_000 };
  svc.takeMortgageLoan(prop, 50_000);
  assert.strictEqual(prop.mortgageBalance, 150_000);
});

test('RealPropertyService.takeMortgageLoan: does not change value', () => {
  const prop = { mortgageBalance: 0, value: 800_000 };
  svc.takeMortgageLoan(prop, 300_000);
  assert.strictEqual(prop.value, 800_000);
});

test('RealPropertyService.repayMortgage: decreases mortgageBalance', () => {
  const prop = { mortgageBalance: 300_000, value: 800_000 };
  svc.repayMortgage(prop, 50_000);
  assert.strictEqual(prop.mortgageBalance, 250_000);
});

test('RealPropertyService.repayMortgage: floors at 0 on overpayment', () => {
  const prop = { mortgageBalance: 10_000, value: 800_000 };
  svc.repayMortgage(prop, 50_000);
  assert.strictEqual(prop.mortgageBalance, 0);
});

test('RealPropertyService.repayMortgage: full repayment clears balance', () => {
  const prop = { mortgageBalance: 200_000, value: 800_000 };
  svc.repayMortgage(prop, 200_000);
  assert.strictEqual(prop.mortgageBalance, 0);
});

// ── applyAppreciation ─────────────────────────────────────────────────────────

test('RealPropertyService.applyAppreciation: compounds value by (1 + rate) for 1 year', () => {
  const prop = { value: 1_000_000, appreciationRate: 0.04 };
  svc.applyAppreciation(prop, 1);
  assert.ok(Math.abs(prop.value - 1_040_000) < 0.01, `expected ~1040000, got ${prop.value}`);
});

test('RealPropertyService.applyAppreciation: default period is 1 year', () => {
  const prop = { value: 1_000_000, appreciationRate: 0.04 };
  svc.applyAppreciation(prop);
  assert.ok(Math.abs(prop.value - 1_040_000) < 0.01, `expected ~1040000, got ${prop.value}`);
});

test('RealPropertyService.applyAppreciation: fractional years compound correctly', () => {
  const prop = { value: 1_000_000, appreciationRate: 0.04 };
  svc.applyAppreciation(prop, 0.5);
  const expected = 1_000_000 * Math.pow(1.04, 0.5);
  assert.ok(Math.abs(prop.value - expected) < 0.01, `expected ~${expected}, got ${prop.value}`);
});

test('RealPropertyService.applyAppreciation: zero rate leaves value unchanged', () => {
  const prop = { value: 500_000, appreciationRate: 0 };
  svc.applyAppreciation(prop, 5);
  assert.strictEqual(prop.value, 500_000);
});

// ── appraise ──────────────────────────────────────────────────────────────────

test('RealPropertyService.appraise: sets value to the new appraisal amount', () => {
  const prop = { value: 800_000 };
  svc.appraise(prop, 950_000);
  assert.strictEqual(prop.value, 950_000);
});

test('RealPropertyService.appraise: can set value to zero', () => {
  const prop = { value: 800_000 };
  svc.appraise(prop, 0);
  assert.strictEqual(prop.value, 0);
});
