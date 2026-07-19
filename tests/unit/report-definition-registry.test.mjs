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
import { TypeRegistry }               from '../../src/simulation-framework/type-registry.js';
import { ReportDefinitionRegistry }   from '../../src/finance/journal-reporting/report-definition-registry.js';
import { StateSchemaRegistry }        from '../../src/finance/services/state-schema-registry.js';

// All toolsets — registered once so familyTypes() resolves correctly.
import { US_BANKING }        from '../../src/scenarios/toolsets/us-banking-toolset.js';
import { US_BROKERAGE }      from '../../src/scenarios/toolsets/us-brokerage-toolset.js';
import { US_COLLECTIBLES }   from '../../src/scenarios/toolsets/us-collectibles-toolset.js';
import { US_INCOME }         from '../../src/scenarios/toolsets/us-income-toolset.js';
import { US_REAL_PROPERTY }  from '../../src/scenarios/toolsets/us-real-property-toolset.js';
import { US_RETIREMENT }     from '../../src/scenarios/toolsets/us-retirement-toolset.js';
import { US_ROTH_CONVERSION } from '../../src/scenarios/toolsets/us-roth-conversion-toolset.js';
import { US_TAX }            from '../../src/scenarios/toolsets/us-tax-toolset.js';
import { AU_BANKING }        from '../../src/scenarios/toolsets/au-banking-toolset.js';
import { AU_BROKERAGE }      from '../../src/scenarios/toolsets/au-brokerage-toolset.js';
import { AU_INCOME }         from '../../src/scenarios/toolsets/au-income-toolset.js';
import { AU_REAL_PROPERTY }  from '../../src/scenarios/toolsets/au-real-property-toolset.js';
import { AU_RETIREMENT }     from '../../src/scenarios/toolsets/au-retirement-toolset.js';
import { AU_TAX }            from '../../src/scenarios/toolsets/au-tax-toolset.js';

