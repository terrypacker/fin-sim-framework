/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export class ActionNode {
  constructor({
    id, type, date, parent, children, action,
    reducer, stateBefore, stateAfter, sourceEvent
  }) {
    this.id = id;
    this.type = type;
    this.date = date;
    this.parent = parent;
    this.children = children;
    this.action = action;
    this.reducer = reducer;
    this.stateBefore = stateBefore;
    this.stateAfter = stateAfter;
    this.sourceEvent = sourceEvent;
  }
}

export class SimulationEventGraph {
  constructor({} = {}) {
    this.actionGraph = new Map(); // actionId -> node

  }

  addActionNode(actionNode) {
    this.actionGraph.set(actionNode.id, actionNode);

    // Link to parent
    if (actionNode.parent !== null && this.actionGraph.has(actionNode.parent)) {
      this.actionGraph.get(actionNode.parent).children.push(actionNode.id);
    }
  }

  getNode(id) {
    return this.actionGraph.get(id);
  }

  /**
   * Go from root to leaves
   * @param rootId
   * @returns {*[]}
   */
  traceActionChain(rootId) {
    const result = [];

    function dfs(sim, id) {
      const node = sim.actionGraph.get(id);
      if (!node) return;

      result.push(node);

      for (const child of node.children) {
        dfs(sim, child);
      }
    }

    dfs(this, rootId);

    return result;
  }

  /**
   * Trace upstream to find cause
   * @param id
   * @returns {*[]}
   */
  traceActionsUp(id) {
    const chain = [];

    let current = this.actionGraph.get(id);

    while (current) {
      chain.push(current);
      current = current.parent !== null
          ? this.actionGraph.get(current.parent)
          : null;
    }

    return chain.reverse();
  }

  /**
   * Get all roots
   * @returns {any[]}
   */
  getRootActions() {
    return [...this.actionGraph.values()]
    .filter(n => n.parent === null);
  }

}
