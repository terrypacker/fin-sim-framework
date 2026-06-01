/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { Journal, JournalEntry }  from '../../src/simulation-framework/journal.js';
import { JournalDataSource }      from '../../src/finance/journal-data-source.js';
import { JournalQueryApi }        from '../../src/finance/journal-query-api.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _seq = 0;

function makeEntry({ id, date, actionType, data, stateDiff, cc } = {}) {
  const d = date ?? new Date(Date.UTC(2026, 0, 15));
  return new JournalEntry({
    id:          id ?? `e-${_seq++}`,
    seq:         _seq++,
    date:        d,
    executionId: 'e1.1',
    event:  { nodeId: null, type: 'EVT', name: 'Evt', color: null },
    action: {
      instanceId:   'i-' + _seq,
      parentId:     null,
      rootId:       null,
      siblingIndex: 0,
      nodeId:       null,
      type:         actionType ?? 'WAGES_INCOME_TAX',
      name:         actionType ?? 'WAGES_INCOME_TAX',
      data:         data ?? { amount: 1000, cc: cc ?? 'US' },
    },
    reducer:            { nodeId: null, name: 'R' },
    stateDiff:          stateDiff ?? [{ field: 'usOrdinaryIncomeYTD', before: 0, after: 1000, delta: 1000 }],
    emittedInstanceIds: [],
    emittedTypes:       [],
  });
}

function makeApi(entries) {
  const j = new Journal({ enabled: true });
  for (const e of entries) j.addEntry(e);
  return { journal: j, api: new JournalQueryApi(new JournalDataSource(j)) };
}

// ─── between() ───────────────────────────────────────────────────────────────

test('between() returns an AND of gt/lt AST nodes', () => {
  const { api } = makeApi([]);
  const ast = api.between(1000, 2000);
  assert.strictEqual(ast.op, 'and');
  assert.ok(ast.conditions.some(c => c.op === 'gt' && c.field === 'ts' && c.value === 1000));
  assert.ok(ast.conditions.some(c => c.op === 'lt' && c.field === 'ts' && c.value === 2000));
});

test('search with between() filters entries by timestamp', async () => {
  const jan = new Date(Date.UTC(2026, 0, 15));
  const jun = new Date(Date.UTC(2026, 5, 15));
  const dec = new Date(Date.UTC(2026, 11, 15));

  const { api } = makeApi([
    makeEntry({ id: 'jan', date: jan }),
    makeEntry({ id: 'jun', date: jun }),
    makeEntry({ id: 'dec', date: dec }),
  ]);

  const fromTs = Date.UTC(2026, 2, 1);  // Mar 1
  const toTs   = Date.UTC(2026, 9, 1);  // Oct 1
  const result = await api.search({ query: api.between(fromTs, toTs), limit: 100 });

  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].id, 'jun');
});

// ─── periodOf() ──────────────────────────────────────────────────────────────

test('periodOf() returns a betweenSeq AST for both fromEntryId and toEntryId', () => {
  const prevSettle = makeEntry({ id: 'settle-prev', date: new Date(Date.UTC(2025, 11, 31)) });
  const currSettle = makeEntry({ id: 'settle-curr', date: new Date(Date.UTC(2026, 11, 31)) });
  const { api }    = makeApi([prevSettle, currSettle]);

  const ast = api.periodOf({ fromEntryId: 'settle-prev', toEntryId: 'settle-curr' });
  assert.strictEqual(ast.op, 'and');
  const gtCond = ast.conditions.find(c => c.op === 'gt' && c.field === 'seq');
  const ltCond = ast.conditions.find(c => c.op === 'lt' && c.field === 'seq');
  assert.ok(gtCond, 'should have a gt seq condition');
  assert.ok(ltCond, 'should have a lt seq condition');
  assert.strictEqual(gtCond.value, prevSettle.seq, 'lower bound = prevSettle seq');
  assert.strictEqual(ltCond.value, currSettle.seq, 'upper bound = currSettle seq');
});

