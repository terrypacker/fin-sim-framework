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
 * event-bus.test.mjs
 * Tests for EventBus
 * Run with: node --test tests/event-bus.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { EventBus } from '../src/simulation-framework/event-bus.js';

// ─── Subscribe & publish ──────────────────────────────────────────────────────

test('EventBus: typed subscriber is called when matching event is published', () => {
  const bus = new EventBus();
  let received = null;

  bus.subscribe('TICK', (event) => { received = event; });
  bus.publish({ type: 'TICK', payload: { value: 1 } });

  assert.ok(received !== null, 'handler should have been called');
  assert.strictEqual(received.type, 'TICK');
  assert.strictEqual(received.payload.value, 1);
});

test('EventBus: typed subscriber is NOT called for a different event type', () => {
  const bus = new EventBus();
  let called = false;

  bus.subscribe('TICK', () => { called = true; });
  bus.publish({ type: 'OTHER', payload: {} });

  assert.strictEqual(called, false);
});

test('EventBus: multiple subscribers for the same type all receive the event', () => {
  const bus = new EventBus();
  let count = 0;

  bus.subscribe('TICK', () => { count++; });
  bus.subscribe('TICK', () => { count++; });
  bus.publish({ type: 'TICK', payload: {} });

  assert.strictEqual(count, 2);
});

test('EventBus: subscribers for different types receive only their own events', () => {
  const bus = new EventBus();
  const calls = { A: 0, B: 0 };

  bus.subscribe('A', () => { calls.A++; });
  bus.subscribe('B', () => { calls.B++; });

  bus.publish({ type: 'A', payload: {} });
  bus.publish({ type: 'A', payload: {} });
  bus.publish({ type: 'B', payload: {} });

  assert.strictEqual(calls.A, 2);
  assert.strictEqual(calls.B, 1);
});

// ─── Wildcard ─────────────────────────────────────────────────────────────────

test('EventBus: wildcard subscriber receives every published event', () => {
  const bus    = new EventBus();
  const events = [];

  bus.subscribe('*', (e) => { events.push(e.type); });

  bus.publish({ type: 'TICK',  payload: {} });
  bus.publish({ type: 'TOCK',  payload: {} });
  bus.publish({ type: 'OTHER', payload: {} });

  assert.deepStrictEqual(events, ['TICK', 'TOCK', 'OTHER']);
});

test('EventBus: wildcard subscriber runs in addition to typed subscribers', () => {
  const bus  = new EventBus();
  const seen = [];

  bus.subscribe('TICK',  () => { seen.push('typed'); });
  bus.subscribe('*',     () => { seen.push('wildcard'); });

  bus.publish({ type: 'TICK', payload: {} });

  // Both handlers fire; typed fires before wildcard
  assert.ok(seen.includes('typed'),    'typed handler should fire');
  assert.ok(seen.includes('wildcard'), 'wildcard handler should fire');
  assert.strictEqual(seen.length, 2);
});

test('EventBus: multiple wildcard subscribers all fire', () => {
  const bus = new EventBus();
  let count = 0;

  bus.subscribe('*', () => { count++; });
  bus.subscribe('*', () => { count++; });

  bus.publish({ type: 'TICK', payload: {} });
  assert.strictEqual(count, 2);
});

// ─── History ──────────────────────────────────────────────────────────────────

test('EventBus: getHistory returns all published events in order', () => {
  const bus = new EventBus();

  bus.publish({ type: 'A', payload: 1 });
  bus.publish({ type: 'B', payload: 2 });
  bus.publish({ type: 'C', payload: 3 });

  const h = bus.getHistory();
  assert.strictEqual(h.length, 3);
  assert.strictEqual(h[0].type, 'A');
  assert.strictEqual(h[1].type, 'B');
  assert.strictEqual(h[2].type, 'C');
});

test('EventBus: getHistory starts empty on a new bus', () => {
  const bus = new EventBus();
  assert.strictEqual(bus.getHistory().length, 0);
});

test('EventBus: event is added to history even when no subscribers exist', () => {
  const bus = new EventBus();
  bus.publish({ type: 'ORPHAN', payload: {} });

  assert.strictEqual(bus.getHistory().length, 1);
  assert.strictEqual(bus.getHistory()[0].type, 'ORPHAN');
});

test('EventBus: history entry is the same object reference passed to publish', () => {
  const bus   = new EventBus();
  const event = { type: 'TICK', payload: { x: 1 } };

  bus.publish(event);

  assert.strictEqual(bus.getHistory()[0], event);
});

// ─── Subscriber receives correct event object ─────────────────────────────────

test('EventBus: handler receives the exact event object that was published', () => {
  const bus   = new EventBus();
  const event = { type: 'TICK', date: new Date(2025, 0, 1), payload: { n: 42 } };
  let received;

  bus.subscribe('TICK', (e) => { received = e; });
  bus.publish(event);

  assert.strictEqual(received, event);
});

// ─── Publishing without prior subscribe ───────────────────────────────────────

test('EventBus: publishing to an unsubscribed type does not throw', () => {
  const bus = new EventBus();
  assert.doesNotThrow(() => bus.publish({ type: 'UNKNOWN', payload: {} }));
});
