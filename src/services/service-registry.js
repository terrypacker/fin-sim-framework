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
import { AccountService } from '../finance/services/account-service.js';
import { PersonService } from '../finance/services/person-service.js';
import { ReducerService } from './reducer-service.js';
import { SimulationRegistry } from './simulation-registry.js';
import { SimulationSync } from './simulation-sync.js';
import {Graph} from "../graph/graph.js";
import {GraphQueryApi} from "../graph/graph-query-api.js";
import {ScenarioService} from "./scenario-service.js";
import {ScenarioStorage} from "../scenarios/scenario-storage.js";
import {ScenarioRegistry} from "../scenarios/scenario-registry.js";
import { StateRegistry } from '../finance/services/state-registry.js';
import { StateSchemaRegistry } from '../finance/services/state-schema-registry.js';
import { RealPropertyService } from '../finance/services/real-property-service.js';
import { CollectibleService } from '../finance/services/collectible-service.js';

/**
 * Central singleton registry for all application services, the shared
 * EventBus, and the SimulationRegistry.
 *
 * Usage:
 *   const { eventService, simulationRegistry } = ServiceRegistry.getInstance();
 *
 * Call ServiceRegistry.reset() at the start of every scenario Rebuild.
 * It keeps the singleton alive and clears only the execution layer + SimulationRegistry,
 * so scenario nodes (layer:'scenario') and config nodes (layer:'config') survive.
 *
 * Call ServiceRegistry.resetAll() in tests that need a completely fresh environment.
 */
export class ServiceRegistry {
  /** @type {ServiceRegistry|null} */
  static _instance = null;

  constructor() {
    this.bus                = new EventBus();
    this.graph              = new Graph();
    this.graphQueryApi      = new GraphQueryApi(this.graph);
    this.accountService         = new AccountService(this.graph, this.graphQueryApi, this.bus);
    this.actionService          = new ActionService(this.graph, this.graphQueryApi, this.bus);
    this.eventService           = new EventService(this.graph, this.graphQueryApi, this.bus);
    this.handlerService         = new HandlerService(this.graph, this.graphQueryApi, this.bus);
    this.personService          = new PersonService(this.graph, this.graphQueryApi, this.bus);
    this.reducerService         = new ReducerService(this.graph, this.graphQueryApi, this.bus);
    this.realPropertyService    = new RealPropertyService(this.graph, this.graphQueryApi, this.bus);
    this.collectibleService     = new CollectibleService(this.graph, this.graphQueryApi, this.bus);

    this.stateRegistry      = new StateRegistry({ accountService: this.accountService });
    this.schemaRegistry     = new StateSchemaRegistry();
    this.scenarioRegistry   = new ScenarioRegistry(new ScenarioStorage(), this.graph);
    this.scenarioService    = new ScenarioService(this.bus, this.scenarioRegistry);
    this.simulationRegistry = new SimulationRegistry();

    this.simulationSync     = new SimulationSync({
      bus: this.bus,
      simulationRegistry: this.simulationRegistry,
      eventService: this.eventService,
      handlerService: this.handlerService,
      actionService: this.actionService,
      reducerService: this.reducerService
    });

    this.simulationContext = {
      simulationRegistry: this.simulationRegistry,
      simulationSync: this.simulationSync,
      eventService: this.eventService,
      handlerService: this.handlerService,
      actionService: this.actionService,
      reducerService: this.reducerService,
      scenarioService: this.scenarioService,
      scenarioRegistry: this.scenarioRegistry,
      bus: this.bus,
      graph: this.graph,
      personService: this.personService,
      accountService: this.accountService,
      realPropertyService: this.realPropertyService,
      collectibleService: this.collectibleService,
      stateRegistry: this.stateRegistry,
      schemaRegistry: this.schemaRegistry,
      services: this,
    };
  }

  /**
   * Instance-level rebuild reset: clear the execution layer + SimulationRegistry
   * on THIS registry. Scenario and config nodes survive. Use this when the
   * caller holds a non-singleton ServiceRegistry (Monte Carlo / optimization
   * isolated registries, branching, parallel sims).
   */
  reset() {
    this.graph.clearLayer('execution');
    this.simulationRegistry.clear();
    this.bus.publish({ type: 'execution:reset' });
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
   * Lightweight Rebuild reset: keep the singleton alive, clear only the
   * execution layer and SimulationRegistry. Scenario and config nodes survive.
   * Callers (WorkbenchApp.destroyScenario) are responsible for clearing
   * layer:'config' when they also need a fresh config graph.
   */
  static reset() {
    ServiceRegistry._instance?.reset();
  }

  /**
   * Full teardown — discards the singleton entirely. Use in tests that need
   * a completely clean environment (fresh graph, bus, and all services).
   */
  static resetAll() {
    ServiceRegistry._instance = null;
  }
}
