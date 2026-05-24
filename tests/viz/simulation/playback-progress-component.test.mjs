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
import { PlaybackProgressComponent } from '../../../src/visualization/simulation/playback-progress-component.js';
import { EventBus }                  from '../../../src/simulation-framework/event-bus.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../../src/simulation-framework/bus-messages.js';

// ─── Setup ────────────────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeScenario(startYear = 2025, endYear = 2030) {
  return {
    simStart: new Date(startYear, 0, 1),
    simEnd:   new Date(endYear,   0, 1),
  };
}

function makeComponent(overrides = {}) {
  const scenario   = overrides.scenario   ?? makeScenario();
  const timeSlider = overrides.timeSlider ?? { value: 0 };
  const timeLabel  = overrides.timeLabel  ?? { textContent: '' };
  const formatDate = overrides.formatDate ?? (d => d.toDateString());
  const comp = new PlaybackProgressComponent({ scenario, timeSlider, timeLabel, formatDate });
  return { comp, scenario, timeSlider, timeLabel };
}

function makeBeginMsg(date) {
  return {
    type: `EXECUTION_${EXECUTION_PHASES.BEGIN}`,
    kind: EXECUTION_KINDS.EVENT,
    date: date.toISOString(),
  };
}

// ─── update() — direct synchronous path ──────────────────────────────────────

test('PlaybackProgressComponent.update: schedules a render', () => {
  const { comp } = makeComponent();
  comp.update(new Date(2027, 0, 1));
  assert.strictEqual(_rafQueue.length, 1);
});

test('PlaybackProgressComponent.update: slider reflects correct percentage after RAF flush', () => {
  const { comp, scenario, timeSlider } = makeComponent();
  const { simStart, simEnd } = scenario;
  const mid = new Date((simStart.getTime() + simEnd.getTime()) / 2);
  comp.update(mid);
  flushRaf();
  const expected = Math.round(
    (mid.getTime() - simStart.getTime()) / (simEnd.getTime() - simStart.getTime()) * 100
  );
  assert.strictEqual(+timeSlider.value, expected);
});

test('PlaybackProgressComponent.update: label reflects the date via formatDate', () => {
  const { comp, scenario, timeLabel } = makeComponent();
  const { simStart, simEnd } = scenario;
  const mid = new Date((simStart.getTime() + simEnd.getTime()) / 2);
  comp.update(mid);
  flushRaf();
  assert.strictEqual(timeLabel.textContent, mid.toDateString());
});

test('PlaybackProgressComponent.update: coalesces rapid calls — only last date used', () => {
  const { comp, scenario, timeSlider } = makeComponent();
  const { simStart, simEnd } = scenario;
  const d1 = new Date(2026, 0, 1);
  const d2 = new Date(2027, 0, 1);
  const d3 = new Date(2028, 0, 1);
  comp.update(d1);
  comp.update(d2);
  comp.update(d3);
  assert.strictEqual(_rafQueue.length, 1, 'only one RAF should be scheduled');
  flushRaf();
  const expected = Math.round(
    (d3.getTime() - simStart.getTime()) / (simEnd.getTime() - simStart.getTime()) * 100
  );
  assert.strictEqual(+timeSlider.value, expected, 'slider should show the latest date');
});

test('PlaybackProgressComponent.update: allows a new frame after the first flushes', () => {
  const { comp, scenario, timeSlider } = makeComponent();
  const { simStart, simEnd } = scenario;
  const d1 = new Date(2026, 0, 1);
  const d2 = new Date(2028, 0, 1);
  comp.update(d1);
  flushRaf();
  comp.update(d2);
  flushRaf();
  const expected = Math.round(
    (d2.getTime() - simStart.getTime()) / (simEnd.getTime() - simStart.getTime()) * 100
  );
  assert.strictEqual(+timeSlider.value, expected);
});

test('PlaybackProgressComponent.update: does not render when date is null initially', () => {
  const { comp, timeSlider } = makeComponent();
  // No update call — _pendingDate stays null
  flushRaf();
  assert.strictEqual(+timeSlider.value, 0, 'slider should be untouched before first update');
});

