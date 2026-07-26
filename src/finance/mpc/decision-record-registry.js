/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

const LAYER = 'decision';

/**
 * Registry for MPC decision records (design 39 Step 5c + §13 H4).
 *
 * Records live in the shared Graph under `layer:'decision'` — their own layer, so
 * `byLayer('scenario')` (and therefore the scenario picker and `fin-sim-scenarios`
 * storage) never sees them. That whitelist is the Step 5c fix and stays.
 *
 * What §13 changes is durability: a run's decisions are the *source* the harvest
 * reads (§13.2), so losing them to a page reload loses an un-harvested run. This
 * registry backs the layer with its own `fin-sim-decisions` storage — same pattern
 * as DecisionGraphRegistry over `layer:'analysis'`.
 *
 * Records are still NOT scenarios: they carry no persons/accounts/toolsets/params,
 * so nothing here makes them loadable.
 */
export class DecisionRecordRegistry {
  constructor(storage, graph) {
    this._storage = storage;
    this._graph   = graph;
    this._init();
  }

  /** Re-hydrate persisted records into the `decision` layer. */
  _init() {
    const data = this._storage?.load?.() ?? { records: [] };
    for (const r of (data.records ?? [])) {
      if (!r?.id) continue;
      r.layer = LAYER;                       // never trust a persisted layer
      if (!this._graph.getNode(r.id)) this._graph.addNode(r);
    }
  }

  /** Every record currently in the layer (graph is the source of truth). */
  getAll() { return this._graph.byLayer(LAYER); }

  /**
   * Persist the layer's current contents. Called after a record is added (the
   * writer is `recordDecisionRecord`, which only touches the graph — keeping the
   * graph the single source of truth and this a pure mirror).
   */
  persist() {
    this._storage?.save?.({ records: this.getAll() });
  }

  /** Drop every record, in the graph and in storage. */
  clear() {
    this._graph.clearLayer(LAYER);
    this.persist();
  }

  /** Drop one run's records (the harvest UI's per-run delete). */
  clearRun(runId) {
    for (const n of this.getAll()) {
      if (n?.runId === runId) this._graph.removeNode(n.id);
    }
    this.persist();
  }
}
