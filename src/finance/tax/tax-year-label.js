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
 * Human-readable tax-year labels — the single definition of how a `taxYear`
 * integer is spelled for a reader.
 *
 * Internally a tax year is always an integer, filed under the convention the
 * return uses: the calendar year for the US, the fiscal-year START year for AU
 * (`2025` = FY2025-26, 1 Jul 2025 – 30 Jun 2026). That integer is the join key
 * between the worksheet CSV and the drill-report CSVs and what `--year` filters
 * on, so it stays a number everywhere.
 *
 * What it is NOT is self-explanatory: a bare `2025` on an Australian row reads
 * as calendar 2025 and is off by half a year. Everything user-facing therefore
 * shows the label instead of (or beside) the integer, and every producer of one
 * — the AU return titles, the workbench period dropdown, the CSV exports —
 * calls through here so the three artifacts can never drift apart.
 */

/**
 * Label for a tax year in its country's convention.
 *
 *   taxYearLabel('AU', 2025) → 'FY 2025–26'   (July-anchored fiscal year)
 *   taxYearLabel('US', 2032) → 'CY 2032'      (calendar year)
 *
 * The separator is an EN DASH (U+2013), matching the AU return titles and the
 * period dropdown. It is non-ASCII, which is exactly why CSV artifacts carry a
 * UTF-8 BOM (see `src/utils/csv.js`).
 *
 * @param {string} country  'AU' for a fiscal year; anything else is calendar
 * @param {number} taxYear  the filing year integer
 * @returns {string|null}   null when there is no year to label
 */
export function taxYearLabel(country, taxYear) {
  if (taxYear == null || !Number.isFinite(Number(taxYear))) return null;
  const year = Number(taxYear);
  return country === 'AU' ? auFyLabel(year) : `CY ${year}`;
}

/**
 * `FY 2025–26` for the fiscal year STARTING in `startYear`.
 *
 * @param {number} startYear
 * @returns {string}
 */
export function auFyLabel(startYear) {
  return `FY ${startYear}–${String(startYear + 1).slice(-2)}`;
}
