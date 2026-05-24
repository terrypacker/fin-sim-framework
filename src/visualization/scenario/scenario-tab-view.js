/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

export class ScenarioTabView {
  constructor() {

    /** @type {function(string)|null} */
    this.onOpen = null;
    /** @type {function()|null} */
    this.onRebuild = null;
    /** @type {function()|null} */
    this.onNew = null;
    /** @type {function(string)|null} */
    this.onDelete = null;


    /** @type {function(string)|null} */
    this.onNameChange = null;
    /** @type {function(Date)|null} */
    this.onStartChange = null;
    /** @type {function(Date)|null} */
    this.onEndChange = null;
    /** @type {function({})|null} */
    this.onInitialStateChange = null;
    /** @type {function({})|null} */
    this.onAddParameter = null;
    /** @type {function({scenario} */
    this.onSave   = null;
    /** @type {function()|null} */
    this.onDownloadJson = null;
    /** @type {function(file)|null} */
    this.onUploadJson = null;

    this._bound = false;
    // Bind immediately when DOM elements already exist (test environment).
    // In production the ScenarioPlugin hasn't mounted yet, so bind() must be
    // called explicitly from WorkbenchApp.initView() after the shell mounts.
    if (document.getElementById('scenarioSelect')) {
      this._init();
      this._bound = true;
    }
  }

  // ─── DOM wiring ───────────────────────────────────────────────────────────

  /**
   * Attach event listeners to the ScenarioPlugin DOM.
   * Must be called after ScenarioPlugin has mounted (elements exist in DOM).
   * Safe to call multiple times — wires only once.
   */
  bind() {
    if (this._bound) return;
    this._bound = true;
    this._init();
  }

  _init() {
    document.getElementById('scenarioSelect')?.addEventListener('change', (e) => {
      if(this.onOpen) this.onOpen(e.target.value || '')
    });

    document.getElementById('loadScenarioBtn')?.addEventListener('click', () => {
      if(this.onRebuild) this.onRebuild();
    });

    document.getElementById('newScenarioBtn')?.addEventListener('click', () => {
      if(this.onNew) this.onNew();
    });

    document.getElementById('deleteScenarioBtn')?.addEventListener('click', () => {
      if(this.onDelete) this.onDelete();
    });

    document.getElementById('scenarioName')?.addEventListener('input', (e) => {
      if(this.onNameChange) this.onNameChange(e.target.value);
    });

    document.getElementById('simStartInput')?.addEventListener('change', (e) => {
      if(this.onStartChange) this.onStartChange(e.target.value);
    });

    document.getElementById('simEndInput')?.addEventListener('change', (e) => {
      if(this.onEndChange) this.onEndChange(e.target.value);
    });

    document.getElementById('initialStateJson')?.addEventListener('blur', (e) => {
      try {
        const initialState = JSON.parse(e.target.value);
        if(this.onInitialStateChange) this.onInitialStateChange(initialState);
        e.target.style.borderColor = '';
      } catch {
        e.target.style.borderColor = 'red';
      }
    });

    document.getElementById('addParamBtn')?.addEventListener('click', () => {
      if(this.onAddParameter) this.onAddParameter({ name: '', type: 'Number', value: 0 });
    });

    document.getElementById('saveScenarioBtn')?.addEventListener('click', () => {
      if(this.onSave) this.onSave();
    });

    document.getElementById('downloadJsonBtn')?.addEventListener('click', () => {
      if(this.onDownloadJson) this.onDownloadJson();
    });

    document.getElementById('uploadJsonFileInput')?.addEventListener('change', async (e) => {
      if(this.onUploadJson) {
        const file = e.target.files[0];
        if (!file) return;
        try {
          this.onUploadJson(file);
        } catch (err) {
          alert('Failed to parse JSON file: ' + err.message);
        }
        e.target.value = '';
      }
    });
  }

  updateSelectOption(name) {
    const sel = document.getElementById('scenarioSelect');
    if (sel?.selectedIndex >= 0) sel.options[sel.selectedIndex].textContent = name || 'Unnamed';
  }

  _refreshScenarioSelect(scenarios, active) {
    const sel = document.getElementById('scenarioSelect');
    if (!sel) return;
    sel.innerHTML = '';

    // ── Pre-built scenarios optgroup ─────────────────────────────────────────
    const prebuiltScenarios = scenarios.filter(s => s.prebuilt === true);
    if (prebuiltScenarios.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Pre-built Scenarios';
      for (const pb of prebuiltScenarios) {
        const opt = document.createElement('option');
        opt.value       = pb.id;
        opt.textContent = pb.label;
        group.appendChild(opt);
      }
      sel.appendChild(group);
    }

    // ── User-saved scenarios optgroup ────────────────────────────────────────
    const userScenarios = scenarios.filter(s => s.prebuilt === false);
    if (userScenarios.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Saved Scenarios';
      userScenarios.forEach((s, i) => {
        const opt = document.createElement('option');
        opt.value       = s.id;
        opt.textContent = s.name || `Scenario ${i + 1}`;
        group.appendChild(opt);
      });
      sel.appendChild(group);
    }

    if(active) {
      sel.value = active.id;
      this._populateScenarioForm(active);
    }
  }

