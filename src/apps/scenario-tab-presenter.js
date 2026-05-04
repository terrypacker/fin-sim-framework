/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ScenarioStorage }    from '../scenarios/scenario-storage.js';
import { ScenarioSerializer } from '../scenarios/scenario-serializer.js';
import { ServiceRegistry }    from '../services/service-registry.js';

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
   * @param {object}            [opts]
   * @param {PrebuiltScenario[]} [opts.prebuiltScenarios=[]]
   */
  constructor({ prebuiltScenarios = [] } = {}) {
    // Sort pre-built scenarios by order (ascending) so index 0 is the default.
    this._prebuiltScenarios = [...prebuiltScenarios].sort((a, b) => a.order - b.order);

    this._scenarioData = ScenarioStorage.load();

    // Restore last-used selection, or compute the appropriate default.
    const lastUsed = this._scenarioData.lastUsed;
    if (lastUsed !== undefined && lastUsed !== null) {
      this._activeValue = lastUsed;
    } else if (this._scenarioData.scenarios.length > 0) {
      // Backward-compat: if the user has saved scenarios but no lastUsed
      // (pre-feature data), select the first one as before.
      this._activeValue = 'u:0';
    } else if (this._prebuiltScenarios.length > 0) {
      this._activeValue = `p:${this._prebuiltScenarios[0].id}`;
    } else {
      this._activeValue = '';
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getParams() {
    const params = this._activeScenario()?.params;
    if (!params?.length) return {};
    return Object.fromEntries(params.map(p => [p.name, p.value]));
  }

  getInitialState() {
    return this._activeScenario()?.initialState ?? {};
  }

  /**
   * Instantiate the correct scenario class for the current selection.
   *
   * Resolution order:
   *  1. Active pre-built → use its factory directly.
   *  2. Active user scenario with a `scenarioId` → use the matching prebuilt factory.
   *  3. Active user scenario without `scenarioId` → use the first prebuilt factory.
   *  4. `fallbackFactory` argument → used when no prebuilt scenarios are registered.
   *
   * @param {object}   params        - Scenario params (from getParams())
   * @param {object}   initialState  - Initial state (from getInitialState())
   * @param {object}   ui            - EventSchedulerUI instance
   * @param {Function} [fallbackFactory] - Legacy factory for apps that don't supply prebuiltScenarios
   * @returns {BaseScenario}
   */
  createScenario(params, initialState, ui, fallbackFactory) {
    const pb = this._activePrebuilt();
    if (pb) return pb.factory(params, initialState, ui);

    const cfg = this._activeScenario();
    if (cfg) {
      // Try to find the prebuilt this user scenario was derived from.
      const matchedPb = cfg.scenarioId
        ? this._prebuiltScenarios.find(p => p.id === cfg.scenarioId)
        : null;
      const factory = (matchedPb ?? this._prebuiltScenarios[0])?.factory;
      if (factory) return factory(params, initialState, ui);
    }

    if (fallbackFactory) return fallbackFactory(params, initialState, ui);

    throw new Error('ScenarioTabPresenter: no scenario factory available');
  }

  /** Restore saved config or call loadDefaults(). Called after scenario.buildSim(). */
  afterBuildSim(scenario) {
    // Store so _saveCurrentScenario() can capture the resolved initialState.
    this._scenario = scenario;

    const cfg = this._activeScenario();
    if (cfg) {
      ScenarioSerializer.deserialize(cfg, ServiceRegistry.getInstance());
    } else if (typeof scenario.loadDefaults === 'function') {
      scenario.loadDefaults();
    }
  }

  /**
   * Wire all scenario-tab DOM event listeners.
   * @param {() => void} onRebuild — called when the user clicks "Load Scenario"
   */
  init(onRebuild) {
    this._refreshScenarioSelect();

    document.getElementById('scenarioSelect')?.addEventListener('change', (e) => {
      this._activeValue = e.target.value || '';
      this._persistLastUsed();
      this._populateScenarioForm();
    });

    document.getElementById('loadScenarioBtn')?.addEventListener('click', () => {
      onRebuild();
    });

    document.getElementById('newScenarioBtn')?.addEventListener('click', () => {
      // Base the new scenario on whatever prebuilt is currently active (or the first one).
      const pb = this._activePrebuilt() ?? this._prebuiltScenarios[0] ?? null;
      const newCfg = {
        name:         'New Scenario',
        scenarioId:   pb?.id ?? null,
        simStart:     pb?.simStart ?? '2026-01-01',
        simEnd:       pb?.simEnd   ?? '2041-01-01',
        events:       [],
        handlers:     [],
        actions:      [],
        reducers:     [],
        initialState: {},
        params:       [],
      };
      this._scenarioData.scenarios.push(newCfg);
      this._activeValue = `u:${this._scenarioData.scenarios.length - 1}`;
      this._persistLastUsed();
      ScenarioStorage.save(this._scenarioData);
      this._refreshScenarioSelect();
      this._populateScenarioForm();
    });

    document.getElementById('deleteScenarioBtn')?.addEventListener('click', () => {
      if (!this._activeValue?.startsWith('u:')) return;
      const idx = parseInt(this._activeValue.slice(2), 10);
      this._scenarioData.scenarios.splice(idx, 1);
      // After deletion, fall back to first prebuilt, then first user scenario, then empty.
      if (this._prebuiltScenarios.length > 0) {
        this._activeValue = `p:${this._prebuiltScenarios[0].id}`;
      } else if (this._scenarioData.scenarios.length > 0) {
        this._activeValue = 'u:0';
      } else {
        this._activeValue = '';
      }
      this._persistLastUsed();
      ScenarioStorage.save(this._scenarioData);
      this._refreshScenarioSelect();
      this._populateScenarioForm();
    });

    document.getElementById('scenarioName')?.addEventListener('input', (e) => {
      const cfg = this._activeScenario();
      if (!cfg) return;
      cfg.name = e.target.value;
      const sel = document.getElementById('scenarioSelect');
      if (sel?.selectedIndex >= 0) sel.options[sel.selectedIndex].textContent = cfg.name || 'Unnamed';
    });

    document.getElementById('simStartInput')?.addEventListener('change', (e) => {
      const cfg = this._activeScenario();
      if (cfg) cfg.simStart = e.target.value;
    });

    document.getElementById('simEndInput')?.addEventListener('change', (e) => {
      const cfg = this._activeScenario();
      if (cfg) cfg.simEnd = e.target.value;
    });

    document.getElementById('initialStateJson')?.addEventListener('blur', (e) => {
      const cfg = this._activeScenario();
      if (!cfg) return;
      try {
        cfg.initialState = JSON.parse(e.target.value);
        e.target.style.borderColor = '';
      } catch {
        e.target.style.borderColor = 'red';
      }
    });

    document.getElementById('addParamBtn')?.addEventListener('click', () => {
      const cfg = this._activeScenario();
      if (!cfg) return;
      cfg.params.push({ name: '', type: 'Number', value: 0 });
      this._renderParamsList();
    });

    document.getElementById('saveScenarioBtn')?.addEventListener('click', () => {
      this._saveCurrentScenario();
    });

    document.getElementById('downloadJsonBtn')?.addEventListener('click', () => {
      ScenarioStorage.downloadJson(this._scenarioData);
    });

    document.getElementById('uploadJsonFileInput')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = await ScenarioStorage.readUploadedJson(file);
        if (Array.isArray(data.scenarios)) {
          const existing = new Set(this._scenarioData.scenarios.map(s => s.name));
          for (const s of data.scenarios) {
            if (!existing.has(s.name)) {
              this._scenarioData.scenarios.push(s);
              existing.add(s.name);
            }
          }
        }
        ScenarioStorage.save(this._scenarioData);
        this._refreshScenarioSelect();
      } catch (err) {
        alert('Failed to parse JSON file: ' + err.message);
      }
      e.target.value = '';
    });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /** Returns the active PrebuiltScenario, or null if a user scenario (or nothing) is selected. */
  _activePrebuilt() {
    if (this._activeValue?.startsWith('p:')) {
      const id = this._activeValue.slice(2);
      return this._prebuiltScenarios.find(p => p.id === id) ?? null;
    }
    return null;
  }

  /** Returns the active user-saved scenario config, or null if a prebuilt is selected. */
  _activeScenario() {
    if (this._activeValue?.startsWith('u:')) {
      const idx = parseInt(this._activeValue.slice(2), 10);
      return this._scenarioData.scenarios[idx] ?? null;
    }
    return null;
  }

  /** Write the current active value as lastUsed and flush to localStorage. */
  _persistLastUsed() {
    this._scenarioData.lastUsed = this._activeValue;
    ScenarioStorage.save(this._scenarioData);
  }

  _refreshScenarioSelect() {
    const sel = document.getElementById('scenarioSelect');
    if (!sel) return;
    sel.innerHTML = '';

    // ── Pre-built scenarios optgroup ─────────────────────────────────────────
    if (this._prebuiltScenarios.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Pre-built Scenarios';
      for (const pb of this._prebuiltScenarios) {
        const opt = document.createElement('option');
        opt.value       = `p:${pb.id}`;
        opt.textContent = pb.label;
        group.appendChild(opt);
      }
      sel.appendChild(group);
    }

    // ── User-saved scenarios optgroup ────────────────────────────────────────
    if (this._scenarioData.scenarios.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Saved Scenarios';
      this._scenarioData.scenarios.forEach((s, i) => {
        const opt = document.createElement('option');
        opt.value       = `u:${i}`;
        opt.textContent = s.name || `Scenario ${i + 1}`;
        group.appendChild(opt);
      });
      sel.appendChild(group);
    }

    sel.value = this._activeValue ?? '';
    this._populateScenarioForm();
  }

  _populateScenarioForm() {
    const cfg = this._activeScenario();
    const pb  = this._activePrebuilt();
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

    if (pb) {
      set('scenarioName',     pb.label);
      set('simStartInput',    pb.simStart);
      set('simEndInput',      pb.simEnd);
      set('initialStateJson', '{}');
      this._renderParamsList();
      return;
    }

    set('scenarioName',     cfg?.name     ?? '');
    set('simStartInput',    cfg?.simStart ?? '2026-01-01');
    set('simEndInput',      cfg?.simEnd   ?? '2041-01-01');
    set('initialStateJson', JSON.stringify(cfg?.initialState ?? { metrics: { amount: 0, salary: 0 } }, null, 2));
    this._renderParamsList();
  }

  _renderParamsList() {
    const cfg = this._activeScenario();
    const container = document.getElementById('paramsList');
    if (!container) return;
    container.innerHTML = '';
    if (!cfg?.params?.length) return;

    cfg.params.forEach((param, i) => {
      const row = document.createElement('div');
      row.className = 'param-row';

      const nameInput = document.createElement('input');
      nameInput.placeholder = 'name';
      nameInput.value = param.name;
      nameInput.addEventListener('input', () => { param.name = nameInput.value; });

      const typeSelect = document.createElement('select');
      ['Number', 'String', 'Boolean'].forEach(t => {
        const opt = document.createElement('option');
        opt.value = t; opt.textContent = t;
        typeSelect.appendChild(opt);
      });
      typeSelect.value = param.type ?? 'Number';
      typeSelect.addEventListener('change', () => { param.type = typeSelect.value; });

      const valueInput = document.createElement('input');
      valueInput.placeholder = 'value';
      valueInput.value = String(param.value ?? '');
      valueInput.addEventListener('input', () => {
        const raw = valueInput.value;
        if      (param.type === 'Number')  param.value = parseFloat(raw);
        else if (param.type === 'Boolean') param.value = raw === 'true';
        else                               param.value = raw;
      });

      const delBtn = document.createElement('button');
      delBtn.className   = 'btn btn-warn btn-sm';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => {
        cfg.params.splice(i, 1);
        this._renderParamsList();
      });

      row.appendChild(nameInput);
      row.appendChild(typeSelect);
      row.appendChild(valueInput);
      row.appendChild(delBtn);
      container.appendChild(row);
    });
  }

  _saveCurrentScenario() {
    const pb = this._activePrebuilt();

    if (pb || !this._activeValue?.startsWith('u:')) {
      // Saving from a pre-built baseline → create a new user scenario.
      const name = document.getElementById('scenarioName')?.value || pb?.label || 'Saved Scenario';

      // Prefer the scenario's resolved initialState (set by buildSim / buildDefaultInitialState)
      // so that the full default state is captured in the config rather than an empty object.
      // Fall back to the UI textarea only if the scenario hasn't been built yet.
      const scenarioInitialState = this._scenario?.initialState ?? {};
      let initialState = Object.keys(scenarioInitialState).length > 0 ? scenarioInitialState : {};
      if (Object.keys(initialState).length === 0) {
        try { initialState = JSON.parse(document.getElementById('initialStateJson')?.value); } catch {}
      }

      this._scenarioData.scenarios.push({
        name,
        scenarioId:   pb?.id ?? null,
        simStart:     document.getElementById('simStartInput')?.value || pb?.simStart || '2026-01-01',
        simEnd:       document.getElementById('simEndInput')?.value   || pb?.simEnd   || '2041-01-01',
        events: [], handlers: [], actions: [], reducers: [],
        initialState,
        params: [],
      });
      this._activeValue = `u:${this._scenarioData.scenarios.length - 1}`;
    }

    const cfg = this._activeScenario();
    const serialized = ScenarioSerializer.serialize(
      ServiceRegistry.getInstance(),
      cfg.name,
      cfg.simStart,
      cfg.simEnd,
      cfg.initialState,
      cfg.params,
    );
    Object.assign(cfg, serialized);
    this._persistLastUsed();
    this._refreshScenarioSelect();
  }
}
