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

/**
 * QueryApi
 *
 * A lightweight in-memory query engine for querying iterable-backed data structures.
 * Provides a flexible query DSL, predicate evaluation, sorting, and basic indexing
 * for efficient retrieval of items.
 *
 * ------------------------------------------------------------
 * Core Responsibilities
 * ------------------------------------------------------------
 * - Parse a query string (DSL) into an abstract syntax tree (AST)
 * - Compile the AST into executable predicates
 * - Execute queries against iterable data (filter, sort, paginate)
 * - Optimize lookups using indexes (e.g. id, name, kind)
 *
 * ------------------------------------------------------------
 * Query Execution Pipeline
 * ------------------------------------------------------------
 *   DSL/String → Tokenizer → Parser (AST)
 *             → Predicate Builder → Filter
 *             → Sort → Pagination
 *
 * ------------------------------------------------------------
 * Supported Query DSL
 * ------------------------------------------------------------
 * Logical Operators:
 *   &    → AND
 *   |    → OR
 *   !    → NOT
 *   (...) → grouping
 *
 * Comparison / Predicate Operators:
 *   field=value                → equality
 *   contains(field,value)      → substring match (case-insensitive)
 *   gt(field,value)            → greater than
 *   lt(field,value)            → less than
 *   in(field,valueArray)       → inclusion (array-based)
 *
 * Example:
 *   kind=handler & (contains(name,abc) | contains(name,xyz)) & !eq(status,disabled)
 *
 * ------------------------------------------------------------
 * Query Options
 * ------------------------------------------------------------
 * @param {Object} options
 * @param {string|Object} options.query
 *   - String: DSL query (parsed internally)
 *   - Object: pre-built AST (advanced usage)
 *
 * @param {Array<{field: string, dir?: 'asc'|'desc'}>} [options.sort]
 *   - Optional multi-field sorting configuration
 *
 * @param {number} [options.offset=0]
 *   - Pagination offset
 *
 * @param {number} [options.limit=50]
 *   - Pagination limit
 *
 * ------------------------------------------------------------
 * Performance Characteristics
 * ------------------------------------------------------------
 * - id lookups: O(1) via index
 * - name equality: O(1) bucket lookup
 * - filtered queries: O(n) over candidate set
 * - sorting: O(n log n)
 *
 * The API attempts to reduce scan size by:
 *   - Extracting indexed fields (e.g. id, kind, name)
 *   - Pre-selecting candidate sets before predicate evaluation
 *
 * ------------------------------------------------------------
 * Notes / Limitations
 * ------------------------------------------------------------
 * - `contains` queries are not indexed (full scan required)
 * - Complex NOT conditions cannot be index-optimized
 * - Indexes must be rebuilt or maintained if the graph mutates
 *
 * ------------------------------------------------------------
 * Typical Usage
 * ------------------------------------------------------------
 *   const api = new QueryApi(dataSource);
 *
 *   const result = await api.search({
 *     query: "kind=handler & contains(name,abc)",
 *     sort: [{ field: 'name', dir: 'asc' }],
 *     offset: 0,
 *     limit: 25
 *   });
 *
 *   console.log(result.items, result.total);
 *
 * ------------------------------------------------------------
 * Future Extensions (Design Intent)
 * ------------------------------------------------------------
 * - Index-aware query planning
 * - Prefix / full-text search
 * - Projection (select fields)
 * - Aggregations
 *
 * ------------------------------------------------------------
 * @class QueryApi
 */
export class QueryApi {
  /**
   * A data source has a getAll() method to return an iterable of items
   * @param dataSource
   */
  constructor(dataSource) {
    this._dataSource = dataSource;
    this._idIndex = new Map();     // id -> item
    this._nameIndex = new Map();   // lower(name) -> [items]
    this.rebuildIndexes = true;
  }


  // =========================================================
  // Public API
  // =========================================================

  getById(id) {
    if(this.rebuildIndexes) this._buildIndexes();
    return this._idIndex.get(String(id)) || null;
  }

  getByName(name) {
    if(this.rebuildIndexes) this._buildIndexes();
    return this._nameIndex.get(name) || null;
  }

  getAll() {
    return this._dataSource.getAll();
  }

