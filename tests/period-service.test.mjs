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
 * period-service.test.mjs
 * Tests for Period, PeriodRelationship, PeriodService, and period-builder.js
 *
 * Run with: node --test tests/period-service.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Period, PeriodRelationship, PeriodService } from '../assets/js/finance/period/period-service.js';
import {
  buildMonthPeriod,
  buildUsCalendarYear,
  buildAuFiscalYear,
  applyTo,
} from '../assets/js/finance/period/period-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMinimalSvc() {
  const svc = new PeriodService();

  // US 2024 year
  const usYear = new Period({
    id: 'US-2024', type: 'YEAR_US', name: '2024',
    startMs: Date.UTC(2024, 0, 1),
    endMs:   Date.UTC(2025, 0, 1),
  });

  // AU FY 2023-2024
  const auYear = new Period({
    id: 'AU-2023-2024', type: 'YEAR_AU', name: '2023-2024',
    startMs: Date.UTC(2023, 6, 1),
    endMs:   Date.UTC(2024, 6, 1),
  });

  // January 2024 — shared between US-2024 and AU-2023-2024
  const jan2024 = new Period({
    id: 'M-2024-01', type: 'MONTH', name: 'Jan/2024',
    startMs: Date.UTC(2024, 0, 1),
    endMs:   Date.UTC(2024, 1, 1),
  });

  // March 2024 — US only (after AU FY ends in June, but we keep it simple here)
  const mar2024 = new Period({
    id: 'M-2024-03', type: 'MONTH', name: 'Mar/2024',
    startMs: Date.UTC(2024, 2, 1),
    endMs:   Date.UTC(2024, 3, 1),
  });

  svc.addPeriods([usYear, auYear, jan2024, mar2024]);

  svc.addRelationship(new PeriodRelationship({ parentId: 'US-2024',      childId: 'M-2024-01', ordinal: 1  }));
  svc.addRelationship(new PeriodRelationship({ parentId: 'US-2024',      childId: 'M-2024-03', ordinal: 3  }));
  svc.addRelationship(new PeriodRelationship({ parentId: 'AU-2023-2024', childId: 'M-2024-01', ordinal: 7  }));

  return { svc, usYear, auYear, jan2024, mar2024 };
}

// ---------------------------------------------------------------------------
// Period constructor
// ---------------------------------------------------------------------------

test('Period: constructs with valid arguments', () => {
  const p = new Period({
    id: 'US-2024', type: 'YEAR_US', name: '2024',
    startMs: Date.UTC(2024, 0, 1),
    endMs:   Date.UTC(2025, 0, 1),
  });
  assert.equal(p.id,   'US-2024');
  assert.equal(p.type, 'YEAR_US');
});

test('Period: throws when startMs >= endMs', () => {
  assert.throws(() => new Period({
    id: 'BAD', type: 'MONTH', name: 'Bad',
    startMs: 1000, endMs: 500,
  }), /startMs must be < endMs/);
});

test('Period: throws when id is missing', () => {
  assert.throws(() => new Period({ type: 'MONTH', name: 'X', startMs: 0, endMs: 1 }), /id is required/);
});

// ---------------------------------------------------------------------------
// PeriodRelationship constructor
// ---------------------------------------------------------------------------

test('PeriodRelationship: throws when parentId === childId', () => {
  assert.throws(() => new PeriodRelationship({ parentId: 'X', childId: 'X' }), /must differ/);
});

// ---------------------------------------------------------------------------
// PeriodService.addPeriod
// ---------------------------------------------------------------------------

test('addPeriod: idempotent for identical period', () => {
  const svc = new PeriodService();
  const p = buildMonthPeriod(2024, 1);
  svc.addPeriod(p);
  assert.doesNotThrow(() => svc.addPeriod(p));
  assert.equal(svc.getAllPeriods().length, 1);
});

test('addPeriod: throws on conflicting period with same id', () => {
  const svc = new PeriodService();
  svc.addPeriod(buildMonthPeriod(2024, 1));
  const conflicting = new Period({
    id: 'M-2024-01', type: 'MONTH', name: 'Different',
    startMs: Date.UTC(2024, 0, 2),
    endMs:   Date.UTC(2024, 1, 1),
  });
  assert.throws(() => svc.addPeriod(conflicting), /conflicting period id/);
});

// ---------------------------------------------------------------------------
// PeriodService.addRelationship validation
// ---------------------------------------------------------------------------

test('addRelationship: throws when parent not registered', () => {
  const svc = new PeriodService();
  svc.addPeriod(buildMonthPeriod(2024, 1));
  assert.throws(() => svc.addRelationship(
    new PeriodRelationship({ parentId: 'MISSING', childId: 'M-2024-01' })
  ), /parent 'MISSING' not found/);
});

