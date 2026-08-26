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
 * report-currency.test.mjs — journal reports must not add AUD onto USD.
 *
 * The defect: "Tax Paid by Year" with the country facet blank summed
 * `AU_TAX_PAYMENT_DEBIT.amount` (declared AUD) straight onto its USD siblings,
 * reporting a number in no currency. These tests pin the fix at every layer it
 * touches: the declaration reader (TypeRegistry.fieldCurrency), the rate source
 * (JournalFxRates), the aggregation (normalizeAggregateCurrency, reached through
 * runReport), and the per-diff account reports that mix account currencies.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { Journal, JournalEntry }    from '../../src/simulation-framework/journal.js';
import { TypeRegistry }             from '../../src/simulation-framework/type-registry.js';
import { StateSchemaRegistry }      from '../../src/finance/services/state-schema-registry.js';
import { ReportDefinitionRegistry } from '../../src/finance/journal-reporting/report-definition-registry.js';
import { createReportApis, runReport } from '../../src/finance/journal-reporting/run-report.js';
import { JournalFxRates, normalizeAggregateCurrency, USD_AUD_PATH }
  from '../../src/finance/journal-reporting/report-currency.js';

import { US_TAX }       from '../../src/scenarios/toolsets/us-tax-toolset.js';
import { US_INCOME }    from '../../src/scenarios/toolsets/us-income-toolset.js';
import { US_STATE_TAX } from '../../src/scenarios/toolsets/us-state-tax-toolset.js';
import { AU_TAX }       from '../../src/scenarios/toolsets/au-tax-toolset.js';
import { US_BANKING }   from '../../src/scenarios/toolsets/us-banking-toolset.js';
import { AU_BANKING }   from '../../src/scenarios/toolsets/au-banking-toolset.js';
import { US_BROKERAGE } from '../../src/scenarios/toolsets/us-brokerage-toolset.js';
import { AU_BROKERAGE } from '../../src/scenarios/toolsets/au-brokerage-toolset.js';
import { loadScenarioSim } from '../helpers/scenario-harness.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WHOLE_SIM = { fromEntryId: null, toEntryId: null };

function typeRegistry() {
  const reg = new TypeRegistry();
  for (const t of [US_TAX, US_INCOME, US_STATE_TAX, AU_TAX, US_BANKING, AU_BANKING,
                   US_BROKERAGE, AU_BROKERAGE]) reg.registerToolset(t);
  return reg;
}

let _seq = 0;

function entry({ date, actionType, data, stateDiff } = {}) {
  return new JournalEntry({
    id:          `e-${_seq}`,
    seq:         _seq++,
    date:        date ?? new Date(Date.UTC(2026, 5, 15)),
    executionId: 'e1.1',
    event:  { nodeId: null, type: 'EVT', name: 'Evt', color: null },
    action: {
      instanceId: `i-${_seq}`, parentId: null, rootId: null, siblingIndex: 0,
      nodeId: null, type: actionType, name: actionType, data: data ?? {},
    },
    reducer:            { nodeId: null, name: 'R' },
    stateDiff:          stateDiff ?? [],
    emittedInstanceIds: [],
    emittedTypes:       [],
  });
}

function journalOf(entries) {
  const j = new Journal({ enabled: true });
  for (const e of entries) j.addEntry(e);
  return j;
}

function apisFor(entries, { schemaRegistry = null } = {}) {
  return createReportApis(journalOf(entries), { typeRegistry: typeRegistry(), schemaRegistry });
}

/** An AU settlement, which is where a static-FX run records its USD/AUD rate. */
const auSettle = (date, fxRate) => entry({
  date, actionType: 'AU_TAX_SETTLE_APPLY', data: { tax: 1, fxRate },
});

/** Run `fn` with the sim's per-event logging silenced. */
function silently(fn) {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = log; console.warn = warn; }
}

/** Swallow the module's console.warn so an intentionally rate-less run stays quiet. */
async function withoutWarnings(fn) {
  const original = console.warn;
  const seen = [];
  console.warn = (...args) => seen.push(args.join(' '));
  try { return { result: await fn(), warnings: seen }; }
  finally { console.warn = original; }
}

// ─── The declaration reader ───────────────────────────────────────────────────

