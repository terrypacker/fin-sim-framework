/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { upsertParam }            from './harvest-apply.js';
import { checkHarvestFeasibility } from './harvest-feasibility.js';

/**
 * DESIGN 81 phase 4 — RECORD: the decision log becomes a bag entry.
 *
 * Phases 1–3 built the playback and left the recorder for last, on purpose: there was nothing
 * to record until every lever could be played back. This module closes that loop. It reads the
 * same `decision`-layer log the harvest reads (§13.2), and produces the other thing that log
 * can become — not a collapsed set of age bands, but the run itself.
 *
 * ─── the ONE-WAY boundary (§4.3) ─────────────────────────────────────────────────
 *
 * The graph keeps the RECORDING; the param keeps the PLAN. They have different lifecycles: the
 * log is a session's working notes, deletable, never read by the engine; a bag entry is part of
 * the plan, travels with an export, and is read on every period advance. Promotion runs one
 * way, and is gated (design 80 F1) because writing a bag entry IS a promotion.
 *
 * ─── what this is NOT ────────────────────────────────────────────────────────────
 *
 * Not the harvest. `harvestDecisions` answers "what static params approximate this run", which
 * design 80 measured is a question with no faithful answer for a plan with no margin. This
 * answers "what did the controller actually decide", which is lossless by construction — and
 * that is why D10 demotes the harvest to an export rather than deleting it: a three-band
 * summary a human can argue with is still worth having, it is just no longer what the plan is.
 */

/** ISO day, for run ids and the picker's label. */
function _day(iso) { return String(iso ?? '').slice(0, 10); }

/**
 * Turn a run's decision records into the `{ date, lever, key, value }` table §4.4 specifies.
 *
 * The routing is `harvest.js`'s, deliberately: `controlKeys` says which levers were active that
 * epoch, `controlVars` carries the descriptors (`_startAge`, `_year`, `_role`, `_class`), and
 * `controlParams` carries the committed values. Reading the log the same way the harvest reads
 * it is what makes "record" and "harvest" two views of one thing rather than two parsers that
 * can disagree about what an epoch decided.
 *
 * `scheduleKey` is where the index dies (D5). `controlVars[i].paramKey` is
 * `spendingExpenseBands[19].monthlyAmount`; the row stores `band@69`.
 *
 * @param {object[]} records        one run's records, from `readDecisionRecords(graph, {runId})`
 * @param {object}   opts
 * @param {object}   opts.controlsByKey  { [COCKPIT_CONTROLS key]: spec } — for `scheduleKey`
 * @param {boolean} [opts.dedupeUnchanged=true]  drop a row that re-decides the value already
 *                                               in force (see below)
 * @returns {{ decisions: Array, warnings: string[] }}
 */
export function decisionsFromRecords(records = [], { controlsByKey = {}, dedupeUnchanged = true } = {}) {
  const rows = [...records].sort((a, b) => String(a.asOfDate).localeCompare(String(b.asOfDate)));
  const decisions = [];
  const warnings  = [];
  const inForce   = new Map();          // `${lever}\u0000${key}` -> last emitted value

  for (const r of rows) {
    const keys = (r.controlKeys ?? []);
    const all  = r.controlVars ?? [];
    // Records written before multi-lever tagging carry untagged vars; with a single active
    // lever those are unambiguously its own. Same rule as `harvest.js:_epochsFor`.
    const tagged = all.some(v => v?._controlKey);

    for (const lever of (keys.length ? keys : [all[0]?._controlKey].filter(Boolean))) {
      const spec = controlsByKey[lever];
      if (!spec) {
        if (!warnings.some(w => w.includes(lever))) {
          warnings.push(`Lever “${lever}” is no longer registered — its decisions were skipped.`);
        }
        continue;
      }
      const vars = tagged ? all.filter(v => v._controlKey === lever) : all;
      for (const v of vars) {
        const value = r.controlParams?.[v?.paramKey];
        if (value === undefined) continue;
        const key = spec.scheduleKey ? spec.scheduleKey(v) : (v?.paramKey ?? null);
        if (key == null) {
          warnings.push(`Lever “${lever}” produced no stable key for ${v?.paramKey} — row skipped.`);
          continue;
        }
        // A run that holds a lever steady for 30 epochs writes 30 identical rows. Dropping the
        // repeats is LOSSLESS for playback — `activeDecisionsAt` takes the latest row at or
        // before "now", so an unchanged value stays in force with or without them — and it is
        // the difference between a table a human can read and one they cannot. It is NOT the
        // POINT collapse D2 warns about: that keeps one value for the whole run and discards
        // the time dimension; this keeps every CHANGE and discards only restatements. MRR-3
        // asserts both forms replay identically.
        const id = `${lever}\u0000${key}`;
        if (dedupeUnchanged && _sameScalar(inForce.get(id), value)) continue;
        inForce.set(id, value);
        decisions.push({ date: r.asOfDate, lever, key, value });
      }
    }
  }
  return { decisions, warnings };
}

function _sameScalar(a, b) {
  return a === b || (typeof a === 'number' && typeof b === 'number'
    && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-12);
}

/**
 * Build the whole bag entry — `{ source, decisions }` — from one run's log.
 *
 * `source` is provenance, and it is not decoration: §8's picker labels every option from it,
 * because a raw run id is not a choice anyone can make. `derivedFrom` is §4.3's lineage, held
 * as a PARENT POINTER rather than a graph edge — `DecisionRecordStorage.save` persists nodes
 * without edges, so an edge-based tree would not survive a page refresh.
 *
 * @param {object[]} records
 * @param {object}   opts
 * @param {object}   opts.controlsByKey
 * @param {string}  [opts.runId]            the cockpit run id; also the default bag key
 * @param {string}  [opts.derivedFrom]      the bag entry this run was re-solved from
 * @param {string}  [opts.baseScenarioId]   the scenario it was recorded against (Q5 provenance)
 * @param {string}  [opts.solver]           e.g. 'CEM/128'
 * @param {string}  [opts.recordedAt]       ISO; defaults to now
 * @returns {{ entry: {source: object, decisions: Array}|null, warnings: string[] }}
 */