test('addRelationship: throws on time consistency violation', () => {
  const svc = new PeriodService();
  // Month that starts before the parent
  const parent = new Period({
    id: 'PARENT', type: 'YEAR_US', name: 'Parent',
    startMs: Date.UTC(2024, 3, 1),
    endMs:   Date.UTC(2025, 0, 1),
  });
  const child = buildMonthPeriod(2024, 1); // Jan 2024 — before parent start
  svc.addPeriods([parent, child]);
  assert.throws(() => svc.addRelationship(
    new PeriodRelationship({ parentId: 'PARENT', childId: 'M-2024-01' })
  ), /fall outside parent/);
});

test('addRelationship: throws on cycle detection', () => {
  const svc = new PeriodService();
  // Two periods with identical bounds — time consistency allows both directions,
  // but adding both creates a cycle: A→B→A
  const a = new Period({ id: 'A', type: 'CUSTOM', name: 'A', startMs: 0, endMs: 500 });
  const b = new Period({ id: 'B', type: 'CUSTOM', name: 'B', startMs: 0, endMs: 500 });
  svc.addPeriods([a, b]);
  svc.addRelationship(new PeriodRelationship({ parentId: 'A', childId: 'B' }));
  assert.throws(() => svc.addRelationship(
    new PeriodRelationship({ parentId: 'B', childId: 'A' })
  ), /cycle/);
});

// ---------------------------------------------------------------------------
// getPeriodsAt / getPeriodsAtDate
// ---------------------------------------------------------------------------

test('getPeriodsAt: returns all periods containing timestamp', () => {
  const { svc } = buildMinimalSvc();
  const ts = Date.UTC(2024, 0, 15); // Jan 15
  const ids = svc.getPeriodsAt(ts).map(p => p.id).sort();
  assert.deepEqual(ids, ['AU-2023-2024', 'M-2024-01', 'US-2024']);
});

test('getPeriodsAt: returns empty for timestamp outside all periods', () => {
  const { svc } = buildMinimalSvc();
  const ts = Date.UTC(2030, 0, 1);
  assert.equal(svc.getPeriodsAt(ts).length, 0);
});

test('getPeriodsAt: boundary — startMs is inclusive', () => {
  const { svc, jan2024 } = buildMinimalSvc();
  const result = svc.getPeriodsAt(jan2024.startMs);
  assert.ok(result.some(p => p.id === 'M-2024-01'));
});

test('getPeriodsAt: boundary — endMs is exclusive', () => {
  const { svc, jan2024 } = buildMinimalSvc();
  const result = svc.getPeriodsAt(jan2024.endMs); // first ms of Feb
  assert.ok(!result.some(p => p.id === 'M-2024-01'));
});

test('getPeriodsAtDate: matches getPeriodsAt(date.getTime())', () => {
  const { svc } = buildMinimalSvc();
  const date = new Date('2024-01-15T00:00:00Z');
  const byTs   = svc.getPeriodsAt(date.getTime()).map(p => p.id).sort();
  const byDate = svc.getPeriodsAtDate(date).map(p => p.id).sort();
  assert.deepEqual(byTs, byDate);
});

// ---------------------------------------------------------------------------
// rollup
// ---------------------------------------------------------------------------

test('rollup: returns leaf descendants of composite period', () => {
  const { svc } = buildMinimalSvc();
  const leaves = svc.rollup('US-2024').map(p => p.id).sort();
  assert.deepEqual(leaves, ['M-2024-01', 'M-2024-03']);
});

test('rollup: returns the period itself when it is a leaf', () => {
  const { svc } = buildMinimalSvc();
  const leaves = svc.rollup('M-2024-01');
  assert.equal(leaves.length, 1);
  assert.equal(leaves[0].id, 'M-2024-01');
});

test('rollup: AU hierarchy returns correct leaves', () => {
  const { svc } = buildMinimalSvc();
  const leaves = svc.rollup('AU-2023-2024').map(p => p.id).sort();
  assert.deepEqual(leaves, ['M-2024-01']);
});

test('rollup: throws when period not found', () => {
  const svc = new PeriodService();
  assert.throws(() => svc.rollup('MISSING'), /not found/);
});

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

test('aggregate: sums metric across leaf periods', () => {
  const { svc } = buildMinimalSvc();
  const income = { 'M-2024-01': 5000, 'M-2024-03': 3000 };
  const total = svc.aggregate('US-2024', p => income[p.id] ?? 0);
  assert.equal(total, 8000);
});

test('aggregate: returns 0 when metric function returns 0 for all leaves', () => {
  const { svc } = buildMinimalSvc();
  assert.equal(svc.aggregate('US-2024', () => 0), 0);
});