test('TypeRegistry.fieldCurrency reads the code the toolset declared', () => {
  const reg = typeRegistry();
  assert.strictEqual(reg.fieldCurrency('AU_TAX_PAYMENT_DEBIT',    'amount'), 'AUD');
  assert.strictEqual(reg.fieldCurrency('US_TAX_PAYMENT_DEBIT',    'amount'), 'USD');
  assert.strictEqual(reg.fieldCurrency('STATE_TAX_PAYMENT_DEBIT', 'amount'), 'USD');
  // Not money, not declared, not registered → no unit to claim.
  assert.strictEqual(reg.fieldCurrency('AU_TAX_PAYMENT_DEBIT', 'escalated'), null);
  assert.strictEqual(reg.fieldCurrency('AU_TAX_PAYMENT_DEBIT', 'nosuch'),    null);
  assert.strictEqual(reg.fieldCurrency('NO_SUCH_ACTION',       'amount'),    null);
});

// ─── The rate source ──────────────────────────────────────────────────────────

test('JournalFxRates: a static-FX run reads its rate off the tax settlements', () => {
  const fx = new JournalFxRates(journalOf([auSettle(new Date(Date.UTC(2026, 5, 30)), 1.5)]));
  assert.strictEqual(fx.isEmpty, false);
  // Before the first settle, at it, and after it: one recorded rate covers the run.
  assert.strictEqual(fx.rateAt(Date.UTC(2020, 0, 1)), 1.5);
  assert.strictEqual(fx.rateAt(Date.UTC(2026, 5, 30)), 1.5);
  assert.strictEqual(fx.rateAt(Date.UTC(2040, 0, 1)), 1.5);
  assert.strictEqual(fx.convert(150, 'AUD', 'USD', Date.UTC(2026, 5, 30)), 100);
  assert.strictEqual(fx.convert(150, 'AUD', 'AUD', Date.UTC(2026, 5, 30)), 150, 'same currency is untouched');
});

test('JournalFxRates: a moving rate is read per date from the state diffs, seeded by the first `before`', () => {
  const fx = new JournalFxRates(journalOf([
    entry({
      date: new Date(Date.UTC(2027, 0, 1)), actionType: 'FX_STEP_APPLY',
      stateDiff: [{ field: USD_AUD_PATH, before: 1.5, after: 1.6, delta: 0.1 }],
    }),
    entry({
      date: new Date(Date.UTC(2028, 0, 1)), actionType: 'FX_STEP_APPLY',
      stateDiff: [{ field: USD_AUD_PATH, before: 1.6, after: 2.0, delta: 0.4 }],
    }),
  ]));
  assert.strictEqual(fx.rateAt(Date.UTC(2026, 0, 1)), 1.5, 'the opening rate covers everything before the first move');
  assert.strictEqual(fx.rateAt(Date.UTC(2027, 6, 1)), 1.6);
  assert.strictEqual(fx.rateAt(Date.UTC(2029, 0, 1)), 2.0);
});

test('JournalFxRates: no recorded rate anywhere ⇒ null, never a silent 1.0', () => {
  const fx = new JournalFxRates(journalOf([entry({ actionType: 'RECORD_BALANCE' })]));
  assert.strictEqual(fx.isEmpty, true);
  assert.strictEqual(fx.rateAt(Date.UTC(2026, 0, 1)), null);
  assert.strictEqual(fx.convert(100, 'AUD', 'USD', Date.UTC(2026, 0, 1)), null);
  assert.strictEqual(fx.convert(100, 'USD', 'USD', Date.UTC(2026, 0, 1)), 100, 'no rate needed to not convert');
});

test('JournalFxRates: falls back to the live state rate when the journal records none', () => {
  const fx = new JournalFxRates(journalOf([entry({ actionType: 'RECORD_BALANCE' })]), {
    fallbackRate: () => 1.25,
  });
  assert.strictEqual(fx.rateAt(Date.UTC(2026, 0, 1)), 1.25);
});

// ─── The report ───────────────────────────────────────────────────────────────

/**
 * Design 95 phase 6 — the report must count tax WITHHELD as tax paid.
 *
 * The settle credits withholding against the liability and debits only the balance
 * due, so a report reading the TAX_PAYMENT_DEBIT family alone reports the balance
 * and calls it the tax. Three rows here: a debit, a withholding that was netted out
 * of the paycheque, and a hand-authored withholding that debited cash. All three are
 * tax the household paid, and all three must be in the total exactly once.
 */
