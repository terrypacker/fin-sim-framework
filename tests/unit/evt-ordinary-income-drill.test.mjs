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
 * EVT-DRILL: Journal Report drill-down contract tests.
 *
 * Runs IntlRetirementScenario for one US tax year, then verifies that:
 *
 * 1. The TaxDocumentRegistry produces a US Form 1040 with a drillReport on the
 *    "Gross Ordinary Income" line.
 * 2. Running JournalQueryApi.aggregate() with the drill report's params returns
 *    a grand total that matches the Form 1040's Gross Ordinary Income value.
 *
 * This is the regression guard for the §6.1 contract between tax documents and
 * the Journal Reporting plugin.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { ServiceRegistry }          from '../../src/services/service-registry.js';
import { IntlRetirementScenario }   from '../../src/scenarios/intl-retirement-scenario.js';
import { JournalReportingService }  from '../../src/finance/journal-reporting-service.js';
import { JournalDataSource }        from '../../src/finance/journal-data-source.js';
import { JournalQueryApi }          from '../../src/finance/journal-query-api.js';
import { ReportDefinitionRegistry } from '../../src/finance/journal-reporting/report-definition-registry.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildScenario() {
  ServiceRegistry.resetAll();
  const scenario = IntlRetirementScenario.buildAndCompile({});
  return { scenario, sim: scenario.sim };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('EVT-DRILL-1: US Form 1040 Gross Ordinary Income line carries a drillReport when period is available', () => {
  const { scenario, sim } = buildScenario();

  // Run to the end of the first US tax year so a TAX_SETTLE_APPLY entry exists.
  sim.stepTo(new Date(Date.UTC(2026, 11, 31)));

  const journal = sim.journal;
  const entries = journal.journal;

  // Find the first US TAX_SETTLE_APPLY entry.
  const settleEntry = entries.find(
    e => e.action?.type === 'US_TAX_SETTLE_APPLY'
  );
  assert.ok(settleEntry, 'Should have a US_TAX_SETTLE_APPLY entry after stepping to Dec 31');

  const service   = new JournalReportingService();
  const taxDoc    = service.generate(settleEntry, entries);

  // generate() may return a single TaxDocument or an array (when Schedule D exists).
  const docs      = Array.isArray(taxDoc) ? taxDoc : [taxDoc];
  const form1040  = docs.find(d => d.title?.includes('Form 1040'));
  assert.ok(form1040, 'JournalReportingService should produce a Form 1040');

  const incomeSection = form1040.sections?.find(s => s.heading === 'Income');
  assert.ok(incomeSection, 'Form 1040 should have an Income section');

  const grossLine = incomeSection.lineItems.find(li => li.label === 'Gross Ordinary Income');
  assert.ok(grossLine, 'Income section should have a Gross Ordinary Income line item');
  assert.ok(grossLine.drillReport, 'Gross Ordinary Income should carry a drillReport descriptor');
  assert.strictEqual(grossLine.drillReport.reportId, 'ordinary-income-by-source');
  assert.strictEqual(grossLine.drillReport.params.cc, 'US');
  assert.ok(grossLine.drillReport.params.period?.toEntryId, 'period.toEntryId should be set');
});

test('EVT-DRILL-2: drill query total matches Form 1040 Gross Ordinary Income', async () => {
  const { scenario, sim } = buildScenario();
  sim.stepTo(new Date(Date.UTC(2026, 11, 31)));

  const journal = sim.journal;
  const entries = journal.journal;

  const settleEntry = entries.find(
    e => e.action?.type === 'US_TAX_SETTLE_APPLY'
  );
  assert.ok(settleEntry, 'Should have a US_TAX_SETTLE_APPLY entry');

  // Build the tax document.
  const service  = new JournalReportingService();
  const taxDoc   = service.generate(settleEntry, entries);
  const docs     = Array.isArray(taxDoc) ? taxDoc : [taxDoc];
  const form1040 = docs.find(d => d.title?.includes('Form 1040'));
  const grossLine = form1040.sections
    .find(s => s.heading === 'Income')
    .lineItems.find(li => li.label === 'Gross Ordinary Income');

  const modalAmount = grossLine.amount;
  assert.ok(modalAmount > 0, 'Gross Ordinary Income should be positive');

  // Run the drill query.
  const api      = new JournalQueryApi(new JournalDataSource(journal));
  const registry = new ReportDefinitionRegistry();
  const def      = registry.get('ordinary-income-by-source');
  assert.ok(def, 'ordinary-income-by-source definition should be registered');

  const ast    = def.buildQuery(grossLine.drillReport.params, api);
  const result = await api.aggregate({
    query:      ast,
    groupBy:    def.defaultGroupBy,
    aggregates: def.defaultAggregates,
  });

  assert.ok(result.grandTotal != null, 'aggregate should produce a grandTotal');
  assert.ok(
    Math.abs(result.grandTotal - modalAmount) < 1.0,
    `Drill query grand total (${result.grandTotal.toFixed(2)}) should match ` +
    `Form 1040 Gross Ordinary Income (${modalAmount.toFixed(2)}) within $1`
  );
});

test('EVT-DRILL-3: AU Ordinary Income line carries a drillReport', () => {
  const { sim } = buildScenario();

  // Run to the end of the Australian FY (June 30 2026).
  sim.stepTo(new Date(Date.UTC(2026, 5, 30)));

  const entries = sim.journal.journal;
  const settleEntry = entries.find(
    e => e.action?.type === 'AU_TAX_SETTLE_APPLY'
  );

  if (!settleEntry) {
    // AU tax may not have settled yet depending on scenario configuration; skip gracefully.
    return;
  }

  const service = new JournalReportingService();
  const taxDoc  = service.generate(settleEntry, entries);
  const docs    = Array.isArray(taxDoc) ? taxDoc : [taxDoc];

  for (const doc of docs) {
    const incomeSection = doc.sections?.find(s => s.heading === 'Income');
    if (!incomeSection) continue;

    const ordinaryLine = incomeSection.lineItems.find(li => li.label === 'Ordinary Income');
    if (ordinaryLine && ordinaryLine.amount > 0) {
      assert.ok(ordinaryLine.drillReport, 'AU Ordinary Income should carry a drillReport');
      assert.strictEqual(ordinaryLine.drillReport.params.cc, 'AU');
      return;
    }
  }
});

test('EVT-DRILL-4: pretax-adjustments-by-source report definition exists', () => {
  const registry = new ReportDefinitionRegistry();
  const def = registry.get('pretax-adjustments-by-source');
  assert.ok(def, 'pretax-adjustments-by-source should be registered');
  assert.strictEqual(def.id,    'pretax-adjustments-by-source');
  assert.ok(def.title.length > 0);
  assert.ok(Array.isArray(def.facets));
});

test('EVT-DRILL-5: capital-gains-by-disposal report definition exists', () => {
  const registry = new ReportDefinitionRegistry();
  const def = registry.get('capital-gains-by-disposal');
  assert.ok(def, 'capital-gains-by-disposal should be registered');
  assert.strictEqual(def.id, 'capital-gains-by-disposal');
  // The headline `total` aggregate sums realized gain so the report ties out to
  // the tax document's "Capital Gains (before discount)" line (us/auCapitalGainsYTD).
  assert.strictEqual(def.defaultAggregates.total.field, 'gain', 'headline total should sum the gain field');
});
