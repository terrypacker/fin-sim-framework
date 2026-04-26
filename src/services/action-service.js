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
import { ActionFactory } from './action-factory.js';

/**
 * Service for managing Action instances throughout their lifecycle.
 *
 * Owns a singleton ActionFactory and wraps each factory method with a CREATE
 * event published to the shared EventBus.  updateAction and deleteAction
 * publish UPDATE and DELETE events respectively.
 *
 * All methods return the affected Action so callers can chain or register it
 * immediately.
 */
export class ActionService extends BaseService {
  constructor(bus) {
    super(bus);
    this._factory = new ActionFactory();
  }

  /** Access the underlying ActionFactory directly when needed. */
  get factory() {
    return this._factory;
  }

  // ─── Create ───────────────────────────────────────────────────────────────

  createAmountAction(type, name, value = 0) {
    const item = this._factory.amountAction(type, name, value);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createRecordMetricAction(type, name, fieldName, value) {
    const item = this._factory.recordMetricAction(type, name, fieldName, value);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createRecordArrayMetricAction(name, fieldName, value) {
    const item = this._factory.recordArrayMetricAction(name, fieldName, value);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createRecordNumericSumMetricAction(name, fieldName, value) {
    const item = this._factory.recordNumericSumMetricAction(name, fieldName, value);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createRecordMultiplicativeMetricAction(name, fieldName, value) {
    const item = this._factory.recordMultiplicativeMetricAction(name, fieldName, value);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createRecordBalanceAction() {
    const item = this._factory.recordBalanceAction();
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  /**
   * Apply `changes` to an existing action in-place, then publish an UPDATE event.
   * A shallow clone of the action is captured as `originalItem` before applying changes.
   *
   * @param {import('../simulation-framework/actions.js').Action} action
   * @param {object} changes - Key/value pairs to assign onto the action
   * @returns {import('../simulation-framework/actions.js').Action} the mutated action
   */
  updateAction(action, changes = {}) {
    const originalItem = Object.assign(
      Object.create(Object.getPrototypeOf(action)),
      action
    );
    Object.assign(action, changes);
    this._publish('UPDATE', action.constructor.name, action, originalItem);
    return action;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  /**
   * Publish a DELETE event for the given action.
   * The caller is responsible for removing the action from handlers/reducers.
   *
   * @param {import('../simulation-framework/actions.js').Action} action
   * @returns {import('../simulation-framework/actions.js').Action} the deleted action
   */
  deleteAction(action) {
    this._publish('DELETE', action.constructor.name, action, action);
    return action;
  }
}
