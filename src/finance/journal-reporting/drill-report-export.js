/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Multi-year drill-report export (design 71 Phase 4 follow-on).
 *
 * The workbench panel scopes a report to ONE period at a time, so its download
 * button can only ever produce a single year. For validation you want the whole
 * run in one file, so this module stacks the years itself and stamps a `taxYear`
 * column on every row. One file per report, all years inside it.
 *
 * Two shapes of report, one output contract:
 *   - Reports that already group by `year` (tax-paid-by-year and friends) run
 *     ONCE over the whole simulation; their year key becomes `taxYear`.
 *   - Every other report is run once per settled period, with the period's tax
 *     year stamped on its rows. Facets other than cc/period are left unset,
 *     which each definition reads as "All".
 *
 * `taxYear` follows the convention each return is filed under: the calendar year
 * for US, the fiscal-year START year for AU (`2025` = FY2025-26). That matches
 * the tax-worksheet CSV, so a drill file and the worksheet can be joined on
 * (taxYear, cc) without an off-by-one.
 *
 * Period buckets come from a country's settle entries, so they never overlap.
 * A report with a `cc` facet is run once per requested country against that
 * country's own tax years; a report without one (the per-account reports) uses
 * the first requested country's tax years as its bucket basis, since US calendar
 * years and AU fiscal years would otherwise double-count the same entries.
 */

import { createReportApis, runReport } from './run-report.js';
import { buildReportRows, rowsToCsv }  from './report-csv.js';

/**
 * Export a set of reports as multi-year CSV documents.
 *
 * @param {object}   opts
 * @param {import('../../simulation-framework/journal.js').Journal} opts.journal
 * @param {import('./report-definition-registry.js').ReportDefinitionRegistry} opts.registry
 * @param {object}   [opts.services]        - ServiceRegistry (typeRegistry/periodService/schemaRegistry)
 * @param {string[]} [opts.reportIds]       - default: every registered report
 * @param {string[]} [opts.ccs=['US','AU']] - countries to run cc-faceted reports for
 * @param {'groups'|'entries'} [opts.detail='groups']
 * @returns {Promise<Array<{id,title,mode,cc,years,rowCount,csv}>>} one entry per report
 */
export async function exportDrillReports({
  journal, registry, services = null, reportIds = null, ccs = ['US', 'AU'], detail = 'groups',
}) {
  const apis = createReportApis(journal, services);
  if (!apis) return [];

  const defs = (reportIds ?? registry.getAll().map(d => d.id))
    .map(id => registry.get(id))
    .filter(Boolean);

  const out = [];
  for (const def of defs) {
    const result = _isYearGrouped(def)
      ? await _runWholeSimulation(def, apis, ccs, detail)
      : await _runPerPeriod(def, apis, ccs, detail);

    out.push({
      id:       def.id,
      title:    def.title,
      mode:     result.mode,
      cc:       result.ccs.join('|'),
      years:    _yearSpan(result.rows),
      rowCount: result.rows.length,
      csv:      rowsToCsv(result.rows),
    });
  }
  return out;
}

/** Reports that already bucket by year need no period loop — one pass covers the run. */
function _isYearGrouped(def) {
  return (def.defaultGroupBy ?? []).includes('year');
}

const WHOLE_SIMULATION = { fromEntryId: null, toEntryId: null };

/**
 * Single whole-simulation pass for a year-grouped report. The report's own
 * `year` key is promoted to `taxYear` so every exported file leads with the same
 * column regardless of which path produced it.
 */
async function _runWholeSimulation(def, apis, requestedCcs, detail) {
  const ccOptions = _ccFacetOptions(def);
  const ccs       = ccOptions.length ? ccOptions.filter(c => requestedCcs.includes(c)) : [null];
  const rows      = [];

  for (const cc of ccs) {
    const params = { period: WHOLE_SIMULATION, ...(cc ? { cc } : {}) };
    const { groups } = await runReport(def, params, apis);
    // The period rollup keys an AU fiscal year by its END year; the AU return —
    // and so the worksheet CSV these files are cross-referenced against — is
    // filed under the START year. Restate it so the two artifacts agree.
    const auYears = (cc ?? def.yearCc) === 'AU';
    for (const row of buildReportRows(groups, def, { detail })) {
      const { year, ...rest } = row;
      const taxYear = year == null ? null : (auYears ? year - 1 : year);
      rows.push({ taxYear, ...(cc ? { cc } : {}), ...rest });
    }
  }
  return { mode: 'year-grouped', ccs: ccs.map(c => c ?? '—'), rows };
}

/**
 * One run per settled period, stacked. `periodLabel` carries the period's own
 * name (`US CY 2026` / `AU FY 2025–26`) so the bucket basis stays visible even
 * for reports that have no cc of their own.
 */
async function _runPerPeriod(def, apis, ccs, detail) {
  const ccOptions  = _ccFacetOptions(def);
  // Without a cc facet the report still needs a bucket basis; the first
  // requested country supplies it (see the module header).
  const runCcs     = ccOptions.length ? ccOptions.filter(c => ccs.includes(c)) : ccs.slice(0, 1);
  const hasCcFacet = ccOptions.length > 0;
  const rows       = [];

  for (const cc of runCcs) {
    // Chronological — listSettledPeriods returns most-recent-first for the UI.
    const periods = [...apis.entry.listSettledPeriods(cc)].reverse();
    for (const p of periods) {
      const params = {
        period: { fromEntryId: p.fromEntryId, toEntryId: p.toEntryId },
        ...(hasCcFacet ? { cc } : {}),
      };
      const { groups } = await runReport(def, params, apis);
      const lead = { taxYear: _taxYearOf(cc, p.toEntryDate), periodLabel: p.label, cc };
      rows.push(...buildReportRows(groups, def, { detail, lead }));
    }
  }
  return { mode: 'per-period', ccs: runCcs, rows };
}

/** The `cc` select facet's options, or [] when the report has no cc facet. */
function _ccFacetOptions(def) {
  const facet = (def.facets ?? []).find(f => f.name === 'cc' && f.kind === 'select');
  return (facet?.options ?? []).filter(Boolean);
}

/**
 * The tax year a settle date belongs to, in the convention the tax documents
 * file under: the calendar year for US, and for AU the START year of the
 * July-anchored fiscal year (a 30 June 2026 settle is taxYear 2025 — FY2025-26).
 * That is the same number the worksheet CSV's `taxYear` carries, so the two
 * exports line up row for row.
 */
function _taxYearOf(cc, date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  if (cc === 'AU') return d.getUTCMonth() >= 6 ? y : y - 1;
  return y;
}

function _yearSpan(rows) {
  const years = rows.map(r => r.taxYear).filter(y => y != null).sort((a, b) => a - b);
  if (!years.length) return '';
  return years[0] === years[years.length - 1]
    ? String(years[0])
    : `${years[0]}–${years[years.length - 1]}`;
}
