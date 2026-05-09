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

  /**
   * Create a new scenario from this scenario, it will be a user scenario and the new active
   *  scenario
   * @param fromScenario
   * @return {*|null}
   */
  newScenario(fromScenario) {
    return this._service.newScenario(fromScenario);
  }

  /**
   * Delete this scenario
   * @param scenario
   * @return the active scenario, in case we deleted it
   */
  delete(scenario) {
    this._service.delete(scenario.id);
    return this._service.getActive();
  }

  /**
   * Save the scenario, it is now the active one
   * @param scenario
   */
  save(scenario) {
    this._service.save(scenario, true);
  }

  getAll() {
    return this._service.getAll();
  }

  getUserScenarios() {
    return this._service.getUserScenarios();
  }

  replaceUserScenarios(data) {
    this._service.replaceUserScenarios(data);
    this._service.getActive();
  }

}
