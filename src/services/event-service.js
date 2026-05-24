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
 * Each mutating method publishes a ServiceActionEvent to the shared EventBus.
 */
export class EventService extends BaseService {

  // ─── Create ───────────────────────────────────────────────────────────────

  /**
   * @param {object} params - EventSeries constructor params
   * @returns {EventSeries}
   */
  createEventSeries(params) {
    const item = new EventSeries(params);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  /**
   * @param {object} params - OneOffEvent constructor params
   * @returns {OneOffEvent}
   */
  createOneOffEvent(params) {
    const item = new OneOffEvent(params);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  /**
   * Apply `changes` to an existing event in-place, then publish an UPDATE event.
   *
   * @param {import('../simulation-framework/events/base-event.js').BaseEvent} event
   * @param {object} changes
   * @returns {import('../simulation-framework/events/base-event.js').BaseEvent}
   */
  updateEvent(event, changes = {}) {
    const originalItem = Object.assign(
      Object.create(Object.getPrototypeOf(event)),
      event
    );
    Object.assign(event, changes);
    this._publish('UPDATE', event.constructor.name, event, originalItem);
    return event;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  /**
   * Publish a DELETE event for the given event config.
   * The caller is responsible for unscheduling it from the simulation.
   *
   * @param {import('../simulation-framework/events/base-event.js').BaseEvent} event
   * @returns {import('../simulation-framework/events/base-event.js').BaseEvent}
   */
  deleteEvent(event) {
    this._publish('DELETE', event.constructor.name, event, event);
    return event;
  }
}
