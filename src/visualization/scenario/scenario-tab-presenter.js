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
import { paramsToCsv, csvToParamUpdates, coerceParamValue, CSV_SCALAR_TYPES } from './param-csv.js';

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
 * array (each entry: `{cls, order, active, simStart, simEnd}`) sorted by `order`
 * (ascending).  On a fresh page
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
  constructor({ controller, view, bus, initScenario, editModal }) {
    this._controller = controller;
    this._view = view;
    this._bus = bus;
    this._initScenario = initScenario;
    this._editModal = editModal ?? null;
    this._activeScenario = null;

    // Resolve a param's `node` declaration to the live account/person so the
    // params panel can display the current name (not the frozen schema label).
    this._view.nodeLookup = (paramNode) => {
      if (!paramNode) return null;
      const registry = ServiceRegistry.getInstance();
      if (paramNode.type === 'account') {
        const account = registry.accountService?.getAll?.()
          .find(a => a.stateKey === paramNode.stateKey);
        return account
          ? { name: account.name ?? paramNode.stateKey, kind: 'account', node: account, found: true }
          : { name: paramNode.stateKey, kind: 'account', node: null, found: false };
      }
      if (paramNode.type === 'person') {
        const person = registry.personService?.getAll?.()
          .find(p => p.id === paramNode.id);
        return person
          ? { name: person.name ?? paramNode.id, kind: 'person', node: person, found: true }
          : { name: paramNode.id, kind: 'person', node: null, found: false };
      }
      return null;
    };

    // Supply persons to person-picker param editors (e.g. HealthcareEventList).
    this._view.personsProvider = () => {
      const registry = ServiceRegistry.getInstance();
      return (registry.personService?.getAll?.() ?? [])
        .map(p => ({ id: p.id, name: p.name ?? p.id }));
    };

    // Click-through: open the linked account/person in the shared edit modal.
    this._view.onOpenLinkedNode = (paramNode) => {
      const info = this._view.nodeLookup?.(paramNode);
      if (!info?.node || !this._editModal) return;
      this._editModal.open(info.node);
    };

    // Re-render the params list when an account or person is renamed in the
    // Configuration editor so the linked labels track the live names without
    // requiring a scenario rebuild.
    this._bus?.subscribe?.('SERVICE_ACTION', (msg) => {
      const kind = msg?.item?.kind;
      if (kind !== 'account' && kind !== 'person') return;
      if (!this._activeScenario?.params?.length) return;
      this._view._renderParamsList(this._activeScenario);
    });

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
      this._loadActiveScenario();
    };

    this._view.onNewBlank = () => {
      this._activeScenario = this._controller.newBlankScenario(this._activeScenario);
      this._loadActiveScenario();
    };

    this._view.onDelete = () => {
      if (!this._activeScenario || this._activeScenario.prebuilt) return;
      this._activeScenario = this._controller.delete(this._activeScenario);
      this._view._refreshScenarioSelect(this._controller.getAll(), this._activeScenario);
    };

    this._view.onResetDefaults = () => {
      if (!this._activeScenario) return;
      // Reset is destructive — it replaces the whole config (persons, accounts,
      // and every parameter) with the prebuilt defaults and discards edits.
      // Confirm first so it can't wipe a customized scenario by accident.
      const name = this._activeScenario.name ?? 'this scenario';
      const ok = (typeof window === 'undefined' || typeof window.confirm !== 'function')
        ? true
        : window.confirm(
            `Reset "${name}" to prebuilt defaults?\n\n` +
            `This discards ALL customizations — parameters, persons, and accounts — ` +
            `and cannot be undone. Export to JSON first if you want to keep them.`
          );
      if (!ok) return;
      this._controller.resetToDefaults(this._activeScenario);
      this._view._populateScenarioForm(this._activeScenario);
      this._initScenario();
    };

    this._view.onNameChange = (name) => {
      this._activeScenario.name = name;
      this._view.updateSelectOption(name);
    }

    this._view.onStartChange = (startDate) => {
      // <input type="date"> emits YYYY-MM-DD; canonicalize to full ISO so the
      // registry / storage / JSON download all share one representation.
      this._activeScenario.simStart = ScenarioSerializer.toDateStr(startDate);
    }

    this._view.onEndChange = (endDate) => {
      this._activeScenario.simEnd = ScenarioSerializer.toDateStr(endDate);
    }

    this._view.onAddParameter = (parameter) => {
      this._activeScenario.params.push(parameter);
      this._view._renderParamsList(this._activeScenario);
    }

    this._view.onSave = () => {
      if (!this._activeScenario) return;
      // Harvest in-flight service-map state into the active scenario record so
      // localStorage / Download / Rebuild see edits the user has made but not
      // yet rebuilt. The graph snapshot also forces subsequent loads through
      // the deserialize branch rather than recompiling from toolsets.
      Object.assign(this._activeScenario, ScenarioSerializer.snapshotServices(ServiceRegistry.getInstance()));
      this._controller.save(this._activeScenario);
      this._view._refreshScenarioSelect(this._controller.getAll(), this._activeScenario);
    };

    this._view.onDownloadJson = () => {
      // Design 15: the active scenario record is the source of truth. Serialize
      // straight from it instead of re-reading services or the live built
      // scenario — both can diverge from what's actually in storage/cfg.
      if (!this._activeScenario) return;
      const serialized = ScenarioSerializer.serializeScenario(this._activeScenario);
      this._view.downloadJson({ scenarios: [serialized] });
    };

    this._view.onUploadJson = async (file) => {
      const data = await this._view.readUploadedJson(file);

      //Replace and set active scenario
      this._activeScenario = this._controller.upsertUserScenarios(data);
      this._loadActiveScenario();
    };

    this._view.onDownloadCsv = () => {
      if (!this._activeScenario) return;
      const csv  = paramsToCsv(this._activeScenario.params);
      const base = (this._activeScenario.name || 'scenario').replace(/[^\w.-]+/g, '-');
      this._view.downloadFile(`${base}-params.csv`, csv, 'text/csv');
    };

    this._view.onUploadCsv = async (file) => {
      const text   = await this._view.readUploadedText(file);
      const result = this._applyParamCsv(text);
      this._view._renderParamsList(this._activeScenario);
      this._view.reportCsvImport(result);
    };

  }

  /**
   * Apply a parameter CSV to the active scenario's params, in place.
   *
   * Matches rows to live params by key (param.name); coerces each value by the
   * live param's own type; skips unknown keys and non-scalar params; collects
   * per-row errors. Does not rebuild — like the inline editor, the user hits
   * Rebuild to push edits into the sim via the normal service path.
   *
   * @returns {{applied:number, skipped:string[], errors:string[]}|{error:string}}
   * @private
   */
  _applyParamCsv(text) {
    const params = this._activeScenario?.params ?? [];
    const byKey  = new Map(params.map(p => [p.name, p]));

    let updates;
    try { updates = csvToParamUpdates(text); }
    catch (e) { return { error: e.message }; }

    let applied = 0;
    const skipped = [];
    const errors  = [];
    for (const { key, rawValue, rawCurrency } of updates) {
      const param = byKey.get(key);
      if (!param || !CSV_SCALAR_TYPES.has(param.type)) { skipped.push(key); continue; }
      const res = coerceParamValue(param, rawValue);
      if (!res.ok) { errors.push(`${key}: ${res.error}`); continue; }
      param.value = res.value;
      // Money params round-trip their native currency from the `currency` column.
      if (param.type === 'Money') {
        const cur = String(rawCurrency ?? '').trim().toUpperCase();
        if (cur === 'USD' || cur === 'AUD') param.currency = cur;
      }
      applied++;
    }
    return { applied, skipped, errors };
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

  /**
   * The active scenario's live params array — the exact objects the params panel
   * renders. Editors build a ParamFieldLinks from this and mutate these entries
   * directly so a linked-field edit and the panel share one source (design/32).
   * @returns {Array<object>}
   */
  getActiveParams() {
    return this._activeScenario?.params ?? [];
  }

  /** Re-render the params list (e.g. after an editor wrote a linked param). */
  refreshParams() {
    if (this._activeScenario) this._view._renderParamsList(this._activeScenario);
  }

  /**
   * Reveal a param in the panel: clear the filter, expand its group, and
   * re-render so a click-through from an editor's 🔗 badge lands on it.
   * @param {object} param
   */
  revealParam(param) {
    if (!param || !this._activeScenario) return;
    this._view.revealParam?.(param, this._activeScenario);
  }

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
