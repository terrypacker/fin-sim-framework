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
import { BaseComponent }  from '../../../src/visualization/components/base-component.js';
import { EventBus }       from '../../../src/simulation-framework/event-bus.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../../src/simulation-framework/bus-messages.js';

let _rafQueue = [];
beforeEach(() => {
  _rafQueue = [];
  global.requestAnimationFrame = cb => { _rafQueue.push(cb); return _rafQueue.length; };
  global.cancelAnimationFrame  = ()  => {};
  global.performance = { now: () => 0 };
});

function flushRaf() {
  const cbs = _rafQueue.splice(0);
  cbs.forEach(cb => cb(0));
}

class TestComponent extends BaseComponent {
  constructor() {
    super();
    this.renders = 0;
  }
  render() { this.scheduleRender(() => { this.renders++; }); }
}

// ─── busQueue — basic subscription ────────────────────────────────────────────

test('BaseComponent.busQueue: returns a drain function', () => {
  const comp = new TestComponent();
  const bus  = new EventBus();
  const drain = comp.busQueue(bus, 'MY_EVENT', () => comp.render());
  assert.strictEqual(typeof drain, 'function');
});

test('BaseComponent.busQueue: queues messages on publish', () => {
  const comp = new TestComponent();
  const bus  = new EventBus();
  const drain = comp.busQueue(bus, 'MY_EVENT', () => comp.render());
  bus.publish({ type: 'MY_EVENT', value: 1 });
  bus.publish({ type: 'MY_EVENT', value: 2 });
  const msgs = drain();
  assert.strictEqual(msgs.length, 2);
});

test('BaseComponent.busQueue: drain clears the queue', () => {
  const comp = new TestComponent();
  const bus  = new EventBus();
  const drain = comp.busQueue(bus, 'MY_EVENT', () => comp.render());
  bus.publish({ type: 'MY_EVENT', value: 42 });
  drain();
  assert.strictEqual(drain().length, 0, 'second drain should return empty array');
});

test('BaseComponent.busQueue: drain returns messages in arrival order', () => {
  const comp = new TestComponent();
  const bus  = new EventBus();
  const drain = comp.busQueue(bus, 'MY_EVENT', () => comp.render());
  bus.publish({ type: 'MY_EVENT', n: 1 });
  bus.publish({ type: 'MY_EVENT', n: 2 });
  bus.publish({ type: 'MY_EVENT', n: 3 });
  const msgs = drain();
  assert.deepStrictEqual(msgs.map(m => m.n), [1, 2, 3]);
});

test('BaseComponent.busQueue: calls renderFn on each message arrival', () => {
  let calls = 0;
  const comp = new TestComponent();
  const bus  = new EventBus();
  comp.busQueue(bus, 'MY_EVENT', () => { calls++; });
  bus.publish({ type: 'MY_EVENT' });
  bus.publish({ type: 'MY_EVENT' });
  assert.strictEqual(calls, 2);
});

test('BaseComponent.busQueue: does not queue messages of other types', () => {
  const comp = new TestComponent();
  const bus  = new EventBus();
  const drain = comp.busQueue(bus, 'MY_EVENT', () => comp.render());
  bus.publish({ type: 'OTHER_EVENT', value: 99 });
  assert.strictEqual(drain().length, 0);
});

// ─── busQueue — subscription cleanup (leak regression) ────────────────────────

test('BaseComponent.busQueue: destroy() unsubscribes from the bus', () => {
  const comp = new TestComponent();
  const bus  = new EventBus();
  const drain = comp.busQueue(bus, 'MY_EVENT', () => comp.render());
  comp.destroy();
  bus.publish({ type: 'MY_EVENT', value: 1 });
  assert.strictEqual(drain().length, 0, 'no messages should queue after destroy');
  assert.strictEqual(bus.listeners.get('MY_EVENT').length, 0, 'listener must be removed from the bus');
});

test('BaseComponent.busQueue: drain.unsubscribe() removes the subscription without destroy', () => {
  const comp = new TestComponent();
  const bus  = new EventBus();
  const drain = comp.busQueue(bus, 'MY_EVENT', () => comp.render());
  assert.strictEqual(typeof drain.unsubscribe, 'function');
  drain.unsubscribe();
  bus.publish({ type: 'MY_EVENT', value: 1 });
  assert.strictEqual(drain().length, 0, 'unsubscribe should stop queuing');
  assert.strictEqual(bus.listeners.get('MY_EVENT').length, 0);
});