// ---------------------------------------------------------------------------
// getParents / getChildren
// ---------------------------------------------------------------------------

test('getParents: returns correct immediate parents', () => {
  const { svc } = buildMinimalSvc();
  const parentIds = svc.getParents('M-2024-01').map(p => p.id).sort();
  assert.deepEqual(parentIds, ['AU-2023-2024', 'US-2024']);
});

test('getParents: returns empty for a root period', () => {
  const { svc } = buildMinimalSvc();
  assert.equal(svc.getParents('US-2024').length, 0);
});

test('getChildren: returns correct immediate children', () => {
  const { svc } = buildMinimalSvc();
  const childIds = svc.getChildren('US-2024').map(p => p.id).sort();
  assert.deepEqual(childIds, ['M-2024-01', 'M-2024-03']);
});

test('getChildren: returns empty for a leaf period', () => {
  const { svc } = buildMinimalSvc();
  assert.equal(svc.getChildren('M-2024-01').length, 0);
});

// ---------------------------------------------------------------------------
// getPath
// ---------------------------------------------------------------------------

test('getPath: traverses up to the correct period type', () => {
  const { svc } = buildMinimalSvc();
  const result = svc.getPath('M-2024-01', 'YEAR_US');
  assert.ok(result);
  assert.equal(result.id, 'US-2024');
});

test('getPath: returns null when target type not reachable', () => {
  const { svc } = buildMinimalSvc();
  const result = svc.getPath('M-2024-01', 'QUARTER');
  assert.equal(result, null);
});

