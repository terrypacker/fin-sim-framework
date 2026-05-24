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
 * Period — a named time interval used as an aggregation container.
 *
 * Plain data object (structuredClone-safe) so it can appear in simulation state.
 *
 * @typedef {'MONTH'|'YEAR_US'|'YEAR_AU'|'QUARTER'|'CUSTOM'} PeriodType
 */
export class Period {
  /**
   * @param {object} opts
   * @param {string}      opts.id       - Unique identifier (e.g. 'M-2024-01', 'US-2024')
   * @param {PeriodType}  opts.type     - Period classification
   * @param {string}      opts.name     - Human-readable label
   * @param {number}      opts.startMs  - Inclusive start (UTC epoch ms)
   * @param {number}      opts.endMs    - Exclusive end (UTC epoch ms)
   * @param {object}      [opts.metaData] - Optional auxiliary data
   */
  constructor({ id, type, name, startMs, endMs, metaData } = {}) {
    if (!id)                    throw new Error('Period: id is required');
    if (!type)                  throw new Error('Period: type is required');
    if (!name)                  throw new Error('Period: name is required');
    if (startMs == null)        throw new Error('Period: startMs is required');
    if (endMs == null)          throw new Error('Period: endMs is required');
    if (startMs >= endMs)       throw new Error(`Period ${id}: startMs must be < endMs`);

    this.id       = id;
    this.type     = type;
    this.name     = name;
    this.startMs  = startMs;
    this.endMs    = endMs;
    if (metaData !== undefined) this.metaData = metaData;
  }
}

/**
 * PeriodRelationship — an explicit parent→child link in the period DAG.
 *
 * Plain data object (structuredClone-safe).
 */
export class PeriodRelationship {
  /**
   * @param {object} opts
   * @param {string}  opts.parentId - ID of the parent period
   * @param {string}  opts.childId  - ID of the child period
   * @param {number}  [opts.ordinal] - Ordering within the parent (e.g., month 1–12)
   */
  constructor({ parentId, childId, ordinal } = {}) {
    if (!parentId) throw new Error('PeriodRelationship: parentId is required');
    if (!childId)  throw new Error('PeriodRelationship: childId is required');
    if (parentId === childId) throw new Error('PeriodRelationship: parentId and childId must differ');

    this.parentId = parentId;
    this.childId  = childId;
    if (ordinal !== undefined) this.ordinal = ordinal;
  }
}

/**
 * PeriodService — DAG registry and query engine for Period objects.
 *
 * Periods are defined before simulation runs. The service is the single source
 * of truth for period structure and query logic — no period logic should be
 * scattered in simulation handlers or reducers.
 *
 * Usage:
 *   const svc = new PeriodService();
 *   svc.addPeriod(new Period({ id: 'US-2024', type: 'YEAR_US', name: '2024',
 *                               startMs: ..., endMs: ... }));
 *   svc.addPeriod(new Period({ id: 'M-2024-01', ... }));
 *   svc.addRelationship(new PeriodRelationship({ parentId: 'US-2024', childId: 'M-2024-01', ordinal: 1 }));
 *
 *   svc.getPeriodsAtDate(new Date('2024-01-15'));
 *   // → [Period(M-2024-01), Period(US-2024), ...]
 *
 *   svc.rollup('US-2024');
 *   // → [Period(M-2024-01), ..., Period(M-2024-12)]
 *
 *   svc.aggregate('US-2024', p => metrics[p.id]?.income ?? 0);
 *   // → number
 */
export class PeriodService {
  constructor() {
    /** @type {Map<string, Period>} */
    this._periodById = new Map();

    /** @type {Map<string, PeriodRelationship[]>} parent → child rels */
    this._childrenByParent = new Map();

    /** @type {Map<string, PeriodRelationship[]>} child → parent rels */
    this._parentsByChild = new Map();

    /** @type {Period[]} sorted ascending by startMs */
    this._periodsByStart = [];
  }

  // ---------------------------------------------------------------------------
  // Mutation APIs
  // ---------------------------------------------------------------------------

  /**
   * Register a Period. If a period with the same id already exists and is
   * identical, the call is a no-op (idempotent). Conflicting ids throw.
   * @param {Period} period
   */
  addPeriod(period) {
    if (!(period instanceof Period)) {
      throw new Error('PeriodService.addPeriod: argument must be a Period instance');
    }
    const existing = this._periodById.get(period.id);
    if (existing) {
      if (existing.startMs === period.startMs && existing.endMs === period.endMs) {
        return; // idempotent
      }
      throw new Error(`PeriodService.addPeriod: conflicting period id '${period.id}'`);
    }
    this._periodById.set(period.id, period);

    // Insert into sorted array (binary search for position)
    const idx = this._sortedInsertIndex(period.startMs);
    this._periodsByStart.splice(idx, 0, period);
  }

  /**
   * Register multiple periods.
   * @param {Period[]} periods
   */
  addPeriods(periods) {
    for (const p of periods) this.addPeriod(p);
  }

