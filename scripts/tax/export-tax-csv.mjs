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
 * export-tax-csv.mjs — design 71 Phase 4.
 *
 * Headless tax-worksheet CSV exporter: runs a scenario and writes one row per
 * tax-form line item plus one row per marginal bracket band, for every settled tax
 * year in the run. This is the manual-validation instrument — open the CSV in a
 * spreadsheet, pivot by `taxYear`, and confirm the bands sum to the line and the
 * lines sum to the liability.
 *
 * The CSV is a projection of the very same TaxDocument the tax popup renders
 * (design 71 §2.1), so if the two ever disagree, that is a bug.
 *
 * Files are written with a UTF-8 BOM so Excel decodes `§`, the FY en dash and `≤`
 * correctly instead of falling back to the legacy codepage (§5.5).
 *
 * Two columns worth knowing about (§5.5):
 *   `taxYearLabel` — `taxYear` spelled the way the return files it (`CY 2032`,
 *                    `FY 2025–26`). `taxYear` itself stays the integer, since it
 *                    is the join key to the drill files and the only sortable form.
 *   `fxRate`       — USD/AUD at the settlement (AUD per USD), the rate behind
 *                    every converted figure on a cross-border return.
 *
 * Usage:
 *   node scripts/export-tax-csv.mjs --reference > tax.csv
 *   node scripts/export-tax-csv.mjs <file.json> [options] > tax.csv
 *   npm run export:tax -- --reference --check
 *   npm run export:tax -- --reference --state NE --cc STATE --check
 *
 * Options:
 *   --reference        Run the built-in reference scenario (IntlRetirementScenario)
 *                      instead of loading a file. Handy for a zero-setup baseline.
 *   --cc <J[,J]>       Jurisdiction(s) to export: US, AU, STATE. Default US.
 *                      STATE is the US state return (design 71 §11.3) — one document
 *                      per settled year for the primary person's residency state.
 *                      It rides in the `form` column (`NE State Income Tax`); the
 *                      `country`/`currency` columns stay US/USD, so `--cc US,STATE`
 *                      puts the federal and state returns in one file and they are
 *                      told apart by `form`.
 *   --state <CODE>     Reference-scenario residency state (NE, HI or SD — the states
 *                      with rates modules). Only meaningful with --reference: the
 *                      reference scenario has no residency state by default, so
 *                      `--cc STATE` alone yields no rows. Configs loaded from a file
 *                      carry their own residencyState; this flag does not override it.
 *                      Note the reference scenario moves US→AU in 2031, after which
 *                      state liability is legitimately zero.
 *   --year <Y[,Y]>     Restrict to these tax years. Default: every settled year.
 *   --schedules        Also emit supplementary sections-shaped forms (Schedule D).
 *                      Table-shaped forms (8949, AU CGT Schedule) are never emitted
 *                      — see design 71 §5.4.
 *   --to <YYYY-MM-DD>  Stop the run at this date instead of the scenario's simEnd.
 *   --out <path>       Write to a file instead of stdout.
 *   --check            Verify the footing invariants (design 71 §6) and report to
 *                      stderr. Exits non-zero if any check fails.
 *   --first            If the file holds several scenarios, only export the first.
 *   -h, --help         Show this help.
 *
 * Drill reports (the journal-backed reports the workbench panel renders):
 *   --drill-reports <all|id[,id]>
 *                      Also export drill reports. The panel scopes a report to one
 *                      period at a time; this stacks every settled year into one file
 *                      per report with a leading `taxYear` column.
 *   --drill-out <dir>  Directory for the per-report files. Default ./drill-reports.
 *   --drill-detail <groups|entries>
 *                      Row granularity: one row per group per year (default), or one
 *                      row per contributing journal entry (what the panel downloads).
 *   --drill-cc <J[,J]> Countries for cc-faceted reports. Default: --cc minus STATE,
 *                      falling back to US,AU.
 *   --list-drill-reports  Print every report id + title and exit.
 *
 * npm:  npm run export:tax -- <file.json> [options]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join }                   from 'node:path';

import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { BaseScenario }           from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { StateTaxSettleService }  from '../../src/finance/tax/state/state-tax-settle-service.js';
import { ReportDefinitionRegistry } from '../../src/finance/journal-reporting/report-definition-registry.js';
import { exportDrillReports }       from '../../src/finance/journal-reporting/drill-report-export.js';
import {
  buildTaxWorksheetRows,
  toCsv,
  verifyWorksheetRows,
} from '../../src/finance/tax/tax-worksheet-export.js';
import { withBom }                 from '../../src/utils/csv.js';
import { parseFlags }              from '../lib/cli.mjs';

