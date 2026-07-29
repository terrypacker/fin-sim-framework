/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ASSET_CLASS } from './asset-class.js';

/**
 * allocation-palette.js — which hue means which asset class.
 *
 * Shared between the lab page and the workbench panel deliberately. Not because a hex
 * value is interesting, but because **colour is how a band is identified**: someone who
 * has learned that the purple band is the house should not have to relearn it in the
 * app, and two charts of the same plan that disagree about which band is equity are
 * worse than one chart.
 *
 * The hue IDENTITY is shared; the exact value is not. The lab page renders on a light
 * background and the app on a dark one, so each gets its own tuning of the same
 * assignment — blue equity, green bonds, gold gold, purple property, orange private
 * equity, teal collectibles, red liabilities, grey cash and unknown.
 *
 * Grey for CASH is a choice, not a leftover: cash is the class you want to *notice* is
 * large, not the one that draws the eye by default.
 */

/** Light background (the self-contained HTML lab report). */
export const ASSET_CLASS_COLOR = Object.freeze({
  [ASSET_CLASS.EQUITY]:         '#2a78d6',
  [ASSET_CLASS.BOND]:           '#4f9d69',
  [ASSET_CLASS.CASH]:           '#8d8b84',
  [ASSET_CLASS.GOLD]:           '#d8a13a',
  [ASSET_CLASS.REAL_ESTATE]:    '#a05fc0',
  [ASSET_CLASS.PRIVATE_EQUITY]: '#dd7a3c',
  [ASSET_CLASS.COLLECTIBLE]:    '#3fa8a0',
  [ASSET_CLASS.LIABILITY]:      '#e34948',
  [ASSET_CLASS.UNKNOWN]:        '#b6b4ab',
});

/** Dark background (the workbench). Same assignment, lifted for contrast on --bg-panel. */
export const ASSET_CLASS_COLOR_DARK = Object.freeze({
  [ASSET_CLASS.EQUITY]:         '#60a5fa',
  [ASSET_CLASS.BOND]:           '#34d399',
  [ASSET_CLASS.CASH]:           '#94a3b8',
  [ASSET_CLASS.GOLD]:           '#fbbf24',
  [ASSET_CLASS.REAL_ESTATE]:    '#a78bfa',
  [ASSET_CLASS.PRIVATE_EQUITY]: '#fb923c',
  [ASSET_CLASS.COLLECTIBLE]:    '#22d3ee',
  [ASSET_CLASS.LIABILITY]:      '#fb7185',
  [ASSET_CLASS.UNKNOWN]:        '#8b8f98',
});

/** Fallback cycle for keys that are not an asset class (rateKey, role, account name). */
export const PALETTE_CYCLE = Object.freeze(
  ['#2a78d6', '#4f9d69', '#d8a13a', '#a05fc0', '#dd7a3c', '#3fa8a0', '#e34948', '#8d8b84', '#6b7fd7', '#b1873f']);

export const PALETTE_CYCLE_DARK = Object.freeze(
  ['#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#22d3ee', '#fb7185', '#94a3b8', '#818cf8', '#a3e635']);

/** The separator `groupKey` puts between dimensions in a composite series key. */
const KEY_SEP = ' · ';

/**
 * Colour for a series key.
 *
 * A multi-dimension group-by produces composite keys like `US · EQUITY`; taking the
 * LAST segment means a per-country chart still paints equity in the equity colour,
 * which is what makes the country chart readable at a glance against the total one.
 * Anything with no asset class in it (a rateKey, a role, an account name) falls back to
 * a stable cycle position, so the same key keeps its colour across re-renders.
 *
 * @param {string}   key
 * @param {number}   index                 - the key's position in the series list
 * @param {object}   [opts]
 * @param {boolean}  [opts.dark=false]
 * @returns {string} css colour
 */
export function colorForSeriesKey(key, index, { dark = false } = {}) {
  const byClass = dark ? ASSET_CLASS_COLOR_DARK : ASSET_CLASS_COLOR;
  const cycle   = dark ? PALETTE_CYCLE_DARK      : PALETTE_CYCLE;

  if (byClass[key]) return byClass[key];
  const tail = String(key).split(KEY_SEP).pop();
  if (byClass[tail]) return byClass[tail];
  return cycle[Math.abs(index) % cycle.length];
}