test('periodOf() with fromEntryId=null uses seq=-1 as lower bound', () => {
  const currSettle = makeEntry({ id: 'settle-1', date: new Date(Date.UTC(2026, 11, 31)) });
  const { api }    = makeApi([currSettle]);

  const ast    = api.periodOf({ fromEntryId: null, toEntryId: 'settle-1' });
  const gtCond = ast.conditions.find(c => c.op === 'gt' && c.field === 'seq');
  assert.strictEqual(gtCond.value, -1, 'no fromEntryId → lower bound seq = -1 (include all prior)');
});

test('periodOf() correctly includes same-day entries before settle via seq ordering', async () => {
  // Simulate: 3 income entries + 1 settle entry all on the same date.
  const sameDate   = new Date(Date.UTC(2026, 11, 31));
  const income1    = makeEntry({ id: 'inc1', date: sameDate, actionType: 'WAGES_INCOME_TAX',    data: { amount: 5000, cc: 'US' } });
  const income2    = makeEntry({ id: 'inc2', date: sameDate, actionType: 'IRA_RMD_TAX',         data: { amount: 2000, cc: 'US' } });
  const income3    = makeEntry({ id: 'inc3', date: sameDate, actionType: 'FIXED_INCOME_EARNINGS_TAX', data: { amount: 1000, cc: 'US' } });
  const settle     = makeEntry({ id: 'settle', date: sameDate, actionType: 'US_TAX_SETTLE_APPLY', data: {} });
  const { api }    = makeApi([income1, income2, income3, settle]);

  const ast    = api.periodOf({ fromEntryId: null, toEntryId: 'settle' });
  const result = await api.aggregate({
    query:      ast,
    groupBy:    ['actionType'],
    aggregates: { total: { fn: 'sum', field: 'amount' }, count: { fn: 'count' } },
  });

  // settle entry should NOT be in results (its seq is >= settle.seq)
  const settleGroup = result.groups.find(g => g.key.actionType === 'US_TAX_SETTLE_APPLY');
  assert.ok(!settleGroup, 'US_TAX_SETTLE_APPLY entry should be excluded (same-day, higher seq)');
  assert.strictEqual(result.grandTotal, 8000, 'should include all 3 income entries');
});

// ─── periodOfTaxYear() — date-based bounds, includes settle + chained ────────

test('periodOfTaxYear() bounds entries by the CY containing a US settle', () => {
  const currSettle = makeEntry({ id: 'us-26', date: new Date(Date.UTC(2026, 11, 31)), actionType: 'US_TAX_SETTLE_APPLY', data: {} });
  const { api }    = makeApi([currSettle]);

  const ast = api.periodOfTaxYear({ fromEntryId: null, toEntryId: 'us-26' });
  const gt  = ast.conditions.find(c => c.op === 'gt' && c.field === 'ts');
  const lt  = ast.conditions.find(c => c.op === 'lt' && c.field === 'ts');
  assert.strictEqual(gt.value, Date.UTC(2026, 0, 1) - 1, 'lower = Jan 1 2026 ts - 1ms');
  assert.strictEqual(lt.value, Date.UTC(2027, 0, 1),     'upper = Jan 1 2027 ts (exclusive)');
});

test('periodOfTaxYear() bounds entries by the July-anchored FY for an AU settle', () => {
  const auSettle = makeEntry({ id: 'au-26', date: new Date(Date.UTC(2026, 5, 30)), actionType: 'AU_TAX_SETTLE_APPLY', data: {} });
  const { api }  = makeApi([auSettle]);

  const ast = api.periodOfTaxYear({ fromEntryId: null, toEntryId: 'au-26' });
  const gt  = ast.conditions.find(c => c.op === 'gt' && c.field === 'ts');
  const lt  = ast.conditions.find(c => c.op === 'lt' && c.field === 'ts');
  assert.strictEqual(gt.value, Date.UTC(2025, 6, 1) - 1, 'lower = Jul 1 2025 ts - 1ms');
  assert.strictEqual(lt.value, Date.UTC(2026, 6, 1),     'upper = Jul 1 2026 ts (exclusive)');
});

test('periodOfTaxYear() includes the AU settle itself in its own FY window', async () => {
  // Reproduces the AU-Tax-by-Person-Year bug: seq-based bounds excluded
  // the settle entry; date-based bounds include it.
  const auSettle = makeEntry({ id: 'au-26', date: new Date(Date.UTC(2026, 5, 30)), actionType: 'AU_TAX_SETTLE_APPLY', data: {} });
  const { api }  = makeApi([auSettle]);

  const ast    = api.periodOfTaxYear({ fromEntryId: null, toEntryId: 'au-26' });
  const result = await api.search({ query: ast, limit: 100 });
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].id, 'au-26');
});

