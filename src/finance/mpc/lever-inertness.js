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
 * Design 114 §16 — the cockpit's INERT verdicts, for the Optimize panel and the MC grid.
 *
 * Design 39 §14.8 found that on a plan whose pool graph compiles the spend order, several drawdown
 * levers decide nothing: the cockpit refuses to search them, through `LEVER_SCHEDULE`'s gates. The
 * same levers are offered by the optimizer's harvest and, through it, as grid axes — keyed by PARAM
 * rather than by cockpit control, so neither surface ever asked the gate. An optimizer run over
 * them spends dimensions on nothing, and a grid over one returns identical cells that read as a
 * finding ("this lever does not matter") instead of a defect.
 *
 * This module maps a param key to the gate that already decides it and reports, never repairs:
 * the rows are shaped like `poolAxisProblems`' and `runAxisProblems`', so the grid's hygiene
 * renderer draws them unchanged. One predicate and one sentence per lever — the gate's own
 * `inertWhen` and `leverRequirement` — so the cockpit and these panels cannot disagree.
 *
 * Only the INERT half of a gate is used. `appliesTo` also fails when a mode is not selected (the
 * weights want `drawdownStrategy: WEIGHTED`), and that is a different statement about a different
 * surface: the optimizer sets values, the cockpit decides per year. `inertWhen` is the measured
 * one — the lever cannot move this plan's run at any value.
 */

import { LEVER_SCHEDULE, leverRequirement } from './lever-schedule.js';
import { DRAWDOWN_WEIGHT_PREFIX, DRAWDOWN_WEIGHT_SEP } from '../../scenarios/params/lever-weights.js';
import { SLEEVE_WEIGHT_PREFIX, SLEEVE_WEIGHT_SEP } from '../holdings/holdings-selection.js';

/** The problem kind a row carries — the grid renders it as `INERT`. */
export const INERT_LEVER_KIND = 'inert';

/** Param key → the `LEVER_SCHEDULE` gate that decides it. First match wins. */
const GATE_FOR_PARAM = Object.freeze([
  [(k) => k === 'crossBorderDrawdown',                                    'DRAWDOWN_XBORDER'],
  [(k) => k === 'withinTierDraw',                                         'DRAWDOWN_WITHINTIER'],
  [(k) => k.startsWith(`${DRAWDOWN_WEIGHT_PREFIX}${DRAWDOWN_WEIGHT_SEP}`), 'DRAWDOWN_WEIGHTS'],
  [(k) => k.startsWith(`${SLEEVE_WEIGHT_PREFIX}${SLEEVE_WEIGHT_SEP}`),     'DRAWDOWN_SLEEVE'],
]);

/** The gate name for a param key, or null when no gate decides it. */
export function leverGateForParam(paramKey) {
  if (typeof paramKey !== 'string') return null;
  return GATE_FOR_PARAM.find(([match]) => match(paramKey))?.[1] ?? null;
}

/**
 * One row per param key that is INERT on this plan.
 *
 * @param {Array<string>} paramKeys  the levers a surface offers (Opt variables, grid axes)
 * @param {object} bp                the plan's flat param bag
 * @returns {Array<{param:string, index:null, field:null, severity:'warn', kind:'inert',
 *                  gate:string, message:string}>}
 */
export function inertLeverProblems(paramKeys, bp) {
  const out = [];
  for (const param of (Array.isArray(paramKeys) ? paramKeys : [])) {
    const gate = leverGateForParam(param);
    const spec = gate ? LEVER_SCHEDULE[gate] : null;
    if (typeof spec?.inertWhen !== 'function' || !spec.inertWhen(bp ?? {})) continue;
    out.push({
      param, index: null, field: null, severity: 'warn', kind: INERT_LEVER_KIND, gate,
      message: leverRequirement(spec, bp),
    });
  }
  return out;
}
