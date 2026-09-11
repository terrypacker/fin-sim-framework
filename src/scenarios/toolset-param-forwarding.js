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
 * Forwarding of toolset-contributed param overrides in a prebuilt scenario's
 * buildDefaultConfig().
 *
 * Each prebuilt hand-enumerates its `parameters` map for its own scenario-level params.
 * A key a TOOLSET owns (the market totals and yields, `shocks`, `behavioralStrategies`,
 * …) is not in that block, so without this an override bag carrying one was dropped
 * without a word: buildDefaultConfig({ auEquityGrowthRate: 0.07 }) ran at the default
 * rate. The intl plan forwarded; the US and AU single-homeowner plans did not, which
 * made design 99 P5b's first attribution probe show four identical runs.
 */
import { RETIRED_RATE_PARAMS } from './retired-rate-params.js';

/**
 * The keys contributed by `toolsets` that the scenario-level schema does not name.
 *
 * @param {object[]} toolsets        - toolset objects (each with an optional paramSchema)
 * @param {object[]} scenarioSchema  - the scenario's own param schema
 * @returns {Set<string>}
 */
export function toolsetParamKeys(toolsets, scenarioSchema) {
  const scenarioKeys = new Set(scenarioSchema.map(e => e.key));
  const keys = new Set();
  for (const t of toolsets)
    for (const e of (t.paramSchema?.({}) ?? []))
      if (e?.key && !scenarioKeys.has(e.key)) keys.add(e.key);
  return keys;
}

/**
 * Copy each explicit override in `params` that a toolset owns onto `parameters`.
 *
 * Only keys the caller passed are forwarded — a toolset param left out keeps its own
 * schema default, so a plan built with no overrides is unchanged. A key the enumerated
 * block already emitted is left alone (it may be a transformed scenario input). A
 * retired equity rate (design 99 P2) is forwarded so the loader can WARN when it differs
 * from the market's, rather than being dropped here without a word.
 *
 * @param {object}      params      - the caller's override bag
 * @param {object}      parameters  - the cfg.parameters map being built (mutated)
 * @param {Set<string>} toolsetKeys - from toolsetParamKeys()
 */
export function forwardToolsetOverrides(params, parameters, toolsetKeys) {
  for (const key of Object.keys(params)) {
    if (key in parameters) continue;
    if (!toolsetKeys.has(key) && !(key in RETIRED_RATE_PARAMS)) continue;
    parameters[key] = params[key];
  }
}