  /**
   * Register a PeriodRelationship (parent→child link).
   * Validates:
   *   - Both periods must be registered
   *   - Time consistency: child bounds within parent bounds
   *   - No cycles introduced
   * @param {PeriodRelationship} rel
   */
  addRelationship(rel) {
    if (!(rel instanceof PeriodRelationship)) {
      throw new Error('PeriodService.addRelationship: argument must be a PeriodRelationship instance');
    }

    const parent = this._periodById.get(rel.parentId);
    const child  = this._periodById.get(rel.childId);

    if (!parent) throw new Error(`PeriodService.addRelationship: parent '${rel.parentId}' not found`);
    if (!child)  throw new Error(`PeriodService.addRelationship: child '${rel.childId}' not found`);

    // Time consistency
    if (child.startMs < parent.startMs || child.endMs > parent.endMs) {
      throw new Error(
        `PeriodService.addRelationship: child '${rel.childId}' time bounds ` +
        `[${child.startMs}, ${child.endMs}) fall outside parent '${rel.parentId}' ` +
        `[${parent.startMs}, ${parent.endMs})`
      );
    }

    // Cycle detection: would adding this edge create a path from child back to parent?
    if (this._wouldCreateCycle(rel.parentId, rel.childId)) {
      throw new Error(
        `PeriodService.addRelationship: adding '${rel.parentId}'→'${rel.childId}' would create a cycle`
      );
    }

    if (!this._childrenByParent.has(rel.parentId)) this._childrenByParent.set(rel.parentId, []);
    if (!this._parentsByChild.has(rel.childId))    this._parentsByChild.set(rel.childId, []);

    this._childrenByParent.get(rel.parentId).push(rel);
    this._parentsByChild.get(rel.childId).push(rel);
  }

  /**
   * Register multiple relationships.
   * @param {PeriodRelationship[]} rels
   */
  addRelationships(rels) {
    for (const r of rels) this.addRelationship(r);
  }

  // ---------------------------------------------------------------------------
  // Query APIs (pure functions)
  // ---------------------------------------------------------------------------

  /**
   * Return the period with the given id.
   * @param {string} id
   * @returns {Period}
   */
  getPeriod(id) {
    const p = this._periodById.get(id);
    if (!p) throw new Error(`PeriodService.getPeriod: '${id}' not found`);
    return p;
  }

  /**
   * Return all registered periods, sorted by startMs.
   * @returns {Period[]}
   */
  getAllPeriods() {
    return this._periodsByStart.slice();
  }

  /**
   * Return all periods whose interval contains the given UTC millisecond timestamp.
   * Condition: startMs <= ts < endMs
   * @param {number} ts - UTC epoch milliseconds
   * @returns {Period[]}
   */
  getPeriodsAt(ts) {
    const result = [];
    for (const p of this._periodsByStart) {
      if (p.startMs > ts) break; // sorted, so no further matches possible
      if (ts < p.endMs) result.push(p);
    }
    return result;
  }

  /**
   * Return all periods whose interval contains the given Date.
   * @param {Date} date
   * @returns {Period[]}
   */
  getPeriodsAtDate(date) {
    return this.getPeriodsAt(date.getTime());
  }

  /**
   * Return leaf descendant periods under the given period (DFS).
   * A leaf is a period with no registered children.
   * If the given period is itself a leaf, returns [period].
   * @param {string} periodId
   * @returns {Period[]}
   */
  rollup(periodId) {
    if (!this._periodById.has(periodId)) {
      throw new Error(`PeriodService.rollup: '${periodId}' not found`);
    }
    const result = [];
    const stack  = [periodId];

    while (stack.length) {
      const current  = stack.pop();
      const children = this._childrenByParent.get(current) || [];

      if (children.length === 0) {
        result.push(this._periodById.get(current));
      } else {
        for (const rel of children) {
          stack.push(rel.childId);
        }
      }
    }

    return result;
  }

  /**
   * Aggregate a metric across all leaf periods under the given period.
   * @param {string} periodId
   * @param {function(Period): number} metricFn
   * @returns {number}
   */
  aggregate(periodId, metricFn) {
    const leaves = this.rollup(periodId);
    let total = 0;
    for (const p of leaves) total += metricFn(p);
    return total;
  }

  /**
   * Return immediate parent periods of the given period.
   * @param {string} periodId
   * @returns {Period[]}
   */
  getParents(periodId) {
    return (this._parentsByChild.get(periodId) || [])
      .map(rel => this._periodById.get(rel.parentId));
  }

  /**
   * Return immediate child periods of the given period.
   * @param {string} periodId
   * @returns {Period[]}
   */
  getChildren(periodId) {
    return (this._childrenByParent.get(periodId) || [])
      .map(rel => this._periodById.get(rel.childId));
  }

  /**
   * Traverse ancestors until a period of the given type is found.
   * Returns the first match (BFS upward), or null if not found.
   * @param {string} periodId
   * @param {PeriodType} targetType
   * @returns {Period|null}
   */
  getPath(periodId, targetType) {
    const visited = new Set();
    const queue   = [periodId];

    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);

      const period = this._periodById.get(current);
      if (!period) continue;
      if (current !== periodId && period.type === targetType) return period;

      for (const rel of (this._parentsByChild.get(current) || [])) {
        queue.push(rel.parentId);
      }
    }

    return null;
  }

  /**
   * Returns true if the period has no registered children (is a leaf).
   * @param {string} periodId
   * @returns {boolean}
   */
  isLeaf(periodId) {
    const children = this._childrenByParent.get(periodId);
    return !children || children.length === 0;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Binary search for insert index in the startMs-sorted array.
   * @param {number} startMs
   * @returns {number}
   */
  _sortedInsertIndex(startMs) {
    let lo = 0, hi = this._periodsByStart.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._periodsByStart[mid].startMs <= startMs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Returns true if adding an edge parentId→childId would create a cycle.
   * A cycle would exist if childId is already an ancestor of parentId.
   * @param {string} parentId
   * @param {string} childId
   * @returns {boolean}
   */
  _wouldCreateCycle(parentId, childId) {
    // BFS upward from parentId; if we reach childId, there's already a path
    const visited = new Set();
    const queue   = [parentId];

    while (queue.length) {
      const current = queue.shift();
      if (current === childId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const rel of (this._parentsByChild.get(current) || [])) {
        queue.push(rel.parentId);
      }
    }

    return false;
  }
}
