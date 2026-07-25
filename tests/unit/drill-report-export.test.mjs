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
 * drill-report-export.test.mjs — multi-year drill-report export.
 *
 * Covers the two paths the exporter takes (period-loop for period-faceted
 * reports, single whole-simulation pass for year-grouped ones), the `taxYear`
 * column both must produce, and the CSV projection shared with the workbench
 * download button.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { Journal, JournalEntry }    from '../../src/simulation-framework/journal.js';
import { TypeRegistry }             from '../../src/simulation-framework/type-registry.js';
import { ReportDefinitionRegistry } from '../../src/finance/journal-reporting/report-definition-registry.js';
import { exportDrillReports }       from '../../src/finance/journal-reporting/drill-report-export.js';
import { buildReportRows, rowsToCsv } from '../../src/finance/journal-reporting/report-csv.js';
import { createReportApis, runReport } from '../../src/finance/journal-reporting/run-report.js';

import { US_BANKING }    from '../../src/scenarios/toolsets/us-banking-toolset.js';
import { US_INCOME }     from '../../src/scenarios/toolsets/us-income-toolset.js';
import { US_TAX }        from '../../src/scenarios/toolsets/us-tax-toolset.js';
import { AU_BANKING }    from '../../src/scenarios/toolsets/au-banking-toolset.js';
import { AU_TAX }        from '../../src/scenarios/toolsets/au-tax-toolset.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const _typeRegistry = new TypeRegistry();
for (const t of [US_BANKING, US_INCOME, US_TAX, AU_BANKING, AU_TAX]) _typeRegistry.registerToolset(t);

let _seq = 0;

function entry({ id, date, actionType, data, stateDiff } = {}) {
  const n = _seq++;
  return new JournalEntry({
    id:          id ?? `e-${n}`,
    seq:         n,
    date:        date ?? new Date(Date.UTC(2026, 5, 15)),
    executionId: 'e1.1',
    event:  { nodeId: null, type: 'EVT', name: 'Evt', color: null },
    action: {
      instanceId: `i-${n}`, parentId: null, rootId: null, siblingIndex: 0,
      nodeId: null, type: actionType, name: actionType, data: data ?? {},
    },
    reducer:            { nodeId: null, name: 'R' },
    stateDiff:          stateDiff ?? [],
    emittedInstanceIds: [],
    emittedTypes:       [],
  });
}

const income = (date, amount) => entry({
  date,
  actionType: 'US_SAVINGS_INTEREST_TAX',
  data:       { amount, cc: 'US' },
  stateDiff:  [{ field: 'usOrdinaryIncomeYTD', before: 0, after: amount, delta: amount }],
});

const usSettle = (date, id) => entry({
  id, date, actionType: 'US_TAX_SETTLE_APPLY', data: { cc: 'US' },
});

const taxPaid = (date, amount) => entry({
  date, actionType: 'US_TAX_PAYMENT_DEBIT', data: { amount, cc: 'US' },
  stateDiff: [{ field: 'usSavingsAccount.balance', before: 1000, after: 1000 - amount, delta: -amount }],
});

/**
 * Two settled US calendar years with income and a tax payment in each. The
 * income amounts differ per year so a report that leaks entries across the
 * period boundary shows up as a wrong total rather than a wrong row count.
 */
function buildJournal() {
  _seq = 0;
  const j = new Journal({ enabled: true });
  for (const e of [
    income(new Date(Date.UTC(2026, 2, 1)), 100),
    income(new Date(Date.UTC(2026, 8, 1)), 200),
    taxPaid(new Date(Date.UTC(2026, 11, 31)), 90),
    usSettle(new Date(Date.UTC(2026, 11, 31)), 'settle-2026'),
    income(new Date(Date.UTC(2027, 2, 1)), 400),
    taxPaid(new Date(Date.UTC(2027, 11, 31)), 120),
    usSettle(new Date(Date.UTC(2027, 11, 31)), 'settle-2027'),
  ]) j.addEntry(e);
  return j;
}

// A minimal schema registry: enough for the per-account reports to scope
// themselves exactly (design 70) and to attach a display name to their groups.
const services = {
  typeRegistry:  _typeRegistry,
  periodService: null,
  schemaRegistry: {
    accountBalanceKeys: () => ['usSavingsAccount.balance'],
    displayNameFor:     key => (key === 'usSavingsAccount' ? 'US Savings' : null),
  },
};

function exportOne(id, opts = {}) {
  return exportDrillReports({
    journal:   buildJournal(),
    registry:  new ReportDefinitionRegistry(),
    services,
    reportIds: [id],
    ccs:       ['US'],
    ...opts,
  });
}

const parseCsv = csv => {
  const [head, ...lines] = csv.split('\n');
  const cols = head.split(',');
  return lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
};

// ─── Period-loop path ─────────────────────────────────────────────────────────

