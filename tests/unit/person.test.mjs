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
 * person.test.mjs
 * Tests for Person, PersonService, and PersonBuilder
 * Run with: node --test tests/unit/person.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Person } from '../../src/finance/person.js';
import { PersonService } from '../../src/finance/services/person-service.js';
import { PersonBuilder } from '../../src/finance/builders/person-builder.js';
import { EventBus } from '../../src/simulation-framework/event-bus.js';
import {Graph} from "../../src/graph/graph.js";
import {AccountService} from "../../src/finance/services/account-service.js";
import {GraphQueryApi} from "../../src/graph/graph-query-api.js";

// ── Person construction ───────────────────────────────────────────────────────

test('Person: sets id and birthDate', () => {
  const p = new Person('p1', new Date(1966, 0, 1));
  assert.strictEqual(p.id, 'p1');
  assert.deepStrictEqual(p.birthDate, new Date(1966, 0, 1));
});

test('Person: defaults name to empty string and citizen to [US]', () => {
  const p = new Person('p1', new Date(1966, 0, 1));
  assert.strictEqual(p.name, '');
  assert.deepStrictEqual(p.citizen, ['US']);
});

test('Person: defaults lifeExpectancy to 90 and socialSecurityMonthly to 2800', () => {
  const p = new Person('p1', new Date(1966, 0, 1));
  assert.strictEqual(p.lifeExpectancy, 90);
  assert.strictEqual(p.socialSecurityMonthly, 2800);
});

test('Person: opts override name and citizen', () => {
  const p = new Person('p2', new Date(1970, 5, 15), { name: 'Alice', citizen: ['AU'] });
  assert.strictEqual(p.name, 'Alice');
  assert.deepStrictEqual(p.citizen, ['AU']);
});

test('Person: opts override lifeExpectancy and socialSecurityMonthly', () => {
  const p = new Person('p2', new Date(1970, 5, 15), { lifeExpectancy: 85, socialSecurityMonthly: 3200 });
  assert.strictEqual(p.lifeExpectancy, 85);
  assert.strictEqual(p.socialSecurityMonthly, 3200);
});

test('Person: dual citizen stores both country codes', () => {
  const p = new Person('p3', new Date(1975, 0, 1), { citizen: ['US', 'AU'] });
  assert.ok(p.citizen.includes('US'));
  assert.ok(p.citizen.includes('AU'));
});

test('Person: residency defaults to first citizen entry', () => {
  const p = new Person('p1', new Date(1966, 0, 1), { citizen: ['AU'] });
  assert.strictEqual(p.residency, 'AU');
});

test('Person: dual citizen defaults residency to first entry (US)', () => {
  const p = new Person('p1', new Date(1966, 0, 1), { citizen: ['US', 'AU'] });
  assert.strictEqual(p.residency, 'US');
});

test('Person: explicit residency overrides citizen default', () => {
  const p = new Person('p1', new Date(1966, 0, 1), { citizen: ['US', 'AU'], residency: 'AU' });
  assert.strictEqual(p.residency, 'AU');
  assert.deepStrictEqual(p.citizen, ['US', 'AU']);
});

test('Person: dual citizen with US residency stays US even though AU citizen', () => {
  const p = new Person('p1', new Date(1966, 0, 1), { citizen: ['US', 'AU'], residency: 'US' });
  assert.strictEqual(p.residency, 'US');
});

test('Person: id defaults to null when not provided', () => {
  const p = new Person(null, new Date(1966, 0, 1));
  assert.strictEqual(p.id, null);
});

