/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { WorkbenchComponent } from '../../component.js';
import { WB_EVENTS }          from '../../workbench-runtime.js';
import { ServiceRegistry }    from '../../../../services/service-registry.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../../../simulation-framework/bus-messages.js';
import { get }                from '../../../../finance/monte-carlo/mc-param-paths.js';
import { FieldFormatter }     from '../../../state/field-format.js';
import { buildFieldRow, renderSparkline } from '../../../state/field-row.js';

const AXES = [['auto', 'Auto'], ['left', 'Left'], ['right', 'Right']];

/**
 * WatchlistPlugin — design 101 W3. Pick a watchlist, see its fields' current values,
 * chart them, and maintain the lists.
 *
 *   [ list ▾ ] ＋ ✎ ⧉ 🗑
 *   ☑ ⠿ US Brokerage · SWTSX · Market Value   ╱╲╱‾   $1.23M   ⋯
 *
 * A row is [charted ☑][drag ⠿][label][sparkline][value][⋯]. The label is the entry's
 * own, else the field's context label. Values are read from `sim.state`, so they
 * follow the run and a scrub, and formatted compact. A path absent at the current date
 * (a lot not yet bought) is muted. Row click publishes FIELD_HISTORY_OPEN.
 *
 * Everything goes through `runtime.watchlist` (WatchlistController.facade) and
 * WATCHLIST_CHANGED, the cross-panel contract, so this panel holds no list state. The
 * row structure is rebuilt only when a list changes; each step only refreshes the value
 * and sparkline cells, so a drag or an open menu survives a running simulation.
 */
