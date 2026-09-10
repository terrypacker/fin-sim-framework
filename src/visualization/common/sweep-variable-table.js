/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * SweepVariableTable — the grouped variable list shared by the Monte Carlo and
 * Optimization config panels (design 98 W4): a live filter, collapsible groups and
 * an `enabled / total` count on every group header. Each panel keeps its own row
 * builder; this owns grouping, filtering and collapse.
 *
 * Modelled on the scenario params panel (scenario-tab-view.js `_renderParamsList`),
 * with three deliberate differences:
 *
 *   1. EVERY row is built; collapse and filter only toggle `hidden`. The panels'
 *      `getConfig()` reads a row's live inputs from their row map and falls back to
 *      the row's ORIGINAL config when a row was never built — so a group that skipped
 *      building its rows while collapsed would silently drop an axis the user enabled.
 *   2. A group holding an enabled row starts EXPANDED. Collapsed-by-default is right
 *      for the ~60 harvested rows and wrong for the ~15 that will actually be swept.
 *      That default is re-evaluated on every render until the user toggles the group;
 *      from then on their choice sticks, across setVariables() rebuilds too. (Deciding
 *      it once per group name would freeze the state the panel's constructor saw on
 *      its placeholder list, before the real variables arrived.)
 *   3. The filter matches `label`, `paramKey` and `group`, and force-expands every
 *      group with a match.
 */
export class SweepVariableTable {
  /**
   * @param {object} owner      the panel (a BaseComponent) — its `listen` registers
   *                            handlers so they are released on destroy()
   * @param {HTMLElement} parentEl  where the filter box and the group list mount
   * @param {{ prefix: string, buildRow: (cfg: object) => { el: HTMLElement, refs: object } }} opts
   *        `refs.enabledCb` must be the row's enable checkbox.
   */
  constructor(owner, parentEl, { prefix, buildRow }) {
    this._prefix   = prefix;
    this._buildRow = buildRow;
    this._filter   = '';
    this._expanded = new Set();   // groups currently open
    this._userSet  = new Map();   // group → expanded, for groups the user has toggled
    this._groups   = [];          // [{ name, header, caret, countEl, body, rows: [{ cfg, el, refs }] }]

    this.filterInput = document.createElement('input');
    this.filterInput.type        = 'search';
    this.filterInput.placeholder = 'Filter variables…';
    this.filterInput.className   = `sweep-var-filter ${prefix}-var-filter`;

    this.body = document.createElement('div');
    this.body.className = 'sweep-var-body';
    parentEl.append(this.filterInput, this.body);

    owner.listen(this.filterInput, 'input', () => {
      this._filter = (this.filterInput.value ?? '').trim().toLowerCase();
      this._apply();
    });
    // Counts follow the checkboxes without each panel having to report changes.
    owner.listen(this.body, 'change', e => {
      if (e.target?.type === 'checkbox') this._updateCounts();
    });
    this._owner = owner;
  }

  /**
   * (Re)build every group and row.
   *
   * @param {Array<object>} variables  the resolved variable list
   * @param {Map<string, object>} savedState  paramKey → the user's prior row state
   * @param {Map<string, object>} rowMap  filled with paramKey → row refs
   */
  render(variables, savedState, rowMap) {
    this.body.replaceChildren();
    this._groups = [];

    const byGroup = new Map();
    for (const cfg of variables) {
      const name = cfg.group ?? '';
      if (!byGroup.has(name)) byGroup.set(name, []);
      byGroup.get(name).push(cfg);
    }

    for (const [name, configs] of byGroup) {
      const header = document.createElement('div');
      header.className = `sweep-group-header ${this._prefix}-group-header`;
      const caret   = document.createElement('span');
      caret.className = 'sweep-group-caret';
      const label   = document.createElement('span');
      label.className   = 'sweep-group-label';
      label.textContent = name || 'Other';
      const countEl = document.createElement('span');
      countEl.className = 'sweep-group-count';
      header.append(caret, label, countEl);

      const groupBody = document.createElement('div');
      groupBody.className = 'sweep-group-body';

      const rows = configs.map(cfg => {
        const prior  = savedState.get(cfg.paramKey);
        const merged = prior ? { ...cfg, ...prior } : cfg;
        const { el, refs } = this._buildRow(merged);
        groupBody.appendChild(el);
        rowMap.set(cfg.paramKey, refs);
        return { cfg, el, refs };
      });

      const open = this._userSet.has(name)
        ? this._userSet.get(name)
        : rows.some(r => r.refs.enabledCb?.checked);
      if (open) this._expanded.add(name);
      else this._expanded.delete(name);

      this._owner.listen(header, 'click', () => {
        const next = !this._expanded.has(name);
        this._userSet.set(name, next);
        if (next) this._expanded.add(name);
        else this._expanded.delete(name);
        this._apply();
      });

      this.body.append(header, groupBody);
      this._groups.push({ name, header, caret, countEl, body: groupBody, rows });
    }

    this._apply();
    this._updateCounts();
  }

  _matches(cfg) {
    if (!this._filter) return true;
    return [cfg.label, cfg.paramKey, cfg.group].join(' ').toLowerCase().includes(this._filter);
  }

  /** Apply filter + collapse to the already-built rows. */
  _apply() {
    for (const g of this._groups) {
      let any = false;
      for (const r of g.rows) {
        const match = this._matches(r.cfg);
        r.el.hidden = !match;
        any ||= match;
      }
      const expanded = this._filter !== '' || this._expanded.has(g.name);
      g.header.hidden = !any;
      g.body.hidden   = !any || !expanded;
      g.caret.textContent = expanded ? '▼' : '▶';
      g.header.classList.toggle('sweep-group-header--collapsed', !expanded);
    }
  }

  _updateCounts() {
    for (const g of this._groups) {
      const n = g.rows.filter(r => r.refs.enabledCb?.checked).length;
      g.countEl.textContent = `${n} / ${g.rows.length}`;
      g.header.classList.toggle('sweep-group-header--active', n > 0);
    }
  }
}
