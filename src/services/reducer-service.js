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
  ScriptedReducer,
  ArrayReducer,
  NumericSumReducer,
  MultiplicativeReducer,
  PRIORITY,
  REDUCER_CLASSES,
} from '../simulation-framework/reducers.js';

/**
 * Service for managing Reducer instances throughout their lifecycle.
 *
 * Owns an internal Map<id, item> as the source of truth.  Wiring reducers
 * into a ReducerPipeline is the caller's responsibility.
 */
export class ReducerService extends BaseService {
  constructor(bus) { super(bus, 'r'); }

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

  createArrayReducer(fieldName, name = 'Array Metric Reducer', priority = PRIORITY.METRICS) {
    const item = new ArrayReducer(name, priority, fieldName);
    item.id = this._generateId('r');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createNumericSumReducer(metricName, name = 'Sum Metric Reducer', priority = PRIORITY.METRICS) {
    const item = new NumericSumReducer(name, priority, metricName);
    item.id = this._generateId('r');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createMultiplicativeReducer(metricName, name = 'Multiplicative Metric Reducer', priority = PRIORITY.METRICS) {
    const item = new MultiplicativeReducer(name, priority, metricName);
    item.id = this._generateId('r');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createScriptedReducer(fieldName = '', script = '// return value (fieldName set) or partial state object\nreturn {};', name = 'Scripted Reducer', priority = PRIORITY.POSITION_UPDATE) {
    const item = new ScriptedReducer(name, priority, fieldName, script);
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

  /**
   * Replace an existing reducer with a new instance of the given type,
   * preserving id, name, priority, reducedActions, and generatedActions.
   * Extra properties (e.g. fieldName, metricName) can be supplied via extraProps.
   *
   * This is the correct way to change a reducer's type: swapping the instance
   * keeps constructor.name, getDescription(), and reduce() all in sync with
   * the stored reducerType string.
   *
   * @param {string|Reducer} idOrReducer
   * @param {string}         newType    - key in REDUCER_CLASSES
   * @param {object}         [extraProps]
   * @returns {Reducer}
   */
  replaceReducer(idOrReducer, newType, extraProps = {}) {
    const old = this._resolve(idOrReducer);
    const Cls = REDUCER_CLASSES[newType];
    if (!Cls) throw new Error(`ReducerService: unknown reducer type "${newType}"`);

    const fresh = new Cls(old.name, old.priority);
    fresh.id               = old.id;
    fresh.reducedActions   = old.reducedActions;
    fresh.generatedActions = old.generatedActions;
    Object.assign(fresh, extraProps);

    this._items.set(fresh.id, fresh);
    this._publish('UPDATE', newType, fresh, old);
    return fresh;
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
