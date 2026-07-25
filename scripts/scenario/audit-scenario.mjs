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
 * audit-scenario.mjs
 *
 * Headless scenario *auditor* — a QA/sanity-check companion to run-scenario.mjs.
 * Where run-scenario.mjs answers "what are the ending numbers?", this answers
 * "does the run look mechanically healthy, and where does the money actually
 * move?". It loads one exported scenario JSON (the `{ "scenarios": [...] }`
 * shape the workbench saves), runs it to simEnd via the real ScenarioLoader +
 * Simulation, then reports:
 *
 *   1. Run summary        — net worth, failure flag, out-of-funds.
 *   2. Action histogram   — count of journal entries per action type (a fast
 *                           anomaly detector: missing/extra action types jump out).
 *   3. Net worth by year  — year-end USD net worth + year-over-year delta, so
 *                           discontinuities / phantom jumps are visible.
 *   4. Invariant checks   — negative asset-account balances (any month) and
 *                           holdings-sum vs balance desync on the final state.
 *   5. Account ledgers    — for accounts named via --accounts, the money-in and
 *                           money-out totals grouped by the action type that
 *                           caused each balance change ("who drained this?").
 *
 * Usage:
 *   node scripts/audit-scenario.mjs <file.json> [options]
 *   node scripts/audit-scenario.mjs a.json --accounts iraAccount,superAccount
 *   node scripts/audit-scenario.mjs a.json --to 2040-01-01
 *   node scripts/audit-scenario.mjs a.json --json > baseline.json
 *
 * Options:
 *   --accounts <k1,k2>  Also print per-action balance-change ledgers for these
 *                       state keys. Pass "*" for every account with a balance.
 *   --to <YYYY-MM-DD>   Stop at this date instead of the scenario's simEnd.
 *   --first             If the file holds several scenarios, only audit the first.
 *   --json              Emit the full audit as machine-readable JSON (good for
 *                       saving a regression baseline).
 *   -h, --help          Show this help.
 *
 * npm:  npm run audit -- <file.json> [options]   (if wired into package.json)
 */

import { readFileSync } from 'node:fs';
import { basename }     from 'node:path';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { BaseScenario }    from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { computeNetWorth } from '../../src/finance/derived-metrics/net-worth.js';

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { file: null, accounts: [], to: null, first: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--accounts': opts.accounts = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean); break;
      case '--to':       opts.to = argv[++i]; break;
      case '--first':    opts.first = true; break;
      case '--json':     opts.json = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) { console.error(`Unknown option: ${a}`); process.exit(2); }
        else if (!opts.file) opts.file = a;
        else { console.error(`Unexpected extra argument: ${a}`); process.exit(2); }
    }
  }
  return opts;
}

const HELP = `audit-scenario — headless scenario auditor / sanity checker

Usage:
  node scripts/audit-scenario.mjs <file.json> [options]

Options:
  --accounts <k1,k2>  Per-action balance-change ledgers for these state keys ("*" = all).
  --to <YYYY-MM-DD>   Stop at this date instead of the scenario's simEnd.
  --first             Only audit the first scenario if the file holds several.
  --json              Emit machine-readable JSON (e.g. to save a regression baseline).
  -h, --help          Show this help.`;

// ─── Running ────────────────────────────────────────────────────────────────

/** Temporarily swallow console.log/.warn so run noise doesn't drown the report. */
function silenceConsole() {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  return () => { console.log = log; console.warn = warn; };
}

/** Load + run a single scenario config to `endDate`; return the live Simulation. */
function runScenario(cfg, endDate) {
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
  try {
    scenario.sim.stepTo(endDate ?? new Date(cfg.simEnd));
  } finally {
    restore();
  }
  return scenario.sim;
}

// ─── Audit passes ─────────────────────────────────────────────────────────────

/** Count journal entries per action type, descending. */
function actionHistogram(journal) {
  const counts = {};
  for (const e of journal) counts[e.action.type] = (counts[e.action.type] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }));
}

