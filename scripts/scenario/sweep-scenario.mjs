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
 * sweep-scenario.mjs
 *
 * Vary ONE scenario param across a range, run the scenario once per value, and
 * table the terminal metrics. The deterministic counterpart to a Monte Carlo run:
 * MC asks "what is the spread given uncertainty?", this asks "which way does this
 * lever push, and is the response smooth?".
 *
 * The smoothness question is the point. A lever that steps sharply at one value
 * is either a real threshold (a tax-residency boundary, a bracket edge, an age
 * gate) or a bug — and you cannot tell which from a single run at either side.
 * Sweeping shows the shape. A step larger than the underlying statutory
 * difference can justify is the tell for a missing relief rather than economics;
 * that is exactly how design/72 was found.
 *
 * Usage:
 *   node scripts/sweep-scenario.mjs s.json --param companySaleYear --range 2027:2035
 *   node scripts/sweep-scenario.mjs s.json --param moveYear --range 2028:2036 --step 2
 *   node scripts/sweep-scenario.mjs s.json --param usStockGrowthRate --values 0.06,0.08,0.10
 *   node scripts/sweep-scenario.mjs s.json --param companySaleYear --range 2027:2035 --json
 *
 * Options:
 *   --param <name>     Param to vary (must exist in the scenario's params list).
 *   --range <a:b>      Inclusive numeric range.
 *   --step <n>         Range step (default 1).
 *   --values <a,b,c>   Explicit values instead of --range.
 *   --to <YYYY-MM-DD>  Stop before simEnd.
 *   --json             Machine-readable output.
 *   -h, --help         Show this help.
 *
 * SCOPE: this drives `cfg.params`, so it can vary anything exposed as a param —
 * which since design/55 includes generated per-record params, so most domain-record
 * fields ARE reachable:
 *   prop.<stateKey>.plannedSaleYear / .value / .appreciationRate
 *   acct.<stateKey>.growthRate / .interestRate / .minimumBalance / ...
 *   coll.<stateKey>.plannedSaleYear
 *   person.<id>.retirementDate / .monthlyWage
 * Run with a bogus --param to print the full list for a given scenario.
 *
 * NOT reachable: **company equity has no generated per-record params** — only the
 * single global `companySaleYear`, node-linked to `companyEquityAccount`. A scenario
 * with several tranches cannot sweep the 2nd or 3rd this way; script the cfg mutation
 * directly (see design/72 §4, which wants per-record company-equity params anyway).
 */

import { readFileSync } from 'node:fs';

import { ServiceRegistry }     from '../../src/services/service-registry.js';
import { BaseScenario }        from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }      from '../../src/scenarios/scenario-loader.js';
import { computeNetLiquidity } from '../../src/finance/derived-metrics/net-liquidity.js';

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { file: null, param: null, range: null, step: 1, values: null, to: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--param':  opts.param = argv[++i]; break;
      case '--range':  opts.range = argv[++i]; break;
      case '--step':   opts.step = Number(argv[++i]); break;
      case '--values': opts.values = argv[++i].split(',').map(s => Number(s.trim())); break;
      case '--to':     opts.to = argv[++i]; break;
      case '--json':   opts.json = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) { console.error(`Unknown option: ${a}`); process.exit(2); }
        opts.file = a;
    }
  }
  return opts;
}

const HELP = `sweep-scenario — vary one param across a range and table the results

Usage:
  node scripts/sweep-scenario.mjs <file.json> --param <name> (--range a:b | --values a,b,c)

Options:
  --param <name>     Param to vary (must exist in the scenario's params).
  --range <a:b>      Inclusive numeric range.
  --step <n>         Range step (default 1).
  --values <a,b,c>   Explicit values instead of --range.
  --to <YYYY-MM-DD>  Stop before simEnd.
  --json             Machine-readable output.
  -h, --help         Show this help.

Run with a bogus --param to list every param in a given scenario. Since design/55
most domain-record fields are exposed (prop.*/acct.*/coll.*/person.*); company
equity is the exception — only the global companySaleYear.`;

// ─── Running ────────────────────────────────────────────────────────────────

/** Temporarily swallow console.log/.warn; returns a restore fn. */
function silenceConsole() {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  return () => { console.log = log; console.warn = warn; };
}

/** Run one iteration of the scenario with `param` forced to `value`. */
function runOne(baseCfg, param, value, endDate) {
  const cfg = structuredClone(baseCfg);
  let found = false;
  for (const p of (cfg.params ?? [])) {
    if (p.name === param) { p.value = value; found = true; }
  }
  if (!found) return { missing: true };
  // Params are also read from cfg.parameters on some paths; keep both in step.
  cfg.parameters = { ...(cfg.parameters ?? {}), [param]: value };

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
  const restore = silenceConsole();
  try { sim.stepTo(endDate ?? new Date(cfg.simEnd)); } finally { restore(); }

  const s = sim.state;
  return {
    value,
    netWorth:   Math.round(s.metrics?.netWorth ?? 0),
    netLiq:     Math.round(computeNetLiquidity(s, sim.currentDate)),
    lifetimeTax: Math.round(s.cumulativeTaxesPaid ?? 0),
    failed:     s.scenarioFailed ?? false,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.file || !opts.param || (!opts.range && !opts.values)) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 1);
  }

  const parsed = JSON.parse(readFileSync(opts.file, 'utf8'));
  const cfg = Array.isArray(parsed.scenarios) ? parsed.scenarios[0]
            : Array.isArray(parsed)           ? parsed[0]
            : parsed;

  let values = opts.values;
  if (!values) {
    const [lo, hi] = opts.range.split(':').map(Number);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      console.error('--range must look like 2027:2035');
      process.exit(2);
    }
    values = [];
    for (let v = lo; v <= hi; v += opts.step) values.push(v);
  }

  const endDate = opts.to ? new Date(opts.to) : null;
  const rows = [];
  for (const v of values) {
    const r = runOne(cfg, opts.param, v, endDate);
    if (r.missing) {
      const names = (cfg.params ?? []).map(p => p.name);
      console.error(`Param "${opts.param}" not found. Available (${names.length}):`);
      console.error(names.join(', '));
      process.exit(2);
    }
    rows.push(r);
  }

  if (opts.json) {
    console.log(JSON.stringify({ param: opts.param, rows }, null, 2));
    return;
  }

  const base = rows[0].netWorth;
  const W = Math.max(opts.param.length, 12) + 2;
  console.log(`\nSweep: ${opts.param}   (${rows.length} runs)\n`);
  console.log('VALUE'.padStart(W) + 'NET WORTH'.padStart(16) + 'NET LIQUIDITY'.padStart(16)
    + 'LIFETIME TAX'.padStart(16) + 'Δ vs FIRST'.padStart(16) + '  FAILED');
  console.log('─'.repeat(W + 64 + 9));
  for (const r of rows) {
    console.log(String(r.value).padStart(W)
      + r.netWorth.toLocaleString().padStart(16)
      + r.netLiq.toLocaleString().padStart(16)
      + r.lifetimeTax.toLocaleString().padStart(16)
      + (r.netWorth - base).toLocaleString().padStart(16)
      + (r.failed ? '  YES' : '  no'));
  }
  console.log('\nA sharp step is either a real threshold or a missing relief. If the step is');
  console.log('bigger than the statutory difference at that boundary justifies, suspect a bug.');
}

main();
