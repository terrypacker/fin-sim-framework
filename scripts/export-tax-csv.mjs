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
 * Usage:
 *   node scripts/export-tax-csv.mjs --reference > tax.csv
 *   node scripts/export-tax-csv.mjs <file.json> [options] > tax.csv
 *   npm run export:tax -- --reference --check
 *
 * Options:
 *   --reference        Run the built-in reference scenario (IntlRetirementScenario)
 *                      instead of loading a file. Handy for a zero-setup baseline.
 *   --cc <US[,AU]>     Country/countries to export. Default US. AU lands with
 *                      design 71 Phase 5; passing it today yields no rows.
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
 * npm:  npm run export:tax -- <file.json> [options]
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { ServiceRegistry }        from '../src/services/service-registry.js';
import { BaseScenario }           from '../src/scenarios/base-scenario.js';
import { ScenarioLoader }         from '../src/scenarios/scenario-loader.js';
import { IntlRetirementScenario } from '../src/scenarios/intl-retirement-scenario.js';
import {
  buildTaxWorksheetRows,
  toCsv,
  verifyWorksheetRows,
} from '../src/finance/tax/tax-worksheet-export.js';

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    file: null, reference: false, cc: ['US'], years: null,
    schedules: false, to: null, out: null, check: false, first: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--reference': opts.reference = true; break;
      case '--cc':        opts.cc = splitList(argv[++i]).map(s => s.toUpperCase()); break;
      case '--year':      opts.years = splitList(argv[++i]).map(Number); break;
      case '--schedules': opts.schedules = true; break;
      case '--to':        opts.to = argv[++i]; break;
      case '--out':       opts.out = argv[++i]; break;
      case '--check':     opts.check = true; break;
      case '--first':     opts.first = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) { console.error(`Unknown option: ${a}`); process.exit(2); }
        else if (!opts.file) opts.file = a;
        else { console.error(`Unexpected extra argument: ${a}`); process.exit(2); }
    }
  }
  return opts;
}

const splitList = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);

const HELP = `export-tax-csv — headless tax worksheet CSV export (design 71)

Usage:
  node scripts/export-tax-csv.mjs --reference > tax.csv
  node scripts/export-tax-csv.mjs <file.json> [options] > tax.csv

Options:
  --reference        Run the built-in reference scenario instead of loading a file.
  --cc <US[,AU]>     Country/countries to export (default US).
  --year <Y[,Y]>     Restrict to these tax years (default: all settled years).
  --schedules        Also emit supplementary forms (Schedule D).
  --to <YYYY-MM-DD>  Stop the run at this date instead of the scenario's simEnd.
  --out <path>       Write to a file instead of stdout.
  --check            Verify the design 71 §6 footing invariants; non-zero exit on failure.
  --first            Only export the first scenario if the file holds several.
  -h, --help         Show this help.`;

// ─── Running ──────────────────────────────────────────────────────────────────

/** Swallow console.log/.warn so run noise never contaminates CSV on stdout. */
function silenceConsole() {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  return () => { console.log = log; console.warn = warn; };
}

/** Run the built-in reference scenario; return its journal entries. */
function runReference(endDate) {
  ServiceRegistry.resetAll();
  const scenario = IntlRetirementScenario.buildAndCompile({});
  const restore = silenceConsole();
  try { scenario.sim.stepTo(endDate ?? scenario.simEnd); }
  finally { restore(); }
  return { journal: scenario.sim.journal.journal, name: 'IntlRetirementScenario (reference)' };
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
  return { journal: scenario.sim.journal.journal, name: cfg.name ?? '(unnamed)' };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.file && !opts.reference)) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 1);
  }

  const endDate = opts.to ? new Date(opts.to) : null;

  let runs;
  if (opts.reference) {
    runs = [runReference(endDate)];
  } else {
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
  }));

  if (!rows.length) {
    console.error(`No tax settlements found for ${opts.cc.join(',')}`
      + `${opts.years ? ` in ${opts.years.join(',')}` : ''}.`
      + ' The run may end before the first settle, or the country may not be settled in it.');
    process.exit(1);
  }

  const csv = toCsv(rows);
  if (opts.out) {
    writeFileSync(opts.out, csv + '\n');
    console.error(`Wrote ${rows.length} rows to ${opts.out}`);
  } else {
    process.stdout.write(csv + '\n');
  }

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

main();
