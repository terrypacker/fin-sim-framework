/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CustomScenario — demonstrates the service-as-entry-point pattern.
 *
 * Items are created and inserted directly into the services.  Publishing a
 * CREATE event on the shared bus is handled automatically by service.register()
 * and service.create*().  Two bus subscribers react to each CREATE:
 *
 *   SimulationSync  → wires the item into the active Simulation
 *   EventScheduler  → adds the node to the configuration graph
 *
 * loadDefaults() does NOT call any BaseScenario helpers (scheduleEvent,
 * registerHandler, etc.) — those have been removed.  All you need is the
 * ServiceRegistry and the domain objects.
 */
export class CustomScenario extends FinSimLib.Scenarios.BaseScenario {
  constructor({ eventSchedulerUI } = {}) {
    super({ eventSchedulerUI });
  }

  /**
   * Build the bare Simulation instance.
   * Events, handlers, and reducers are NOT registered here — call loadDefaults()
   * or let BaseApp call ScenarioSerializer.deserialize() when loading from a
   * saved config.
   */
  buildSim(params, initialState) {
    super.buildSim(params, initialState);
  }

  /**
   * Populate the scenario with its default event series, handlers, and reducers.
   * Called by BaseApp.afterBuildSim() when there is no saved config to load.
   *
   * Pattern:
   *   1. Build the domain object (EventSeries, HandlerEntry, reducer, action).
   *   2. Set any cross-references (handledEvents, generatedActions, reducedActions).
   *   3. Call service.register(item) — this publishes CREATE on the bus,
   *      which SimulationSync and EventScheduler handle automatically.
   */
  loadDefaults() {
    const { EventBuilder, ActionBuilder, HandlerBuilder, ReducerBuilder } = FinSimLib.Core;
    const { eventService, actionService, handlerService, reducerService } =
      FinSimLib.Services.ServiceRegistry.getInstance();

    // ── Events ────────────────────────────────────────────────────────────────
    // Build the event, then register it.  SimulationSync schedules it in the
    // sim; EventScheduler adds the graph node.
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

    const sumSalaryPaymentAction = ActionBuilder.recordNumericSum()
      .name('Sum Payments')
      .fieldName('amount')
      .build();
    actionService.register(sumSalaryPaymentAction);

    // ── Handlers ──────────────────────────────────────────────────────────────
    // Build the handler with its connections populated before calling register()
    // so that SimulationSync wires it fully into the sim on the first CREATE.
    const monthEndHandler = HandlerBuilder
      .handler(function({ data, date, state }) { return [...this.generatedActions]; })
      .name('Month End Handler')
      .forEvent(monthEndEventSeries)
      .generateAction(recordSalaryPaymentAction)
      .build();
    handlerService.register(monthEndHandler);

    // ── Reducers ──────────────────────────────────────────────────────────────
    const recordSalaryPaymentReducer = ReducerBuilder
      .metric('amount')
      .name('Process Salary Payment Amount')
      .reduceAction(recordSalaryPaymentAction)
      .generateAction(sumSalaryPaymentAction)
      .build();
    reducerService.register(recordSalaryPaymentReducer);

    const sumSalaryPaymentReducer = ReducerBuilder
      .numericSum('salary')
      .name('Update Total Salary')
      .reduceAction(sumSalaryPaymentAction)
      .build();
    reducerService.register(sumSalaryPaymentReducer);

    const depositReducer = ReducerBuilder
      .arrayMetric('deposits')
      .name('Deposit Payment')
      .reduceAction(recordSalaryPaymentAction)
      .build();
    reducerService.register(depositReducer);
  }
}