function buildTypeRegistry() {
  const reg = new TypeRegistry();
  for (const t of [
    US_BANKING, US_BROKERAGE, US_COLLECTIBLES, US_INCOME, US_REAL_PROPERTY,
    US_RETIREMENT, US_ROTH_CONVERSION, US_TAX,
    AU_BANKING, AU_BROKERAGE, AU_INCOME, AU_REAL_PROPERTY, AU_RETIREMENT, AU_TAX,
  ]) reg.registerToolset(t);
  return reg;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _seq = 0;

function entry({ id, date, actionType, data, stateDiff, instanceId } = {}) {
  return new JournalEntry({
    id:          id ?? `e-${_seq}`,
    seq:         _seq++,
    date:        date ?? new Date(Date.UTC(2026, 5, 15)),
    executionId: 'e1.1',
    event:  { nodeId: null, type: 'EVT', name: 'Evt', color: null },
    action: {
      // Shared across the entries a single action emits (one per reducer); pass
      // an explicit instanceId to simulate that action×reducer fan-out.
      instanceId:   instanceId ?? `i-${_seq}`,
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

const _typeRegistry = buildTypeRegistry();

function buildApi(entries, { perDiff = false, perPerson = false } = {}) {
  const j = new Journal({ enabled: true });
  for (const e of entries) j.addEntry(e);
  return new JournalQueryApi(new JournalDataSource(j, { perDiff, perPerson }), _typeRegistry);
}

async function runDef(def, params, entries) {
  const api = buildApi(entries, { perDiff: def.perDiff, perPerson: def.perPerson });
  const ast = def.buildQuery(params, api);
  return api.aggregate({
    query:      ast,
    groupBy:    def.defaultGroupBy,
    aggregates: def.defaultAggregates,
    sort:       [{ field: 'total', dir: 'desc' }],
    dedupeBy:   def.dedupeBy,
  });
}

// ─── Registry composition ────────────────────────────────────────────────────

test('ReportDefinitionRegistry registers the 15 built-in definitions', () => {
  const reg = new ReportDefinitionRegistry();
  const ids = reg.getAll().map(d => d.id).sort();
  assert.deepStrictEqual(ids, [
    'au-tax-by-person-year',
    'capital-gains-by-disposal',
    'cash-flow-by-account',
    'credits-to-account',
    'debits-from-account',
    'journal-composition',
    'money-moved-by-action',
    'nr-withholding-income-by-source',
    'ordinary-income-by-source',
    'pretax-adjustments-by-source',
    'real-property-cash-flow',
    'roth-conversions-by-year',
    'state-tax-by-year',
    'tax-paid-by-year',
    'withdrawals-by-account',
  ]);
});

// ─── JournalCompositionDef ───────────────────────────────────────────────────

test('journal-composition: counts journal entries per action type, one row per entry (not per action)', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('journal-composition');
  assert.strictEqual(def.perDiff, false, 'primary composition view is a bare-entry census');

  // ONE action, run through two reducers → two entries sharing an instanceId.
  // `count` must see both; `actions` (distinct instanceId) must collapse to 1.
  const convTax1 = entry({ actionType: 'ROTH_CONVERSION_TAX', data: { amount: 1000 }, instanceId: 'conv-tax-1' });
  const convTax2 = entry({ actionType: 'ROTH_CONVERSION_TAX', data: { amount: 1000 }, instanceId: 'conv-tax-1' });
  const convApply = entry({ actionType: 'ROTH_CONVERSION_APPLY', data: { amount: 40000 } });
  // An entry that carries no `amount` — count still increments, amount sum ignores it.
  const recordBal = entry({ actionType: 'RECORD_BALANCE' });

  const api = buildApi([convTax1, convTax2, convApply, recordBal], { perDiff: def.perDiff });
  const { groups } = await api.aggregate({
    query:      def.buildQuery({ period: null }, api),
    groupBy:    def.defaultGroupBy,
    aggregates: def.defaultAggregates,
    sort:       def.defaultSort,
  });

  const byType = Object.fromEntries(groups.map(g => [g.key.actionType, g]));
  assert.strictEqual(byType.ROTH_CONVERSION_TAX.count, 2, 'both reducer entries counted');
  assert.strictEqual(byType.ROTH_CONVERSION_TAX.actions, 1, 'distinct instanceId collapses reducer fan-out');
  assert.strictEqual(byType.ROTH_CONVERSION_APPLY.count, 1);
  assert.strictEqual(byType.ROTH_CONVERSION_APPLY.actions, 1);
  assert.strictEqual(byType.RECORD_BALANCE.count, 1);
  assert.strictEqual(byType.ROTH_CONVERSION_TAX.amount, 2000, 'amount summed across entries');
  // count-desc default sort → the two-entry type leads.
  assert.strictEqual(groups[0].key.actionType, 'ROTH_CONVERSION_TAX');
});

// ─── MoneyMovedByActionDef ───────────────────────────────────────────────────

test('money-moved-by-action: gross sums |Δ| so offsetting legs do not cancel; net keeps sign', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('money-moved-by-action');
  assert.strictEqual(def.perDiff, true);

  // A rebalance that moves $5k out of one holding-account leg and $5k into
  // another within the same account: net ≈ 0 but gross = $10k of real movement.
  const rebalance = entry({
    actionType: 'HOLDING_TRANSACT',
    stateDiff: [
      { field: 'brokerageAccount.balance', before: 100000, after: 95000,  delta: -5000 },
      { field: 'brokerageAccount.balance', before: 95000,  after: 100000, delta:  5000 },
    ],
  });
  // A plain withdrawal debit of $8k.
  const withdrawal = entry({
    actionType: 'STOCK_WITHDRAWAL_APPLY',
    stateDiff: [
      { field: 'brokerageAccount.balance', before: 100000, after: 92000, delta: -8000 },
    ],
  });
  // A non-account diff (YTD accumulator) must be excluded by the account.balance filter.
  const taxAccrual = entry({
    actionType: 'STOCK_WITHDRAWAL_TAX',
    stateDiff: [
      { field: 'usOrdinaryIncomeYTD', before: 0, after: 2000, delta: 2000 },
    ],
  });

  const api = buildApi([rebalance, withdrawal, taxAccrual], { perDiff: def.perDiff });
  const { groups } = await api.aggregate({
    query:      def.buildQuery({ period: null, accountStateKeys: [] }, api),
    groupBy:    def.defaultGroupBy,
    aggregates: def.defaultAggregates,
    sort:       def.defaultSort,
  });

  const byType = Object.fromEntries(groups.map(g => [g.key.actionType, g]));
  assert.strictEqual(byType.HOLDING_TRANSACT.gross, 10000, 'gross = |−5000| + |5000|');
  assert.strictEqual(byType.HOLDING_TRANSACT.net, 0,       'net cancels');
  assert.strictEqual(byType.STOCK_WITHDRAWAL_APPLY.gross, 8000);
  assert.strictEqual(byType.STOCK_WITHDRAWAL_APPLY.out, -8000, 'largest single debit');
  assert.ok(!('STOCK_WITHDRAWAL_TAX' in byType), 'non-account diffs excluded');
  // gross-desc default sort → the rebalance leads.
  assert.strictEqual(groups[0].key.actionType, 'HOLDING_TRANSACT');
});

// ─── StateTaxByYearDef ───────────────────────────────────────────────────────

test('state-tax-by-year: sums STATE_TAX_PAYMENT_DEBIT by year, ignoring federal tax payments', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('state-tax-by-year');

  const state2026 = entry({ date: new Date(Date.UTC(2026, 11, 31)), actionType: 'STATE_TAX_PAYMENT_DEBIT', data: { amount: 3629 } });
  const state2027 = entry({ date: new Date(Date.UTC(2027, 11, 31)), actionType: 'STATE_TAX_PAYMENT_DEBIT', data: { amount: 4100 } });
  // Federal payment in the same year must NOT be counted by the state report.
  const fed2026   = entry({ date: new Date(Date.UTC(2026, 11, 31)), actionType: 'US_TAX_PAYMENT_DEBIT',    data: { amount: 50000 } });

  const { groups, grandTotal } = await runDef(def, { period: null }, [state2026, state2027, fed2026]);

  const byYear = Object.fromEntries(groups.map(g => [g.key.year, g.total]));
  assert.strictEqual(byYear[2026], 3629);
  assert.strictEqual(byYear[2027], 4100);
  assert.strictEqual(grandTotal, 7729, 'federal payment excluded');
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

// ─── CreditsToAccountDef ─────────────────────────────────────────────────────

test('credits-to-account: includes only positive balance deltas regardless of action type', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('credits-to-account');
  assert.strictEqual(def.perDiff, true);

  const entries = [
    // REPLENISH_SAVINGS credits savings (+5000), debits IRA (-5000).
    entry({
      actionType: 'REPLENISH_SAVINGS',
      data:       { deficit: 5000 },
      stateDiff: [
        { field: 'usSavingsAccount.balance', before: 1000,  after: 6000,  delta:  5000 },
        { field: 'iraAccount.balance',       before: 80000, after: 75000, delta: -5000 },
      ],
    }),
    // Wages: no account.balance field — must be excluded.
    entry({
      actionType: 'WAGES_INCOME_TAX',
      data:       { amount: 9000, cc: 'US' },
      stateDiff:  [{ field: 'usOrdinaryIncomeYTD', before: 0, after: 9000, delta: 9000 }],
    }),
  ];

  const { groups, grandTotal } = await runDef(def, { period: null }, entries);
  const byKey = Object.fromEntries(groups.map(g => [g.key.stateKey, g.total]));

  assert.strictEqual(byKey['usSavingsAccount.balance'], 5000, 'savings credit must appear');
  assert.ok(!('iraAccount.balance' in byKey), 'IRA debit must be excluded');
  assert.ok(!('usOrdinaryIncomeYTD' in byKey), 'non-account field must be excluded');
  assert.strictEqual(grandTotal, 5000);
});

// ─── DebitsFromAccountDef ─────────────────────────────────────────────────────

test('debits-from-account: includes only negative balance deltas across all action types', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('debits-from-account');
  assert.strictEqual(def.perDiff, true);

  const entries = [
    // EXPENSE_DEBIT debits savings (-3000).
    entry({
      actionType: 'EXPENSE_DEBIT',
      data:       { amount: 3000 },
      stateDiff: [
        { field: 'usSavingsAccount.balance', before: 6000, after: 3000, delta: -3000 },
      ],
    }),
    // REPLENISH_SAVINGS: savings credit (+5000) must be excluded, IRA debit (-5000) must appear.
    entry({
      actionType: 'REPLENISH_SAVINGS',
      data:       { deficit: 5000 },
      stateDiff: [
        { field: 'usSavingsAccount.balance', before: 1000,  after: 6000,  delta:  5000 },
        { field: 'iraAccount.balance',       before: 80000, after: 75000, delta: -5000 },
      ],
    }),
    // Income field — must be excluded.
    entry({
      actionType: 'WAGES_INCOME_TAX',
      data:       { amount: 9000, cc: 'US' },
      stateDiff:  [{ field: 'usOrdinaryIncomeYTD', before: 0, after: 9000, delta: 9000 }],
    }),
  ];

  const { groups, grandTotal } = await runDef(def, { period: null }, entries);
  const byKey = Object.fromEntries(groups.map(g => [g.key.stateKey, g.total]));

  assert.strictEqual(byKey['usSavingsAccount.balance'], -3000, 'savings expense debit must appear');
  assert.strictEqual(byKey['iraAccount.balance'],       -5000, 'IRA drawdown debit must appear');
  assert.ok(!('usOrdinaryIncomeYTD' in byKey), 'non-account field must be excluded');
  assert.strictEqual(grandTotal, -8000);
});

// ─── TaxPaidByYearDef ────────────────────────────────────────────────────────

test('tax-paid-by-year: groups TAX_PAYMENT_DEBIT entries by year, sums amount', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('tax-paid-by-year');

  const entries = [
    entry({ date: new Date(Date.UTC(2026, 5, 30)),  actionType: 'US_TAX_PAYMENT_DEBIT', data: { amount: 15000 } }),
    entry({ date: new Date(Date.UTC(2026, 11, 30)), actionType: 'AU_TAX_PAYMENT_DEBIT', data: { amount:  8000 } }),
    entry({ date: new Date(Date.UTC(2027, 5, 30)),  actionType: 'US_TAX_PAYMENT_DEBIT', data: { amount: 20000 } }),
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
    entry({ date: new Date(Date.UTC(2026, 5, 30)),  actionType: 'US_TAX_PAYMENT_DEBIT', data: { amount: 15000 } }),
    entry({ date: new Date(Date.UTC(2026, 11, 30)), actionType: 'AU_TAX_PAYMENT_DEBIT', data: { amount:  8000 } }),
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
      actionType: 'LOAN_PAYMENT_APPLY',
      data:       { payment: 2500, interest: 0 },
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
  assert.strictEqual(totalsByType['LOAN_PAYMENT_APPLY'], -2500);
  assert.ok(!('WAGES_INCOME_TAX' in totalsByType), 'off-domain action types must be excluded');
  assert.strictEqual(grandTotal, 700000 + -800000 + -2500);
});

// ─── CapitalGainsByDisposalDef ───────────────────────────────────────────────

test('capital-gains-by-disposal: AU report includes US-asset disposals realized while AU-resident (cross-border)', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('capital-gains-by-disposal');

  const entries = [
    // US stock sale realized while AU-resident — feeds auCapitalGainsYTD via the
    // US tax module's isAuResident branch, but the action is cc 'US'. The old
    // `familyTypes('CAPITAL_GAINS', { cc: 'AU' })` filter dropped it; it must
    // appear now.
    entry({ actionType: 'STOCK_WITHDRAWAL_TAX',    data: { gain: 40000,    proceeds: 100000, residency: 'AU', description: 'usStockAccount' } }),
    // Native AU stock sale, AU-resident.
    entry({ actionType: 'AU_STOCK_WITHDRAWAL_TAX', data: { gain: 23371.89, proceeds:  60000, residency: 'AU', description: 'auStockAccount' } }),
  ];

  const { groups, grandTotal } = await runDef(def, { cc: 'AU', period: null }, entries);
  const types = groups.map(g => g.key.actionType).sort();
  assert.ok(types.includes('STOCK_WITHDRAWAL_TAX'),    'US-cc disposal must appear in the AU report');
  assert.ok(types.includes('AU_STOCK_WITHDRAWAL_TAX'), 'AU-cc disposal must appear in the AU report');
  // Ties out to the "Capital Gains (before discount)" line (= auCapitalGainsYTD).
  assert.strictEqual(Math.round(grandTotal * 100) / 100, 63371.89);
});

test('capital-gains-by-disposal: AU report excludes non-resident disposals (they route to NR withholding)', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('capital-gains-by-disposal');

  const entries = [
    entry({ actionType: 'AU_STOCK_WITHDRAWAL_TAX', data: { gain: 10000, proceeds: 30000, residency: 'AU' } }),
    // Non-resident disposal: gain accrues to auNonResidentWithholdingYTD, not
    // auCapitalGainsYTD — must NOT show on the AU capital-gains report.
    entry({ actionType: 'AU_STOCK_WITHDRAWAL_TAX', data: { gain:  5000, proceeds: 20000, residency: 'US' } }),
  ];

  const { grandTotal } = await runDef(def, { cc: 'AU', period: null }, entries);
  assert.strictEqual(grandTotal, 10000, 'only resident-realized gains belong to the AU line');
});

