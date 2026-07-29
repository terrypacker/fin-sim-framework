/**
 * WorkbenchLayoutModel — manages the dockable pane layout.
 *
 * Layout shape:
 *   {
 *     sizes:            [number, number, number],  // flex fractions for left/center/right
 *     left:             { tabs: string[], active: string | null },
 *     center:           { tabs: string[], active: string | null },
 *     right:            { tabs: string[], active: string | null },
 *     bottom:           { tabs: string[], active: string | null },
 *     bottomSize:       number,   // px height of bottom panel
 *     bottomCollapsed:  boolean,
 *     centerSplit:      boolean,  // whether center is split into two sub-panes
 *     centerSplitDir:   'h'|'v',  // 'h' = side-by-side, 'v' = stacked
 *     centerInnerSizes: [number, number],  // flex fractions (h) or [1, px-height] (v)
 *     'center-a':       { tabs: string[], active: string | null },
 *     'center-b':       { tabs: string[], active: string | null },
 *     closedTabs:       string[],  // tabs the user closed on purpose — see _adoptNewDefaultTabs
 *   }
 */
export class WorkbenchLayoutModel {
  /** @param {object} defaultLayout */
  constructor(defaultLayout) {
    this._default = defaultLayout;
    this._layout = null;
    this._storageKey = null;
  }

  get layout() {
    return this._layout;
  }

