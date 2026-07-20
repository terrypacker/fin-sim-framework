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
 * diff-scenarios.mjs
 *
 * Answers "where and when do these two scenarios diverge?" — the question
 * run-scenario.mjs cannot, because it only compares *final* summary rows and
 * account balances.
 *
 * Two modes:
 *
 *   POINT (default)  Run both to --at and diff every numeric field in state,
 *                    ranked by |delta|. This surfaces the accumulators that
 *                    actually explain a divergence — tax buckets, FTC pools,
 *                    YTD income — not just balances. Use it when two runs end
 *                    differently and you want the cause rather than the size.
 *
 *   TRACK (--track)  Print an annual series of the delta in a handful of fields,
 *                    so you can see *when* the paths separate and whether the
 *                    gap compounds, stays flat, or closes. A delta that stays
 *                    nominally flat for decades while the portfolio compounds
 *                    means the marginal money is not being invested — that
 *                    signature is how design/72 Gap 2 was found.
 *
 * Usage:
 *   node scripts/diff-scenarios.mjs a.json b.json
 *   node scripts/diff-scenarios.mjs a.json b.json --at 2034-01-01 --top 40
 *   node scripts/diff-scenarios.mjs a.json b.json --track
 *   node scripts/diff-scenarios.mjs a.json b.json --track --fields metrics.netWorth,cumulativeTaxesPaid
 *   node scripts/diff-scenarios.mjs a.json b.json --json
 *
 * Options:
 *   --at <YYYY-MM-DD>  Point-diff date (default: each scenario's simEnd).
 *   --track            Annual delta series instead of a point diff.
 *   --from <YYYY>      Track start year (default: simStart's year).
 *   --fields <a,b,c>   Track these dotted state paths instead of the defaults.
 *   --top <N>          Point mode: show N largest deltas (default 25).
 *   --eps <N>          Ignore deltas smaller than this (default 1).
 *   --json             Machine-readable output.
 *   -h, --help         Show this help.
 *
 * GOTCHA when building an A/B pair by *removing* a domain record: setting
 * `companyEquities: []` (or accounts/persons/realProperties/collectibles) does
 * NOT produce a scenario without it — ScenarioLoader._driftMergeDomainRecords
 * re-adds the scenario-class default. You need an explicit tombstone:
 *   cfg.deletedDefaults = { companyEquities: ['companyEquityAccount'] };
 * Without it the "without" arm silently runs *with* a default record and the
 * comparison inverts (design/72 §5).
 */

import { readFileSync } from 'node:fs';
import { basename }     from 'node:path';

import { ServiceRegistry }     from '../src/services/service-registry.js';
import { BaseScenario }        from '../src/scenarios/base-scenario.js';
import { ScenarioLoader }      from '../src/scenarios/scenario-loader.js';
import { computeNetLiquidity } from '../src/finance/derived-metrics/net-liquidity.js';

const DEFAULT_TRACK_FIELDS = [
  'metrics.netWorth',
  'metrics.netLiquidity',
  'cumulativeTaxesPaid',
  'cumulativeConsumption',
];

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { files: [], at: null, track: false, from: null, fields: null, top: 25, eps: 1, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--at':     opts.at = argv[++i]; break;
      case '--track':  opts.track = true; break;
      case '--from':   opts.from = Number(argv[++i]); break;
      case '--fields': opts.fields = argv[++i].split(',').map(s => s.trim()).filter(Boolean); break;
      case '--top':    opts.top = Number(argv[++i]); break;
      case '--eps':    opts.eps = Number(argv[++i]); break;
      case '--json':   opts.json = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) { console.error(`Unknown option: ${a}`); process.exit(2); }
        opts.files.push(a);
    }
  }
  return opts;
}

const HELP = `diff-scenarios — find where and when two scenarios diverge

Usage:
  node scripts/diff-scenarios.mjs <a.json> <b.json> [options]

Options:
  --at <YYYY-MM-DD>  Point-diff date (default: simEnd).
  --track            Annual delta series instead of a point diff.
  --from <YYYY>      Track start year (default: simStart's year).
  --fields <a,b,c>   Track these dotted state paths (default: net worth,
                     net liquidity, cumulative taxes, cumulative consumption).
  --top <N>          Point mode: show N largest deltas (default 25).
  --eps <N>          Ignore deltas smaller than this (default 1).
  --json             Machine-readable output.
  -h, --help         Show this help.`;

// ─── Running ────────────────────────────────────────────────────────────────

/** Load a cfg and build its sim without stepping it. */
function build(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const cfg = Array.isArray(parsed.scenarios) ? parsed.scenarios[0]
            : Array.isArray(parsed)           ? parsed[0]
            : parsed;
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
  return { cfg, sim: scenario.sim };
}

/** Temporarily swallow console.log/.warn; returns a restore fn. */
function silenceConsole() {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  return () => { console.log = log; console.warn = warn; };
}

