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
import { EventSeries } from '../simulation-framework/events/event-series.js';
import { OneOffEvent } from '../simulation-framework/events/one-off-event.js';

/**
 * Service for managing simulation event configuration items (EventSeries and
 * OneOffEvent) throughout their lifecycle.
 *
 * Owns an internal Map<id, item> as the source of truth.  Each mutating method
 * resolves the item from the map before applying changes so that the
 * originalItem snapshot is always taken before mutation.
 */
export class EventService extends BaseService {
  constructor(bus) { super(bus, 'e'); }

  // ─── Create ───────────────────────────────────────────────────────────────

  /**
   * @param {object} params - EventSeries constructor params
   * @returns {EventSeries}
   */
  createEventSeries(params) {
    if (!params.id) params = { ...params, id: this._generateId('e') };
    const item = new EventSeries(params);
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  /**
   * @param {object} params - OneOffEvent constructor params
   * @returns {OneOffEvent}
   */
  createOneOffEvent(params) {
    if (!params.id) params = { ...params, id: this._generateId('e') };
    const item = new OneOffEvent(params);
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  /**
   * Apply `changes` to an existing event and publish an UPDATE event.
   *
   * Accepts either the item's string ID or the item object itself.  The item
   * is resolved from the internal map so the originalItem snapshot is taken
   * before the mutation is applied.
   *
   * @param {string|import('../simulation-framework/events/base-event.js').BaseEvent} idOrEvent
   * @param {object} changes
   * @returns {import('../simulation-framework/events/base-event.js').BaseEvent}
   */
  updateEvent(idOrEvent, changes = {}) {
    const event = this._resolve(idOrEvent);
    const originalItem = Object.assign(Object.create(Object.getPrototypeOf(event)), event);
    Object.assign(event, changes);
    this._publish('UPDATE', event.constructor.name, event, originalItem);
    return event;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  /**
   * Remove the event from the service map and publish a DELETE event.
   * The caller is responsible for unscheduling it from the simulation.
   *
   * @param {string|import('../simulation-framework/events/base-event.js').BaseEvent} idOrEvent
   * @returns {import('../simulation-framework/events/base-event.js').BaseEvent}
   */
  deleteEvent(idOrEvent) {
    const event = this._resolve(idOrEvent);
    this._unregister(event.id);
    this._publish('DELETE', event.constructor.name, event, event);
    return event;
  }
}
