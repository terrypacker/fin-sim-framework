#!/usr/bin/env node
/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * diff-mutation-tracker.mjs — design 78 §5.4 gate.
 *
 * `_processReducers` records a reducer's `stateDelta` two ways. `MutationTracker`
 * records field writes as they happen (cheap). Everything else deep-clones state
 * and runs `diffStates` afterwards (expensive — 12,976 clone+diff pairs on a
 * 44-year run). Phase 2 wants to move reducers onto the tracker.
 *
 * That is only safe if the two agree. They agree only when every write a reducer
 * makes passes through a seam that records — and a reducer whose writes are
 * PARTIALLY recorded produces a journal that still looks well-formed and quietly
 * under-foots. The design 16 drill reports and `npm run crossfoot` read
 * `stateDelta`, so that failure is invisible until a tax total is wrong.
 *
 * So: run a real scenario with BOTH strategies active on every reducer and
 * compare. This is the instrument that says which reducers may move, and it must
 * stay green as seams are added.
 *
 * Comparison is by NET EFFECT PER FIELD, not entry-for-entry: a reducer that
 * writes one field twice yields two tracker records but one diff entry, and both
 * are correct. Collapsing to first-before / last-after is the honest comparison.
 *
 * Usage:
 *   node scripts/dev/diff-mutation-tracker.mjs [scenario.json] [--to YYYY-MM-DD]
 *   node scripts/dev/diff-mutation-tracker.mjs --verbose    # list differing fields
 *
 * Exit code is non-zero when any reducer that the engine currently TRACKS
 * disagrees with the diff — that is a live correctness bug. Reducers that still
 * take the clone path are reported but do not fail the run; they are the backlog.
 */

import { readFileSync } from 'node:fs';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { BaseScenario }    from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { Simulation }      from '../../src/simulation-framework/simulation.js';
import { deepClone, diffStates, MutationTracker } from '../../src/simulation-framework/state-utils.js';
import { FieldReducer, AccountTransactionReducer } from '../../src/simulation-framework/reducers.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';

// ─── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const opts = { file: null, to: null, verbose: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--to') opts.to = argv[++i];
  else if (a === '--verbose') opts.verbose = true;
  else if (a === '-h' || a === '--help') {
    console.log('Usage: node scripts/dev/diff-mutation-tracker.mjs [scenario.json] [--to YYYY-MM-DD] [--verbose]');
    process.exit(0);
  } else opts.file = a;
}

// ─── Comparison ───────────────────────────────────────────────────────────────

/**
 * Two-level shallow copy: new top-level object, plus a fresh shallow copy of each
 * top-level object/array value. Preserves any field mutated in place ONE level
 * down (`account.balance = …`) while costing a few dozen small spreads instead of
 * a full recursive clone.
 */
function shallowCopyDepth2(state) {
  const out = {};
  for (const k in state) {
    const v = state[k];
    if (v !== null && typeof v === 'object') out[k] = Array.isArray(v) ? [...v] : { ...v };
    else out[k] = v;
  }
  return out;
}

/** Collapse a list of {field, before, after} into field → {before, after} net effect. */
function netByField(records) {
  const net = new Map();
  for (const r of records ?? []) {
    const cur = net.get(r.field);
    if (cur) cur.after = r.after;             // later write wins
    else net.set(r.field, { before: r.before, after: r.after });
  }
  // A field written back to its original value is not a net change.
  for (const [f, v] of [...net]) {
    if (Object.is(v.before, v.after)) net.delete(f);
  }
  return net;
}

const sameValue = (a, b) =>
  Object.is(a, b) || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Compare tracker output against diff output; returns a list of disagreements. */
