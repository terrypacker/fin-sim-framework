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
 * Run `--help` for the flags; the spec in this file is the only copy of them.
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

import { loadBaseConfig, describeSource } from '../lib/scenario-source.mjs';
import { parseFlags } from '../lib/cli.mjs';
import { runJobsParallel } from '../lib/parallel.mjs';
import { buildGridModel, makeIdOf } from '../lib/grid-report.mjs';
import { table, note } from '../lib/format.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/lab/variant-grid.mjs --spec <spec.json> [options]\n\n'
       + 'variant-grid — run every cell of a declarative lever grid.',
  spec:     { type: 'string', help: 'the grid spec' },
  out:      { type: 'string', help: 'write the results JSON here (what paired-delta reads)' },
  workers:  { type: 'number', default: 8, help: 'worker processes' },
  scenario: { type: 'string', help: 'base scenario export; omitted ⇒ the synthetic default' },
  index:    { type: 'number', default: 0, help: 'scenario index in that file' },
  json:     { type: 'flag',   help: 'machine-readable output' },
});

if (!opts.spec) {
  console.error('\nvariant-grid needs --spec <spec.json>.  (-h for options)\n');
  process.exit(2);
}

const spec = JSON.parse(readFileSync(opts.spec, 'utf8'));

const source = { file: opts.scenario, index: opts.index };
const base = loadBaseConfig(source);

// ─── axis handling ───────────────────────────────────────────────────────────

const axisNames = Object.keys(spec.axes ?? {});
if (!axisNames.length) { console.error('spec has no axes'); process.exit(2); }

/** Write `value` at a dotted path inside a lever bag, creating parents. */
function setLeverPath(levers, path, value) {
  const parts = path.split('.');
  let node = levers;
  for (const p of parts.slice(0, -1)) node = (node[p] ??= {});
  node[parts.at(-1)] = value;
}

// Shared with the reader in lib/grid-report.mjs — see makeIdOf's note.
const idOf = makeIdOf(axisNames);

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
  source, worker: WORKER, workers: Math.max(1, opts.workers), label: 'grid cells',
});

if (opts.out) {
  writeFileSync(opts.out, JSON.stringify({ spec, source: base.source, results }, null, 1));
  console.error(`raw results → ${opts.out}`);
}
if (opts.json) {
  console.log(JSON.stringify({ spec, source: base.source, results }, null, 1));
  process.exit(0);
}

// ─── report ──────────────────────────────────────────────────────────────────
//
// The reduction itself lives in lib/grid-report.mjs so this terminal view and the
// HTML study report cannot drift into disagreeing about what a cell means. Only the
// rendering is local.

let model;
try {
  model = buildGridModel({ spec, results });
} catch (err) {
  console.error(err.message); process.exit(2);
}

const { rowAxis, colAxis, reduceAxis } = model;

console.log('');
if (model.title) console.log(`════ ${model.title} ════`);
note(describeSource(base));
if (model.notes) note(model.notes);
if (model.errors) note(`** ${model.errors} of ${model.total} cells errored — shown as "?" — e.g. ${model.firstError}`);

for (const panel of model.panels) {
  table({
    title: [model.metric, panel.label].filter(Boolean).join(' — '),
    rows: panel.rows, cols: panel.cols,
    cell: (rowLabel, colLabel) =>
      panel.cells[panel.rows.indexOf(rowLabel)][panel.cols.indexOf(colLabel)].text,
    corner: `${rowAxis}\\${colAxis ?? ''}`,
  });
}

if (reduceAxis) {
  console.log(`\n"${model.labelOf(reduceAxis, 0)}"-style entries are the last PASSING ${reduceAxis} value.`);
  console.log(`  "<${model.labelOf(reduceAxis, 0)}" = failed even at the first value (frontier below the sweep)`);
  console.log(`  trailing "+"  = still passing at the last value (frontier beyond the sweep)`);
}

if (model.warnings.length) {
  console.log('\n** NON-MONOTONE CELLS — the frontier is not a single boundary here.');
  console.log('   The reported value is the last passing one, but there is a passing');
  console.log('   region beyond a failing one. Inspect with --json before quoting these.');
  for (const w of model.warnings) console.log(`   · ${w}`);
}
