/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  ServiceActionEvent,
  ServiceBulkActionEvent
} from '../simulation-framework/bus-messages.js';
import {createEdgeId, Edge, EDGE_TYPES} from "../graph/edge.js";
import {GraphQueryApi} from "../graph/graph-query-api.js";

/**
 * Base class for all configuration-item services.
 *
 * Each service shares its data with the global graph instance.  Callers retrieve items via get(id) /
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
   *
   * @param {import('../graph/graph.js')} graph
   * @param {import('../simulation-framework/event-bus.js').EventBus} bus
   * @param {string} kind  - kind of node [event, handler, action, reducer]
   */
  constructor(graph, query, bus, kind, prefixLength = 1, hasEdges = true) {
    this.bus = bus;
    this._graph = graph;
    this._query = query;
    this._kind = kind;
    this._layer = 'config';
    this._nextId   = 1;
    this._idPrefix = this._kind.substring(0, prefixLength);
    this.hasEdges = hasEdges;
  }

  // ─── Public query API ─────────────────────────────────────────────────────

  /**
   * Retrieve an item by ID, or null if not found.
   * @param {string} id
   * @returns {*|null}
   */
  get(id) {
    return this._graph.getNode(id) ?? null;
  }


  /**
   * Return all items managed by this service.
   * @returns {Array}
   */
  getAll() {
    return [...this._graph.getNodes().filter((n) => this._serviceFilter(n))];
  }

  // ─── Public Modification API ──────────────────────────────────────────────

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
    this._graph.addNode(item);
    this._wireNodeEdges(item);
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
    this._graph.addNode(item);
    this._advanceCounter(item.id);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
    return item;
  }

  /**
   * Copy high level properties and dive into meta and data
   * @param item
   * @param changes
   * @return {*}
   */
  mergeChanges(item, changes) {
    const { data, meta, ...rest } = changes;
    Object.assign(item, rest);

    // Controlled nested merges
    if (data) {
      item.data = {
        ...item.data,
        ...data
      };
    }

    if (meta) {
      item.meta = {
        ...item.meta,
        ...meta
      };
    }
    return item;
  }

  /**
   * Merge this data into our data and replace all nodes
   * @param data
   */
  updateAllData(data) {
    this.updateAllMetaData({}, data);
  }

  /**
   * Merge this meta into our meta and replace all nodes
   * @param data
   */
  updateAllMeta(meta) {
    this.updateAllMetaData(meta, {});
  }

  updateAllMetaData(meta, data) {
    //Array of {originalItem: x, item: y} for bulk message
    const updated = [];
    const changes = {
      data: data ?? {},
      meta: meta ?? {}
    };
    this.getAll().forEach(item => {
      const originalItem = Object.assign(Object.create(Object.getPrototypeOf(item)), item);
      this.mergeChanges(item, changes);
      updated.push({
        originalItem: originalItem,
        item: item
      })
    });

    this._publishBulkMessage('UPDATE', updated);
  }

  nextId() {
    return this._generateId(this._idPrefix);
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
    this._graph.addNode(item);
    this._advanceCounter(item.id);
  }

  /**
   * Remove an item from the internal map by ID.
   * @param {string} id
   */
  _unregister(id) {
    this._graph.removeNode(id);
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
    const item = this._graph.getNode(id);
    if (!item) throw new Error(`${this.constructor.name}: item not found: ${id}`);
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
   * @param {*} item            - item returned from the service call
   * @param {*} [originalItem]  - item snapshot before any mutation
   */
  _publish(actionType, item, originalItem = null) {
    this.bus.publish(new ServiceActionEvent({ actionType, item, originalItem }));
  }

  _publishBulkMessage(actionType, changes) {
    this.bus.publish(new ServiceBulkActionEvent({ actionType, changes }));
  }

  /**
   * Filter out nodes for my service
   * @param node
   * @return {boolean}
   * @private
   */
  _serviceFilter(node) {
    return node.kind === this._kind && node.layer === this._layer;
  }

  _wireNodeEdges(item) {
    if(this.hasEdges) {
      throw new Error('Implement wire edges for nodes with edges');
    }
  }

  _addEdge(from, to, type) {
    this._graph.addEdge(new Edge({from, to, type}));
  }

  _rewireEdges(item) {
    if(this.hasEdges) {
      this._removeEdgesForNode(item.id);
      this._wireNodeEdges(item);
    }
  }

  _removeEdgesForNode(nodeId) {
    this._graph.removeEdges({ from: nodeId });
    this._graph.removeEdges({ to: nodeId });
  }

  _removeEdge(from, to, type) {
    this._graph.removeEdge(createEdgeId(from, to, type));
  }

}