test('capital-gains-by-disposal: US report sums every disposal incl gain-only types, regardless of residency', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('capital-gains-by-disposal');

  const entries = [
    entry({ actionType: 'STOCK_WITHDRAWAL_TAX',  data: { gain: 40000, proceeds: 100000, residency: 'AU', description: 'usStockAccount' } }),
    // House sale carries no `residency` and (historically) no `proceeds` field —
    // the old `proceeds > 0` filter dropped it. After normalising taxableGain →
    // gain it must be summed.
    entry({ actionType: 'US_HOUSE_SALE_TAX',     data: { gain: 50000, proceeds: 800000, description: 'usHouse' } }),
    // Collectible sale carries gain but no proceeds — also previously dropped.
    entry({ actionType: 'COLLECTIBLE_SALE_TAX',  data: { gain:  5000, residency: 'US' } }),
  ];

  const { groups, grandTotal } = await runDef(def, { cc: 'US', period: null }, entries);
  const types = groups.map(g => g.key.actionType).sort();
  assert.deepStrictEqual(types, ['COLLECTIBLE_SALE_TAX', 'STOCK_WITHDRAWAL_TAX', 'US_HOUSE_SALE_TAX']);
  // Ties out to usCapitalGainsYTD (every disposal, every residency).
  assert.strictEqual(grandTotal, 95000);

  // proceeds is a secondary column: gain-only rows contribute null and are
  // skipped by the sum, so only the two proceeds-bearing rows count.
  const collectible = groups.find(g => g.key.actionType === 'COLLECTIBLE_SALE_TAX');
  assert.strictEqual(collectible.proceeds, 0, 'gain-only row sums to 0 proceeds, not NaN');
});

