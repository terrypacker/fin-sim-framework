/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  SimulationAdapter
} from "../simulation-framework/simulation/simulation-adapter.js";

/**
 * Bridges the service layer (configuration) and the Simulation (execution).
 *
 * SimulationSync subscribes to SERVICE_ACTION events on the shared bus and
 * keeps the active Simulation in sync with the service maps:
 *
 *   CREATE  — schedules / registers / wires the new item into the sim.
 *   UPDATE  — unregisters the old wiring, re-wires with the new values.
 *   DELETE  — removes the item from the sim, cleans up cross-references.
 *
 * One instance lives in ServiceRegistry and is replaced on every
 * ServiceRegistry.reset().  Callers do not need to manage its lifecycle.
 *
 * simStart must be set by calling setSimStart(date) once the Simulation is
 * created (i.e., from BaseScenario.buildSim()).
 */
export class SimulationSync {
  constructor({ bus, simulationRegistry }) {
    this.simulationRegistry = simulationRegistry;

    this.adapter = new SimulationAdapter({
      sim: null,
      simStart: null
    });

    bus.subscribe('SERVICE_ACTION', msg => {
      this._handle(msg);
    });

    // Design/17 §3.8: clear per-run state so a fresh Simulation after
    // ServiceRegistry.reset() gets all recurring-event handlers re-registered.
    bus.subscribe('execution:reset', () => {
      this.adapter.reset();
    });
  }

  setSimStart(simStart) {
    this.adapter.setSimStart(simStart);
  }

  _getSim() {
    return this.simulationRegistry.getPrimary();
  }

  _handle(msg) {
    const sim = this._getSim();
    if (!sim) return;

    this.adapter.setSim(sim);

    const { actionType, item } = msg;

    if (actionType === 'CREATE') {
      this.adapter.onCreate(item);
    } else if (actionType === 'UPDATE') {
      this.adapter.onUpdate(item);
    } else if (actionType === 'DELETE') {
      this.adapter.onDelete(item);
    }
  }

}
