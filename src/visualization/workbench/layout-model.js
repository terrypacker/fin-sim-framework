/**
 * WorkbenchLayoutModel — manages the dockable pane layout.
 *
 * Layout shape:
 *   {
 *     sizes:          [number, number, number],  // flex fractions for left/center/right
 *     left:           { tabs: string[], active: string | null },
 *     center:         { tabs: string[], active: string | null },
 *     right:          { tabs: string[], active: string | null },
 *     bottom:         { tabs: string[], active: string | null },
 *     bottomSize:     number,   // px height of bottom panel
 *     bottomCollapsed: boolean,
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
   * Add a tab to a pane (e.g. reattach from detached window).
   * No-op if the pane doesn't exist or already contains the tab.
   */
  addTab(pane, tab) {
    const cfg = this._layout[pane];
    if (!cfg || cfg.tabs.includes(tab)) return;
    cfg.tabs.push(tab);
    cfg.active = tab;
  }

  /**
   * Remove a tab from a pane; advances active to next available.
   */
  closeTab(pane, tab) {
    const cfg = this._layout[pane];
    cfg.tabs = cfg.tabs.filter(t => t !== tab);
    if (cfg.active === tab) {
      cfg.active = cfg.tabs[0] ?? null;
    }
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
}