test('getPath: returns null for a root period with no parents', () => {
  const { svc } = buildMinimalSvc();
  const result = svc.getPath('US-2024', 'YEAR_AU');
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// isLeaf
// ---------------------------------------------------------------------------

test('isLeaf: returns true for periods with no children', () => {
  const { svc } = buildMinimalSvc();
  assert.equal(svc.isLeaf('M-2024-01'), true);
});

test('isLeaf: returns false for composite periods', () => {
  const { svc } = buildMinimalSvc();
  assert.equal(svc.isLeaf('US-2024'), false);
});

// ---------------------------------------------------------------------------
// Multi-hierarchy: same month shared across US and AU
// ---------------------------------------------------------------------------

test('multi-hierarchy: Jan 2024 belongs to both US-2024 and AU-2023-2024', () => {
  const { svc } = buildMinimalSvc();
  const ids = svc.getPeriodsAt(Date.UTC(2024, 0, 15)).map(p => p.id);
  assert.ok(ids.includes('M-2024-01'));
  assert.ok(ids.includes('US-2024'));
  assert.ok(ids.includes('AU-2023-2024'));
});

// ---------------------------------------------------------------------------
// buildMonthPeriod
// ---------------------------------------------------------------------------

test('buildMonthPeriod: creates correct Jan 2024 period', () => {
  const p = buildMonthPeriod(2024, 1);
  assert.equal(p.id,      'M-2024-01');
  assert.equal(p.type,    'MONTH');
  assert.equal(p.name,    'Jan/2024');
  assert.equal(p.startMs, Date.UTC(2024, 0, 1));
  assert.equal(p.endMs,   Date.UTC(2024, 1, 1));
});

test('buildMonthPeriod: Dec has correct end boundary', () => {
  const p = buildMonthPeriod(2024, 12);
  assert.equal(p.startMs, Date.UTC(2024, 11, 1));
  assert.equal(p.endMs,   Date.UTC(2025,  0, 1));
});

// ---------------------------------------------------------------------------
// buildUsCalendarYear
// ---------------------------------------------------------------------------

test('buildUsCalendarYear: produces 13 periods and 12 relationships', () => {
  const { periods, relationships } = buildUsCalendarYear(2024);
  assert.equal(periods.length,       13); // 1 year + 12 months
  assert.equal(relationships.length, 12);
});

test('buildUsCalendarYear: year period has correct bounds', () => {
  const { periods } = buildUsCalendarYear(2024);
  const year = periods.find(p => p.id === 'US-2024');
  assert.ok(year);
  assert.equal(year.startMs, Date.UTC(2024, 0, 1));
  assert.equal(year.endMs,   Date.UTC(2025, 0, 1));
});

test('buildUsCalendarYear: all 12 months present', () => {
  const { periods } = buildUsCalendarYear(2024);
  for (let m = 1; m <= 12; m++) {
    const mm  = String(m).padStart(2, '0');
    assert.ok(periods.some(p => p.id === `M-2024-${mm}`), `Missing M-2024-${mm}`);
  }
});

test('buildUsCalendarYear: relationships carry correct ordinals', () => {
  const { relationships } = buildUsCalendarYear(2024);
  for (let m = 1; m <= 12; m++) {
    const mm  = String(m).padStart(2, '0');
    const rel = relationships.find(r => r.childId === `M-2024-${mm}`);
    assert.ok(rel, `Missing relationship for M-2024-${mm}`);
    assert.equal(rel.ordinal, m);
  }
});

test('buildUsCalendarYear: applyTo registers all periods in service', () => {
  const svc = new PeriodService();
  applyTo(svc, buildUsCalendarYear(2024));
  assert.equal(svc.getAllPeriods().length, 13);
  assert.equal(svc.rollup('US-2024').length, 12);
});

// ---------------------------------------------------------------------------
// buildAuFiscalYear
// ---------------------------------------------------------------------------

test('buildAuFiscalYear: produces 13 periods and 12 relationships', () => {
  const { periods, relationships } = buildAuFiscalYear(2023);
  assert.equal(periods.length,       13);
  assert.equal(relationships.length, 12);
});

test('buildAuFiscalYear: year period spans Jul 2023 – Jul 2024', () => {
  const { periods } = buildAuFiscalYear(2023);
  const year = periods.find(p => p.id === 'AU-2023-2024');
  assert.ok(year);
  assert.equal(year.startMs, Date.UTC(2023, 6, 1));
  assert.equal(year.endMs,   Date.UTC(2024, 6, 1));
});

test('buildAuFiscalYear: first month is Jul of startYear', () => {
  const { relationships, periods } = buildAuFiscalYear(2023);
  const first = relationships.find(r => r.ordinal === 1);
  assert.ok(first);
  const child = periods.find(p => p.id === first.childId);
  assert.equal(child.id, 'M-2023-07');
});

test('buildAuFiscalYear: last month is Jun of endYear', () => {
  const { relationships, periods } = buildAuFiscalYear(2023);
  const last = relationships.find(r => r.ordinal === 12);
  assert.ok(last);
  const child = periods.find(p => p.id === last.childId);
  assert.equal(child.id, 'M-2024-06');
});

// ---------------------------------------------------------------------------
// Shared months — merging US and AU into one PeriodService
// ---------------------------------------------------------------------------

test('merged US+AU: shared months are not duplicated', () => {
  const svc = new PeriodService();
  applyTo(svc, buildUsCalendarYear(2024));
  applyTo(svc, buildAuFiscalYear(2023)); // shares M-2024-01..M-2024-06

  // 13 (US-2024) + 13 (AU-2023-2024) - 6 shared months = 20
  assert.equal(svc.getAllPeriods().length, 20);
});

test('merged US+AU: Jan 2024 has two parents', () => {
  const svc = new PeriodService();
  applyTo(svc, buildUsCalendarYear(2024));
  applyTo(svc, buildAuFiscalYear(2023));
  const parentIds = svc.getParents('M-2024-01').map(p => p.id).sort();
  assert.deepEqual(parentIds, ['AU-2023-2024', 'US-2024']);
});

test('merged US+AU: rollup US-2024 returns 12 months', () => {
  const svc = new PeriodService();
  applyTo(svc, buildUsCalendarYear(2024));
  applyTo(svc, buildAuFiscalYear(2023));
  assert.equal(svc.rollup('US-2024').length, 12);
});

test('merged US+AU: rollup AU-2023-2024 returns 12 months', () => {
  const svc = new PeriodService();
  applyTo(svc, buildUsCalendarYear(2024));
  applyTo(svc, buildAuFiscalYear(2023));
  assert.equal(svc.rollup('AU-2023-2024').length, 12);
});

test('merged US+AU: getPath from M-2024-01 finds YEAR_AU', () => {
  const svc = new PeriodService();
  applyTo(svc, buildUsCalendarYear(2024));
  applyTo(svc, buildAuFiscalYear(2023));
  const result = svc.getPath('M-2024-01', 'YEAR_AU');
  assert.ok(result);
  assert.equal(result.id, 'AU-2023-2024');
});

test('merged US+AU: aggregate across US year using per-period metrics', () => {
  const svc = new PeriodService();
  applyTo(svc, buildUsCalendarYear(2024));
  applyTo(svc, buildAuFiscalYear(2023));

  // Simulate per-period state (as would appear in sim state)
  const periodMetrics = {};
  svc.rollup('US-2024').forEach((p, i) => {
    periodMetrics[p.id] = { income: (i + 1) * 1000 };
  });

  const total = svc.aggregate('US-2024', p => periodMetrics[p.id]?.income ?? 0);
  // Sum of 1000+2000+...+12000 = 78000
  assert.equal(total, 78000);
});
