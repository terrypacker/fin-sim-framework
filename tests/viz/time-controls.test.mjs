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
 * time-controls.test.mjs
 * Tests for TimeControls
 * Run with: node --test tests/time-controls.test.mjs
 */

import assert from 'node:assert/strict';

import { TimeControls } from '../../src/visualization/time-controls.js';

// ─── Minimal requestAnimationFrame shim ──────────────────────────────────────
// Collect callbacks so tests can flush them synchronously.

let _rafQueue = [];
global.requestAnimationFrame = cb => { _rafQueue.push(cb); return _rafQueue.length; };
global.cancelAnimationFrame  = ()  => {};

function flushRaf() {
  const cbs = _rafQueue.splice(0);
  cbs.forEach(cb => cb(0));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeQueue(events = []) {
  // events is an array of { date } objects sorted ascending
  let items = events.map(e => ({ ...e, date: new Date(e.date) }));
  return {
    peek() { return items[0] ?? null; },
    pop()  { return items.shift() ?? null; },
    _items: items,
  };
}

function makeScenario(startYear = 2025, endYear = 2030, queueEvents = []) {
  const simStart = new Date(startYear, 0, 1);
  const simEnd   = new Date(endYear,   0, 1);

  const queue = makeQueue(queueEvents);

  const sim = {
    rewound:     false,
    stepped:     [],
    currentDate: new Date(startYear, 0, 1),
    journal:     { journal: [] },
    history:     { resetForReplay() {}, snapshots: [] },
    queue,
    rewindToStart() { this.rewound = true; },
    stepTo(date) {
      this.stepped.push(new Date(date));
      this.currentDate = new Date(date);
      // Advance the queue past events that the real stepTo would have processed,
      // so consecutive stepForward() calls each target the next distinct event.
      while (queue._items.length > 0 && queue._items[0].date <= date) {
        queue._items.shift();
      }
    },
  };

  return { simStart, simEnd, sim };
}

/**
 * Build a scenario whose sim already has snapshots (simulates having played
 * through some events) and whose currentDate is set to a post-play position.
 * The mock stepTo trims the snapshot list to entries ≤ the new date so that
 * consecutive stepBack() calls each find the correct previous event.
 */
function makeScenarioWithSnapshots(startYear, endYear, snapshotDates, currentDate) {
  const simStart = new Date(startYear, 0, 1);
  const simEnd   = new Date(endYear,   0, 1);

  // Keep a master copy so stepTo can rebuild a trimmed view after each rewind.
  const masterSnapshots = snapshotDates.map(d => ({ date: new Date(d) }));

  const sim = {
    rewound:     false,
    stepped:     [],
    currentDate: new Date(currentDate),
    journal:     { journal: [] },
    history: {
      resetForReplay() {},
      snapshots: snapshotDates.map(d => ({ date: new Date(d) })),
    },
    queue: { peek: () => null, _items: [] },
    rewindToStart() { this.rewound = true; },
    stepTo(date) {
      this.stepped.push(new Date(date));
      this.currentDate = new Date(date);
      // Trim snapshots to those ≤ the replay target, mirroring real sim behaviour.
      this.history.snapshots = masterSnapshots.filter(s => s.date <= date);
    },
  };

  return { simStart, simEnd, sim };
}

function makeControlsWithSnapshots(startYear, endYear, snapshotDates, currentDate) {
  _rafQueue = [];
  const slider   = { value: 0 };
  const label    = { textContent: '' };
  const scenario = makeScenarioWithSnapshots(startYear, endYear, snapshotDates, currentDate);

  const tc = new TimeControls({
    scenario,
    timelineView: null,
    graphView:    null,
    chartView:    null,
    timeLabel:    label,
    timeSlider:   slider,
  });

  return { tc, slider, label, scenario };
}

function makeControlsWithQueue(queueEvents = []) {
  _rafQueue = [];

  const slider = { value: 0 };
  const label  = { textContent: '' };
  const scenario = makeScenario(2025, 2030, queueEvents);

  const tc = new TimeControls({
    scenario,
    timelineView: null,
    graphView:    null,
    chartView:    null,
    timeLabel:    label,
    timeSlider:   slider,
  });

  return { tc, slider, label, scenario };
}

function makeControls() {
  _rafQueue = [];

  const slider = { value: 0 };
  const label  = { textContent: '' };
  const scenario = makeScenario();

  const tc = new TimeControls({
    scenario,
    timelineView: null,
    graphView:    null,
    chartView:    null,
    timeLabel:    label,
    timeSlider:   slider,
  });

  return { tc, slider, label, scenario };
}

// ─── onDateChanged — closure / stale-date bug ─────────────────────────────────

test('onDateChanged: single call updates slider to correct percentage after RAF flush', () => {
  const { tc, slider, scenario } = makeControls();
  const { simStart, simEnd } = scenario;

  // Midpoint of the range
  const mid = new Date((simStart.getTime() + simEnd.getTime()) / 2);
  tc.onDateChanged(mid);
  flushRaf();

  const expected = Math.round(
    (mid.getTime() - simStart.getTime()) /
    (simEnd.getTime() - simStart.getTime()) * 100
  );
  assert.strictEqual(+slider.value, expected);
});

test('onDateChanged: single call updates label after RAF flush', () => {
  const { tc, label, scenario } = makeControls();
  const { simStart, simEnd } = scenario;

  const mid = new Date((simStart.getTime() + simEnd.getTime()) / 2);
  tc.onDateChanged(mid);
  flushRaf();

  assert.strictEqual(label.textContent, mid.toDateString());
});

test('onDateChanged: uses the LATEST date when multiple calls precede RAF flush (rewind bug)', () => {
  // This is the core regression test.
  // When rewindTo() replays from the start, onDateChanged fires for every action,
  // starting with the earliest dates.  The RAF must use the LAST date, not the first.
  const { tc, slider, label, scenario } = makeControls();
  const { simStart, simEnd } = scenario;

  const early  = new Date(2025,  0,  1);   // pct ≈ 0
  const middle = new Date(2027,  6,  1);   // pct ≈ 50 %
  const latest = new Date(2028,  0,  1);   // pct ≈ 60 %

  tc.onDateChanged(early);   // schedules RAF
  tc.onDateChanged(middle);  // throttled — should NOT change what the RAF uses
  tc.onDateChanged(latest);  // throttled — should NOT change what the RAF uses

  flushRaf();

  const expectedPct = Math.round(
    (latest.getTime() - simStart.getTime()) /
    (simEnd.getTime() - simStart.getTime()) * 100
  );

  assert.strictEqual(+slider.value, expectedPct,
    'slider should reflect the latest date, not the first date passed to onDateChanged');
  assert.strictEqual(label.textContent, latest.toDateString(),
    'label should reflect the latest date, not the first date passed to onDateChanged');
});

test('onDateChanged: throttle allows a second RAF after the first has flushed', () => {
  const { tc, slider, scenario } = makeControls();
  const { simStart, simEnd } = scenario;

  const d1 = new Date(2025,  6, 1);
  const d2 = new Date(2028,  6, 1);

  tc.onDateChanged(d1);
  flushRaf();                  // first RAF fires

  tc.onDateChanged(d2);        // should schedule a new RAF
  flushRaf();

  const expected = Math.round(
    (d2.getTime() - simStart.getTime()) /
    (simEnd.getTime() - simStart.getTime()) * 100
  );
  assert.strictEqual(+slider.value, expected,
    'a new call after flushing should still update the slider');
});

// ─── rewindTo ─────────────────────────────────────────────────────────────────

test('rewindTo: calls sim.rewindToStart()', () => {
  const { tc, scenario } = makeControls();
  tc.rewindTo(0.5);
  assert.ok(scenario.sim.rewound, 'rewindToStart should be called');
});

test('rewindTo: calls sim.stepTo() with the correct target date', () => {
  const { tc, scenario } = makeControls();
  const { simStart, simEnd } = scenario;

  const pct = 0.4;
  tc.rewindTo(pct);

  const expected = new Date(
    simStart.getTime() + pct * (simEnd.getTime() - simStart.getTime())
  );

  assert.strictEqual(scenario.sim.stepped.length, 1);
  assert.strictEqual(
    scenario.sim.stepped[0].getTime(),
    expected.getTime(),
    'stepTo should be called with the interpolated target date'
  );
});

test('rewindTo: clears the journal before replaying', () => {
  const { tc, scenario } = makeControls();
  scenario.sim.journal.journal.push({ type: 'STALE' });

  tc.rewindTo(0.3);

  assert.strictEqual(scenario.sim.journal.journal.length, 0,
    'journal should be cleared before replay');
});

test('rewindTo: returns the target date', () => {
  const { tc, scenario } = makeControls();
  const { simStart, simEnd } = scenario;

  const pct = 0.75;
  const result = tc.rewindTo(pct);

  const expected = new Date(
    simStart.getTime() + pct * (simEnd.getTime() - simStart.getTime())
  );

  assert.strictEqual(result.getTime(), expected.getTime(),
    'rewindTo should return the computed target date');
});

// ─── stepTo ───────────────────────────────────────────────────────────────────

test('stepTo: calls sim.stepTo() with the correct interpolated date', () => {
  const { tc, scenario } = makeControls();
  const { simStart, simEnd } = scenario;

  const pct = 0.25;
  tc.stepTo(pct);

  const expected = new Date(
    simStart.getTime() + pct * (simEnd.getTime() - simStart.getTime())
  );
  assert.strictEqual(scenario.sim.stepped[0].getTime(), expected.getTime());
});

test('stepTo: updates timeLabel to the target date string', () => {
  const { tc, label, scenario } = makeControls();
  const { simStart, simEnd } = scenario;

  const pct = 0.5;
  tc.stepTo(pct);

  const expected = new Date(
    simStart.getTime() + pct * (simEnd.getTime() - simStart.getTime())
  );
  assert.strictEqual(label.textContent, expected.toDateString());
});

test('stepTo: returns the target date', () => {
  const { tc, scenario } = makeControls();
  const { simStart, simEnd } = scenario;

  const pct = 0.6;
  const result = tc.stepTo(pct);

  const expected = new Date(
    simStart.getTime() + pct * (simEnd.getTime() - simStart.getTime())
  );
  assert.strictEqual(result.getTime(), expected.getTime());
});

// ─── stepForward ─────────────────────────────────────────────────────────────

test('stepForward: steps to the next queued event date', () => {
  const nextEvent = new Date(2026, 3, 1);   // Q2 2026 — 25 % of a 5-year range
  const { tc, scenario } = makeControlsWithQueue([{ date: nextEvent, type: 'QUARTERLY' }]);
  const { simStart, simEnd } = scenario;

  tc.stepForward();

  const expectedDate = new Date(
    simStart.getTime() +
    ((nextEvent.getTime() - simStart.getTime()) / (simEnd.getTime() - simStart.getTime())) *
    (simEnd.getTime() - simStart.getTime())
  );

  assert.strictEqual(scenario.sim.stepped.length, 1);
  assert.strictEqual(scenario.sim.stepped[0].getTime(), expectedDate.getTime(),
    'sim.stepTo should be called with the next event date');
});

test('stepForward: returns the target date', () => {
  const nextEvent = new Date(2027, 0, 1);
  const { tc, scenario } = makeControlsWithQueue([{ date: nextEvent, type: 'ANNUAL' }]);
  const { simStart, simEnd } = scenario;

  const result = tc.stepForward();

  const pct = (nextEvent.getTime() - simStart.getTime()) /
              (simEnd.getTime() - simStart.getTime());
  const expected = new Date(simStart.getTime() + pct * (simEnd.getTime() - simStart.getTime()));

  assert.ok(result !== null, 'should return a date, not null');
  assert.strictEqual(result.getTime(), expected.getTime());
});

test('stepForward: updates the label to the next event date', () => {
  const nextEvent = new Date(2026, 0, 1);
  const { tc, label } = makeControlsWithQueue([{ date: nextEvent, type: 'ANNUAL' }]);

  tc.stepForward();

  // stepTo sets timeLabel synchronously to the computed target date
  assert.strictEqual(label.textContent, nextEvent.toDateString());
});

test('stepForward: returns null when the queue is empty', () => {
  const { tc } = makeControlsWithQueue([]);   // empty queue
  assert.strictEqual(tc.stepForward(), null,
    'should return null when no more events are queued');
});

test('stepForward: returns null when the next event is past simEnd', () => {
  const { tc } = makeControlsWithQueue([{ date: new Date(2031, 0, 1), type: 'LATE' }]);
  assert.strictEqual(tc.stepForward(), null,
    'should return null when next event is beyond simEnd');
});

test('stepForward: advances only to the immediate next event, not further', () => {
  const e1 = new Date(2026, 0, 1);
  const e2 = new Date(2027, 0, 1);
  const { tc, scenario } = makeControlsWithQueue([
    { date: e1, type: 'FIRST'  },
    { date: e2, type: 'SECOND' },
  ]);

  tc.stepForward();

  // sim.stepTo should have been called exactly once, targeting e1
  assert.strictEqual(scenario.sim.stepped.length, 1);
  assert.strictEqual(scenario.sim.stepped[0].getTime(), e1.getTime(),
    'stepForward should advance to the first queued event, not skip ahead');
});

// ─── stepBack — history-based (arrived via stepForward) ──────────────────────

test('stepBack: after one stepForward, rewinds to the start', () => {
  const e1 = new Date(2026, 0, 1);
  const { tc, slider, scenario } = makeControlsWithQueue([{ date: e1, type: 'EV' }]);

  tc.stepForward();
  tc.stepBack();

  // No prior position in history → should land at 0
  assert.strictEqual(+slider.value, 0,
    'slider should be 0 after stepping back past the first event');
  assert.ok(scenario.sim.rewound,
    'rewindToStart should be called by stepBack');
});

test('stepBack: after two stepForwards, returns to the first step position', () => {
  const e1 = new Date(2026, 0, 1);
  const e2 = new Date(2027, 0, 1);
  const { tc, slider, scenario } = makeControlsWithQueue([
    { date: e1, type: 'FIRST'  },
    { date: e2, type: 'SECOND' },
  ]);
  const { simStart, simEnd } = scenario;

  tc.stepForward();  // → e1
  tc.stepForward();  // → e2
  tc.stepBack();     // ← e1

  const pct1 = (e1.getTime() - simStart.getTime()) /
               (simEnd.getTime() - simStart.getTime());
  assert.strictEqual(+slider.value, Math.round(pct1 * 100),
    'slider should reflect the first step position after stepBack');

  // The last sim.stepTo call should target the e1 date
  const lastStep = scenario.sim.stepped[scenario.sim.stepped.length - 1];
  const expectedDate = new Date(
    simStart.getTime() + pct1 * (simEnd.getTime() - simStart.getTime())
  );
  assert.strictEqual(lastStep.getTime(), expectedDate.getTime(),
    'sim.stepTo should be called with the first event date on stepBack');
});

test('stepBack: three stepForwards then two stepBacks lands on the first step', () => {
  const e1 = new Date(2026, 0, 1);
  const e2 = new Date(2027, 0, 1);
  const e3 = new Date(2028, 0, 1);
  const { tc, slider, scenario } = makeControlsWithQueue([
    { date: e1, type: 'A' }, { date: e2, type: 'B' }, { date: e3, type: 'C' },
  ]);
  const { simStart, simEnd } = scenario;

  tc.stepForward(); tc.stepForward(); tc.stepForward();
  tc.stepBack();    // e3 → e2
  tc.stepBack();    // e2 → e1

  const pct1 = (e1.getTime() - simStart.getTime()) /
               (simEnd.getTime() - simStart.getTime());
  assert.strictEqual(+slider.value, Math.round(pct1 * 100),
    'two stepBacks from three forwards should land on the first step');
});

test('stepBack: updates the slider to the previous position', () => {
  const e1 = new Date(2026, 0, 1);
  const e2 = new Date(2028, 0, 1);
  const { tc, slider, scenario } = makeControlsWithQueue([
    { date: e1, type: 'A' }, { date: e2, type: 'B' },
  ]);
  const { simStart, simEnd } = scenario;

  tc.stepForward();  // → e1
  const sliderAfterForward = +slider.value;
  tc.stepForward();  // → e2

  tc.stepBack();     // ← e1

  assert.strictEqual(+slider.value, sliderAfterForward,
    'slider after stepBack must match the value it had after the previous stepForward');
});

test('stepBack: rewindTo clears step history so subsequent stepBack uses snapshot scan', () => {
  const e1 = new Date(2026, 0, 1);
  const e2 = new Date(2027, 0, 1);
  const { tc, scenario } = makeControlsWithQueue([
    { date: e1, type: 'A' }, { date: e2, type: 'B' },
  ]);

  tc.stepForward();
  tc.stepForward();

  assert.strictEqual(tc._stepHistory.length, 2,
    'history should have 2 entries after two stepForwards');

  // Slider rewind (manual navigation) must clear history
  tc.rewindTo(0.5);

  assert.strictEqual(tc._stepHistory.length, 0,
    'rewindTo should clear the step history');
});

// ─── stepBack — snapshot-based (arrived via play / slider) ───────────────────
//
// These tests cover the regression where stepBack after play rewound all the
// way to the start because _stepHistory was empty and fell back to pct = 0.

test('stepBack with no history: goes to the last event before currentDate', () => {
  const D1 = new Date(2026, 0, 1);
  const D2 = new Date(2027, 0, 1);
  const D3 = new Date(2028, 0, 1);

  // Simulate having played to D3: snapshots at D1, D2, D3; currentDate = D3.
  const { tc, slider, scenario } = makeControlsWithSnapshots(
    2025, 2030, [D1, D2, D3], D3
  );
  const { simStart, simEnd } = scenario;

  tc.stepBack();  // should rewind to D2, not D1 or 0

  const expectedPct = (D2.getTime() - simStart.getTime()) /
                      (simEnd.getTime() - simStart.getTime());
  assert.strictEqual(+slider.value, Math.round(expectedPct * 100),
    'stepBack after play should go to the previous event, not the start');

  const lastStep = scenario.sim.stepped[scenario.sim.stepped.length - 1];
  const expectedDate = new Date(
    simStart.getTime() + expectedPct * (simEnd.getTime() - simStart.getTime())
  );
  assert.strictEqual(lastStep.getTime(), expectedDate.getTime(),
    'sim.stepTo should target D2 (the event before currentDate)');
});

test('stepBack with no history: when no earlier snapshot exists, rewinds to 0', () => {
  const D1 = new Date(2026, 0, 1);

  // Only one snapshot at D1 and currentDate = D1; nothing strictly before it.
  const { tc, slider } = makeControlsWithSnapshots(2025, 2030, [D1], D1);

  tc.stepBack();

  assert.strictEqual(+slider.value, 0,
    'slider must be 0 when no snapshot exists before currentDate');
});

test('stepBack with no history: consecutive calls step through each prior event', () => {
  const D1 = new Date(2026, 0, 1);
  const D2 = new Date(2027, 0, 1);
  const D3 = new Date(2028, 0, 1);

  const { tc, slider, scenario } = makeControlsWithSnapshots(
    2025, 2030, [D1, D2, D3], D3
  );
  const { simStart, simEnd } = scenario;

  const pct = d => (d.getTime() - simStart.getTime()) /
                   (simEnd.getTime() - simStart.getTime());

  tc.stepBack();   // D3 → D2
  assert.strictEqual(+slider.value, Math.round(pct(D2) * 100),
    'first stepBack should land on D2');

  tc.stepBack();   // D2 → D1
  assert.strictEqual(+slider.value, Math.round(pct(D1) * 100),
    'second stepBack should land on D1');

  tc.stepBack();   // D1 → start
  assert.strictEqual(+slider.value, 0,
    'third stepBack should land at the start');
});

test('clearStepHistory: causes stepBack to use snapshot scan instead of history', () => {
  const D1 = new Date(2026, 0, 1);
  const D2 = new Date(2027, 0, 1);

  // Start with history from stepForward calls...
  const { tc, slider, scenario } = makeControlsWithSnapshots(
    2025, 2030, [D1, D2], D2
  );
  const { simStart, simEnd } = scenario;

  // Manually push a fake history entry (simulates having stepped forward earlier)
  tc._stepHistory.push(0.9);

  // Play start clears history
  tc.clearStepHistory();
  assert.strictEqual(tc._stepHistory.length, 0, 'history should be empty after clear');

  // stepBack must now use snapshots: D1 < D2 → should land on D1
  tc.stepBack();

  const expectedPct = (D1.getTime() - simStart.getTime()) /
                      (simEnd.getTime() - simStart.getTime());
  assert.strictEqual(+slider.value, Math.round(expectedPct * 100),
    'after clearStepHistory, stepBack should use snapshot scan and land on D1');
});
