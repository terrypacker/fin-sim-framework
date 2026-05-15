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

const INPUT_STYLE = 'background:#0f172a;color:#94a3b8;border:1px solid #1e293b;' +
                    'font-size:10px;padding:1px 3px;font-family:monospace;';

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
    this._rowMap     = new Map(); // paramKey → { enabledCb, typeSel, meanInp, stdDevInp, valueInp }
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
      <div style="padding:4px;display:flex;flex-direction:column;gap:4px">
        <div class="node-field">
          <label>Iterations</label>
          <input type="number" value="100" min="1" max="10000"
            style="flex:1;background:#0f172a;color:#94a3b8;border:1px solid #334155;
                   padding:3px 6px;font-family:monospace;font-size:12px;border-radius:3px" />
        </div>
        <button class="btn btn-primary" style="width:100%">▶ Run Monte Carlo</button>
      </div>
      <div style="padding:6px 8px;font-size:11px;font-family:monospace;color:#64748b;min-height:20px"></div>
      <div class="mc-var-section">
        <div style="font-size:11px;color:#475569;font-family:monospace;padding:4px 8px;
                    border-bottom:1px solid #1e293b;border-top:1px solid #1e293b;
                    text-transform:uppercase;letter-spacing:0.05em">
          Variable Distributions
        </div>
      </div>
    `;
    this.append(this._container, shell);

    this._iterEl   = shell.querySelector('input[type="number"]');
    this._runBtn   = shell.querySelector('button');
    this._statusEl = shell.querySelector('div[style*="min-height:20px"]');
    const section  = shell.querySelector('.mc-var-section');

    this.listen(this._runBtn, 'click', () => {
      if (this.onRun) this.onRun(this.getConfig());
    });

    this._buildVarTable(section);
  }

  _buildVarTable(section) {
    // Group configs by group name
    const groups = new Map();
    for (const cfg of DEFAULT_MC_VARIABLE_CONFIGS) {
      if (!groups.has(cfg.group)) groups.set(cfg.group, []);
      groups.get(cfg.group).push(cfg);
    }

    for (const [groupName, configs] of groups) {
      const header = document.createElement('div');
      header.style.cssText =
        'font-size:10px;color:#334155;font-family:monospace;padding:6px 8px 2px;' +
        'text-transform:uppercase;letter-spacing:0.05em;font-weight:600';
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

    const el = document.createElement('div');
    el.style.cssText =
      'display:flex;flex-direction:column;padding:3px 8px 4px;' +
      'border-bottom:1px solid #0f172a';

    // Row 1: enabled checkbox + label
    const labelRow = document.createElement('div');
    labelRow.style.cssText = 'display:flex;align-items:center;gap:4px';
    labelRow.innerHTML = `
      <input type="checkbox" ${cfg.enabled ? 'checked' : ''}
        style="margin:0;cursor:pointer;accent-color:#3b82f6;flex-shrink:0" />
      <span style="flex:1;font-size:11px;color:#94a3b8;font-family:monospace;
                   overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
        title="${cfg.label}">${cfg.label}</span>
    `;
    el.appendChild(labelRow);

    // Row 2: type dropdown + param inputs
    const inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex;gap:3px;margin-top:2px;padding-left:18px';

    const typeSel = document.createElement('select');
    typeSel.style.cssText =
      INPUT_STYLE + 'flex-shrink:0;color:#64748b;border-color:#1e293b;';
    typeSel.innerHTML = [
      DISTRIBUTION_TYPES.NORMAL,
      DISTRIBUTION_TYPES.LOG_NORMAL,
      DISTRIBUTION_TYPES.UNIFORM,
      DISTRIBUTION_TYPES.CONSTANT,
    ].map(t => `<option value="${t}" ${cfg.type === t ? 'selected' : ''}>${t}</option>`).join('');

    const meanInp = document.createElement('input');
    meanInp.type  = 'number';
    meanInp.step  = 'any';
    meanInp.placeholder = 'mean';
    meanInp.value = isConst ? '' : String(cfg.mean ?? '');
    meanInp.style.cssText = INPUT_STYLE + 'width:60px;display:' + (isConst ? 'none' : 'block');

    const stdDevInp = document.createElement('input');
    stdDevInp.type  = 'number';
    stdDevInp.step  = 'any';
    stdDevInp.placeholder = 'σ';
    stdDevInp.value = isConst ? '' : String(cfg.stdDev ?? '');
    stdDevInp.style.cssText = INPUT_STYLE + 'width:48px;display:' + (isConst ? 'none' : 'block');

    const valueInp = document.createElement('input');
    valueInp.type  = 'number';
    valueInp.step  = 'any';
    valueInp.placeholder = 'value';
    valueInp.value = isConst ? String(cfg.value ?? cfg.mean ?? '') : '';
    valueInp.style.cssText = INPUT_STYLE + 'width:72px;display:' + (isConst ? 'block' : 'none');

    inputRow.append(typeSel, meanInp, stdDevInp, valueInp);
    el.appendChild(inputRow);

    // Show/hide inputs when type changes
    this.listen(typeSel, 'change', () => {
      const c = typeSel.value === DISTRIBUTION_TYPES.CONSTANT;
      meanInp.style.display   = c ? 'none' : 'block';
      stdDevInp.style.display = c ? 'none' : 'block';
      valueInp.style.display  = c ? 'block' : 'none';
    });

    const enabledCb = labelRow.querySelector('input[type="checkbox"]');
    return { el, refs: { enabledCb, typeSel, meanInp, stdDevInp, valueInp } };
  }
}
