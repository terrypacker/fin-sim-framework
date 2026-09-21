/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { DIE_WITH_TARGET_FAMILY, objectivePrimaryMetric } from '../optimization/optimization-objectives.js';

/**
 * DESIGN 39 §14.8.4 — two results the search produces that the card used to render as advice.
 *
 * **A flat objective.** When every candidate scores the same, the solver still returns one of
 * them and the card rendered it as a confident move: on the author's plan, a full sell order
 * chosen from a surface with no slope at all, repeated every epoch. "The search found nothing
 * to choose between" is a result, and it is the opposite of a recommendation.
 *
 * **An unreachable goal target.** A Die-With-Target goal names a terminal target. When every
 * candidate the search tried lands on the same side of it, no value in the searched range
 * reaches it, and the card went on quoting the target beside a projection that missed it by the
 * whole portfolio, unremarked. That says the lever set cannot close the gap, which is the
 * question the user needs answered before trusting the move.
 *
 * Pure: it reads the solver's evaluated candidates and the objective, and decides nothing. The
 * card renders the sentences; the recommendation itself is unchanged, because what to do about
 * a flat surface (keep the plan, widen the range, search another lever) is the user's call.
 */

/**
 * Two scores closer than this are the same score. Scores are dollars (reward minus penalties),
 * so the absolute floor is a dollar; the relative term absorbs float noise on large totals.
 */
const SCORE_TOLERANCE_ABS = 1;
const SCORE_TOLERANCE_REL = 1e-9;

/**
 * A miss smaller than this is on target: half a percent of the target, and never less than
 * $1,000 in today's dollars, so a target near zero does not turn rounding into "unreachable".
 */
const TARGET_TOLERANCE_REL = 0.005;
const TARGET_TOLERANCE_ABS = 1_000;

/**
 * @param {object} opts
 * @param {Array<{candidate:object, score:number, result:object}>} opts.candidates  every evaluation
 * @param {object} opts.objective  the objective the search maximized
 * @returns {{
 *   flat: {flat:boolean, distinct:number, spread:number|null, metricSpread:number|null}|null,
 *   target: {reachable:boolean, target:number, nearest:number, side:'above'|'below'|null}|null,
 * }}
 */
export function adviceSignals({ candidates = [], objective = null } = {}) {
  const scored = candidates.filter(c => Number.isFinite(c?.score));
  return { flat: _flatness(scored, objective), target: _targetReach(scored, objective) };
}

function _flatness(scored, objective) {
  // Distinct CANDIDATES, not evaluations: a ledger can hold one candidate once, but a flat
  // verdict over a single point would be a verdict about nothing.
  const distinct = new Set(scored.map(c => JSON.stringify(c.candidate ?? {}))).size;
  if (distinct < 2) return { flat: false, distinct, spread: null, metricSpread: null };
  const scores = scored.map(c => c.score);
  const hi = Math.max(...scores), lo = Math.min(...scores);
  const spread = hi - lo;
  const key = objectivePrimaryMetric(objective).key;
  const metrics = scored.map(c => c.result?.[key]).filter(Number.isFinite);
  return {
    flat: spread <= Math.max(SCORE_TOLERANCE_ABS, SCORE_TOLERANCE_REL * Math.abs(hi)),
    distinct,
    spread,
    metricSpread: metrics.length ? Math.max(...metrics) - Math.min(...metrics) : null,
  };
}

function _targetReach(scored, objective) {
  if (objective?.family !== DIE_WITH_TARGET_FAMILY) return null;
  const key = objectivePrimaryMetric(objective).key;
  // The same real (base-year) terminal the objective scores against the target.
  const misses = [];
  let target = null;
  for (const c of scored) {
    const r = c.result;
    if (!r || !Number.isFinite(r[key])) continue;
    target ??= r.terminalWealthTarget ?? 0;
    misses.push(r[key] / (r.terminalPriceLevel || 1) - (r.terminalWealthTarget ?? 0));
  }
  if (!misses.length) return null;
  const nearestMiss = misses.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
  const tol = Math.max(TARGET_TOLERANCE_ABS, TARGET_TOLERANCE_REL * Math.abs(target));
  // Reachable when some candidate lands within tolerance, or the candidates straddle the target:
  // then a value between two tried ones reaches it, even if none of them happened to.
  const straddles = misses.some(m => m > 0) && misses.some(m => m < 0);
  const reachable = Math.abs(nearestMiss) <= tol || straddles;
  return {
    reachable,
    target,
    nearest: target + nearestMiss,
    side: reachable ? null : (nearestMiss > 0 ? 'above' : 'below'),
  };
}