test('tax-paid-by-year: withheld tax counts, netted or debited', async () => {
  const def  = new ReportDefinitionRegistry().get('tax-paid-by-year');
  const rows = [
    entry({ date: new Date(Date.UTC(2026, 0, 31)), actionType: 'WAGES_WITHHELD_APPLY',
            data: { amount: 400, alreadyNetted: true } }),
    entry({ date: new Date(Date.UTC(2026, 1, 28)), actionType: 'WAGES_WITHHELD_APPLY',
            data: { amount: 200 } }),
    entry({ date: new Date(Date.UTC(2026, 11, 31)), actionType: 'US_TAX_PAYMENT_DEBIT',
            data: { amount: 100 } }),
  ];

  const us = await runReport(def, { cc: 'US', period: WHOLE_SIM }, apisFor(rows));
  assert.strictEqual(us.currency, 'USD');
  assert.ok(Math.abs(us.grandTotal - 700) < 1e-9,
    `withheld 400 + 200 plus a 100 balance due is 700, got ${us.grandTotal}`);

  // Blank cc must pick the same rows up, not double them.
  const all = await runReport(def, { cc: '', period: WHOLE_SIM }, apisFor(rows));
  assert.ok(Math.abs(all.grandTotal - 700) < 1e-9,
    `all-countries must agree with US-only when there is no AU row, got ${all.grandTotal}`);

  // AU is a different country's return: US withholding is not on it.
  const au = await runReport(def, { cc: 'AU', period: WHOLE_SIM }, apisFor(rows));
  assert.strictEqual(au.grandTotal, 0, 'US withholding must not appear on the AU total');
});

test('tax-paid-by-year: an AUD row and a USD row do not sum raw', async () => {
  const def  = new ReportDefinitionRegistry().get('tax-paid-by-year');
  const apis = apisFor([
    auSettle(new Date(Date.UTC(2026, 5, 30)), 1.5),
    entry({ date: new Date(Date.UTC(2026, 5, 30)), actionType: 'AU_TAX_PAYMENT_DEBIT', data: { amount: 100 } }),
    entry({ date: new Date(Date.UTC(2026, 11, 31)), actionType: 'US_TAX_PAYMENT_DEBIT', data: { amount: 100 } }),
  ]);

  const { grandTotal, currency } = await runReport(def, { cc: '', period: WHOLE_SIM }, apis);

  assert.strictEqual(currency, 'USD', 'the all-countries total names its unit');
  assert.notStrictEqual(grandTotal, 200, 'A$100 + $100 must not report 200');
  assert.ok(Math.abs(grandTotal - (100 / 1.5 + 100)) < 1e-9,
    `expected ${100 / 1.5 + 100}, got ${grandTotal}`);
});

test('tax-paid-by-year: each AU payment converts at the rate in force on its own date', async () => {
  const def  = new ReportDefinitionRegistry().get('tax-paid-by-year');
  const apis = apisFor([
    // Rate starts at 1.5 and doubles at the start of 2028.
    entry({
      date: new Date(Date.UTC(2028, 0, 1)), actionType: 'FX_STEP_APPLY',
      stateDiff: [{ field: USD_AUD_PATH, before: 1.5, after: 3.0, delta: 1.5 }],
    }),
    entry({ date: new Date(Date.UTC(2027, 5, 30)), actionType: 'AU_TAX_PAYMENT_DEBIT', data: { amount: 300 } }),
    entry({ date: new Date(Date.UTC(2029, 5, 30)), actionType: 'AU_TAX_PAYMENT_DEBIT', data: { amount: 300 } }),
  ]);

  const { groups } = await runReport(def, { cc: '', period: WHOLE_SIM }, apis);
  const byYear = Object.fromEntries(groups.map(g => [g.key.year, g.total]));

  assert.strictEqual(byYear[2027], 200, 'A$300 at 1.5');
  assert.strictEqual(byYear[2029], 100, 'A$300 at 3.0 — the same AUD bill is worth less');
});

test('tax-paid-by-year: picking AU reports AUD, unconverted', async () => {
  const def  = new ReportDefinitionRegistry().get('tax-paid-by-year');
  const apis = apisFor([
    auSettle(new Date(Date.UTC(2026, 5, 30)), 1.5),
    entry({ date: new Date(Date.UTC(2026, 5, 30)), actionType: 'AU_TAX_PAYMENT_DEBIT', data: { amount: 100 } }),
    entry({ date: new Date(Date.UTC(2026, 11, 31)), actionType: 'US_TAX_PAYMENT_DEBIT', data: { amount: 100 } }),
  ]);

  const { grandTotal, currency } = await runReport(def, { cc: 'AU', period: WHOLE_SIM }, apis);

  assert.strictEqual(currency, 'AUD');
  assert.strictEqual(grandTotal, 100, 'an AU return is stated in AUD');
});

