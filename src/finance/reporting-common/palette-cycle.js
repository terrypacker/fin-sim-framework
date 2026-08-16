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
 * palette-cycle.js — the fallback hue cycle, for series keys no domain table names.
 *
 * Every domain palette (`allocation-palette.js`, `spending-palette.js`) is a table from
 * a known value to a hue: EQUITY is blue, tax is amber. But a chart can be grouped by
 * something with no such table — an account name, a rateKey, an action type — and those
 * keys still need a colour that is stable across re-renders. That is this cycle, and
 * there is one of it: allocation and spending had drifted into two copies that happened
 * to hold the same hues, one truncated at eight entries.
 *
 * Position IS the identity here — a key's colour is its index in the series list — so
 * entries are appended, never reordered or inserted. Reordering silently repaints every
 * fallback-coloured chart in the app.
 */

/** Light background (the self-contained HTML lab reports). */
export const PALETTE_CYCLE = Object.freeze(
  ['#2a78d6', '#4f9d69', '#d8a13a', '#a05fc0', '#dd7a3c', '#3fa8a0', '#e34948', '#8d8b84', '#6b7fd7', '#b1873f']);

/** Dark background (the workbench). Same assignment, lifted for contrast. */
export const PALETTE_CYCLE_DARK = Object.freeze(
  ['#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#22d3ee', '#fb7185', '#94a3b8', '#818cf8', '#a3e635']);

/**
 * The cycle colour at a position, wrapping. Negative indices are folded rather than
 * returning `undefined`.
 *
 * @param {number}  index
 * @param {object}  [opts]
 * @param {boolean} [opts.dark=false]
 * @returns {string} css colour
 */
export function cycleColor(index, { dark = false } = {}) {
  const cycle = dark ? PALETTE_CYCLE_DARK : PALETTE_CYCLE;
  return cycle[Math.abs(Number(index) || 0) % cycle.length];
}
