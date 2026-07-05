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
 * filtering. The `decision` layer has no storage backing, so records are
 * session-only (gone on reload); cross-reload persistence is design/39 Option #2.
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
 * @returns {Array<{ id: string, asOfDate: string, move: string, result: object|null }>}
 */
export function readDecisionRecords(graph) {
  if (!graph) return [];
  return graph.byLayer('decision')
    .map(n => ({ id: n.id, asOfDate: n.asOfDate, move: n.name, result: n.result ?? null }))
    .sort((a, b) => String(a.asOfDate).localeCompare(String(b.asOfDate)));
}