test('tax-paid-by-year: a cross-currency row with no recorded rate is excluded, not mixed in', async () => {
  const def  = new ReportDefinitionRegistry().get('tax-paid-by-year');
  const apis = apisFor([
    entry({ date: new Date(Date.UTC(2026, 5, 30)), actionType: 'AU_TAX_PAYMENT_DEBIT', data: { amount: 100 } }),
    entry({ date: new Date(Date.UTC(2026, 11, 31)), actionType: 'US_TAX_PAYMENT_DEBIT', data: { amount: 100 } }),
  ]);

  const { result, warnings } = await withoutWarnings(
    () => runReport(def, { cc: '', period: WHOLE_SIM }, apis),
  );

  assert.strictEqual(result.grandTotal, 100, 'the USD row alone; the unconvertible AUD row is dropped');
  assert.ok(warnings.some(w => w.includes('no USD/AUD rate')), 'the exclusion is announced');
  // count still sees both rows, so the drop is visible rather than silent.
  const counts = result.groups.reduce((s, g) => s + g.count, 0);
  assert.strictEqual(counts, 2);
});

test('a report that declares no currency folds exactly as projected', async () => {
  const def = new ReportDefinitionRegistry().get('ordinary-income-by-source');
  assert.strictEqual(def.reportCurrency({ cc: 'AU' }), null,
    'the cc-faceted income drills are single-currency by construction');

  const apis = apisFor([
    auSettle(new Date(Date.UTC(2026, 5, 30)), 1.5),
    entry({
      date: new Date(Date.UTC(2026, 2, 1)), actionType: 'AU_SAVINGS_INTEREST',
      stateDiff: [{ field: 'auOrdinaryIncomeYTD', before: 0, after: 500, delta: 500 }],
    }),
  ]);

  const { grandTotal, currency } = await runReport(def, { cc: 'AU', period: WHOLE_SIM }, apis);
  assert.strictEqual(currency, null);
  assert.strictEqual(grandTotal, 500, 'AUD income stays AUD — the AU return foots to this');
});


test('capital-gains-by-disposal converts a US-asset disposal\'s proceeds onto an AU return', async () => {
  // Design 91 §8. `total` sums the AU accumulator (already AUD via the state schema)
  // and was always right. `proceeds` comes off the action payload, and until the
  // disposal money carried a currency code it was folded at FACE VALUE — a USD
  // contract amount added straight onto an AUD column. Declaring reportCurrency
  // without typing the payload would not have fixed that; it would only have
  // asserted the wrong number was AUD.
  const RATE = 1.55;
  const def  = new ReportDefinitionRegistry().get('capital-gains-by-disposal');
  assert.strictEqual(def.reportCurrency({ cc: 'AU' }), 'AUD');
  assert.strictEqual(def.reportCurrency({ cc: 'US' }), 'USD');

  const apis = apisFor([
    auSettle(new Date(Date.UTC(2030, 5, 30)), RATE),
    // US brokerage disposal assessed on the AU return: payload USD, accumulator AUD.
    entry({
      date: new Date(Date.UTC(2030, 5, 15)), actionType: 'STOCK_WITHDRAWAL_TAX',
      data: { gain: 40000, proceeds: 100000, residency: 'AU', description: 'usStockAccount' },
      stateDiff: [{ field: 'auCapitalGainsYTD', before: 0, after: 62000, delta: 62000 }],
    }),
    // Native AU disposal: payload and accumulator agree, both AUD.
    entry({
      date: new Date(Date.UTC(2030, 5, 15)), actionType: 'AU_STOCK_WITHDRAWAL_TAX',
      data: { gain: 20000, proceeds: 60000, residency: 'AU', description: 'auStockAccount' },
      stateDiff: [{ field: 'auCapitalGainsYTD', before: 62000, after: 82000, delta: 20000 }],
    }),
  ]);

  const { groups, grandTotal, currency } = await runReport(def, { cc: 'AU', period: WHOLE_SIM }, apis);
  assert.strictEqual(currency, 'AUD');
  assert.strictEqual(grandTotal, 82000, 'the AU capital-gains line, unchanged by the conversion');

  const byType = Object.fromEntries(groups.map(g => [g.key.actionType, g]));
  // The aggregate keeps its NAME (`proceeds`) and is repointed at the derived
  // `proceedsInAUD` row field, so the converted figure arrives under the original key.
  assert.strictEqual(byType.STOCK_WITHDRAWAL_TAX.proceeds, 100000 * RATE,
    'the USD contract amount converts at the run\'s own rate — 100,000 USD is not 100,000 AUD');
  assert.strictEqual(byType.AU_STOCK_WITHDRAWAL_TAX.proceeds, 60000,
    'an AUD row is already in the target currency and must pass through untouched');
  // The drill-down row keeps the native amount it was journaled with.
  assert.strictEqual(byType.STOCK_WITHDRAWAL_TAX.items[0].proceeds, 100000,
    'conversion writes a DERIVED field; the row still shows what the journal recorded');
});