/** Keep the last (highest-seq) snapshot for each calendar year. */
function yearEndSnapshots(snapshots) {
  const byYear = new Map();
  for (const [key, snap] of snapshots) {
    const y = key.slice(0, 4);
    const prev = byYear.get(y);
    if (!prev || snap.seq > prev.seq) byYear.set(y, snap);
  }
  return byYear;
}

/** Year-end USD net worth with year-over-year delta. */
function netWorthByYear(snapshots) {
  const byYear = yearEndSnapshots(snapshots);
  const rows = [];
  let prev = null;
  for (const y of [...byYear.keys()].sort()) {
    const netWorth = +computeNetWorth(byYear.get(y).state, 'USD').toFixed(2);
    rows.push({ year: y, netWorth, delta: prev == null ? null : +(netWorth - prev).toFixed(2) });
    prev = netWorth;
  }
  return rows;
}

/** Any month where an asset (non-loan) account balance goes meaningfully negative. */
function negativeBalances(snapshots) {
  const hits = [];
  for (const [key, snap] of [...snapshots].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const [k, v] of Object.entries(snap.state)) {
      if (v && typeof v === 'object' && typeof v.balance === 'number' && v.type !== 'loan' && v.balance < -0.01) {
        hits.push({ date: key, account: k, balance: +v.balance.toFixed(2) });
      }
    }
  }
  return hits;
}

/** Accounts whose holdings market-value sum diverges from the stored balance. */
function holdingsDesync(state) {
  const hits = [];
  for (const [k, v] of Object.entries(state)) {
    if (v && typeof v === 'object' && Array.isArray(v.holdings) && typeof v.balance === 'number') {
      const hsum = v.holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0);
      if (Math.abs(hsum - v.balance) > 1) {
        hits.push({ account: k, balance: +v.balance.toFixed(2), holdings: +hsum.toFixed(2), diff: +(hsum - v.balance).toFixed(2) });
      }
    }
  }
  return hits;
}

/** For one account, group balance changes by the action type that caused them. */
function accountLedger(journal, acct) {
  const field = `${acct}.balance`;
  const inc = {}, dec = {};
  let firstDrain = null, lastNonZero = null;
  for (const e of journal) {
    const d = e.stateDiff?.find(x => x.field === field);
    if (!d) continue;
    const delta = (d.after ?? 0) - (d.before ?? 0);
    if (Math.abs(delta) < 0.005) continue;
    const bucket = delta < 0 ? dec : inc;
    const b = (bucket[e.action.type] ??= { count: 0, total: 0 });
    b.count++; b.total += delta;
    if ((d.after ?? 0) > 0.01) lastNonZero = e.date;
    if (firstDrain == null && delta < 0) firstDrain = e.date;
  }
  const shape = o => Object.entries(o)
    .sort((a, b) => a[1].total - b[1].total)
    .map(([type, v]) => ({ type, count: v.count, total: +v.total.toFixed(2) }));
  return {
    account:     acct,
    firstDrain:  firstDrain ? new Date(firstDrain).toISOString().slice(0, 10) : null,
    lastNonZero: lastNonZero ? new Date(lastNonZero).toISOString().slice(0, 10) : null,
    decreases:   shape(dec),
    increases:   shape(inc),
  };
}