test('period-faceted report stacks every settled year into one document', async () => {
  const [report] = await exportOne('ordinary-income-by-source');

  assert.strictEqual(report.mode, 'per-period');
  assert.strictEqual(report.years, '2026–2027');

  const rows = parseCsv(report.csv);
  assert.deepStrictEqual(rows.map(r => r.taxYear), ['2026', '2027']);
  // Each period sees only its own income: 100+200 in CY 2026, 400 in CY 2027.
  assert.deepStrictEqual(rows.map(r => Number(r.total)), [300, 400]);
  assert.deepStrictEqual(rows.map(r => r.periodLabel), ['US CY 2026', 'US CY 2027']);
  assert.deepStrictEqual(rows.map(r => r.cc), ['US', 'US']);
});

test('taxYear leads every row so the file pivots by year', async () => {
  const [report] = await exportOne('ordinary-income-by-source');
  assert.strictEqual(report.csv.split('\n')[0].split(',')[0], 'taxYear');
});

// ─── Year-grouped path ────────────────────────────────────────────────────────

test('year-grouped report runs once over the whole simulation, promoting year to taxYear', async () => {
  const [report] = await exportOne('tax-paid-by-year');

  assert.strictEqual(report.mode, 'year-grouped');
  const rows = parseCsv(report.csv);
  assert.deepStrictEqual(rows.map(r => r.taxYear), ['2026', '2027']);
  assert.deepStrictEqual(rows.map(r => Number(r.total)), [90, 120]);
  // The report's own `year` key is renamed, never duplicated alongside taxYear.
  assert.ok(!report.csv.split('\n')[0].split(',').includes('year'));
});

test('cc facet is intersected with the requested countries', async () => {
  const [both] = await exportOne('tax-paid-by-year', { ccs: ['US', 'AU'] });
  const [us]   = await exportOne('tax-paid-by-year', { ccs: ['US'] });
  assert.strictEqual(both.cc, 'US|AU');
  assert.strictEqual(us.cc,   'US');
});

// ─── AU fiscal-year convention ────────────────────────────────────────────────

const auSettle = (date, id) => entry({
  id, date, actionType: 'AU_TAX_SETTLE_APPLY',
  data: {
    cc: 'AU',
    personTaxDetails: [{ personKey: 'primary', personName: 'Primary', taxDetail: { netLiability: 500 } }],
  },
});

const auIncome = (date, amount) => entry({
  date, actionType: 'AU_SAVINGS_EARNINGS_TAX', data: { amount, cc: 'AU' },
  stateDiff: [{ field: 'auOrdinaryIncomeYTD', before: 0, after: amount, delta: amount }],
});

/** Two AU fiscal years, each settled on 30 June. */
function buildAuJournal() {
  _seq = 0;
  const j = new Journal({ enabled: true });
  for (const e of [
    auIncome(new Date(Date.UTC(2025, 9, 1)), 700),   // Oct 2025 — inside FY2025-26
    auSettle(new Date(Date.UTC(2026, 5, 30)), 'au-settle-1'),
    auIncome(new Date(Date.UTC(2026, 9, 1)), 800),   // Oct 2026 — inside FY2026-27
    auSettle(new Date(Date.UTC(2027, 5, 30)), 'au-settle-2'),
  ]) j.addEntry(e);
  return j;
}

test('AU taxYear is the fiscal-year START year, matching the worksheet CSV', async () => {
  const [report] = await exportDrillReports({
    journal:   buildAuJournal(),
    registry:  new ReportDefinitionRegistry(),
    services,
    reportIds: ['ordinary-income-by-source'],
    ccs:       ['AU'],
  });

  const rows = parseCsv(report.csv);
  // A 30 June 2026 settle closes FY2025-26, which the AU return is filed under
  // as 2025 — not 2026, the year the label ends in.
  assert.deepStrictEqual(rows.map(r => r.taxYear),     ['2025', '2026']);
  assert.deepStrictEqual(rows.map(r => r.periodLabel), ['AU FY 2025–26', 'AU FY 2026–27']);
  assert.deepStrictEqual(rows.map(r => Number(r.total)), [700, 800]);
});

test('a report with an implicit AU year (au-tax-by-person-year) is restated too', async () => {
  const registry = new ReportDefinitionRegistry();
  assert.strictEqual(registry.get('au-tax-by-person-year').yearCc, 'AU',
    'the report has no cc facet, so it must declare its year basis');

  const [report] = await exportDrillReports({
    journal: buildAuJournal(), registry, services, reportIds: ['au-tax-by-person-year'], ccs: ['AU'],
  });
  assert.deepStrictEqual(parseCsv(report.csv).map(r => r.taxYear), ['2025', '2026']);
});

// ─── Report selection + empty reports ─────────────────────────────────────────

