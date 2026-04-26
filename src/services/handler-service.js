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
 * Each mutating method publishes a ServiceActionEvent to the shared EventBus.
 * Wiring the handler into a simulation's HandlerRegistry is the caller's
 * responsibility.
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
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  /**
   * Apply `changes` to an existing handler in-place, then publish an UPDATE event.
   *
   * @param {HandlerEntry} handler
   * @param {object}       changes
   * @returns {HandlerEntry}
   */
  updateHandler(handler, changes = {}) {
    const originalItem = Object.assign(
      Object.create(Object.getPrototypeOf(handler)),
      handler
    );
    Object.assign(handler, changes);
    this._publish('UPDATE', handler.constructor.name, handler, originalItem);
    return handler;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  /**
   * Publish a DELETE event for the given handler.
   * The caller is responsible for unregistering it from the HandlerRegistry.
   *
   * @param {HandlerEntry} handler
   * @returns {HandlerEntry}
   */
  deleteHandler(handler) {
    this._publish('DELETE', handler.constructor.name, handler, handler);
    return handler;
  }
}
