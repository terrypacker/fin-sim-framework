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
 * Registry that holds all active Simulation instances keyed by string ID.
 *
 * In single-simulation apps use 'primary' as the ID. When sim.clone() is used
 * for branching, register each clone here so the service bus can reach all of
 * them.
 *
 * A fresh instance is created by ServiceRegistry on every reset(), so there is
 * no separate singleton lifecycle — access it via
 * ServiceRegistry.getInstance().simulationRegistry.
 */
export class SimulationRegistry {
  constructor() {
    /** @type {Map<string, import('../simulation-framework/simulation.js').Simulation>} */
    this._sims = new Map();
  }

  /**
   * Register a simulation under the given ID.  Use 'primary' for the main sim.
   * @param {string} id
   * @param {*} sim
   */
  register(id, sim) {
    this._sims.set(id, sim);
  }

  /**
   * Retrieve a simulation by ID, or null if not registered.
   * @param {string} id
   * @returns {*|null}
   */
  get(id) {
    return this._sims.get(id) ?? null;
  }

  /**
   * Return all registered simulations.
   * @returns {Array}
   */
  getAll() {
    return [...this._sims.values()];
  }

  /**
   * Remove a simulation from the registry.
   * @param {string} id
   */
  unregister(id) {
    this._sims.delete(id);
  }

  /**
   * Convenience method for single-sim apps: returns the first registered
   * simulation, or null if none are registered.
   * @returns {*|null}
   */
  getPrimary() {
    const [first] = this._sims.values();
    return first ?? null;
  }
}
