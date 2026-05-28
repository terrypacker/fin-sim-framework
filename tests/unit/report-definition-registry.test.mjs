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
 * report-definition-registry.test.mjs — covers Phase 3 report definitions
 * (withdrawals-by-account, tax-paid-by-year, roth-conversions-by-year,
 * real-property-cash-flow) and verifies their built queries return the
 * expected groups when run end-to-end through JournalQueryApi.aggregate().
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { Journal, JournalEntry }      from '../../src/simulation-framework/journal.js';
import { JournalDataSource }          from '../../src/finance/journal-data-source.js';
import { JournalQueryApi }            from '../../src/finance/journal-query-api.js';
import { ReportDefinitionRegistry }   from '../../src/finance/journal-reporting/report-definition-registry.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _seq = 0;

function entry({ id, date, actionType, data, stateDiff } = {}) {
  return new JournalEntry({
    id:          id ?? `e-${_seq}`,
    seq:         _seq++,
    date:        date ?? new Date(Date.UTC(2026, 5, 15)),
    executionId: 'e1.1',
    event:  { nodeId: null, type: 'EVT', name: 'Evt', color: null },
    action: {
      instanceId:   `i-${_seq}`,
      parentId:     null,
      rootId:       null,
      siblingIndex: 0,
      nodeId:       null,
      type:         actionType,
      name:         actionType,
      data:         data ?? {},
    },
    reducer:            { nodeId: null, name: 'R' },
    stateDiff:          stateDiff ?? [],
    emittedInstanceIds: [],
    emittedTypes:       [],
  });
}

function buildApi(entries, { perDiff = false, perPerson = false } = {}) {
  const j = new Journal({ enabled: true });
  for (const e of entries) j.addEntry(e);
  return new JournalQueryApi(new JournalDataSource(j, { perDiff, perPerson }));
}

async function runDef(def, params, entries) {
  const api = buildApi(entries, { perDiff: def.perDiff, perPerson: def.perPerson });
  const ast = def.buildQuery(params, api);
  return api.aggregate({
    query:      ast,
    groupBy:    def.defaultGroupBy,
    aggregates: def.defaultAggregates,
    sort:       [{ field: 'total', dir: 'desc' }],
  });
}

// ─── Registry composition ────────────────────────────────────────────────────

test('ReportDefinitionRegistry registers the 9 built-in definitions', () => {
  const reg = new ReportDefinitionRegistry();
  const ids = reg.getAll().map(d => d.id).sort();
  assert.deepStrictEqual(ids, [
    'au-tax-by-person-year',
    'capital-gains-by-disposal',
    'cash-flow-by-account',
    'ordinary-income-by-source',
    'pretax-adjustments-by-source',
    'real-property-cash-flow',
    'roth-conversions-by-year',
    'tax-paid-by-year',
    'withdrawals-by-account',
  ]);
});

// ─── WithdrawalsByAccountDef ─────────────────────────────────────────────────

test('withdrawals-by-account: groups source-account debits by stateKey, excludes destination credits', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('withdrawals-by-account');
  assert.strictEqual(def.perDiff, true);

  // K401 withdrawal: debit k401Account, credit checkingAccount.
  const k401WithdrawApply = entry({
    actionType: 'K401_WITHDRAWAL_APPLY',
    data:       { amount: 10000 },
    stateDiff: [
      { field: 'k401Account.balance',     before: 100000, after: 90000, delta: -10000 },
      { field: 'checkingAccount.balance', before: 5000,   after: 15000, delta:  10000 },
    ],
  });
  // IRA RMD: debit iraAccount, credit checkingAccount.
  const iraRmdApply = entry({
    actionType: 'IRA_RMD_APPLY',
    data:       { amount: 4000 },
    stateDiff: [
      { field: 'iraAccount.balance',      before: 80000, after: 76000, delta: -4000 },
      { field: 'checkingAccount.balance', before: 15000, after: 19000, delta:  4000 },
    ],
  });
  // Non-withdrawal action — should be ignored.
  const wages = entry({
    actionType: 'WAGES_INCOME_TAX',
    data:       { amount: 5000, cc: 'US' },
    stateDiff:  [{ field: 'checkingAccount.balance', before: 0, after: 5000, delta: 5000 }],
  });

  const { groups, grandTotal } = await runDef(def, { period: null }, [k401WithdrawApply, iraRmdApply, wages]);

  const byKey = Object.fromEntries(groups.map(g => [g.key.stateKey, g.total]));
  assert.strictEqual(byKey['k401Account.balance'], -10000);
  assert.strictEqual(byKey['iraAccount.balance'],   -4000);
  assert.ok(!('checkingAccount.balance' in byKey),
    'destination credits and unrelated debits must not appear');
  assert.strictEqual(grandTotal, -14000);
});

