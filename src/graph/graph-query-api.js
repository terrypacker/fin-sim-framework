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

import { QueryApi } from "../query/query-api.js";


export class GraphQueryApi extends QueryApi {
  constructor(graph) {
    super(graph);
    this._graph = graph;
  }

  /**
   * Optimization to filter by kind once for repeated queries
   * @param where
   * @return {*}
   * @private
   */
  _createDataSource(where) {
    const kind = this._extractKind(where);
    return kind
        ? this._graph.getKind(kind)
        : this._graph.getAll();
  }

  // =========================================================
  // Public API
  // =========================================================
  //TODO Implement graph edge queries

  // =========================================================
  // Optimization
  // =========================================================

  _extractKind(node) {
    if (!node) return null;

    if (node.op === 'eq' && node.field === 'kind') {
      return node.value;
    }

    if (node.conditions) {
      for (const c of node.conditions) {
        const k = this._extractKind(c);
        if (k) return k;
      }
    }

    if (node.condition) {
      return this._extractKind(node.condition);
    }

    return null;
  }

}
