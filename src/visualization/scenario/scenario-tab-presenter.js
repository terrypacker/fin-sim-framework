/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ServiceRegistry }    from '../../services/service-registry.js';
import { ScenarioSerializer } from '../../scenarios/scenario-serializer.js';

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
  constructor({ controller, view, bus, initScenario, getBuiltScenario }) {
    this._controller = controller;
    this._view = view;
    this._bus = bus;
    this._initScenario = initScenario;
    this._getBuiltScenario = getBuiltScenario ?? null;
    this._activeScenario = null;

    this._view.onOpen = (id) => {
      this._controller.setActiveById(id);
      this._activeScenario = this._controller.getActiveScenario();
      this._loadActiveScenario();
    };

    this._view.onRebuild = () => {
      this._initScenario();
    };

    this._view.onNew = () => {
      this._activeScenario = this._controller.newScenario(this._activeScenario);
      this._view._refreshScenarioSelect(this._controller.getAll(), this._activeScenario);
    };

    this._view.onDelete = () => {
      if (!this._activeScenario || this._activeScenario.prebuilt) return;
      this._activeScenario = this._controller.delete(this._activeScenario);
      this._view._refreshScenarioSelect(this._controller.getAll(), this._activeScenario);
    };

    this._view.onResetDefaults = () => {
      if (!this._activeScenario) return;
      this._controller.resetToDefaults(this._activeScenario);
      this._view._populateScenarioForm(this._activeScenario);
      this._initScenario();
    };

    this._view.onNameChange = (name) => {
      this._activeScenario.name = name;
      this._view.updateSelectOption(name);
    }

    this._view.onStartChange = (startDate) => {
      //TODO #268 Need to deal with timezone here
      this._activeScenario.simStart = new Date(startDate);
    }

    this._view.onEndChange = (endDate) => {
      //TODO #268 Need to deal with timezone here
      this._activeScenario.simEnd = new Date(endDate);
    }

    this._view.onInitialStateChange = (initialState) => {
      this._activeScenario.initialState = initialState;
    }

    this._view.onAddParameter = (parameter) => {
      this._activeScenario.params.push(parameter);
      this._view._renderParamsList(this._activeScenario);
    }

    this._view.onSave = () => {
      const services = ServiceRegistry.getInstance();
      if (!this._activeScenario) return;

      // Domain objects
      this._activeScenario.persons        = (services.personService?.getAll()        ?? []).map(p => ScenarioSerializer._serializePerson(p));
      this._activeScenario.accounts       = (services.accountService?.getAll()       ?? []).map(a => ScenarioSerializer._serializeAccount(a));
      this._activeScenario.realProperties = (services.realPropertyService?.getAll()  ?? []).map(p => ScenarioSerializer._serializeRealProperty(p));
      this._activeScenario.collectibles   = (services.collectibleService?.getAll()   ?? []).map(c => ScenarioSerializer._serializeCollectible(c));

      // Graph snapshot — captured so subsequent loads take the deserialize
      // branch in ScenarioLoader rather than recompiling from toolsets.
      this._activeScenario.events   = (services.eventService?.getAll()   ?? []).map(n => ScenarioSerializer._serializeEvent(n));
      this._activeScenario.handlers = (services.handlerService?.getAll() ?? []).map(n => ScenarioSerializer._serializeHandler(n));
      this._activeScenario.actions  = (services.actionService?.getAll()  ?? []).map(n => ScenarioSerializer._serializeAction(n));
      this._activeScenario.reducers = (services.reducerService?.getAll() ?? []).map(n => ScenarioSerializer._serializeReducer(n));

      this._controller.save(this._activeScenario);
      this._view._refreshScenarioSelect(this._controller.getAll(), this._activeScenario);
    };

    this._view.onDownloadJson = () => {
      const services = ServiceRegistry.getInstance();
      const active   = this._activeScenario;
      const built    = this._getBuiltScenario?.();
      const serialized = ScenarioSerializer.serialize(
        services,
        active?.id    ?? 'export',
        active?.name  ?? 'Exported Scenario',
        active?.order ?? 100,
        true,
        built?.simStart    ?? active?.simStart,
        built?.simEnd      ?? active?.simEnd,
        built?.initialState ?? active?.initialState ?? {},
        active?.params ?? [],
      );
      this._view.downloadJson({ scenarios: [serialized] });
    };

    this._view.onUploadJson = async (file) => {
      const data = await this._view.readUploadedJson(file);

      //Replace and set active scenario
      this._activeScenario = this._controller.replaceUserScenarios(data);
      this._loadActiveScenario();
    };

  }

  /**
   * Performs load of scenario data in UI and services.
   *
   * Design 15 §2.4: re-selecting the same prebuilt no longer silently resets to
   * defaults — Load means "load as stored." Reset is its own explicit action
   * (the Reset to Defaults button).
   *
   * Assumes the active scenario is set in this._activeScenario?
   * @private
   */
  _loadActiveScenario() {
    this._initScenario();
    this._view._populateScenarioForm(this._activeScenario);
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
