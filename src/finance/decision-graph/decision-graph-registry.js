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
 * Registry for DecisionGraph configs.
 *
 * Decision graphs live in the shared Graph under layer:'analysis' so they
 * survive ServiceRegistry.reset() — the same pattern ScenarioRegistry uses
 * for layer:'scenario' nodes.
 *
 * ID scheme: 'dg:<N>'  (N = auto-incrementing index)
 */
export class DecisionGraphRegistry {
  constructor(dgStorage, graph) {
    this._storage = dgStorage;
    this._graph   = graph;
    this._data    = { graphs: [] };
    this._init();
  }

  _init() {
    this._data = this._storage.load();
    (this._data.graphs ?? []).forEach(g => {
      g.layer = 'analysis';
      if (!g.id) g.id = `dg:${this._nextIndex()}`;
      this._graph.addNode(g);
    });
  }

  getAll() {
    return this._graph.byLayer('analysis');
  }

  get(id) {
    const node = this._graph.getNode(id);
    return node?.layer === 'analysis' ? node : undefined;
  }

  save(dg) {
    dg.layer = 'analysis';
    if (!dg.id) dg.id = `dg:${this._nextIndex()}`;
    if (this._graph.getNode(dg.id)) {
      this._graph.updateNode(dg.id, dg);
    } else {
      this._graph.addNode(dg);
    }
    this._persist();
    return dg;
  }

  delete(id) {
    this._graph.removeNode(id);
    this._persist();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _nextIndex() {
    const indices = this.getAll()
      .map(n => parseInt(n.id?.slice(3), 10))
      .filter(n => !isNaN(n));
    return indices.length > 0 ? Math.max(...indices) + 1 : 0;
  }

  _persist() {
    this._data.graphs = this.getAll();
    this._storage.save(this._data);
  }
}
