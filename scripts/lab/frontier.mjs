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
 * frontier.mjs — find the edge of solvency along ONE lever.
 *
 * A single pass/fail run answers almost nothing: the interesting quantity is never
 * "does this plan work" but "how much room does it have". This tool converts a
 * lever into the three units a plan is actually judged in:
 *
 *   spend      the highest sustainable monthly spend  → what you get to live on
 *   return     the lowest survivable equity return    → how much market
 *                                                       disappointment it absorbs
 *   retire     the earliest safe retirement year      → how many working years it costs
 *
 * All three are the same search over a different lever, and each is a number you can
 * hold an opinion about, unlike a pass/fail flag or a terminal net worth.
 *
 * Usage:
 *   node scripts/lab/frontier.mjs spend  [--lo 5000] [--hi 20000] [--step 500]
 *   node scripts/lab/frontier.mjs return [--lo 0]    [--hi 0.10] [--step 0.0025]
 *   node scripts/lab/frontier.mjs retire [--lo 2027] [--hi 2050]
 *
 *   --levers <json|file>  lever bag applied to every probe (see lib/variant.mjs)
 *   --person <id>         whose retirement year `retire` moves (default primary)
 *   --scenario <file>     base scenario export; omitted => synthetic default
 *   --index <n>           scenario index in that file (default 0)
 *   --bisect              binary search instead of a full scan (see the warning)
 *   --json                machine-readable result
 *
 * Examples:
 *   node scripts/lab/frontier.mjs spend --scenario plan.json --lo 6000 --hi 15000
 *   node scripts/lab/frontier.mjs return --scenario plan.json \
 *        --levers '{"retire":{"primary":2032},"spendTotal":9000}'
 *
 * ─── scan vs bisect ──────────────────────────────────────────────────────────
 *
 * The default is a full SCAN, which costs a run per step and is the honest choice:
 * solvency is NOT guaranteed monotone in any of these levers. Tax-year boundaries,
 * residency changes and age gates can make one more year of work — or one extra
 * point of return — locally harmful. A scan finds every flip and reports how many
 * there were.
 *
 * `--bisect` is ~5× cheaper and assumes monotonicity. When the scan reports more
 * than one flip, a bisected answer on that lever is not trustworthy: it will return
 * a clean-looking number from whichever side of the boundary it happened to land.
 * Use it to explore, then confirm with a scan.
 *
 * ─── one caveat that invalidates the `spend` answer ──────────────────────────
 *
 * Under an ADAPTIVE spending strategy (GUARDRAIL and friends) this tool is
 * measuring the wrong thing. A proportional rule cannot run out of money — it
 * responds to depletion by spending less — so the OOF flag stops binding and the
 * ceiling it reports is an artefact. Use `spending-trace.mjs` there instead: the
 * question becomes "at what standard of living did it survive", which is a series,
 * not a threshold.
 */

import { readFileSync, existsSync } from 'node:fs';

import { loadBaseConfig, parseSourceArgs, describeSource } from '../lib/scenario-source.mjs';
import { buildVariant, baseEquityRate } from '../lib/variant.mjs';
import { run } from '../lib/run.mjs';
import { money, pct, columns } from '../lib/format.mjs';

const MODES = {
  spend: {
    lever: (levers, v) => ({ ...levers, spendTotal: v }),
    // ascending: the frontier is the HIGHEST passing value
    defaults: { lo: 5000, hi: 20000, step: 500 }, direction: 'max',
    fmt: money, unit: '$/mo all-in (base-year dollars)',
    label: 'SUSTAINABLE SPEND CEILING',
  },
  return: {
    // equityShift is a delta off the scenario's own rates, so the frontier is
    // reported as the shift AND as the resulting brokerage rate.
    lever: (levers, v, ctx) => ({ ...levers, equityShift: v - ctx.baseRate }),
    defaults: { lo: 0, hi: 0.10, step: 0.0025 }, direction: 'min',
    fmt: (v) => pct(v, 2), unit: 'nominal equity return',
    label: 'BREAK-EVEN RETURN',
  },
  retire: {
    lever: (levers, v, ctx) => ({ ...levers, retire: { ...(levers.retire ?? {}), [ctx.person]: v } }),
    defaults: { lo: 2027, hi: 2050, step: 1 }, direction: 'min',
    fmt: (v) => String(v), unit: 'retirement year',
    label: 'EARLIEST SAFE RETIREMENT',
  },
};

// ─── CLI ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const mode = argv[0];
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const num = (n, d) => { const v = flag(n); return v != null ? Number(v) : d; };

if (!MODES[mode]) {
  console.error(`usage: frontier.mjs <${Object.keys(MODES).join('|')}> [options]  (see file header)`);
  process.exit(2);
}

const M = MODES[mode];
const lo = num('--lo', M.defaults.lo);
const hi = num('--hi', M.defaults.hi);
const step = num('--step', M.defaults.step);
const bisect = argv.includes('--bisect');
const person = flag('--person') ?? 'primary';

let levers = {};
const lv = flag('--levers');
if (lv) levers = JSON.parse(existsSync(lv) ? readFileSync(lv, 'utf8') : lv);

const source = parseSourceArgs(argv);
const base = loadBaseConfig(source);

