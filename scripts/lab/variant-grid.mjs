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
 * variant-grid.mjs — run an N-dimensional grid of scenario variants and table it.
 *
 * This replaces a family of near-identical hand-written grid drivers. They all did
 * the same three things — build a cross product of lever settings, fan it across
 * cores, render a matrix — and differed only in axis values and prose, so they
 * drifted: two of them disagreed about what "spend $10k" meant, which silently
 * made their numbers incomparable. Here the axes are DATA and the machinery is
 * shared, so two studies differ only where they mean to.
 *
 * Usage:
 *   node scripts/lab/variant-grid.mjs --spec <spec.json> [--scenario plan.json]
 *                                     [--workers 8] [--out results.json]
 *   node scripts/lab/variant-grid.mjs --spec scripts/specs/example-grid.json
 *
 * Options:
 *   --spec <file>      REQUIRED. Grid definition (see below).
 *   --scenario <file>  Base scenario export. Omitted ⇒ the built-in synthetic
 *                      default, which is fine for a smoke test and near-useless
 *                      for a real solvency question (see lib/scenario-source.mjs).
 *   --index <n>        Which scenario in the file (default 0).
 *   --workers <n>      Worker processes (default 8).
 *   --out <file>       Also write raw results as JSON, for re-reporting later.
 *   --json             Print raw results instead of tables.
 *
 * ─── the spec ────────────────────────────────────────────────────────────────
 *
 * {
 *   "title": "House price × sale date",
 *   "base":  { "retire": { "primary": 2032 }, "spendTotal": 9000 },
 *   "axes": {
 *     "price":  { "lever": "property.usHouseProperty.valueMult",
 *                 "values": [1.15, 1.0, 0.85], "labels": ["115%", "100%", "85%"] },
 *     "sale":   { "lever": "property.usHouseProperty.saleYear",
 *                 "values": [2032, 2036, null], "labels": ["2032", "2036", "never"] },
 *     "return": { "lever": "equityShift",
 *                 "values": [0, -0.01, -0.02], "labels": ["8%", "7%", "6%"] }
 *   },
 *   "report": {
 *     "rows": "price", "cols": "sale", "panels": [],
 *     "reduce": { "axis": "return", "pick": "last-passing" }
 *   }
 * }
 *
 * `base` is a lever bag (see lib/variant.mjs) applied to every cell. Each axis
 * names a DOTTED PATH into that same lever bag, so any lever is sweepable without
 * new code. `labels` are display-only and default to the raw values — give them
 * when the value is a delta but the reader wants the resulting level.
 *
 * ─── reduce: the part that makes this useful ──────────────────────────────────
 *
 * Without `reduce`, each cell is one run and the table shows pass/fail. That is
 * often uninformative: at a comfortable spending level EVERY cell passes, and a
 * grid where nothing fails carries no information.
 *
 * `reduce` turns a swept axis into a MEASURED FRONTIER per cell. `last-passing`
 * walks the reduce axis in spec order and reports the last value that survived, so
 * with the axis ordered:
 *   · descending returns  → the BREAK-EVEN RETURN: the worst market the plan absorbs
 *   · ascending spend     → the SUSTAINABLE CEILING: the most it can support
 * One primitive, and the direction you list values in chooses the question.
 *
 * Reported edge markers matter for honesty: `<lo` means even the first value failed
 * (frontier is off-grid low) and a trailing `+` means the last value still passed
 * (the true frontier is beyond the sweep). Neither is a number you should quote as
 * if it were measured.
 *
 * SCANNED, not bisected, deliberately: pass/fail is NOT guaranteed monotone along
 * these axes. Tax-year, residency and age-gate interactions can make one more year
 * of work, or one extra point of return, locally harmful. A bisection would return
 * a clean number from the wrong side of a non-monotone boundary; a scan reveals it,
 * and `--json` output plus the flip warning below surfaces it.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { loadBaseConfig, parseSourceArgs, describeSource } from '../lib/scenario-source.mjs';
import { runJobsParallel, parseWorkers } from '../lib/parallel.mjs';
import { table, money, note } from '../lib/format.mjs';