// ─── Per-diff account reports ─────────────────────────────────────────────────

test('cash-flow-by-account: an AU account balance converts at the account currency', async () => {
  const schemaRegistry = new StateSchemaRegistry();
  schemaRegistry.registerAccount('usSavingsAccount', { name: 'US Savings', country: 'US', currency: { code: 'USD' } });
  schemaRegistry.registerAccount('auSavingsAccount', { name: 'AU Savings', country: 'AU', currency: { code: 'AUD' } });

  const def  = new ReportDefinitionRegistry().get('cash-flow-by-account');
  const apis = apisFor([
    auSettle(new Date(Date.UTC(2026, 5, 30)), 1.5),
    entry({
      date: new Date(Date.UTC(2026, 6, 1)), actionType: 'AU_SAVINGS_WITHDRAWAL_APPLY',
      stateDiff: [{ field: 'auSavingsAccount.balance', before: 1000, after: 700, delta: -300 }],
    }),
    entry({
      date: new Date(Date.UTC(2026, 6, 1)), actionType: 'SAVINGS_WITHDRAWAL_APPLY',
      stateDiff: [{ field: 'usSavingsAccount.balance', before: 1000, after: 900, delta: -100 }],
    }),
  ], { schemaRegistry });

  const { groups, grandTotal, currency } = await runReport(
    def, { period: WHOLE_SIM, accountStateKeys: [] }, apis,
  );

  assert.strictEqual(currency, 'USD');
  const byKey = Object.fromEntries(groups.map(g => [g.key.stateKey, g.total]));
  assert.strictEqual(byKey['auSavingsAccount.balance'], -200, 'A$300 out at 1.5 = $200');
  assert.strictEqual(byKey['usSavingsAccount.balance'], -100);
  assert.strictEqual(grandTotal, -300, 'not the raw -400');
});

test('per-diff rows keep their native amount for drill-down', async () => {
  const schemaRegistry = new StateSchemaRegistry();
  schemaRegistry.registerAccount('auSavingsAccount', { name: 'AU Savings', country: 'AU', currency: { code: 'AUD' } });

  const def  = new ReportDefinitionRegistry().get('cash-flow-by-account');
  const apis = apisFor([
    auSettle(new Date(Date.UTC(2026, 5, 30)), 1.5),
    entry({
      date: new Date(Date.UTC(2026, 6, 1)), actionType: 'AU_SAVINGS_WITHDRAWAL_APPLY',
      stateDiff: [{ field: 'auSavingsAccount.balance', before: 1000, after: 700, delta: -300 }],
    }),
  ], { schemaRegistry });

  const { groups } = await runReport(def, { period: WHOLE_SIM, accountStateKeys: [] }, apis);
  const item = groups[0].items[0];

  assert.strictEqual(groups[0].total, -200,          'the fold is in USD');
  assert.strictEqual(item.stateDelta, -300,          'the entry row still reads the journal figure');
  assert.strictEqual(item.stateDeltaInUSD, -200,     'the converted value rides alongside');
});

// ─── The normaliser itself ────────────────────────────────────────────────────

test('normalizeAggregateCurrency leaves non-money aggregates alone', () => {
  const rows = [
    { actionType: 'AU_TAX_PAYMENT_DEBIT', amount: 100, ts: 0, instanceId: 'a' },
    { actionType: 'US_TAX_PAYMENT_DEBIT', amount: 100, ts: 0, instanceId: 'b' },
  ];
  const aggregates = {
    count:   { fn: 'count' },
    actions: { fn: 'distinct', field: 'instanceId' },
    total:   { fn: 'sum', field: 'amount' },
  };
  const out = normalizeAggregateCurrency({
    rows, aggregates, targetCurrency: 'USD',
    typeRegistry: typeRegistry(),
    fx: new JournalFxRates(journalOf([auSettle(new Date(0), 2)])),
  });

  assert.deepStrictEqual(out.aggregates.count,   { fn: 'count' });
  assert.deepStrictEqual(out.aggregates.actions, { fn: 'distinct', field: 'instanceId' });
  assert.deepStrictEqual(out.aggregates.total,   { fn: 'sum', field: 'amountInUSD' });
  assert.strictEqual(out.rows[0].amountInUSD, 50);
  assert.strictEqual(out.rows[1].amountInUSD, 100);
});