// ─── TaxPaidByYearDef ────────────────────────────────────────────────────────

test('tax-paid-by-year: groups TAX_PAYMENT_DEBIT entries by year, sums amount', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('tax-paid-by-year');

  const entries = [
    entry({ date: new Date(Date.UTC(2026, 5, 30)),  actionType: 'TAX_PAYMENT_DEBIT', data: { amount: 15000, cc: 'US' } }),
    entry({ date: new Date(Date.UTC(2026, 11, 30)), actionType: 'TAX_PAYMENT_DEBIT', data: { amount:  8000, cc: 'AU' } }),
    entry({ date: new Date(Date.UTC(2027, 5, 30)),  actionType: 'TAX_PAYMENT_DEBIT', data: { amount: 20000, cc: 'US' } }),
    // Unrelated entry — should not match.
    entry({ date: new Date(Date.UTC(2027, 5, 30)),  actionType: 'WAGES_INCOME_TAX',  data: { amount: 99999, cc: 'US' } }),
  ];

  const { groups, grandTotal } = await runDef(def, { period: null }, entries);
  const byYear = Object.fromEntries(groups.map(g => [g.key.year, g.total]));
  assert.strictEqual(byYear[2026], 23000);
  assert.strictEqual(byYear[2027], 20000);
  assert.strictEqual(grandTotal,    43000);
});

test('tax-paid-by-year: cc facet filters to a single country', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('tax-paid-by-year');

  const entries = [
    entry({ date: new Date(Date.UTC(2026, 5, 30)),  actionType: 'TAX_PAYMENT_DEBIT', data: { amount: 15000, cc: 'US' } }),
    entry({ date: new Date(Date.UTC(2026, 11, 30)), actionType: 'TAX_PAYMENT_DEBIT', data: { amount:  8000, cc: 'AU' } }),
  ];

  const { grandTotal: usTotal } = await runDef(def, { cc: 'US', period: null }, entries);
  assert.strictEqual(usTotal, 15000);

  const { grandTotal: auTotal } = await runDef(def, { cc: 'AU', period: null }, entries);
  assert.strictEqual(auTotal, 8000);
});

// ─── RothConversionsByYearDef ────────────────────────────────────────────────

test('roth-conversions-by-year: groups ROTH_CONVERSION_APPLY by year, sums amount', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('roth-conversions-by-year');

  const entries = [
    entry({ date: new Date(Date.UTC(2026, 0, 5)),  actionType: 'ROTH_CONVERSION_APPLY', data: { amount: 25000 } }),
    entry({ date: new Date(Date.UTC(2026, 6, 1)),  actionType: 'ROTH_CONVERSION_APPLY', data: { amount: 15000 } }),
    entry({ date: new Date(Date.UTC(2027, 0, 5)),  actionType: 'ROTH_CONVERSION_APPLY', data: { amount: 30000 } }),
    // Unrelated tax-side action chained by Roth conversion — should not match.
    entry({ date: new Date(Date.UTC(2026, 0, 5)),  actionType: 'ROTH_CONVERSION_TAX',   data: { amount: 25000 } }),
  ];

  const { groups, grandTotal } = await runDef(def, { period: null }, entries);
  const byYear = Object.fromEntries(groups.map(g => [g.key.year, g.total]));
  assert.strictEqual(byYear[2026], 40000);
  assert.strictEqual(byYear[2027], 30000);
  assert.strictEqual(grandTotal,    70000);
});

// ─── RealPropertyCashFlowDef ─────────────────────────────────────────────────

test('real-property-cash-flow: groups by actionType, sums account.balance diffs, excludes off-domain', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('real-property-cash-flow');
  assert.strictEqual(def.perDiff, true);
  assert.deepStrictEqual(def.defaultGroupBy, ['actionType']);

  const entries = [
    entry({
      actionType: 'US_HOUSE_SALE_APPLY',
      data:       { salePrice: 800000, costBasis: 500000, mortgageBalance: 100000 },
      stateDiff: [
        { field: 'usSavingsAccount.balance', before: 50000, after: 750000, delta: 700000 },
        { field: 'usHouseAccount.balance',   before: 800000, after: 0,     delta: -800000 },
      ],
    }),
    entry({
      actionType: 'US_MORTGAGE_PAYMENT_APPLY',
      data:       { amount: 2500 },
      stateDiff: [
        { field: 'checkingAccount.balance', before: 20000, after: 17500, delta: -2500 },
      ],
    }),
    // Off-domain action — must be excluded by the actionType filter.
    entry({
      actionType: 'WAGES_INCOME_TAX',
      data:       { amount: 1000 },
      stateDiff: [{ field: 'checkingAccount.balance', before: 0, after: 1000, delta: 1000 }],
    }),
  ];

  const { groups, grandTotal } = await runDef(def, { period: null }, entries);
  const totalsByType = Object.fromEntries(groups.map(g => [g.key.actionType, g.total]));

  // House sale: both the credit to savings (+700000) and the house account debit (-800000)
  // are included since both stateKeys contain 'account.balance'.
  assert.strictEqual(totalsByType['US_HOUSE_SALE_APPLY'], 700000 + -800000);
  assert.strictEqual(totalsByType['US_MORTGAGE_PAYMENT_APPLY'], -2500);
  assert.ok(!('WAGES_INCOME_TAX' in totalsByType), 'off-domain action types must be excluded');
  assert.strictEqual(grandTotal, 700000 + -800000 + -2500);
});

