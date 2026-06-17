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
 * param-schema-utils.js — shared helpers for the param schema as the single
 * source of identity metadata (label, options, visibleWhen).
 *
 * The scenario param panel, the Monte Carlo variable list, and the Optimization
 * variable list all describe the same underlying params. Identity metadata lives
 * once in the toolset/registry paramSchema; the MC/Opt overlays carry only
 * sweep-specific data (distributions, ranges, grouping). These helpers let the
 * overlays inherit identity from the schema instead of duplicating it, and
 * evaluate the schema's `visibleWhen` conditions consistently everywhere.
 */

/**
 * Evaluate a `visibleWhen` condition. Returns true when there is no condition or
 * the condition is satisfied by the controlling param's current value.
 *
 * Condition shapes (extensible):
 *   { param, includes: <value> } — controller value (an array) contains <value>
 *   { param, equals:   <value> } — controller value strictly equals <value>
 *
 * @param {object}   meta     an object that may carry a `visibleWhen` field
 * @param {function} valueOf  (paramName) → current value of that param
 * @returns {boolean}
 */
export function isParamVisible(meta, valueOf) {
  const cond = meta?.visibleWhen;
  if (!cond || !cond.param) return true;
  const v = valueOf(cond.param);
  if ('includes' in cond) return Array.isArray(v) && v.includes(cond.includes);
  if ('equals'   in cond) return v === cond.equals;
  return true;
}

/** Index a flat param schema array by its `key` for O(1) identity lookups. */
export function indexParamSchema(schema = []) {
  return new Map(schema.map(e => [e.key, e]));
}

/**
 * Resolve a sweep overlay (MC / Opt variable list) against the param schema:
 *
 *   1. Inherit identity from the matching schema entry, keyed by `paramKey`:
 *        - `visibleWhen` is schema-owned (overlays never declare it), so the
 *          schema value wins — this is what lets a strategy's knobs hide.
 *        - `label` / `options` fall back to the schema only when the overlay
 *          omits them, so a new sweep variable can specify just `paramKey` +
 *          sweep metadata and inherit its label, while existing curated labels
 *          (and any sweep-specific wording) are preserved unchanged.
 *      Orphan keys with no schema entry (scenario-only aliases, synthesized
 *      per-shock rows) keep their overlay identity as-is.
 *   2. Drop entries whose `visibleWhen` isn't satisfied by `baseParams` — so an
 *      unselected strategy's knobs never appear in (or get swept by) the MC/Opt
 *      panels.
 *
 * @param {Array<object>} entries     overlay variables (carry `paramKey`)
 * @param {Map<string,object>} schemaByKey  schema indexed by key
 * @param {object} baseParams         flat param snapshot (name → value)
 * @returns {Array<object>}
 */
export function resolveSweepVariables(entries, schemaByKey, baseParams = {}) {
  const valueOf = (name) => baseParams?.[name];
  return entries
    .map(e => {
      const s = schemaByKey.get(e.paramKey);
      if (!s) return e; // orphan — keep the overlay's own identity
      return {
        ...e,
        label:       e.label       ?? s.label,        // overlay wins; schema fills omissions
        options:     e.options     ?? s.options,
        visibleWhen: s.visibleWhen ?? e.visibleWhen,   // schema-owned; drives hiding
      };
    })
    .filter(e => isParamVisible(e, valueOf));
}
