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
 * Actions use their `type` string as their stable identity (id = type) so that
 * the same action object is shared between handlers and reducers that reference
 * the same event type.
 *
 * Owns an internal Map<id, item> as the source of truth.
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
    item.id = type;
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createRecordMetricAction(type, name, fieldName, value) {
    const item = this._factory.recordMetricAction(type, name, fieldName, value);
    item.id = type;
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createRecordArrayMetricAction(name, fieldName, value) {
    const item = this._factory.recordArrayMetricAction(name, fieldName, value);
    item.id = item.type;
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createRecordNumericSumMetricAction(name, fieldName, value) {
    const item = this._factory.recordNumericSumMetricAction(name, fieldName, value);
    item.id = item.type;
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createRecordMultiplicativeMetricAction(name, fieldName, value) {
    const item = this._factory.recordMultiplicativeMetricAction(name, fieldName, value);
    item.id = item.type;
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createRecordBalanceAction() {
    const item = this._factory.recordBalanceAction();
    item.id = item.type;
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  /**
   * Apply `changes` to an existing action and publish an UPDATE event.
   *
   * Accepts either the item's ID (= its type string) or the action object.
   * The item is resolved from the internal map so the originalItem snapshot is
   * taken before the mutation is applied.
   *
   * @param {string|import('../simulation-framework/actions.js').Action} idOrAction
   * @param {object} changes
   * @returns {import('../simulation-framework/actions.js').Action}
   */
  updateAction(idOrAction, changes = {}) {
    const action = this._resolve(idOrAction);
    const originalItem = Object.assign(Object.create(Object.getPrototypeOf(action)), action);
    Object.assign(action, changes);
    this._publish('UPDATE', action.constructor.name, action, originalItem);
    return action;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  /**
   * Remove the action from the service map and publish a DELETE event.
   * The caller is responsible for removing the action from handlers/reducers.
   *
   * @param {string|import('../simulation-framework/actions.js').Action} idOrAction
   * @returns {import('../simulation-framework/actions.js').Action}
   */
  deleteAction(idOrAction) {
    const action = this._resolve(idOrAction);
    this._unregister(action.id);
    this._publish('DELETE', action.constructor.name, action, action);
    return action;
  }
}