test('capital-gains-by-disposal: dedupes the reducer fan-out so one disposal counts once', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('capital-gains-by-disposal');
  assert.strictEqual(def.dedupeBy, 'instanceId', 'CG report must dedupe by instanceId');

  // ONE house sale (gain 350000), journaled 3× — one row per TAX_CALC reducer
  // (dynamic:US, state:classify, dynamic:AU) — all sharing the action instanceId
  // and carrying the identical `gain`/`proceeds` payload. Without dedupe the sum
  // and count triple; with dedupe they reflect the single disposal.
  const entries = [
    entry({ actionType: 'US_HOUSE_SALE_TAX', instanceId: 'sale-1', data: { gain: 350000, proceeds: 1200000, description: 'usHouseProperty' } }),
    entry({ actionType: 'US_HOUSE_SALE_TAX', instanceId: 'sale-1', data: { gain: 350000, proceeds: 1200000, description: 'usHouseProperty' } }),
    entry({ actionType: 'US_HOUSE_SALE_TAX', instanceId: 'sale-1', data: { gain: 350000, proceeds: 1200000, description: 'usHouseProperty' } }),
  ];

  const { groups, grandTotal } = await runDef(def, { cc: 'US', period: null }, entries);
  assert.strictEqual(groups.length, 1);
  const g = groups[0];
  assert.strictEqual(g.total, 350000, 'gain summed once, not tripled');
  assert.strictEqual(g.count, 1, 'one distinct disposal, not three journal rows');
  assert.strictEqual(g.proceeds, 1200000, 'proceeds summed once');
  assert.strictEqual(grandTotal, 350000);
});