// ─── Facet sanity ────────────────────────────────────────────────────────────

test('new definitions all expose at least a period facet', () => {
  const reg = new ReportDefinitionRegistry();
  for (const id of ['withdrawals-by-account', 'tax-paid-by-year', 'roth-conversions-by-year', 'real-property-cash-flow']) {
    const def    = reg.get(id);
    const facets = def.facets;
    assert.ok(facets.some(f => f.kind === 'period'), `${id} should declare a period facet`);
  }
});

// ─── Phase 3B: multiselect facets ────────────────────────────────────────────

test('account-multiselect defs expose an "account" multiselect facet', () => {
  const reg = new ReportDefinitionRegistry();
  for (const id of ['cash-flow-by-account', 'withdrawals-by-account', 'real-property-cash-flow']) {
    const def = reg.get(id);
    const f   = def.facets.find(x => x.name === 'accountStateKeys');
    assert.ok(f, `${id} should expose accountStateKeys facet`);
    assert.strictEqual(f.kind, 'multiselect');
    assert.strictEqual(f.optionsSource, 'account');
  }
});

test('person-multiselect defs expose a "person" multiselect facet', () => {
  const reg = new ReportDefinitionRegistry();
  for (const id of ['ordinary-income-by-source', 'capital-gains-by-disposal', 'au-tax-by-person-year']) {
    const def = reg.get(id);
    const f   = def.facets.find(x => x.name === 'personKeys');
    assert.ok(f, `${id} should expose personKeys facet`);
    assert.strictEqual(f.kind, 'multiselect');
    assert.strictEqual(f.optionsSource, 'person');
  }
});

test('tax-paid-by-year does NOT expose a personKeys facet (household-only debit)', () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('tax-paid-by-year');
  assert.ok(!def.facets.some(f => f.name === 'personKeys'),
    'tax-paid-by-year should not advertise per-person filtering since TAX_PAYMENT_DEBIT carries no personKey');
});

test('account multiselect on cash-flow-by-account filters per-diff rows by stateKey prefix', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('cash-flow-by-account');

  // Two distinct accounts; selecting one must exclude the other.
  const entries = [
    entry({
      actionType: 'TRANSFER_APPLY',
      data:       { amount: 1000 },
      stateDiff: [
        { field: 'usSavingsAccount.balance', before: 5000, after: 4000, delta: -1000 },
        { field: 'checkingAccount.balance',  before: 0,    after: 1000, delta:  1000 },
      ],
    }),
    entry({
      actionType: 'TRANSFER_APPLY',
      data:       { amount: 200 },
      stateDiff: [
        { field: 'iraAccount.balance',       before: 1000, after: 800,  delta: -200 },
        { field: 'checkingAccount.balance',  before: 1000, after: 1200, delta:  200 },
      ],
    }),
  ];

  // With no filter — all account.balance diffs flow through.
  const all = await runDef(def, { period: null }, entries);
  const allKeys = all.groups.map(g => g.key.stateKey).sort();
  assert.deepStrictEqual(allKeys, ['checkingAccount.balance', 'iraAccount.balance', 'usSavingsAccount.balance']);

  // Selecting only `usSavingsAccount` restricts to that one stateKey.
  const filtered = await runDef(def, {
    period:           null,
    accountStateKeys: ['usSavingsAccount'],
  }, entries);
  assert.strictEqual(filtered.groups.length, 1);
  assert.strictEqual(filtered.groups[0].key.stateKey, 'usSavingsAccount.balance');
  assert.strictEqual(filtered.groups[0].total, -1000);
});

