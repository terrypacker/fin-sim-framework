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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides = {}) {
  const date = overrides.date ?? new Date(Date.UTC(2026, 3, 15));
  return new JournalEntry({
    id:          overrides.id          ?? 'entry-1',
    seq:         overrides.seq         ?? 0,
    date,
    executionId: overrides.executionId ?? 'e1.1',
    event: {
      nodeId: 'ev-node-1',
      type:   overrides.eventType ?? 'WAGES_INCOME',
      name:   'Wages',
      color:  null,
    },
    action: {
      instanceId:  'inst-1',
      parentId:    null,
      rootId:      null,
      siblingIndex: 0,
      nodeId:      'act-node-1',
      type:        overrides.actionType ?? 'WAGES_INCOME_TAX',
      name:        'Wages Income Tax',
      data:        overrides.data ?? { amount: 5000, cc: 'US' },
    },
    reducer:     { nodeId: 'red-node-1', name: 'WagesReducer' },
    stateDiff:   overrides.stateDiff   ?? [{ field: 'usOrdinaryIncomeYTD', before: 0, after: 5000, delta: 5000 }],
    emittedInstanceIds: [],
    emittedTypes:       [],
  });
}

function makeJournal(...entries) {
  const j = new Journal({ enabled: true });
  for (const e of entries) j.addEntry(e);
  return j;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('JournalDataSource: projects basic fields correctly', () => {
  const date  = new Date(Date.UTC(2026, 3, 15));
  const entry = makeEntry({ date, id: 'abc', actionType: 'WAGES_INCOME_TAX', data: { amount: 5000, cc: 'US' } });
  const j     = makeJournal(entry);
  const ds    = new JournalDataSource(j);
  const rows  = ds.getAll();

  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.id,         'abc');
  assert.strictEqual(r.seq,        0);
  assert.strictEqual(r.actionType, 'WAGES_INCOME_TAX');
  assert.strictEqual(r.cc,         'US');
  assert.strictEqual(r.amount,     5000);
  assert.strictEqual(r.ts,         date.getTime());
  assert.strictEqual(r.year,       2026, 'year is derived from UTC date');
  assert.strictEqual(r.entry,      entry, 'entry back-reference should be the original object');
});

test('JournalDataSource: year field uses UTC and survives year-boundary timestamps', () => {
  const newYearsEveUtc = new Date(Date.UTC(2030, 11, 31, 23, 59, 0));
  const rows = new JournalDataSource(makeJournal(makeEntry({ date: newYearsEveUtc }))).getAll();
  assert.strictEqual(rows[0].year, 2030);
});

test('JournalDataSource: changedFields is a comma-joined string', () => {
  const entry = makeEntry({
    stateDiff: [
      { field: 'usOrdinaryIncomeYTD', before: 0,    after: 5000,  delta: 5000  },
      { field: 'usSavingsAccount.balance', before: 10000, after: 9000, delta: -1000 },
    ],
  });
  const rows = new JournalDataSource(makeJournal(entry)).getAll();
  const { changedFields } = rows[0];
  assert.ok(changedFields.includes('usOrdinaryIncomeYTD'),     'should contain usOrdinaryIncomeYTD');
  assert.ok(changedFields.includes('usSavingsAccount.balance'), 'should contain usSavingsAccount.balance');
});

test('JournalDataSource: null/absent data fields default to null', () => {
  const entry = makeEntry({ data: { amount: 123 } });
  const rows  = new JournalDataSource(makeJournal(entry)).getAll();
  const r     = rows[0];
  assert.strictEqual(r.cc,          null);
  assert.strictEqual(r.proceeds,    null);
  assert.strictEqual(r.costBasis,   null);
  assert.strictEqual(r.gain,        null);
  assert.strictEqual(r.personKey,   null);
  assert.strictEqual(r.description, null);
});

test('JournalDataSource: empty stateDiff produces empty changedFields string', () => {
  const entry = makeEntry({ stateDiff: [] });
  const rows  = new JournalDataSource(makeJournal(entry)).getAll();
  assert.strictEqual(rows[0].changedFields, '');
});

