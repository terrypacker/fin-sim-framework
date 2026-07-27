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
 * run-scenario.mjs
 *
 * Headless scenario runner + comparator. Loads one or more exported scenario
 * JSON files (the `{ "scenarios": [...] }` shape the workbench saves), runs
 * each to its simEnd via the real ScenarioLoader + Simulation, and prints a
 * net-wealth breakdown. With two or more scenarios it prints them side-by-side
 * and flags the rows that differ — handy for "why do these two scenarios end so
 * differently?" investigations without driving the browser UI.
 *
 * Usage:
 *   node scripts/run-scenario.mjs <file.json> [more.json ...]
 *   node scripts/run-scenario.mjs a.json b.json --params   # also diff input params
 *   node scripts/run-scenario.mjs a.json --to 2040-01-01    # stop early
 *   node scripts/run-scenario.mjs a.json --verbose          # show run-time logs
 *   node scripts/run-scenario.mjs a.json b.json --json      # machine-readable
 *
 * A file may hold multiple scenarios; all are run unless --first is given.
 *
 * npm:  npm run scenario -- <file.json> [more.json ...] [options]
 */

import { readFileSync } from 'node:fs';
import { basename }     from 'node:path';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { BaseScenario }    from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { files: [], to: null, params: false, verbose: false, json: false, first: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--to':      opts.to = argv[++i]; break;
      case '--params':  opts.params = true; break;
      case '--verbose': opts.verbose = true; break;
      case '--json':    opts.json = true; break;
      case '--first':   opts.first = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) { console.error(`Unknown option: ${a}`); process.exit(2); }
        opts.files.push(a);
    }
  }
  return opts;
}

const HELP = `run-scenario — headless scenario runner + comparator

Usage:
  node scripts/run-scenario.mjs <file.json> [more.json ...] [options]

Options:
  --to <YYYY-MM-DD>  Stop at this date instead of the scenario's simEnd.
  --params           Also print a table of input params that differ across scenarios.
  --first            Only run the first scenario in each file (default: run all).
  --verbose          Show the simulation's own console output (e.g. OUT_OF_FUNDS).
  --json             Emit machine-readable JSON instead of tables.
  -h, --help         Show this help.`;

// ─── Running ────────────────────────────────────────────────────────────────

/**
 * Load + run a single scenario config to `endDate`, returning its final state
 * and a flattened net-wealth breakdown. Suppresses the simulation's own console
 * output unless `verbose`, so the comparison tables aren't drowned in run logs.
 */
function runScenario(cfg, endDate, { verbose }) {
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

  const sim = scenario.sim;
  const restore = verbose ? null : silenceConsole();
  try {
    sim.stepTo(endDate ?? new Date(cfg.simEnd));
  } finally {
    restore?.();
  }
  return summarize(sim.state, sim.currentDate);
}

/** Temporarily swallow console.log/.warn; returns a restore fn. */
function silenceConsole() {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  return () => { console.log = log; console.warn = warn; };
}

/**
 * Build a flat metric→value map from final sim state: headline run status, then
 * every account balance and every asset (real property, collectibles) value.
 * `netWorth` is the simulation's own authoritative total.
 */