const ctx = { person, baseRate: baseEquityRate(base.cfg) };
const probe = (v) => run(buildVariant(base.cfg, M.lever(levers, v, ctx)));

// ─── search ──────────────────────────────────────────────────────────────────

/** Values to test, ordered so that "later" means "more demanding". */
function ladder() {
  const out = [];
  if (M.direction === 'max') for (let v = lo; v <= hi + 1e-9; v += step) out.push(round(v));
  else                       for (let v = hi; v >= lo - 1e-9; v -= step) out.push(round(v));
  return out;
}

/**
 * Clean accumulated float error only — do NOT snap to the step grid.
 *
 * Snapping (`Math.round(v / step) * step`) looks equivalent and is not: with
 * lo=0.01, step=0.02 it rounds the requested 0.05 up to 0.06, so the tool silently
 * probes values the caller never asked for and reports a frontier outside the stated
 * range. Repeated addition needs the float noise removed, nothing more.
 */
const DECIMALS = Math.max(0, -Math.floor(Math.log10(step)) + 2);
const round = (v) => Number(v.toFixed(step < 1 ? DECIMALS : 0));

function scan() {
  const trace = [];
  let frontier = null, flips = 0, prev = null;
  for (const v of ladder()) {
    const r = probe(v);
    trace.push({ value: v, ...r });
    if (!r.failed) frontier = v;
    if (prev !== null && r.failed !== prev) flips++;
    prev = r.failed;
  }
  return { frontier, trace, flips, method: 'scan' };
}

/**
 * Binary search on the pass/fail boundary. Assumes monotone solvency; see header.
 * Anchored on the two endpoints so an entirely-passing or entirely-failing range
 * is reported as off-grid rather than as a spurious interior boundary.
 */
function bisectSearch() {
  const first = ladder()[0], last = ladder().at(-1);
  const trace = [];
  const test = (v) => { const r = probe(v); trace.push({ value: v, ...r }); return !r.failed; };

  if (!test(first)) return { frontier: null, trace, flips: 0, method: 'bisect', offGrid: 'low' };
  if (test(last))   return { frontier: last, trace, flips: 0, method: 'bisect', offGrid: 'high' };

  let pass = first, fail = last;
  while (Math.abs(fail - pass) > step + 1e-9) {
    const mid = round((pass + fail) / 2);
    if (mid === pass || mid === fail) break;
    if (test(mid)) pass = mid; else fail = mid;
  }
  return { frontier: pass, trace, flips: 1, method: 'bisect' };
}

const started = Date.now();
const res = bisect ? bisectSearch() : scan();
const secs = ((Date.now() - started) / 1000).toFixed(0);

// ─── report ──────────────────────────────────────────────────────────────────

if (argv.includes('--json')) {
  console.log(JSON.stringify({ mode, source: base.source, levers, lo, hi, step, ...res }, null, 1));
  process.exit(0);
}

console.log(`\n════ ${M.label} ════`);
console.log(describeSource(base));
console.log(`lever: ${mode} over ${M.fmt(lo)}…${M.fmt(hi)} step ${mode === 'return' ? pct(step, 2) : step}`
  + `   method: ${res.method}   ${res.trace.length} runs in ${secs}s`);
if (Object.keys(levers).length) console.log(`held: ${JSON.stringify(levers)}`);
if (mode === 'return') console.log(`scenario's own equity rate: ${pct(ctx.baseRate, 2)}`);

columns({
  rows: res.trace,
  columns: [
    { head: mode.toUpperCase(), get: r => M.fmt(r.value), width: 14 },
    { head: 'RESULT', get: r => (r.failed ? 'FAIL' : 'ok'), width: 9 },
    { head: 'OOF DATE', get: r => r.oofDate ?? '—', width: 13 },
    { head: 'DEFICIT', get: r => money(r.deficit), width: 15 },
    { head: 'NET WORTH', get: r => money(r.netWorth), width: 17 },
    { head: 'NET LIQ', get: r => money(r.netLiq), width: 16 },
  ],
});

console.log('');
if (res.frontier == null) {
  console.log(`→ NO ${mode} value in the swept range survives. The frontier is beyond `
    + `${M.fmt(M.direction === 'max' ? lo : hi)} — widen the range.`);
} else {
  const atEdge = res.frontier === (M.direction === 'max' ? hi : lo);
  console.log(`→ ${M.label}: ${M.fmt(res.frontier)}  (${M.unit})`);
  if (atEdge) {
    console.log(`  ** this is the edge of the swept range — the true frontier is further out,`);
    console.log(`     so treat it as "at least this good", not as a measurement.`);
  }
}

if (res.flips > 1) {
  console.log(`\n** NON-MONOTONE: ${res.flips} pass↔fail flips along ${mode}.`);
  console.log(`   Solvency is not a single boundary here — there is a passing region beyond a`);
  console.log(`   failing one, so the headline number understates what is reachable. This is`);
  console.log(`   usually a tax-year, residency or age-gate interaction and is worth`);
  console.log(`   understanding before acting on it. A --bisect answer here would be wrong.`);
}
if (bisect && res.flips <= 1) {
  console.log(`\n(bisect assumed monotonicity and did not verify it; confirm with a full scan`);
  console.log(` before quoting this number.)`);
}
