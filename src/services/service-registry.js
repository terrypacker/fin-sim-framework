/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { EventBus } from '../simulation-framework/event-bus.js';
import { ActionService } from './action-service.js';
import { EventService } from './event-service.js';
import { HandlerService } from './handler-service.js';
import { ReducerService } from './reducer-service.js';

/**
 * Central singleton registry for all application services and the shared
 * EventBus.
 *
 * Usage:
 *   const registry = ServiceRegistry.getInstance();
 *   const action = registry.actionService.createAmountAction('MY_TYPE', 'Salary', 5000);
 *   registry.bus.subscribe('SERVICE_ACTION', e => console.log(e));
 *
 * For tests, call ServiceRegistry.reset() between cases to get a fresh
 * instance with clean bus history and empty service state.
 */
export class ServiceRegistry {
  /** @type {ServiceRegistry|null} */
  static _instance = null;

  constructor() {
    this.bus            = new EventBus();
    this.actionService  = new ActionService(this.bus);
    this.eventService   = new EventService(this.bus);
    this.handlerService = new HandlerService(this.bus);
    this.reducerService = new ReducerService(this.bus);
  }

  /**
   * Return the singleton instance, creating it on first call.
   * @returns {ServiceRegistry}
   */
  static getInstance() {
    if (!ServiceRegistry._instance) {
      ServiceRegistry._instance = new ServiceRegistry();
    }
    return ServiceRegistry._instance;
  }

  /**
   * Destroy the current singleton instance.
   * Intended for test isolation — call before each test that needs a clean state.
   */
  static reset() {
    ServiceRegistry._instance = null;
  }
}