test('periodOfTaxYear() includes a chained TAX_PAYMENT_DEBIT dated on the settle day', async () => {
  // Reproduces the Tax-Paid-by-Year bug: the chained payment had a higher
  // seq than the settle, so the seq-based period dropped it.
  const auSettle  = makeEntry({ id: 'au-26',  date: new Date(Date.UTC(2026, 5, 30)), actionType: 'AU_TAX_SETTLE_APPLY',  data: {} });
  const auPayment = makeEntry({ id: 'au-pay', date: new Date(Date.UTC(2026, 5, 30)), actionType: 'AU_TAX_PAYMENT_DEBIT', data: { amount: 12000 } });
  const { api }   = makeApi([auSettle, auPayment]);

  const ast    = api.periodOfTaxYear({ fromEntryId: null, toEntryId: 'au-26' });
  const result = await api.search({ query: ast, limit: 100 });
  const ids    = result.items.map(i => i.id).sort();
  assert.deepStrictEqual(ids, ['au-26', 'au-pay']);
});

test('periodOfTaxYear() with only fromEntryId yields gt(ts, lastTaxYearEnd - 1)', () => {
  const usLast  = makeEntry({ id: 'us-25', date: new Date(Date.UTC(2025, 11, 31)), actionType: 'US_TAX_SETTLE_APPLY', data: {} });
  const { api } = makeApi([usLast]);

  const ast = api.periodOfTaxYear({ fromEntryId: 'us-25', toEntryId: null });
  assert.strictEqual(ast.op,    'gt');
  assert.strictEqual(ast.field, 'ts');
  assert.strictEqual(ast.value, Date.UTC(2026, 0, 1) - 1, 'current period starts at Jan 1 2026');
});

test('periodOfTaxYear() with both bounds null returns an always-true AST', () => {
  const { api } = makeApi([]);
  const ast     = api.periodOfTaxYear({ fromEntryId: null, toEntryId: null });
  assert.deepStrictEqual(ast, { op: 'gt', field: 'seq', value: -1 });
});

// ─── aggregate() ─────────────────────────────────────────────────────────────

test('aggregate() groups by actionType and sums amount', async () => {
  const { api } = makeApi([
    makeEntry({ actionType: 'WAGES_INCOME_TAX',    data: { amount: 5000, cc: 'US' } }),
    makeEntry({ actionType: 'WAGES_INCOME_TAX',    data: { amount: 3000, cc: 'US' } }),
    makeEntry({ actionType: 'IRA_RMD_TAX',         data: { amount: 2000, cc: 'US' } }),
  ]);

  const result = await api.aggregate({
    query:      '',
    groupBy:    ['actionType'],
    aggregates: { total: { fn: 'sum', field: 'amount' }, count: { fn: 'count' } },
  });

  assert.strictEqual(result.groups.length, 2);
  const wages = result.groups.find(g => g.key.actionType === 'WAGES_INCOME_TAX');
  const rmd   = result.groups.find(g => g.key.actionType === 'IRA_RMD_TAX');
  assert.ok(wages, 'wages group should exist');
  assert.strictEqual(wages.total,  8000);
  assert.strictEqual(wages.count,  2);
  assert.strictEqual(rmd.total,    2000);
  assert.strictEqual(rmd.count,    1);
  assert.strictEqual(result.grandTotal, 10000);
});

test('aggregate() count fn does not require field', async () => {
  const { api } = makeApi([
    makeEntry({ actionType: 'WAGES_INCOME_TAX' }),
    makeEntry({ actionType: 'WAGES_INCOME_TAX' }),
  ]);
  const result = await api.aggregate({
    query:      '',
    groupBy:    ['actionType'],
    aggregates: { count: { fn: 'count' } },
  });
  assert.strictEqual(result.groups[0].count, 2);
  assert.strictEqual(result.grandTotal, null, 'no total aggregate → grandTotal is null');
});

