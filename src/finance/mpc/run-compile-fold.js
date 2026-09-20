/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { resolveActiveMpcRun, allDecisionsOf } from './run-schedule.js';
import { LEVER_SCHEDULE }                      from './lever-schedule.js';

/**
 * DESIGN 81 phase 3 — what a recorded run does at COMPILE, before any clock exists.
 *
 * Two things, in this order, both called once from `ScenarioCompiler.compile`:
 *
 *   1. `assertRunIsPlayable`  — D11's first half. A run whose levers name a mechanic the base
 *                               has since disabled THROWS, rather than playing back short.
 *   2. `foldQueueLeverRuns`   — §6.3. The ROTH / EARLY_WITHDRAWAL rows become ordinary
 *                               year-keyed schedule params before the toolsets read them.
 *
 * ─── why this module is not in `lever-schedule.js` ───────────────────────────────
 *
 * `lever-schedule.js` holds the per-lever hooks and imports only leaves (§16.5). This one
 * needs `run-schedule.js`'s selectors too, and it is imported by `scenario-compiler.js` — a
 * different position in the graph. Keeping them apart keeps that rule mechanical: both
 * imports here are still leaves, and the file that must stay leaf-only gained no import.
 */

/** The set of levers a run actually decided something for, in a stable order. */
function _leversOf(run) {
  const byLever = allDecisionsOf(run);
  return byLever ? [...byLever.keys()].sort() : [];
}

/**
 * Refuse a recorded run whose levers name a DISABLED mechanic (D11, first half; the case
 * §16.3 found and the one that settles Q5).
 *
 * The failure this prevents is specific and silent. `us-roth-conversion-toolset.js` opens
 * `schedules()` with `if (!p.rothConversionEnabled) return []`, so a run recorded with
 * conversions on and selected against a base where they have since been switched off has
 * EVERY ROTH row dropped on the floor — and plays back as a different plan with nothing on
 * screen to say so. The lever's own `appliesTo` gate cannot catch it: that ran at record time.
 *
 * It throws rather than warning because a plan quietly becoming a different plan is a
 * scenario-level contradiction, which is the half of D11 that throws — the precedent is
 * `normalizeLiquidityGraph` throwing on a hand-authored `drawdownSequence` beside a graph.
 * A badge on the picker is not enough when the thing being compared is the plan itself.
 *
 * The check is general, not ROTH-specific: every lever's gate is asserted, because the same
 * shape of failure exists wherever a gate decides whether a consumer is compiled at all (no
 * EXPLICIT_BANDS ⇒ no `ExplicitBandsSpendingReducer` ⇒ a stamped band table nobody reads).
 *
 * @param {object} parameters  the resolved scenario parameter bag
 * @throws {Error} naming every offending lever and how to satisfy its gate
 */
export function assertRunIsPlayable(parameters) {
  const run = resolveActiveMpcRun(parameters);
  if (!run) return;

  const problems = [];
  for (const lever of _leversOf(run)) {
    const gate = LEVER_SCHEDULE[lever]?.appliesTo;
    if (typeof gate !== 'function' || gate(parameters)) continue;
    problems.push(`  • ${lever} — ${LEVER_SCHEDULE[lever]?.requirement
      ?? 'the mechanic this lever drives is not enabled in this scenario.'}`);
  }
  if (problems.length === 0) return;

  throw new Error(
    `mpcActiveRun: recorded run '${run.runId}' decided ${problems.length} lever(s) whose `
    + 'mechanic this scenario has since disabled. Playing it would drop those decisions '
    + 'silently and run a DIFFERENT plan (design 81 D11 / §16.3):\n'
    + problems.join('\n')
    + '\n\nRe-enable the mechanic(s), or clear `mpcActiveRun` (or set `mpcRunEnabled: false`) '
    + 'to run the base scenario.');
}

/**
 * Fold the two QUEUE levers' rows into the year-keyed schedule params they address (§6.3).
 *
 * Returns a NEW bag; the caller's is not mutated, because the authored parameters are what a
 * re-save writes back and a run must write into no param (D5). Entries the run never decided
 * survive untouched, which is what keeps the pre-run plan for years the run never reached.
 *
 * @param {object} parameters  the resolved scenario parameter bag
 * @returns {object} the bag the toolsets should compile against
 */
export function foldQueueLeverRuns(parameters) {
  const run = resolveActiveMpcRun(parameters);
  const byLever = run ? allDecisionsOf(run) : null;
  if (!byLever) return parameters;

  let folded = null;
  for (const [lever, rows] of byLever) {
    const spec = LEVER_SCHEDULE[lever];
    if (!spec?.foldsAtCompile || typeof spec.foldAt !== 'function') continue;
    const next = spec.foldAt({ rows, baseParams: folded ?? parameters });
    if (next) folded = { ...(folded ?? parameters), [spec.paramKey]: next };
  }
  return folded ?? parameters;
}
