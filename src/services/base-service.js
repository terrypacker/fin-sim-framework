/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ServiceActionEvent } from '../simulation-framework/bus-messages.js';

/**
 * Base class for all configuration-item services.
 *
 * Each service owns an internal Map<id, item> that is the single source of
 * truth for the items it manages.  Callers retrieve items via get(id) /
 * getAll() and mutate them only through the service's update* methods, which
 * snapshot the item before applying changes and publish a ServiceActionEvent
 * to the shared bus.
 *
 * ID generation lives here so BaseScenario no longer needs _nextXxxId counters.
 * The counter auto-advances when load() is called with a pre-assigned numeric
 * ID, preventing collisions between programmatic IDs and service-generated ones.
 */
export class BaseService {
  /**
   * @param {import('../simulation-framework/event-bus.js').EventBus} bus
   * @param {string} idPrefix  - Prefix used when auto-generating IDs (e.g. 'e', 'h', 'r', 'a')
   */
  constructor(bus, idPrefix = 'item') {
    this.bus = bus;
    /** @type {Map<string, *>} */
    this._items = new Map();
    this._nextId   = 1;
    this._idPrefix = idPrefix;
  }

  // ─── Public query API ─────────────────────────────────────────────────────

  /**
   * Retrieve an item by ID, or null if not found.
   * @param {string} id
   * @returns {*|null}
   */
  get(id) {
    return this._items.get(id) ?? null;
  }

  /**
   * Return all items managed by this service.
   * @returns {Array}
   */
  getAll() {
    return [...this._items.values()];
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Generate a unique string ID with the given prefix (e.g. 'e', 'h', 'r').
   * @param {string} prefix
   * @returns {string}
   */
  _generateId(prefix = 'item') {
    return prefix + this._nextId++;
  }

  /**
   * Store an item in the internal map using item.id as the key.
   * Automatically advances the ID counter when the item's id has the pattern
   * <letters><digits> so programmatic loading never collides with generated IDs.
   * @param {*} item - must have an `id` property
   */
  _register(item) {
    this._items.set(item.id, item);
    this._advanceCounter(item.id);
  }

  /**
   * Remove an item from the internal map by ID.
   * @param {string} id
   */
  _unregister(id) {
    this._items.delete(id);
  }

  /**
   * Resolve an item from the map.  Accepts either the item's string ID or the
   * item object itself (which must have an `id` property).
   * Throws if the item is not found.
   * @param {string|object} idOrItem
   * @returns {*}
   */
  _resolve(idOrItem) {
    const id = typeof idOrItem === 'string' ? idOrItem : idOrItem?.id;
    const item = this._items.get(id);
    if (!item) throw new Error(`${this.constructor.name}: item not found: ${id}`);
    return item;
  }

  /**
   * Register an existing item in the map without publishing a bus event.
   * Used when items are created outside the service (builders, deserialization,
   * programmatic setup) but still need to be findable via get(id) for
   * subsequent update calls.
   *
   * If the item has no id (null / undefined) one is generated using the
   * service's `_idPrefix` so that BaseScenario no longer needs its own
   * `_nextXxxId` counters.
   *
   * Advances the ID counter so future _generateId() calls don't collide.
   *
   * @param {*} item - must have an `id` property (may be null before this call)
   * @returns {*} the item
   */
  load(item) {
    if (item.id == null) item.id = this._generateId(this._idPrefix);
    this._items.set(item.id, item);
    this._advanceCounter(item.id);
    return item;
  }

  /**
   * Register an existing item in the map AND publish a CREATE event on the bus.
   *
   * This is the primary entry point for programmatic item setup (CustomScenario,
   * ScenarioSerializer) and replaces the old pattern of calling BaseScenario
   * helper methods (scheduleEvent, registerHandler, etc.).
   *
   * Subscribers — BaseScenario (sim wiring) and ConfigBuilder (graph node) —
   * react to the CREATE event, so the caller does not need to wire anything
   * manually.
   *
   * If the item has no id one is generated.  Advances the ID counter exactly
   * as load() does, so saved IDs are preserved and future generated IDs never
   * collide.
   *
   * @param {*} item - must have an `id` property (may be null before this call)
   * @returns {*} the item
   */
  register(item) {
    if (item.id == null) item.id = this._generateId(this._idPrefix);
    this._items.set(item.id, item);
    this._advanceCounter(item.id);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  /**
   * Advance _nextId if the given id has a trailing numeric suffix higher than
   * the current counter.
   * @param {string} id
   */
  _advanceCounter(id) {
    const m = id?.match(/^[a-z]+(\d+)$/i);
    if (m) {
      const n = parseInt(m[1], 10) + 1;
      if (n > this._nextId) this._nextId = n;
    }
  }

  /**
   * Publish a SERVICE_ACTION event on the shared bus.
   *
   * @param {'CREATE'|'UPDATE'|'DELETE'} actionType
   * @param {string} classType  - constructor name of the managed item
   * @param {*}      item       - item returned from the service call
   * @param {*}      [originalItem] - item snapshot before any mutation
   */
  _publish(actionType, classType, item, originalItem = null) {
    this.bus.publish(new ServiceActionEvent({ actionType, classType, item, originalItem }));
  }
}