// ─── wireSimBus — bus-driven path ─────────────────────────────────────────────

test('PlaybackProgressComponent.wireSimBus: EXECUTION_BEGIN(EVENT) updates slider after RAF', () => {
  const { comp, scenario, timeSlider } = makeComponent();
  const { simStart, simEnd } = scenario;
  const bus = new EventBus();
  comp.wireSimBus(bus);
  const mid = new Date((simStart.getTime() + simEnd.getTime()) / 2);
  bus.publish(makeBeginMsg(mid));
  flushRaf();
  const expected = Math.round(
    (mid.getTime() - simStart.getTime()) / (simEnd.getTime() - simStart.getTime()) * 100
  );
  assert.strictEqual(+timeSlider.value, expected);
});

test('PlaybackProgressComponent.wireSimBus: ignores non-EVENT-kind messages', () => {
  const { comp, timeSlider } = makeComponent();
  const bus = new EventBus();
  comp.wireSimBus(bus);
  bus.publish({ type: `EXECUTION_${EXECUTION_PHASES.BEGIN}`, kind: EXECUTION_KINDS.HANDLER, date: new Date(2027, 0, 1).toISOString() });
  flushRaf();
  assert.strictEqual(+timeSlider.value, 0, 'non-EVENT messages should not move the slider');
});

test('PlaybackProgressComponent.wireSimBus: coalesces rapid messages — last date wins', () => {
  const { comp, scenario, timeSlider, timeLabel } = makeComponent();
  const { simStart, simEnd } = scenario;
  const bus = new EventBus();
  comp.wireSimBus(bus);
  const d1 = new Date(2026, 0, 1);
  const d2 = new Date(2027, 0, 1);
  const d3 = new Date(2028, 0, 1);
  bus.publish(makeBeginMsg(d1));
  bus.publish(makeBeginMsg(d2));
  bus.publish(makeBeginMsg(d3));
  assert.strictEqual(_rafQueue.length, 1, 'only one RAF should be scheduled for rapid events');
  flushRaf();
  const expected = Math.round(
    (d3.getTime() - simStart.getTime()) / (simEnd.getTime() - simStart.getTime()) * 100
  );
  assert.strictEqual(+timeSlider.value, expected, 'slider should show the last event date');
  assert.strictEqual(timeLabel.textContent, d3.toDateString(), 'label should show the last event date');
});

test('PlaybackProgressComponent.wireSimBus: drain clears the queue between renders', () => {
  const { comp, scenario, timeSlider } = makeComponent();
  const { simStart, simEnd } = scenario;
  const bus = new EventBus();
  comp.wireSimBus(bus);
  const d1 = new Date(2026, 0, 1);
  const d2 = new Date(2028, 0, 1);
  bus.publish(makeBeginMsg(d1));
  flushRaf();
  bus.publish(makeBeginMsg(d2));
  flushRaf();
  const expected = Math.round(
    (d2.getTime() - simStart.getTime()) / (simEnd.getTime() - simStart.getTime()) * 100
  );
  assert.strictEqual(+timeSlider.value, expected, 'second render should use d2, not stale d1');
});

// ─── setRenderThrottle (inherited from BaseComponent) ─────────────────────────

test('PlaybackProgressComponent.setRenderThrottle: sets _renderThrottleMs', () => {
  const { comp } = makeComponent();
  comp.setRenderThrottle(1000);
  assert.strictEqual(comp._renderThrottleMs, 1000);
});

// ─── formatDate injection ─────────────────────────────────────────────────────

test('PlaybackProgressComponent: uses injected formatDate function', () => {
  const fmt  = d => `YEAR:${d.getFullYear()}`;
  const { comp, timeLabel } = makeComponent({ formatDate: fmt });
  comp.update(new Date(2027, 6, 1));
  flushRaf();
  assert.strictEqual(timeLabel.textContent, 'YEAR:2027');
});
