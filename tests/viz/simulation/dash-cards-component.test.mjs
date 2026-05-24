/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import { DashCardsComponent } from '../../../src/visualization/simulation/dash-cards-component.js';
import { EventBus }           from '../../../src/simulation-framework/event-bus.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../../src/simulation-framework/bus-messages.js';

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = `
    <span id="cardCurrentDate"></span>
    <span id="cardEventExecutions"></span>
    <span id="cardHandlerExecutions"></span>
    <span id="cardActionExecutions"></span>
    <span id="cardReducerExecutions"></span>
  `;
  global.requestAnimationFrame = cb => setTimeout(cb, 0);
  global.performance = global.performance ?? { now: () => Date.now() };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const D1 = new Date(2025, 0, 1);

function makeComponent(formatDate) {
  return new DashCardsComponent({ formatDate });
}

function makeSim(overrides = {}) {
  return {
    eventExecutions:   10,
    handlerExecutions: 20,
    actionExecutions:  30,
    reducerExecutions: 40,
    ...overrides,
  };
}

function makeExecMsg(type, date = D1) {
  return { type, kind: EXECUTION_KINDS.EVENT, date: date.toISOString() };
}

function makeBeginMsg(date = D1) {
  return makeExecMsg(`EXECUTION_${EXECUTION_PHASES.BEGIN}`, date);
}

function makeEndMsg(date = D1) {
  return makeExecMsg(`EXECUTION_${EXECUTION_PHASES.END}`, date);
}

// ─── Constructor ─────────────────────────────────────────────────────────────

test('DashCardsComponent: drain functions are noops before wireSimBus', () => {
  const comp = makeComponent();
  assert.deepStrictEqual(comp._drainBeginMsgs(), []);
  assert.deepStrictEqual(comp._drainEndMsgs(),   []);
});

// ─── wireSimBus ───────────────────────────────────────────────────────────────

test('DashCardsComponent.wireSimBus: subscribes to EXECUTION_BEGIN(EVENT)', () => {
  const comp = makeComponent();
  const bus  = new EventBus();
  comp.wireSimBus(bus, makeSim());
  bus.publish(makeBeginMsg());
  assert.strictEqual(comp._drainBeginMsgs().length, 1);
});

test('DashCardsComponent.wireSimBus: subscribes to EXECUTION_END(EVENT)', () => {
  const comp = makeComponent();
  const bus  = new EventBus();
  comp.wireSimBus(bus, makeSim());
  bus.publish(makeEndMsg());
  assert.strictEqual(comp._drainEndMsgs().length, 1);
});

test('DashCardsComponent.wireSimBus: rejects non-EVENT-kind messages', () => {
  const comp = makeComponent();
  const bus  = new EventBus();
  comp.wireSimBus(bus, makeSim());
  bus.publish({ type: `EXECUTION_${EXECUTION_PHASES.END}`, kind: EXECUTION_KINDS.ACTION, date: D1.toISOString() });
  assert.strictEqual(comp._drainEndMsgs().length, 0);
});

test('DashCardsComponent.wireSimBus: stores sim reference', () => {
  const comp = makeComponent();
  const bus  = new EventBus();
  const sim  = makeSim();
  comp.wireSimBus(bus, sim);
  assert.strictEqual(comp._sim, sim);
});

// ─── update (synchronous external path) ──────────────────────────────────────

test('DashCardsComponent.update: sets _pendingDate', () => {
  const comp = makeComponent();
  comp.update(D1);
  assert.strictEqual(comp._pendingDate, D1);
});

// ─── _doRender ────────────────────────────────────────────────────────────────

test('DashCardsComponent._doRender: renders date using formatDate', () => {
  const fmt  = d => `DATE:${d.getFullYear()}`;
  const comp = makeComponent(fmt);
  comp.update(D1);
  comp._doRender();
  assert.strictEqual(document.getElementById('cardCurrentDate').innerText, 'DATE:2025');
});

test('DashCardsComponent._doRender: renders sim execution counters', () => {
  const comp = makeComponent();
  const bus  = new EventBus();
  comp.wireSimBus(bus, makeSim({ eventExecutions: 5, handlerExecutions: 12, actionExecutions: 7, reducerExecutions: 3 }));
  comp.update(D1);
  comp._doRender();
  // jsdom may return innerText as number when set via assignment; compare numerically
  assert.strictEqual(+document.getElementById('cardEventExecutions').innerText,   5);
  assert.strictEqual(+document.getElementById('cardHandlerExecutions').innerText, 12);
  assert.strictEqual(+document.getElementById('cardActionExecutions').innerText,  7);
  assert.strictEqual(+document.getElementById('cardReducerExecutions').innerText, 3);
});

test('DashCardsComponent._doRender: uses latest date from queued messages', () => {
  const fmt  = d => d.toISOString().slice(0, 10);
  const comp = makeComponent(fmt);
  const bus  = new EventBus();
  comp.wireSimBus(bus, makeSim());
  const D2 = new Date(2026, 5, 1);
  bus.publish(makeBeginMsg(D1));
  bus.publish(makeEndMsg(D2));
  comp._doRender();
  assert.strictEqual(document.getElementById('cardCurrentDate').innerText, '2026-06-01');
});

test('DashCardsComponent._doRender: skips render when no date is available', () => {
  const comp = makeComponent();
  const bus  = new EventBus();
  comp.wireSimBus(bus, makeSim());
  // No date set, no messages published — _doRender returns early without touching the DOM
  assert.doesNotThrow(() => comp._doRender());
  // DOM stays untouched; just verify no error was thrown (above assertion is sufficient)
});

test('DashCardsComponent._doRender: falls back to zeros when sim is null', () => {
  const comp = makeComponent();
  comp.update(D1);
  comp._doRender();
  assert.strictEqual(+document.getElementById('cardEventExecutions').innerText, 0);
});

// ─── setRenderThrottle (inherited from BaseComponent) ────────────────────────

test('DashCardsComponent.setRenderThrottle: sets _renderThrottleMs', () => {
  const comp = makeComponent();
  comp.setRenderThrottle(1000);
  assert.strictEqual(comp._renderThrottleMs, 1000);
});
