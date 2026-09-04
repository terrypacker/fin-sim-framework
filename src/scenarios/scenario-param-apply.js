/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ScenarioLoader } from './scenario-loader.js';
import { applyRealPropertySaleYearParams } from './intl-retirement-scenario.js';

/**
 * Apply a flat param bag — a Monte Carlo iteration's sampled params, or an optimizer
 * candidate — onto a scenario config so the next `ScenarioLoader.load()` runs at those
 * values.
 *
 * THE POINT OF THIS FUNCTION IS THAT THERE IS ONLY ONE OF IT. The MC runner and the
 * workbench's Replay button used to apply a bag in two different ways, and the replay's
 * way was a strict subset: it walked `cfg.params` matching `params[p.name]` and nothing
 * else. That drops, silently and with no error anywhere:
 *
 *   1. Every ALIASED key. `ScenarioLoader._applyParamAliases` has already renamed the
 *      typed entries, so a bag key of `stockBalance` never matches a `p.name` of
 *      `acct.usStockAccount.balanceTarget`. That is all 13 account balances, both wage
 *      keys, both cash floors and both house sale years.
 *   2. Every NESTED key — `shocks[N].severity`, `people.<key>.lifeExpectancy` — which
 *      lives in the bag as nested structure, not as a top-level `p.name`.
 *   3. Every key with no typed entry at all.
 *
 * So a replayed run was the sampled scalars plus the scenario's own values for everything
 * else, presented as "this exact run". Sharing one function means a fidelity gap can only
 * ever be a gap in BOTH, which is a gap you can see.
 *
 * Both stores are written, and both are required (see `ScenarioLoader._normalizeParams`):
 *
 *   - `cfg.parameters` (the flat bag) is what the alias pass rewrites and what the
 *     generated-key cascade reads, so it is the only route for aliased, nested and
 *     untyped keys.
 *   - `cfg.params` (the typed array) is synced INTO `cfg.parameters` AFTERWARDS,
 *     overwriting it key by key. Writing only the bag would therefore have every typed
 *     key clobbered straight back to the scenario's own value.
 *
 * The cfg is mutated in place. On the MC path that is a per-iteration `structuredClone`;
 * on the replay path it is the LIVE active scenario record, which is the behaviour the
 * Replay button has always had — see `WorkbenchApp._replayMcRun`.
 *
 * @param {object} cfg     scenario config (mutated)
 * @param {object} params  flat param bag; keys may be legacy aliases or nested paths
 * @returns {object} the same cfg
 */
export function applyParamBagToConfig(cfg, params) {
  if (!cfg || !params) return cfg;

  // The flat map: carries aliased, nested and untyped keys into the loader.
  cfg.parameters = { ...(cfg.parameters ?? {}), ...params };

  // Real property sale years reach cfg.realProperties through the alias + generated-key
  // cascade above, but the direct patch is kept: it is what the MC path has always done,
  // and a scenario whose class cannot be resolved gets no aliases at all.
  applyRealPropertySaleYearParams(cfg, params);

  // The typed array, which the loader syncs over the flat map. Alias-aware: a typed entry
  // already renamed to its generated key still takes the bag's legacy value.
  if (Array.isArray(cfg.params)) {
    const legacyForTarget = new Map();
    for (const [legacy, target] of ScenarioLoader.paramAliasesFor(cfg)) {
      if (target != null && !legacyForTarget.has(target)) legacyForTarget.set(target, legacy);
    }
    for (const p of cfg.params) {
      const legacy = legacyForTarget.get(p.name);
      const val = params[p.name] !== undefined ? params[p.name]
        : (legacy !== undefined ? params[legacy] : undefined);
      if (val !== undefined) p.value = val;
    }
  }

  return cfg;
}