function summarize(state, currentDate) {
  const row = {
    netWorth:          state.metrics?.netWorth ?? null,
    scenarioFailed:    state.scenarioFailed ?? false,
    outOfFundsDate:    state.outOfFundsDate ? new Date(state.outOfFundsDate).toISOString().slice(0, 10) : null,
    cumulativeDeficit: state.cumulativeDeficit ?? 0,
    deficitMonths:     state.deficitMonths ?? 0,
    endDate:           currentDate?.toISOString?.().slice(0, 10) ?? null,
  };
  const accounts = {};
  const assets = {};
  for (const [k, v] of Object.entries(state)) {
    if (!v || typeof v !== 'object') continue;
    if (typeof v.balance === 'number') accounts[k] = v.balance;
    else if (typeof v.value === 'number' && (v.kind === 'real-property' || v.kind === 'collectible')) assets[k] = v.value;
  }
  return { summary: row, accounts, assets };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const SUMMARY_ROWS = [
  ['netWorth',          'Net worth'],
  ['scenarioFailed',    'Scenario failed'],
  ['outOfFundsDate',    'Out-of-funds date'],
  ['cumulativeDeficit', 'Cumulative deficit'],
  ['deficitMonths',     'Deficit months'],
  ['endDate',           'End date'],
];

const fmt = v =>
  typeof v === 'number' ? Math.round(v).toLocaleString() : String(v ?? '');

/** Render a labelled metric table with one column per scenario; flag differing rows. */
function printTable(title, labels, rows) {
  const LABEL_W = Math.max(20, ...rows.map(r => r.label.length));
  const COL_W = Math.max(14, ...labels.map(l => l.length)) + 2;
  const head = 'METRIC'.padEnd(LABEL_W) + labels.map(l => l.padStart(COL_W)).join('') +
               (labels.length > 1 ? '   ' : '');
  console.log(`\n${title}`);
  console.log(head);
  console.log('─'.repeat(head.length));
  for (const r of rows) {
    const cells = r.values.map(v => fmt(v).padStart(COL_W)).join('');
    const differs = labels.length > 1 && new Set(r.values.map(v => String(v))).size > 1;
    console.log(r.label.padEnd(LABEL_W) + cells + (differs ? '   <- differs' : ''));
  }
}

function printReport(scenarios, { params }) {
  const labels = scenarios.map(s => s.label);

  printTable('Run summary', labels, SUMMARY_ROWS.map(([key, label]) => ({
    label, values: scenarios.map(s => s.result.summary[key]),
  })));

  const acctKeys = unionKeys(scenarios.map(s => s.result.accounts));
  if (acctKeys.length) {
    printTable('Account balances', labels, acctKeys.map(k => ({
      label: k, values: scenarios.map(s => s.result.accounts[k] ?? 0),
    })));
  }

  const assetKeys = unionKeys(scenarios.map(s => s.result.assets));
  if (assetKeys.length) {
    printTable('Assets (real property / collectibles)', labels, assetKeys.map(k => ({
      label: k, values: scenarios.map(s => s.result.assets[k] ?? 0),
    })));
  }

  if (params && scenarios.length > 1) printParamDiff(scenarios);
}

/** Print only the input params whose value differs across the compared scenarios. */
function printParamDiff(scenarios) {
  const keys = unionKeys(scenarios.map(s => s.params));
  const rows = keys
    .map(k => ({ label: k, values: scenarios.map(s => s.params[k]) }))
    .filter(r => new Set(r.values.map(v => JSON.stringify(v))).size > 1);
  if (!rows.length) { console.log('\nInput params: no differences.'); return; }
  printTable('Input params (differing only)', scenarios.map(s => s.label), rows);
}

const unionKeys = maps => [...new Set(maps.flatMap(Object.keys))].sort();

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.files.length === 0) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 1);
  }

  const endDate = opts.to ? new Date(opts.to) : null;
  const scenarios = [];

  for (const file of opts.files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`Failed to read ${file}: ${e.message}`);
      process.exit(1);
    }
    const cfgs = Array.isArray(parsed.scenarios) ? parsed.scenarios
               : Array.isArray(parsed)           ? parsed
               : [parsed];
    const chosen = opts.first ? cfgs.slice(0, 1) : cfgs;
    for (const cfg of chosen) {
      // Prefer the scenario's own name; qualify with the filename when a file
      // holds several scenarios (or the scenario is unnamed) to keep columns distinct.
      const label = (chosen.length > 1 || !cfg.name)
        ? `${basename(file).replace(/\.json$/, '')}${cfg.name ? ':' + cfg.name : ''}`
        : cfg.name;
      scenarios.push({
        label,
        params: Object.fromEntries((cfg.params ?? []).map(p => [p.name, p.value])),
        result: runScenario(cfg, endDate, opts),
      });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(scenarios, null, 2));
  } else {
    printReport(scenarios, opts);
  }
}

main();
