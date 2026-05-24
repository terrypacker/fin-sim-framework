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
  AmountAction,
  Action,
  FieldAction,
  FieldValueAction,
  RecordBalanceAction,
  ScriptedAction,
  ACTION_CLASSES,
} from "../simulation-framework/actions.js";

/**
 * Service for managing Action instances throughout their lifecycle.
 *
 * Action.id is a service-generated unique identifier (e.g. 'a1', 'a2').
 * Action.type is the category discriminator used by the ReducerPipeline for
 * reducer lookup — it is set by the caller and is independent of id.
 *
 * Owns an internal Map<id, item> as the source of truth.
 */
export class ActionService extends BaseService {
  constructor(bus) {
    super(bus, 'a');
  }

  // ─── Create ───────────────────────────────────────────────────────────────

  createAmountAction(type, name, value = 0) {
    const item = new AmountAction(type, name, value);
    item.id = this._generateId(this._idPrefix);
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createAction(type, name) {
    const item = new Action(type, name);
    item.id = this._generateId(this._idPrefix);
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createFieldAction(type, name, field) {
    const item = new FieldAction(type, name, field);
    item.id = this._generateId(this._idPrefix);
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createFieldValueAction(type, name, field, value) {
    const item = new FieldValueAction(type, name, field, value);
    item.id = this._generateId(this._idPrefix);
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createRecordBalanceAction() {
    const item = new RecordBalanceAction();
    item.id = this._generateId(this._idPrefix);
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  createScriptedAction(type, name, fieldName = '', script = '// return computed value\nreturn 0;') {
    const item = new ScriptedAction(type, name, fieldName, script);
    item.id = this._generateId(this._idPrefix);
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

  /**
   * Replace an existing action with a new instance of the given class,
   * preserving id, name, type, fieldName, and value.
   *
   * Action subclasses have incompatible constructor signatures, so we bypass
   * the constructor via Object.create and restore all relevant properties
   * explicitly. This keeps constructor.name, getDescription(), and any
   * class-specific behaviour in sync with the stored actionClass string.
   *
   * @param {string|Action} idOrAction
   * @param {string}        newClass   - key in ACTION_CLASSES
   * @param {object}        [extraProps]
   * @returns {Action}
   */
  replaceAction(idOrAction, newClass, extraProps = {}) {
    const old = this._resolve(idOrAction);
    const Cls = ACTION_CLASSES[newClass];
    if (!Cls) throw new Error(`ActionService: unknown action class "${newClass}"`);

    const fresh = Object.create(Cls.prototype);
    fresh.id        = old.id;
    fresh.name      = old.name;
    fresh.type      = old.type;
    fresh.fieldName = old.fieldName;
    fresh.value     = old.value;
    Object.assign(fresh, extraProps);

    this._items.set(fresh.id, fresh);
    this._publish('UPDATE', newClass, fresh, old);
    return fresh;
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