function stepTo(sim, date) {
  const restore = silenceConsole();
  try { sim.stepTo(date); } finally { restore(); }
}

/**
 * Flatten state to { dottedPath: number }. Arrays are skipped — per-holding rows
 * are noisy and their aggregate already shows up as the account balance. Depth is
 * capped so vintage maps (ftcPoolPassive.2033) are reached without walking forever.
 */
function flatten(state, maxDepth = 3) {
  const out = {};
  const walk = (obj, prefix, depth) => {
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj) || depth > maxDepth) return;
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'number' && Number.isFinite(v)) out[path] = v;
      else walk(v, path, depth + 1);
    }
  };
  walk(state, '', 0);
  return out;
}

/** Read a dotted path out of state. */
function get(state, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), state);
}

// ─── Modes ────────────────────────────────────────────────────────────────────

function pointDiff(files, opts) {
  const results = files.map(f => {
    const { cfg, sim } = build(f);
    const date = opts.at ? new Date(opts.at) : new Date(cfg.simEnd);
    stepTo(sim, date);
    // Derived metrics are written during stepping; net liquidity needs the date.
    const state = { ...sim.state };
    state.metrics = { ...(state.metrics ?? {}), netLiquidity: computeNetLiquidity(sim.state, sim.currentDate) };
    return { label: basename(f).replace(/\.json$/, ''), date: sim.currentDate, flat: flatten(state) };
  });

  const [a, b] = results;
  const keys = [...new Set([...Object.keys(a.flat), ...Object.keys(b.flat)])];
  const rows = keys
    .map(k => ({ key: k, a: a.flat[k] ?? 0, b: b.flat[k] ?? 0 }))
    .map(r => ({ ...r, delta: r.b - r.a }))
    .filter(r => Math.abs(r.delta) >= opts.eps)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  if (opts.json) {
    console.log(JSON.stringify({ mode: 'point', date: a.date, a: a.label, b: b.label, rows }, null, 2));
    return;
  }

  const shown = rows.slice(0, opts.top);
  const W = Math.max(20, ...shown.map(r => r.key.length));
  const C = Math.max(16, a.label.length, b.label.length) + 2;
  console.log(`\nPoint diff @ ${a.date.toISOString().slice(0, 10)}   ${a.label} → ${b.label}`);
  console.log(`${rows.length} field(s) differ by >= ${opts.eps}; showing ${shown.length}\n`);
  console.log('FIELD'.padEnd(W) + a.label.padStart(C) + b.label.padStart(C) + 'DELTA'.padStart(C));
  console.log('─'.repeat(W + C * 3));
  for (const r of shown) {
    console.log(r.key.padEnd(W)
      + Math.round(r.a).toLocaleString().padStart(C)
      + Math.round(r.b).toLocaleString().padStart(C)
      + Math.round(r.delta).toLocaleString().padStart(C));
  }
}

function trackDiff(files, opts) {
  const fields = opts.fields ?? DEFAULT_TRACK_FIELDS;
  const series = files.map(f => {
    const { cfg, sim } = build(f);
    const startYear = opts.from ?? new Date(cfg.simStart).getUTCFullYear();
    const endYear   = new Date(opts.at ?? cfg.simEnd).getUTCFullYear();
    const rows = {};
    for (let y = startYear; y <= endYear; y++) {
      stepTo(sim, new Date(Date.UTC(y, 0, 1)));
      const state = { ...sim.state };
      state.metrics = { ...(state.metrics ?? {}), netLiquidity: computeNetLiquidity(sim.state, sim.currentDate) };
      rows[y] = Object.fromEntries(fields.map(fl => [fl, Number(get(state, fl) ?? 0)]));
    }
    return { label: basename(f).replace(/\.json$/, ''), rows };
  });

  const [a, b] = series;
  const years = Object.keys(a.rows).map(Number).sort((x, y) => x - y);

  if (opts.json) {
    const out = years.map(y => ({ year: y, ...Object.fromEntries(fields.map(fl => [fl, b.rows[y][fl] - a.rows[y][fl]])) }));
    console.log(JSON.stringify({ mode: 'track', a: a.label, b: b.label, fields, rows: out }, null, 2));
    return;
  }

  const C = 18;
  console.log(`\nAnnual delta (${b.label} − ${a.label})\n`);
  console.log('YEAR'.padEnd(6) + fields.map(f => f.replace('metrics.', '').slice(0, C - 2).padStart(C)).join(''));
  console.log('─'.repeat(6 + C * fields.length));
  for (const y of years) {
    console.log(String(y).padEnd(6)
      + fields.map(f => Math.round(b.rows[y][f] - a.rows[y][f]).toLocaleString().padStart(C)).join(''));
  }
  console.log('\nA delta that stays nominally flat while the portfolio compounds means the');
  console.log('marginal money is not being invested — check drawdown routing, not returns.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.files.length !== 2) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 1);
  }
  if (opts.track) trackDiff(opts.files, opts);
  else            pointDiff(opts.files, opts);
}

main();