function buildAudit(sim, cfg, accounts) {
  const J = sim.journal;
  const state = sim.state;

  let acctKeys = accounts;
  if (accounts.length === 1 && accounts[0] === '*') {
    acctKeys = Object.entries(state)
      .filter(([, v]) => v && typeof v === 'object' && typeof v.balance === 'number')
      .map(([k]) => k).sort();
  }

  return {
    scenario:    cfg.name ?? null,
    endDate:     sim.currentDate?.toISOString?.().slice(0, 10) ?? null,
    summary: {
      netWorth:          state.metrics?.netWorth ?? null,
      scenarioFailed:    state.scenarioFailed ?? false,
      outOfFundsDate:    state.outOfFundsDate ? new Date(state.outOfFundsDate).toISOString().slice(0, 10) : null,
      cumulativeDeficit: state.cumulativeDeficit ?? 0,
      deficitMonths:     state.deficitMonths ?? 0,
    },
    actionHistogram: actionHistogram(J.journal),
    netWorthByYear:  netWorthByYear(J.snapshots),
    invariants: {
      negativeBalances: negativeBalances(J.snapshots),
      holdingsDesync:   holdingsDesync(state),
    },
    ledgers: acctKeys.map(k => accountLedger(J.journal, k)),
  };
}

// ─── Text rendering ───────────────────────────────────────────────────────────

const money = v => (typeof v === 'number' ? Math.round(v).toLocaleString() : String(v ?? ''));

function printAudit(a) {
  console.log(`\nScenario: ${a.scenario ?? '(unnamed)'}   →  end ${a.endDate}`);

  console.log('\n=== Run summary ===');
  console.log(`  Net worth (USD)     ${money(a.summary.netWorth)}`);
  console.log(`  Scenario failed     ${a.summary.scenarioFailed}`);
  console.log(`  Out-of-funds date   ${a.summary.outOfFundsDate ?? '—'}`);
  console.log(`  Cumulative deficit  ${money(a.summary.cumulativeDeficit)}`);
  console.log(`  Deficit months      ${a.summary.deficitMonths}`);

  console.log('\n=== Action-type histogram (journal entries) ===');
  for (const { type, count } of a.actionHistogram) console.log(String(count).padStart(7), type);

  console.log('\n=== Net worth (USD) by year ===');
  for (const r of a.netWorthByYear) {
    const d = r.delta == null ? '' : (r.delta >= 0 ? '+' : '') + money(r.delta);
    console.log(' ', r.year, money(r.netWorth).padStart(14), d.padStart(14));
  }

  console.log('\n=== Invariant checks ===');
  const neg = a.invariants.negativeBalances;
  const des = a.invariants.holdingsDesync;
  if (!neg.length) console.log('  Negative asset balances: none ✅');
  else { console.log('  Negative asset balances:'); for (const h of neg) console.log('   ', h.date, h.account, money(h.balance)); }
  if (!des.length) console.log('  Holdings/balance desync: none ✅');
  else { console.log('  Holdings/balance desync:'); for (const h of des) console.log('   ', h.account, 'balance', money(h.balance), 'holdings', money(h.holdings), 'Δ', money(h.diff)); }

  if (a.ledgers.length) {
    console.log('\n=== Account ledgers (balance change by action type) ===');
    for (const L of a.ledgers) {
      console.log(`\n  ### ${L.account}   first drain ${L.firstDrain ?? '—'} · last non-zero ${L.lastNonZero ?? '—'}`);
      const line = rows => rows.map(r => `${r.type}(${r.count}, ${money(r.total)})`).join('  ') || '(none)';
      console.log('    DECREASES:', line(L.decreases));
      console.log('    INCREASES:', line(L.increases));
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.file) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(opts.file, 'utf8'));
  } catch (e) {
    console.error(`Failed to read ${opts.file}: ${e.message}`);
    process.exit(1);
  }

  const cfgs = Array.isArray(parsed.scenarios) ? parsed.scenarios
             : Array.isArray(parsed)           ? parsed
             : [parsed];
  const chosen = opts.first ? cfgs.slice(0, 1) : cfgs;
  const endDate = opts.to ? new Date(opts.to) : null;

  const audits = chosen.map(cfg => {
    const sim = runScenario(cfg, endDate);
    const audit = buildAudit(sim, cfg, opts.accounts);
    audit.file = basename(opts.file);
    return audit;
  });

  if (opts.json) {
    console.log(JSON.stringify(audits.length === 1 ? audits[0] : audits, null, 2));
  } else {
    for (const a of audits) printAudit(a);
  }
}

main();