const USAGE = `
variant-grid.mjs — run an N-dimensional grid of scenario variants and table it.

  node scripts/lab/variant-grid.mjs --spec <spec.json> [options]

  --spec <file>      REQUIRED. Grid definition; see scripts/specs/example-grid.json.
  --scenario <file>  Base scenario export. Omitted => built-in synthetic default.
  --index <n>        Which scenario in the file (default 0).
  --workers <n>      Worker processes (default 8).
  --out <file>       Also write raw results as JSON.
  --json             Print raw results instead of tables.

Read the header of this file for the spec format and for what "reduce" does.
`;

const WORKER = new URL('../lib/grid-worker.mjs', import.meta.url).pathname;
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

if (argv.includes('-h') || argv.includes('--help') || !flag('--spec')) {
  console.log(USAGE);
  process.exit(flag('--spec') ? 0 : 2);
}

const spec = JSON.parse(readFileSync(flag('--spec'), 'utf8'));
const source = parseSourceArgs(argv);
const base = loadBaseConfig(source);

// ─── axis handling ───────────────────────────────────────────────────────────

const axisNames = Object.keys(spec.axes ?? {});
if (!axisNames.length) { console.error('spec has no axes'); process.exit(2); }

/** Display label for value j of an axis. */
const labelOf = (name, j) => {
  const ax = spec.axes[name];
  return String(ax.labels?.[j] ?? ax.values[j]);
};

/** Write `value` at a dotted path inside a lever bag, creating parents. */
function setLeverPath(levers, path, value) {
  const parts = path.split('.');
  let node = levers;
  for (const p of parts.slice(0, -1)) node = (node[p] ??= {});
  node[parts.at(-1)] = value;
}

/**
 * Cell id: axis indices joined. Indices rather than labels so a label containing
 * the separator, or two axis values that stringify alike (0.1 vs "0.1"), cannot
 * collide into one cell.
 */
const idOf = (idx) => axisNames.map(n => `${n}=${idx[n]}`).join('|');

function leversFor(idx) {
  const levers = structuredClone(spec.base ?? {});
  for (const name of axisNames) {
    setLeverPath(levers, spec.axes[name].lever, spec.axes[name].values[idx[name]]);
  }
  return levers;
}

/** Every combination of axis indices. */
function crossProduct() {
  let combos = [{}];
  for (const name of axisNames) {
    const next = [];
    for (const c of combos) {
      spec.axes[name].values.forEach((_, j) => next.push({ ...c, [name]: j }));
    }
    combos = next;
  }
  return combos;
}

const jobs = crossProduct().map(idx => ({ id: idOf(idx), levers: leversFor(idx), idx }));

// ─── run ─────────────────────────────────────────────────────────────────────

const results = await runJobsParallel({
  jobs: jobs.map(({ id, levers }) => ({ id, levers })),
  source, worker: WORKER, workers: parseWorkers(argv), label: 'grid cells',
});

const byId = new Map(results.map(r => [r.id, r]));
const errors = results.filter(r => r.error);

if (flag('--out')) {
  writeFileSync(flag('--out'), JSON.stringify({ spec, source: base.source, results }, null, 1));
  console.error(`raw results → ${flag('--out')}`);
}
if (argv.includes('--json')) {
  console.log(JSON.stringify({ spec, source: base.source, results }, null, 1));
  process.exit(0);
}

// ─── report ──────────────────────────────────────────────────────────────────

const rep = spec.report ?? {};
const rowAxis = rep.rows ?? axisNames[0];
const colAxis = rep.cols ?? axisNames[1] ?? null;
const reduceAxis = rep.reduce?.axis ?? null;
const panelAxes = (rep.panels ?? []).length
  ? rep.panels
  : axisNames.filter(n => n !== rowAxis && n !== colAxis && n !== reduceAxis);

for (const name of [rowAxis, colAxis, reduceAxis, ...panelAxes]) {
  if (name && !axisNames.includes(name)) {
    console.error(`report references unknown axis "${name}"`); process.exit(2);
  }
}

