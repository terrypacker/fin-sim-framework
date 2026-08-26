/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { isIncludesRequirement, requirementSatisfied } from './harvest.js';

/**
 * Execute a HarvestPlan against a loaded scenario (design/39 §13.5).
 *
 * Four rules, each fixing something that was wrong or absent before:
 *
 *  1. **Upsert, don't update-if-present.** The `const p = params.find(…); if (p)
 *     p.value = v` idiom at the `actuate` sites silently DROPS a write whose key
 *     isn't materialized in `cfg.params`. Here a missing key is created with a
 *     typed entry, and a key that can't be placed at all is REPORTED as skipped.
 *  2. **One store.** Writes `cfg.params` only; `ScenarioLoader`'s params→parameters
 *     sync does the rest on Rebuild. Writing both is how the two stores drift
 *     (the cfg.params-vs-cfg.parameters trap).
 *  3. **Enabling params ride along, atomically.** A harvested `drawdownWeight::*`
 *     is inert unless `drawdownStrategy = WEIGHTED`; an `allocationGlidepath` is
 *     ignored unless `allocationSchedule = GLIDEPATH`. `plan.requires` is applied
 *     in the same pass as the values — never one without the other.
 *  4. **Provenance.** The scenario is stamped with `harvestedFrom` so a saved plan
 *     says which numbers were searched, under which goal, over which epochs.
 *
 * Deliberately does NOT Rebuild, save, or touch the running sim: it edits the
 * loaded scenario's params and stops. The user's existing Rebuild/Save flows
 * finish the job, which keeps the blast radius at "an edit you could have typed".
 *
 * @param {object} scenario - the ACTIVE scenario (mutated in place).
 * @param {object} plan     - from `harvestDecisions()`.
 * @param {object} [opts]
 * @param {boolean} [opts.applyRequires=true] - apply the enabling params too.
 * @returns {{ applied: string[], created: string[], skipped: Array<{paramKey, reason}>,
 *             requires: string[], provenance: object }}
 */
export function applyHarvestPlan(scenario, plan, { applyRequires = true } = {}) {
  const applied = [];
  const created = [];
  const skipped = [];
  const requiresApplied = [];

  if (!scenario) throw new Error('applyHarvestPlan requires a scenario');
  if (!Array.isArray(scenario.params)) scenario.params = [];

  for (const entry of (plan?.entries ?? [])) {
    const res = upsertParam(scenario, entry.paramKey, entry.to);
    if (res.status === 'skipped') skipped.push({ paramKey: entry.paramKey, reason: res.reason });
    else {
      applied.push(entry.paramKey);
      if (res.status === 'created') created.push(entry.paramKey);
    }
  }

  if (applyRequires) {
    for (const req of (plan?.requires ?? [])) {
      const current = readParamValue(scenario, req.paramKey);
      if (requirementSatisfied(current, req.to)) continue;
      const next = isIncludesRequirement(req.to)
        ? withIncluded(current, req.to.includes)
        : req.to;
      const res = upsertParam(scenario, req.paramKey, next);
      if (res.status === 'skipped') skipped.push({ paramKey: req.paramKey, reason: res.reason });
      else {
        requiresApplied.push(req.paramKey);
        if (res.status === 'created') created.push(req.paramKey);
      }
    }
  }

  const provenance = {
    runId:      plan?.runId ?? null,
    goal:       plan?.goal ?? null,
    levers:     plan?.levers ?? [],
    epochs:     plan?.epochs ?? 0,
    epochRange: plan?.epochRange ?? [null, null],
    date:       new Date().toISOString(),
  };
  scenario.harvestedFrom = provenance;

  return { applied, created, skipped, requires: requiresApplied, provenance };
}

/** A param entry's key, tolerating both shapes in use (`name` from the loader,
 *  `key` from hand-built configs). */
export function paramKeyOf(p) { return p?.key ?? p?.name; }

/** Current value of a param on the scenario (undefined when absent). */
export function readParamValue(scenario, paramKey) {
  return (scenario?.params ?? []).find(p => paramKeyOf(p) === paramKey)?.value;
}

/**
 * Set a param's value, creating a typed entry when it is missing (rule 1).
 *
 * A created entry carries best-effort metadata: the scenario class's schema when
 * it declares the key, otherwise a type inferred from the value plus a known-key
 * table for the schedule-shaped params the harvest bakes. Either way the entry is
 * self-healing — `ScenarioLoader._mergeParamSchema` re-syncs schema-owned metadata
 * (type/label/group/node) on the next load, so an inferred type cannot stick.
 *
 * @returns {{ status: 'updated'|'created'|'skipped', reason?: string }}
 */
export function upsertParam(scenario, paramKey, value) {
  if (!paramKey) return { status: 'skipped', reason: 'no param key' };
  if (value === undefined) return { status: 'skipped', reason: 'no harvested value' };

  const existing = (scenario.params ?? []).find(p => paramKeyOf(p) === paramKey);
  if (existing) { existing.value = value; return { status: 'updated' }; }

  const schema = (scenario.scenarioClass?.getParamSchema?.() ?? []).find(s => s.key === paramKey);
  const entry = schema
    ? {
        name:  schema.key,
        label: schema.label ?? paramKey,
        type:  schema.type ?? inferParamType(paramKey, value),
        group: schema.group ?? 'Harvested',
        value,
        ...(schema.description ? { description: schema.description } : {}),
        ...(schema.node    ? { node:    schema.node }    : {}),
        ...(schema.options ? { options: schema.options } : {}),
      }
    : {
        name:  paramKey,
        label: paramKey,
        type:  inferParamType(paramKey, value),
        group: 'Harvested',
        value,
        description: 'Created by an MPC harvest (design 39 §13). Schema metadata re-syncs on the next Rebuild.',
      };
  scenario.params.push(entry);
  return { status: 'created' };
}

/**
 * Best-effort param type for a synthesized entry. The known-key table covers the
 * schedule-shaped params the harvest writes, whose editors are type-dispatched —
 * getting these right means a created entry still renders as a table rather than
 * a raw JSON textarea.
 */
export function inferParamType(paramKey, value) {
  const KNOWN = {
    spendingExpenseBands:     'ExpenseBandList',
    spendingAgeBands:         'AgeBandList',
    rothConversionSchedule:   'RothScheduleList',
    earlyWithdrawalSchedule:  'EarlyWithdrawalScheduleList',
    allocationGlidepath:      'AllocationGlidepath',
    allocationRegimeTargets:  'AllocationRegimeTargets',
    spendingStrategy:         'EnumMulti',
    behavioralStrategies:     'EnumMulti',
  };
  if (KNOWN[paramKey]) return KNOWN[paramKey];
  if (typeof value === 'boolean') return 'Boolean';
  if (typeof value === 'number')  return 'Number';
  if (Array.isArray(value))       return 'Object';
  if (value && typeof value === 'object') return 'Object';
  return 'Text';
}

/**
 * Add `value` to an EnumMulti list without dropping the user's other selections.
 *
 * Exported because the pre-apply feasibility check (harvest-feasibility.js) must
 * fold the SAME enabling params this writer will, or it would verify a plan
 * different from the one that gets applied — precisely the silent divergence F1
 * exists to close.
 */
export function withIncluded(current, value) {
  if (Array.isArray(current)) return current.includes(value) ? current.slice() : [...current, value];
  if (current == null || current === '') return [value];
  return current === value ? current : [current, value];
}
