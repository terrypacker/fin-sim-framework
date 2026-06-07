/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { StateSchemaRegistry } from '../../finance/services/state-schema-registry.js';

const _defaultRegistry = new StateSchemaRegistry();

/**
 * Walk a state snapshot and return all finite-number leaf paths.
 * Uses StateSchemaRegistry.resolve() for type info.
 *
 * @param {object} state - simulation state snapshot
 * @param {StateSchemaRegistry} [registry] - optional registry override (for testing)
 * @returns {{ path: string, value: number, type: import('../../finance/services/state-schema-registry.js').ParameterValueType }[]}
 */
export function flattenStatePaths(state, registry = _defaultRegistry) {
  const results = [];
  _walk(state, '', results, registry);
  return results;
}

/**
 * Resolve the ParameterValueType for a single state path (currency/rate/…).
 * Shares the module's default registry so the chart and the flatten layer
 * cannot drift. Used by ChartPresenter to bucket a series onto the right Y-axis.
 *
 * @param {string} path
 * @returns {import('../../finance/services/state-schema-registry.js').ParameterValueType}
 */
export function typeForPath(path, registry = _defaultRegistry) {
  return registry.resolve(path);
}

function _walk(node, prefix, results, registry) {
  if (node === null || node === undefined) return;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      _walk(node[i], prefix ? `${prefix}.${i}` : String(i), results, registry);
    }
    return;
  }

  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      _walk(value, prefix ? `${prefix}.${key}` : key, results, registry);
    }
    return;
  }

  if (typeof node === 'number' && isFinite(node)) {
    results.push({ path: prefix, value: node, type: registry.resolve(prefix) });
  }
}

// ── Grouping ──────────────────────────────────────────────────────────────────

function _globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\*\*/g, '.+').replace(/\*/g, '[^.]+');
  return new RegExp(`^${pattern}$`);
}

/**
 * Curated semantic groups: label → glob patterns.
 * Anything unmatched falls into an auto group keyed on the leading path segment.
 */
export const STATE_FIELD_GROUPS = [
  // 'Metrics' must come before 'Balances'/'Tax YTD' — 'metrics.balance' would
  // otherwise match '*.balance' first since group order is first-match-wins.
  { label: 'Metrics',      patterns: ['metrics.*'] },
  { label: 'FX',           patterns: ['baseExchangeRates.*', 'effectiveExchangeRates.*', 'baseFxFees.*', 'effectiveFxFees.*'] },
  { label: 'Regime Rates', patterns: ['effectiveInflationRates.*', 'effectiveAppreciationRates.*', 'effectiveInterestRates.*', 'baseInflationRates.*', 'baseAppreciationRates.*', 'baseInterestRates.*', 'inflationRates.*'] },
  { label: 'Asset Values', patterns: ['*.holdings.*.marketValue', '*.holdings.*.costBasis'] },
  { label: 'Balances',     patterns: ['*.balance'] },
  { label: 'Tax / YTD',   patterns: ['*YTD', 'cumulativeDeficit'] },
];

const _compiledGroups = STATE_FIELD_GROUPS.map(g => ({
  label:   g.label,
  regexes: g.patterns.map(_globToRegex),
}));

/**
 * Return the curated group label for a state path, or the leading path segment
 * as a fallback auto-group when no curated pattern matches.
 *
 * @param {string} path - dot-separated state path
 * @returns {string}
 */
export function groupFor(path) {
  for (const { label, regexes } of _compiledGroups) {
    for (const re of regexes) {
      if (re.test(path)) return label;
    }
  }
  return path.split('.')[0];
}
