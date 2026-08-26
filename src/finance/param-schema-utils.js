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
 * Evaluate a leaf `{ param, <op>: … }` condition against the controller's value.
 * A bare `{ param }` with no operator imposes no constraint (returns true).
 */
function _evalLeaf(cond, valueOf) {
  if (!cond || !cond.param) return true;
  const v = valueOf(cond.param);
  if ('equals'    in cond) return v === cond.equals;
  if ('notEquals' in cond) return v !== cond.notEquals;
  if ('includes'  in cond) return Array.isArray(v) && v.includes(cond.includes);
  if ('excludes'  in cond) return !(Array.isArray(v) && v.includes(cond.excludes));
  if ('in'        in cond) return Array.isArray(cond.in)    && cond.in.includes(v);
  if ('notIn'     in cond) return !(Array.isArray(cond.notIn) && cond.notIn.includes(v));
  if ('exists'    in cond) return (v != null && v !== '') === !!cond.exists;
  if ('truthy'    in cond) return (!!v) === !!cond.truthy;
  if ('gt'  in cond) return Number(v) >  Number(cond.gt);
  if ('gte' in cond) return Number(v) >= Number(cond.gte);
  if ('lt'  in cond) return Number(v) <  Number(cond.lt);
  if ('lte' in cond) return Number(v) <= Number(cond.lte);
  return true;
}

/** Recursively evaluate a `visibleWhen` node (leaf, array=AND, allOf/anyOf/not). */
function _evalCond(cond, valueOf) {
  if (cond == null) return true;
  if (Array.isArray(cond)) return cond.every(c => _evalCond(c, valueOf));   // array ⇒ AND
  if ('allOf' in cond) return (cond.allOf ?? []).every(c => _evalCond(c, valueOf));
  if ('anyOf' in cond) return (cond.anyOf ?? []).some(c => _evalCond(c, valueOf));
  if ('not'   in cond) return !_evalCond(cond.not, valueOf);
  return _evalLeaf(cond, valueOf);
}

/**
 * Evaluate a `visibleWhen` condition. Returns true when there is no condition or
 * the condition is satisfied by the current param values. A small composable DSL —
 * the same evaluator drives the scenario panel, the MC list, and the Opt list.
 *
 * **Leaf** `{ param, <op>: value }` reads the controller `param`'s current value and
 * applies one operator:
 *   equals | notEquals — strict (in)equality
 *   includes | excludes — array membership (EnumMulti controllers)
 *   in | notIn — value is (not) one of an array
 *   exists — value is (not) set  ·  truthy — value is (not) truthy
 *   gt | gte | lt | lte — numeric comparison
 * A bare `{ param }` with no operator imposes no constraint.
 *
 * **Composition** nests arbitrarily:
 *   [c1, c2, …]        — AND (array shorthand)
 *   { allOf: [ … ] }   — AND      · { anyOf: [ … ] } — OR      · { not: c } — negation
 *
 * Back-compat: the original `{ param, equals }` / `{ param, includes }` shapes are
 * just single leaves and evaluate unchanged.
 *
 * @param {object}   meta     an object that may carry a `visibleWhen` field
 * @param {function} valueOf  (paramName) → current value of that param
 * @returns {boolean}
 */
export function isParamVisible(meta, valueOf) {
  return _evalCond(meta?.visibleWhen, valueOf);
}

/**
 * The set of controller param names a `visibleWhen` depends on — recursively across
 * arrays / allOf / anyOf / not. The UI uses this to re-render dependents when any
 * controlling param changes (a single-condition `visibleWhen` yields one name, the
 * legacy behavior).
 *
 * @param {object} meta  an object that may carry a `visibleWhen` field
 * @returns {string[]} distinct controller param names (empty when unconditional)
 */
export function visibleWhenControllers(meta) {
  const names = new Set();
  const walk = (cond) => {
    if (cond == null) return;
    if (Array.isArray(cond)) { cond.forEach(walk); return; }
    if (cond.allOf) cond.allOf.forEach(walk);
    if (cond.anyOf) cond.anyOf.forEach(walk);
    if (cond.not)   walk(cond.not);
    if (cond.param) names.add(cond.param);
  };
  walk(meta?.visibleWhen);
  return [...names];
}

