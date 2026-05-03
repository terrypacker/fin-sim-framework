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
import { ActionDefinition } from '../../src/simulation-framework/actions.js';

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

// ─── generatedActionTypes ─────────────────────────────────────────────────────

test('HandlerBuilder.handler: generatedActionTypes defaults to empty array', () => {
  const h = HandlerBuilder.handler().build();
  assert.deepStrictEqual(h.generatedActionTypes, []);
});

test('HandlerBuilder.handler: generateActionType adds a type string', () => {
  const h = HandlerBuilder.handler().generateActionType('ADD_CASH').build();
  assert.strictEqual(h.generatedActionTypes.length, 1);
  assert.strictEqual(h.generatedActionTypes[0], 'ADD_CASH');
});

test('HandlerBuilder.handler: multiple generateActionType calls accumulate', () => {
  const h = HandlerBuilder.handler().generateActionType('A').generateActionType('B').build();
  assert.strictEqual(h.generatedActionTypes.length, 2);
});

test('HandlerBuilder.handler: generateActionType deduplicates type strings', () => {
  const h = HandlerBuilder.handler().generateActionType('A').generateActionType('A').build();
  assert.strictEqual(h.generatedActionTypes.length, 1);
});

// ─── generatedActionDefinitions ──────────────────────────────────────────────

test('HandlerBuilder.handler: generatedActionDefinitions defaults to empty array', () => {
  const h = HandlerBuilder.handler().build();
  assert.deepStrictEqual(h.generatedActionDefinitions, []);
});

test('HandlerBuilder.handler: generateActionDef adds a definition', () => {
  const def = new ActionDefinition({ type: 'ADD_CASH', config: { actionClass: 'AmountAction', name: 'Credit' } });
  const h = HandlerBuilder.handler().generateActionDef(def).build();
  assert.strictEqual(h.generatedActionDefinitions.length, 1);
  assert.strictEqual(h.generatedActionDefinitions[0], def);
});

test('HandlerBuilder.handler: generateActionDef also registers the type string', () => {
  const def = new ActionDefinition({ type: 'ADD_CASH', config: { actionClass: 'AmountAction' } });
  const h = HandlerBuilder.handler().generateActionDef(def).build();
  assert.ok(h.generatedActionTypes.includes('ADD_CASH'));
});

// ─── Chaining ─────────────────────────────────────────────────────────────────

test('HandlerBuilder.handler: builder methods are chainable', () => {
  const b = HandlerBuilder.handler();
  assert.strictEqual(b.fn(() => []), b);
  assert.strictEqual(b.name('X'), b);
  assert.strictEqual(b.forEvent({ type: 'T' }), b);
  assert.strictEqual(b.generateActionType('A'), b);
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