console.log('');
if (spec.title) console.log(`════ ${spec.title} ════`);
note(describeSource(base));
if (spec.notes) note(spec.notes);
if (errors.length) note(`** ${errors.length} of ${results.length} cells errored — shown as "?" — e.g. ${errors[0].error}`);

/**
 * Scan the reduce axis at fixed other-axis indices and report the frontier.
 * Also counts pass→fail flips, which is the non-monotonicity tell.
 */
function reduceCell(fixed) {
  const ax = spec.axes[reduceAxis];
  let lastPassing = -1, flips = 0, prev = null, missing = false;
  for (let j = 0; j < ax.values.length; j++) {
    const r = byId.get(idOf({ ...fixed, [reduceAxis]: j }));
    if (!r || r.error) { missing = true; continue; }
    if (!r.failed) lastPassing = j;
    if (prev !== null && r.failed !== prev) flips++;
    prev = r.failed;
  }
  if (missing && lastPassing < 0) return { text: '?', flips };
  if (lastPassing < 0) return { text: `<${labelOf(reduceAxis, 0)}`, flips, offGridLow: true };
  const atEnd = lastPassing === ax.values.length - 1;
  return { text: labelOf(reduceAxis, lastPassing) + (atEnd ? '+' : ''), flips, offGridHigh: atEnd };
}

/** Direct cell metric when there is no reduce axis. */
function directCell(fixed) {
  const r = byId.get(idOf(fixed));
  if (!r || r.error) return '?';
  if (rep.metric === 'netWorth') return money(r.netWorth);
  if (rep.metric === 'netLiq')   return money(r.netLiq);
  return r.failed ? `FAIL ${r.oofDate?.slice(0, 4) ?? ''}`.trim() : 'ok';
}

const warnings = [];

/** Enumerate panel index combinations. */
function panelCombos() {
  let combos = [{}];
  for (const name of panelAxes) {
    const next = [];
    for (const c of combos) spec.axes[name].values.forEach((_, j) => next.push({ ...c, [name]: j }));
    combos = next;
  }
  return combos;
}

for (const panel of panelCombos()) {
  const panelLabel = panelAxes.map(n => `${n} ${labelOf(n, panel[n])}`).join(', ');
  const rowLabels = spec.axes[rowAxis].values.map((_, j) => labelOf(rowAxis, j));
  const colLabels = colAxis ? spec.axes[colAxis].values.map((_, j) => labelOf(colAxis, j)) : ['value'];

  const cell = (rowLabel, colLabel) => {
    const ri = rowLabels.indexOf(rowLabel);
    const ci = colAxis ? colLabels.indexOf(colLabel) : null;
    const fixed = { ...panel, [rowAxis]: ri };
    if (colAxis) fixed[colAxis] = ci;

    if (!reduceAxis) return directCell(fixed);
    const { text, flips } = reduceCell(fixed);
    if (flips > 1) warnings.push(`${panelLabel ? panelLabel + ' / ' : ''}${rowAxis} ${rowLabel}`
      + `${colAxis ? ` / ${colAxis} ${colLabel}` : ''}: ${flips} pass↔fail flips along ${reduceAxis}`);
    return text;
  };

  table({
    title: [reduceAxis ? `frontier along ${reduceAxis}` : rep.metric ?? 'pass/fail', panelLabel]
      .filter(Boolean).join(' — '),
    rows: rowLabels, cols: colLabels, cell, corner: `${rowAxis}\\${colAxis ?? ''}`,
  });
}

if (reduceAxis) {
  console.log(`\n"${labelOf(reduceAxis, 0)}"-style entries are the last PASSING ${reduceAxis} value.`);
  console.log(`  "<${labelOf(reduceAxis, 0)}" = failed even at the first value (frontier below the sweep)`);
  console.log(`  trailing "+"  = still passing at the last value (frontier beyond the sweep)`);
}

if (warnings.length) {
  console.log('\n** NON-MONOTONE CELLS — the frontier is not a single boundary here.');
  console.log('   The reported value is the last passing one, but there is a passing');
  console.log('   region beyond a failing one. Inspect with --json before quoting these.');
  for (const w of new Set(warnings)) console.log(`   · ${w}`);
}