test('BaseComponent.busQueue: subscriptions do not accumulate across repeated subscribe/destroy cycles', () => {
  const bus = new EventBus();
  for (let i = 0; i < 5; i++) {
    const comp = new TestComponent();
    comp.busQueue(bus, 'MY_EVENT', () => comp.render());
    comp.destroy();
  }
  assert.strictEqual(bus.listeners.get('MY_EVENT').length, 0, 'no leaked listeners after destroy cycles');
});

// ─── busQueue — filter support ─────────────────────────────────────────────────

test('BaseComponent.busQueue: kind filter allows matching messages', () => {
  const comp = new TestComponent();
  const bus  = new EventBus();
  const drain = comp.busQueue(bus, `EXECUTION_${EXECUTION_PHASES.END}`, () => comp.render(), { kind: EXECUTION_KINDS.EVENT });
  bus.publish({ type: `EXECUTION_${EXECUTION_PHASES.END}`, kind: EXECUTION_KINDS.EVENT });
  assert.strictEqual(drain().length, 1);
});

test('BaseComponent.busQueue: kind filter rejects non-matching messages', () => {
  const comp = new TestComponent();
  const bus  = new EventBus();
  const drain = comp.busQueue(bus, `EXECUTION_${EXECUTION_PHASES.END}`, () => comp.render(), { kind: EXECUTION_KINDS.EVENT });
  bus.publish({ type: `EXECUTION_${EXECUTION_PHASES.END}`, kind: EXECUTION_KINDS.HANDLER });
  bus.publish({ type: `EXECUTION_${EXECUTION_PHASES.END}`, kind: EXECUTION_KINDS.ACTION });
  assert.strictEqual(drain().length, 0, 'non-EVENT-kind messages must be rejected');
});

test('BaseComponent.busQueue: no filter queues all messages of the type', () => {
  const comp = new TestComponent();
  const bus  = new EventBus();
  const drain = comp.busQueue(bus, `EXECUTION_${EXECUTION_PHASES.END}`, () => comp.render());
  bus.publish({ type: `EXECUTION_${EXECUTION_PHASES.END}`, kind: EXECUTION_KINDS.EVENT });
  bus.publish({ type: `EXECUTION_${EXECUTION_PHASES.END}`, kind: EXECUTION_KINDS.HANDLER });
  assert.strictEqual(drain().length, 2);
});

// ─── setRenderThrottle ────────────────────────────────────────────────────────

test('BaseComponent.setRenderThrottle: stores value in _renderThrottleMs', () => {
  const comp = new TestComponent();
  comp.setRenderThrottle(1000);
  assert.strictEqual(comp._renderThrottleMs, 1000);
});

test('BaseComponent.setRenderThrottle: 0 restores RAF mode', () => {
  const comp = new TestComponent();
  comp.setRenderThrottle(500);
  comp.setRenderThrottle(0);
  assert.strictEqual(comp._renderThrottleMs, 0);
});

// ─── scheduleRender — coalescing ───────────────────────────────────────────────

test('BaseComponent.scheduleRender: coalesces rapid calls into one RAF frame', () => {
  const comp = new TestComponent();
  comp.render();
  comp.render();
  comp.render();
  assert.strictEqual(_rafQueue.length, 1, 'only one RAF should be scheduled');
  flushRaf();
  assert.strictEqual(comp.renders, 1, 'fn should be called exactly once');
});

test('BaseComponent.scheduleRender: allows a new frame after the previous one fires', () => {
  const comp = new TestComponent();
  comp.render();
  flushRaf();
  comp.render();
  flushRaf();
  assert.strictEqual(comp.renders, 2);
});

// ─── destroy ──────────────────────────────────────────────────────────────────

test('BaseComponent.destroy: runs registered cleanups', () => {
  const comp    = new TestComponent();
  let cleaned   = false;
  comp.onCleanup(() => { cleaned = true; });
  comp.destroy();
  assert.ok(cleaned, 'cleanup should be called on destroy');
});

test('BaseComponent.destroy: destroys registered children', () => {
  const parent  = new TestComponent();
  const child   = new TestComponent();
  let cleaned   = false;
  child.onCleanup(() => { cleaned = true; });
  parent._registerChild(child);
  parent.destroy();
  assert.ok(cleaned, 'child cleanup should be called when parent is destroyed');
});
