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
 * tax-worksheet-export — flatten a run's tax documents into worksheet rows / CSV
 * (design 71 §4–§5).
 *
 * The export is a **projection, never a recomputation**: it walks the journal's
 * `<cc>_TAX_SETTLE_APPLY` entries and renders each through the very same
 * `JournalReportingService` the tax-document popup uses. If the CSV and the popup
 * ever disagree, that is a bug — a validation instrument that recomputed its own
 * subject would validate nothing (§2.1).
 *
 * The flattener is deliberately **country-agnostic**. It knows about the generic
 * TaxDocument shape (`sections[].lineItems[]` + `summary`) and about two optional
 * per-line fields the country document modules attach:
 *
 *   `bands` — Array<{ lower, upper, rate, income, tax }>, a marginal-bracket schedule
 *   `flat`  — { rate, income, tax, ... }, a flat-rate tax stated on the line itself
 *
 * Nothing here is US-specific, so the AU worksheet (§8) lands by attaching the same
 * two fields in the AU document module — no change to this file.
 *
 * Pure and DOM-free: usable from the headless export script and from the browser.
 */

import { JournalReportingService } from '../journal-reporting-service.js';
import { primaryTaxSettleEntries, settleActionTypeFor } from './tax-settle-entries.js';
import { taxYearLabel } from './tax-year-label.js';

/** Native currency of a filing, by country (design 71 §5.3 — never display currency). */
const COUNTRY_TO_CURRENCY = { US: 'USD', AU: 'AUD' };

/**
 * CSV column order — the format contract (design 71 §5.1). Columns 1–15 are the
 * shape validated against `scenarios/example-tax-report.csv`; `personKey` and
 * `currency` are APPENDED so a spreadsheet built on the 15-column export keeps
 * working. Never insert into the middle of this list.
 *
 * Three more are appended for the same reason (§5.5):
 *
 *   `taxYearLabel` — `taxYear` spelled the way the return files it: `CY 2032`,
 *                    or `FY 2025–26` for AU. `taxYear` itself STAYS the integer
 *                    (2025 = FY2025-26): it is the join key against the
 *                    drill-report CSVs, what `--year` filters on, and the only
 *                    form a spreadsheet can sort or pivot numerically. The
 *                    label is what stops a reader taking an AU `2025` for the
 *                    calendar year — it is off by half a year.
 *   `fxPair`/`fxRate` — the USD/AUD rate in force at the settlement, quoted as
 *                    AUD per USD. Every cross-border figure on the return was
 *                    normalized through it and is otherwise unreproducible from
 *                    the export alone. See `taxFxRate` for its exact meaning:
 *                    it is the settle-date rate, not a weighted average of the
 *                    rates the individual lines accrued at.
 */
export const WORKSHEET_COLUMNS = [
  'taxYear', 'country', 'form', 'section', 'line', 'label', 'rowType', 'amount',
  'bracketRate', 'bracketLower', 'bracketUpper', 'bracketIncome', 'bracketTax',
  'parentLine', 'drillReport', 'personKey', 'currency',
  'taxYearLabel', 'fxPair', 'fxRate',
];

/**
 * Walk the journal's tax settlements and flatten every tax document to worksheet rows.
 *
 * Rows carry **raw numbers**, not formatted strings, so programmatic consumers get
 * full precision; `toCsv` is what applies display rounding (§4.2).
 *
 * @param {object[]} journal                   full journal entry array
 * @param {object}   [opts]
 * @param {'US'|'AU'|Array<'US'|'AU'>} [opts.cc='US']  country/countries to export
 * @param {number[]|null} [opts.years=null]    restrict to these tax years (null = all)
 * @param {boolean}  [opts.includeSchedules=false]  also emit supplementary forms
 *                                             (Schedule D); see §4 note on table-shaped forms
 * @param {object}   [opts.service]            JournalReportingService override (tests)
 * @returns {object[]} worksheet rows, in document order, oldest year first
 */
export function buildTaxWorksheetRows(journal, opts = {}) {
  const {
    cc = 'US',
    years = null,
    includeSchedules = false,
    service = new JournalReportingService(),
  } = opts;

  const countries  = Array.isArray(cc) ? cc : [cc];
  const types      = countries.map(settleActionTypeFor);
  const yearFilter = years ? new Set(years) : null;
  const entries    = journal ?? [];

  // Collapse the action×reducer fan-out to one entry per settlement — the shared rule
  // the timeline's "Tax Doc ↗" button uses too. See tax-settle-entries.js for why the
  // FIRST entry is the canonical one (it is the one with intact drill-down periods).
  const primary = primaryTaxSettleEntries(entries, { types });

  const rows = [];
  for (const entry of entries) {
    if (!primary.has(entry)) continue;

    const generated = service.generate(entry, entries);
    if (!generated) continue;

    // A settle yields one document, or several: supplementary US forms
    // (Schedule D / 8949) and AU's one-document-per-person filings (§8.2).
    for (const doc of (Array.isArray(generated) ? generated : [generated])) {
      if (!doc) continue;
      if (yearFilter && !yearFilter.has(doc.taxYear)) continue;
      if (!isPrimaryForm(doc) && !includeSchedules) continue;
      rows.push(...flattenDocument(doc));
    }
  }
  return rows;
}