// ─── Facet sanity ────────────────────────────────────────────────────────────

test('new definitions all expose at least a period facet', () => {
  const reg = new ReportDefinitionRegistry();
  for (const id of ['withdrawals-by-account', 'credits-to-account', 'debits-from-account', 'tax-paid-by-year', 'roth-conversions-by-year', 'real-property-cash-flow']) {
    const def    = reg.get(id);
    const facets = def.facets;
    assert.ok(facets.some(f => f.kind === 'period'), `${id} should declare a period facet`);
  }
});

// ─── Phase 3B: multiselect facets ────────────────────────────────────────────

test('account-multiselect defs expose an "account" multiselect facet', () => {
  const reg = new ReportDefinitionRegistry();
  for (const id of ['cash-flow-by-account', 'withdrawals-by-account', 'credits-to-account', 'debits-from-account', 'real-property-cash-flow']) {
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
    actionType: 'AU_TAX_SETTLE_APPLY',
    data: { tax: personTaxDetails.reduce((s, p) => s + p.taxDetail.netLiability, 0), personTaxDetails },
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
      actionType: 'US_TAX_SETTLE_APPLY',
      data: { tax: 30000, taxDetail: { netLiability: 30000 } },
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
      actionType: 'AU_TAX_SETTLE_APPLY',
      data: { tax: 10000, taxDetail: { netLiability: 10000 } },
    }),
  ];

  const { groups, grandTotal } = await runDef(def, { period: null }, entries);
  assert.strictEqual(groups.length, 0);
  assert.strictEqual(grandTotal, 0);
});

