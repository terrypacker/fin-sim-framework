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
 * series-keys.js — how a cube row becomes a chart series key.
 *
 * Owned here rather than in either pivot because both of them (`allocation-grouping.js`
 * for stocks, `spending-grouping.js` for flows) had grown their own identical copy, and
 * the palettes had grown a third copy of the separator alone. That is worse than
 * redundant: the separator is a CONTRACT between a pivot and a palette — `colorForX`
 * splits a composite key on it to recover the last dimension, so a chart paints the
 * equity band the equity colour. Two definitions that agree today are two definitions
 * that can disagree tomorrow, and the failure mode is a silently miscoloured chart, not
 * an error.
 *
 * Nothing here is domain-specific; a third cube would import it rather than copy it.
 */

/** Rendered in place of a null/absent dimension value — visible, never silently merged. */
export const NO_VALUE = '(none)';

/**
 * The separator between dimensions in a composite series key.
 *
 * ` · ` reads as a path in a legend, and is a character no dimension value contains, so
 * `key.split(KEY_SEP).pop()` recovers the last dimension unambiguously.
 */
export const KEY_SEP = ' · ';

/** @private */
const _dimValue = (row, dim) => {
  const v = row?.[dim];
  return v == null || v === '' ? NO_VALUE : String(v);
};

/**
 * Composite key for a multi-dimension group.
 *
 * @param {object}   row   a cube fact row
 * @param {string[]} dims  dimension field names, in the order they should read
 * @returns {string} e.g. `US · EQUITY`, or `2031 · LIVING`
 */
export const groupKey = (row, dims) => dims.map(d => _dimValue(row, d)).join(KEY_SEP);

/**
 * The last dimension of a composite key — the one a palette looks up.
 *
 * @param {string} key
 * @returns {string}
 */
export const lastKeySegment = key => String(key ?? '').split(KEY_SEP).pop();
