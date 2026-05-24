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
 * Provides a shared EventBus reference and the _publish helper used by every
 * CRUD method to emit a ServiceActionEvent.
 */
export class BaseService {
  /**
   * @param {import('../simulation-framework/event-bus.js').EventBus} bus
   */
  constructor(bus) {
    this.bus = bus;
  }

  /**
   * Publish a SERVICE_ACTION event on the shared bus.
   *
   * @param {'CREATE'|'UPDATE'|'DELETE'} actionType
   * @param {string} classType  - constructor name of the managed item
   * @param {*}      item       - item returned from the service call
   * @param {*}      [originalItem] - item as received (null for CREATE)
   */
  _publish(actionType, classType, item, originalItem = null) {
    this.bus.publish(new ServiceActionEvent({ actionType, classType, item, originalItem }));
  }
}