test('Person: is structuredClone-safe (plain data, no prototype methods)', () => {
  const p  = new Person('p1', new Date(1966, 0, 1), {
    name: 'Bob', citizen: ['AU'], lifeExpectancy: 85, socialSecurityMonthly: 3000,
  });
  const p2 = structuredClone(p);
  assert.strictEqual(p2.id,                    'p1');
  assert.strictEqual(p2.name,                  'Bob');
  assert.deepStrictEqual(p2.citizen,           ['AU']);
  assert.strictEqual(p2.lifeExpectancy,        85);
  assert.strictEqual(p2.socialSecurityMonthly, 3000);
  assert.deepStrictEqual(p2.birthDate,         p.birthDate);
});

// ── PersonService CRUD ────────────────────────────────────────────────────────

test('PersonService: createPerson assigns a p-prefixed id', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new PersonService(graph, new GraphQueryApi(graph), bus);
  const p = svc.createPerson(new Date(1980, 0, 1), { name: 'Alice' });
  assert.ok(p.id.startsWith('p'), `expected id to start with 'p', got ${p.id}`);
  assert.strictEqual(p.name, 'Alice');
});

test('PersonService: createPerson registers the person in the service map', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new PersonService(graph, new GraphQueryApi(graph), bus);
  const p = svc.createPerson(new Date(1980, 0, 1), { name: 'Bob' });
  assert.strictEqual(svc.get(p.id), p);
});

test('PersonService: getAll returns all registered persons', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new PersonService(graph, new GraphQueryApi(graph), bus);
  svc.createPerson(new Date(1980, 0, 1), { name: 'Alice' });
  svc.createPerson(new Date(1985, 5, 15), { name: 'Bob' });
  assert.strictEqual(svc.getAll().length, 2);
});

test('PersonService: register accepts a pre-built person and assigns id', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new PersonService(graph, new GraphQueryApi(graph), bus);
  const p = new Person(null, new Date(1970, 0, 1), { name: 'Carol' });
  svc.register(p);
  assert.ok(p.id !== null);
  assert.strictEqual(svc.get(p.id), p);
});

test('PersonService: register preserves a pre-set id', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new PersonService(graph, new GraphQueryApi(graph), bus);
  const p = new Person('primary', new Date(1966, 0, 1));
  svc.register(p);
  assert.strictEqual(p.id, 'primary');
  assert.strictEqual(svc.get('primary'), p);
});

test('PersonService: updatePerson applies changes and publishes UPDATE', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new PersonService(graph, new GraphQueryApi(graph), bus);
  const p = svc.createPerson(new Date(1980, 0, 1), { name: 'Alice' });

  let updateFired = false;
  bus.subscribe('SERVICE_ACTION', msg => {
    if (msg.actionType === 'UPDATE' && msg.item instanceof Person) updateFired = true;
  });

  svc.updatePerson(p.id, { name: 'Alice Updated', lifeExpectancy: 85 });
  assert.strictEqual(p.name, 'Alice Updated');
  assert.strictEqual(p.lifeExpectancy, 85);
  assert.ok(updateFired);
});

test('PersonService: deletePerson removes from map and publishes DELETE', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new PersonService(graph, new GraphQueryApi(graph), bus);
  const p = svc.createPerson(new Date(1980, 0, 1), { name: 'Alice' });

  let deleteFired = false;
  bus.subscribe('SERVICE_ACTION', msg => {
    if (msg.actionType === 'DELETE' && msg.item instanceof Person) deleteFired = true;
  });

  svc.deletePerson(p.id);
  assert.strictEqual(svc.get(p.id), null);
  assert.ok(deleteFired);
});

test('PersonService: id counter advances so multiple creates get unique ids', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new PersonService(graph, new GraphQueryApi(graph), bus);
  const p1 = svc.createPerson(new Date(1980, 0, 1));
  const p2 = svc.createPerson(new Date(1985, 0, 1));
  assert.notStrictEqual(p1.id, p2.id);
});

// ── PersonService.getAge ──────────────────────────────────────────────────────

