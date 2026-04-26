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
 * journal.test.mjs
 * Tests for Journal and JournalEntry
 * Run with: node --test tests/journal.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Journal, JournalEntry } from '../../src/simulation-framework/journal.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides = {}) {
  return new JournalEntry({
    date:           overrides.date       ?? new Date(2025, 0, 1),
    eventType:      overrides.eventType  ?? 'TICK',
    action:         overrides.action     ?? { type: 'INCREMENT', amount: 10 },
    reducer:        overrides.reducer    ?? 'MyReducer',
    prevState:      overrides.prevState  ?? { counter: 0 },
    nextState:      overrides.nextState  ?? { counter: 10 },
    emittedActions: overrides.emitted    ?? [],
    sourceEvent:    overrides.src        ?? {}
  });
}

// ─── JournalEntry construction ────────────────────────────────────────────────

test('JournalEntry: all fields are assigned correctly', () => {
  const date    = new Date(2025, 5, 15);
  const action  = { type: 'FOO', amount: 99 };
  const prev    = { x: 0 };
  const next    = { x: 99 };
  const emitted = [{ type: 'BAR' }];
  const src     = { type: 'SOURCE_EVENT' };

  const entry = new JournalEntry({
    date, eventType: 'SOURCE_EVENT', action,
    reducer: 'R1', prevState: prev, nextState: next,
    emittedActions: emitted, sourceEvent: src
  });

  assert.strictEqual(entry.date,           date);
  assert.strictEqual(entry.eventType,      'SOURCE_EVENT');
  assert.strictEqual(entry.action,         action);
  assert.strictEqual(entry.reducer,        'R1');
  assert.strictEqual(entry.prevState,      prev);
  assert.strictEqual(entry.nextState,      next);
  assert.strictEqual(entry.emittedActions, emitted);
  assert.strictEqual(entry.sourceEvent,    src);
});

// ─── Journal construction ──────────────────────────────────────────────────────

test('Journal: enabled flag is set from constructor option', () => {
  assert.strictEqual(new Journal({ enabled: true  }).enabled, true);
  assert.strictEqual(new Journal({ enabled: false }).enabled, false);
});

test('Journal: starts with an empty journal array', () => {
  const j = new Journal({ enabled: true });
  assert.strictEqual(j.journal.length, 0);
});

// ─── addEntry ─────────────────────────────────────────────────────────────────

test('Journal.addEntry: adds entry to journal array', () => {
  const j = new Journal({ enabled: true });
  j.addEntry(makeEntry());
  assert.strictEqual(j.journal.length, 1);
});

test('Journal.addEntry: multiple entries accumulate in order', () => {
  const j   = new Journal({ enabled: true });
  const e1  = makeEntry({ action: { type: 'A' } });
  const e2  = makeEntry({ action: { type: 'B' } });
  const e3  = makeEntry({ action: { type: 'C' } });

  j.addEntry(e1);
  j.addEntry(e2);
  j.addEntry(e3);

  assert.strictEqual(j.journal.length, 3);
  assert.strictEqual(j.journal[0].action.type, 'A');
  assert.strictEqual(j.journal[1].action.type, 'B');
  assert.strictEqual(j.journal[2].action.type, 'C');
});

// ─── getActions ───────────────────────────────────────────────────────────────

test('Journal.getActions: returns only entries matching the action type', () => {
  const j = new Journal({ enabled: true });

  j.addEntry(makeEntry({ action: { type: 'INC', amount: 1 } }));
  j.addEntry(makeEntry({ action: { type: 'DEC', amount: 1 } }));
  j.addEntry(makeEntry({ action: { type: 'INC', amount: 2 } }));

  const results = j.getActions('INC');
  assert.strictEqual(results.length, 2);
  assert.ok(results.every(e => e.action.type === 'INC'));
});

test('Journal.getActions: returns empty array when no entries match', () => {
  const j = new Journal({ enabled: true });
  j.addEntry(makeEntry({ action: { type: 'INC' } }));

  assert.deepStrictEqual(j.getActions('UNKNOWN'), []);
});

test('Journal.getActions: returns all entries when all match', () => {
  const j = new Journal({ enabled: true });
  j.addEntry(makeEntry({ action: { type: 'INC' } }));
  j.addEntry(makeEntry({ action: { type: 'INC' } }));

  assert.strictEqual(j.getActions('INC').length, 2);
});

// ─── getStateTimeline ─────────────────────────────────────────────────────────

test('Journal.getStateTimeline: returns array of {date, value} for each entry', () => {
  const j  = new Journal({ enabled: true });
  const d1 = new Date(2025, 0, 1);
  const d2 = new Date(2026, 0, 1);

  j.addEntry(makeEntry({ date: d1, nextState: { counter: 10, other: 'x' } }));
  j.addEntry(makeEntry({ date: d2, nextState: { counter: 20, other: 'y' } }));

  const timeline = j.getStateTimeline('counter');
  assert.strictEqual(timeline.length, 2);
  assert.strictEqual(timeline[0].date,  d1);
  assert.strictEqual(timeline[0].value, 10);
  assert.strictEqual(timeline[1].date,  d2);
  assert.strictEqual(timeline[1].value, 20);
});

test('Journal.getStateTimeline: returns undefined for missing field (not an error)', () => {
  const j = new Journal({ enabled: true });
  j.addEntry(makeEntry({ nextState: { counter: 5 } }));

  const timeline = j.getStateTimeline('nonexistent');
  assert.strictEqual(timeline.length, 1);
  assert.strictEqual(timeline[0].value, undefined);
});

// ─── traceEvent ───────────────────────────────────────────────────────────────

test('Journal.traceEvent: returns entries whose date matches exactly', () => {
  const j       = new Journal({ enabled: true });
  const target  = new Date(2025, 5, 15);
  const other   = new Date(2026, 0, 1);

  j.addEntry(makeEntry({ date: target, action: { type: 'A' } }));
  j.addEntry(makeEntry({ date: other,  action: { type: 'B' } }));
  j.addEntry(makeEntry({ date: target, action: { type: 'C' } }));

  const results = j.traceEvent(target);
  assert.strictEqual(results.length, 2);
  assert.ok(results.every(e => e.date.getTime() === target.getTime()));
});

test('Journal.traceEvent: returns empty array when no entries match the date', () => {
  const j = new Journal({ enabled: true });
  j.addEntry(makeEntry({ date: new Date(2025, 0, 1) }));

  const results = j.traceEvent(new Date(2099, 0, 1));
  assert.deepStrictEqual(results, []);
});
