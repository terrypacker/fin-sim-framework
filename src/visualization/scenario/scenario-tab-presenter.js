/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ScenarioStorage }    from '../../scenarios/scenario-storage.js';
import { ScenarioSerializer } from '../../scenarios/scenario-serializer.js';
import { ServiceRegistry }    from '../../services/service-registry.js';
import {PrebuiltScenario} from "../../scenarios/prebuilt-scenario.js";

/**
 * ScenarioTabPresenter — owns all scenario-tab UI and scenario CRUD.
 *
 * ### Active-value encoding
 *
 * `_activeValue` is a string that identifies which scenario is currently
 * selected in the dropdown:
 *
 *   `'p:<id>'`  — a pre-built scenario (shipped with the app, not in localStorage)
 *   `'u:<N>'`   — a user-saved scenario at index N in `_scenarioData.scenarios`
 *   `''`        — nothing selected (edge case / legacy)
 *
 * ### Pre-built scenario selection and first-load default
 *
 * Pre-built scenarios are supplied via the constructor's `prebuiltScenarios`
 * array and sorted by `PrebuiltScenario.order` (ascending).  On a fresh page
 * load with no localStorage state the lowest-order pre-built is selected
 * automatically, making it the "default first load" scenario.
 *
 * ### Last-used persistence
 *
 * `_activeValue` is written to `_scenarioData.lastUsed` and persisted to
 * localStorage whenever the selection changes or a scenario is saved/deleted.
 * On the next page load the last-used value is restored.
 */
export class ScenarioTabPresenter {
  /**
   * @param {{
   *   controller: import('./scenario-tab-controller.js').ScenarioTabController,
   *   view:       import('./scenario-tab-view.js').ScenarioTabView,
   *   bus:        import('../../simulation-framework/event-bus.js').EventBus
   * }}
   */
  constructor({ controller, view, bus , initScenario}) {
    this._controller = controller;
    this._view = view;
    this._bus = bus;
    this._initScenario = initScenario;
    this._activeScenario = null;

    this._view.onOpen = (id) => {
      this._activeScenario = this._controller.get(id);
      this._controller.setActiveById(id);
      this._controller._persistLastUsed();
      this._view._populateScenarioForm(this._activeScenario);
    };

    this._view.onRebuild = () => {
      this._initScenario();
    };

    this._view.onNew = () => {
      this._activeScenario = this._controller.newScenario();
      this._view._refreshScenarioSelect(this._controller.getAll(), this._activeScenario);
    };

    this._view.onDelete = () => {
      this._activeScenario = this._controller.delete(this._activeScenario);
      this._view._refreshScenarioSelect(this._controller.getAll(), this._activeScenario);
    };

    this._view.onNameChange = (name) => {
      this._activeScenario.name = name;
      this._view.updateSelectOption(name);
    }

    this._view.onStartChange = (startDate) => {
      this._activeScenario.simStart = startDate
    }

    this._view.onEndChange = (endDate) => {
      this._activeScenario.simEnd = endDate
    }

    this._view.onInitialStateChange = (initialState) => {
      this._activeScenario.initialState = initialState;
    }

    this._view.onAddParameter = (parameter) => {
      this._activeScenario.params.push(parameter);
      this._view._renderParamsList(this._activeScenario);
    }

    /**
     * This call assumes this._activeScenario is up to date with the inputs
     * @param scenario
     */
    this._view.onSave = () => {
      //TODO Deal with saving the prebuilt scenarios with a new id?
      this._controller.save(this._activeScenario);
      this._view._refreshScenarioSelect(this._controller.getAll(), this._activeScenario);
    };

    this._view.onDownloadJson = () => {
      this._view.downloadJson(this._controller.getUserScenarios());
    };

    this._view.onUploadJson = async (file) => {
      const data = await this._view.readUploadedJson(file);
      this._activeScenario = this._controller.replaceUserScenarios(data);
      this._view._refreshScenarioSelect(this._controller.getAll(), this._activeScenario);
    };

    // Initial render.
    this._refresh();
  }

  _refresh() {
    this._activeScenario = this._controller.getActiveScenario();
    this._view._refreshScenarioSelect(this._controller.getAll(), this._activeScenario);
  }

  // ── Public ────────────────────────────────────────────────────────────────
  //TODO These should go away, this information will be tracked on change elsewhere
  getSimStart() {
    const simStartString = document.getElementById('simStartInput')?.value; //this.getSimulationStartDate();
    return (simStartString) ? new Date(simStartString) : undefined;
  }

  getSimEnd() {
    const simEndString = document.getElementById('simEndInput')?.value; //this.getSimulationEndDate();
    return (simEndString) ? new Date(simEndString) : undefined;
  }

}