test('person multiselect on ordinary-income-by-source filters by personKey', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('ordinary-income-by-source');

  const entries = [
    entry({
      actionType: 'WAGES_INCOME_TAX',
      data:       { amount: 12000, cc: 'US', personKey: 'p-1' },
      stateDiff:  [{ field: 'usOrdinaryIncomeYTD', before: 0,     after: 12000, delta: 12000 }],
    }),
    entry({
      actionType: 'WAGES_INCOME_TAX',
      data:       { amount:  8000, cc: 'US', personKey: 'p-2' },
      stateDiff:  [{ field: 'usOrdinaryIncomeYTD', before: 12000, after: 20000, delta: 8000  }],
    }),
  ];

  const both = await runDef(def, { cc: 'US', period: null }, entries);
  assert.strictEqual(both.grandTotal, 20000);

  const onlyP1 = await runDef(def, {
    cc:         'US',
    period:     null,
    personKeys: ['p-1'],
  }, entries);
  assert.strictEqual(onlyP1.grandTotal, 12000);
});

// ─── AuTaxByPersonYearDef ────────────────────────────────────────────────────

function auSettleEntry({ date, personTaxDetails }) {
  return entry({
    date,
    actionType: 'TAX_SETTLE_APPLY',
    data: { cc: 'AU', tax: personTaxDetails.reduce((s, p) => s + p.taxDetail.netLiability, 0), personTaxDetails },
  });
}

test('au-tax-by-person-year: fans out personTaxDetails and groups by year + personName', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('au-tax-by-person-year');
  assert.strictEqual(def.perPerson, true);

  const entries = [
    auSettleEntry({
      date: new Date(Date.UTC(2026, 5, 30)),
      personTaxDetails: [
        { personKey: 'p-1', personName: 'Alice', taxDetail: { netLiability: 12000 } },
        { personKey: 'p-2', personName: 'Bob',   taxDetail: { netLiability:  8000 } },
      ],
    }),
    auSettleEntry({
      date: new Date(Date.UTC(2027, 5, 30)),
      personTaxDetails: [
        { personKey: 'p-1', personName: 'Alice', taxDetail: { netLiability: 13000 } },
        { personKey: 'p-2', personName: 'Bob',   taxDetail: { netLiability:  9500 } },
      ],
    }),
    // US settle with no per-person details — must be excluded by the cc filter.
    entry({
      date: new Date(Date.UTC(2026, 11, 30)),
      actionType: 'TAX_SETTLE_APPLY',
      data: { cc: 'US', tax: 30000, taxDetail: { netLiability: 30000 } },
    }),
  ];

  const { groups, grandTotal } = await runDef(def, { period: null }, entries);
  const byKey = Object.fromEntries(groups.map(g => [`${g.key.year}|${g.key.personName}`, g.total]));
  assert.strictEqual(byKey['2026|Alice'], 12000);
  assert.strictEqual(byKey['2026|Bob'],    8000);
  assert.strictEqual(byKey['2027|Alice'], 13000);
  assert.strictEqual(byKey['2027|Bob'],   9500);
  assert.strictEqual(grandTotal, 12000 + 8000 + 13000 + 9500);
});

test('au-tax-by-person-year: personKeys facet narrows to selected people', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('au-tax-by-person-year');

  const entries = [
    auSettleEntry({
      date: new Date(Date.UTC(2026, 5, 30)),
      personTaxDetails: [
        { personKey: 'p-1', personName: 'Alice', taxDetail: { netLiability: 12000 } },
        { personKey: 'p-2', personName: 'Bob',   taxDetail: { netLiability:  8000 } },
      ],
    }),
  ];

  const { grandTotal: aliceOnly } = await runDef(def, { period: null, personKeys: ['p-1'] }, entries);
  assert.strictEqual(aliceOnly, 12000);
});

test('au-tax-by-person-year: ignores entries that lack personTaxDetails', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('au-tax-by-person-year');

  const entries = [
    // AU settle WITHOUT personTaxDetails — fall-back single-filer path. Should be skipped.
    entry({
      date: new Date(Date.UTC(2026, 5, 30)),
      actionType: 'TAX_SETTLE_APPLY',
      data: { cc: 'AU', tax: 10000, taxDetail: { netLiability: 10000 } },
    }),
  ];

  const { groups, grandTotal } = await runDef(def, { period: null }, entries);
  assert.strictEqual(groups.length, 0);
  assert.strictEqual(grandTotal, 0);
});

test('empty multiselect arrays act as "no filter"', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('cash-flow-by-account');

  const e = entry({
    actionType: 'TRANSFER_APPLY',
    data:       { amount: 1000 },
    stateDiff: [
      { field: 'usSavingsAccount.balance', before: 5000, after: 4000, delta: -1000 },
    ],
  });

  // null, undefined, and [] should all behave identically (no constraint).
  for (const v of [null, undefined, []]) {
    const r = await runDef(def, { period: null, accountStateKeys: v }, [e]);
    assert.strictEqual(r.groups.length, 1, `accountStateKeys=${JSON.stringify(v)} should not filter`);
    assert.strictEqual(r.groups[0].total, -1000);
  }
});