test('PersonService.getAge: returns correct whole years', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new PersonService(graph, new GraphQueryApi(graph), bus);
  const p = new Person('p1', new Date(1966, 0, 1));
  assert.strictEqual(svc.getAge(p, new Date(2026, 0, 1)), 60); // exact birthday
  assert.strictEqual(svc.getAge(p, new Date(2026, 6, 1)), 60); // mid-year
});

test('PersonService.getAge: one day before birthday is still the previous year', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new PersonService(graph, new GraphQueryApi(graph), bus);
  const p = new Person('p1', new Date(1966, 0, 1));
  assert.strictEqual(svc.getAge(p, new Date(2025, 11, 31)), 59);
});

test('PersonService.getAge: exact birthday returns the new age', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new PersonService(graph, new GraphQueryApi(graph), bus);
  const p = new Person('p1', new Date(1966, 6, 15)); // July 15
  assert.strictEqual(svc.getAge(p, new Date(2026, 6, 15)), 60); // exact
  assert.strictEqual(svc.getAge(p, new Date(2026, 6, 14)), 59); // one day before
});

test('PersonService.getAge: younger person (born 1990) returns 36 in 2026', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new PersonService(graph, new GraphQueryApi(graph), bus);
  const p = new Person('p1', new Date(1990, 0, 1));
  assert.strictEqual(svc.getAge(p, new Date(2026, 3, 1)), 36);
});

// ── PersonService.getAgeDecimal ───────────────────────────────────────────────

test('PersonService.getAgeDecimal: returns decimal age above 59.5 for 401k gate', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new PersonService(graph, new GraphQueryApi(graph), bus);
  const p = new Person('p1', new Date(1966, 6, 1));
  const age = svc.getAgeDecimal(p, new Date(2026, 6, 1)); // age 60.0
  assert.ok(age >= 59.5, `expected age >= 59.5, got ${age}`);
});

test('PersonService.getAgeDecimal: returns age below 59.5 before the gate', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new PersonService(graph, new GraphQueryApi(graph), bus);
  const p = new Person('p1', new Date(1990, 0, 1));
  const age = svc.getAgeDecimal(p, new Date(2026, 0, 15));
  assert.ok(age < 59.5, `expected age < 59.5, got ${age}`);
});

// ── PersonBuilder ─────────────────────────────────────────────────────────────

test('PersonBuilder: builds a person with default values', () => {
  const p = PersonBuilder.person().build();
  assert.strictEqual(p.id, null);
  assert.strictEqual(p.name, '');
  assert.deepStrictEqual(p.citizen, ['US']);
  assert.strictEqual(p.lifeExpectancy, 90);
  assert.strictEqual(p.socialSecurityMonthly, 2800);
});

test('PersonBuilder: fluent setters populate all fields', () => {
  const bd = new Date(Date.UTC(1975, 5, 15));
  const p  = PersonBuilder.person()
    .name('Diana')
    .birthDate(bd)
    .citizen(['US', 'AU'])
    .lifeExpectancy(88)
    .socialSecurityMonthly(3100)
    .build();

  assert.strictEqual(p.name, 'Diana');
  assert.deepStrictEqual(p.birthDate, bd);
  assert.deepStrictEqual(p.citizen, ['US', 'AU']);
  assert.strictEqual(p.lifeExpectancy, 88);
  assert.strictEqual(p.socialSecurityMonthly, 3100);
});

test('PersonBuilder: pre-set id is preserved', () => {
  const p = PersonBuilder.person().id('primary').name('Alice').birthDate(new Date(1980, 0, 1)).build();
  assert.strictEqual(p.id, 'primary');
});

test('PersonBuilder: built person can be registered with PersonService', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new PersonService(graph, new GraphQueryApi(graph), bus);
  const p   = PersonBuilder.person()
    .name('Eve')
    .birthDate(new Date(Date.UTC(1982, 3, 20)))
    .citizen(['AU'])
    .build();

  svc.register(p);
  assert.ok(p.id !== null);
  assert.strictEqual(svc.get(p.id).name, 'Eve');
});