test('aggregate() with a pre-built AST query filters before grouping', async () => {
  const date  = new Date(Date.UTC(2026, 5, 15));
  const jan   = new Date(Date.UTC(2026, 0, 15));
  const { api } = makeApi([
    makeEntry({ actionType: 'A', date: jan,  data: { amount: 100, cc: 'US' } }),
    makeEntry({ actionType: 'A', date,       data: { amount: 200, cc: 'US' } }),
  ]);

  const ast = api.between(
    Date.UTC(2026, 2, 1),
    Date.UTC(2026, 9, 1),
  );
  const result = await api.aggregate({
    query:      ast,
    groupBy:    ['actionType'],
    aggregates: { total: { fn: 'sum', field: 'amount' } },
  });

  assert.strictEqual(result.groups.length, 1);
  assert.strictEqual(result.groups[0].total, 200, 'only the June entry should be counted');
});

test('aggregate() min/max/avg aggregates', async () => {
  const { api } = makeApi([
    makeEntry({ actionType: 'A', data: { amount: 100, cc: 'US' } }),
    makeEntry({ actionType: 'A', data: { amount: 300, cc: 'US' } }),
    makeEntry({ actionType: 'A', data: { amount: 200, cc: 'US' } }),
  ]);

  const result = await api.aggregate({
    query:      '',
    groupBy:    ['actionType'],
    aggregates: {
      min:  { fn: 'min', field: 'amount' },
      max:  { fn: 'max', field: 'amount' },
      avg:  { fn: 'avg', field: 'amount' },
    },
  });

  const g = result.groups[0];
  assert.strictEqual(g.min, 100);
  assert.strictEqual(g.max, 300);
  assert.ok(Math.abs(g.avg - 200) < 0.01, `avg should be ~200, got ${g.avg}`);
});

test('aggregate() with in operator on actionType', async () => {
  const { api } = makeApi([
    makeEntry({ actionType: 'STOCK_WITHDRAWAL_TAX', data: { amount: 1000, proceeds: 5000, cc: 'US' } }),
    makeEntry({ actionType: 'WAGES_INCOME_TAX',     data: { amount: 2000, cc: 'US' } }),
    makeEntry({ actionType: 'IRA_RMD_TAX',          data: { amount:  500, cc: 'US' } }),
  ]);

  const result = await api.aggregate({
    query:      { op: 'in', field: 'actionType', value: ['STOCK_WITHDRAWAL_TAX', 'IRA_RMD_TAX'] },
    groupBy:    ['actionType'],
    aggregates: { count: { fn: 'count' } },
  });

  assert.strictEqual(result.groups.length, 2);
  const types = result.groups.map(g => g.key.actionType).sort();
  assert.deepStrictEqual(types, ['IRA_RMD_TAX', 'STOCK_WITHDRAWAL_TAX']);
});

// ─── listSettledPeriods() ────────────────────────────────────────────────────

test('listSettledPeriods() returns one period per US settle in reverse chronological order with CY labels', () => {
  const us25 = makeEntry({ id: 'us-25', date: new Date(Date.UTC(2025, 11, 31)), actionType: 'US_TAX_SETTLE_APPLY', data: {} });
  const us26 = makeEntry({ id: 'us-26', date: new Date(Date.UTC(2026, 11, 31)), actionType: 'US_TAX_SETTLE_APPLY', data: {} });
  const us27 = makeEntry({ id: 'us-27', date: new Date(Date.UTC(2027, 11, 31)), actionType: 'US_TAX_SETTLE_APPLY', data: {} });
  const { api } = makeApi([us25, us26, us27]);

  const periods = api.listSettledPeriods('US');
  assert.strictEqual(periods.length, 3, 'one entry per US settle');

  // Reverse chronological: 27 first.
  assert.strictEqual(periods[0].toEntryId,   'us-27');
  assert.strictEqual(periods[0].fromEntryId, 'us-26');
  assert.strictEqual(periods[0].label,       'US CY 2027');

  assert.strictEqual(periods[1].toEntryId,   'us-26');
  assert.strictEqual(periods[1].fromEntryId, 'us-25');
  assert.strictEqual(periods[1].label,       'US CY 2026');

  // First-ever settle: fromEntryId is null (no predecessor).
  assert.strictEqual(periods[2].toEntryId,   'us-25');
  assert.strictEqual(periods[2].fromEntryId, null);
  assert.strictEqual(periods[2].label,       'US CY 2025');
});