/**
 * Flatten TaxDocuments that a caller already has in hand — the tax-document modal's
 * CSV button, which exports exactly what is on screen (design 71 §11.1).
 *
 * Same rows and same column contract as the journal-driven path; it simply starts
 * from documents instead of from a journal. Table-shaped documents contribute no
 * rows (§5.4), so a caller can check for an empty result to decide whether an export
 * is meaningful.
 *
 * @param {object|object[]} docOrDocs
 * @returns {object[]} worksheet rows
 */
export function worksheetRowsFromDocuments(docOrDocs) {
  const docs = Array.isArray(docOrDocs) ? docOrDocs : [docOrDocs];
  return docs.flatMap(doc => (doc ? flattenDocument(doc) : []));
}

/**
 * True for the return itself (Form 1040 / AU ITR), false for a supplementary form.
 * Primary forms are the ones whose lines foot to a liability; the rest are detail
 * schedules gated behind `includeSchedules`.
 */
function isPrimaryForm(doc) {
  return Array.isArray(doc.sections) && doc.sections.length > 0 && !doc.table;
}

/**
 * Flatten one TaxDocument to worksheet rows.
 *
 * `line` is a positional index within THIS document, 1..N over sections in order
 * (§4.1) — not a statutory IRS/ATO line number, which the document modules do not
 * carry. `parentLine` is therefore scoped to (taxYear, form, personKey).
 *
 * Table-shaped documents (Form 8949, AU CGT Schedule) are **skipped**: they are
 * disposal registers whose columns (proceeds / cost basis / dates) have no home in
 * the §5.1 column set, and forcing them in would mean overloading `bracketIncome`
 * and `bracketTax` with unrelated meanings. They need their own export shape.
 */
function flattenDocument(doc) {
  if (doc.table && !doc.sections) return [];

  const base = {
    taxYear:   doc.taxYear,
    country:   doc.country,
    form:      formNameOf(doc),
    personKey: doc.personKey ?? null,
    currency:  COUNTRY_TO_CURRENCY[doc.country] ?? doc.currency ?? null,
    // Repeated on every row rather than stated once: a worksheet is read through
    // a pivot table, where a header-only value would be filtered away.
    taxYearLabel: taxYearLabel(doc.country, doc.taxYear),
    // Absent in a single-country run (no rate was ever recorded) and on
    // settlements predating the field — blank cells, never a fabricated 1.0.
    fxPair:       doc.fxRate != null ? (doc.fxPair ?? null) : null,
    fxRate:       doc.fxRate ?? null,
  };

  const rows = [];
  let line = 0;

  for (const section of doc.sections ?? []) {
    for (const li of section.lineItems ?? []) {
      line += 1;
      rows.push({
        ...base,
        section:     section.heading,
        line,
        label:       li.label,
        // A document module marks a breakdown row with `sub: true` (the SECA
        // SS/Medicare split; AU's ordinary-vs-CGT split of "Tax on Income"). Those
        // rows are components of the line ABOVE them, so summing them alongside it
        // double-counts. `SUBLINE` keeps them in the worksheet while excluding them
        // from any `rowType = 'LINE'` footing check (§5.2).
        //
        // `memo: true` marks a DISCLOSURE row: an amount the return states but does
        // not assess. The only one today is the AU Div 295 superannuation fund tax
        // (design 77 §5.3) — real tax, paid by the fund out of fund assets, never a
        // liability of the member filing this return. It sits below Net Tax
        // Liability and must stay out of every footing sum, so it gets its own
        // rowType rather than `LINE`.
        //
        // A line may also declare its own `rowType` outright — the foreign-relief
        // worksheet (§13) emits `WORKSHEET` and `RATE` rows, which are supporting
        // intermediates rather than lines of the return and must never be summed
        // into it.
        rowType:     li.rowType ?? (li.memo ? 'MEMO' : li.sub ? 'SUBLINE' : 'LINE'),
        amount:      li.amount ?? null,
        // A flat-rate tax states its rate and base on the line itself rather than
        // breaking out a one-band schedule (§5.2).
        bracketRate:   li.flat?.rate   ?? null,
        bracketLower:  null,
        bracketUpper:  null,
        bracketIncome: li.flat?.income ?? null,
        bracketTax:    li.flat?.tax    ?? null,
        parentLine:  null,
        drillReport: li.drillReport?.reportId ?? null,
      });

      for (const band of li.bands ?? []) {
        rows.push({
          ...base,
          section:       section.heading,
          line,
          label:         li.label,
          rowType:       'BRACKET',
          amount:        null,
          bracketRate:   band.rate,
          bracketLower:  band.lower,
          // null on the open-ended top band — rendered as an empty cell (§5.1).
          bracketUpper:  band.upper ?? null,
          bracketIncome: band.income,
          bracketTax:    band.tax,
          parentLine:    line,
          drillReport:   null,
        });
      }
    }
  }

  rows.push(...summaryRows(doc, base, line));
  return rows;
}