  /**
   * Load from localStorage, falling back to the default layout.
   * @param {string} storageKey
   */
  load(storageKey) {
    this._storageKey = storageKey;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        this._layout = JSON.parse(saved);
        this._fillMissingFromDefault();
        return;
      }
    } catch {
      // ignore malformed JSON — fall through to default
    }
    this._layout = structuredClone(this._default);
  }

  /** Backfill any keys present in the default but absent in a saved layout. */
  _fillMissingFromDefault() {
    for (const [key, value] of Object.entries(this._default)) {
      if (this._layout[key] === undefined) {
        this._layout[key] = structuredClone(value);
      }
    }
    this._adoptNewDefaultTabs();
  }

  /**
   * Place default tabs that the saved layout has never heard of.
   *
   * Backfilling only top-level KEYS meant a newly registered panel was invisible to
   * everyone with a saved layout — which is everyone who has used the app — and
   * invisible in the worst way: the plugin loads, works, and simply has no tab, so it
   * reads as "the feature doesn't work" rather than "your layout predates it".
   *
   * A tab the user CLOSED must stay closed, so intent is recorded explicitly at the
   * moment of closing (`closedTabs`) rather than inferred from absence. One-time quirk
   * worth knowing: tabs closed before `closedTabs` existed have no record, so they
   * reappear once and stay gone after the next close.
   */
  _adoptNewDefaultTabs() {
    const closed = new Set(Array.isArray(this._layout.closedTabs) ? this._layout.closedTabs : []);

    const placed = new Set();
    for (const cfg of Object.values(this._layout)) {
      if (Array.isArray(cfg?.tabs)) cfg.tabs.forEach(t => placed.add(t));
    }

    for (const [pane, cfg] of Object.entries(this._default)) {
      if (!Array.isArray(cfg?.tabs)) continue;
      for (const tab of cfg.tabs) {
        if (placed.has(tab) || closed.has(tab)) continue;
        if (!Array.isArray(this._layout[pane]?.tabs)) continue;
        this._layout[pane].tabs.push(tab);
        this._layout[pane].active ??= tab;
        placed.add(tab);
      }
    }
  }

  /** Persist current layout to localStorage. */
  save() {
    if (!this._storageKey) return;
    try {
      localStorage.setItem(this._storageKey, JSON.stringify(this._layout));
    } catch {
      // quota exceeded or private mode — silently ignore
    }
  }

  /** Revert to default layout and remove persisted state. */
  reset() {
    this._layout = structuredClone(this._default);
    if (this._storageKey) {
      localStorage.removeItem(this._storageKey);
    }
  }

  /**
   * Move a tab from one pane to another.
   * Caller must re-render both affected panes.
   */
  moveTab(tab, fromPane, toPane) {
    if (fromPane === toPane) return;
    const from = this._layout[fromPane];
    const to   = this._layout[toPane];

    from.tabs = from.tabs.filter(t => t !== tab);
    if (from.active === tab) {
      from.active = from.tabs[0] ?? null;
    }

    to.tabs.push(tab);
    to.active = tab;
  }

  /**
   * Add a tab to a pane.
   * No-op if the pane doesn't exist or already contains the tab.
   */
  addTab(pane, tab) {
    const cfg = this._layout[pane];
    if (!cfg || cfg.tabs.includes(tab)) return;
    cfg.tabs.push(tab);
    cfg.active = tab;
    // Re-opening revokes the "don't put this back" record from closeTab().
    if (Array.isArray(this._layout.closedTabs)) {
      this._layout.closedTabs = this._layout.closedTabs.filter(t => t !== tab);
    }
  }

  /**
   * Remove a tab from a pane; advances active to next available.
   *
   * Records the id so `_adoptNewDefaultTabs()` does not helpfully put it back on the
   * next load — closing a tab is an instruction, not an accident.
   */
  closeTab(pane, tab) {
    const cfg = this._layout[pane];
    cfg.tabs = cfg.tabs.filter(t => t !== tab);
    if (cfg.active === tab) {
      cfg.active = cfg.tabs[0] ?? null;
    }
    const closed = Array.isArray(this._layout.closedTabs) ? this._layout.closedTabs : [];
    if (!closed.includes(tab)) closed.push(tab);
    this._layout.closedTabs = closed;
  }

  /** Set the active tab in a pane. */
  setActive(pane, tab) {
    this._layout[pane].active = tab;
  }

  /**
   * Store pane flex sizes (3-element array: [left, center, right]).
   * These are relative flex fractions (e.g. [1, 2, 1]).
   */
  setSizes(sizes) {
    this._layout.sizes = sizes;
  }

  /** @returns {number[]} */
  getSizes() {
    return this._layout.sizes ?? this._default.sizes ?? [1, 2, 1];
  }

  /** @returns {number} px height of the bottom panel */
  getBottomSize() {
    return this._layout.bottomSize ?? 200;
  }

  /** @param {number} h — px height */
  setBottomSize(h) {
    this._layout.bottomSize = h;
  }

  /** @returns {boolean} */
  isBottomCollapsed() {
    return this._layout.bottomCollapsed ?? false;
  }

  /** @param {boolean} collapsed */
  setBottomCollapsed(collapsed) {
    this._layout.bottomCollapsed = collapsed;
  }

  // ── Center split ────────────────────────────────────────────────────────────

  /** @returns {boolean} */
  isCenterSplit() {
    return this._layout.centerSplit ?? false;
  }

  /** @returns {'h'|'v'} */
  getCenterSplitDir() {
    return this._layout.centerSplitDir ?? 'h';
  }

  /** @param {'h'|'v'} dir */
  setCenterSplitDir(dir) {
    this._layout.centerSplitDir = dir;
  }

  /**
   * Toggle center split on/off, migrating tabs between center ↔ center-a.
   * @param {boolean} enabled
   */
  setCenterSplit(enabled) {
    if (enabled === this.isCenterSplit()) return;
    if (enabled) {
      this._layout['center-a'] = structuredClone(this._layout.center);
      this._layout['center-b'] = { tabs: [], active: null };
    } else {
      const a = this._layout['center-a'] ?? { tabs: [], active: null };
      const b = this._layout['center-b'] ?? { tabs: [], active: null };
      this._layout.center = {
        tabs:   [...a.tabs, ...b.tabs],
        active: a.active ?? b.active ?? null,
      };
    }
    this._layout.centerSplit = enabled;
  }

  /** @returns {[number, number]} */
  getCenterInnerSizes() {
    return this._layout.centerInnerSizes ?? [1, 1];
  }

  /** @param {[number, number]} sizes */
  setCenterInnerSizes(sizes) {
    this._layout.centerInnerSizes = sizes;
  }

  /**
   * Reorder a tab within its pane by moving it before insertBefore (or to end).
   * @param {string}      pane
   * @param {string}      tabId
   * @param {string|null} insertBefore  — tabId to insert before, or null to append
   */
  reorderTab(pane, tabId, insertBefore) {
    const cfg = this._layout[pane];
    if (!cfg) return;
    const tabs = cfg.tabs.filter(t => t !== tabId);
    const idx  = insertBefore ? tabs.indexOf(insertBefore) : -1;
    if (idx === -1) {
      tabs.push(tabId);
    } else {
      tabs.splice(idx, 0, tabId);
    }
    cfg.tabs = tabs;
  }

  // ── Template management ─────────────────────────────────────────────────────

  static get _TEMPLATE_PREFIX() { return 'workbench-tpl-'; }

  /**
   * Save the current layout as a named user template in localStorage.
   * @param {string} name
   */
  saveTemplate(name) {
    try {
      localStorage.setItem(
        WorkbenchLayoutModel._TEMPLATE_PREFIX + name,
        JSON.stringify(this._layout),
      );
    } catch { /* quota exceeded or private mode */ }
  }

  /**
   * Load a previously saved user template by name.
   * @param {string} name
   * @returns {object | null}
   */
  loadTemplate(name) {
    try {
      const raw = localStorage.getItem(WorkbenchLayoutModel._TEMPLATE_PREFIX + name);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /** @returns {string[]} names of all user-saved templates */
  listSavedTemplates() {
    const names = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(WorkbenchLayoutModel._TEMPLATE_PREFIX)) {
          names.push(key.slice(WorkbenchLayoutModel._TEMPLATE_PREFIX.length));
        }
      }
    } catch { /* private mode */ }
    return names.sort();
  }

  /** Delete a user-saved template. */
  deleteTemplate(name) {
    try {
      localStorage.removeItem(WorkbenchLayoutModel._TEMPLATE_PREFIX + name);
    } catch { /* private mode */ }
  }

  /**
   * Replace the current layout with the given layout object and persist it.
   * Backfills any keys present in the default but absent in the template.
   * @param {object} layoutObj
   */
  applyTemplate(layoutObj) {
    this._layout = structuredClone(layoutObj);
    this._fillMissingFromDefault();
    this.save();
  }
}
