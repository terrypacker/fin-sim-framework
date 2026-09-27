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
 * retired-strategies.js — behavioral strategies that no longer exist, and what a saved
 * plan that still names one becomes on load.
 *
 * The same bargain as `retired-rate-params.js` (design 99): drop the retired input, and
 * WARN when dropping it changes what the plan does. A strategy key nothing handles would
 * otherwise compile to no reducers at all (`BEHAVIORAL_STRATEGY_REGISTRY[k]?.reducers`),
 * so a plan that ticked it would silently stop doing what its author asked, with no sign
 * that anything was different.
 *
 * ─── STRATEGIC_ASSET_LOCATION (retired 27 Sep 2026, design 115 §12) ───────────────
 *
 * Its "swap" was a one-way transfer: the apply shrank a holding in one tax-advantaged
 * account and grew a holding in ANOTHER, so value crossed accounts with no tax and nothing
 * coming back. On the reference plan it emptied both IRAs, the spouse's 401(k) and super,
 * and part of the primary's super into the primary's Roth ($85.6k → $1.0m) within a
 * year: between people, from AU super into a US Roth, pre-tax into Roth. Design 61's
 * LOCATED placement (TARGET_ALLOCATION) does the job correctly and is the replacement.
 */

/** Every retired strategy key: the params it owned and the reducer classes it compiled. */
export const RETIRED_BEHAVIORAL_STRATEGIES = Object.freeze({
  STRATEGIC_ASSET_LOCATION: Object.freeze({
    params:       Object.freeze(['assetLocationPolicy']),
    reducerTypes: Object.freeze(['StrategicAssetLocationReducer', 'AssetLocationRebalanceApplyReducer']),
    replacement:  'TARGET_ALLOCATION with Allocation Location = LOCATED (its Allocation Location '
      + 'Policy takes the same { class: [roles] } map as the retired Asset Location Policy)',
    why:          'its swap moved money one way between tax-advantaged accounts with no tax '
      + '(design 115 §12)',
  }),
});

/** Reducer class names a serialized graph may still carry from a retired strategy. */
export const RETIRED_REDUCER_TYPES = Object.freeze(new Set(
  Object.values(RETIRED_BEHAVIORAL_STRATEGIES).flatMap(r => r.reducerTypes)));

/**
 * Strip retired strategies from `behavioralStrategies`, and their params, from both param
 * stores (`cfg.parameters` bag and the typed `cfg.params` list).
 *
 * Warns once per retired strategy the plan had ENABLED — that is a behaviour change. A
 * retired param with the strategy off was already inert, so it is dropped silently.
 *
 * @param {object} cfg
 * @param {object} [opts]
 * @param {function(string): void} [opts.warn=console.warn]
 * @returns {string[]} the warnings issued
 */
export function retireBehavioralStrategies(cfg, { warn = console.warn } = {}) {
  if (!cfg) return [];
  const notes   = [];
  const retired = Object.keys(RETIRED_BEHAVIORAL_STRATEGIES);
  const typed   = Array.isArray(cfg.params) ? cfg.params : [];
  const listEntry = typed.find(p => p?.name === 'behavioralStrategies');

  const enabled = new Set();
  const strip = (list) => {
    if (!Array.isArray(list)) return list;
    for (const k of list) if (retired.includes(k)) enabled.add(k);
    return list.filter(k => !retired.includes(k));
  };
  if (cfg.parameters && 'behavioralStrategies' in cfg.parameters) {
    cfg.parameters.behavioralStrategies = strip(cfg.parameters.behavioralStrategies);
  }
  if (listEntry) listEntry.value = strip(listEntry.value);

  const droppedParams = new Set(retired.flatMap(k => RETIRED_BEHAVIORAL_STRATEGIES[k].params));
  for (const key of droppedParams) if (cfg.parameters) delete cfg.parameters[key];
  if (Array.isArray(cfg.params)) cfg.params = cfg.params.filter(p => !droppedParams.has(p?.name));

  for (const k of enabled) {
    const r = RETIRED_BEHAVIORAL_STRATEGIES[k];
    notes.push(`Behavioral strategy '${k}' is retired and has been removed from this plan: ${r.why}. `
      + `Use ${r.replacement}.`);
  }
  for (const n of notes) warn(n);
  return notes;
}
