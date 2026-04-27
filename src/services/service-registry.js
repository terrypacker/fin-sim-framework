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
import { SimulationRegistry } from './simulation-registry.js';
import { SimulationSync } from './simulation-sync.js';

/**
 * Central singleton registry for all application services, the shared
 * EventBus, and the SimulationRegistry.
 *
 * Usage:
 *   const { eventService, simulationRegistry } = ServiceRegistry.getInstance();
 *
 * Call ServiceRegistry.reset() before rebuilding a scenario to get a fresh
 * instance with a clean bus, empty service maps, and an empty SimulationRegistry.
 * This is also called automatically by BaseApp.buildScenario().
 */
export class ServiceRegistry {
  /** @type {ServiceRegistry|null} */
  static _instance = null;

  constructor() {
    this.bus                = new EventBus();
    this.actionService      = new ActionService(this.bus);
    this.eventService       = new EventService(this.bus);
    this.handlerService     = new HandlerService(this.bus);
    this.reducerService     = new ReducerService(this.bus);
    this.simulationRegistry = new SimulationRegistry();
    // SimulationSync receives `this` so it can reach the bus, simulationRegistry,
    // and sibling services without a ServiceRegistry import (avoids circular deps).
    this.simulationSync     = new SimulationSync(this);
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
   * Destroy the current singleton and create a fresh one.
   * All service item maps, the bus, and the SimulationRegistry are cleared.
   * Intended to be called at the start of every scenario rebuild.
   */
  static reset() {
    ServiceRegistry._instance = null;
  }
}
