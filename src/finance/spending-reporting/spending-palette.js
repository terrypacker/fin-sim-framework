/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { REPORT_CATEGORY } from './spending-classification.js';

/**
 * spending-palette.js — which hue means which spending category.
 *
 * Shared between the lab page and the workbench panel for the reason
 * `allocation-palette.js` states and this design inherits (82 §6.7): **colour is how a
 * band is identified.** Someone who has learned that the amber band is tax should not
 * have to relearn it in the app, and two charts of the same plan that disagree about
 * which band is tax are worse than one chart.
 *
 * The hue IDENTITY is shared; the exact value is not — the lab page renders on a light
 * background and the app on a dark one, so each gets its own tuning of one assignment.
 *
 * ─── the assignment, and why it is not arbitrary ─────────────────────────────
 *
 * The chart's whole subject is the tier-1 / tier-2 distinction, so the palette carries
 * it too rather than leaving it to a caption:
 *
 * · **Tier 1 is chromatic.** Blue-green for what the household chose to spend (living,
 *   housing, discretionary), amber-red for what was levied on it (the three taxes, plus
 *   interest). A reader can see the "chosen vs owed" split without reading a legend,
 *   which is the second question everyone asks after "how much".
 * · **Tier 2 is desaturated.** Greys and muted tones throughout, because it must be
 *   *visible* — §7(a) needs it drawn — without competing for attention with the money
 *   that was actually spent. It is an audit, not a headline.
 * · **`UNCLASSIFIED` is the exception: it is deliberately loud.** It is the one band
 *   whose appearance means something is wrong, and a muted stripe is exactly how that
 *   goes unnoticed for a release.
 */

/** Light background (the self-contained HTML lab report). */
export const CATEGORY_COLOR = Object.freeze({
  // Tier 1 — chosen
  [REPORT_CATEGORY.LIVING]:            '#2a78d6',
  [REPORT_CATEGORY.HOUSING_RUNNING]:   '#4f9d69',
  [REPORT_CATEGORY.HOUSING_REPAIR]:    '#7cbf8e',
  [REPORT_CATEGORY.DISCRETIONARY]:     '#3fa8a0',
  // Tier 1 — levied
  [REPORT_CATEGORY.TAX_US_FEDERAL]:    '#d8a13a',
  [REPORT_CATEGORY.TAX_US_STATE]:      '#e8c477',
  [REPORT_CATEGORY.TAX_AU]:            '#dd7a3c',
  [REPORT_CATEGORY.INTEREST]:          '#c2603f',
  // Tier 2 — not spending
  [REPORT_CATEGORY.INTERNAL]:          '#a8a69e',
  [REPORT_CATEGORY.DEBT_PRINCIPAL]:    '#8d8b84',
  [REPORT_CATEGORY.ASSET_PURCHASE]:    '#9a86b8',
  [REPORT_CATEGORY.ASSET_IMPROVEMENT]: '#b9a9cf',
  [REPORT_CATEGORY.REVALUATION]:       '#c3c2b7',
  [REPORT_CATEGORY.UNCLASSIFIED]:      '#e34948',
});

/** Dark background (the workbench). Same assignment, lifted for contrast. */
export const CATEGORY_COLOR_DARK = Object.freeze({
  [REPORT_CATEGORY.LIVING]:            '#60a5fa',
  [REPORT_CATEGORY.HOUSING_RUNNING]:   '#34d399',
  [REPORT_CATEGORY.HOUSING_REPAIR]:    '#6ee7b7',
  [REPORT_CATEGORY.DISCRETIONARY]:     '#22d3ee',
  [REPORT_CATEGORY.TAX_US_FEDERAL]:    '#fbbf24',
  [REPORT_CATEGORY.TAX_US_STATE]:      '#fde68a',
  [REPORT_CATEGORY.TAX_AU]:            '#fb923c',
  [REPORT_CATEGORY.INTEREST]:          '#f87171',
  [REPORT_CATEGORY.INTERNAL]:          '#94a3b8',
  [REPORT_CATEGORY.DEBT_PRINCIPAL]:    '#64748b',
  [REPORT_CATEGORY.ASSET_PURCHASE]:    '#a78bfa',
  [REPORT_CATEGORY.ASSET_IMPROVEMENT]: '#c4b5fd',
  [REPORT_CATEGORY.REVALUATION]:       '#475569',
  [REPORT_CATEGORY.UNCLASSIFIED]:      '#fb7185',
});

/** Fallback cycle for keys that are not a category (an account name, an action type). */
export const PALETTE_CYCLE = Object.freeze(
  ['#2a78d6', '#4f9d69', '#d8a13a', '#a05fc0', '#dd7a3c', '#3fa8a0', '#e34948', '#8d8b84']);

export const PALETTE_CYCLE_DARK = Object.freeze(
  ['#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#22d3ee', '#fb7185', '#94a3b8']);

/** The separator `groupKey` puts between dimensions in a composite series key. */
const KEY_SEP = ' · ';

/**
 * Colour for a series key.
 *
 * A multi-dimension group-by produces composite keys like `2031 · LIVING`; taking the
 * LAST segment means a split-out chart still paints living costs in the living colour,
 * which is what lets a reader carry one legend across every chart on the page. Anything
 * with no category in it falls back to a stable cycle position, so the same key keeps
 * its colour across re-renders.
 *
 * @param {string}  key
 * @param {number}  index            the key's position in the series list
 * @param {object}  [opts]
 * @param {boolean} [opts.dark=false]
 * @returns {string} css colour
 */
export function colorForCategory(key, index = 0, { dark = false } = {}) {
  const table = dark ? CATEGORY_COLOR_DARK : CATEGORY_COLOR;
  const cycle = dark ? PALETTE_CYCLE_DARK  : PALETTE_CYCLE;
  const last  = String(key ?? '').split(KEY_SEP).pop();
  return table[last] ?? cycle[index % cycle.length];
}
