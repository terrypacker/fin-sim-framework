/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent } from '../components/base-component.js';
import { DecisionGraph, DecisionPoint } from '../../finance/decision-graph/decision-graph-models.js';

const OBJECTIVES = [
  { value: 'finalBalance',       label: 'Final Balance (P50)' },
  { value: 'successRate',        label: 'Success Rate'         },
  { value: 'cumulativeDeficit',  label: 'Min Deficit'          },
];

/**
 * DgConfigPanel — left pane of the Decision Graph tab.
 *
 * Shows the list of saved analyses and an inline form for creating/editing one.
 * When a paramSchema is supplied (from INTL_RETIREMENT_PARAM_SCHEMA), decision
 * points are configured via a grouped param dropdown instead of raw text inputs,
 * and option inputs are type-aware (Number / Boolean / Date / custom).
 *
 * Callbacks:
 *   onRun(dg)  — fired when the user clicks Run on a saved analysis.
 *   onSave(dg) — fired after saving (to refresh the results panel label).
 *
 * @param {HTMLElement}  containerEl
 * @param {object}       dgRegistry
 * @param {object}       scenarioRegistry
 * @param {Array}        [paramSchema=[]]     — entries from INTL_RETIREMENT_PARAM_SCHEMA
 * @param {object|null}  [resultStorage=null] — DecisionGraphResultStorage (for persist indicator)
 */
export class DgConfigPanel extends BaseComponent {
  constructor(containerEl, dgRegistry, scenarioRegistry, paramSchema = [], resultStorage = null) {
    super();
    this._container        = containerEl;
    this._dgRegistry       = dgRegistry;
    this._scenarioRegistry = scenarioRegistry;
    this._paramSchema      = paramSchema;
    this._resultStorage    = resultStorage;
    this._editingDg        = null;
    this._formVisible      = false;
    this._statusEl         = null;
    this._listEl           = null;
    this._formEl           = null;

    /** @type {Function|null} */
    this.onRun        = null;
    /** @type {Function|null} */
    this.onSave       = null;
    /** @type {Function|null} */
    this.onLoadResult = null;

    this._render();
  }

