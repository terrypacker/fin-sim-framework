/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { isParamVisible, visibleWhenControllers } from '../../finance/param-schema-utils.js';

export class ScenarioTabView {
  constructor() {

    /** @type {function(string)|null} */
    this.onOpen = null;
    /** @type {function()|null} */
    this.onRebuild = null;

    // Linked-node resolution for params with a `node` declaration. The
    // presenter wires these so the params list reflects current account/person
    // names instead of frozen schema labels.
    /** @type {function({type,stateKey?,id?,field}): {name:string,kind:string,node?:object,found?:boolean}|null} */
    this.nodeLookup = null;
    /** @type {function(object): void} */
    this.onOpenLinkedNode = null;
    /**
     * Supplies the list of persons for person-picker param editors (e.g. the
     * HealthcareEventList Person column). The presenter wires this from the
     * personService so the view stays service-agnostic.
     * @type {function(): Array<{id:string,name:string}>|null}
     */
    this.personsProvider = null;
    /** @type {function()|null} */
    this.onNew = null;
    /** @type {function()|null} */
    this.onNewBlank = null;
    /** @type {function(string)|null} */
    this.onDelete = null;
    /** @type {function()|null} */
    this.onResetDefaults = null;


    /** @type {function(string)|null} */
    this.onNameChange = null;
    /** @type {function(Date)|null} */
    this.onStartChange = null;
    /** @type {function(Date)|null} */
    this.onEndChange = null;
    /** @type {function({})|null} */
    this.onAddParameter = null;
    /** @type {function({scenario} */
    this.onSave   = null;
    /** @type {function()|null} */
    this.onDownloadJson = null;
    /** @type {function(file)|null} */
    this.onUploadJson = null;
    /** @type {function()|null} */
    this.onDownloadCsv = null;
    /** @type {function(file)|null} */
    this.onUploadCsv = null;

    // Parameters list: live filter substring + per-group expand state.
    // Mirrors StatePanelView's filter/foldable-section behaviour. Groups are
    // collapsed by default; absence from _expandedGroups means collapsed.
    this._paramFilter       = '';
    this._expandedGroups    = new Set();
    // Which param fields the filter searches. Defaults to description only.
    this._paramFilterFields = new Set(['description']);
    this._activeScenario    = null;

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

    document.getElementById('newBlankScenarioBtn')?.addEventListener('click', () => {
      if(this.onNewBlank) this.onNewBlank();
    });

    document.getElementById('deleteScenarioBtn')?.addEventListener('click', () => {
      if(this.onDelete) this.onDelete();
    });

    document.getElementById('resetDefaultsBtn')?.addEventListener('click', () => {
      if(this.onResetDefaults) this.onResetDefaults();
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

    document.getElementById('paramsFilter')?.addEventListener('input', (e) => {
      this._paramFilter = (e.target.value ?? '').trim().toLowerCase();
      if (this._activeScenario) this._renderParamsList(this._activeScenario);
    });

    this._buildFilterFieldSelect(document.getElementById('paramsFilterFields'));

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

    document.getElementById('downloadCsvBtn')?.addEventListener('click', () => {
      if(this.onDownloadCsv) this.onDownloadCsv();
    });

    document.getElementById('uploadCsvFileInput')?.addEventListener('change', async (e) => {
      if(this.onUploadCsv) {
        const file = e.target.files[0];
        if (!file) return;
        try {
          await this.onUploadCsv(file);
        } catch (err) {
          alert('Failed to import CSV: ' + err.message);
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
        opt.textContent = pb.name;
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

    // Registry / cfg invariant (Design 15): simStart/simEnd are full ISO strings.
    // <input type="date"> only accepts YYYY-MM-DD, so slice the first 10 chars.
    const toInputDate = (val, fallback) => {
      if (!val) return fallback;
      const iso = val instanceof Date ? val.toISOString() : String(val);
      return iso.slice(0, 10);
    };
    const simStart = toInputDate(scenario?.simStart, '2026-01-01');
    const simEnd   = toInputDate(scenario?.simEnd,   '2041-01-01');

    set('scenarioName',  scenario?.name ?? scenario?.label ?? '');
    set('simStartInput', simStart);
    set('simEndInput',   simEnd);

    const addBtn = document.getElementById('addParamBtn');
    if (addBtn) addBtn.disabled = !!scenario?.prebuilt;

    this._renderParamsList(scenario);
  }

  /**
   * Reveal a param: clear the filter, expand its group, re-render, then scroll
   * the row into view and briefly highlight it. Backs an editor's 🔗 click-through
   * (design/32).
   */
  revealParam(param, scenario) {
    if (!param) return;
    this._paramFilter = '';
    const filterInput = document.getElementById('paramsFilter');
    if (filterInput) filterInput.value = '';
    if (param.group) this._expandedGroups.add(param.group);
    this._renderParamsList(scenario);

    const row = document.querySelector(`#paramsList .param-row[data-param-name="${CSS.escape(param.name)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.classList.add('param-row--revealed');
      setTimeout(() => row.classList.remove('param-row--revealed'), 1500);
    }
  }

  _renderParamsList(scenario) {
    const container = document.getElementById('paramsList');
    if (!container) return;
    container.innerHTML = '';
    this._activeScenario = scenario;
    if (!scenario?.params?.length) return;

    // Sort by group in place. Array.sort mutates, so the indices captured below
    // stay valid for splice-on-delete.
    scenario.params.sort((a, b) => (a.group ?? '').localeCompare(b.group ?? ''));

    const filter = this._paramFilter;

    // Conditional visibility (visibleWhen): a param can declare it should only
    // show when another param's value satisfies a predicate (e.g. a strategy
    // config knob is shown only when its strategy is selected). Pure UI — the
    // compiler still receives every param. valueByName resolves the controlling
    // param's current value; controllerNames are the params others depend on, so
    // a change to one re-renders the list to reveal/hide dependents.
    const valueByName = new Map(scenario.params.map(p => [p.name, p.value]));
    // Controllers are params others depend on, so a change re-renders the list.
    // Two dependency kinds: visibleWhen (reveal/hide) and dynamicOptionsFrom (an
    // Enum whose selectable options are extended by a sibling list param).
    this._controllerNames = new Set([
      ...scenario.params.flatMap(p => visibleWhenControllers(p)),
      ...scenario.params.map(p => p.dynamicOptionsFrom).filter(Boolean),
    ]);

    // Group visible params (preserving original index for delete) by group label.
    const groups = new Map();   // group label → [{ param, index }]
    scenario.params.forEach((param, index) => {
      if (param.hidden) return;
      if (!this._paramVisible(param, valueByName)) return;
      if (filter && !this._paramMatchesFilter(param, filter)) return;
      const key = param.group || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ param, index });
    });

    for (const [group, entries] of groups) {
      // Ungrouped params render directly with no (collapsible) header.
      if (!group) {
        entries.forEach(({ param, index }) =>
          container.appendChild(this._buildParamRow(param, index, scenario)));
        continue;
      }

      // Groups are collapsed by default; an active filter force-expands matches.
      const expanded = filter !== '' || this._expandedGroups.has(group);
      container.appendChild(this._buildGroupHeader(group, expanded, scenario));
      if (!expanded) continue;

      entries.forEach(({ param, index }) =>
        container.appendChild(this._buildParamRow(param, index, scenario)));
    }
  }

  /**
   * Evaluate a param's `visibleWhen` condition against the current param values
   * (shared evaluator — same DSL as the MC/Opt variable lists).
   * @param {object} param  the param being tested
   * @param {Map<string,*>} valueByName  name → current value for every param
   */
  _paramVisible(param, valueByName) {
    return isParamVisible(param, (name) => valueByName.get(name));
  }

  /**
   * Re-render the params list when a param that others' visibility depends on
   * changes — so dependent rows appear/disappear live. No-op for params nothing
   * depends on, keeping ordinary edits cheap.
   */
  _maybeRerenderForController(param, scenario) {
    if (this._controllerNames?.has(param.name)) this._renderParamsList(scenario);
  }

  /**
   * Case-insensitive substring match against the param fields the user opted into
   * via the filter-field multi-select (defaults to description only).
   */
  _paramMatchesFilter(param, filter) {
    const fields = this._paramFilterFields;
    const parts = [];
    if (fields.has('label'))       parts.push(param.label ?? '');
    if (fields.has('name'))        parts.push(param.name ?? '');
    if (fields.has('group'))       parts.push(param.group ?? '');
    if (fields.has('description')) parts.push(param.description ?? '');
    return parts.join(' ').toLowerCase().includes(filter);
  }

  /** Build a clickable, collapsible group header (caret + label). */
  _buildGroupHeader(group, expanded, scenario) {
    const header = document.createElement('div');
    header.className = 'param-group-header';
    if (!expanded) header.classList.add('param-group-header--collapsed');

    const caret = document.createElement('span');
    caret.className = 'param-group-caret';
    caret.textContent = expanded ? '▼' : '▶';

    const label = document.createElement('span');
    label.textContent = group;

    header.append(caret, label);
    header.addEventListener('click', () => {
      if (this._expandedGroups.has(group)) this._expandedGroups.delete(group);
      else this._expandedGroups.add(group);
      this._renderParamsList(scenario);
    });
    return header;
  }

  /**
   * Build the filter-field multi-select dropdown — a toggle button plus a popup
   * of checkboxes controlling which param fields _paramMatchesFilter searches.
   * Self-contained (no BaseComponent) to match this view's plain-DOM style.
   */
  _buildFilterFieldSelect(container) {
    if (!container) return;
    container.innerHTML = '';

    const FIELDS = [
      { key: 'label',       label: 'Label' },
      { key: 'name',        label: 'Name' },
      { key: 'group',       label: 'Group' },
      { key: 'description', label: 'Description' },
    ];

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'param-filter-fields-btn';
    btn.title = 'Choose which fields the filter searches';

    const menu = document.createElement('div');
    menu.className = 'param-filter-fields-menu';
    menu.style.display = 'none';

    const syncBtnLabel = () => {
      const sel = FIELDS.filter(f => this._paramFilterFields.has(f.key)).map(f => f.label);
      btn.textContent = (sel.length === 0 ? 'Search: none'
        : sel.length === FIELDS.length ? 'Search: all'
        : `Search: ${sel.join(', ')}`) + ' ▾';
    };

    FIELDS.forEach(({ key, label }) => {
      const row = document.createElement('label');
      row.className = 'param-filter-fields-option';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this._paramFilterFields.has(key);
      cb.addEventListener('change', () => {
        if (cb.checked) this._paramFilterFields.add(key);
        else this._paramFilterFields.delete(key);
        syncBtnLabel();
        if (this._activeScenario) this._renderParamsList(this._activeScenario);
      });

      row.append(cb, document.createTextNode(label));
      menu.appendChild(row);
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'none' ? '' : 'none';
    });
    // Close when clicking outside the dropdown.
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) menu.style.display = 'none';
    });

    syncBtnLabel();
    container.append(btn, menu);
  }

  /** Build a single param row (label/value/type/delete). Returns the row element. */
  _buildParamRow(param, i, scenario) {
      // ── Resolve linked-node label/state (account or person) ───────────────
      // For params with a `node` declaration, derive the displayed label from
      // the live account/person so that renaming an account in the
      // Configuration list updates the params panel automatically.
      let linkedInfo = null;
      if (param.node && typeof this.nodeLookup === 'function') {
        linkedInfo = this.nodeLookup(param.node);
      }
      const linkedFound = !linkedInfo ? null : (linkedInfo.found !== false);
      const fallbackLabel = param.label ?? param.name;
      const displayLabel = (linkedInfo && linkedFound)
        ? `${linkedInfo.name} — ${this._humanizeField(param.node.field)}`
        : (linkedInfo && linkedFound === false)
          ? `(unlinked) ${fallbackLabel}`
          : fallbackLabel;

      const row = document.createElement('div');
      row.className = 'param-row';
      row.dataset.paramName = param.name; // for revealParam() click-through (design/32)
      if (linkedFound === false) row.classList.add('param-row--unlinked');

      // ── node-field: label + value input ───────────────────────────────────
      const field = document.createElement('div');
      field.className = 'node-field param-field';

      const labelEl = document.createElement('label');
      labelEl.textContent = displayLabel;
      // Tooltip: prefer the schema description (richest), then the key name,
      // so hovering surfaces the toolset's authoritative documentation.
      const tooltip = param.description || (param.label ? param.name : '');
      if (tooltip) labelEl.title = tooltip;

      // Click-through to open the linked account/person editor. Only shown
      // when a node was resolved and the presenter wired a handler.
      if (param.node && linkedFound && typeof this.onOpenLinkedNode === 'function') {
        const linkBtn = document.createElement('button');
        linkBtn.type = 'button';
        linkBtn.className = 'param-link-btn';
        linkBtn.textContent = '↗';
        linkBtn.title = `Open ${linkedInfo.name}`;
        linkBtn.addEventListener('click', (e) => {
          e.preventDefault();
          this.onOpenLinkedNode(param.node);
        });
        labelEl.appendChild(linkBtn);
      }

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
        valueInput.addEventListener('change', () => {
          param.value = valueInput.value === 'true';
          this._maybeRerenderForController(param, scenario);
        });
      } else if (param.type === 'Date') {
        valueInput = document.createElement('input');
        valueInput.type = 'date';
        const iso = param.value instanceof Date
          ? param.value.toISOString().slice(0, 10)
          : String(param.value ?? '').slice(0, 10);
        valueInput.value = iso;
        valueInput.addEventListener('change', () => { param.value = valueInput.value; });
      } else if (param.type === 'ShockList') {
        valueInput = _buildShockListEditor(param);
      } else if (param.type === 'AgeBandList') {
        valueInput = _buildAgeBandListEditor(param);
      } else if (param.type === 'ExpenseBandList') {
        valueInput = _buildExpenseBandListEditor(param);
      } else if (param.type === 'RothScheduleList') {
        valueInput = _buildRothScheduleListEditor(param);
      } else if (param.type === 'PrimeScheduleList') {
        valueInput = _buildPrimeScheduleListEditor(param);
      } else if (param.type === 'EarlyWithdrawalScheduleList') {
        valueInput = _buildEarlyWithdrawalScheduleListEditor(param);
      } else if (param.type === 'HealthcareEventList') {
        valueInput = _buildHealthcareEventListEditor(param, this.personsProvider);
      } else if (param.type === 'DrawdownStrategyList') {
        valueInput = _buildDrawdownStrategyListEditor(
          param, () => this._maybeRerenderForController(param, scenario),
          scenario.params);
      } else if (param.type === 'Enum') {
        valueInput = document.createElement('select');
        // Static schema options plus any names contributed by a sibling list
        // param named in `dynamicOptionsFrom` (e.g. custom drawdown strategies).
        let enumOptions = param.options ?? [];
        if (param.dynamicOptionsFrom) {
          const src = scenario.params.find(p => p.name === param.dynamicOptionsFrom);
          const extra = Array.isArray(src?.value)
            ? src.value.map(s => s?.name).filter(Boolean) : [];
          enumOptions = [...enumOptions, ...extra];
        }
        enumOptions.forEach(opt => {
          const el = document.createElement('option');
          el.value = opt; el.textContent = opt;
          valueInput.appendChild(el);
        });
        valueInput.value = param.value ?? (param.options?.[0] ?? '');
        valueInput.addEventListener('change', () => {
          param.value = valueInput.value;
          this._maybeRerenderForController(param, scenario);
        });
      } else if (param.type === 'EnumMulti') {
        valueInput = _buildEnumMultiEditor(param, () => this._maybeRerenderForController(param, scenario));
      } else if (param.type === 'Money') {
        // Numeric value + inline native-currency selector (design 10 §Phase 5).
        // The value stays numeric (the compiler reads it as-is); the chosen
        // currency rides on param.currency and is stamped at load time.
        valueInput = document.createElement('div');
        valueInput.className = 'param-money';

        const num = document.createElement('input');
        num.type = 'number';
        num.placeholder = 'value';
        num.value = param.value ?? '';
        num.addEventListener('input', () => {
          const raw = num.value;
          param.value = raw.trim() === '' ? null : parseFloat(raw);
        });

        const cur = document.createElement('select');
        ['USD', 'AUD'].forEach(c => {
          const o = document.createElement('option');
          o.value = c; o.textContent = c;
          cur.appendChild(o);
        });
        cur.value = param.currency ?? param.defaultCurrency ?? 'USD';
        cur.addEventListener('change', () => { param.currency = cur.value; });

        valueInput.appendChild(num);
        valueInput.appendChild(cur);
      } else if (param.type === 'Object') {
        // Structured params (maps / tables) carry a real object|array value — a plain
        // text input would store a String and corrupt them. Render a JSON textarea that
        // parses on input: empty ⇒ null; invalid JSON is flagged and leaves the last
        // valid value untouched so a mid-edit keystroke never clobbers the model.
        valueInput = document.createElement('textarea');
        valueInput.className = 'param-json';
        valueInput.rows = 3;
        valueInput.spellcheck = false;
        valueInput.placeholder = 'JSON — blank = default (see description)';
        valueInput.value = (param.value == null) ? '' : JSON.stringify(param.value);
        valueInput.addEventListener('input', () => {
          const raw = valueInput.value.trim();
          if (raw === '') { param.value = null; valueInput.classList.remove('param-json-invalid'); return; }
          try { param.value = JSON.parse(raw); valueInput.classList.remove('param-json-invalid'); }
          catch { valueInput.classList.add('param-json-invalid'); }   // keep last valid value
        });
      } else {
        valueInput = document.createElement('input');
        valueInput.placeholder = 'value';
        valueInput.value = String(param.value ?? '');
        valueInput.addEventListener('input', () => {
          const raw = valueInput.value;
          param.value = param.type === 'Number'
            ? (raw.trim() === '' ? null : parseFloat(raw))
            : raw;
        });
      }
      if (tooltip) valueInput.title = tooltip;
      field.appendChild(valueInput);
      row.appendChild(field);

      // ── Type select (custom params only) ──────────────────────────────────
      // Schema-defined params (those carrying a label) have a fixed, non-editable
      // type, so the type-select is always disabled for them — it just crowds the
      // value field into a narrow first column. Show it only for custom,
      // user-added params, where changing the type is meaningful.
      if (!param.label) {
        const typeSelect = document.createElement('select');
        ['Number', 'String', 'Boolean', 'Date', 'Money'].forEach(t => {
          const opt = document.createElement('option');
          opt.value = t; opt.textContent = t;
          typeSelect.appendChild(opt);
        });
        typeSelect.value = param.type ?? 'Number';
        typeSelect.addEventListener('change', () => {
          param.type = typeSelect.value;
          this._renderParamsList(scenario);
        });
        row.appendChild(typeSelect);
      }

      // ── Delete button (custom params only) ────────────────────────────────
      // Predefined (labeled) params are owned by the schema and regenerate on
      // Rebuild, so deleting them is meaningless — only custom, user-added params
      // get a delete button. This also lets the value field span the full row.
      if (!param.label) {
        const delBtn = document.createElement('button');
        delBtn.className   = 'btn btn-warn btn-sm';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', () => {
          scenario.params.splice(i, 1);
          this._renderParamsList(scenario);
        });
        row.appendChild(delBtn);
      }

      return row;
  }

  /**
   * Turn a node field name (e.g. `balance`, `monthlyWage`) into a
   * human-readable label. A small overrides map handles fields whose plain
   * camelCase split is misleading; everything else falls back to camelCase splitting.
   * @private
   */
  _humanizeField(field) {
    if (!field) return '';
    const OVERRIDES = {
      minimumBalance: 'Min Balance',
      balance:        'Balance',
    };
    if (OVERRIDES[field]) return OVERRIDES[field];
    return field
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^./, c => c.toUpperCase());
  }

  downloadJson(data) {
    this.downloadFile('fin-sim-scenarios.json', JSON.stringify(data, null, 2), 'application/json');
  }

  /** Trigger a browser download of arbitrary text content. */
  downloadFile(filename, text, mime = 'text/plain') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  readUploadedJson(file) {
    return this.readUploadedText(file).then(JSON.parse);
  }

  /** Read an uploaded file as text. */
  readUploadedText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  /** Surface a CSV import summary ({ applied, skipped, errors } or { error }). */
  reportCsvImport(result) {
    if (!result) return;
    if (result.error) { alert('CSV import failed: ' + result.error); return; }
    const lines = [`Applied ${result.applied} parameter${result.applied === 1 ? '' : 's'}.`];
    if (result.skipped?.length) {
      lines.push(`Skipped ${result.skipped.length} unknown key${result.skipped.length === 1 ? '' : 's'}: ${result.skipped.join(', ')}`);
    }
    if (result.errors?.length) {
      lines.push(`${result.errors.length} error${result.errors.length === 1 ? '' : 's'}:`, ...result.errors);
    }
    lines.push('', 'Click Rebuild Simulation to apply.');
    alert(lines.join('\n'));
  }

}

// ─── ShockList editor ─────────────────────────────────────────────────────────

/**
 * Build a self-contained DOM editor for a ShockList parameter.
 *
 * Each entry in `param.value` (an array) is rendered as a row with:
 *   - a preset <select> populated from `param.options`
 *   - a date <input type="date"> for startDate
 *   - a remove button
 *
 * An "Add Shock" button appends a blank entry `{ preset: 'none', startDate: '' }`.
 * Mutations are written directly onto the param.value array in-place so the
 * scenario picks them up on the next rebuild.
 *
 * @param {object} param  The param descriptor ({ value, options, ... })
 * @returns {HTMLElement}
 */
function _buildShockListEditor(param) {
  const options = Array.isArray(param.options) ? param.options : [];

  const container = document.createElement('div');
  container.className = 'shock-list-editor';

  const render = () => {
    container.innerHTML = '';
    const shocks = Array.isArray(param.value) ? param.value : [];

    shocks.forEach((shock, idx) => {
      const row = document.createElement('div');
      row.className = 'shock-list-row';

      // Preset dropdown
      const presetSel = document.createElement('select');
      presetSel.className = 'shock-preset-select';
      options.forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        presetSel.appendChild(opt);
      });
      presetSel.value = shock.preset ?? 'none';
      presetSel.addEventListener('change', () => { shock.preset = presetSel.value; });
      row.appendChild(presetSel);

      // Start date
      const dateInput = document.createElement('input');
      dateInput.type = 'date';
      dateInput.className = 'shock-date-input';
      const rawDate = shock.startDate;
      dateInput.value = rawDate
        ? (rawDate instanceof Date ? rawDate.toISOString() : String(rawDate)).slice(0, 10)
        : '';
      dateInput.addEventListener('change', () => { shock.startDate = dateInput.value; });
      row.appendChild(dateInput);

      // Remove button
      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn btn-warn btn-sm';
      rmBtn.textContent = '✕';
      rmBtn.addEventListener('click', () => {
        shocks.splice(idx, 1);
        param.value = shocks;
        render();
      });
      row.appendChild(rmBtn);

      container.appendChild(row);
    });

    // Add button
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-sm shock-add-btn';
    addBtn.textContent = '+ Add Shock';
    addBtn.addEventListener('click', () => {
      if (!Array.isArray(param.value)) param.value = [];
      param.value.push({ preset: 'none', startDate: '' });
      render();
    });
    container.appendChild(addBtn);
  };

  render();
  return container;
}

// ─── AgeBandList editor ───────────────────────────────────────────────────────

/**
 * Build a self-contained DOM editor for an AgeBandList parameter (design/33).
 *
 * Each entry in `param.value` is a band `{ startAge, multiplier, annualRealDrift }`
 * rendered as a row of three number inputs plus a remove button. An "Add Band"
 * button appends a blank band. Bands are kept sorted by `startAge` on every edit
 * so the runtime factor function (which assumes ascending order) stays correct.
 *
 * The incoming value is deep-cloned up front so we never mutate the shared
 * DEFAULT_AGE_BANDS constant referenced by the schema default.
 *
 * @param {object} param  The param descriptor ({ value, ... })
 * @returns {HTMLElement}
 */
function _buildAgeBandListEditor(param) {
  // Clone so in-place edits don't corrupt the module-level default table.
  param.value = (Array.isArray(param.value) ? param.value : []).map(b => ({ ...b }));

  const container = document.createElement('div');
  container.className = 'age-band-list-editor';

  const COLUMNS = [
    { field: 'startAge',        label: 'Start Age', step: '1'    },
    { field: 'multiplier',      label: 'Multiplier', step: '0.01' },
    { field: 'annualRealDrift', label: 'Drift/yr',  step: '0.001' },
  ];

  const render = () => {
    container.innerHTML = '';
    const bands = param.value;

    // Column header
    const header = document.createElement('div');
    header.className = 'age-band-row age-band-header';
    COLUMNS.forEach(({ label }) => {
      const h = document.createElement('span');
      h.className = 'age-band-col-label';
      h.textContent = label;
      header.appendChild(h);
    });
    header.appendChild(document.createElement('span')); // spacer over remove button
    container.appendChild(header);

    bands.forEach((band, idx) => {
      const row = document.createElement('div');
      row.className = 'age-band-row';

      COLUMNS.forEach(({ field, step }) => {
        const input = document.createElement('input');
        input.type = 'number';
        input.step = step;
        input.className = 'age-band-input';
        input.value = band[field] ?? '';
        input.addEventListener('change', () => {
          const raw = input.value;
          band[field] = raw.trim() === '' ? 0 : parseFloat(raw);
          if (field === 'startAge') {
            // Re-sort and re-render so the ascending-order invariant holds.
            param.value.sort((a, b) => (a.startAge ?? 0) - (b.startAge ?? 0));
            render();
          }
        });
        row.appendChild(input);
      });

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn btn-warn age-band-remove';
      rmBtn.textContent = '✕';
      rmBtn.title = 'Remove band';
      rmBtn.addEventListener('click', () => {
        bands.splice(idx, 1);
        render();
      });
      row.appendChild(rmBtn);

      container.appendChild(row);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-sm age-band-add-btn';
    addBtn.textContent = '+ Add Band';
    addBtn.addEventListener('click', () => {
      const lastAge = param.value.length ? (param.value[param.value.length - 1].startAge ?? 0) : 0;
      param.value.push({ startAge: lastAge + 5, multiplier: 1.0, annualRealDrift: 0 });
      render();
    });
    container.appendChild(addBtn);
  };

  render();
  return container;
}

// ─── ExpenseBandList editor (EXPLICIT_BANDS spending, design 38 §6.1) ─────────

/**
 * Build a self-contained DOM editor for an ExpenseBandList parameter
 * (`spendingExpenseBands`). Each band is `{ startAge, monthlyAmount }` (base-year
 * currency), rendered as a two-column row (Start Age, Monthly Amount) plus a
 * remove button, with an "Add Band" button. Mirrors the AgeBandList editor but
 * with the two fields this strategy uses — so it is no longer a raw text input
 * showing "[object Object]".
 */
function _buildExpenseBandListEditor(param) {
  param.value = (Array.isArray(param.value) ? param.value : []).map(b => ({ ...b }));

  const container = document.createElement('div');
  container.className = 'age-band-list-editor';   // reuse the shared band-editor styles

  const COLUMNS = [
    { field: 'startAge',      label: 'Start Age',     step: '1'  },
    { field: 'monthlyAmount', label: 'Monthly Amount', step: '100' },
  ];
  const GRID = '1fr 1fr 26px';   // two fields + remove (overrides the 3-col default)

  const render = () => {
    container.innerHTML = '';
    const bands = param.value;

    const header = document.createElement('div');
    header.className = 'age-band-row age-band-header';
    header.style.gridTemplateColumns = GRID;
    COLUMNS.forEach(({ label }) => {
      const h = document.createElement('span');
      h.className = 'age-band-col-label';
      h.textContent = label;
      header.appendChild(h);
    });
    header.appendChild(document.createElement('span')); // spacer over remove button
    container.appendChild(header);

    bands.forEach((band, idx) => {
      const row = document.createElement('div');
      row.className = 'age-band-row';
      row.style.gridTemplateColumns = GRID;

      COLUMNS.forEach(({ field, step }) => {
        const input = document.createElement('input');
        input.type = 'number';
        input.step = step;
        input.min = '0';
        input.className = 'age-band-input';
        input.value = band[field] ?? '';
        input.addEventListener('change', () => {
          const raw = input.value;
          band[field] = raw.trim() === '' ? 0 : parseFloat(raw);
          if (field === 'startAge') {
            param.value.sort((a, b) => (a.startAge ?? 0) - (b.startAge ?? 0));
            render();
          }
        });
        row.appendChild(input);
      });

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn btn-warn age-band-remove';
      rmBtn.textContent = '✕';
      rmBtn.title = 'Remove band';
      rmBtn.addEventListener('click', () => { bands.splice(idx, 1); render(); });
      row.appendChild(rmBtn);

      container.appendChild(row);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-sm age-band-add-btn';
    addBtn.textContent = '+ Add Band';
    addBtn.addEventListener('click', () => {
      const last = param.value[param.value.length - 1];
      param.value.push({
        startAge:      (last?.startAge ?? 60) + 10,
        monthlyAmount: last?.monthlyAmount ?? 6000,
      });
      render();
    });
    container.appendChild(addBtn);
  };

  render();
  return container;
}

// ─── RothScheduleList editor (per-year Roth conversion schedule, design 39) ───

/**
 * Build a self-contained DOM editor for a RothScheduleList parameter
 * (`rothConversionSchedule`). Each entry is `{ year, incomeTarget }` — the
 * income-fill ceiling for that year in real base-year (2025) USD, the per-year
 * control form the MPC cockpit actuates. Rendered as a two-column row (Year,
 * Income Target) plus a remove button, with an "Add Year" button. Mirrors the
 * ExpenseBandList editor (entries kept sorted, here by `year`) so it is no longer
 * a raw text input showing "[object Object],[object Object],…".
 *
 * Legacy `{ year, bracketCeiling }` entries (statutory rate) are still accepted
 * by the toolset; the editor surfaces the `incomeTarget` field, so converting a
 * legacy entry is a matter of re-entering its target here.
 *
 * The incoming value is cloned up front so in-place edits never mutate a shared
 * schema default; a non-array value (e.g. a stale string from the old free-text
 * input) is coerced to an empty list.
 */
function _buildRothScheduleListEditor(param) {
  param.value = (Array.isArray(param.value) ? param.value : []).map(e => ({ ...e }));

  const container = document.createElement('div');
  container.className = 'age-band-list-editor';   // reuse the shared band-editor styles

  const COLUMNS = [
    { field: 'year',         label: 'Year',                step: '1',    min: '1900' },
    { field: 'incomeTarget', label: 'Income Target (real $)', step: '1000', min: '0' },
  ];
  const GRID = '1fr 1fr 26px';   // two fields + remove

  const render = () => {
    container.innerHTML = '';
    const entries = param.value;

    const header = document.createElement('div');
    header.className = 'age-band-row age-band-header';
    header.style.gridTemplateColumns = GRID;
    COLUMNS.forEach(({ label }) => {
      const h = document.createElement('span');
      h.className = 'age-band-col-label';
      h.textContent = label;
      header.appendChild(h);
    });
    header.appendChild(document.createElement('span')); // spacer over remove button
    container.appendChild(header);

    entries.forEach((entry, idx) => {
      const row = document.createElement('div');
      row.className = 'age-band-row';
      row.style.gridTemplateColumns = GRID;

      COLUMNS.forEach(({ field, step, min }) => {
        const input = document.createElement('input');
        input.type = 'number';
        input.step = step;
        input.min = min;
        input.className = 'age-band-input';
        input.value = entry[field] ?? '';
        input.addEventListener('change', () => {
          const raw = input.value;
          entry[field] = raw.trim() === '' ? 0 : parseFloat(raw);
          if (field === 'year') {
            param.value.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
            render();
          }
        });
        row.appendChild(input);
      });

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn btn-warn age-band-remove';
      rmBtn.textContent = '✕';
      rmBtn.title = 'Remove year';
      rmBtn.addEventListener('click', () => { entries.splice(idx, 1); render(); });
      row.appendChild(rmBtn);

      container.appendChild(row);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-sm age-band-add-btn';
    addBtn.textContent = '+ Add Year';
    addBtn.addEventListener('click', () => {
      const last = param.value[param.value.length - 1];
      param.value.push({
        year:         (last?.year ?? new Date().getUTCFullYear()) + 1,
        incomeTarget: 0,
      });
      param.value.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
      render();
    });
    container.appendChild(addBtn);
  };

  render();
  return container;
}

// ─── PrimeScheduleList editor (per-year central-bank Prime path, design 56) ───

/**
 * Build a self-contained DOM editor for a PrimeScheduleList parameter
 * (`primeSchedule`, design 56 §5 Phase 2b). Each entry is `{ year, PRIME_US, PRIME_AU }`
 * — the ABSOLUTE central-bank policy rates taking effect that year and holding until the
 * next row (a step path). Rendered as a three-column row (Year, PRIME_US, PRIME_AU) plus a
 * remove button, with an "Add Year" button; mirrors the RothScheduleList editor (entries
 * kept sorted by `year`) so it is not a raw text input showing "[object Object],…".
 *
 * An empty rate cell is stored as `null` — the toolset compiler reads `!= null`, so a
 * blank means "leave that country's Prime at its seed for this step" rather than 0% (ZIRP).
 * The incoming value is cloned up front so in-place edits never mutate a shared schema
 * default; a non-array value is coerced to an empty list.
 */
function _buildPrimeScheduleListEditor(param) {
  param.value = (Array.isArray(param.value) ? param.value : []).map(e => ({ ...e }));

  const container = document.createElement('div');
  container.className = 'age-band-list-editor';   // reuse the shared band-editor styles

  const COLUMNS = [
    { field: 'year',     label: 'Year',     step: '1',      min: '1900' },
    { field: 'PRIME_US', label: 'PRIME_US', step: '0.0025', min: '0' },
    { field: 'PRIME_AU', label: 'PRIME_AU', step: '0.0025', min: '0' },
  ];
  const GRID = '1fr 1fr 1fr 26px';   // three fields + remove

  const render = () => {
    container.innerHTML = '';
    const entries = param.value;

    const header = document.createElement('div');
    header.className = 'age-band-row age-band-header';
    header.style.gridTemplateColumns = GRID;
    COLUMNS.forEach(({ label }) => {
      const h = document.createElement('span');
      h.className = 'age-band-col-label';
      h.textContent = label;
      header.appendChild(h);
    });
    header.appendChild(document.createElement('span')); // spacer over remove button
    container.appendChild(header);

    entries.forEach((entry, idx) => {
      const row = document.createElement('div');
      row.className = 'age-band-row';
      row.style.gridTemplateColumns = GRID;

      COLUMNS.forEach(({ field, step, min }) => {
        const input = document.createElement('input');
        input.type = 'number';
        input.step = step;
        input.min = min;
        input.className = 'age-band-input';
        input.value = entry[field] ?? '';
        input.addEventListener('change', () => {
          const raw = input.value;
          // Year coerces to a number; a blank rate cell stays null (no move that country).
          entry[field] = raw.trim() === ''
            ? (field === 'year' ? 0 : null)
            : parseFloat(raw);
          if (field === 'year') {
            param.value.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
            render();
          }
        });
        row.appendChild(input);
      });

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn btn-warn age-band-remove';
      rmBtn.textContent = '✕';
      rmBtn.title = 'Remove year';
      rmBtn.addEventListener('click', () => { entries.splice(idx, 1); render(); });
      row.appendChild(rmBtn);

      container.appendChild(row);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-sm age-band-add-btn';
    addBtn.textContent = '+ Add Year';
    addBtn.addEventListener('click', () => {
      const last = param.value[param.value.length - 1];
      param.value.push({
        year:     (last?.year ?? new Date().getUTCFullYear()) + 1,
        PRIME_US: 0.045,
        PRIME_AU: 0.0435,
      });
      param.value.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
      render();
    });
    container.appendChild(addBtn);
  };

  render();
  return container;
}

// ─── EarlyWithdrawalScheduleList editor (per-year per-class decant, design 45) ─

/**
 * Build a self-contained DOM editor for an EarlyWithdrawalScheduleList parameter
 * (`earlyWithdrawalSchedule`). Each entry is
 * `{ year, taxDeferredAmount, rothAmount, destinationKey? }` — the per-class GROSS
 * draw for that year in real base-year (2025) USD, the per-year control form the
 * MPC cockpit's EARLY_WITHDRAWAL lever actuates. Rendered as a three-column row
 * (Year, Tax-Deferred, Roth) plus a remove button, with an "Add Year" button.
 * Mirrors the RothScheduleList editor (entries kept sorted by `year`) so it is no
 * longer a raw text input showing "[object Object],[object Object],…".
 *
 * `destinationKey` (an optional brokerage-account override; default the owner's US
 * brokerage) is not surfaced as a column — it is preserved through the up-front
 * clone for any entry that already carries one, and left unset on new entries. It may
 * be a state key or a per-owner `{ ownerId: stateKey }` map (design 84 G6), so the
 * clone below has to reach INTO it: a shallow `{ ...e }` would hand every clone the
 * same map object and an edit here would reach back into the active scenario, which is
 * the shallow-copy trap design 39 §13 already paid for once.
 *
 * The incoming value is cloned up front so in-place edits never mutate a shared
 * schema default; a non-array value (e.g. a stale string from the old free-text
 * input) is coerced to an empty list.
 */
function _buildEarlyWithdrawalScheduleListEditor(param) {
  param.value = (Array.isArray(param.value) ? param.value : []).map(e => ({
    ...e,
    ...(e?.destinationKey != null && typeof e.destinationKey === 'object'
      ? { destinationKey: { ...e.destinationKey } }
      : {}),
  }));

  const container = document.createElement('div');
  container.className = 'age-band-list-editor';   // reuse the shared band-editor styles

  const COLUMNS = [
    { field: 'year',              label: 'Year',                  step: '1',    min: '1900' },
    { field: 'taxDeferredAmount', label: 'Tax-Deferred (real $)', step: '1000', min: '0' },
    { field: 'rothAmount',        label: 'Roth (real $)',         step: '1000', min: '0' },
  ];
  const GRID = '1fr 1fr 1fr 26px';   // three fields + remove

  const render = () => {
    container.innerHTML = '';
    const entries = param.value;

    const header = document.createElement('div');
    header.className = 'age-band-row age-band-header';
    header.style.gridTemplateColumns = GRID;
    COLUMNS.forEach(({ label }) => {
      const h = document.createElement('span');
      h.className = 'age-band-col-label';
      h.textContent = label;
      header.appendChild(h);
    });
    header.appendChild(document.createElement('span')); // spacer over remove button
    container.appendChild(header);

    entries.forEach((entry, idx) => {
      const row = document.createElement('div');
      row.className = 'age-band-row';
      row.style.gridTemplateColumns = GRID;

      COLUMNS.forEach(({ field, step, min }) => {
        const input = document.createElement('input');
        input.type = 'number';
        input.step = step;
        input.min = min;
        input.className = 'age-band-input';
        input.value = entry[field] ?? '';
        input.addEventListener('change', () => {
          const raw = input.value;
          entry[field] = raw.trim() === '' ? 0 : parseFloat(raw);
          if (field === 'year') {
            param.value.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
            render();
          }
        });
        row.appendChild(input);
      });

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn btn-warn age-band-remove';
      rmBtn.textContent = '✕';
      rmBtn.title = 'Remove year';
      rmBtn.addEventListener('click', () => { entries.splice(idx, 1); render(); });
      row.appendChild(rmBtn);

      container.appendChild(row);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-sm age-band-add-btn';
    addBtn.textContent = '+ Add Year';
    addBtn.addEventListener('click', () => {
      const last = param.value[param.value.length - 1];
      param.value.push({
        year:              (last?.year ?? new Date().getUTCFullYear()) + 1,
        taxDeferredAmount: 0,
        rothAmount:        0,
      });
      param.value.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
      render();
    });
    container.appendChild(addBtn);
  };

  render();
  return container;
}

// ─── HealthcareEventList editor ───────────────────────────────────────────────

/**
 * Build a self-contained DOM editor for a HealthcareEventList parameter.
 *
 * Each entry in `param.value` is a one-off healthcare event
 * `{ date, amount, category, personId }` rendered as a row of inputs (date,
 * amount, category, person id) plus a remove button. An "Add Event" button
 * appends a blank event. Mutations are written in-place onto the cloned
 * `param.value` array so the scenario picks them up on the next rebuild.
 *
 * The incoming value is deep-cloned up front so in-place edits never mutate the
 * shared schema default (an empty array, but cloned for consistency with the
 * AgeBandList editor). A non-array value (e.g. a stale string from the old
 * free-text input) is coerced to an empty list.
 *
 * The Person column is a <select> populated from `personsProvider` (each event's
 * personId picks whose residency drives the debited savings account). It is
 * optional — a blank "— Any —" option leaves personId null so the handler falls
 * back to the first person.
 *
 * @param {object} param  The param descriptor ({ value, ... })
 * @param {function(): Array<{id:string,name:string}>} [personsProvider]
 * @returns {HTMLElement}
 */
function _buildHealthcareEventListEditor(param, personsProvider) {
  param.value = (Array.isArray(param.value) ? param.value : []).map(e => ({ ...e }));

  const container = document.createElement('div');
  container.className = 'healthcare-event-list-editor';

  const persons = (typeof personsProvider === 'function' ? personsProvider() : null) ?? [];

  const COLUMNS = [
    { field: 'date',     label: 'Date',     type: 'date'   },
    { field: 'amount',   label: 'Amount',   type: 'number', step: '100' },
    { field: 'category', label: 'Category', type: 'text',   placeholder: 'e.g. surgery' },
    { field: 'personId', label: 'Person',   type: 'person' },
  ];

  const render = () => {
    container.innerHTML = '';
    const events = param.value;

    // Column header
    const header = document.createElement('div');
    header.className = 'healthcare-event-row healthcare-event-header';
    COLUMNS.forEach(({ label }) => {
      const h = document.createElement('span');
      h.className = 'healthcare-event-col-label';
      h.textContent = label;
      header.appendChild(h);
    });
    header.appendChild(document.createElement('span')); // spacer over remove button
    container.appendChild(header);

    events.forEach((evt, idx) => {
      const row = document.createElement('div');
      row.className = 'healthcare-event-row';

      COLUMNS.forEach(({ field, type, step, placeholder }) => {
        if (type === 'person') {
          const sel = document.createElement('select');
          sel.className = 'healthcare-event-input';
          const anyOpt = document.createElement('option');
          anyOpt.value = '';
          anyOpt.textContent = '— Any —';
          sel.appendChild(anyOpt);
          persons.forEach(({ id, name }) => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = name ?? id;
            sel.appendChild(opt);
          });
          sel.value = evt.personId ?? '';
          sel.addEventListener('change', () => {
            evt.personId = sel.value === '' ? null : sel.value;
          });
          row.appendChild(sel);
          return;
        }

        const input = document.createElement('input');
        input.type = type;
        if (step) input.step = step;
        if (placeholder) input.placeholder = placeholder;
        input.className = 'healthcare-event-input';
        const raw = evt[field];
        input.value = field === 'date'
          ? (raw ? (raw instanceof Date ? raw.toISOString() : String(raw)).slice(0, 10) : '')
          : (raw ?? '');
        input.addEventListener('change', () => {
          const v = input.value;
          if (field === 'amount') {
            evt.amount = v.trim() === '' ? null : parseFloat(v);
          } else {
            evt[field] = v.trim() === '' ? '' : v;
          }
        });
        row.appendChild(input);
      });

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn btn-warn healthcare-event-remove';
      rmBtn.textContent = '✕';
      rmBtn.title = 'Remove event';
      rmBtn.addEventListener('click', () => {
        events.splice(idx, 1);
        render();
      });
      row.appendChild(rmBtn);

      container.appendChild(row);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-sm healthcare-event-add-btn';
    addBtn.textContent = '+ Add Event';
    addBtn.addEventListener('click', () => {
      param.value.push({ date: '', amount: null, category: '', personId: null });
      render();
    });
    container.appendChild(addBtn);
  };

  render();
  return container;
}

// ─── DrawdownStrategyList editor ──────────────────────────────────────────────

/**
 * Build a self-contained DOM editor for a DrawdownStrategyList parameter.
 *
 * `param.value` is an array of user-authored strategies, each
 * `{ name, roles: { <role>: <order> } }`. `param.options` is the list of
 * drawdown-eligible roles to render a rank input for. Each strategy renders as a
 * card: a name input + one numeric "order" input per role + a remove button. An
 * "Add Strategy" button appends a blank strategy.
 *
 * The named strategies become selectable as the active Drawdown Strategy and as
 * Optimize sweep values, so `onChange` (a list re-render) fires on structural
 * edits — add / remove / rename — to refresh the sibling dropdown. Per-role rank
 * edits mutate in place without a re-render so the input keeps focus.
 *
 * The incoming value is deep-cloned up front so in-place edits never corrupt the
 * shared schema default (`[]`) or a round-tripped reference.
 *
 * @param {object}   param         The param descriptor ({ value, options, ... })
 * @param {function} onChange      Called after structural edits to refresh siblings
 * @param {Array}    [siblingParams] The scenario's full params array — used to
 *   follow a rename through to any Enum that selected this strategy by name
 *   (e.g. the Drawdown Strategy dropdown), so the selection doesn't dangle on
 *   the old name and silently fall back to authored defaults.
 * @returns {HTMLElement}
 */
function _buildDrawdownStrategyListEditor(param, onChange, siblingParams) {
  const roles = Array.isArray(param.options) ? param.options : [];
  // Clone so edits don't mutate the shared module-level default / saved value.
  param.value = (Array.isArray(param.value) ? param.value : [])
    .map(s => ({ name: s?.name ?? '', roles: { ...(s?.roles ?? {}) } }));

  const container = document.createElement('div');
  container.className = 'drawdown-strategy-list-editor';

  const render = () => {
    container.innerHTML = '';
    const strategies = param.value;

    strategies.forEach((strategy, idx) => {
      const card = document.createElement('div');
      card.className = 'drawdown-strategy-card';

      // Header: name input + remove button
      const head = document.createElement('div');
      head.className = 'drawdown-strategy-head';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'drawdown-strategy-name';
      nameInput.placeholder = 'Strategy name';
      nameInput.value = strategy.name ?? '';
      // Last committed name, so a rename can be propagated to any sibling Enum
      // that selected this strategy. Tracked across multiple blurs without a
      // re-render (the input handler mutates strategy.name live on each keystroke).
      let committedName = strategy.name ?? '';
      nameInput.addEventListener('input', () => { strategy.name = nameInput.value; });
      // On blur: follow the rename through to any sibling selection, then refresh
      // the sibling dropdown. Done on blur (not per-keystroke) so typing keeps focus.
      nameInput.addEventListener('change', () => {
        const newName = nameInput.value;
        if (committedName && newName && committedName !== newName && Array.isArray(siblingParams)) {
          for (const sp of siblingParams) {
            if (sp?.dynamicOptionsFrom === param.name && sp.value === committedName) {
              sp.value = newName;
            }
          }
        }
        committedName = newName;
        onChange?.();
      });
      head.appendChild(nameInput);

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn btn-warn btn-sm drawdown-strategy-remove';
      rmBtn.textContent = '✕';
      rmBtn.addEventListener('click', () => {
        strategies.splice(idx, 1);
        onChange?.();
      });
      head.appendChild(rmBtn);
      card.appendChild(head);

      // One rank input per drawdown-eligible role. Empty = excluded (stays null).
      roles.forEach(role => {
        const row = document.createElement('div');
        row.className = 'drawdown-strategy-role-row';

        const label = document.createElement('span');
        label.className = 'drawdown-strategy-role-label';
        label.textContent = role;
        row.appendChild(label);

        const rank = document.createElement('input');
        rank.type = 'number';
        rank.min = '1';
        rank.step = '1';
        rank.className = 'drawdown-strategy-rank';
        rank.placeholder = '—';
        const cur = strategy.roles?.[role];
        rank.value = (cur == null ? '' : String(cur));
        rank.addEventListener('input', () => {
          const raw = rank.value.trim();
          if (raw === '') delete strategy.roles[role];
          else strategy.roles[role] = parseInt(raw, 10);
        });
        row.appendChild(rank);

        card.appendChild(row);
      });

      container.appendChild(card);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-sm drawdown-strategy-add-btn';
    addBtn.textContent = '+ Add Strategy';
    addBtn.addEventListener('click', () => {
      param.value.push({ name: 'New Strategy', roles: {} });
      onChange?.();
    });
    container.appendChild(addBtn);
  };

  render();
  return container;
}

// ─── EnumMulti editor ─────────────────────────────────────────────────────────

/**
 * Build a checkbox-group editor for an EnumMulti parameter.
 *
 * param.value is an array of selected option strings (e.g. ['FIXED', 'REGIME_AWARE']).
 * param.options is a string array of all available choices.
 * Mutations write directly onto param.value so the scenario picks them up
 * on the next rebuild.
 *
 * @param {object} param  The param descriptor ({ value, options, ... })
 * @returns {HTMLElement}
 */
function _buildEnumMultiEditor(param, onChange) {
  const container = document.createElement('div');
  container.className = 'enum-multi-editor';

  const selected = new Set(Array.isArray(param.value) ? param.value : []);
  const options  = Array.isArray(param.options) ? param.options : [];

  options.forEach(opt => {
    const label = document.createElement('label');
    label.className = 'enum-multi-option';

    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.value   = opt;
    cb.checked = selected.has(opt);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(opt); else selected.delete(opt);
      param.value = [...selected];
      onChange?.();
    });

    label.appendChild(cb);
    label.appendChild(document.createTextNode(opt));
    container.appendChild(label);
  });

  return container;
}
