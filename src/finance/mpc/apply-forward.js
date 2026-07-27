/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OptimizationProblem }      from '../optimization/optimization-problem.js';
import { OPTIMIZATION_OBJECTIVES }  from '../optimization/optimization-objectives.js';
import { Edge, EDGE_TYPES }         from '../../graph/edge.js';

/**
 * Apply-forward actuation (design/39 Step 2, §5).
 *
 * Applying a recommended (or user-overridden) control move must affect only the
 * future (t > now), leaving the realized past untouched. The clean primitive for
 * that is the snapshot-seeded rollout from Step 1:
 *
 *   - the now-snapshot freezes the realized past (state computed under the OLD
 *     controls) — it is injected verbatim, never re-simulated, and
 *   - the forward roll COMPILES FRESH with the NEW control params baked into the
 *     wiring, so the new control is effective strictly from "now" forward.
 *
 * This deliberately avoids ScenarioLoader's full compile-from-t0 replay (the
 * rebuild/revert + harvest traps in §5). It is also fully isolated — no mutation
 * of any live/shared Simulation — which is exactly what the receding-horizon MPC
 * loop (Step 3) needs when it evaluates candidate moves and advances "now".
 *
 * The live, interactive cockpit "Apply" button (mutating the user's running sim
 * via SimulationSync) layers on top of this in the Step 5 UI; the correctness
 * contract it must honour — forward-effective, past untouched — is what the
 * §9 gate (`tests/unit/apply-forward.test.mjs`) proves here.
 *
 * @param {object}  opts
 * @param {object}  opts.snapshot      - { date, state, queue, rngState? } from SimulationHistory.takeSnapshot().
 * @param {object} [opts.controlParams]- The forward-effective control edit (paramKey → value;
 *                                        nested paths like `spendingExpenseBands[1].monthlyAmount` ok).
 * @param {object} [opts.baseParams]   - Scenario params the snapshot was produced under.
 * @param {Date}    opts.simStart
 * @param {Date}    opts.simEnd
 * @param {object} [opts.cfgTemplate]  - Optional serialized cfg template (defaults to IntlRetirement).
 * @param {object} [opts.objective]    - OPTIMIZATION_OBJECTIVES entry for scoring the resulting path.
 * @returns {{ result: object, score: number, problem: OptimizationProblem }}
 */
export function rollForwardWithControls({
  snapshot,
  controlParams = {},
  baseParams    = {},
  simStart,
  simEnd,
  cfgTemplate   = null,
  objective     = OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
}) {
  if (!snapshot) throw new Error('rollForwardWithControls requires a now-snapshot');

  const problem = new OptimizationProblem({
    variables:    [],
    baseParams,
    objective,
    simStart,
    simEnd,
    initialState: { kind: 'snapshot', snapshot, cfgTemplate },
  });

  // Pass the control edit as the candidate so nested paths route through the
  // problem's path-aware set() (design 25a), exactly like a solver candidate.
  const { result, score } = problem.evaluate(controlParams);
  return { result, score, problem };
}

/**
 * Record a chosen forward path as an MPC **decision record** that DERIVES_FROM
 * its parent (design/17), so the decision is inspectable/comparable (design/30)
 * and the advisor's recommendation is auditable.
 *
 * A decision record is NOT a scenario: it carries no persons/accounts/toolsets/
 * params/initialState, just `{ asOfDate, controlParams, result }` + the parent
 * edge — selecting + Load would compile nothing. So it lives in its OWN graph
 * layer (`'decision'`), never `'scenario'` (design/39 Step 5c). That keeps it out
 * of `byLayer('scenario')` — hence out of `ScenarioRegistry.getUserScenarios()`,
 * the picker, and `fin-sim-scenarios` storage — at the root, with no per-reader
 * filtering. `DecisionRecordRegistry` backs the layer with its own
 * `fin-sim-decisions` storage so an un-harvested run survives a reload (§13 H4).
 *
 * **Harvest source (design/39 §13.2).** These records — not the controller — are
 * what the harvest reads: the controller is rebuilt after every Apply and every
 * clock step, and its `committed` bag has already collapsed the time dimension.
 * Three fields make the log self-describing enough to bake back into params:
 *   - `runId`       — which cockpit run this epoch belongs to (harvest targets ONE
 *                     run, §13 H1; without it, exploratory runs blend);
 *   - `controlKeys` — the levers active that epoch, so a mixed-lever log routes
 *                     each paramKey back to the lever that owns it;
 *   - `controlVars` — the epoch's variable descriptors (`_role`/`_class`/`_year`/
 *                     `_bandIndex`/`_effectiveYear`/`_controlKey`). `controlParams`
 *                     alone is enough to REPLAY but not to RE-KEY onto a band table
 *                     whose indices the harvest is about to rewrite.
 *
 * Minimal by design: the rich comparison surface is the Step 5 cockpit's concern;
 * this just lays the graph trail.
 *
 * @returns {object} the created decision-record node.
 */
