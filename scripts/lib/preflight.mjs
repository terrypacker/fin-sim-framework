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
 * preflight.mjs — prove a study's axes MOVE before the grid runs.
 *
 * ─── the failure this exists to catch ────────────────────────────────────────
 *
 * Not slowness. A grid that **completes, looks reasonable, and measured nothing**.
 * It has happened repeatedly and it has never once looked like a bug:
 *
 *   · a `drawdownSequence` authored with `key` instead of `name` was dropped on the
 *     way to the compiler; every arm came back byte-identical (offset-bond-pool)
 *   · a mistyped `--shock` silently ran a no-crash column (offset-bond-pool)
 *   · a facility-SIZE axis moved nothing because the offset was not in the drawdown
 *     queue, so every cell that differed only in size was the same run
 *     (offset-bucket-study, which needed a whole throwaway probe to establish it)
 *   · `buildSim()` runs before `ScenarioLoader.load()`, so a scenario option read
 *     at construction time is read from a cfg that does not have it yet
 *   · the two param stores: a workbench export populates `cfg.params`, the synthetic
 *     default populates only `cfg.parameters`, and code that writes one is silently
 *     inert against the other
 *
 * Every one produced a confident, wrong answer **of exactly the right shape**. An
 * inert axis does not error and does not look like noise — it looks like a finding
 * ("the lever doesn't matter"), which is the one conclusion nobody re-checks.
 *
 * So this checks the axes CHANGE THE ANSWER, not that the code runs.
 *
 * ─── what it does ────────────────────────────────────────────────────────────
 *
 *   1. `checks`   — static assertions about the base scenario, so a study states
 *                   the settings its writeup claims rather than assuming them
 *   2. `landing`  — each lever REACHED `sim.state`, on a short run: the cheap check
 *                   that catches a dropped field before an expensive one catches it
 *   3. rates      — every foreign account has an FX rate, so no cut is priced 1:1
 *                   (see `cuts.assertRatesSeeded`)
 *   4. row axis   — corner rows produce DIFFERENT answers at a fixed column
 *   5. col axis   — corner columns produce DIFFERENT answers at a fixed row
 *   6. cost       — one cell timed, so the grid's price is known before it starts
 *
 * Steps 4 and 5 are the point. 1-3 catch a lever that never arrived; 4-5 catch a
 * lever that arrived and does nothing, which is the failure that survives review.
 *
 * ─── usage ───────────────────────────────────────────────────────────────────
 *
 *   import { preflight } from '../../scripts/lib/preflight.mjs';
 *   import { ROWS, COLUMNS, applyCell, BASE } from './study-config.mjs';
 *
 *   await preflight({
 *     title: 'OFFSET BOND POOL',
 *     base: BASE, rows: ROWS, cols: COLUMNS, applyCell,
 *     probeTo: '2029-12-31',
 *     checks:  [['horizon ends 2042', String(BASE.simEnd).startsWith('2042')]],
 *     landing: [{ label: 'drawdownSequence reached state',
 *                 read: sim => sim.state.drawdownSequence?.length ?? 0,
 *                 expect: n => n > 0 }],
 *   });   // exits non-zero if anything failed
 *
 * Keep study-specific label checks (does the "6 year" row REALISE six years?) in the
 * study's own smoke script; they are the part that cannot generalise.
 */

import { openSim, quiet, summarize } from './run.mjs';
import { assertRatesSeeded } from './cuts.mjs';

/**
 * A running tally of pass/fail checks that prints as it goes.
 *
 * Prints immediately rather than collecting, because a preflight that throws on
 * check 7 should still have shown you checks 1-6 — the failure is usually explained
 * by something that passed just above it.
 */
export function createGate(title) {
  let failures = 0;
  return {
    section(name) { console.log(`\n${name}`); },
    check(ok, label, detail = '') {
      console.log(`  ${ok ? '✔' : '✘'} ${label}${detail ? `  ${detail}` : ''}`);
      if (!ok) failures++;
      return ok;
    },
    get failures() { return failures; },
    /** Print the verdict and exit non-zero if anything failed. */
    finish(what = 'the grid') {
      console.log(failures === 0
        ? `\nPREFLIGHT PASSED — safe to run ${what}.\n`
        : `\nPREFLIGHT FAILED — ${failures} check(s). Do NOT run ${what} until these are fixed.\n`);
      if (failures > 0) process.exitCode = 1;
      return failures;
    },
    title,
  };
}

/** The earlier of `date` and the cfg's own simEnd — `stepTo` past simEnd throws. */
function clampToHorizon(cfg, date) {
  const end = new Date(cfg.simEnd);
  const at = new Date(date);
  return at > end ? end : at;
}

/**
 * Run one cell to `to`, returning the sim and its summary row.
 *
 * Exported because a study's own extra checks (does this row realise the cover its
 * LABEL claims?) need the same cell, run the same way, or they are checking
 * something else.
 */
export function runCell(cfg, { to = null, telemetry = 'off', checkRates = true } = {}) {
  const sim = openSim(cfg, { telemetry });
  const landedState = sim.state;
  quiet(() => sim.stepTo(clampToHorizon(cfg, to ?? cfg.simEnd)));
  if (checkRates) assertRatesSeeded(sim.state);
  return { sim, landedState, row: summarize(sim) };
}