export class WatchlistPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime          = runtime;
    this._sim              = null;
    this._unsubSimBus      = null;
    this._renderQueued     = false;
    this._rows             = new Map();  // path → { row, spark, value }
    this._menu             = null;
    this._onDocDown        = null;
    this._dragFrom         = null;
    this._servicesOverride = null;       // tests
    this._formatter        = null;
    this._formatterReg     = null;
  }

  setServices(services) { this._servicesOverride = services ?? null; }
  _services() { return this._servicesOverride ?? ServiceRegistry.getInstance(); }

  /** The loaded scenario's watchlists, read at call time (re-assigned per load). */
  _wl() { return this._runtime.watchlist ?? null; }

  render() {
    const root = document.createElement('div');
    root.className = 'wl-plugin wb-plugin-fill';
    root.innerHTML = `
      <div class="wl-toolbar">
        <select class="wb-select wl-list" data-wl="list" title="The active watchlist: the chart plots its charted fields"></select>
        <button class="btn btn-sm" data-wl="new"       title="New watchlist">＋</button>
        <button class="btn btn-sm" data-wl="rename"    title="Rename this watchlist">✎</button>
        <button class="btn btn-sm" data-wl="duplicate" title="Duplicate this watchlist">⧉</button>
        <button class="btn btn-sm" data-wl="delete"    title="Delete this watchlist">🗑</button>
      </div>
      <div class="wl-body" data-wl="body"></div>
      <div class="wl-hint">☑ charted · ⠿ drag to reorder · click a row for its history</div>
    `;
    return root;
  }

  _q(name) { return this.el?.querySelector(`[data-wl="${name}"]`) ?? null; }

  onInit() {
    this._runtime.bus.subscribe(WB_EVENTS.SCENARIO_READY, ({ scenario }) => this._bindSim(scenario?.sim ?? null));
    this._runtime.bus.subscribe(WB_EVENTS.WATCHLIST_CHANGED, () => this._renderAll());
    this._runtime.bus.subscribe(WB_EVENTS.DISPLAY_SETTINGS_CHANGED, () => this._renderValues());
  }

  onMount() {
    // Late mount: the scenario may already be running before this panel first shows.
    if (!this._sim) this._bindSim(this._services()?.simulationRegistry?.getPrimary?.() ?? null);
    this._bindToolbar();
    this._renderAll();
  }

  onUnmount() { this._closeMenu(); }

  destroy() {
    this._closeMenu();
    this._unsubSimBus?.();
    this._unsubSimBus = null;
    super.destroy?.();
  }

  // ─── Binding ─────────────────────────────────────────────────────────────

  _bindSim(sim) {
    // Every Rebuild swaps in a fresh sim and bus, so re-subscribe on each.
    this._unsubSimBus?.();
    this._unsubSimBus = null;
    this._sim = sim ?? null;
    if (sim?.bus) {
      this._unsubSimBus = sim.bus.subscribe(
        `EXECUTION_${EXECUTION_PHASES.END}`,
        { kind: EXECUTION_KINDS.EVENT },
        () => this._scheduleValues(),
      );
    }
    this._renderAll();
  }

  /** Coalesce step-driven value refreshes to one per frame; a hidden tab pays nothing. */
  _scheduleValues() {
    if (!this._mounted || this._renderQueued) return;
    this._renderQueued = true;
    const run = () => { this._renderQueued = false; this._renderValues(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  /** A FieldFormatter over the current services' registry (a Rebuild replaces it). */
  _fmt() {
    const reg = this._services()?.schemaRegistry ?? null;
    if (!reg) return null;
    if (reg !== this._formatterReg) {
      this._formatterReg = reg;
      this._formatter    = new FieldFormatter({ registry: reg, stateProvider: () => this._sim?.state ?? null });
    }
    return this._formatter;
  }

  _bindToolbar() {
    if (!this.el || this.el._wlBound) return;
    this.el._wlBound = true;
    this._q('list').addEventListener('change', e => this._wl()?.setActive(e.target.value));
    this._q('new').addEventListener('click', () => {
      const name = window.prompt('Name for the new watchlist', 'Watchlist');
      if (name != null && name.trim()) this._wl()?.create(name);
    });
    this._q('rename').addEventListener('click', () => {
      const active = this._wl()?.active();
      if (!active) return;
      const name = window.prompt('Rename watchlist', active.name);
      if (name != null) this._wl().rename(active.id, name);
    });
    this._q('duplicate').addEventListener('click', () => {
      const active = this._wl()?.active();
      if (active) this._wl().duplicate(active.id);
    });
    this._q('delete').addEventListener('click', () => {
      const active = this._wl()?.active();
      if (!active) return;
      const n = active.entries.length;
      if (window.confirm(`Delete the watchlist "${active.name}" and its ${n} field${n === 1 ? '' : 's'}?`)) {
        this._wl().delete(active.id);
      }
    });
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  _renderAll() {
    if (!this._mounted) return;
    this._renderToolbar();
    this._renderRows();
    this._renderValues();
  }

  _renderToolbar() {
    const wl       = this._wl();
    const lists    = wl?.lists() ?? [];
    const activeId = wl?.activeId() ?? null;
    const sel      = this._q('list');
    sel.replaceChildren();
    sel.disabled = lists.length === 0;
    if (lists.length === 0) sel.add(new Option(wl ? 'No watchlists' : 'No scenario loaded', ''));
    for (const { id, name, size } of lists) sel.add(new Option(`${name} (${size})`, id));
    sel.value = activeId ?? '';
    this._q('new').disabled = !wl;
    for (const b of ['rename', 'duplicate', 'delete']) this._q(b).disabled = !activeId;
  }

  _renderRows() {
    this._closeMenu();
    const body = this._q('body');
    body.replaceChildren();
    this._rows.clear();

    const wl     = this._wl();
    const active = wl?.active() ?? null;
    const empty  = text => { const d = document.createElement('div'); d.className = 'wl-empty'; d.textContent = text; body.appendChild(d); };
    if (!wl)                     return empty('Load a scenario to see its watchlists.');
    if (!active)                 return empty('No watchlists. ＋ creates one.');
    if (!active.entries.length)  return empty('This list is empty. Check a field in the State panel to add it.');

    const fmt   = this._fmt();
    const state = this._sim?.state ?? null;
    active.entries.forEach((entry, index) => {
      const row = buildFieldRow({
        path:       entry.path,
        label:      entry.label ?? fmt?.contextLabel(entry.path, { state }) ?? entry.path,
        valueText:  '',
        toggle:     this._chartToggle(entry),
        handle:     this._dragHandle(index),
        trail:      this._moreButton(entry, index),
        extraClass: 'wl-row',
        onClick:    () => this._runtime.bus.publish({ type: WB_EVENTS.FIELD_HISTORY_OPEN, path: entry.path }),
      });
      if (entry.label) row.querySelector('.lsp-metric-label').classList.add('is-custom');
      this._wireDrop(row, index);
      this._rows.set(entry.path, {
        row,
        spark: row.querySelector('.lsp-metric-spark'),
        value: row.querySelector('.lsp-metric-value'),
      });
      body.appendChild(row);
    });
  }

  /** Refresh only the value and sparkline cells from the current state. */
  _renderValues() {
    if (!this._mounted || this._rows.size === 0) return;
    const fmt   = this._fmt();
    const wl    = this._wl();
    const state = this._sim?.state ?? null;
    for (const [path, { row, spark, value }] of this._rows) {
      const v = state ? get(state, path) : undefined;
      const absent = v == null || (typeof v === 'number' && !Number.isFinite(v));
      row.classList.toggle('is-absent', absent);
      value.classList.remove('is-untyped');
      if (absent) {
        value.textContent = 'not in state at this date';
        value.title = '';
        spark.replaceChildren();
        continue;
      }
      value.textContent = fmt?.format(path, v, { compact: true })
        ?? (typeof v === 'object' ? JSON.stringify(v).slice(0, 40) : String(v));
      value.title = fmt?.valueTitle(path, v) ?? '';
      if (typeof v === 'number' && fmt && !fmt.isTyped(path)) value.classList.add('is-untyped');
      const svg = renderSparkline((wl?.series(path) ?? []).map(p => p.value));
      spark.replaceChildren(...(svg ? [svg] : []));
    }
  }

  // ─── Row controls ────────────────────────────────────────────────────────

  _chartToggle(entry) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'lsp-chart-toggle';
    cb.title = 'Show on chart';
    cb.checked = entry.charted;
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', () => this._wl()?.setCharted(entry.path, cb.checked));
    return cb;
  }

  _dragHandle(index) {
    const h = document.createElement('span');
    h.className = 'wl-handle';
    h.textContent = '⠿';
    h.title = 'Drag to reorder';
    h.draggable = true;
    h.addEventListener('click', e => e.stopPropagation());
    h.addEventListener('dragstart', e => {
      this._dragFrom = index;
      e.dataTransfer?.setData?.('text/plain', String(index));
      h.closest('.wl-row')?.classList.add('is-dragging');
    });
    h.addEventListener('dragend', () => {
      this._dragFrom = null;
      this.el?.querySelectorAll('.is-dragging, .is-drop-target')
        .forEach(r => r.classList.remove('is-dragging', 'is-drop-target'));
    });
    return h;
  }

  _wireDrop(row, index) {
    row.addEventListener('dragover', e => {
      if (this._dragFrom == null) return;
      e.preventDefault();
      row.classList.add('is-drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      const from = this._dragFrom;
      this._dragFrom = null;
      if (from != null && from !== index) this._wl()?.moveEntry(from, index);
    });
  }

  _moreButton(entry, index) {
    const b = document.createElement('button');
    b.className = 'wl-more';
    b.textContent = '⋯';
    b.title = 'More';
    b.addEventListener('click', e => { e.stopPropagation(); this._openMenu(b, entry, index); });
    return b;
  }

  /** The row's ⋯ menu: label, axis, copy path, move, remove. */
  _openMenu(anchor, entry, index) {
    this._closeMenu();
    const wl = this._wl();
    if (!wl) return;
    const count = wl.active()?.entries.length ?? 0;

    const menu = document.createElement('div');
    menu.className = 'wl-menu';
    menu.setAttribute('role', 'menu');
    const item = (text, action, { checked = false, disabled = false } = {}) => {
      const it = document.createElement('button');
      it.className = 'wl-menu-item';
      it.setAttribute('role', 'menuitem');
      it.textContent = (checked ? '✓ ' : '') + text;
      it.disabled = disabled;
      it.addEventListener('click', e => { e.stopPropagation(); this._closeMenu(); action(); });
      menu.appendChild(it);
    };
    const part = (cls, text = '') => {
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      menu.appendChild(d);
    };

    item('Rename label…', () => {
      const label = window.prompt('Label for this field (blank restores the automatic one)', entry.label ?? '');
      if (label != null) wl.setLabel(entry.path, label);
    });
    part('wl-menu-sep');
    part('wl-menu-head', 'Chart axis');
    for (const [axis, text] of AXES) item(text, () => wl.setAxis(entry.path, axis), { checked: entry.axis === axis });
    part('wl-menu-sep');
    item('Copy path', () => navigator.clipboard?.writeText?.(entry.path));
    item('Move up',   () => wl.moveEntry(index, index - 1), { disabled: index === 0 });
    item('Move down', () => wl.moveEntry(index, index + 1), { disabled: index >= count - 1 });
    part('wl-menu-sep');
    item('Remove from watchlist', () => wl.remove(entry.path));

    menu.style.top = `${anchor.offsetTop + anchor.offsetHeight}px`;
    this.el.appendChild(menu);
    this._menu = menu;
    this._onDocDown = e => { if (!menu.contains(e.target)) this._closeMenu(); };
    document.addEventListener('mousedown', this._onDocDown);
  }

  _closeMenu() {
    this._menu?.remove();
    this._menu = null;
    if (this._onDocDown) document.removeEventListener('mousedown', this._onDocDown);
    this._onDocDown = null;
  }
}
