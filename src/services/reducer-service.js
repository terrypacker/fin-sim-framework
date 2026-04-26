/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseService } from './base-service.js';
import {
  NoOpReducer,
  FieldReducer,
  StateFieldReducer,
  MetricReducer,
  ArrayMetricReducer,
  NumericSumMetricReducer,
  MultiplicativeMetricReducer,
  PRIORITY,
} from '../simulation-framework/reducers.js';

/**
 * Service for managing Reducer instances throughout their lifecycle.
 *
 * Exposes factory methods for each built-in Reducer subclass, each of which
 * publishes a CREATE ServiceActionEvent.  updateReducer and deleteReducer
 * publish UPDATE and DELETE events respectively.
 *
 * Wiring reducers into a ReducerPipeline (and re-wiring after changes) is the
 * caller's responsibility.
 */
export class ReducerService extends BaseService {

  // ─── Create ───────────────────────────────────────────────────────────────

  createNoOpReducer(name = 'No-Op', priority = PRIORITY.LOGGING + 5) {
    const item = new NoOpReducer(name, priority);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createFieldReducer(fieldName, name = 'Field Reducer', priority = PRIORITY.METRICS) {
    const item = new FieldReducer(name, priority, fieldName);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createStateFieldReducer(fieldName, generate, name = 'State Field Reducer', priority = PRIORITY.POSITION_UPDATE) {
    const item = new StateFieldReducer(name, priority, fieldName, generate);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createMetricReducer(metricName, name = 'Metric Reducer', priority = PRIORITY.METRICS) {
    const item = new MetricReducer(name, priority, metricName);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createArrayMetricReducer(fieldName, name = 'Array Metric Reducer', priority = PRIORITY.METRICS) {
    const item = new ArrayMetricReducer(name, priority, fieldName);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createNumericSumMetricReducer(metricName, name = 'Sum Metric Reducer', priority = PRIORITY.METRICS) {
    const item = new NumericSumMetricReducer(name, priority, metricName);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createMultiplicativeMetricReducer(metricName, name = 'Multiplicative Metric Reducer', priority = PRIORITY.METRICS) {
    const item = new MultiplicativeMetricReducer(name, priority, metricName);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  /**
   * Apply `changes` to an existing reducer in-place, then publish an UPDATE event.
   * Re-wiring the reducer in its ReducerPipeline after this call is the
   * caller's responsibility.
   *
   * @param {import('../simulation-framework/reducers.js').Reducer} reducer
   * @param {object} changes
   * @returns {import('../simulation-framework/reducers.js').Reducer}
   */
  updateReducer(reducer, changes = {}) {
    const originalItem = Object.assign(
      Object.create(Object.getPrototypeOf(reducer)),
      reducer
    );
    Object.assign(reducer, changes);
    this._publish('UPDATE', reducer.constructor.name, reducer, originalItem);
    return reducer;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  /**
   * Publish a DELETE event for the given reducer.
   * The caller is responsible for unregistering it from the ReducerPipeline.
   *
   * @param {import('../simulation-framework/reducers.js').Reducer} reducer
   * @returns {import('../simulation-framework/reducers.js').Reducer}
   */
  deleteReducer(reducer) {
    this._publish('DELETE', reducer.constructor.name, reducer, reducer);
    return reducer;
  }
}