test('normalizeAggregateCurrency is a no-op without a target currency', () => {
  const rows       = [{ actionType: 'AU_TAX_PAYMENT_DEBIT', amount: 100, ts: 0 }];
  const aggregates = { total: { fn: 'sum', field: 'amount' } };
  const out = normalizeAggregateCurrency({
    rows, aggregates, targetCurrency: null, typeRegistry: typeRegistry(), fx: null,
  });
  assert.strictEqual(out.rows, rows,             'same array reference — nothing copied');
  assert.strictEqual(out.aggregates, aggregates, 'same spec reference');
});

// ─── End-to-end reconciliation ────────────────────────────────────────────────

/**
 * The acceptance check: on a real cross-border run the blank-cc total must agree
 * with `state.cumulativeTaxesPaid` less the in-fund Div 295 super fund tax.
 *
 * The two are built by completely separate paths — the reducer converts each AU
 * settlement's `tax` as it happens, the report converts each AU cash debit
 * afterwards from the journal — so agreement is a real cross-check rather than a
 * restatement. `fundTax` is subtracted because it is withheld inside the super
 * fund and never produces a cash debit for the report to see (design 77 §5.4).
 */
test('e2e: a cross-border run reconciles with state.cumulativeTaxesPaid', async () => {
  const { sim, services, cfg } = silently(() => loadScenarioSim({ telemetry: 'journal' }));
  silently(() => sim.stepTo(new Date(cfg.simEnd)));

  const apis = createReportApis(sim.journal, services);
  const def  = new ReportDefinitionRegistry().get('tax-paid-by-year');
  const { grandTotal, currency } = await runReport(def, { cc: '', period: WHOLE_SIM }, apis);

  // Div 295, converted at each settle's own recorded rate — one action can be
  // journaled once per reducer, so count each action once.
  let fundTaxUsd = 0;
  const counted = new Set();
  for (const e of sim.journal.journal) {
    if (e.action?.type !== 'AU_TAX_SETTLE_APPLY') continue;
    if (counted.has(e.action.instanceId)) continue;
    counted.add(e.action.instanceId);
    const d = e.action.data ?? {};
    if (d.fundTax) fundTaxUsd += d.fundTax / (d.fxRate ?? 1);
  }

  // Design 95 phase 6 — payroll withholding is IN the total, and this is the check
  // that says so. FICA leaves the paycheque monthly as WAGES_WITHHELD_APPLY and is
  // credited against the liability at settle, so the settle debits only the BALANCE
  // due: a report reading the TAX_PAYMENT_DEBIT family alone understated US federal
  // tax by the whole year's withholding ($528k against $716k here). The report now
  // unions the TAX_WITHHELD family, so it is NOT subtracted from the target — a
  // regression on either side reopens a gap this test measures directly.
  let withheldUsd = 0;
  const seenWh = new Set();
  for (const e of sim.journal.journal) {
    if (e.action?.type !== 'WAGES_WITHHELD_APPLY') continue;
    if (seenWh.has(e.action.instanceId)) continue;
    seenWh.add(e.action.instanceId);
    withheldUsd += e.action.data?.amount ?? 0;
  }

  const target = (sim.state.cumulativeTaxesPaid ?? 0) - fundTaxUsd;

  assert.strictEqual(currency, 'USD');
  assert.ok(target > 0, 'the run must actually pay tax for this to check anything');
  assert.ok(fundTaxUsd > 0, 'and hold AU super, so the fundTax term is exercised');
  assert.ok(withheldUsd > 0, 'and withhold FICA, so the withholding term is exercised');
  assert.ok(withheldUsd / target > 0.1,
    `withholding must be a material share of the total for this to bite, got ${withheldUsd} of ${target}`);
  assert.ok(Math.abs(grandTotal - target) < 0.01,
    `blank-cc total ${grandTotal} vs cumulativeTaxesPaid−fundTax ${target}`);
});
