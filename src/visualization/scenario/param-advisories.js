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
 * Advisories drawn under a param's row in the Parameters list: what a single run with the
 * current values will do that the value alone does not say. Each is the SAME text the
 * compile warns with (it used to reach only the console), or the compile's refusal, so the
 * row says before Rebuild what the run would say after it.
 *
 * Read with the single-run values. Monte Carlo swaps in its own processes, and its panel's
 * return-paths line says what its paths run (design 133).
 */

import { bootstrapWindowWarning, bootstrapStartWarning } from '../../finance/economic-regimes/bootstrap-window.js';

/**
 * The DOM event (on `document`) the Parameters list fires after a committed edit, with
 * `detail.name`. Panels that describe the live plan elsewhere listen for it.
 */
export const PARAM_EDITED_EVENT = 'finsim:param-edited';

/** param name → (values) → advisory text or null. */
const ADVISORIES = {
  // Design 133 §3.2 — a pre-1951 window under joint inflation runs from 1951.
  equityReturnBootstrapFromYear:  bootstrapWindowWarning,
  // Design 133 §4.1 — pinned years before 1951 draw inflation at random under joint mode.
  equityReturnBootstrapStartYear: bootstrapStartWarning,
};

/** The params whose values an advisory reads: a change to one redraws the advisories. */
export const ADVISORY_INPUTS = new Set([
  'equityReturnStochastic', 'equityReturnModel', 'inflationStochastic', 'inflationModel',
  'equityReturnBootstrapFromYear', 'equityReturnBootstrapStartYear', 'equityReturnBootstrapStartRun',
]);

/** True when `name`'s row can carry an advisory. */
export function hasAdvisory(name) { return Object.hasOwn(ADVISORIES, name); }

/**
 * The advisory for `name`'s row, or null. A value the compile would refuse comes back as
 * the refusal's own message, so a bad year is named at the row rather than at Rebuild.
 *
 * @param {string} name
 * @param {object} values  the scenario's param values by name
 * @returns {{ text: string, refused: boolean }|null}
 */
export function paramAdvisory(name, values) {
  const fn = ADVISORIES[name];
  if (!fn) return null;
  try {
    const text = fn(values);
    return text ? { text, refused: false } : null;
  } catch (err) {
    return { text: String(err?.message ?? err), refused: true };
  }
}
