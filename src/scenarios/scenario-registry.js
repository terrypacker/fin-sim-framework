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
 * Storage to track and manage our Scenarios, including the current active one
 */
export class ScenarioRegistry {
  constructor(scenarioStorage) {
    this._scenarioStorage = scenarioStorage;
    this._scenarios = new Map();

    /**
     * Loaded data for our scenarios configuation
     * - scenarios[] list of all user defined scenarios
     * - last...
     * - ...
     * @type {object}
     * @private
     */
    this._scenarioData = {};

    this._init();
  }

  /**
   * Load scenarios in from ScenarioStorage
   */
  _init() {
    this._scenarioData = this._scenarioStorage.load();
    this._scenarioData.scenarios.forEach(s => {
      this._scenarios.set(s.id, s);
    });
  }

  /**
   * Load in prebuilt scenarios, replacing existing
   * @param prebuiltScenarios
   */
  loadPrebuilt(prebuiltScenarios = []) {
    prebuiltScenarios.forEach(pb => {
      this._scenarios.set(pb.id, pb);
    })
  }

  /**
   * Get all scenarios ordered by priority (ascending)
   * Sort scenarios by order (ascending) so index 0 is the default.
   * @return {any[]}
   */
  getAll() {
    return [...this._scenarios.values()].sort((a, b) => a.order - b.order);
  }

  /**
   * Instantiate the correct scenario class for the current selection.
   * @returns {BaseScenario}
   */
  get(id) {
    return this._scenarios.get(id);
  }

  /**
   *
   * @param scenario
   * @param active - is the the new active scenario
   */
  save(scenario, active) {
    if(active) {
      //Make sure we are the only active scenario in storage
      this._scenarios.entries().forEach(e => e.active = false);
      scenario.active = true;
    }else {
      scenario.active = false;
    }
    this._scenarios.set(scenario.id, scenario);
    this._persistUserScenarios();
    this._persistLastUsed(scenario.id);
  }

  delete(id) {
    let deletingActive = null;
    const active = this.getActive();
    this._scenarios.delete(id);

    if(active.id == id) {

    }
    const newActive = this.getAll()[0];
    newActive.active = true;
    this.save(newActive, true);
    this._persistUserScenarios();
    this._persistLastUsed(newActive.id);
    return this.getActive();
  }

  /**
   * Get the one active scenario in the application
   */
  getActive() {
    return this.getAll().find(s => s.active);
  }

  getPrebuiltScenarios() {
    // Sort pre-built scenarios by order (ascending) so index 0 is the default.
    return [...this._scenarios.values()].filter(s => s.prebuilt === true).sort((a, b) => a.order - b.order);
  }

  getUserScenarios() {
    // Sort scenarios by order (ascending) so index 0 is the default.
    return [...this._scenarios.values()].filter(s => s.prebuilt === false).sort((a, b) => a.order - b.order);
  }

  getNextUserScenarioId() {
    return this.getUserScenarios().length;
  }

  replaceUserScenarios(data) {
    if (Array.isArray(data.scenarios)) {
      for (const s of data.scenarios) {
        this._scenarios.set(s.id, s);
      }
    }
    this._persistUserScenarios();
  }

  deleteActiveScenario() {
    if (!this._activeValue?.startsWith('u:')) return;
    this._scenarios.delete(this._activeValue);

    // After deletion, fall back to first prebuilt, then first user scenario, then empty.
    const prebuilt = this.getPrebuiltScenarios();
    const user = this.getUserScenarios();
    if (prebuilt.length > 0) {
      this._activeValue = prebuilt.id;
    } else if (user.length > 0) {
      this._activeValue = user[0].id;
    } else {
      this._activeValue = '';
    }
    this._persistUserScenarios();
    this._persistLastUsed();
  }

  /** Write the current active value as lastUsed and flush to localStorage. */
  _persistLastUsed(id) {
    this._scenarioData.lastUsed = id;
    this._scenarioStorage.save(this._scenarioData);
  }

  _persistUserScenarios() {
    //Ensure our scenarios are up-to-date
    this._scenarioData.scenarios = this.getUserScenarios();
    this._scenarioStorage.save(this._scenarioData);
  }

}