// ─── NrWithholdingIncomeBySourceDef ──────────────────────────────────────────

test('nr-withholding-income-by-source: matches household-mode entries (auNonResidentWithholdingYTD)', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('nr-withholding-income-by-source');

  // Household mode: reducer writes auNonResidentWithholdingYTD directly (state.people == null).
  const savingsEntry = entry({
    actionType: 'AU_SAVINGS_EARNINGS_TAX',
    data:       { amount: 150, residency: 'US' },
    stateDiff: [
      { field: 'auNonResidentWithholdingYTD', before: 0,   after: 150, delta: 150 },
      { field: 'ftcYTD',                      before: 0,   after: 150, delta: 150 },
    ],
  });
  const fixedEntry = entry({
    actionType: 'AU_FIXED_INCOME_EARNINGS_TAX',
    data:       { amount: 110.57, residency: 'US' },
    stateDiff: [
      { field: 'auNonResidentWithholdingYTD', before: 150, after: 260.57, delta: 110.57 },
      { field: 'ftcYTD',                      before: 150, after: 260.57, delta: 110.57 },
    ],
  });
  // Ordinary income entry — must not appear in NR withholding report.
  const ordinaryEntry = entry({
    actionType: 'WAGES_INCOME_TAX',
    data:       { amount: 5000 },
    stateDiff: [
      { field: 'auOrdinaryIncomeYTD', before: 0, after: 5000, delta: 5000 },
    ],
  });

  const { groups, grandTotal } = await runDef(def, { period: null }, [savingsEntry, fixedEntry, ordinaryEntry]);
  const types = groups.map(g => g.key.actionType).sort();
  assert.ok(types.includes('AU_SAVINGS_EARNINGS_TAX'),     'savings withholding must appear');
  assert.ok(types.includes('AU_FIXED_INCOME_EARNINGS_TAX'), 'fixed-income withholding must appear');
  assert.ok(!types.includes('WAGES_INCOME_TAX'), 'ordinary income must be excluded');
  assert.strictEqual(grandTotal, 260.57);
});

