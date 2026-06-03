/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent }              from '../components/base-component.js';
import { DEFAULT_MC_VARIABLE_CONFIGS } from '../../finance/monte-carlo/intl-retirement-mc-config.js';
import { DISTRIBUTION_TYPES }          from '../../simulation-framework/distributions.js';

/**
 * McConfigPanel — left pane of the MC tab.
 *
 * Renders the run controls (iterations, run button, status) and a grouped
 * variable-distribution table into the provided container element.
 *
 * Callbacks:
 *   onRun({ n, variableConfigs }) — fired when the Run button is clicked.
 */
export class McConfigPanel extends BaseComponent {
  constructor(containerEl) {
    super();
    this._container  = containerEl;
    this._rowMap     = new Map(); // paramKey → { enabledCb, typeSel, meanInp, stdDevInp, valueInp, minDateInp, maxDateInp }
    this._iterEl     = null;
    this._runBtn     = null;
    this._statusEl   = null;
    this.onRun       = null;

    this._render();
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  showProgress(msg) {
    if (this._statusEl) this._statusEl.textContent = msg;
    if (this._runBtn)   this._runBtn.disabled = true;
  }

  enableRun() {
    if (this._runBtn) this._runBtn.disabled = false;
  }

  /**
   * Returns the current panel configuration.
   * @returns {{ n: number, variableConfigs: Array }}
   */
  getConfig() {
    const n = Math.max(1, parseInt(this._iterEl?.value ?? '100', 10) || 100);

    const variableConfigs = DEFAULT_MC_VARIABLE_CONFIGS.map(cfg => {
      const row = this._rowMap.get(cfg.paramKey);
      if (!row) return { ...cfg };

      const enabled = row.enabledCb.checked;
      const type    = row.typeSel.value;
      const out     = { ...cfg, enabled, type };

      if (type === DISTRIBUTION_TYPES.CONSTANT) {
        out.value  = parseFloat(row.valueInp.value);
        if (!isFinite(out.value)) out.value = cfg.value ?? cfg.mean ?? 0;
      } else if (type === DISTRIBUTION_TYPES.UNIFORM_DATE) {
        out.min = row.minDateInp.value || cfg.min || '';
        out.max = row.maxDateInp.value || cfg.max || '';
      } else {
        out.mean   = parseFloat(row.meanInp.value);
        out.stdDev = parseFloat(row.stdDevInp.value);
        if (!isFinite(out.mean))   out.mean   = cfg.mean   ?? 0;
        if (!isFinite(out.stdDev)) out.stdDev = cfg.stdDev ?? 0;
      }
      return out;
    });

    return { n, variableConfigs };
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _render() {
    const shell = document.createElement('div');
    shell.innerHTML = `
      <div class="node-header">Monte Carlo</div>
      <div class="mc-controls">
        <div class="node-field">
          <label>Iterations</label>
          <input type="number" class="mc-iters-input" value="100" min="1" max="10000" />
        </div>
        <button class="btn btn-primary" style="width:100%">▶ Run Monte Carlo</button>
      </div>
      <div class="mc-status-el"></div>
      <div class="mc-var-section">
        <div class="mc-var-header">Variable Distributions</div>
      </div>
    `;
    this.append(this._container, shell);

    this._iterEl   = shell.querySelector('input[type="number"]');
    this._runBtn   = shell.querySelector('button');
    this._statusEl = shell.querySelector('.mc-status-el');
    const section  = shell.querySelector('.mc-var-section');

    this.listen(this._runBtn, 'click', () => {
      if (this.onRun) this.onRun(this.getConfig());
    });

    this._buildVarTable(section);
  }

  _buildVarTable(section) {
    const groups = new Map();
    for (const cfg of DEFAULT_MC_VARIABLE_CONFIGS) {
      if (!groups.has(cfg.group)) groups.set(cfg.group, []);
      groups.get(cfg.group).push(cfg);
    }

    for (const [groupName, configs] of groups) {
      const header = document.createElement('div');
      header.className = 'mc-group-header';
      header.textContent = groupName;
      section.appendChild(header);

      for (const cfg of configs) {
        const { el, refs } = this._buildVarRow(cfg);
        section.appendChild(el);
        this._rowMap.set(cfg.paramKey, refs);
      }
    }
  }

  _buildVarRow(cfg) {
    const isConst = cfg.type === DISTRIBUTION_TYPES.CONSTANT;
    const isDate  = cfg.type === DISTRIBUTION_TYPES.UNIFORM_DATE;

    const el = document.createElement('div');
    el.className = 'mc-var-row';

    const labelRow = document.createElement('div');
    labelRow.className = 'mc-var-label-row';
    labelRow.innerHTML = `
      <input type="checkbox" ${cfg.enabled ? 'checked' : ''}
        style="margin:0;cursor:pointer;accent-color:var(--purple);flex-shrink:0" />
      <span class="mc-var-label" title="${cfg.label}">${cfg.label}</span>
    `;
    el.appendChild(labelRow);

    const inputRow = document.createElement('div');
    inputRow.className = 'mc-var-input-row';

    const typeSel = document.createElement('select');
    typeSel.className = 'mc-num-input';
    typeSel.innerHTML = [
      DISTRIBUTION_TYPES.NORMAL,
      DISTRIBUTION_TYPES.LOG_NORMAL,
      DISTRIBUTION_TYPES.UNIFORM,
      DISTRIBUTION_TYPES.UNIFORM_DATE,
      DISTRIBUTION_TYPES.CONSTANT,
    ].map(t => `<option value="${t}" ${cfg.type === t ? 'selected' : ''}>${t}</option>`).join('');

    const meanInp = document.createElement('input');
    meanInp.type  = 'number';
    meanInp.step  = 'any';
    meanInp.placeholder = 'mean';
    meanInp.value = (isConst || isDate) ? '' : String(cfg.mean ?? '');
    meanInp.className = 'mc-num-input';
    meanInp.style.width = '60px';
    meanInp.style.display = (isConst || isDate) ? 'none' : 'block';

    const stdDevInp = document.createElement('input');
    stdDevInp.type  = 'number';
    stdDevInp.step  = 'any';
    stdDevInp.placeholder = 'σ';
    stdDevInp.value = (isConst || isDate) ? '' : String(cfg.stdDev ?? '');
    stdDevInp.className = 'mc-num-input';
    stdDevInp.style.width = '48px';
    stdDevInp.style.display = (isConst || isDate) ? 'none' : 'block';

    const valueInp = document.createElement('input');
    valueInp.type  = 'number';
    valueInp.step  = 'any';
    valueInp.placeholder = 'value';
    valueInp.value = isConst ? String(cfg.value ?? cfg.mean ?? '') : '';
    valueInp.className = 'mc-num-input';
    valueInp.style.width = '72px';
    valueInp.style.display = isConst ? 'block' : 'none';

    const minDateInp = document.createElement('input');
    minDateInp.type = 'date';
    minDateInp.placeholder = 'from';
    minDateInp.value = isDate ? String(cfg.min ?? '') : '';
    minDateInp.className = 'mc-num-input';
    minDateInp.style.width = '110px';
    minDateInp.style.display = isDate ? 'block' : 'none';

    const maxDateInp = document.createElement('input');
    maxDateInp.type = 'date';
    maxDateInp.placeholder = 'to';
    maxDateInp.value = isDate ? String(cfg.max ?? '') : '';
    maxDateInp.className = 'mc-num-input';
    maxDateInp.style.width = '110px';
    maxDateInp.style.display = isDate ? 'block' : 'none';

    inputRow.append(typeSel, meanInp, stdDevInp, valueInp, minDateInp, maxDateInp);
    el.appendChild(inputRow);

    this.listen(typeSel, 'change', () => {
      const c = typeSel.value === DISTRIBUTION_TYPES.CONSTANT;
      const d = typeSel.value === DISTRIBUTION_TYPES.UNIFORM_DATE;
      meanInp.style.display    = (c || d) ? 'none' : 'block';
      stdDevInp.style.display  = (c || d) ? 'none' : 'block';
      valueInp.style.display   = c ? 'block' : 'none';
      minDateInp.style.display = d ? 'block' : 'none';
      maxDateInp.style.display = d ? 'block' : 'none';
    });

    const enabledCb = labelRow.querySelector('input[type="checkbox"]');
    return { el, refs: { enabledCb, typeSel, meanInp, stdDevInp, valueInp, minDateInp, maxDateInp } };
  }
}
