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
 * Owns an internal Map<id, item> as the source of truth.  Wiring reducers
 * into a ReducerPipeline is the caller's responsibility.
 */
export class ReducerService extends BaseService {

  // ─── Create ───────────────────────────────────────────────────────────────

  createNoOpReducer(name = 'No-Op', priority = PRIORITY.LOGGING + 5) {
    const item = new NoOpReducer(name, priority);
    item.id = this._generateId('r');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createFieldReducer(fieldName, name = 'Field Reducer', priority = PRIORITY.METRICS) {
    const item = new FieldReducer(name, priority, fieldName);
    item.id = this._generateId('r');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createStateFieldReducer(fieldName, generate, name = 'State Field Reducer', priority = PRIORITY.POSITION_UPDATE) {
    const item = new StateFieldReducer(name, priority, fieldName, generate);
    item.id = this._generateId('r');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createMetricReducer(metricName, name = 'Metric Reducer', priority = PRIORITY.METRICS) {
    const item = new MetricReducer(name, priority, metricName);
    item.id = this._generateId('r');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createArrayMetricReducer(fieldName, name = 'Array Metric Reducer', priority = PRIORITY.METRICS) {
    const item = new ArrayMetricReducer(name, priority, fieldName);
    item.id = this._generateId('r');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createNumericSumMetricReducer(metricName, name = 'Sum Metric Reducer', priority = PRIORITY.METRICS) {
    const item = new NumericSumMetricReducer(name, priority, metricName);
    item.id = this._generateId('r');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createMultiplicativeMetricReducer(metricName, name = 'Multiplicative Metric Reducer', priority = PRIORITY.METRICS) {
    const item = new MultiplicativeMetricReducer(name, priority, metricName);
    item.id = this._generateId('r');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  /**
   * Apply `changes` to an existing reducer and publish an UPDATE event.
   *
   * Accepts either the item's string ID or the reducer object.  The item is
   * resolved from the internal map so the originalItem snapshot is taken
   * before the mutation is applied.
   *
   * @param {string|import('../simulation-framework/reducers.js').Reducer} idOrReducer
   * @param {object} changes
   * @returns {import('../simulation-framework/reducers.js').Reducer}
   */
  updateReducer(idOrReducer, changes = {}) {
    const reducer = this._resolve(idOrReducer);
    const originalItem = Object.assign(Object.create(Object.getPrototypeOf(reducer)), reducer);
    Object.assign(reducer, changes);
    this._publish('UPDATE', reducer.constructor.name, reducer, originalItem);
    return reducer;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  /**
   * Remove the reducer from the service map and publish a DELETE event.
   * The caller is responsible for unregistering it from the ReducerPipeline.
   *
   * @param {string|import('../simulation-framework/reducers.js').Reducer} idOrReducer
   * @returns {import('../simulation-framework/reducers.js').Reducer}
   */
  deleteReducer(idOrReducer) {
    const reducer = this._resolve(idOrReducer);
    this._unregister(reducer.id);
    this._publish('DELETE', reducer.constructor.name, reducer, reducer);
    return reducer;
  }
}
