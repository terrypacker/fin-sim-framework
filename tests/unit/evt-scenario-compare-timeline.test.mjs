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
 * EVT-Scenario-Compare: journal overlay rendering.
 *
 * Tests the pure `buildJournalOverlay` utility without DOM or ServiceRegistry.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { buildJournalOverlay } from '../../src/finance/scenario-compare/scenario-compare-utils.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function mkEntry(dateStr, actionType = 'SOME_ACTION') {
  return { date: new Date(dateStr), action: { type: actionType, name: actionType } };
}

// ── buildJournalOverlay ───────────────────────────────────────────────────────

test('buildJournalOverlay: empty arrays produce empty result', () => {
  const result = buildJournalOverlay([], []);
  assert.deepEqual(result, []);
});

test('buildJournalOverlay: entries only in A produce a-only days', () => {
  const entriesA = [mkEntry('2027-03-01'), mkEntry('2027-03-01')];
  const result   = buildJournalOverlay(entriesA, []);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].date, '2027-03-01');
  assert.strictEqual(result[0].aEntries.length, 2);
  assert.strictEqual(result[0].bEntries.length, 0);
});

test('buildJournalOverlay: entries only in B produce b-only days', () => {
  const entriesB = [mkEntry('2027-06-15')];
  const result   = buildJournalOverlay([], entriesB);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].date, '2027-06-15');
  assert.strictEqual(result[0].aEntries.length, 0);
  assert.strictEqual(result[0].bEntries.length, 1);
});

test('buildJournalOverlay: matching dates from A and B are paired', () => {
  const entriesA = [mkEntry('2027-01-01', 'ACT_A')];
  const entriesB = [mkEntry('2027-01-01', 'ACT_B')];
  const result   = buildJournalOverlay(entriesA, entriesB);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].date, '2027-01-01');
  assert.strictEqual(result[0].aEntries.length, 1);
  assert.strictEqual(result[0].bEntries.length, 1);
  assert.strictEqual(result[0].aEntries[0].action.type, 'ACT_A');
  assert.strictEqual(result[0].bEntries[0].action.type, 'ACT_B');
});

test('buildJournalOverlay: days are sorted chronologically', () => {
  const entriesA = [mkEntry('2028-01-01'), mkEntry('2026-06-01')];
  const entriesB = [mkEntry('2027-03-15')];
  const result   = buildJournalOverlay(entriesA, entriesB);
  const dates    = result.map(r => r.date);
  assert.deepEqual(dates, [...dates].sort());
});

test('buildJournalOverlay: multiple entries on the same date are all captured', () => {
  const entriesA = [
    mkEntry('2027-07-04', 'ACT_1'),
    mkEntry('2027-07-04', 'ACT_2'),
    mkEntry('2027-07-04', 'ACT_3'),
  ];
  const result = buildJournalOverlay(entriesA, []);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].aEntries.length, 3);
});

test('buildJournalOverlay: non-overlapping date ranges produce separate day entries', () => {
  const entriesA = [mkEntry('2026-01-01')];
  const entriesB = [mkEntry('2040-12-31')];
  const result   = buildJournalOverlay(entriesA, entriesB);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].date, '2026-01-01');
  assert.strictEqual(result[1].date, '2040-12-31');
});

test('buildJournalOverlay: each day entry has date, aEntries, and bEntries', () => {
  const entriesA = [mkEntry('2029-05-10')];
  const result   = buildJournalOverlay(entriesA, []);
  for (const row of result) {
    assert.ok('date'     in row, 'missing date');
    assert.ok('aEntries' in row, 'missing aEntries');
    assert.ok('bEntries' in row, 'missing bEntries');
    assert.ok(Array.isArray(row.aEntries));
    assert.ok(Array.isArray(row.bEntries));
  }
});

test('buildJournalOverlay: entries with null date are skipped', () => {
  const entries = [{ date: null, action: { type: 'X' } }, mkEntry('2027-01-01')];
  const result  = buildJournalOverlay(entries, []);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].date, '2027-01-01');
});