test('listSettledPeriods() ignores non-matching cc and yields AU FY labels', () => {
  // AU FY 2025-26 settle dated 30 Jun 2026; AU FY 2026-27 settle dated 30 Jun 2027.
  const au26   = makeEntry({ id: 'au-26', date: new Date(Date.UTC(2026, 5, 30)), actionType: 'AU_TAX_SETTLE_APPLY', data: {} });
  const us26   = makeEntry({ id: 'us-26', date: new Date(Date.UTC(2026, 11, 31)), actionType: 'US_TAX_SETTLE_APPLY', data: {} });
  const au27   = makeEntry({ id: 'au-27', date: new Date(Date.UTC(2027, 5, 30)), actionType: 'AU_TAX_SETTLE_APPLY', data: {} });
  const { api } = makeApi([au26, us26, au27]);

  const periods = api.listSettledPeriods('AU');
  assert.strictEqual(periods.length, 2, 'should not include the US settle');
  assert.strictEqual(periods[0].toEntryId, 'au-27');
  assert.strictEqual(periods[0].label,     'AU FY 2026–27');
  assert.strictEqual(periods[1].toEntryId, 'au-26');
  assert.strictEqual(periods[1].label,     'AU FY 2025–26');

  // Cross-cc enumeration: empty cc → settles from every country.
  const all = api.listSettledPeriods('');
  assert.strictEqual(all.length, 3, 'no cc filter → all settles');
});

test('listSettledPeriods() returns empty when no TAX_SETTLE_APPLY entries exist', () => {
  const wages   = makeEntry({ actionType: 'WAGES_INCOME_TAX', data: { amount: 100, cc: 'US' } });
  const { api } = makeApi([wages]);
  assert.deepStrictEqual(api.listSettledPeriods('US'), []);
});

// ─── currentInProgressPeriod() ────────────────────────────────────────────────

test('currentInProgressPeriod() returns null when journal is empty', () => {
  const { api } = makeApi([]);
  assert.strictEqual(api.currentInProgressPeriod('US'), null);
});

test('currentInProgressPeriod() returns null when no settles exist (Whole simulation covers it)', () => {
  const wages   = makeEntry({ actionType: 'WAGES_INCOME_TAX', data: { amount: 100, cc: 'US' } });
  const { api } = makeApi([wages]);
  assert.strictEqual(api.currentInProgressPeriod('US'), null);
});

test('currentInProgressPeriod() returns null when last settle is the last journal entry', () => {
  const wages  = makeEntry({ actionType: 'WAGES_INCOME_TAX', data: { amount: 100, cc: 'US' } });
  const settle = makeEntry({ id: 'us-settle', actionType: 'US_TAX_SETTLE_APPLY', data: {} });
  const { api } = makeApi([wages, settle]);
  assert.strictEqual(api.currentInProgressPeriod('US'), null);
});

test('currentInProgressPeriod() reports an open period when post-settle activity exists', () => {
  const settle = makeEntry({ id: 'us-settle', actionType: 'US_TAX_SETTLE_APPLY', data: {} });
  const post   = makeEntry({ actionType: 'WAGES_INCOME_TAX', data: { amount: 5000, cc: 'US' } });
  const { api } = makeApi([settle, post]);

  const result = api.currentInProgressPeriod('US');
  assert.ok(result, 'should return a descriptor');
  assert.strictEqual(result.fromEntryId, 'us-settle');
  assert.strictEqual(result.toEntryId,   null);
  assert.strictEqual(result.label,       'Current (in progress)');
});

// ─── changedFields contains predicate ────────────────────────────────────────

test('search with contains(changedFields,...) filters by state-diff field', async () => {
  const { api } = makeApi([
    makeEntry({
      id:        'wages',
      stateDiff: [{ field: 'usOrdinaryIncomeYTD', before: 0, after: 1000, delta: 1000 }],
    }),
    makeEntry({
      id:        'cg',
      stateDiff: [{ field: 'usCgYTD', before: 0, after: 500, delta: 500 }],
    }),
  ]);

  const result = await api.search({
    query: { op: 'contains', field: 'changedFields', value: 'usOrdinaryIncomeYTD' },
    limit: 100,
  });
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].id, 'wages');
});