/**
 * The Summary block: the liability the return arrives at, plus the two rates.
 *
 * Rates are `RATE` rows carrying a ratio in `amount`, so anything summing the
 * `amount` column MUST filter on `rowType = 'LINE'`. That is deliberate (§5.2):
 * the rates belong with the worksheet but must never be mistaken for money.
 */
function summaryRows(doc, base, lastLine) {
  const s = doc.summary;
  if (!s) return [];

  let line = lastLine;
  const row = (label, rowType, amount) => ({
    ...base,
    section: 'Summary',
    line: (line += 1),
    label,
    rowType,
    amount,
    bracketRate: null, bracketLower: null, bracketUpper: null,
    bracketIncome: null, bracketTax: null,
    parentLine: null, drillReport: null,
  });

  const rows = [row('Net Tax Liability', 'LINE', s.netLiability ?? null)];
  if (s.effectiveRate != null) rows.push(row('Effective Rate', 'RATE', s.effectiveRate));
  if (s.marginalRate  != null) rows.push(row('Marginal Rate',  'RATE', s.marginalRate));
  return rows;
}

/**
 * Form name from a document title: `"Form 1040 — 2025"` → `"Form 1040"`.
 * Titles are `<name> — <year label>` by convention across every document module;
 * a title without the separator is used whole.
 */
function formNameOf(doc) {
  const title = doc.title ?? '';
  const idx   = title.indexOf('—');
  return (idx > 0 ? title.slice(0, idx) : title).trim();
}

// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Money comparison tolerance. The CSV displays 2 dp, so a discrepancy smaller than
 * a cent is invisible to the reader and not actionable.
 */
const CENT = 0.005;

/**
 * Check the footing invariants the CSV format exists to make checkable (§6):
 *
 *   1. Every bracket schedule sums to the line it explains.
 *   2. The ordinary schedule's bands span exactly the taxable ordinary income.
 *   3. The listed tax lines sum to Gross Tax, and Gross Tax + credits = net liability.
 *
 * Deliberately run over the exported ROWS, not over the engine: this validates the
 * artifact the user will actually read, so it catches flattening bugs (a mis-parented
 * band, a dropped line) as well as engine ones. `SUBLINE` rows are components of the
 * line above them and are excluded from every sum — see §5.2.
 *
 * @param {object[]} rows  output of buildTaxWorksheetRows
 * @returns {{ failures: string[], reconciled: number, years: number }}
 */