test('JournalDataSource: getAll() reflects new entries added after construction', () => {
  const j  = makeJournal();
  const ds = new JournalDataSource(j);
  assert.strictEqual(ds.getAll().length, 0);

  j.addEntry(makeEntry({ id: 'e1' }));
  assert.strictEqual(ds.getAll().length, 1, 'should see new entry without reconstruction');
});

test('JournalDataSource: capital gain fields projected correctly', () => {
  const entry = makeEntry({
    actionType: 'STOCK_WITHDRAWAL_TAX',
    data: {
      cc:          'US',
      amount:      2000,
      proceeds:    15000,
      costBasis:   13000,
      gain:        2000,
      isLongTerm:  true,
      description: 'Brokerage sale',
    },
  });
  const rows = new JournalDataSource(makeJournal(entry)).getAll();
  const r    = rows[0];
  assert.strictEqual(r.proceeds,    15000);
  assert.strictEqual(r.costBasis,   13000);
  assert.strictEqual(r.gain,        2000);
  assert.strictEqual(r.isLongTerm,  true);
  assert.strictEqual(r.description, 'Brokerage sale');
});

// ─── perDiff mode ─────────────────────────────────────────────────────────────

test('JournalDataSource perDiff: emits one row per stateDiff entry', () => {
  const entry = makeEntry({
    stateDiff: [
      { field: 'checkingAccount.balance', before: 5000, after: 4000, delta: -1000 },
      { field: 'savingsAccount.balance',  before: 2000, after: 2050, delta:    50 },
    ],
  });
  const ds   = new JournalDataSource(makeJournal(entry), { perDiff: true });
  const rows = ds.getAll();

  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].stateKey,    'checkingAccount.balance');
  assert.strictEqual(rows[0].stateBefore, 5000);
  assert.strictEqual(rows[0].stateAfter,  4000);
  assert.strictEqual(rows[0].stateDelta,  -1000);
  assert.strictEqual(rows[0].diffSeq,     0);

  assert.strictEqual(rows[1].stateKey,   'savingsAccount.balance');
  assert.strictEqual(rows[1].stateDelta, 50);
  assert.strictEqual(rows[1].diffSeq,    1);
});

test('JournalDataSource perDiff: inherits parent entry base fields on each row', () => {
  const entry = makeEntry({
    id: 'e99', actionType: 'WAGES_INCOME_TAX',
    stateDiff: [
      { field: 'checkingAccount.balance', before: 0, after: 1000, delta: 1000 },
    ],
  });
  const rows = new JournalDataSource(makeJournal(entry), { perDiff: true }).getAll();
  assert.strictEqual(rows[0].id,         'e99');
  assert.strictEqual(rows[0].actionType, 'WAGES_INCOME_TAX');
  assert.strictEqual(rows[0].entry,      entry);
});

test('JournalDataSource perDiff: changedFields is the single stateKey for each row', () => {
  const entry = makeEntry({
    stateDiff: [
      { field: 'checkingAccount.balance', before: 100, after: 200, delta: 100 },
      { field: 'usOrdinaryIncomeYTD',     before: 0,   after: 100, delta: 100 },
    ],
  });
  const rows = new JournalDataSource(makeJournal(entry), { perDiff: true }).getAll();
  assert.strictEqual(rows[0].changedFields, 'checkingAccount.balance');
  assert.strictEqual(rows[1].changedFields, 'usOrdinaryIncomeYTD');
});

test('JournalDataSource perDiff: entry with no stateDiff emits one row with null diff fields', () => {
  const entry = makeEntry({ stateDiff: [] });
  const rows  = new JournalDataSource(makeJournal(entry), { perDiff: true }).getAll();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].stateKey,   null);
  assert.strictEqual(rows[0].stateDelta, null);
});

