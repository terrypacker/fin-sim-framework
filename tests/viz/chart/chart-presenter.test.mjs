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
import { ChartController } from '../../../src/visualization/chart/chart-controller.js';
import { ChartPresenter }  from '../../../src/visualization/chart/chart-presenter.js';
import { EventBus }        from '../../../src/simulation-framework/event-bus.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../../src/simulation-framework/bus-messages.js';

// ─── DOM setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Provide the filter bar template and container so startViz → _mountFilter works.
  document.body.innerHTML = `
    <div id="chartFilterContainer"></div>
    <template id="tpl-chart-filter-bar">
      <div class="tl-filter-bar">
        <div id="chart-metric-select"></div>
      </div>
    </template>
  `;
  global.requestAnimationFrame = cb => setTimeout(cb, 0);
  global.performance = global.performance ?? { now: () => Date.now() };
});

// ─── Mock view ────────────────────────────────────────────────────────────────
// A lightweight stand-in that records calls without needing Chart.js.

function makeMockView(filterBarEl = null) {
  let _filterBarEl = filterBarEl;
  const calls = {
    addSnapshot:       [],
    setDatasetVisible: [],
    setRenderThrottle: [],
    resetHistory:      0,
    startViz:          0,
    stopViz:           0,
    addAnnotation:     [],
    removeAnnotation:  [],
  };
  return {
    calls,
    _children: new Set(),
    _cleanups:  [],
    running:    false,
    get _filterBarEl() { return _filterBarEl; },
    addSnapshot(date, data)          { calls.addSnapshot.push({ date, data }); },
    setDatasetVisible(key, visible)  { calls.setDatasetVisible.push({ key, visible }); },
    setRenderThrottle(ms)            { calls.setRenderThrottle.push(ms); },
    resetHistory()                   { calls.resetHistory++; },
    startViz()                       { calls.startViz++; this.running = true; },
    stopViz()                        { calls.stopViz++;  this.running = false; },
    addAnnotation(id, opts)          { calls.addAnnotation.push({ id, opts }); },
    removeAnnotation(id)             { calls.removeAnnotation.push(id); },
    mountFilterBar() {
      if (_filterBarEl) return _filterBarEl;
      const bar = document.createElement('div');
      const sel = document.createElement('div');
      sel.id = 'chart-metric-select';
      bar.appendChild(sel);
      _filterBarEl = bar;
      return bar;
    },
    _registerChild(child) { this._children.add(child); },
    destroy() {
      for (const c of this._children) c.destroy?.();
      this._children.clear();
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePresenter(viewOverride) {
  const controller = new ChartController();
  const view       = viewOverride ?? makeMockView();
  const presenter  = new ChartPresenter({ controller, view });
  return { presenter, controller, view };
}

const D1 = new Date(2025, 0, 1);

// ─── startViz / stopViz ───────────────────────────────────────────────────────

test('ChartPresenter.startViz: delegates to view.startViz', () => {
  const { presenter, view } = makePresenter();
  presenter.startViz();
  assert.strictEqual(view.calls.startViz, 1);
});

test('ChartPresenter.startViz: mounts the metric filter', () => {
  const { presenter } = makePresenter();
  presenter.startViz();
  assert.ok(presenter._metricFilter !== null, 'filter should be created');
});

test('ChartPresenter.stopViz: delegates to view.stopViz', () => {
  const { presenter, view } = makePresenter();
  presenter.startViz();
  presenter.stopViz();
  assert.strictEqual(view.calls.stopViz, 1);
});

test('ChartPresenter.stopViz: clears _metricFilter reference', () => {
  const { presenter } = makePresenter();
  presenter.startViz();
  presenter.stopViz();
  assert.strictEqual(presenter._metricFilter, null);
});

// ─── setRenderThrottle ────────────────────────────────────────────────────────

// ChartPresenter now extends BaseComponent and owns its own throttle.
// It no longer delegates setRenderThrottle to the view — the view is only
// rendered from ChartPresenter's already-throttled scheduleRender path.
test('ChartPresenter.setRenderThrottle: sets _renderThrottleMs on presenter', () => {
  const { presenter } = makePresenter();
  presenter.setRenderThrottle(500);
  assert.strictEqual(presenter._renderThrottleMs, 500);
});

test('ChartPresenter.setRenderThrottle: does not delegate to view', () => {
  const { presenter, view } = makePresenter();
  presenter.setRenderThrottle(500);
  assert.deepStrictEqual(view.calls.setRenderThrottle, [],
    'view.setRenderThrottle should not be called — view is driven by presenter');
});

// ─── addAnnotation / removeAnnotation ─────────────────────────────────────────

test('ChartPresenter.addAnnotation: delegates to view', () => {
  const { presenter, view } = makePresenter();
  presenter.addAnnotation('evt1', { label: 'A', date: D1 });
  assert.strictEqual(view.calls.addAnnotation.length, 1);
  assert.strictEqual(view.calls.addAnnotation[0].id, 'evt1');
});

test('ChartPresenter.removeAnnotation: delegates to view', () => {
  const { presenter, view } = makePresenter();
  presenter.removeAnnotation('evt1');
  assert.deepStrictEqual(view.calls.removeAnnotation, ['evt1']);
});

// ─── addSnapshot — data forwarding ───────────────────────────────────────────

test('ChartPresenter.addSnapshot: forwards to view.addSnapshot', () => {
  const { presenter, view } = makePresenter();
  presenter.addSnapshot(D1, { balance: 1000 });
  assert.strictEqual(view.calls.addSnapshot.length, 1);
  assert.deepStrictEqual(view.calls.addSnapshot[0].data, { balance: 1000 });
});

test('ChartPresenter.addSnapshot: null data is forwarded without throwing', () => {
  const { presenter } = makePresenter();
  assert.doesNotThrow(() => presenter.addSnapshot(D1, null));
});

// ─── addSnapshot — key discovery ─────────────────────────────────────────────

test('ChartPresenter.addSnapshot: discovers new keys in controller', () => {
  const { presenter, controller } = makePresenter();
  presenter.addSnapshot(D1, { balance: 1000 });
  assert.deepStrictEqual(controller.getAllKeys(), ['balance']);
});

test('ChartPresenter.addSnapshot: does not re-discover the same key twice', () => {
  const { presenter, controller } = makePresenter();
  presenter.addSnapshot(D1, { balance: 1000 });
  presenter.addSnapshot(D1, { balance: 2000 });
  assert.strictEqual(controller.getAllKeys().length, 1);
});

test('ChartPresenter.addSnapshot: discovers multiple keys from one snapshot', () => {
  const { presenter, controller } = makePresenter();
  presenter.addSnapshot(D1, { a: 1, b: 2, c: 3 });
  assert.strictEqual(controller.getAllKeys().length, 3);
});

// ─── addSnapshot — visibility application ────────────────────────────────────

test('ChartPresenter.addSnapshot: does not hide a newly discovered visible key', () => {
  const { presenter, view } = makePresenter();
  presenter.addSnapshot(D1, { balance: 1000 });
  const hiddenCalls = view.calls.setDatasetVisible.filter(c => c.key === 'balance' && !c.visible);
  assert.strictEqual(hiddenCalls.length, 0);
});

test('ChartPresenter.addSnapshot: hides a key that was already hidden in the controller', () => {
  const { presenter, controller, view } = makePresenter();
  // Pre-hide 'balance' before the simulation sees it
  controller.discoverKey('balance');
  controller.setVisible('balance', false);
  // Now presenter encounters 'balance' for the first time
  presenter.addSnapshot(D1, { balance: 1000 });
  const hiddenCalls = view.calls.setDatasetVisible.filter(c => c.key === 'balance' && !c.visible);
  assert.strictEqual(hiddenCalls.length, 1, 'should apply the hidden state immediately');
});

test('ChartPresenter.addSnapshot: does not call setDatasetVisible for visible keys', () => {
  const { presenter, view } = makePresenter();
  presenter.addSnapshot(D1, { balance: 1000, income: 500 });
  assert.strictEqual(view.calls.setDatasetVisible.length, 0);
});

// ─── resetHistory ─────────────────────────────────────────────────────────────

test('ChartPresenter.resetHistory: delegates to view.resetHistory', () => {
  const { presenter, view } = makePresenter();
  presenter.addSnapshot(D1, { balance: 1000 });
  presenter.resetHistory();
  assert.strictEqual(view.calls.resetHistory, 1);
});

test('ChartPresenter.resetHistory: clears _processedKeys so keys are re-discovered', () => {
  const { presenter, view } = makePresenter();
  presenter.addSnapshot(D1, { balance: 1000 });
  presenter.resetHistory();
  presenter.addSnapshot(D1, { balance: 2000 });
  // Two addSnapshot calls should have happened on the view
  assert.strictEqual(view.calls.addSnapshot.length, 2);
});

test('ChartPresenter.resetHistory: controller hidden-key state is preserved', () => {
  const { presenter, controller } = makePresenter();
  presenter.addSnapshot(D1, { balance: 1000 });
  controller.setVisible('balance', false);
  presenter.resetHistory();
  assert.strictEqual(controller.isVisible('balance'), false,
    'hidden key should survive a rewind');
});

test('ChartPresenter.resetHistory: hidden key is re-applied on next replay', () => {
  const { presenter, controller, view } = makePresenter();
  // First run: discover and hide 'balance'
  presenter.addSnapshot(D1, { balance: 1000 });
  controller.setVisible('balance', false);
  // Rewind
  presenter.resetHistory();
  view.calls.setDatasetVisible.length = 0; // clear prior calls
  // Second run: balance should be hidden immediately when re-encountered
  presenter.addSnapshot(D1, { balance: 2000 });
  const hiddenCalls = view.calls.setDatasetVisible.filter(c => c.key === 'balance' && !c.visible);
  assert.strictEqual(hiddenCalls.length, 1,
    'hidden state should be re-applied after rewind');
});

// ─── Filter toggle behaviour ──────────────────────────────────────────────────

test('ChartPresenter: filter toggle with selections hides non-selected keys', () => {
  const { presenter, controller, view } = makePresenter();
  presenter.startViz();
  // Populate the controller with known keys
  presenter.addSnapshot(D1, { a: 1, b: 2, c: 3 });
  view.calls.setDatasetVisible.length = 0; // reset for clarity

  // Simulate the filter selecting only 'a' and 'c'
  const onToggle = presenter._metricFilter._onToggle;
  const selected = [{ id: 'a', name: 'A' }, { id: 'c', name: 'C' }];
  onToggle({}, true, selected);

  const visibilityCalls = Object.fromEntries(
    view.calls.setDatasetVisible.map(c => [c.key, c.visible])
  );
  assert.strictEqual(visibilityCalls['a'], true,  'a should be visible');
  assert.strictEqual(visibilityCalls['c'], true,  'c should be visible');
  assert.strictEqual(visibilityCalls['b'], false, 'b should be hidden');
});

test('ChartPresenter: filter toggle with empty selection shows all keys', () => {
  const { presenter, controller, view } = makePresenter();
  presenter.startViz();
  presenter.addSnapshot(D1, { a: 1, b: 2 });
  controller.setVisible('a', false);
  controller.setVisible('b', false);
  view.calls.setDatasetVisible.length = 0;

  const onToggle = presenter._metricFilter._onToggle;
  onToggle({}, false, []);  // empty selection → show all

  const allVisible = view.calls.setDatasetVisible.every(c => c.visible === true);
  assert.ok(allVisible, 'all keys should be made visible when selection is cleared');
});

test('ChartPresenter: filter toggle with empty selection clears controller hidden set', () => {
  const { presenter, controller } = makePresenter();
  presenter.startViz();
  presenter.addSnapshot(D1, { a: 1, b: 2 });
  controller.setVisible('a', false);

  const onToggle = presenter._metricFilter._onToggle;
  onToggle({}, false, []);

  assert.strictEqual(controller.isVisible('a'), true, 'controller should clear hidden on empty selection');
});

// ─── wireSimBus ───────────────────────────────────────────────────────────────

function makeSimBus() {
  return new EventBus();
}

function makeExecEndMsg(date, metrics = {}) {
  return {
    type:          `EXECUTION_${EXECUTION_PHASES.END}`,
    kind:          EXECUTION_KINDS.EVENT,
    date:          date.toISOString(),
    stateSnapshot: { metrics },
  };
}

test('ChartPresenter.wireSimBus: subscribes to EXECUTION_END(EVENT)', () => {
  const { presenter } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  // Publishing a non-EVENT kind should not enqueue
  const before = presenter._drainExecEndMsgs().length;
  bus.publish({ type: `EXECUTION_${EXECUTION_PHASES.END}`, kind: EXECUTION_KINDS.HANDLER, date: D1.toISOString() });
  const after = presenter._drainExecEndMsgs().length;
  assert.strictEqual(before, 0);
  assert.strictEqual(after,  0, 'HANDLER-kind end messages should not be queued');
});

test('ChartPresenter.wireSimBus: queues EXECUTION_END(EVENT) messages', () => {
  const { presenter } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  bus.publish(makeExecEndMsg(D1, { balance: 1000 }));
  bus.publish(makeExecEndMsg(new Date(2025, 1, 1), { balance: 1100 }));
  const queued = presenter._drainExecEndMsgs();
  assert.strictEqual(queued.length, 2, 'both messages should be queued');
});

test('ChartPresenter.wireSimBus: drain returns and clears the queue', () => {
  const { presenter } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  bus.publish(makeExecEndMsg(D1, { balance: 500 }));
  presenter._drainExecEndMsgs(); // consume
  const second = presenter._drainExecEndMsgs();
  assert.strictEqual(second.length, 0, 'drain should clear the queue');
});

test('ChartPresenter._doRender: calls addSnapshot for each queued message', () => {
  const { presenter, view } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  const D2 = new Date(2025, 1, 1);
  bus.publish(makeExecEndMsg(D1, { balance: 100 }));
  bus.publish(makeExecEndMsg(D2, { balance: 200 }));
  presenter._doRender();
  assert.strictEqual(view.calls.addSnapshot.length, 2, 'addSnapshot should be called once per message');
});

test('ChartPresenter._doRender: passes metrics object to addSnapshot', () => {
  const { presenter, view } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  bus.publish(makeExecEndMsg(D1, { netWorth: 500_000, income: 120_000 }));
  presenter._doRender();
  assert.deepStrictEqual(view.calls.addSnapshot[0].data, { netWorth: 500_000, income: 120_000 });
});

test('ChartPresenter._doRender: handles missing stateSnapshot gracefully', () => {
  const { presenter } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  bus.publish({ type: `EXECUTION_${EXECUTION_PHASES.END}`, kind: EXECUTION_KINDS.EVENT, date: D1.toISOString() });
  assert.doesNotThrow(() => presenter._doRender());
});

test('ChartPresenter._doRender: handles null metrics gracefully', () => {
  const { presenter } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  bus.publish({ type: `EXECUTION_${EXECUTION_PHASES.END}`, kind: EXECUTION_KINDS.EVENT, date: D1.toISOString(), stateSnapshot: {} });
  assert.doesNotThrow(() => presenter._doRender());
});