export function verifyWorksheetRows(rows) {
  const failures = [];
  const lines = (rows ?? []).filter(r => r.rowType === 'LINE');
  const bands = (rows ?? []).filter(r => r.rowType === 'BRACKET');
  // A schedule can hang off a SUBLINE as well as a LINE: the AU return splits "Tax on
  // Income" into ordinary and capital-gains sub-rows and attaches a band set to each
  // (§8.4). Those bands must be reconciled too, or the AU capital-gains differential —
  // the least obvious number on the return — would go unchecked.
  const banded = (rows ?? []).filter(r => r.rowType === 'LINE' || r.rowType === 'SUBLINE');

  // 1. Bracket schedules reconcile to their line.
  let reconciled = 0;
  for (const line of banded) {
    const own = bands.filter(b => keyOf(b) === keyOf(line) && b.parentLine === line.line);
    if (!own.length) continue;
    const sum = own.reduce((s, b) => s + b.bracketTax, 0);
    if (Math.abs(sum - line.amount) > CENT) {
      failures.push(`${keyOf(line)} "${line.label}": Σ bracketTax ${sum.toFixed(2)} != line ${line.amount.toFixed(2)}`);
    }
    reconciled += 1;
  }

  for (const key of [...new Set(lines.map(keyOf))]) {
    const group = lines.filter(r => keyOf(r) === key);
    const at = label => group.find(r => r.label === label);

    // 2. The ordinary bands span the taxable income they are applied to.
    const taxLine = at('Tax on Ordinary Income');
    const taxable = at('Taxable Ordinary Income');
    if (taxLine && taxable) {
      const own = bands.filter(b => keyOf(b) === key && b.parentLine === taxLine.line);
      const spanned = own.reduce((s, b) => s + b.bracketIncome, 0);
      if (own.length && Math.abs(spanned - taxable.amount) > CENT) {
        failures.push(`${key}: bands span ${spanned.toFixed(2)} but taxable income is ${taxable.amount.toFixed(2)}`);
      }
    }

    // 3a. Components sum to the stated Gross Tax.
    const gross = at('Gross Tax');
    if (gross) {
      const components = group
        .filter(r => r.section === 'Tax Computation' && r.label !== 'Gross Tax')
        .reduce((s, r) => s + (r.amount ?? 0), 0);
      if (Math.abs(components - gross.amount) > CENT) {
        failures.push(`${key}: tax components ${components.toFixed(2)} != Gross Tax ${gross.amount.toFixed(2)}`);
      }
    }

    // 3b. Gross − credits = net liability. Credit lines are already signed negative;
    // carryforward rows are informational memos, not credits taken, so exclude them.
    const net = at('Net Tax Liability');
    if (gross && net) {
      const credits = group
        .filter(r => r.section === 'Credits' && !/carryforward/i.test(r.label))
        .reduce((s, r) => s + (r.amount ?? 0), 0);
      if (Math.abs(gross.amount + credits - net.amount) > CENT) {
        failures.push(`${key}: Gross ${gross.amount.toFixed(2)} + credits ${credits.toFixed(2)} != net ${net.amount.toFixed(2)}`);
      }
    }
  }

  return { failures, reconciled, years: new Set(lines.map(r => r.taxYear)).size };
}

/** Identity of one filing: a year's form for one filer. `parentLine` is scoped to it. */
function keyOf(row) {
  return `${row.taxYear} ${row.country} ${row.form}${row.personKey ? ` [${row.personKey}]` : ''}`;
}

// ─── CSV rendering ────────────────────────────────────────────────────────────

/**
 * Render worksheet rows as an RFC 4180 CSV string with the §5.1 column order.
 *
 * Money is formatted to 2 decimal places and rates to 5, which is display rounding
 * only — the engine never rounds, and `buildTaxWorksheetRows` returns raw floats for
 * consumers that want full precision (§4.2).
 *
 * `null` becomes an EMPTY cell, never `0` — a structural blank must not pollute a
 * spreadsheet's AVERAGE/COUNT (§5.2).
 *
 * @param {object[]} rows
 * @param {{ header?: boolean }} [opts]
 * @returns {string}
 */
export function toCsv(rows, { header = true } = {}) {
  const out = header ? [WORKSHEET_COLUMNS.join(',')] : [];
  for (const row of rows ?? []) {
    out.push(WORKSHEET_COLUMNS.map(col => csvEscape(formatCell(col, row))).join(','));
  }
  return out.join('\n');
}

/** Money renders at 2dp, rates at 5dp. */
const MONEY_DP = 2;
const RATE_DP  = 5;
/**
 * FX at 6dp. An exchange rate is a multiplier, not a percentage: at 5dp a rate
 * of 1.55 applied to a seven-figure gain is already off by dollars, and the
 * column exists precisely so a reader can re-derive the conversion.
 */
const FX_DP    = 6;

/** Columns holding a currency amount — all formatted alike. */
const MONEY_COLUMNS = new Set([
  'bracketIncome', 'bracketTax',
  // Bracket edges are dollar amounts too, and once inflation-indexing is applied
  // they are NOT round numbers: the 2032 MFJ 12% band starts at 28478.147272216655.
  // Formatting them as money keeps the column readable and comparable to the
  // incomes sitting beside it.
  'bracketLower', 'bracketUpper',
]);

/**
 * Per-column display formatting.
 *
 * The `amount` column is polymorphic — money on `LINE` rows, a ratio on `RATE` rows
 * (§5.2) — so formatting has to consult `rowType`, not just the column name.
 */
function formatCell(col, row) {
  const value = row[col];
  if (value == null) return '';
  if (typeof value !== 'number') return value;

  if (col === 'amount')    return value.toFixed(row.rowType === 'RATE' ? RATE_DP : MONEY_DP);
  if (col === 'bracketRate') return value.toFixed(RATE_DP);
  if (col === 'fxRate')      return value.toFixed(FX_DP);
  if (MONEY_COLUMNS.has(col)) return value.toFixed(MONEY_DP);
  return value;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
