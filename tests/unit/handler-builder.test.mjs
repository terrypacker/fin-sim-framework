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
 * handler-builder.test.mjs
 * Tests for HandlerBuilder
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { HandlerBuilder } from '../../src/simulation-framework/builders/handler-builder.js';
import { HandlerEntry }   from '../../src/simulation-framework/handlers.js';

// ─── Basic construction ───────────────────────────────────────────────────────

test('HandlerBuilder.handler: build() returns a HandlerEntry', () => {
  const h = HandlerBuilder.handler().build();
  assert.ok(h instanceof HandlerEntry);
});

test('HandlerBuilder.handler: name is set', () => {
  const h = HandlerBuilder.handler().name('My Handler').build();
  assert.strictEqual(h.name, 'My Handler');
});

test('HandlerBuilder.handler: name defaults to "anonymous"', () => {
  const h = HandlerBuilder.handler().build();
  assert.strictEqual(h.name, 'anonymous');
});

test('HandlerBuilder.handler: fn is set via constructor arg', () => {
  const fn = () => [];
  const h = HandlerBuilder.handler(fn).build();
  assert.strictEqual(h.fn, fn);
});

test('HandlerBuilder.handler: fn is set via .fn() method', () => {
  const fn = () => [];
  const h = HandlerBuilder.handler().fn(fn).build();
  assert.strictEqual(h.fn, fn);
});

test('HandlerBuilder.handler: null fn falls back to HandlerEntry defaultFunction', () => {
  const h = HandlerBuilder.handler(null).build();
  assert.strictEqual(h.fn, h.defaultFunction);
});

// ─── handledEvents ────────────────────────────────────────────────────────────

test('HandlerBuilder.handler: handledEvents defaults to empty array', () => {
  const h = HandlerBuilder.handler().build();
  assert.deepStrictEqual(h.handledEvents, []);
});

test('HandlerBuilder.handler: forEvent adds an event', () => {
  const event = { type: 'MONTH_END', id: 'e1' };
  const h = HandlerBuilder.handler().forEvent(event).build();
  assert.strictEqual(h.handledEvents.length, 1);
  assert.strictEqual(h.handledEvents[0], event);
});

test('HandlerBuilder.handler: forEvent can be called multiple times', () => {
  const e1 = { type: 'A', id: 'e1' };
  const e2 = { type: 'B', id: 'e2' };
  const h = HandlerBuilder.handler().forEvent(e1).forEvent(e2).build();
  assert.strictEqual(h.handledEvents.length, 2);
});

test('HandlerBuilder.handler: built handledEvents is a copy, not the builder internal array', () => {
  const e1 = { type: 'A', id: 'e1' };
  const builder = HandlerBuilder.handler().forEvent(e1);
  const h1 = builder.build();
  builder.forEvent({ type: 'B', id: 'e2' });
  const h2 = builder.build();
  assert.strictEqual(h1.handledEvents.length, 1, 'first built entry should not be affected by subsequent builder changes');
  assert.strictEqual(h2.handledEvents.length, 2);
});

// ─── generatedActions ─────────────────────────────────────────────────────────

test('HandlerBuilder.handler: generatedActions defaults to empty array', () => {
  const h = HandlerBuilder.handler().build();
  assert.deepStrictEqual(h.generatedActions, []);
});

test('HandlerBuilder.handler: generateAction adds an action', () => {
  const action = { type: 'ADD_CASH', name: 'Credit' };
  const h = HandlerBuilder.handler().generateAction(action).build();
  assert.strictEqual(h.generatedActions.length, 1);
  assert.strictEqual(h.generatedActions[0], action);
});

test('HandlerBuilder.handler: multiple generateAction calls accumulate actions', () => {
  const a1 = { type: 'A' };
  const a2 = { type: 'B' };
  const h = HandlerBuilder.handler().generateAction(a1).generateAction(a2).build();
  assert.strictEqual(h.generatedActions.length, 2);
});

// ─── Chaining ─────────────────────────────────────────────────────────────────

test('HandlerBuilder.handler: builder methods are chainable', () => {
  const b = HandlerBuilder.handler();
  assert.strictEqual(b.fn(() => []), b);
  assert.strictEqual(b.name('X'), b);
  assert.strictEqual(b.forEvent({ type: 'T' }), b);
  assert.strictEqual(b.generateAction({ type: 'A' }), b);
});

// ─── HandlerEntry.call still works ───────────────────────────────────────────

test('HandlerEntry built by builder: call() invokes the fn with the given context', () => {
  let received;
  const fn = (ctx) => { received = ctx; return []; };
  const h = HandlerBuilder.handler(fn).name('Test').build();
  const ctx = { date: new Date(), data: {}, state: {} };
  h.call(ctx);
  assert.strictEqual(received, ctx);
});