  setStatus(msg) {
    if (this._statusEl) this._statusEl.textContent = msg;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _render() {
    if (!this._container) return;
    this._container.innerHTML = '';

    const root = document.createElement('div');
    root.className = 'dg-root';

    const listSection = document.createElement('div');

    const listHdr = document.createElement('div');
    listHdr.className = 'node-header';
    listHdr.textContent = 'Decision Graph';
    listSection.appendChild(listHdr);

    this._listEl = document.createElement('div');
    this._listEl.className = 'dg-analysis-list';
    listSection.appendChild(this._listEl);

    const newBtn = document.createElement('button');
    newBtn.className = 'btn btn-primary dg-new-btn';
    newBtn.textContent = '+ New Analysis';
    this.listen(newBtn, 'click', () => this._showForm(null));
    listSection.appendChild(newBtn);

    this._statusEl = document.createElement('div');
    this._statusEl.className = 'dg-status-line';

    this._formEl = document.createElement('div');
    this._formEl.className = 'dg-form-section';
    this._formEl.style.display = 'none';

    root.append(listSection, this._formEl, this._statusEl);
    this._container.appendChild(root);

    this._refreshList();
  }

  _refreshList() {
    if (!this._listEl) return;
    this._listEl.innerHTML = '';
    const analyses = this._dgRegistry?.getAll() ?? [];

    if (analyses.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dg-empty-msg';
      empty.textContent = 'No analyses yet.';
      this._listEl.appendChild(empty);
      return;
    }

    for (const dg of analyses) {
      const item = document.createElement('div');
      item.className = 'dg-analysis-item';

      const nameEl = document.createElement('span');
      nameEl.className = 'dg-analysis-name';
      nameEl.textContent = dg.name ?? dg.id;
      const leafCount = (dg.decisionPoints ?? []).reduce((p, dp) => p * (dp.options?.length ?? 0), 1) || 1;
      nameEl.title = `Leaves: ${leafCount} | Draws/leaf: ${dg.mcDrawsPerLeaf ?? 100}`;

      const leafLabel = document.createElement('span');
      leafLabel.className = 'dg-analysis-meta';
      const n = (dg.decisionPoints ?? []).reduce((p, dp) => p * (dp.options?.length ?? 0), 1) || 1;
      leafLabel.textContent = `${n}L×${dg.mcDrawsPerLeaf ?? 100}`;

      const runBtn = document.createElement('button');
      runBtn.className = 'btn dg-run-btn';
      runBtn.textContent = '▶';
      runBtn.title = 'Run analysis';
      this.listen(runBtn, 'click', () => this._runAnalysis(dg));

      const editBtn = document.createElement('button');
      editBtn.className = 'btn dg-edit-btn';
      editBtn.textContent = '✎';
      editBtn.title = 'Edit';
      this.listen(editBtn, 'click', () => this._showForm(dg));

      const delBtn = document.createElement('button');
      delBtn.className = 'btn dg-delete-btn';
      delBtn.textContent = '✕';
      delBtn.title = 'Delete';
      this.listen(delBtn, 'click', () => this._deleteAnalysis(dg.id));

      item.append(nameEl, leafLabel, runBtn, editBtn, delBtn);

      if (dg.persistLeaves && this._resultStorage?.loadResult(dg.id)) {
        const loadBtn = document.createElement('button');
        loadBtn.className = 'btn dg-load-btn';
        loadBtn.textContent = '📋';
        loadBtn.title = 'Load persisted result';
        this.listen(loadBtn, 'click', () => { if (this.onLoadResult) this.onLoadResult(dg); });
        item.appendChild(loadBtn);
      }
      this._listEl.appendChild(item);
    }
  }

  _showForm(dg) {
    // Build a working copy of decisionPoints with schema metadata attached.
    const dpList = (dg?.decisionPoints ?? []).map(dp => {
      const match = this._paramSchema.find(s => s.key === dp.paramKey);
      return {
        id:        dp.id,
        label:     dp.label,
        paramKey:  dp.paramKey,
        options:   [...(dp.options ?? [])],
        weights:   dp.weights ?? null,
        _schemaKey: match?.key ?? '',
        _type:      match?.type ?? null,
      };
    });
    this._editingDg   = dg ? { ...dg } : null;
    this._formVisible = true;
    this._formEl.style.display = '';
    this._renderForm(dpList);
  }

  _hideForm() {
    this._formVisible = false;
    this._formEl.style.display = 'none';
    this._formEl.innerHTML = '';
  }

  _renderForm(dpList) {
    const dg = this._editingDg;
    this._formEl.innerHTML = '';

    const hdr = document.createElement('div');
    hdr.className = 'dg-form-header node-header';
    hdr.textContent = dg ? 'Edit Analysis' : 'New Analysis';
    this._formEl.appendChild(hdr);

    const form = document.createElement('div');
    form.className = 'dg-form';

    // Name
    const nameField = this._makeField('Name');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'dg-text-input';
    nameInput.value = dg?.name ?? '';
    nameInput.placeholder = 'e.g. SS Age × Retire Date';
    nameField.appendChild(nameInput);
    form.appendChild(nameField);

    // Base scenario
    const baseField = this._makeField('Base Scenario');
    const baseSel = document.createElement('select');
    baseSel.className = 'dg-select';
    const scenarios = this._scenarioRegistry?.getAll() ?? [];
    for (const s of scenarios) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name ?? s.id;
      if (s.id === dg?.baseScenarioId) opt.selected = true;
      baseSel.appendChild(opt);
    }
    baseField.appendChild(baseSel);
    form.appendChild(baseField);

    // MC draws / leaf
    const drawsField = this._makeField('MC Draws / Leaf');
    const drawsInput = document.createElement('input');
    drawsInput.type = 'number';
    drawsInput.className = 'dg-num-input';
    drawsInput.value = String(dg?.mcDrawsPerLeaf ?? 50);
    drawsInput.min = '1';
    drawsInput.max = '10000';
    drawsField.appendChild(drawsInput);
    form.appendChild(drawsField);

    // Objective
    const objField = this._makeField('Objective');
    const objSel = document.createElement('select');
    objSel.className = 'dg-select';
    for (const o of OBJECTIVES) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === (dg?.objective ?? 'finalBalance')) opt.selected = true;
      objSel.appendChild(opt);
    }
    objField.appendChild(objSel);
    form.appendChild(objField);

    // Persist results
    const persistField = this._makeField('Persist results');
    const persistChk = document.createElement('input');
    persistChk.type = 'checkbox';
    persistChk.className = 'dg-persist-chk';
    persistChk.checked = dg?.persistLeaves ?? false;
    persistChk.title = 'Save results to localStorage so they survive page reloads';
    persistField.appendChild(persistChk);
    form.appendChild(persistField);

    // Decision points
    const dpSectionHdr = document.createElement('div');
    dpSectionHdr.className = 'dg-dp-section-header';
    dpSectionHdr.textContent = 'Decision Points';
    form.appendChild(dpSectionHdr);

    const dpListEl = document.createElement('div');
    dpListEl.className = 'dg-dp-list';
    form.appendChild(dpListEl);

    const renderDpList = () => {
      dpListEl.innerHTML = '';
      dpList.forEach((dp, idx) => {
        dpListEl.appendChild(this._buildDpRow(dp, idx, dpList, renderDpList));
      });
    };
    renderDpList();

    const addDpBtn = document.createElement('button');
    addDpBtn.className = 'btn dg-add-dp-btn';
    addDpBtn.textContent = '+ Add Decision Point';
    this.listen(addDpBtn, 'click', () => {
      dpList.push({ id: '', label: '', paramKey: '', options: [{ value: '', label: '' }], weights: null, _schemaKey: '', _type: null });
      renderDpList();
    });
    form.appendChild(addDpBtn);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'dg-form-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Save';
    this.listen(saveBtn, 'click', () => {
      const saved = this._saveForm(dg?.id, nameInput, baseSel, drawsInput, objSel, dpList, persistChk);
      if (saved) this._hideForm();
    });

    const saveRunBtn = document.createElement('button');
    saveRunBtn.className = 'btn';
    saveRunBtn.textContent = '▶ Save & Run';
    this.listen(saveRunBtn, 'click', () => {
      const saved = this._saveForm(dg?.id, nameInput, baseSel, drawsInput, objSel, dpList, persistChk);
      if (saved) {
        this._hideForm();
        this._runAnalysis(saved);
      }
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    this.listen(cancelBtn, 'click', () => this._hideForm());

    actions.append(saveBtn, saveRunBtn, cancelBtn);
    form.appendChild(actions);

    this._formEl.appendChild(form);
  }

  // ── Decision-point row ──────────────────────────────────────────────────────

  _buildDpRow(dp, idx, dpList, refreshFn) {
    const item = document.createElement('div');
    item.className = 'dg-dp-item';

    // ── Header row: remove + param picker ──
    const pickerRow = document.createElement('div');
    pickerRow.className = 'dg-dp-picker-row';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn dg-dp-remove-btn';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove decision point';
    this.listen(removeBtn, 'click', () => { dpList.splice(idx, 1); refreshFn(); });

    const paramSel = this._buildParamSelect(dp._schemaKey ?? '');

    // Schema-info label (shown when a schema param is selected)
    const schemaInfo = document.createElement('span');
    schemaInfo.className = 'dg-dp-schema-info';
    this._updateSchemaInfo(schemaInfo, dp);

    // Custom fields (shown only when no schema param selected)
    const customFields = document.createElement('div');
    customFields.className = 'dg-dp-custom-fields';
    customFields.style.display = dp._schemaKey ? 'none' : '';

    const idInp    = this._smallInput(dp.id ?? '', 'id');
    const labelInp = this._smallInput(dp.label ?? '', 'label');
    const paramInp = this._smallInput(dp.paramKey ?? '', 'paramKey');
    this.listen(idInp,    'input', () => { dp.id = idInp.value; });
    this.listen(labelInp, 'input', () => { dp.label = labelInp.value; });
    this.listen(paramInp, 'input', () => { dp.paramKey = paramInp.value; });
    customFields.append(idInp, labelInp, paramInp);

    // Options section (re-rendered when type changes)
    const optionsSection = document.createElement('div');
    optionsSection.className = 'dg-dp-options-section';
    const renderOptionsSection = () => {
      optionsSection.innerHTML = '';
      this._renderOptionsSection(optionsSection, dp);
    };
    renderOptionsSection();

    // When param picker changes
    this.listen(paramSel, 'change', () => {
      const key = paramSel.value;
      const entry = this._paramSchema.find(s => s.key === key);
      dp._schemaKey = key;
      dp._type = entry?.type ?? null;
      if (entry) {
        dp.id       = entry.key;
        dp.label    = entry.label;
        dp.paramKey = entry.key;
        if (entry.type === 'Boolean') {
          dp.options = [{ value: true, label: 'Yes' }, { value: false, label: 'No' }];
        } else if (!dp.options.length) {
          dp.options = [{ value: '', label: '' }];
        }
        customFields.style.display = 'none';
      } else {
        customFields.style.display = '';
      }
      this._updateSchemaInfo(schemaInfo, dp);
      renderOptionsSection();
    });

    pickerRow.append(removeBtn, paramSel, schemaInfo, customFields);
    item.append(pickerRow, optionsSection);
    return item;
  }

  _buildParamSelect(currentKey) {
    const sel = document.createElement('select');
    sel.className = 'dg-param-select';

    const customOpt = document.createElement('option');
    customOpt.value = '';
    customOpt.textContent = '— Custom param —';
    sel.appendChild(customOpt);

    // Group schema entries by group
    const groups = new Map();
    for (const s of this._paramSchema) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    for (const [groupName, entries] of groups) {
      const og = document.createElement('optgroup');
      og.label = groupName;
      for (const e of entries) {
        const opt = document.createElement('option');
        opt.value = e.key;
        opt.textContent = e.label;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }

    sel.value = currentKey;
    return sel;
  }

  _updateSchemaInfo(el, dp) {
    if (dp._schemaKey) {
      el.textContent = `${dp.label}`;
      el.style.display = '';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
  }

  // ── Options section (type-aware) ────────────────────────────────────────────

  _renderOptionsSection(container, dp) {
    const type   = dp._type;
    const isNum  = type === 'Number';
    const isBool = type === 'Boolean';
    const isDate = type === 'Date';

    const hdr = document.createElement('div');
    hdr.className = 'dg-options-label';
    hdr.textContent = isBool ? 'Options (fixed):'
      : isNum  ? 'Options (numbers):'
      : isDate ? 'Options (dates):'
      : 'Options (value | label):';
    container.appendChild(hdr);

    const listEl = document.createElement('div');
    listEl.className = 'dg-option-list';
    container.appendChild(listEl);

    const renderOptions = () => {
      listEl.innerHTML = '';
      (dp.options ?? []).forEach((opt, oi) => {
        const row = document.createElement('div');
        row.className = 'dg-option-row';

        if (isBool) {
          const span = document.createElement('span');
          span.className = 'dg-option-readonly';
          span.textContent = opt.value === true ? 'Yes (true)' : 'No (false)';
          row.appendChild(span);
        } else if (isNum) {
          const valInp = document.createElement('input');
          valInp.type = 'number';
          valInp.className = 'dg-num-option-input';
          valInp.value = String(opt.value ?? '');
          this.listen(valInp, 'input', () => {
            const n = parseFloat(valInp.value);
            opt.value = isNaN(n) ? valInp.value : n;
            opt.label = String(opt.value);
          });
          const rmBtn = this._rmBtn(() => { dp.options.splice(oi, 1); if (dp.weights) dp.weights.splice(oi, 1); renderOptions(); });
          row.append(valInp, ...this._weightInput(dp, oi), rmBtn);
        } else if (isDate) {
          const valInp = document.createElement('input');
          valInp.type = 'date';
          valInp.className = 'dg-date-input';
          valInp.value = typeof opt.value === 'string' ? opt.value.slice(0, 10) : '';
          this.listen(valInp, 'change', () => {
            opt.value = valInp.value;
            opt.label = valInp.value;
          });
          const rmBtn = this._rmBtn(() => { dp.options.splice(oi, 1); if (dp.weights) dp.weights.splice(oi, 1); renderOptions(); });
          row.append(valInp, ...this._weightInput(dp, oi), rmBtn);
        } else {
          const valInp = this._smallInput(String(opt.value ?? ''), 'value');
          this.listen(valInp, 'input', () => { opt.value = valInp.value; });
          const lInp = this._smallInput(opt.label ?? '', 'label');
          this.listen(lInp, 'input', () => { opt.label = lInp.value; });
          const rmBtn = this._rmBtn(() => { dp.options.splice(oi, 1); if (dp.weights) dp.weights.splice(oi, 1); renderOptions(); });
          row.append(valInp, lInp, ...this._weightInput(dp, oi), rmBtn);
        }

        listEl.appendChild(row);
      });
    };
    renderOptions();

    if (!isBool) {
      const addOptBtn = document.createElement('button');
      addOptBtn.className = 'btn dg-add-option-btn';
      addOptBtn.textContent = '+ option';
      this.listen(addOptBtn, 'click', () => {
        dp.options.push(isNum ? { value: 0, label: '0' } : { value: '', label: '' });
        if (dp.weights !== null) dp.weights.push(0);
        renderOptions();
      });
      container.appendChild(addOptBtn);

      if (isNum) {
        container.appendChild(this._buildRangeBuilder(dp, renderOptions));
      }

      // ── Weights toggle ──
      container.appendChild(this._buildWeightsSection(dp, renderOptions));
    }
  }

  _buildWeightsSection(dp, renderOptions) {
    const wrapper = document.createElement('div');
    wrapper.className = 'dg-weights-section';

    const labelRow = document.createElement('label');
    labelRow.className = 'dg-weights-label';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'dg-weights-chk';
    chk.checked = dp.weights !== null;

    const span = document.createElement('span');
    span.textContent = ' Enable probability weights';

    labelRow.append(chk, span);
    wrapper.appendChild(labelRow);

    this.listen(chk, 'change', () => {
      if (chk.checked) {
        const n = dp.options.length;
        dp.weights = dp.options.map(() => n > 0 ? +(1 / n).toFixed(4) : 0);
      } else {
        dp.weights = null;
      }
      renderOptions();
    });

    return wrapper;
  }

  // ── Range builder ───────────────────────────────────────────────────────────

  _buildRangeBuilder(dp, renderOptions) {
    const wrapper = document.createElement('div');
    wrapper.className = 'dg-range-builder';

    const toggle = document.createElement('button');
    toggle.className = 'btn dg-range-toggle-btn';
    toggle.textContent = '⟳ Range';

    const fields = document.createElement('div');
    fields.className = 'dg-range-fields';
    fields.style.display = 'none';

    const fromInp = this._numInput('from');
    const toInp   = this._numInput('to');
    const stepInp = this._numInput('step');

    const genBtn = document.createElement('button');
    genBtn.className = 'btn dg-range-gen-btn';
    genBtn.textContent = 'Generate';
    this.listen(genBtn, 'click', () => {
      const from = parseFloat(fromInp.value);
      const to   = parseFloat(toInp.value);
      const step = parseFloat(stepInp.value);
      if (isNaN(from) || isNaN(to) || isNaN(step) || step <= 0 || from > to) return;
      dp.options = [];
      for (let v = from; v <= to + step * 1e-9; v += step) {
        const r = Math.round(v * 1e9) / 1e9;
        dp.options.push({ value: r, label: String(r) });
      }
      renderOptions();
      fields.style.display = 'none';
      toggle.textContent = '⟳ Range';
    });

    this.listen(toggle, 'click', () => {
      const open = fields.style.display !== 'none';
      fields.style.display = open ? 'none' : '';
      toggle.textContent = open ? '⟳ Range' : '⟳ Range ▲';
    });

    fields.append(fromInp, toInp, stepInp, genBtn);
    wrapper.append(toggle, fields);
    return wrapper;
  }

  // ── Save ────────────────────────────────────────────────────────────────────

  _saveForm(existingId, nameInput, baseSel, drawsInput, objSel, dpList, persistChk) {
    const name = nameInput.value.trim();
    if (!name) { this.setStatus('Name is required'); return null; }
    const baseScenarioId = baseSel.value;
    if (!baseScenarioId) { this.setStatus('Base scenario is required'); return null; }

    const decisionPoints = dpList.map(dp => new DecisionPoint({
      id:       dp.id,
      label:    dp.label,
      paramKey: dp.paramKey,
      options:  (dp.options ?? []).map(o => ({
        value: typeof o.value === 'boolean' ? o.value
          : isNaN(Number(o.value)) ? o.value : Number(o.value),
        label: String(o.label ?? o.value ?? ''),
      })),
      weights: dp.weights ?? null,
    }));

    const dg = new DecisionGraph({
      id:             existingId,
      name,
      baseScenarioId,
      decisionPoints,
      objective:      objSel.value,
      mcDrawsPerLeaf: Math.max(1, parseInt(drawsInput.value, 10) || 50),
      persistLeaves:  persistChk?.checked ?? false,
    });

    const saved = this._dgRegistry?.save(dg);
    this.setStatus('');
    this._refreshList();
    if (this.onSave) this.onSave(saved ?? dg);
    return saved ?? dg;
  }

  _runAnalysis(dg) {
    if (this.onRun) this.onRun(dg);
  }

  _deleteAnalysis(id) {
    this._dgRegistry?.delete(id);
    this._refreshList();
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────────

  _makeField(labelText) {
    const field = document.createElement('div');
    field.className = 'node-field';
    const lbl = document.createElement('label');
    lbl.textContent = labelText;
    field.appendChild(lbl);
    return field;
  }

  _smallInput(value, placeholder) {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'dg-small-input';
    inp.value = value;
    inp.placeholder = placeholder;
    return inp;
  }

  _numInput(placeholder) {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'dg-small-input';
    inp.placeholder = placeholder;
    return inp;
  }

  _weightInput(dp, oi) {
    if (dp.weights === null) return [];
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'dg-weight-input';
    inp.step = '0.01';
    inp.min = '0';
    inp.value = String(dp.weights[oi] ?? 0);
    inp.placeholder = 'w';
    inp.title = 'Probability weight for this option';
    this.listen(inp, 'input', () => {
      const v = parseFloat(inp.value);
      dp.weights[oi] = isNaN(v) ? 0 : v;
    });
    return [inp];
  }

  _rmBtn(fn) {
    const btn = document.createElement('button');
    btn.className = 'btn dg-dp-remove-btn';
    btn.textContent = '✕';
    this.listen(btn, 'click', fn);
    return btn;
  }
}