// ─── CLI parsing ──────────────────────────────────────────────────────────────

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/tax/export-tax-csv.mjs --reference > tax.csv\n'
       + 'node scripts/tax/export-tax-csv.mjs <file.json> [options] > tax.csv\n'
       + 'node scripts/tax/export-tax-csv.mjs --reference --state NE --cc STATE > state-tax.csv\n\n'
       + 'export-tax-csv — headless tax worksheet CSV export (design 71).',
  positional: { name: 'file', type: 'string', help: 'scenario export; omit with --reference' },
  reference:  { type: 'flag',   help: 'run the built-in reference scenario instead of loading a file' },
  cc:         { type: 'list',   default: ['US'], choices: ['US', 'AU', 'STATE', 'us', 'au', 'state'],
                help: "jurisdictions to export; STATE is the US state return, riding in the 'form' column with country US" },
  state:      { type: 'string', help: 'residency state for --reference (NE, HI, SD); without it the reference scenario yields no STATE rows' },
  year:       { type: 'list',   help: 'restrict to these tax years (default: all settled years)' },
  schedules:  { type: 'flag',   help: 'also emit supplementary forms (Schedule D)' },
  to:         { type: 'string', help: "stop the run at this YYYY-MM-DD instead of the scenario's simEnd" },
  out:        { type: 'string', help: 'write to a file instead of stdout' },
  check:      { type: 'flag',   help: 'verify the design 71 §6 footing invariants; non-zero exit on failure' },
  first:      { type: 'flag',   help: 'export only the first scenario if the file holds several' },

  drillReports:     { type: 'list',   help: 'export these drill reports alongside the worksheet ("all" for every one)' },
  drillOut:         { type: 'string', default: 'drill-reports', help: 'drill report output directory' },
  drillDetail:      { type: 'string', default: 'groups', choices: ['groups', 'entries'],
                      help: 'one row per group per year, or per entry' },
  drillCc:          { type: 'list',   help: 'countries for cc-faceted reports (default: --cc, else US,AU)' },
  listDrillReports: { type: 'flag',   help: 'list every report id + title and exit' },
});

// Normalised once, here, rather than at each of the dozen use sites below.
opts.cc      = opts.cc.map(c => c.toUpperCase());
opts.state   = opts.state ? opts.state.toUpperCase() : null;
opts.years   = opts.year?.map(Number) ?? null;
opts.drillCc = opts.drillCc?.map(c => c.toUpperCase()) ?? null;

// ─── Running ──────────────────────────────────────────────────────────────────

/** Swallow console.log/.warn so run noise never contaminates CSV on stdout. */
function silenceConsole() {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  return () => { console.log = log; console.warn = warn; };
}

/**
 * Run the built-in reference scenario; return its journal entries.
 *
 * `residencyState` is the one param the exporter overrides: the reference scenario
 * leaves it null, so without it the US_STATE_TAX settle handler emits nothing at all
 * and `--cc STATE` has no settlements to project (design 71 §11.3).
 */
function runReference(endDate, residencyState = null) {
  ServiceRegistry.resetAll();
  const params   = residencyState ? { residencyState } : {};
  const scenario = IntlRetirementScenario.buildAndCompile({ params });
  const restore = silenceConsole();
  try { scenario.sim.stepTo(endDate ?? scenario.simEnd); }
  finally { restore(); }
  return {
    journal:  scenario.sim.journal.journal,
    // Drill reports query the Journal object itself (seq/stateDiff live there,
    // not on the flat entry list the worksheet exporter consumes).
    journalObj: scenario.sim.journal,
    services: ServiceRegistry.getInstance(),
    name:     'IntlRetirementScenario (reference)',
  };
}

/** Load + run one exported scenario config; return its journal entries. */
function runConfig(cfg, endDate) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:      services.simulationContext,
    initialState: cfg.initialState ?? {},
    simStart:     new Date(cfg.simStart),
    simEnd:       new Date(cfg.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);
  const restore = silenceConsole();
  try { scenario.sim.stepTo(endDate ?? new Date(cfg.simEnd)); }
  finally { restore(); }
  return {
    journal:    scenario.sim.journal.journal,
    journalObj: scenario.sim.journal,
    services,
    name:       cfg.name ?? '(unnamed)',
  };
}

// ─── Drill reports ────────────────────────────────────────────────────────────

/**
 * Export the requested drill reports for every run, one CSV per report plus a
 * `_manifest.csv` naming what was written. The manifest is the fast way to spot
 * a report that came back empty — an empty file would otherwise look like a
 * report with nothing to say rather than one whose facets found no rows.
 *
 * With several scenarios in one file each run gets its own subdirectory, since
 * the report ids collide.
 */