/**
 * The `controllable` param facet (design/38 §6.0).
 *
 * The batch optimizer searches over every param flagged `opt`. The MPC
 * controller (design/39) can only actuate the subset that is *forward-adjustable
 * at runtime* — you can re-decide next year's spending or this year's Roth
 * conversion, but you cannot re-decide a birth date or un-sell a house already
 * sold at the current "now". A schema/variable entry marks itself with
 * `controllable: true` to opt into that control set; the control vector is
 * therefore `controllable ⊆ opt`.
 *
 * Defined here because it is a property of the variable. It is INERT in design
 * 38 (nothing reads it yet) and merely consumed by design 39.
 *
 * @param {Array} entries  param-schema or sweep-variable entries.
 * @returns {Array} the subset flagged `controllable: true`.
 */
export function controllableVariables(entries = []) {
  return entries.filter(e => e?.controllable === true);
}

/**
 * The loaded scenario's own parameter values, as one flat `name → value` bag.
 *
 * A scenario cfg carries params in TWO stores and a sweep runner that reads only
 * one of them silently centers on the wrong world:
 *   - `cfg.parameters` — the plain bag the compiler reads. Carries the scenario
 *                        class's own defaults from `buildDefaultConfig`, but is
 *                        refreshed from the list ONLY on load (`_normalizeParams`),
 *                        so it is both incomplete (toolset-declared params are
 *                        absent until a save+reload) and STALE (any edit since the
 *                        last Rebuild is missing). Neither gap announces itself.
 *   - `cfg.params`     — the typed UI list (`{ name, value, type, … }`). Populated
 *                        once ScenarioLoader has materialized the schema; this is
 *                        what the scenario editor writes to, so it WINS on conflict.
 *
 * Use this — never one store alone — wherever "what does this plan actually
 * assume?" is the question (MC/Opt variable centers, provenance checks).
 *
 * @param {object} cfg  a serialized scenario config
 * @returns {object} flat param bag (empty object when cfg has neither store)
 */
export function scenarioParamValues(cfg) {
  const out = { ...(cfg?.parameters ?? {}) };
  for (const p of (Array.isArray(cfg?.params) ? cfg.params : [])) {
    if (p?.name != null && p.value !== undefined) out[p.name] = p.value;
  }
  return out;
}

/**
 * The per-country central-bank "Prime" rates a scenario currently assumes (design 56).
 *
 * Read through {@link scenarioParamValues} rather than off `cfg.parameters`, and the
 * difference is not cosmetic. The scenario panel writes an edited param to the typed
 * `cfg.params` LIST; `ScenarioLoader._normalizeParams` copies the list into the flat
 * bag, but **only on load — i.e. on Rebuild**. So between editing a Prime rate and
 * rebuilding, the bag holds the OLD Prime while the plan is going to run the new one.
 *
 * An editor caught in that window does not merely display a stale number. The rate
 * fields edit an ABSOLUTE rate and store `primeSpread = absolute − Prime`, so an
 * absolute typed against the stale Prime is stored as a spread that resolves against
 * the real one. Measured on the reference plan: with AU Prime edited 4.35% → 7% and no
 * rebuild, a savings account set to "5%" stored a spread of 0.65% and the plan ran it
 * at **7.65%**. The hint even named the wrong Prime ("= Prime (4.35%) + 0.15%").
 *
 * @param {object} cfg  the active scenario config
 * @returns {{US: number|undefined, AU: number|undefined}} undefined where unconfigured
 */
export function primeRatesOf(cfg) {
  const values = scenarioParamValues(cfg);
  return { US: values.usPrimeRate, AU: values.auPrimeRate };
}

/**
 * The `key → defaultValue` bag from a flat param schema.
 *
 * This is the value ScenarioLoader materializes into `cfg.params` for any key the
 * cfg doesn't carry (`_mergeParamSchema`), so it is what the SIM will actually run
 * at. A sweep centering on anything else for those keys is centering off the run.
 *
 * Hidden entries are excluded to mirror the loader's `persistableSchema`: a hidden
 * generated param (e.g. an account's `balanceTarget`) is a compile-only MC/Opt lever
 * whose default must never be injected — writing it would rescale that account's
 * holdings (design 55 §13).
 */
export function paramSchemaDefaults(schema = []) {
  const out = {};
  for (const e of schema) {
    if (e?.key != null && !e.hidden && e.defaultValue !== undefined) out[e.key] = e.defaultValue;
  }
  return out;
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
