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
 * timeline-playback-perf.test.mjs — design 78 §6.
 *
 * The timeline was 70% of playback wall time. These pin the four behaviours that
 * fixed it, because each is silently reversible: nothing breaks visibly if `sum`
 * goes back to eager, or if the throttle is dropped — the UI just gets slow again,
 * which no functional test would catch.
 */

import assert from 'node:assert/strict';

import { TimelineController } from '../../../src/visualization/timeline/timeline-controller.js';
import { TimelineView }       from '../../../src/visualization/timeline/timeline-view.js';
import { TimelinePresenter }  from '../../../src/visualization/timeline/timeline-presenter.js';

let _seq = 0;
function makeEntry({ date = new Date(2025, 0, 1), eventType = 'EV', actionType = 'ACT', amount = 1234.56 } = {}) {
  const seq = _seq++;
  return {
    seq, date, executionId: null,
    event:  { nodeId: null, type: eventType, name: eventType, color: null },
    action: {
      instanceId: `inst-${seq}`, parentId: null, rootId: null, siblingIndex: 0,
      nodeId: null, type: actionType, name: actionType, data: { amount, cc: 'US' },
    },
    reducer: { name: 'R' },
    stateDiff: [], emittedInstanceIds: [], emittedTypes: [],
  };
}

function makeFilterTemplate() {
  if (document.getElementById('tpl-timeline-filter-bar')) return;
  const t = document.createElement('template');
  t.id = 'tpl-timeline-filter-bar';
  t.innerHTML = `<div class="tl-filter-bar">
    <div class="reducer-chip-grid" id="tl-ev-select"></div>
    <div class="reducer-chip-grid" id="tl-act-select"></div>
    <input type="range" id="tl-date-start"><input type="range" id="tl-date-end">
    <span id="tl-date-label-start"></span><span id="tl-date-label-end"></span>
    <button id="tl-filter-clear"></button><button id="tl-download-csv"></button>
    <button id="tl-mode-toggle"></button></div>`;
  document.body.appendChild(t);
}

function makeSetup(entries) {
  makeFilterTemplate();
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientHeight', { value: 100, configurable: true });
  document.body.appendChild(container);
  const controller = new TimelineController();
  const view       = new TimelineView({ container });
  const presenter  = new TimelinePresenter({ controller, view, onDetail: () => {} });
  controller.setJournal({ journal: entries });
  return { controller, view, presenter };
}

const fmtDate = d => d.toISOString().slice(0, 10);

test('TL-PERF-1: groups() does not format currency for entries (sum is lazy)', () => {
  const { controller } = makeSetup([makeEntry(), makeEntry(), makeEntry()]);

  let sumCalls = 0;
  const origSum = controller.sum.bind(controller);
  controller.sum = a => { sumCalls++; return origSum(a); };

  const groups = controller.groups(fmtDate);
  assert.equal(sumCalls, 0,
    'groups() must not compute sum eagerly — the view is virtualized and reads it for visible rows only');

  // …but reading it still works, and memoises.
  const items = [...[...groups.values()][0].values()][0];
  const first = items[0].sum;
  assert.ok(typeof first === 'string' && first.length > 0, 'sum should render on access');
  assert.equal(sumCalls, 1, 'accessing sum computes it once');
  assert.equal(items[0].sum, first, 'second access returns the same value');
  assert.equal(sumCalls, 1, 'sum is memoised — not recomputed on every access');
});

test('TL-PERF-2: currency formatters are cached, not rebuilt per value', () => {
  const { controller } = makeSetup([]);
  const entries = [1, 2, 3].map(n => makeEntry({ amount: n * 100 }));

  const before = Intl.NumberFormat;
  let constructed = 0;
  // Count constructions across many distinct values in the same currency.
  globalThis.Intl = { ...Intl, NumberFormat: function (...a) { constructed++; return new before(...a); } };
  try {
    for (const e of entries) controller.sum(e.action);
  } finally {
    globalThis.Intl = { ...globalThis.Intl, NumberFormat: before };
  }
  assert.equal(constructed, 0,
    'formatting must reuse the cached Intl.NumberFormat built on first use, not construct per value');
});

test('TL-PERF-3: update() does not build the grouped map to find the latest date', () => {
  const { controller, presenter } = makeSetup([
    makeEntry({ date: new Date(2025, 0, 1) }),
    makeEntry({ date: new Date(2025, 0, 2) }),
  ]);

  let groupCalls = 0;
  const origGroups = controller.groups.bind(controller);
  controller.groups = f => { groupCalls++; return origGroups(f); };

  presenter.update();
  assert.equal(groupCalls, 1,
    'exactly one grouping pass per update: _render()\'s. update() used to build a second one just to read its last key');
});

test('TL-PERF-4: latestDateKey matches the last key groups() would produce', () => {
  const { controller } = makeSetup([
    makeEntry({ date: new Date(2025, 0, 1) }),
    makeEntry({ date: new Date(2025, 0, 2) }),
    makeEntry({ date: new Date(2025, 0, 3) }),
  ]);
  const fromGroups = [...controller.groups(fmtDate).keys()].at(-1);
  assert.equal(controller.latestDateKey(fmtDate), fromGroups,
    'the fast path must agree with the grouping it replaced');

  // …including when a filter excludes the newest entries.
  controller.filterDateEnd = new Date(2025, 0, 2, 23, 59);
  assert.equal(controller.latestDateKey(fmtDate), [...controller.groups(fmtDate).keys()].at(-1),
    'must respect the active filters, as groups() does');
});

test('TL-PERF-5: playback throttling coalesces renders and flushes on stop', async () => {
  const { presenter, controller } = makeSetup([makeEntry()]);
  let renders = 0;
  const origRender = presenter._render.bind(presenter);
  presenter._render = () => { renders++; return origRender(); };

  presenter.setRenderThrottle(1000);
  // Several playback steps in quick succession, each appending an entry.
  for (let i = 0; i < 5; i++) {
    controller.journal.journal.push(makeEntry({ date: new Date(2025, 0, 2 + i) }));
    presenter.update();
  }
  assert.equal(renders, 0, 'throttled updates must not render synchronously');

  // Stopping playback restores immediate rendering AND flushes the pending frame,
  // so the timeline never ends a run showing stale content.
  presenter.setRenderThrottle(0);
  assert.equal(renders, 1, 'setRenderThrottle(0) must flush exactly one pending render');

  // Unthrottled, updates render immediately again.
  controller.journal.journal.push(makeEntry({ date: new Date(2025, 1, 1) }));
  presenter.update();
  assert.equal(renders, 2, 'interactive (unthrottled) updates render synchronously');
});
