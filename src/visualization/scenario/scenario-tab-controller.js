/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

export class ScenarioTabController {
  constructor({ scenarioService }) {
    this._service = scenarioService;
  }

  get(id) {
    return this._service.get(id);
  }

  getActiveScenario() {
    return this._service.getActive();
  }

  getAll() {
    return this._service.getAll();
  }

  /**
   * Set the scenario with the given id as active (persists lastUsed via save).
   */
  setActiveById(id) {
    this._service.setActiveById(id);
  }

  /**
   * Create a new user scenario based on fromScenario.
   */
  newScenario(fromScenario) {
    return this._service.newScenario(fromScenario);
  }

  /**
   * Delete this scenario; returns the new active scenario.
   */
  delete(scenario) {
    this._service.delete(scenario.id);
    return this._service.getActive();
  }

  /**
   * Save the scenario, making it the active one.
   */
  save(scenario) {
    this._service.save(scenario, true);
  }

  resetParamsFromSchema(scenario) {
    this._service.resetParamsFromSchema(scenario);
  }

  resetToDefaults(scenario) {
    this._service.resetToDefaults(scenario);
  }

  getUserScenarios() {
    return this._service.getUserScenarios();
  }

  upsertUserScenarios(data) {
    this._service.upsertUserScenarios(data);
    return this._service.getActive();
  }
}
