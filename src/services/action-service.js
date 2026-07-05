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
import {HandlerEntry} from "../simulation-framework/handlers.js";
import {Reducer} from "../simulation-framework/reducers.js";

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
  constructor(graph, query, bus) {
    super(graph, query, bus, 'action', 1, false);

    bus.subscribe('SERVICE_ACTION', { subtype: 'CREATE', instanceOf: HandlerEntry }, ({ item }) => {
      this._ensureActionTypes(item.generatedActionTypes);
    });
    bus.subscribe('SERVICE_ACTION', { subtype: 'CREATE', instanceOf: Reducer }, ({ item }) => {
      this._ensureActionTypes(item.generatedActionTypes);
      this._ensureActionTypes(item.reducedActionTypes);
    });
  }

  // ─── Query API ───────────────────────────────────────────────────────────────

  /**
   * Get Actions by Type
   * @param type
   * @return {*}
   */
  getByType(type) {
    return this._query.getOneByKind('action', 'type', type);
  }

  // ─── Create ───────────────────────────────────────────────────────────────

  createAmountAction(type, name, value = 0) {
    const item = new AmountAction(type, name, value);
    item.id = this._generateId(this._idPrefix);
    this._register(item);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
    return item;
  }

  createAction(type, name) {
    const item = new Action(type, name);
    item.id = this._generateId(this._idPrefix);
    this._register(item);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
    return item;
  }

  createFieldAction(type, name, field) {
    const item = new FieldAction(type, name, field);
    item.id = this._generateId(this._idPrefix);
    this._register(item);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
    return item;
  }

  createFieldValueAction(type, name, field, value) {
    const item = new FieldValueAction(type, name, field, value);
    item.id = this._generateId(this._idPrefix);
    this._register(item);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
    return item;
  }

  createRecordBalanceAction() {
    const item = new RecordBalanceAction();
    item.id = this._generateId(this._idPrefix);
    this._register(item);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
    return item;
  }

  createScriptedAction(type, name, fieldName = '', script = '// return computed value\nreturn 0;') {
    const item = new ScriptedAction(type, name, fieldName, script);
    item.id = this._generateId(this._idPrefix);
    this._register(item);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
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
    this.mergeChanges(action, changes);
    this._publish('UPDATE', action, originalItem);
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

    const fresh = new Cls(old.type, old.name);
    fresh.id        = old.id;
    fresh.name      = old.name;
    fresh.type      = old.type;
    fresh.fieldName = old.fieldName;
    fresh.value     = old.value;
    Object.assign(fresh, extraProps);

    this._graph.updateNode(fresh.id, fresh);
    this._publish('UPDATE', fresh, old);
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
    this._publish('DELETE', action, action);
    return action;
  }

  /**
   * Ensure each action type string has at least one stub Action registered in
   * ActionService. Skips types that already have a registered action, so this
   * is safe to call for every handler/reducer CREATE without producing duplicates.
   *
   * Stubs allow the config graph to show action nodes for finance-domain
   * handlers/reducers that emit plain objects rather than service-registered
   * Action instances.
   *
   * @param {string[]} types
   * @private
   */
  _ensureActionTypes(types) {
    if (!types || types.length === 0) return;
    for (const type of types) this.ensureActionForType(type);
  }

  /**
   * Ensure a graph action node exists for `type`, creating a base Action node if
   * none is present. Returns the existing or newly-created node.
   *
   * Mirrors the auto-creation that runs when a handler/reducer is first created
   * (the CREATE subscriptions above), so action types added later — e.g. via the
   * ActionDefinition editor on an existing handler — also get a node. Without
   * this such types are invisible in the graph and can't be selected as reducer
   * inputs.
   *
   * @param {string} type
   * @returns {Action}
   */
  ensureActionForType(type) {
    return this.getByType(type) ?? this.register(new Action(type, type));
  }

}
