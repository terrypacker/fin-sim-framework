/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {BaseScenario} from "./base-scenario.js";
import {ServiceRegistry} from "../services/service-registry.js";
import {EventBuilder} from "../simulation-framework/builders/event-builder.js";
import {
  ActionBuilder
} from "../simulation-framework/builders/action-builder.js";
import {
  HandlerBuilder
} from "../simulation-framework/builders/handler-builder.js";
import {
  ReducerBuilder
} from "../simulation-framework/builders/reducer-builder.js";
import { ActionDefinition } from "../simulation-framework/actions.js";
import {SimulationState} from "../simulation-framework/simulation-state.js";

/**
 * SimulationWorkbenchDefaultScenario — demonstrates the service-as-entry-point pattern.
 *
 * Items are created and inserted directly into the services.  Publishing a
 * CREATE event on the shared bus is handled automatically by service.register()
 * and service.create*().  Two bus subscribers react to each CREATE:
 *
 *   SimulationSync  → wires the item into the active Simulation
 *   ConfigBuilder  → adds the node to the configuration graph
 *
 * loadDefaults() does NOT call any BaseScenario helpers (scheduleEvent,
 * registerHandler, etc.) — those have been removed.  All you need is the
 * ServiceRegistry and the domain objects.
 */
export class SimulationWorkbenchDefaultScenario extends BaseScenario {
  constructor({eventSchedulerUI} = {}) {
    super({eventSchedulerUI});
    this.initialState = new SimulationState();
  }

  /**
   * Populate the scenario with its default event series, handlers, and reducers.
   * Called by BaseApp.afterBuildSim() when there is no saved config to load.
   *
   * Pattern:
   *   1. Build the domain object (EventSeries, HandlerEntry, reducer, action).
   *   2. Set any cross-references (handledEvents, generatedActionTypes/Definitions, reducedActionTypes).
   *   3. Call service.register(item) — this publishes CREATE on the bus,
   *      which SimulationSync and ConfigBuilder handle automatically.
   */
  loadDefaults() {
    const { eventService, actionService, handlerService, reducerService } = ServiceRegistry.getInstance();

    // ── Events ────────────────────────────────────────────────────────────────
    // Build the event, then register it.  SimulationSync schedules it in the
    // sim; ConfigBuilder adds the graph node.

    const monthStartEventSeries = EventBuilder
    .eventSeries()
    .name('Month Start')
    .type('MONTH_START')
    .interval('monthly')
    .enabled(true)
    .color('#0206f5')
    .build();
    eventService.register(monthStartEventSeries);

    const monthEndEventSeries = EventBuilder
    .eventSeries()
    .name('Month End')
    .type('MONTH_END')
    .interval('month-end')
    .enabled(true)
    .color('#F44336')
    .build();
    eventService.register(monthEndEventSeries);

    // ── Actions ───────────────────────────────────────────────────────────────
    const recordSalaryPaymentAction = ActionBuilder.amount()
    .type('RECORD_METRIC')
    .name('Pay Salary')
    .value(1200)
    .build();
    actionService.register(recordSalaryPaymentAction);

    const sumSalaryPaymentAction = ActionBuilder.fieldAction('SUM_SALARY_PAYMENT')
    .name('Sum Payments')
    .fieldName('metrics.amount')
    .build();
    actionService.register(sumSalaryPaymentAction);

    const monthStartAction = ActionBuilder.action('MONTH_START')
    .name('Month started')
    .build();
    actionService.register(monthStartAction);


    //TODO When we fix the classes for Actions we can make this a field metric
    const sumTaxAction = ActionBuilder.fieldValueAction('SUM_TAX')
    .name('Sum Salary Tax')
    .fieldName('metrics.taxAmount')
    .build();
    actionService.register(sumTaxAction);

    // ── Handlers ──────────────────────────────────────────────────────────────
    // Build the handler with its connections populated before calling register()
    // so that SimulationSync wires it fully into the sim on the first CREATE.
    // null fn → uses HandlerEntry.defaultFunction which instantiates from generatedActionDefinitions.
    const monthStartHandler = HandlerBuilder
    .handler(null)
    .name('Month Start Handler')
    .forEvent(monthStartEventSeries)
    .generateActionDef(ActionDefinition.fromAction(monthStartAction))
    .build();
    handlerService.register(monthStartHandler);

    const monthEndHandler = HandlerBuilder
    .handler(null)
    .name('Month End Handler')
    .forEvent(monthEndEventSeries)
    .generateActionDef(ActionDefinition.fromAction(recordSalaryPaymentAction))
    .build();
    handlerService.register(monthEndHandler);

    // ── Reducers ──────────────────────────────────────────────────────────────
    const recordSalaryPaymentReducer = ReducerBuilder
    .field('metrics.amount')
    .name('Process Salary Payment Amount')
    .reduceActionType(recordSalaryPaymentAction.type)
    .generateActionDef(ActionDefinition.fromAction(sumSalaryPaymentAction))
    .build();
    reducerService.register(recordSalaryPaymentReducer);

    const recordSalaryTaxReducer = ReducerBuilder
    .multiplicative('metrics.taxAmount')
    .name('Process Salary Tax')
    .value(0.15)
    .reduceActionType(recordSalaryPaymentAction.type)
    .generateActionDef(ActionDefinition.fromAction(sumTaxAction))
    .build();
    reducerService.register(recordSalaryTaxReducer);

    const sumSalaryPaymentReducer = ReducerBuilder
    .numericSum('metrics.salary')
    .name('Update Total Salary')
    .reduceActionType(sumSalaryPaymentAction.type)
    .build();
    reducerService.register(sumSalaryPaymentReducer);

    const sumSalaryTaxReducer = ReducerBuilder
    .numericSum('metrics.totalTax')
    .name('Update Total Tax')
    .reduceActionType(sumTaxAction.type)
    .build();
    reducerService.register(sumSalaryTaxReducer);

    const depositReducer = ReducerBuilder
    .array('metrics.deposits')
    .name('Deposit Payment')
    .reduceActionType(recordSalaryPaymentAction.type)
    .build();
    reducerService.register(depositReducer);
  }
}
