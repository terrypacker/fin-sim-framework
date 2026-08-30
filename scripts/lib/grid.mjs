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
 * grid.mjs — run a rows × columns grid of cells IN PROCESS, and table the result.
 *
 * ─── why this is not `lab/variant-grid.mjs` ──────────────────────────────────
 *
 * `variant-grid.mjs` sweeps axes that are DATA: a spec names dotted paths into the
 * lever bag, and the cross product is fanned across worker processes. That is the
 * right tool when the axes can be written down as lever values, and it should stay
 * the default.
 *
 * A study's axes often cannot. `offset-bond-pool` sweeps shock presets crossed with
 * a drawdown SEQUENCE rebuilt from the scenario's own accounts; `offset-bucket-study`
 * sweeps glidepath anchor arrays. Those are functions, not values, and a spec file
 * cannot hold them. Every such study therefore wrote its own driver, and each
 * rewrote the same four things: the cross product, a progress line with an ETA,
 * per-cell error handling, and a results envelope. This is those four things.
 *
 * It runs cells SERIALLY in this process, which is the other half of the split.
 * Worker processes cannot be handed a closure, and a study cell usually wants to
 * read `sim.state` — trough, cover, lot snapshots — rather than reduce to a row.
 * That is affordable because these cells are cheap (~0.3s on a 16-year horizon with
 * `telemetry: 'off'`). When a cell is a whole Monte Carlo arm instead, it is minutes,
 * the closure problem disappears because the arm is defined by data, and the answer
 * is `parallel.mjs` + a worker module — see `account-asset-classes/ladder-frontier.mjs`.
 *
 * ─── the one behaviour worth arguing about ───────────────────────────────────
 *
 * A cell that throws ABORTS THE GRID by default. That is deliberate and it is the
 * lesson of `preflight.mjs`: the characteristic failure here is not a cell that
 * errors, it is a grid that quietly measured nothing. A driver that catches and
 * marks a bad cell turns a wiring failure into one odd entry in an otherwise
 * complete table — the exact shape of a finding. Pass `onError: 'mark'` only when a
 * cell failing is itself part of the result.
 */

/**
 * Render a markdown table. `\$` escapes are the caller's job — use `escapeMoney`.
 *
 * @param {object}   o
 * @param {object[]} o.rows      each `{id, label?}`
 * @param {object[]} o.cols      each `{id, label?}`
 * @param {(row:object,col:object)=>string} o.cell
 * @param {string}   [o.corner='']
 * @returns {string}
 */
export function markdownTable({ rows, cols, cell, corner = '' }) {
  const name = (x) => x.label ?? x.id;
  return [
    // The corner is usually empty, and `| ${''} |` renders a two-space cell that shows up
    // as a diff against every table this replaced. Emit one space when there is no label.
    `|${corner ? ` ${corner} ` : ' '}|${cols.map(c => ` ${name(c)} `).join('|')}|`,
    `|---|${cols.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${name(r)} | ${cols.map(c => cell(r, c)).join(' | ')} |`),
  ].join('\n');
}

/**
 * `$1.23m`, with the dollar sign escaped for markdown.
 *
 * A bare `$…$` pair on one line renders as LaTeX math, so a table row with two money
 * cells silently becomes italic gibberish in any markdown viewer. Escaping is not
 * cosmetic here — the table is the deliverable.
 */
export const escapeMoney = (n, dp = 2) =>
  (n == null || !Number.isFinite(n)) ? '—' : `\\$${(n / 1e6).toFixed(dp)}m`;

/** `$1,234k`, escaped the same way. */
export const escapeThousands = (n) =>
  (n == null || !Number.isFinite(n)) ? '—' : `\\$${Math.round(n / 1000).toLocaleString()}k`;

/**
 * Run every (row, col) cell, printing progress with an ETA.
 *
 * @param {object}   o
 * @param {string}   [o.title]
 * @param {object[]} o.rows                each `{id, label?}`
 * @param {object[]} o.cols                each `{id, label?}`
 * @param {(row:object,col:object,ctx:{index:number,total:number})=>object} o.cell
 *        Runs one cell and returns whatever the study wants to keep.
 * @param {(row:object,col:object,result:object)=>string} [o.summarize]
 *        One line per cell, appended to the progress line. Keep it to the two or
 *        three numbers you would actually watch — this is the only view of a long
 *        grid while it runs.
 * @param {(row:object,col:object)=>string} [o.key]  results key; default `row/col`.
 * @param {'throw'|'mark'} [o.onError='throw']  see the header.
 * @param {string}  [o.header]  a line printed under the title (base file, horizon, …).
 * @returns {Promise<{results: Record<string,object>, elapsedMs: number, errors: number}>}
 */
export async function runGrid({
  title, rows, cols, cell,
  summarize = null,
  key = (r, c) => `${r.id}/${c.id}`,
  onError = 'throw',
  header = null,
}) {
  const total = rows.length * cols.length;
  if (title) console.log(`\n${title} — ${rows.length} rows × ${cols.length} columns = ${total} cells`);
  if (header) console.log(`${header}\n`);

  const results = {};
  const started = Date.now();
  let done = 0, errors = 0;

  for (const row of rows) {
    for (const col of cols) {
      const t0 = Date.now();
      let res;
      try {
        res = await cell(row, col, { index: done, total });
      } catch (e) {
        errors++;
        console.error(`\n✘ ${row.id}/${col.id}: ${e.message}\n`);
        if (onError !== 'mark') throw e;          // an inert axis is not a cell to skip
        res = { error: e.message };
      }
      done++;
      results[key(row, col)] = { row: row.id, col: col.id, ...res };

      const elapsed = (Date.now() - started) / 1000;
      const eta = (elapsed / done) * (total - done);
      // `summarize` owns its own column widths — the caller is the only one who knows
      // how wide its numbers run, and a width imposed here would ragged every study.
      const line = res.error ? 'ERROR' : (summarize ? summarize(row, col, res) : '');
      console.log(`[${String(done).padStart(2)}/${total}] ${row.id} ${col.id.padEnd(9)} ${line}`
        + `  (${((Date.now() - t0) / 1000).toFixed(1)}s, eta ${eta.toFixed(0)}s)`);
    }
  }

  return { results, elapsedMs: Date.now() - started, errors };
}

/**
 * The JSON envelope a grid writes beside its tables.
 *
 * The split is the same one `montecarlo/` makes and for the same reason: the grid
 * costs minutes and the report costs milliseconds, and the report is the half you
 * rewrite ten times. Keeping the axes IN the file (not just the cells) is what lets
 * a later reporter render it without importing the study's config module — and what
 * makes a stale file self-describing rather than a bag of numbers.
 */
export function gridEnvelope({ rows, cols, results, ...meta }) {
  return { generatedAt: new Date().toISOString(), ...meta, rows, columns: cols, results };
}
