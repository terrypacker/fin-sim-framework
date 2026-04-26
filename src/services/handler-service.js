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
import { HandlerEntry } from '../simulation-framework/handlers.js';

/**
 * Service for managing HandlerEntry instances throughout their lifecycle.
 *
 * Owns an internal Map<id, item> as the source of truth.  Wiring handlers
 * into a simulation's HandlerRegistry is the caller's responsibility.
 */
export class HandlerService extends BaseService {

  // ─── Create ───────────────────────────────────────────────────────────────

  /**
   * Create a new HandlerEntry and publish a CREATE event.
   *
   * @param {Function|null} fn   - Handler function receiving ({data, date, state, sim})
   * @param {string}        name - Display name for the handler
   * @returns {HandlerEntry}
   */
  createHandler(fn = null, name = 'New Handler') {
    const item = new HandlerEntry(fn, name);
    item.id = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  /**
   * Apply `changes` to an existing handler and publish an UPDATE event.
   *
   * Accepts either the item's string ID or the handler object.  The item is
   * resolved from the internal map so the originalItem snapshot is taken
   * before the mutation is applied.
   *
   * @param {string|HandlerEntry} idOrHandler
   * @param {object} changes
   * @returns {HandlerEntry}
   */
  updateHandler(idOrHandler, changes = {}) {
    const handler = this._resolve(idOrHandler);
    const originalItem = Object.assign(Object.create(Object.getPrototypeOf(handler)), handler);
    Object.assign(handler, changes);
    this._publish('UPDATE', handler.constructor.name, handler, originalItem);
    return handler;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  /**
   * Remove the handler from the service map and publish a DELETE event.
   * The caller is responsible for unregistering it from the HandlerRegistry.
   *
   * @param {string|HandlerEntry} idOrHandler
   * @returns {HandlerEntry}
   */
  deleteHandler(idOrHandler) {
    const handler = this._resolve(idOrHandler);
    this._unregister(handler.id);
    this._publish('DELETE', handler.constructor.name, handler, handler);
    return handler;
  }
}