/**
 * The axis-liveness gate. See the module header.
 *
 * @param {object}   o
 * @param {string}   o.title
 * @param {object}   o.base                  base cfg; never mutated
 * @param {object[]} o.rows                  axis 1, each `{id, label?}`
 * @param {object[]} o.cols                  axis 2, each `{id, label?}`
 * @param {(cfg:object,row:object,col:object)=>object} o.applyCell
 *        mutates and returns a CLONE — the gate clones for you before calling.
 * @param {string|Date} [o.probeTo]          short-horizon date for the landing checks;
 *        defaults to simEnd, but a near date makes them near-free.
 * @param {Array<[string, boolean, string?]>} [o.checks=[]]
 *        static `[label, ok, detail]` assertions about the base scenario.
 * @param {Array<{label:string, read:(sim:object,cfg:object)=>any, expect:(v:any)=>boolean, format?:Function}>} [o.landing=[]]
 *        per-lever "it reached state" checks, run on the probe cell.
 * @param {(row:object)=>number} [o.measure]  the answer the axes must move.
 *        Defaults to `netLiq`. Pass an explicit one when the study's headline is
 *        something else — an axis can move net liquidity and not move YOUR metric.
 * @param {number} [o.probeRow=0] / [o.probeCol=0] which cell the landing checks use.
 * @returns {Promise<{failures:number, perCellMs:number, cells:number}>}
 */
export async function preflight({
  title,
  base,
  rows,
  cols,
  applyCell,
  probeTo = null,
  checks = [],
  landing = [],
  measure = (row) => row.netLiq,
  probeRow = 0,
  probeCol = 0,
} = {}) {
  const gate = createGate(title);
  console.log(`\n${title} — PREFLIGHT  ·  ${rows.length} rows × ${cols.length} cols`);

  const cell = (row, col) => applyCell(structuredClone(base), row, col);
  const name = (x) => x.label ?? x.id;

  if (checks.length) {
    gate.section('1. the base scenario is what the writeup claims');
    for (const [label, ok, detail] of checks) gate.check(ok, label, detail ?? '');
  }

  if (landing.length) {
    gate.section(`2. the levers land in sim.state${probeTo ? ` (short run to ${probeTo})` : ''}`);
    const cfg = cell(rows[probeRow], cols[probeCol]);
    const { sim } = runCell(cfg, { to: probeTo });
    for (const l of landing) {
      let v, ok;
      try { v = l.read(sim, cfg); ok = !!l.expect(v); } catch (e) { v = e.message; ok = false; }
      gate.check(ok, l.label, l.format ? l.format(v) : String(v));
    }
  }

  gate.section('3. FX rates are seeded for every foreign account');
  try {
    const { sim } = runCell(cell(rows[probeRow], cols[probeCol]), { to: probeTo });
    assertRatesSeeded(sim.state);
    gate.check(true, 'every foreign account has a rate', 'no cut is priced 1:1');
  } catch (e) {
    gate.check(false, 'every foreign account has a rate', e.message);
  }

  // ── the axes move ──────────────────────────────────────────────────────────
  // Corner cells only. Two rows that differ prove the axis is wired; proving every
  // row differs is the grid's own job, and this has to stay cheap enough to run
  // every time or it will not be run at all.
  const t0 = Date.now();
  const anchorCol = cols[probeCol];
  const anchorRow = rows[probeRow];
  const corners = { rowLo: runCell(cell(rows[0], anchorCol)) };
  const perCellMs = Date.now() - t0;

  gate.section('4. the ROW axis moves the answer (full horizon)');
  if (rows.length < 2) {
    gate.check(true, 'single row — no axis to test');
  } else {
    corners.rowHi = runCell(cell(rows[rows.length - 1], anchorCol));
    gate.check(measure(corners.rowLo.row) !== measure(corners.rowHi.row),
      `${name(rows[0])} vs ${name(rows[rows.length - 1])} differ`,
      `${fmt(measure(corners.rowLo.row))} vs ${fmt(measure(corners.rowHi.row))}`);
  }

  gate.section('5. the COLUMN axis moves the answer');
  if (cols.length < 2) {
    gate.check(true, 'single column — no axis to test');
  } else {
    corners.colLo = runCell(cell(anchorRow, cols[0]));
    corners.colHi = runCell(cell(anchorRow, cols[cols.length - 1]));
    gate.check(measure(corners.colLo.row) !== measure(corners.colHi.row),
      `${name(cols[0])} vs ${name(cols[cols.length - 1])} differ`,
      `${fmt(measure(corners.colLo.row))} vs ${fmt(measure(corners.colHi.row))}`);
  }

  const cells = rows.length * cols.length;
  gate.section('6. cost of the full grid');
  console.log(`  one cell ≈ ${(perCellMs / 1000).toFixed(1)}s  ·  ${cells} cells`
    + `  ·  est ${((perCellMs * cells) / 1000 / 60).toFixed(1)} min`);

  // `corners` carries the cells this gate already ran, so a study's own follow-up checks
  // (does the "6 year" row REALISE six years?) read the same run rather than a second one
  // that might not be the same arm.
  return { failures: gate.failures, perCellMs, cells, gate, corners };
}

const fmt = (n) => (Number.isFinite(n) ? `$${Math.round(n / 1000).toLocaleString()}k` : String(n));