test('JournalDataSource perDiff: default mode (no flag) is still one-row-per-entry', () => {
  const entry = makeEntry({
    stateDiff: [
      { field: 'checkingAccount.balance', before: 0, after: 500, delta: 500 },
      { field: 'usOrdinaryIncomeYTD',     before: 0, after: 500, delta: 500 },
    ],
  });
  const rows = new JournalDataSource(makeJournal(entry)).getAll();
  assert.strictEqual(rows.length, 1, 'default mode: one row per entry regardless of stateDiff length');
});

// ─── perPerson mode ──────────────────────────────────────────────────────────

test('JournalDataSource perPerson: fans out personTaxDetails into one row per person', () => {
  const settle = makeEntry({
    actionType: 'AU_TAX_SETTLE_APPLY',
    data: {
      tax: 20000,
      personTaxDetails: [
        { personKey: 'p-1', personName: 'Alice', taxDetail: { netLiability: 12000, taxableIncome: 90000, grossTax: 15000 } },
        { personKey: 'p-2', personName: 'Bob',   taxDetail: { netLiability:  8000, taxableIncome: 60000, grossTax: 10000 } },
      ],
    },
  });
  const rows = new JournalDataSource(makeJournal(settle), { perPerson: true }).getAll();

  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map(r => r.personKey),       ['p-1', 'p-2']);
  assert.deepStrictEqual(rows.map(r => r.personName),      ['Alice', 'Bob']);
  assert.deepStrictEqual(rows.map(r => r.personTaxAmount), [12000, 8000]);
  assert.deepStrictEqual(rows.map(r => r.taxableIncome),   [90000, 60000]);
  assert.deepStrictEqual(rows.map(r => r.grossTax),        [15000, 10000]);
});

test('JournalDataSource perPerson: inherits base fields (date, year, actionType, cc) on each row', () => {
  const settle = makeEntry({
    date: new Date(Date.UTC(2027, 5, 30)),
    actionType: 'AU_TAX_SETTLE_APPLY',
    data: {
      tax: 12000,
      personTaxDetails: [
        { personKey: 'p-1', personName: 'Alice', taxDetail: { netLiability: 12000 } },
      ],
    },
  });
  const [row] = new JournalDataSource(makeJournal(settle), { perPerson: true }).getAll();
  assert.strictEqual(row.year, 2027);
  assert.strictEqual(row.actionType, 'AU_TAX_SETTLE_APPLY');
  assert.strictEqual(row.cc, 'AU');
});

test('JournalDataSource perPerson: drops entries without personTaxDetails', () => {
  const noPersons = makeEntry({
    actionType: 'US_TAX_SETTLE_APPLY',
    data: { tax: 5000, taxDetail: { netLiability: 5000 } },
  });
  const withPersons = makeEntry({
    actionType: 'AU_TAX_SETTLE_APPLY',
    data: {
      tax: 7000,
      personTaxDetails: [{ personKey: 'p-1', personName: 'Alice', taxDetail: { netLiability: 7000 } }],
    },
  });
  const rows = new JournalDataSource(makeJournal(noPersons, withPersons), { perPerson: true }).getAll();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].personKey, 'p-1');
});

test('JournalDataSource perPerson: empty personTaxDetails array is treated as missing', () => {
  const entry = makeEntry({
    actionType: 'AU_TAX_SETTLE_APPLY',
    data: { tax: 0, personTaxDetails: [] },
  });
  const rows = new JournalDataSource(makeJournal(entry), { perPerson: true }).getAll();
  assert.strictEqual(rows.length, 0);
});

test('JournalDataSource perPerson: null taxDetail.netLiability defaults to 0', () => {
  const settle = makeEntry({
    actionType: 'AU_TAX_SETTLE_APPLY',
    data: {
      tax: 0,
      personTaxDetails: [
        { personKey: 'p-1', personName: 'Alice', taxDetail: {} },
      ],
    },
  });
  const [row] = new JournalDataSource(makeJournal(settle), { perPerson: true }).getAll();
  assert.strictEqual(row.personTaxAmount, 0);
});
