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
 * event-builder.test.mjs
 * Tests for EventBuilder (EventSeries and OneOffEvent construction)
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { EventBuilder }  from '../../src/simulation-framework/builders/event-builder.js';
import { EventSeries }   from '../../src/simulation-framework/events/event-series.js';
import { OneOffEvent }   from '../../src/simulation-framework/events/one-off-event.js';

// ─── EventSeries builder ──────────────────────────────────────────────────────

test('EventBuilder.eventSeries: build() returns an EventSeries instance', () => {
  const event = EventBuilder.eventSeries().type('TICK').interval('monthly').build();
  assert.ok(event instanceof EventSeries);
});

test('EventBuilder.eventSeries: name is set', () => {
  const event = EventBuilder.eventSeries().name('My Event').type('T').interval('monthly').build();
  assert.strictEqual(event.name, 'My Event');
});

test('EventBuilder.eventSeries: type is set', () => {
  const event = EventBuilder.eventSeries().type('MONTH_END').interval('month-end').build();
  assert.strictEqual(event.type, 'MONTH_END');
});

test('EventBuilder.eventSeries: id is set', () => {
  const event = EventBuilder.eventSeries().id('my-id').type('T').interval('monthly').build();
  assert.strictEqual(event.id, 'my-id');
});

test('EventBuilder.eventSeries: enabled defaults to true', () => {
  const event = EventBuilder.eventSeries().type('T').interval('monthly').build();
  assert.strictEqual(event.enabled, true);
});

test('EventBuilder.eventSeries: enabled can be set to false', () => {
  const event = EventBuilder.eventSeries().type('T').interval('monthly').enabled(false).build();
  assert.strictEqual(event.enabled, false);
});

test('EventBuilder.eventSeries: color defaults to #888888', () => {
  const event = EventBuilder.eventSeries().type('T').interval('monthly').build();
  assert.strictEqual(event.color, '#888888');
});

test('EventBuilder.eventSeries: color is set', () => {
  const event = EventBuilder.eventSeries().type('T').interval('monthly').color('#F44336').build();
  assert.strictEqual(event.color, '#F44336');
});

test('EventBuilder.eventSeries: interval is set', () => {
  const event = EventBuilder.eventSeries().type('T').interval('annually').build();
  assert.strictEqual(event.interval, 'annually');
});

test('EventBuilder.eventSeries: startOffset defaults to 0', () => {
  const event = EventBuilder.eventSeries().type('T').interval('monthly').build();
  assert.strictEqual(event.startOffset, 0);
});

test('EventBuilder.eventSeries: startOffset is set', () => {
  const event = EventBuilder.eventSeries().type('T').interval('annually').startOffset(2).build();
  assert.strictEqual(event.startOffset, 2);
});

test('EventBuilder.eventSeries: data is set', () => {
  const event = EventBuilder.eventSeries().type('T').interval('monthly').data({ amount: 500 }).build();
  assert.deepStrictEqual(event.data, { amount: 500 });
});

test('EventBuilder.eventSeries: meta is set', () => {
  const event = EventBuilder.eventSeries().type('T').interval('monthly').meta({ tag: 'x' }).build();
  assert.deepStrictEqual(event.meta, { tag: 'x' });
});

test('EventBuilder.eventSeries: builder is chainable and returns same builder', () => {
  const builder = EventBuilder.eventSeries();
  assert.strictEqual(builder.name('A'), builder);
  assert.strictEqual(builder.type('T'), builder);
  assert.strictEqual(builder.interval('monthly'), builder);
  assert.strictEqual(builder.enabled(true), builder);
  assert.strictEqual(builder.color('#fff'), builder);
  assert.strictEqual(builder.startOffset(1), builder);
  assert.strictEqual(builder.data({}), builder);
  assert.strictEqual(builder.meta({}), builder);
});

test('EventBuilder.eventSeries: each build() call creates a new instance', () => {
  const builder = EventBuilder.eventSeries().type('T').interval('monthly');
  const e1 = builder.build();
  const e2 = builder.build();
  assert.notStrictEqual(e1, e2);
});

// ─── OneOffEvent builder ──────────────────────────────────────────────────────

test('EventBuilder.oneOff: build() returns a OneOffEvent instance', () => {
  const event = EventBuilder.oneOff().type('SALE').date(new Date(2026, 0, 1)).build();
  assert.ok(event instanceof OneOffEvent);
});

test('EventBuilder.oneOff: name is set', () => {
  const event = EventBuilder.oneOff().name('Asset Sale').type('SALE').date(new Date(2026, 0, 1)).build();
  assert.strictEqual(event.name, 'Asset Sale');
});

test('EventBuilder.oneOff: type is set', () => {
  const event = EventBuilder.oneOff().type('ASSET_SALE').date(new Date(2026, 0, 1)).build();
  assert.strictEqual(event.type, 'ASSET_SALE');
});

test('EventBuilder.oneOff: id is set', () => {
  const event = EventBuilder.oneOff().id('oo-1').type('T').date(new Date(2026, 0, 1)).build();
  assert.strictEqual(event.id, 'oo-1');
});

test('EventBuilder.oneOff: date is set', () => {
  const d = new Date(2026, 5, 15);
  const event = EventBuilder.oneOff().type('T').date(d).build();
  assert.strictEqual(event.date, d);
});

test('EventBuilder.oneOff: enabled defaults to true', () => {
  const event = EventBuilder.oneOff().type('T').date(new Date()).build();
  assert.strictEqual(event.enabled, true);
});

test('EventBuilder.oneOff: color defaults to #888888', () => {
  const event = EventBuilder.oneOff().type('T').date(new Date()).build();
  assert.strictEqual(event.color, '#888888');
});

test('EventBuilder.oneOff: builder is chainable', () => {
  const builder = EventBuilder.oneOff();
  assert.strictEqual(builder.name('A'), builder);
  assert.strictEqual(builder.type('T'), builder);
  assert.strictEqual(builder.enabled(true), builder);
  assert.strictEqual(builder.color('#000'), builder);
  assert.strictEqual(builder.date(new Date()), builder);
  assert.strictEqual(builder.data({}), builder);
  assert.strictEqual(builder.meta({}), builder);
});
