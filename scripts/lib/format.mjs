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
 * format.mjs — number formatting and fixed-width table rendering for terminal reports.
 *
 * Every tool here prints a table to a terminal, and the tables are read side by
 * side across studies, so consistent column widths and money formats are not
 * cosmetic — a `$1.1m` in one report and `$1,100,000` in the next makes two
 * comparable numbers look unrelated.
 */

export const money = (n) => (n == null ? '—' : (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString());
export const millions = (n) => (n == null ? '—' : '$' + (n / 1e6).toFixed(1) + 'm');
export const thousands = (n) => (n == null ? '—' : '$' + Math.round(n / 1000) + 'k');
export const pct = (r, dp = 1) => (r == null ? '—' : `${(r * 100).toFixed(dp)}%`);

/** Percentile by nearest-rank. Small-n friendly and never interpolates a value that no path produced. */
export function percentile(values, p) {
  const s = [...values].filter(v => v != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = Math.floor((p / 100) * (s.length - 1));
  return s[Math.min(s.length - 1, Math.max(0, i))];
}

export function mean(rows, key) {
  const vals = rows.map(r => r[key]).filter(v => typeof v === 'number');
  return vals.length ? vals.reduce((t, v) => t + v, 0) / vals.length : null;
}

/**
 * Render a matrix as a fixed-width table.
 *
 * @param {object}   o
 * @param {string}   o.title
 * @param {string[]} o.rows      row labels (left column)
 * @param {string[]} o.cols      column headers
 * @param {function} o.cell      (rowLabel, colLabel) ⇒ string
 * @param {string}   [o.corner]  header for the label column
 * @param {number}   [o.width]   data column width (default: widest header + 2)
 */
export function table({ title, rows, cols, cell, corner = '', width }) {
  const w = width ?? Math.max(...cols.map(c => c.length), 6) + 2;
  const labelW = Math.max(corner.length, ...rows.map(r => r.length)) + 2;
  const out = [];
  if (title) out.push('', `════ ${title} ════`);
  out.push(corner.padEnd(labelW) + cols.map(c => c.padStart(w)).join(''));
  out.push('─'.repeat(labelW + w * cols.length));
  for (const r of rows) out.push(r.padEnd(labelW) + cols.map(c => String(cell(r, c)).padStart(w)).join(''));
  console.log(out.join('\n'));
}

/**
 * Render a list of records as a column report.
 *
 * @param {object}   o
 * @param {string}   [o.title]
 * @param {Array}    o.rows
 * @param {Array}    o.columns  `[{ head, get, width?, align? }]`
 */
export function columns({ title, rows, columns: cols }) {
  const widths = cols.map(c => c.width ?? Math.max(c.head.length, 8) + 2);
  const line = (cells) => cells.map((s, i) =>
    cols[i].align === 'left' ? String(s).padEnd(widths[i]) : String(s).padStart(widths[i])).join('');
  const out = [];
  if (title) out.push('', `════ ${title} ════`);
  out.push(line(cols.map(c => c.head)));
  out.push('─'.repeat(widths.reduce((a, b) => a + b, 0)));
  for (const r of rows) out.push(line(cols.map(c => c.get(r))));
  console.log(out.join('\n'));
}

export const heading = (s) => console.log(`\n\n########## ${s} ##########`);
export const note = (s) => console.log(s);