export function buildRunEntry(records = [], {
  controlsByKey = {}, runId = null, derivedFrom = null, baseScenarioId = null,
  solver = null, recordedAt = null, dedupeUnchanged = true,
} = {}) {
  const { decisions, warnings } = decisionsFromRecords(records, { controlsByKey, dedupeUnchanged });
  if (decisions.length === 0) {
    warnings.push('This run decided nothing that can be recorded — no entry was created.');
    return { entry: null, warnings };
  }
  const sorted = [...records].sort((a, b) => String(a.asOfDate).localeCompare(String(b.asOfDate)));
  const source = {
    recordedAt:     recordedAt ?? new Date().toISOString(),
    runId,
    epochs:         sorted.length,
    first:          sorted[0]?.asOfDate ?? null,
    last:           sorted[sorted.length - 1]?.asOfDate ?? null,
    levers:         [...new Set(sorted.flatMap(r => r.controlKeys ?? []))],
    goal:           sorted[sorted.length - 1]?.goalMetric ?? null,
    solver,
    baseScenarioId,
    derivedFrom,
    rows:           decisions.length,
  };
  return { entry: { source, decisions }, warnings };
}

/**
 * The picker's one-line label (§8) — `9 levers · CEM/128 · 2026-09-18 · 44 epochs`.
 *
 * Shared by the UI select, the run picker and `run:inspect` so the three cannot describe the
 * same entry differently.
 */
export function describeRunSource(source, runId = null) {
  if (!source) return runId ?? 'recorded run';
  const parts = [];
  const n = source.levers?.length ?? 0;
  if (n) parts.push(`${n} lever${n === 1 ? '' : 's'}`);
  if (source.solver) parts.push(source.solver);
  if (source.recordedAt) parts.push(_day(source.recordedAt));
  if (source.epochs) parts.push(`${source.epochs} epoch${source.epochs === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : (runId ?? 'recorded run');
}

/** A bag key that is legible in a select and stable across a session. */
export function makeRunKey(source, existingBag = null) {
  const base = `run:${_day(source?.recordedAt) || 'undated'}`;
  let key = base, n = 2;
  while (existingBag && Object.prototype.hasOwnProperty.call(existingBag, key)) key = `${base}#${n++}`;
  return key;
}

/**
 * The design 80 F1 promotion gate, reused rather than rebuilt.
 *
 * `harvest-feasibility.js` says in its own header that this is what the split was for: "the
 * check takes a PLAN, and a plan with one entry is a valid input". A bag entry is two entries —
 * the bag and the selection — and folding them produces exactly the params the saved scenario
 * will carry, so the check runs the plan the user is about to create and asks the simulation
 * whether it runs out of money.
 *
 * Note what makes this gate *stronger* here than over a harvest: the thing being checked IS the
 * thing being saved, byte for byte. Over a harvest the check had to mirror `applyHarvestPlan`
 * entry-for-entry and could drift from it; here there is nothing to mirror.
 *
 * @returns the `checkHarvestFeasibility` verdict — `feasible: null` means "could not check",
 *   a third state the caller must render rather than treat as either answer.
 */
export function checkRunFeasibility({ runId, entry, baseParams = {}, simStart, simEnd,
                                      cfgTemplate = null, objective = undefined,
                                      check = checkHarvestFeasibility } = {}) {
  const bag = { ...(baseParams?.mpcRuns ?? {}), [runId]: entry };
  return check({
    plan: { entries: [
      { paramKey: 'mpcRuns',       to: bag },
      { paramKey: 'mpcActiveRun',  to: runId },
      { paramKey: 'mpcRunEnabled', to: true },
    ] },
    baseParams, simStart, simEnd, cfgTemplate, objective,
  });
}

/**
 * Write the entry into the scenario's bag and select it.
 *
 * ONE STORE, like `applyHarvestPlan`: this writes `scenario.params` and nothing else, and
 * `ScenarioLoader`'s params→parameters sync does the rest on Rebuild. Writing both is how the
 * two stores drift, which is a trap this repo has already paid for once.
 *
 * Deliberately does NOT Rebuild, save, or touch the running sim — same blast radius as the
 * harvest's writer: an edit you could have typed.
 *
 * @returns {{ runId, created: boolean, selected: boolean }}
 */
export function saveRunToScenario(scenario, { runId, entry, select = true } = {}) {
  if (!scenario) throw new Error('saveRunToScenario requires a scenario');
  if (!runId || !entry) throw new Error('saveRunToScenario requires a runId and an entry');
  if (!Array.isArray(scenario.params)) scenario.params = [];

  const current = (scenario.params ?? [])
    .find(p => (p.key ?? p.name) === 'mpcRuns')?.value;
  const bag = (current && typeof current === 'object' && !Array.isArray(current)) ? { ...current } : {};
  const created = !Object.prototype.hasOwnProperty.call(bag, runId);
  bag[runId] = entry;

  upsertParam(scenario, 'mpcRuns', bag);
  if (select) {
    upsertParam(scenario, 'mpcActiveRun', runId);
    // Selecting a run whose switch is off would look like a no-op and read as a bug. The
    // switch exists to be turned off DELIBERATELY (§8), not to be inherited from a previous
    // selection the user has moved on from.
    upsertParam(scenario, 'mpcRunEnabled', true);
  }
  return { runId, created, selected: select };
}