async function writeDrillReports(runs, opts) {
  const registry  = new ReportDefinitionRegistry();
  const requested = opts.drillReports.includes('all') ? null : opts.drillReports;

  if (requested) {
    const unknown = requested.filter(id => !registry.get(id));
    if (unknown.length) {
      console.error(`Unknown drill report id(s): ${unknown.join(', ')}.`
        + ' Run --list-drill-reports to see the available ids.');
      process.exit(2);
    }
  }

  // STATE is a US return, not a country the reports are faceted by.
  const ccs = (opts.drillCc ?? opts.cc.filter(c => c !== 'STATE'));
  const drillCcs = ccs.length ? ccs : ['US', 'AU'];

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const dir = runs.length > 1 ? join(opts.drillOut, `run-${i + 1}`) : opts.drillOut;
    mkdirSync(dir, { recursive: true });

    const exported = await exportDrillReports({
      journal:   run.journalObj,
      registry,
      services:  run.services,
      reportIds: requested,
      ccs:       drillCcs,
      detail:    opts.drillDetail,
    });

    const manifest = [['report', 'title', 'mode', 'cc', 'years', 'rows', 'file'].join(',')];
    let written = 0;
    for (const r of exported) {
      if (!r.rowCount) {
        console.error(`  (empty) ${r.id} — no rows for ${drillCcs.join(',')}`);
        manifest.push([r.id, `"${r.title}"`, r.mode, r.cc, '', 0, ''].join(','));
        continue;
      }
      const file = `${r.id}.csv`;
      writeFileSync(join(dir, file), withBom(r.csv) + '\n');
      manifest.push([r.id, `"${r.title}"`, r.mode, r.cc, r.years, r.rowCount, file].join(','));
      written++;
    }
    writeFileSync(join(dir, '_manifest.csv'), withBom(manifest.join('\n')) + '\n');
    console.error(`Wrote ${written} drill report(s) (${opts.drillDetail}) to ${dir}/`
      + ` for ${run.name}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Listing needs no scenario — answer it before demanding an input.
  if (opts.listDrillReports) {
    for (const def of new ReportDefinitionRegistry().getAll()) {
      console.log(`${def.id.padEnd(34)} ${def.title}`);
    }
    return;
  }

  if (!opts.file && !opts.reference) {
    console.error('\nexport-tax-csv needs a <file.json> or --reference.  (-h for options)\n');
    process.exit(1);
  }

  const endDate = opts.to ? new Date(opts.to) : null;

  // A state with no rates module still settles — at zero, with only the summary lines —
  // so the export would silently look "empty but valid". Say so up front.
  if (opts.state && !new StateTaxSettleService().hasState(opts.state)) {
    console.error(`No rates module for state ${opts.state}; it settles at zero`
      + ' and the export will carry summary lines only. Modeled states: NE, HI, SD.');
  }

  let runs;
  if (opts.reference) {
    runs = [runReference(endDate, opts.state)];
  } else {
    if (opts.state) {
      console.error('--state applies to --reference only; a loaded config carries its own'
        + ' residencyState. Ignoring it.');
    }
    let parsed;
    try { parsed = JSON.parse(readFileSync(opts.file, 'utf8')); }
    catch (e) { console.error(`Failed to read ${opts.file}: ${e.message}`); process.exit(1); }

    const cfgs = Array.isArray(parsed.scenarios) ? parsed.scenarios
               : Array.isArray(parsed)           ? parsed
               : [parsed];
    runs = (opts.first ? cfgs.slice(0, 1) : cfgs).map(cfg => runConfig(cfg, endDate));
  }

  const rows = runs.flatMap(run => buildTaxWorksheetRows(run.journal, {
    cc:               opts.cc.length === 1 ? opts.cc[0] : opts.cc,
    years:            opts.years,
    includeSchedules: opts.schedules,
    // The AU CGT worksheet converts each disposal from its own currency; the manifest
    // is where that currency is declared (design 91 §8.6 step 3).
    typeRegistry:     ServiceRegistry.getInstance().typeRegistry,
  }));

  if (!rows.length) {
    const yearsNote = opts.years ? ` in ${opts.years.join(',')}` : '';
    console.error(`No tax settlements found for ${opts.cc.join(',')}${yearsNote}.`
      + ' The run may end before the first settle, or that jurisdiction may not be settled in it.');
    if (opts.cc.includes('STATE')) {
      console.error('For STATE rows the primary person needs a residencyState:'
        + ' pass --state NE|HI|SD with --reference, or set it in the scenario config.');
    }
    // Drill reports are computed from the journal independently of the worksheet,
    // so an empty worksheet is no reason to skip them when they were asked for.
    if (!opts.drillReports) process.exit(1);
  }

  if (rows.length) {
    // BOM on the artifact, not in toCsv: without it Excel decodes the file with
    // the legacy codepage and every § / – / ≤ in the labels arrives mangled.
    // stdout gets one too — `> tax.csv` is the documented usage, so the
    // redirected bytes are the file.
    const csv = withBom(toCsv(rows));
    if (opts.out) {
      writeFileSync(opts.out, csv + '\n');
      console.error(`Wrote ${rows.length} rows to ${opts.out}`);
    } else {
      process.stdout.write(csv + '\n');
    }
  }

  if (opts.drillReports) await writeDrillReports(runs, opts);

  if (opts.check) {
    const { failures, reconciled, years } = verifyWorksheetRows(rows);
    console.error(`\nChecked ${years} tax year(s), ${reconciled} bracket schedule(s).`);
    if (failures.length) {
      console.error(`FAILED — ${failures.length} footing violation(s):`);
      for (const f of failures) console.error(`  ✖ ${f}`);
      process.exit(1);
    }
    console.error('All footing checks passed ✅');
  }
}

await main();