  _populateScenarioForm(scenario) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

    //TODO #268 this should be cleaned up to always be a date or UTC String
    let simStart,simEnd;
    if(scenario?.simStart instanceof Date) {
      simStart = scenario.simStart.toISOString().slice(0, 10);
    }else if(scenario?.simStart) {
      simStart = scenario?.simStart; //Could be a string not serialized I guess
    }else {
      simStart = '2026-01-01'; // Default
    }

    if(scenario?.simEnd instanceof Date) {
      simEnd = scenario.simEnd.toISOString().slice(0, 10);
    }else if(scenario?.simEnd) {
      simEnd = scenario?.simEnd; //Could be a string not serialized I guess {
    }else {
      simEnd = '2041-01-01'; // Default
    }


    set('scenarioName',     scenario?.name ?? scenario?.label ?? '');
    set('simStartInput',    simStart);
    set('simEndInput',      simEnd);
    set('initialStateJson', JSON.stringify(scenario?.initialState ?? { metrics: { } }, null, 2));
    this._renderParamsList(scenario);
  }

  _renderParamsList(scenario) {
    const container = document.getElementById('paramsList');
    if (!container) return;
    container.innerHTML = '';
    if (!scenario?.params?.length) return;

    let currentGroup = null;

    scenario.params.forEach((param, i) => {
      // ── Group header ──────────────────────────────────────────────────────
      if (param.group && param.group !== currentGroup) {
        currentGroup = param.group;
        const header = document.createElement('div');
        header.className = 'param-group-header';
        header.textContent = param.group;
        container.appendChild(header);
      }

      const row = document.createElement('div');
      row.className = 'param-row';

      // ── node-field: label + value input ───────────────────────────────────
      const field = document.createElement('div');
      field.className = 'node-field param-field';

      const labelEl = document.createElement('label');
      labelEl.textContent = param.label ?? param.name;
      if (param.label) labelEl.title = param.name;
      field.appendChild(labelEl);

      // For user-defined params (no label), also provide an editable name input above the value
      if (!param.label) {
        const nameInput = document.createElement('input');
        nameInput.placeholder = 'key';
        nameInput.value = param.name;
        nameInput.addEventListener('input', () => {
          param.name = nameInput.value;
          labelEl.textContent = nameInput.value;
        });
        field.appendChild(nameInput);
      }

      // ── Value input — type-appropriate control ────────────────────────────
      let valueInput;
      if (param.type === 'Boolean') {
        valueInput = document.createElement('select');
        ['true', 'false'].forEach(v => {
          const opt = document.createElement('option');
          opt.value = v; opt.textContent = v;
          valueInput.appendChild(opt);
        });
        valueInput.value = String(param.value ?? 'false');
        valueInput.addEventListener('change', () => { param.value = valueInput.value === 'true'; });
      } else if (param.type === 'Date') {
        valueInput = document.createElement('input');
        valueInput.type = 'date';
        const iso = param.value instanceof Date
          ? param.value.toISOString().slice(0, 10)
          : String(param.value ?? '').slice(0, 10);
        valueInput.value = iso;
        valueInput.addEventListener('change', () => { param.value = valueInput.value; });
      } else {
        valueInput = document.createElement('input');
        valueInput.placeholder = 'value';
        valueInput.value = String(param.value ?? '');
        valueInput.addEventListener('input', () => {
          const raw = valueInput.value;
          param.value = param.type === 'Number' ? parseFloat(raw) : raw;
        });
      }
      field.appendChild(valueInput);
      row.appendChild(field);

      // ── Type select ───────────────────────────────────────────────────────
      const typeSelect = document.createElement('select');
      ['Number', 'String', 'Boolean', 'Date'].forEach(t => {
        const opt = document.createElement('option');
        opt.value = t; opt.textContent = t;
        typeSelect.appendChild(opt);
      });
      typeSelect.value = param.type ?? 'Number';
      // Schema-defined params carry a label; prevent type changes on them to
      // avoid corrupting numeric year/boolean fields with incompatible types.
      if (param.label) {
        typeSelect.disabled = true;
      } else {
        typeSelect.addEventListener('change', () => {
          param.type = typeSelect.value;
          this._renderParamsList(scenario);
        });
      }
      row.appendChild(typeSelect);

      // ── Delete button ─────────────────────────────────────────────────────
      const delBtn = document.createElement('button');
      delBtn.className   = 'btn btn-warn btn-sm';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => {
        scenario.params.splice(i, 1);
        this._renderParamsList(scenario);
      });
      row.appendChild(delBtn);

      container.appendChild(row);
    });
  }

  downloadJson(data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'fin-sim-scenarios.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  readUploadedJson(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          resolve(JSON.parse(e.target.result));
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

}