export function recordDecisionRecord({
  graph,
  parentId,
  id,
  name,
  controlParams = {},
  asOfDate,
  simStart,
  simEnd,
  result,
  runId       = null,
  controlKeys = [],
  controlVars = [],
  extra = {},
}) {
  if (!graph) throw new Error('recordDecisionRecord requires a graph');
  if (!id)    throw new Error('recordDecisionRecord requires an id');

  const toIso = d => (d instanceof Date ? d.toISOString() : d);
  graph.addNode({
    id,
    layer:    'decision',
    name:     name ?? id,
    derived:  true,                 // marks this as an MPC candidate/applied path
    asOfDate: toIso(asOfDate),
    controlParams,
    result:   result ?? null,
    simStart: toIso(simStart),
    simEnd:   toIso(simEnd),
    runId,
    controlKeys,
    // Strip functions/undefined: descriptors must survive JSON round-tripping to
    // storage, and a solver-built variable may carry non-serializable extras.
    controlVars: controlVars.map(v => JSON.parse(JSON.stringify(v ?? {}))),
    ...extra,
  });

  // Edge direction: child (derived) → parent, per EDGE_TYPES.DERIVES_FROM.
  if (parentId != null && graph.getNode(parentId)) {
    graph.addEdge(new Edge({ from: id, to: parentId, type: EDGE_TYPES.DERIVES_FROM }));
  }

  return graph.getNode(id);
}

/**
 * Read the session's MPC decision records (design/39 Step 5c) as inspect-only
 * summaries for the cockpit "MPC Save Points" list — `{ id, asOfDate, move,
 * result }`, oldest "now" first. Sources straight from the `decision` graph layer
 * (the source of truth that survives controller rebuilds), so it is independent
 * of any one CockpitController's lifecycle. Not loadable scenarios — just a log.
 *
 * @param {object} graph - the shared Graph.
 * @param {object} [opts]
 * @param {string} [opts.runId] - keep only this run's epochs (design/39 §13 H1).
 * @returns {Array<{ id, asOfDate, move, result, goalMetric, runId, controlKeys, controlVars, controlParams }>}
 */
export function readDecisionRecords(graph, { runId = null } = {}) {
  if (!graph) return [];
  return graph.byLayer('decision')
    .filter(n => runId == null || n.runId === runId)
    .map(n => ({ id: n.id, asOfDate: n.asOfDate, move: n.name, result: n.result ?? null,
                 goalMetric: n.goalMetric ?? null,
                 runId: n.runId ?? null,
                 controlKeys:   n.controlKeys   ?? [],
                 controlVars:   n.controlVars   ?? [],
                 controlParams: n.controlParams ?? {} }))
    .sort((a, b) => String(a.asOfDate).localeCompare(String(b.asOfDate)));
}

/**
 * The session's decision records grouped into RUNS, newest first — the harvest
 * picker's model (§13 H1: harvest targets one run, no cross-run merge).
 *
 * Records predating the `runId` stamp (or written outside a cockpit run) collect
 * under a single `null` run so the log stays complete and harvestable.
 *
 * @returns {Array<{ runId, epochs: number, first: string, last: string, levers: string[],
 *                   goal: {key,label}|null, records: object[] }>}
 */
export function readDecisionRuns(graph) {
  const byRun = new Map();
  for (const r of readDecisionRecords(graph)) {
    const key = r.runId ?? null;
    if (!byRun.has(key)) byRun.set(key, []);
    byRun.get(key).push(r);
  }
  const runs = [...byRun.entries()].map(([runId, records]) => ({
    runId,
    epochs: records.length,
    first:  records[0]?.asOfDate ?? null,
    last:   records[records.length - 1]?.asOfDate ?? null,
    levers: [...new Set(records.flatMap(r => r.controlKeys ?? []))],
    goal:   records[records.length - 1]?.goalMetric ?? null,
    records,
  }));
  // Newest run first: by the run's LAST epoch, so a run resumed later still sorts
  // by its most recent activity. `null`-run (legacy/unstamped) sorts last.
  return runs.sort((a, b) => {
    if (a.runId == null) return 1;
    if (b.runId == null) return -1;
    return String(b.last).localeCompare(String(a.last));
  });
}