test('all registered reports export, and empty ones report zero rows rather than failing', async () => {
  const registry = new ReportDefinitionRegistry();
  const reports  = await exportDrillReports({
    journal: buildJournal(), registry, services, ccs: ['US', 'AU'],
  });

  assert.strictEqual(reports.length, registry.getAll().length);
  const byId = Object.fromEntries(reports.map(r => [r.id, r]));
  assert.ok(byId['ordinary-income-by-source'].rowCount > 0);
  // Nothing in the fixture feeds Roth conversions — an empty result, not an error.
  assert.strictEqual(byId['roth-conversions-by-year'].rowCount, 0);
  assert.strictEqual(byId['roth-conversions-by-year'].csv, '');
});

// ─── Row granularity ──────────────────────────────────────────────────────────

test('entries detail emits one row per contributing journal entry', async () => {
  const [groups]  = await exportOne('ordinary-income-by-source');
  const [entries] = await exportOne('ordinary-income-by-source', { detail: 'entries' });

  assert.strictEqual(groups.rowCount, 2,  'one row per group per year');
  assert.strictEqual(entries.rowCount, 3, 'one row per income entry');

  const rows = parseCsv(entries.csv);
  assert.deepStrictEqual(rows.map(r => r.date), ['2026-03-01', '2026-09-01', '2027-03-01']);
  assert.deepStrictEqual(rows.map(r => r.taxYear), ['2026', '2026', '2027']);
});

// ─── CSV projection ───────────────────────────────────────────────────────────

test('group rows carry the definition\'s declared aggregates', async () => {
  const registry = new ReportDefinitionRegistry();
  const def      = registry.get('cash-flow-by-account');
  const apis     = createReportApis(buildJournal(), services);
  const { groups } = await runReport(def, { period: null }, apis);

  const [row] = buildReportRows(groups, def, { detail: 'groups' });
  // The group key, the name decorate() attached, then the four aggregates
  // cash-flow-by-account declares.
  assert.deepStrictEqual(Object.keys(row),
    ['stateKey', 'stateKeyName', 'total', 'count', 'min', 'max']);
  assert.strictEqual(row.stateKey,     'usSavingsAccount.balance');
  assert.strictEqual(row.stateKeyName, 'US Savings');
  assert.strictEqual(row.total,        -210, 'both tax payments debited');
});

test('rowsToCsv quotes separators and unions columns across ragged rows', () => {
  const csv = rowsToCsv([
    { a: 'plain', b: 1 },
    { a: 'has,comma', c: 'say "hi"' },
  ]);
  assert.deepStrictEqual(csv.split('\n'), [
    'a,b,c',
    'plain,1,',
    '"has,comma",,"say ""hi"""',
  ]);
});

// ─── taxYearLabel ─────────────────────────────────────────────────────────────

test('taxYearLabel spells the AU fiscal year out, beside the numeric join key', async () => {
  // The bare AU integer is the trap this column exists to close: `2025` on a row
  // covering July 2025 – June 2026 reads as calendar 2025 and is off by half a
  // year. taxYear STAYS numeric so the file still pivots and still joins to the
  // worksheet CSV.
  const [report] = await exportDrillReports({
    journal:   buildAuJournal(),
    registry:  new ReportDefinitionRegistry(),
    services,
    reportIds: ['ordinary-income-by-source'],
    ccs:       ['AU'],
  });

  const rows = parseCsv(report.csv);
  assert.deepStrictEqual(rows.map(r => r.taxYear),      ['2025', '2026']);
  assert.deepStrictEqual(rows.map(r => r.taxYearLabel), ['FY 2025–26', 'FY 2026–27']);
});

test('US rows label the calendar year, on both export paths', async () => {
  const [perPeriod]   = await exportOne('ordinary-income-by-source');
  const [yearGrouped] = await exportOne('tax-paid-by-year');

  assert.deepStrictEqual(parseCsv(perPeriod.csv).map(r => r.taxYearLabel),   ['CY 2026', 'CY 2027']);
  assert.deepStrictEqual(parseCsv(yearGrouped.csv).map(r => r.taxYearLabel), ['CY 2026', 'CY 2027']);
});

test('the year-grouped AU path restates the label too, not just the integer', async () => {
  // au-tax-by-person-year has no cc facet and declares yearCc: 'AU'; the label has
  // to follow the same `yearCc` basis the integer restatement uses, or the two
  // columns on the same row would disagree.
  const [report] = await exportDrillReports({
    journal:   buildAuJournal(),
    registry:  new ReportDefinitionRegistry(),
    services,
    reportIds: ['au-tax-by-person-year'],
    ccs:       ['AU'],
  });
  const rows = parseCsv(report.csv);
  assert.deepStrictEqual(rows.map(r => r.taxYear),      ['2025', '2026']);
  assert.deepStrictEqual(rows.map(r => r.taxYearLabel), ['FY 2025–26', 'FY 2026–27']);
});
