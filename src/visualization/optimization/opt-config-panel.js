/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent }                from '../components/base-component.js';
import { DEFAULT_OPTIMIZATION_CONFIGS } from '../../finance/optimization/intl-retirement-opt-config.js';
import { OPTIMIZATION_OBJECTIVES, OPT_PARAM_TYPES } from '../../finance/optimization/optimization-objectives.js';
import { valuesForConfig }              from '../../finance/optimization/intl-retirement-optimizer.js';

const INPUT_STYLE =
  'background:#0f172a;color:#94a3b8;border:1px solid #1e293b;' +
  'font-size:10px;padding:1px 3px;font-family:monospace;';

/**
 * OptConfigPanel — left pane of the Optimization tab.
 *
 * Renders the objective selector, run controls, and a grouped
 * search-space table into the provided container element.
 *
 * Callbacks:
 *   onRun({ optimizationConfigs, objective, objectiveKey, candidateCount })
 */
export class OptConfigPanel extends BaseComponent {
  constructor(containerEl) {
    super();
    this._container    = containerEl;
    this._rowMap       = new Map(); // paramKey → { enabledCb, rangeEl, minInp?, maxInp?, stepInp? }
    this._objectiveSel = null;
    this._countEl      = null;
    this._runBtn       = null;
    this._statusEl     = null;
    this.onRun         = null;

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
   * @returns {{ optimizationConfigs, objective, objectiveKey, candidateCount }}
   */
  getConfig() {
    const objectiveKey = this._objectiveSel?.value ?? 'MAX_NET_WORTH';
    const objective    = OPTIMIZATION_OBJECTIVES[objectiveKey] ?? OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH;

    const optimizationConfigs = DEFAULT_OPTIMIZATION_CONFIGS.map(cfg => {
      const row = this._rowMap.get(cfg.paramKey);
      if (!row) return { ...cfg };

      const out     = { ...cfg, enabled: row.enabledCb.checked };
      if (cfg.type !== OPT_PARAM_TYPES.ENUM && row.minInp) {
        const min  = parseFloat(row.minInp.value);
        const max  = parseFloat(row.maxInp.value);
        const step = parseFloat(row.stepInp.value);
        if (isFinite(min))  out.min  = min;
        if (isFinite(max))  out.max  = max;
        if (isFinite(step) && step > 0) out.step = step;
      }
      return out;
    });

    const candidateCount = this._computeCount(optimizationConfigs);
    return { optimizationConfigs, objective, objectiveKey, candidateCount };
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _computeCount(configs) {
    const enabled = configs.filter(c => c.enabled);
    if (!enabled.length) return 1;
    return enabled.reduce((n, cfg) => n * valuesForConfig(cfg).length, 1);
  }

  _updateCount() {
    if (!this._countEl) return;
    const { optimizationConfigs } = this.getConfig();
    const n = this._computeCount(optimizationConfigs);
    this._countEl.textContent = `${n} candidate${n !== 1 ? 's' : ''}`;
  }

  _render() {
    const objectiveOptions = Object.entries(OPTIMIZATION_OBJECTIVES)
      .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
      .join('');

    const shell = document.createElement('div');
    shell.innerHTML = `
      <div class="node-header">Optimization</div>
      <div style="padding:4px;display:flex;flex-direction:column;gap:4px">
        <div class="node-field">
          <label>Objective</label>
          <select style="flex:1;background:#0f172a;color:#94a3b8;border:1px solid #334155;
                         padding:3px 6px;font-family:monospace;font-size:12px;border-radius:3px">
            ${objectiveOptions}
          </select>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="btn btn-primary" style="flex:1">⚡ Run Optimization</button>
          <span class="opt-count-label"
            style="font-size:11px;color:#64748b;font-family:monospace;white-space:nowrap">
            — candidates
          </span>
        </div>
      </div>
      <div class="opt-status"
        style="padding:6px 8px;font-size:11px;font-family:monospace;color:#64748b;min-height:20px"></div>
      <div class="opt-var-section">
        <div style="font-size:11px;color:#475569;font-family:monospace;padding:4px 8px;
                    border-bottom:1px solid #1e293b;border-top:1px solid #1e293b;
                    text-transform:uppercase;letter-spacing:0.05em">
          Search Space
        </div>
      </div>
    `;
    this.append(this._container, shell);

    this._objectiveSel = shell.querySelector('select');
    this._runBtn       = shell.querySelector('button');
    this._statusEl     = shell.querySelector('.opt-status');
    this._countEl      = shell.querySelector('.opt-count-label');
    const section      = shell.querySelector('.opt-var-section');

    this.listen(this._runBtn, 'click', () => {
      if (this.onRun) this.onRun(this.getConfig());
    });

    this._buildVarTable(section);
    this._updateCount();
  }

  _buildVarTable(section) {
    const groups = new Map();
    for (const cfg of DEFAULT_OPTIMIZATION_CONFIGS) {
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
    const el = document.createElement('div');
    el.style.cssText =
      'display:flex;flex-direction:column;padding:3px 8px 4px;' +
      'border-bottom:1px solid #0f172a';

    // Row 1: enabled checkbox + label + value-count badge
    const labelRow = document.createElement('div');
    labelRow.style.cssText = 'display:flex;align-items:center;gap:4px';

    const valCount = valuesForConfig(cfg).length;
    labelRow.innerHTML = `
      <input type="checkbox" ${cfg.enabled ? 'checked' : ''}
        style="margin:0;cursor:pointer;accent-color:#a78bfa;flex-shrink:0" />
      <span style="flex:1;font-size:11px;color:#94a3b8;font-family:monospace;
                   overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
        title="${cfg.label}">${cfg.label}</span>
      <span style="font-size:9px;color:#475569;font-family:monospace;flex-shrink:0">${valCount}v</span>
    `;
    el.appendChild(labelRow);

    // Row 2: range details (hidden when disabled)
    const rangeRow = document.createElement('div');
    rangeRow.style.cssText =
      'margin-top:3px;padding-left:18px;display:' + (cfg.enabled ? '' : 'none');

    let refs = { enabledCb: labelRow.querySelector('input[type="checkbox"]') };

    if (cfg.type === OPT_PARAM_TYPES.ENUM) {
      // Read-only pills for enum values
      const pct = v => (typeof v === 'number' && v > 0 && v < 1) ? `${(v * 100).toFixed(0)}%` : String(v);
      rangeRow.innerHTML =
        `<div style="font-size:10px;color:#475569;font-family:monospace;word-break:break-all">` +
        cfg.values.map(v => `<span style="display:inline-block;background:#1e293b;border-radius:3px;padding:0 4px;margin:1px">${pct(v)}</span>`).join(' ') +
        `</div>`;
    } else {
      // Editable min / max / step inputs
      const minInp  = this._numInput(String(cfg.min),  'min',  '54px');
      const maxInp  = this._numInput(String(cfg.max),  'max',  '54px');
      const stepInp = this._numInput(String(cfg.step), 'step', '42px');

      const lbl = (t) => {
        const s = document.createElement('span');
        s.style.cssText = 'font-size:9px;color:#334155;font-family:monospace';
        s.textContent   = t;
        return s;
      };

      rangeRow.style.display = 'flex';
      rangeRow.style.gap     = '3px';
      rangeRow.style.alignItems = 'center';
      rangeRow.append(lbl('min'), minInp, lbl('max'), maxInp, lbl('step'), stepInp);

      refs = { ...refs, minInp, maxInp, stepInp };

      [minInp, maxInp, stepInp].forEach(inp =>
        this.listen(inp, 'input', () => this._updateCount())
      );
    }

    el.appendChild(rangeRow);

    const enabledCb = refs.enabledCb;
    this.listen(enabledCb, 'change', () => {
      rangeRow.style.display = enabledCb.checked ? (cfg.type === OPT_PARAM_TYPES.ENUM ? '' : 'flex') : 'none';
      this._updateCount();
    });

    return { el, refs };
  }

  _numInput(value, placeholder, width) {
    const inp = document.createElement('input');
    inp.type        = 'number';
    inp.step        = 'any';
    inp.value       = value;
    inp.placeholder = placeholder;
    inp.style.cssText = INPUT_STYLE + `width:${width}`;
    return inp;
  }
}