function compare(tracked, diffed) {
  const t = netByField(tracked);
  const d = netByField(diffed);
  const problems = [];
  for (const [field, dv] of d) {
    const tv = t.get(field);
    if (!tv)                                   problems.push({ kind: 'missed', field, expected: dv.after });
    else if (!sameValue(tv.after, dv.after))   problems.push({ kind: 'wrong-after', field, got: tv.after, expected: dv.after });
    else if (!sameValue(tv.before, dv.before)) problems.push({ kind: 'wrong-before', field, got: tv.before, expected: dv.before });
  }
  for (const [field, tv] of t) {
    if (!d.has(field)) problems.push({ kind: 'phantom', field, got: tv.after });
  }
  return problems;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

function buildSim() {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  let cfg;
  if (opts.file) {
    const raw = JSON.parse(readFileSync(opts.file, 'utf8'));
    cfg = (raw.scenarios ?? [raw])[0];
  } else {
    cfg = IntlRetirementScenario.buildDefaultConfig({});
  }
  const scenario = new BaseScenario({
    context:      services.simulationContext,
    initialState: cfg.initialState ?? {},
    simStart:     new Date(cfg.simStart),
    simEnd:       new Date(cfg.simEnd),
  });
  // Needs the journal path live so `useTracker` is exercised exactly as in a UI run.
  scenario.buildSim({ telemetry: 'full' });
  new ScenarioLoader().load(cfg, services);
  return { sim: scenario.sim, cfg };
}

const stats = new Map(); // reducerClass → { tracked, runs, agree, disagree, problems: Map<kind|field, n> }

function statFor(name, isTracked) {
  let s = stats.get(name);
  if (!s) { s = { name, tracked: isTracked, runs: 0, agree: 0, disagree: 0, problems: new Map() }; stats.set(name, s); }
  return s;
}

const { sim, cfg } = buildSim();

// Wrap every reducer's fn: run BOTH strategies and compare.
const origProcess = Simulation.prototype._processReducers;
Simulation.prototype._processReducers = function (action, startIdx, reducers, ...rest) {
  const wrapped = reducers.map((rw) => {
    const r    = rw.reducer;
    const name = r?.constructor?.name ?? 'plain-fn';
    const isTracked = (r instanceof FieldReducer) || (r instanceof AccountTransactionReducer);
    return { ...rw, fn: (state, act, date) => {
      const before        = deepClone(state);
      const shallowBefore = { ...state };   // §5.5 hypothesis: is a shallow copy enough?
      const shallow2      = shallowCopyDepth2(state); // …or one level deeper?
      MutationTracker.begin();
      const res     = rw.fn(state, act, date);
      const tracked = MutationTracker.flush();
      let   after   = (res && res.state) ? res.state : (res || state);
      // `_processReducers` strips the `next` key (emitted actions) before
      // assigning to this.state, so it never reaches the diff. Mirror that, or
      // every emitting reducer shows a phantom `next` field.
      if (after && typeof after === 'object' && 'next' in after) {
        const { next: _discard, ...clean } = after;
        after = clean;
      }
      const diffed  = diffStates(before, after);

      const s = statFor(name, isTracked);
      s.runs++;
      const problems = compare(tracked, diffed);
      if (problems.length === 0) s.agree++;
      else {
        s.disagree++;
        for (const p of problems) {
          const key = `${p.kind}:${p.field}`;
          s.problems.set(key, (s.problems.get(key) ?? 0) + 1);
        }
      }

      // §5.5: would a SHALLOW top-level copy have produced the same diff? It does
      // whenever the reducer is copy-on-write, because unchanged top-level keys
      // keep their reference (diffStates short-circuits on `b === a`) and changed
      // ones get a fresh object. It fails only for in-place mutation, where the
      // snapshot aliases the mutated object.
      const shallow2Diff = diffStates(shallow2, after);
      const shallow2Problems = compare(
        [...netByField(shallow2Diff)].map(([field, v]) => ({ field, ...v })), diffed);
      if (shallow2Problems.length === 0) s.shallow2Ok = (s.shallow2Ok ?? 0) + 1;
      else {
        s.shallow2Bad = (s.shallow2Bad ?? 0) + 1;
        for (const p of shallow2Problems) {
          const key = `${p.kind}:${p.field}`;
          s.shallow2Problems ??= new Map();
          s.shallow2Problems.set(key, (s.shallow2Problems.get(key) ?? 0) + 1);
        }
      }

      const shallowDiff = diffStates(shallowBefore, after);
      const shallowProblems = compare(
        [...netByField(shallowDiff)].map(([field, v]) => ({ field, ...v })),
        diffed);
      if (shallowProblems.length === 0) s.shallowOk = (s.shallowOk ?? 0) + 1;
      else {
        s.shallowBad = (s.shallowBad ?? 0) + 1;
        for (const p of shallowProblems) {
          const key = `${p.kind}:${p.field}`;
          s.shallowProblems ??= new Map();
          s.shallowProblems.set(key, (s.shallowProblems.get(key) ?? 0) + 1);
        }
      }
      return res;
    } };
  });
  return origProcess.call(this, action, startIdx, wrapped, ...rest);
};

const { log, warn } = console;
console.log = () => {}; console.warn = () => {};
sim.stepTo(opts.to ? new Date(opts.to) : new Date(cfg.simEnd));
console.log = log; console.warn = warn;

// ─── Report ───────────────────────────────────────────────────────────────────

const rows = [...stats.values()].sort((a, b) => (b.disagree - a.disagree) || (b.runs - a.runs));
const trackedRows   = rows.filter(r => r.tracked);
const untrackedRows = rows.filter(r => !r.tracked);

const pct = (n, d) => d ? `${(n / d * 100).toFixed(0)}%` : '—';
function printSection(title, list) {
  console.log(`\n${title}`);
  console.log('  runs   agree  disagree  reducer');
  console.log('  ' + '─'.repeat(60));
  for (const r of list) {
    console.log(
      `  ${String(r.runs).padStart(5)}  ${String(r.agree).padStart(5)}  ${String(r.disagree).padStart(8)}  ${r.name}` +
      (r.disagree ? `   (${pct(r.disagree, r.runs)} differ)` : ''));
    if (opts.verbose && r.problems.size) {
      for (const [k, n] of [...r.problems].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        console.log(`           ${String(n).padStart(6)}x  ${k}`);
      }
    }
  }
}

console.log(`scenario: ${opts.file ?? 'IntlRetirementScenario (default)'}`);
console.log(`reducer invocations: ${rows.reduce((s, r) => s + r.runs, 0)}`);

printSection('TRACKED today (engine already trusts MutationTracker here):', trackedRows);
printSection('UNTRACKED today (still pays deepClone + diffStates):', untrackedRows);

const brokenTracked   = trackedRows.filter(r => r.disagree > 0);
const readyUntracked  = untrackedRows.filter(r => r.disagree === 0);
const blockedUntracked = untrackedRows.filter(r => r.disagree > 0);

console.log(`\n─── summary ───`);
console.log(`  tracked reducers disagreeing with the diff : ${brokenTracked.length}  ${brokenTracked.length ? '← LIVE BUG' : '✅'}`);
console.log(`  untracked reducers ready to move          : ${readyUntracked.length}`);
console.log(`  untracked reducers still blocked          : ${blockedUntracked.length}`);
if (readyUntracked.length) {
  const moves = readyUntracked.reduce((s, r) => s + r.runs, 0);
  console.log(`  clone+diff pairs those would remove       : ${moves}`);
}
if (!opts.verbose && (brokenTracked.length || blockedUntracked.length)) {
  console.log(`\n  (re-run with --verbose to see the differing fields)`);
}

// ─── §5.5: shallow-snapshot viability ─────────────────────────────────────────
const shallowRows = untrackedRows.filter(r => (r.shallowBad ?? 0) > 0);
const shallowOkRuns  = untrackedRows.reduce((s, r) => s + (r.shallowOk  ?? 0), 0);
const shallowBadRuns = untrackedRows.reduce((s, r) => s + (r.shallowBad ?? 0), 0);
console.log(`\n─── shallow-snapshot viability (design 78 §5.5) ───`);
console.log(`  untracked runs where { ...state } gives the SAME diff as deepClone : ${shallowOkRuns}`);
console.log(`  runs where it does NOT (in-place mutation)                        : ${shallowBadRuns}`);
console.log(`  reducer classes blocking it                                       : ${shallowRows.length}`);
const s2Rows = untrackedRows.filter(r => (r.shallow2Bad ?? 0) > 0);
const s2Ok  = untrackedRows.reduce((s, r) => s + (r.shallow2Ok  ?? 0), 0);
const s2Bad = untrackedRows.reduce((s, r) => s + (r.shallow2Bad ?? 0), 0);
console.log(`  depth-2 copy: same diff : ${s2Ok}   differs : ${s2Bad}   blocking classes : ${s2Rows.length}`);
for (const r of s2Rows.sort((a, b) => b.shallow2Bad - a.shallow2Bad)) {
  console.log(`     [depth2] ${String(r.shallow2Bad).padStart(5)}x  ${r.name}`);
  for (const [k, n] of [...(r.shallow2Problems ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    console.log(`                 ${String(n).padStart(5)}x  ${k}`);
  }
}
for (const r of shallowRows.sort((a, b) => b.shallowBad - a.shallowBad)) {
  console.log(`     ${String(r.shallowBad).padStart(5)}x  ${r.name}`);
  if (opts.verbose) {
    for (const [k, n] of [...(r.shallowProblems ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`              ${String(n).padStart(5)}x  ${k}`);
    }
  }
}

process.exit(brokenTracked.length ? 1 : 0);