  /**
   * Public search API:
   * await api.search({
   *   query: "kind=handler & contains(name,abc)",
   *   sort: [
   *     { field: 'name', dir: 'asc' }
   *   ]
   * });
   *
   * @param query
   * @param sort
   * @param offset
   * @param limit
   * @return {Promise<{items: *, total: *}>}
   */
  async search({ query, sort = [], offset = 0, limit = 50 }) {
    if(this.rebuildIndexes) this._buildIndexes();

    const where = typeof query === 'string'
        ? this._parse(query)
        : query;

    //Short circuit for get by id
    if (where.op === 'eq' && where.field === 'id') {
      const item = this._idIndex.get(String(where.value));
      return {
        items: item ? [item] : [],
        total: item ? 1 : 0
      };
    }

    let dataSource = this._extractIndexCandidates(where);

    // fallback to existing logic
    if (!dataSource) {
      dataSource = this._createDataSource(where);
    }

    //Filter
    const predicate = this._buildPredicate(where);
    let results = dataSource.filter(predicate);

    //Sort
    const comparator = this._buildComparator(sort);
    if (comparator) {
      //Modern JS engines are stable, but relying on it implicitly is risky long-term.
      results = results
      .map((item, idx) => ({ item, idx }))
      .sort((a, b) => comparator(a.item, b.item) || a.idx - b.idx)
      .map(x => x.item);
    }

    //Limit the return
    return {
      items: results.slice(offset, offset + limit),
      total: results.length
    };
  }

  // =========================================================
  // Optimization hook for subclasses
  // =========================================================
  _createDataSource(where) {
    return this._dataSource.getAll();
  }

  // =========================================================
  // Tokenizer
  // =========================================================

  _tokenize(input) {
    const tokens = [];
    let i = 0;

    const isAlpha = c => /[a-zA-Z_]/.test(c);
    const isAlphaNum = c => /[a-zA-Z0-9_]/.test(c);

    while (i < input.length) {
      const c = input[i];

      if (/\s/.test(c)) {
        i++;
        continue;
      }

      if (c === '&') { tokens.push({ type: 'AND' }); i++; continue; }
      if (c === '|') { tokens.push({ type: 'OR' }); i++; continue; }
      if (c === '!') { tokens.push({ type: 'NOT' }); i++; continue; }
      if (c === '(') { tokens.push({ type: 'LPAREN' }); i++; continue; }
      if (c === ')') { tokens.push({ type: 'RPAREN' }); i++; continue; }
      if (c === ',') { tokens.push({ type: 'COMMA' }); i++; continue; }
      if (c === '=') { tokens.push({ type: 'EQ' }); i++; continue; }

      // identifier
      if (isAlpha(c)) {
        let start = i;
        while (i < input.length && isAlphaNum(input[i])) i++;
        tokens.push({
          type: 'IDENT',
          value: input.slice(start, i)
        });
        continue;
      }

      // value (numbers / strings without quotes)
      let start = i;
      while (
          i < input.length &&
          !/[&|!(),=\s]/.test(input[i])
          ) i++;

      tokens.push({
        type: 'VALUE',
        value: input.slice(start, i)
      });
    }

    return tokens;
  }

  // =========================================================
  // Parser (recursive descent)
  // =========================================================

  _parse(input) {
    this._tokens = this._tokenize(input);
    this._pos = 0;
    return this._parseExpression();
  }

  _peek() {
    return this._tokens[this._pos];
  }

  _consume(type) {
    const token = this._tokens[this._pos];
    if (!token || token.type !== type) {
      throw new Error(`Expected ${type}, got ${token?.type}`);
    }
    this._pos++;
    return token;
  }

  _match(type) {
    const token = this._peek();
    if (token && token.type === type) {
      this._pos++;
      return true;
    }
    return false;
  }

  // OR level
  _parseExpression() {
    let node = this._parseTerm();

    while (this._match('OR')) {
      node = {
        op: 'or',
        conditions: [node, this._parseTerm()]
      };
    }

    return node;
  }

  // AND level
  _parseTerm() {
    let node = this._parseFactor();

    while (this._match('AND')) {
      node = {
        op: 'and',
        conditions: [node, this._parseFactor()]
      };
    }

    return node;
  }

  // NOT / grouping
  _parseFactor() {
    if (this._match('NOT')) {
      return {
        op: 'not',
        condition: this._parseFactor()
      };
    }

    if (this._match('LPAREN')) {
      const expr = this._parseExpression();
      this._consume('RPAREN');
      return expr;
    }

    return this._parsePredicate();
  }