test('nr-withholding-income-by-source: matches per-person-mode entries (auPersonNonResidentWithholdingYTD)', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('nr-withholding-income-by-source');

  // Per-person mode: reducer writes auPersonNonResidentWithholdingYTD (state.people != null).
  const perPersonEntry = entry({
    actionType: 'AU_SAVINGS_EARNINGS_TAX',
    data:       { amount: 260.57, residency: 'US', personKey: 'p-1' },
    stateDiff: [
      { field: 'auPersonNonResidentWithholdingYTD', before: 0, after: 260.57, delta: 260.57 },
      { field: 'ftcYTD',                            before: 0, after: 260.57, delta: 260.57 },
    ],
  });

  const { grandTotal } = await runDef(def, { period: null }, [perPersonEntry]);
  assert.strictEqual(grandTotal, 260.57,
    'per-person path (auPersonNonResidentWithholdingYTD) must be found by the report');
});

test('nr-withholding-income-by-source: personKeys facet filters correctly', async () => {
  const reg = new ReportDefinitionRegistry();
  const def = reg.get('nr-withholding-income-by-source');

  const entries = [
    entry({
      actionType: 'AU_SAVINGS_EARNINGS_TAX',
      data:       { amount: 200, residency: 'US', personKey: 'p-1' },
      stateDiff: [{ field: 'auNonResidentWithholdingYTD', before: 0,   after: 200, delta: 200 }],
    }),
    entry({
      actionType: 'AU_SAVINGS_EARNINGS_TAX',
      data:       { amount: 60.57, residency: 'US', personKey: 'p-2' },
      stateDiff: [{ field: 'auNonResidentWithholdingYTD', before: 200, after: 260.57, delta: 60.57 }],
    }),
  ];

  const all = await runDef(def, { period: null }, entries);
  assert.strictEqual(all.grandTotal, 260.57);

  const p1Only = await runDef(def, { period: null, personKeys: ['p-1'] }, entries);
  assert.strictEqual(p1Only.grandTotal, 200);
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

// ─── Design 70 §6.3 — the §14.6 substring retire ─────────────────────────────

/**
 * Build an api whose schema registry knows the given accounts, so per-account
 * reports scope to the real account set instead of the `account.balance`
 * substring. Mirrors what ScenarioLoader._registerDisplayCurrencies stamps.
 */
function buildScopedApi(entries, stateKeys, { perDiff = true } = {}) {
  const j = new Journal({ enabled: true });
  for (const e of entries) j.addEntry(e);
  const reg = new StateSchemaRegistry();
  for (const sk of stateKeys) reg.registerDisplayRecord(sk, { name: sk, country: 'US' }, 'account');
  return new JournalQueryApi(new JournalDataSource(j, { perDiff }), _typeRegistry, null, reg);
}

async function runScopedDef(def, params, entries, stateKeys) {
  const api = buildScopedApi(entries, stateKeys, { perDiff: def.perDiff });
  return api.aggregate({
    query:      def.buildQuery(params, api),
    groupBy:    def.defaultGroupBy,
    aggregates: def.defaultAggregates,
    dedupeBy:   def.dedupeBy,
  });
}

const _mixedKeyEntries = [
  entry({
    actionType: 'TRANSFER_APPLY',
    data:       { amount: 1000 },
    stateDiff: [
      { field: 'usSavingsAccount.balance', before: 5000, after: 4000, delta: -1000 },
      // An inherited key that does NOT end in `…Account` — invisible to the old
      // `contains 'account.balance'` selector (design 63 §14.6).
      { field: 'beq1_a1.balance',          before: 0,    after: 1000, delta:  1000 },
    ],
  }),
];

test('§14.6: a non-…Account inherited key now selects into cash-flow-by-account', async () => {
  const def = new ReportDefinitionRegistry().get('cash-flow-by-account');

  // Before: the substring selector drops it (no registry bound → fallback path).
  const legacy = await runDef(def, { period: null }, _mixedKeyEntries);
  assert.deepStrictEqual(legacy.groups.map(g => g.key.stateKey), ['usSavingsAccount.balance'],
    'the substring selector is blind to beq1_a1');

  // After: scoping to the real account set picks it up.
  const scoped = await runScopedDef(def, { period: null }, _mixedKeyEntries,
    ['usSavingsAccount', 'beq1_a1']);
  assert.deepStrictEqual(scoped.groups.map(g => g.key.stateKey).sort(),
    ['beq1_a1.balance', 'usSavingsAccount.balance']);
});

test('§14.6: existing …Account-keyed selection is unchanged by the retire', async () => {
  const def = new ReportDefinitionRegistry().get('cash-flow-by-account');
  const entries = [
    entry({
      actionType: 'TRANSFER_APPLY',
      data:       { amount: 1000 },
      stateDiff: [
        { field: 'usSavingsAccount.balance', before: 5000, after: 4000, delta: -1000 },
        { field: 'checkingAccount.balance',  before: 0,    after: 1000, delta:  1000 },
        // Non-balance rows on an account must stay out of an account *balance* report.
        { field: 'usSavingsAccount.holdings.0.marketValue', before: 10, after: 20, delta: 10 },
      ],
    }),
  ];
  const keys = ['usSavingsAccount', 'checkingAccount'];
  const legacy = await runDef(def, { period: null }, entries);
  const scoped = await runScopedDef(def, { period: null }, entries, keys);
  assert.deepStrictEqual(
    scoped.groups.map(g => ({ k: g.key.stateKey, t: g.total })).sort((a, b) => a.k.localeCompare(b.k)),
    legacy.groups.map(g => ({ k: g.key.stateKey, t: g.total })).sort((a, b) => a.k.localeCompare(b.k)),
    'byte-identical selection for …Account keys');
});

test('§14.6: the accounts facet still narrows to the selected accounts', async () => {
  const def = new ReportDefinitionRegistry().get('cash-flow-by-account');
  const scoped = await runScopedDef(def,
    { period: null, accountStateKeys: ['beq1_a1'] }, _mixedKeyEntries,
    ['usSavingsAccount', 'beq1_a1']);
  assert.deepStrictEqual(scoped.groups.map(g => g.key.stateKey), ['beq1_a1.balance']);
});

test('§14.6: every per-account report scopes to the account set', async () => {
  const reg = new ReportDefinitionRegistry();
  const withdrawal = [
    entry({
      actionType: 'K401_WITHDRAWAL_APPLY',
      data:       { amount: 500 },
      stateDiff: [{ field: 'beq1_a1.balance', before: 1000, after: 500, delta: -500 }],
    }),
  ];
  for (const id of ['withdrawals-by-account', 'debits-from-account', 'money-moved-by-action']) {
    const res = await runScopedDef(reg.get(id), { period: null }, withdrawal, ['beq1_a1']);
    assert.ok(res.groups.length > 0, `${id} should see the inherited key`);
  }
});
