#!/usr/bin/env node
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
 * crossfoot-drill-reports.mjs — design 73 §0.
 *
 * Cross-foots exported drill reports against the tax-worksheet lines that link
 * to them. Every worksheet line carrying a `drillReport` value asserts "this
 * report explains this number", which makes the claim mechanically checkable:
 * the report's total for a tax year must equal the line for that year.
 *
 * This is the check that found design 73 §0.3–0.5 and §0b — none of which is
 * visible one year at a time, which is the whole point of exporting every year
 * into one file (design 71 §7.3).
 *
 * It reads only the exported CSVs; it never re-runs the simulation, so it is
 * fast and validates the artifact a reader actually holds.
 *
 * Usage:
 *   node scripts/crossfoot-drill-reports.mjs <dir> [<dir> …]
 *   npm run crossfoot -- scenarios/my-reports/us scenarios/my-reports/au
 *
 * Each <dir> is one country's export directory — a `_tax-worksheet-*.csv`
 * plus the per-report CSVs beside it, exactly as `export-tax-csv.mjs
 * --drill-reports all --drill-out <dir>` writes them.
 *
 * Options:
 *   --tolerance <n>  Absolute tolerance for a match (default 0.02, i.e. cents).
 *   --verbose        List every disagreeing year, not just the first few.
 *   -h, --help       Show this help.
 *
 * Exits non-zero when any linked line fails to foot.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, basename }            from 'node:path';

// ─── CSV ──────────────────────────────────────────────────────────────────────

/** RFC 4180 reader — the exports quote any field carrying a separator. */
function readCsv(path) {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',')  { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  row.push(field); rows.push(row);
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const num = v => (v === '' || v == null ? null : Number(v));

// ─── Cross-foot ───────────────────────────────────────────────────────────────

/**
 * Check one country's export directory.
 * @returns {{checked: number, failures: Array<object>, notes: Array<string>}}
 */
function crossfoot(dir, tolerance) {
  const worksheetName = readdirSync(dir).find(f => f.startsWith('_tax-worksheet'));
  if (!worksheetName) throw new Error(`No _tax-worksheet-*.csv in ${dir}`);
  const worksheet = readCsv(join(dir, worksheetName));

  // A linked line is emitted per person on the AU return; the drill reports are
  // household-scoped, so sum the people back up before comparing.
  //
  // SUBLINE rows count too: a drill may legitimately hang off a sub-row rather
  // than the line above it (the NIIT drill explains the §1411 base, not the tax —
  // design 73 §0b.2). Skipping them would silently retire the check instead of
  // verifying it.
  const lines = new Map();
  for (const r of worksheet) {
    if ((r.rowType !== 'LINE' && r.rowType !== 'SUBLINE') || !r.drillReport) continue;
    // Keyed by a JSON tuple: a label contains spaces, commas and parentheses, so
    // any single-character separator is either ambiguous or -- if chosen to be
    // unambiguous, like NUL -- makes this file read as binary to git.
    const key = JSON.stringify([r.taxYear, r.drillReport, r.label]);
    lines.set(key, (lines.get(key) ?? 0) + (num(r.amount) ?? 0));
  }

  const totals = new Map();   // reportId → Map(taxYear → Σ total)
  const totalsFor = id => {
    if (!totals.has(id)) {
      let rows = [];
      try { rows = readCsv(join(dir, `${id}.csv`)); }
      catch { /* report exported empty — every year reads 0 */ }
      const m = new Map();
      for (const r of rows) m.set(r.taxYear, (m.get(r.taxYear) ?? 0) + (num(r.total) ?? 0));
      totals.set(id, m);
    }
    return totals.get(id);
  };

  const failures = [];
  const zeroLines = new Map();
  for (const [key, lineAmount] of lines) {
    const [taxYear, report, label] = JSON.parse(key);
    const drill = totalsFor(report).get(taxYear) ?? 0;
    if (Math.abs(lineAmount - drill) > tolerance) {
      failures.push({ taxYear, report, label, line: lineAmount, drill });
    }
    if (lineAmount === 0) zeroLines.set(report, (zeroLines.get(report) ?? 0) + 1);
  }

  const notes = [...zeroLines].map(([report, n]) => `${report}: linked line is 0.00 in ${n} year(s)`);
  return { checked: lines.size, failures, notes };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const HELP = `crossfoot-drill-reports — verify drill reports against the worksheet lines that link to them

Usage:
  node scripts/crossfoot-drill-reports.mjs <dir> [<dir> …]

Options:
  --tolerance <n>  Absolute match tolerance (default 0.02).
  --verbose        List every disagreeing year.
  -h, --help       Show this help.`;

function main() {
  const argv = process.argv.slice(2);
  const dirs = [];
  let tolerance = 0.02, verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tolerance')            tolerance = Number(argv[++i]);
    else if (a === '--verbose')         verbose = true;
    else if (a === '-h' || a === '--help') { console.log(HELP); return; }
    else if (a.startsWith('-'))         { console.error(`Unknown option: ${a}`); process.exit(2); }
    else dirs.push(a);
  }
  if (!dirs.length) { console.log(HELP); process.exit(1); }

  let failed = 0;
  for (const dir of dirs) {
    const { checked, failures, notes } = crossfoot(dir, tolerance);
    console.log(`\n=== ${basename(dir)} — ${checked} linked line(s) ===`);

    if (!failures.length) {
      console.log('  ✅ every linked line foots to its drill report');
    } else {
      failed += failures.length;
      const byReport = new Map();
      for (const f of failures) {
        if (!byReport.has(f.report)) byReport.set(f.report, []);
        byReport.get(f.report).push(f);
      }
      for (const [report, items] of byReport) {
        console.log(`  ✖ ${report}: ${items.length} year(s) disagree`);
        for (const f of (verbose ? items : items.slice(0, 5))) {
          console.log(`      ${f.taxYear} ${f.label}: line=${f.line.toFixed(2)}`
            + ` drill=${f.drill.toFixed(2)} Δ=${(f.line - f.drill).toFixed(2)}`);
        }
        if (!verbose && items.length > 5) console.log(`      … ${items.length - 5} more (--verbose)`);
      }
    }
    for (const n of notes) console.log(`  (note) ${n}`);
  }

  if (failed) {
    console.error(`\n${failed} linked line(s) did not foot.`
      + ' Known-open cases are documented in design/73 §0b.');
    process.exit(1);
  }
  console.log('\nAll linked lines foot ✅');
}

main();