  // leaf nodes
  _parsePredicate() {
    const ident = this._consume('IDENT').value;

    // eq syntax: field=value
    if (this._match('EQ')) {
      const valueToken = this._consumeAny(['IDENT', 'VALUE']);
      return {
        op: 'eq',
        field: ident,
        value: valueToken.value
      };
    }

    // function syntax: contains(name,abc)
    if (this._match('LPAREN')) {
      const field = this._consume('IDENT').value;
      this._consume('COMMA');
      const value = this._consumeAny(['IDENT', 'VALUE']).value;
      this._consume('RPAREN');

      return {
        op: ident,
        field,
        value
      };
    }

    throw new Error(`Invalid predicate starting with ${ident}`);
  }

  _consumeAny(types) {
    const token = this._peek();
    if (!token || !types.includes(token.type)) {
      throw new Error(`Expected one of ${types}, got ${token?.type}`);
    }
    this._pos++;
    return token;
  }

  // =========================================================
  // Predicate Builder
  // =========================================================

  _buildPredicate(node) {
    if (!node) return () => true;

    if (node.op === 'and') {
      const preds = node.conditions.map(c => this._buildPredicate(c));
      return item => preds.every(p => p(item));
    }

    if (node.op === 'or') {
      const preds = node.conditions.map(c => this._buildPredicate(c));
      return item => preds.some(p => p(item));
    }

    if (node.op === 'not') {
      const pred = this._buildPredicate(node.condition);
      return item => !pred(item);
    }

    return item => {
      const val = item[node.field];
      if (val == null) return false;

      switch (node.op) {
        case 'eq':
          return String(val) === String(node.value);

        case 'contains':
          return String(val)
          .toLowerCase()
          .includes(String(node.value).toLowerCase());

        case 'gt':
          return val > node.value;

        case 'lt':
          return val < node.value;

        case 'in':
          return Array.isArray(node.value) && node.value.includes(val);

        default:
          throw new Error(`Unknown operator: ${node.op}`);
      }
    };
  }

  // =========================================================
  // Comparator
  // =========================================================

  _buildComparator(sort = []) {
    if (!sort.length) return null;

    return (a, b) => {
      for (const { field, dir = 'asc' } of sort) {
        const av = a[field];
        const bv = b[field];

        // handle nulls consistently
        if (av == null && bv == null) continue;
        if (av == null) return 1;
        if (bv == null) return -1;

        // normalize strings
        const aVal = typeof av === 'string' ? av.toLowerCase() : av;
        const bVal = typeof bv === 'string' ? bv.toLowerCase() : bv;

        if (aVal < bVal) return dir === 'asc' ? -1 : 1;
        if (aVal > bVal) return dir === 'asc' ? 1 : -1;
      }

      return 0;
    };
  }

  // =========================================================
  // Optimization
  // =========================================================
  _invalidateIndexes() {
    this.rebuildIndexes = true;
  }

  _buildIndexes() {
    this._buildIndexesFrom(this.getAll());
  }
  _buildIndexesFrom(all) {
    // Clear before rebuilding
    this._idIndex.clear();
    this._nameIndex.clear();

    for (const item of all) {
      if (item.id != null) {
        this._idIndex.set(String(item.id), item);
      }

      if (item.name != null) {
        const key = String(item.name).toLowerCase();
        if (!this._nameIndex.has(key)) {
          this._nameIndex.set(key, []);
        }
        this._nameIndex.get(key).push(item);
      }
    }
    this.rebuildIndexes = false;
  }

  _extractIndexCandidates(node) {
    if (!node) return null;

    // id = X  → direct hit
    if (node.op === 'eq' && node.field === 'id') {
      const item = this._idIndex.get(String(node.value));
      return item ? [item] : [];
    }

    // name = X → exact match bucket
    if (node.op === 'eq' && node.field === 'name') {
      return this._nameIndex.get(String(node.value).toLowerCase()) || [];
    }

    // AND → intersect candidates
    if (node.op === 'and') {
      let sets = node.conditions
      .map(c => this._extractIndexCandidates(c))
      .filter(Boolean);

      if (!sets.length) return null;

      return sets.reduce((acc, curr) =>
          acc.filter(x => curr.includes(x))
      );
    }

    // OR → union candidates
    if (node.op === 'or') {
      let sets = node.conditions
      .map(c => this._extractIndexCandidates(c))
      .filter(Boolean);

      if (!sets.length) return null;

      return [...new Set(sets.flat())];
    }

    // NOT → can't safely optimize
    if (node.op === 'not') {
      return null;
    }

    return null;
  }
}
