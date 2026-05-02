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
 * Owns:
 *  - _scenarioData / _activeIdx state
 *  - All scenario-tab DOM event listeners (wired once via init())
 *  - getParams() / getInitialState() / afterBuildSim() for BaseApp.buildScenario()
 */
export class ScenarioTabPresenter {

  constructor() {
    this._scenarioData = ScenarioStorage.load();
    // Auto-select the first saved scenario on load; fall back to default if none.
    this._activeIdx = this._scenarioData.scenarios.length > 0 ? 0 : null;
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

  /** Restore saved config or call loadDefaults(). Called after scenario.buildSim(). */
  afterBuildSim(scenario) {
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
      const val = e.target.value;
      this._activeIdx = val === '' ? null : parseInt(val, 10);
      this._populateScenarioForm();
    });

    document.getElementById('loadScenarioBtn')?.addEventListener('click', () => {
      onRebuild();
    });

    document.getElementById('newScenarioBtn')?.addEventListener('click', () => {
      const newCfg = {
        name:         'New Scenario',
        simStart:     '2026-01-01',
        simEnd:       '2041-01-01',
        events:       [],
        handlers:     [],
        actions:      [],
        reducers:     [],
        initialState: { metrics: { amount: 0, salary: 0 } },
        params:       [],
      };
      this._scenarioData.scenarios.push(newCfg);
      this._activeIdx = this._scenarioData.scenarios.length - 1;
      this._refreshScenarioSelect();
      this._populateScenarioForm();
    });

    document.getElementById('deleteScenarioBtn')?.addEventListener('click', () => {
      if (this._activeIdx === null) return;
      this._scenarioData.scenarios.splice(this._activeIdx, 1);
      this._activeIdx = null;
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

  _activeScenario() {
    if (this._activeIdx !== null) {
      return this._scenarioData.scenarios[this._activeIdx] ?? null;
    }
    return null;
  }

  _refreshScenarioSelect() {
    const sel = document.getElementById('scenarioSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Default Scenario —</option>';
    this._scenarioData.scenarios.forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value       = i;
      opt.textContent = s.name || `Scenario ${i + 1}`;
      sel.appendChild(opt);
    });
    sel.value = this._activeIdx !== null ? String(this._activeIdx) : '';
    this._populateScenarioForm();
  }

  _populateScenarioForm() {
    const cfg = this._activeScenario();
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
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
    if (this._activeIdx === null) {
      const name = document.getElementById('scenarioName')?.value || 'Saved Scenario';
      let initialState = { metrics: { amount: 0, salary: 0 } };
      try { initialState = JSON.parse(document.getElementById('initialStateJson')?.value); } catch {}
      this._scenarioData.scenarios.push({
        name,
        simStart:     document.getElementById('simStartInput')?.value || '2026-01-01',
        simEnd:       document.getElementById('simEndInput')?.value   || '2041-01-01',
        events: [], handlers: [], actions: [], reducers: [],
        initialState,
        params: [],
      });
      this._activeIdx = this._scenarioData.scenarios.length - 1;
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
    ScenarioStorage.save(this._scenarioData);
    this._refreshScenarioSelect();
  }
}
