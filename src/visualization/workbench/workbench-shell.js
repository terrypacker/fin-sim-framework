import { WorkbenchLayoutModel } from './layout-model.js';
import { PluginRegistry }       from './plugin-registry.js';
import { SplitPane }            from './split-pane.js';
import { TabGroup }             from './tab-group.js';
import { WorkbenchRuntime, WB_EVENTS } from './workbench-runtime.js';

const STORAGE_KEY  = 'sim-workbench-layout';
const OUTER_PANES  = ['left', 'center', 'right'];   // outer horizontal split — always 3
const CENTER_SPLIT_PANES = ['center-a', 'center-b'];

/**
 * WorkbenchShell — assembles the full dockable workbench.
 *
 * Layout structure:
 *   outer vertical split ('main' / 'bottom')
 *     └── main  → inner horizontal split ('left' / 'center' / 'right')
 *                  └── 'center' may contain a nested SplitPane ('center-a' / 'center-b')
 *     └── bottom → bottom TabGroup (collapsible)
 *
 * Usage:
 *   const shell = new WorkbenchShell({ defaultLayout, plugins });
 *   shell.init(document.getElementById('workbench-root'));
 *
 * @param {object}       opts
 * @param {object}       opts.defaultLayout  — initial layout if no persisted state
 * @param {Array<{ id, title, component }>} opts.plugins — plugin descriptors to register
 * @param {string}       [opts.storageKey]   — localStorage key for persisted layout
 */
export class WorkbenchShell {
  constructor({ defaultLayout, plugins = [], storageKey }) {
    this.runtime  = new WorkbenchRuntime();
    this.registry = new PluginRegistry();
    this.layout   = new WorkbenchLayoutModel(defaultLayout);
    this._storageKey = storageKey ?? STORAGE_KEY;

    /** @type {Map<string, import('./component.js').WorkbenchComponent>} */
    this.instances = new Map();

    this._outerSplit       = null;
    this._innerSplit       = null;
    this._centerInnerSplit = null;  // nested split inside center pane when centerSplit=true
    this._tabGroups        = new Map();   // pane name → TabGroup
    this._container        = null;
    this._dragState        = null;        // { tabId, fromPane }
    this._ghost            = null;
    this._collapseBtn      = null;
    this._maximized        = false;

    for (const descriptor of plugins) {
      this.registry.registerPlugin(descriptor);
    }
  }

  // ── Active pane helpers ─────────────────────────────────────────────────────

  /** All pane names that currently have TabGroups (varies with center split state). */
  get _activePanes() {
    const center = this.layout.isCenterSplit() ? CENTER_SPLIT_PANES : ['center'];
    return ['left', ...center, 'right', 'bottom'];
  }

  /**
   * Render the full workbench into `container`.
   * @param {HTMLElement} container
   */
  init(container) {
    this._container = container;
    this.layout.load(this._storageKey);
    this._instantiatePlugins();
    this._render();
  }

  // ── Plugin instantiation ────────────────────────────────────────────────────

  _instantiatePlugins() {
    const allTabIds = new Set();
    for (const pane of this._activePanes) {
      const cfg = this.layout.layout[pane];
      if (cfg) cfg.tabs.forEach(id => allTabIds.add(id));
    }

    for (const id of allTabIds) {
      if (this.instances.has(id)) continue;
      const descriptor = this.registry.getPlugin(id);
      if (!descriptor) {
        console.warn(`WorkbenchShell: no plugin registered for tab '${id}'`);
        continue;
      }
      this.instances.set(id, new descriptor.component(this.runtime));
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  _render() {
    this._container.innerHTML = '';
    this._tabGroups.clear();
    this._centerInnerSplit = null;
    this._maximized = false;

    // Outer vertical split: 'main' (flex:1) + 'bottom' (fixed px)
    this._outerSplit = new SplitPane({ layout: this.layout, panes: ['main', 'bottom'], direction: 'vertical' });
    this._outerSplit.mount(this._container);

    // Inner horizontal split inside 'main'
    const mainEl = this._outerSplit.getPaneEl('main');
    this._innerSplit = new SplitPane({ layout: this.layout, panes: OUTER_PANES });
    this._innerSplit.mount(mainEl);

    // Collapse toggle button — injected into the bottom TabGroup's tab bar
    this._collapseBtn = document.createElement('button');
    this._collapseBtn.className = 'wb-btn wb-btn--collapse';
    this._collapseBtn.title = 'Toggle panel';
    this._collapseBtn.textContent = this.layout.isBottomCollapsed() ? '▲' : '▼';
    this._collapseBtn.addEventListener('click', () => this._toggleBottomCollapse());

    // Bottom TabGroup
    const bottomTabGroup = this._newTabGroup('bottom', { extraControls: this._collapseBtn });
    bottomTabGroup.mount(this._outerSplit.getPaneEl('bottom'));
    this._tabGroups.set('bottom', bottomTabGroup);

    // Left and right TabGroups
    for (const pane of ['left', 'right']) {
      const tg = this._newTabGroup(pane);
      tg.mount(this._innerSplit.getPaneEl(pane));
      this._tabGroups.set(pane, tg);
    }

    // Center — may be a single TabGroup or a split pair
    this._mountCenterContent(this._innerSplit.getPaneEl('center'));

    // Apply initial collapsed state
    if (this.layout.isBottomCollapsed()) {
      const bottomEl = this._outerSplit.getPaneEl('bottom');
      bottomEl.style.height = '34px';
      bottomEl.dataset.collapsed = '';
    }
  }

  /** Mount center pane content (single TabGroup or nested split). */
  _mountCenterContent(centerEl) {
    centerEl.innerHTML = '';

    if (this.layout.isCenterSplit()) {
      const dir = this.layout.getCenterSplitDir() === 'v' ? 'vertical' : 'horizontal';
      this._centerInnerSplit = new SplitPane({
        layout:       this.layout,
        panes:        CENTER_SPLIT_PANES,
        direction:    dir,
        getSizes:     ()  => this.layout.getCenterInnerSizes(),
        setSizes:     (s) => this.layout.setCenterInnerSizes(s),
        getFixedSize: ()  => this.layout.getCenterInnerSizes()[1] ?? 300,
        setFixedSize: (h) => this.layout.setCenterInnerSizes([this.layout.getCenterInnerSizes()[0], h]),
      });
      this._centerInnerSplit.mount(centerEl);

      const controls = this._buildCenterControls();
      const tgA = this._newTabGroup('center-a', { extraControls: controls });
      tgA.mount(this._centerInnerSplit.getPaneEl('center-a'));
      this._tabGroups.set('center-a', tgA);

      const tgB = this._newTabGroup('center-b');
      tgB.mount(this._centerInnerSplit.getPaneEl('center-b'));
      this._tabGroups.set('center-b', tgB);
    } else {
      const controls = this._buildCenterControls();
      const tg = this._newTabGroup('center', { extraControls: controls });
      tg.mount(centerEl);
      this._tabGroups.set('center', tg);
    }
  }

  /**
   * Re-mount just the center pane area (used when toggling split or direction).
   * Preserves all other panes and plugin instances.
   */
  _remountCenter() {
    // Unmount existing center TabGroups and inner split
    for (const pane of ['center', ...CENTER_SPLIT_PANES]) {
      const tg = this._tabGroups.get(pane);
      if (tg) { tg.unmount(); this._tabGroups.delete(pane); }
    }
    this._centerInnerSplit?.unmount();
    this._centerInnerSplit = null;

    this._instantiatePlugins();
    this._mountCenterContent(this._innerSplit.getPaneEl('center'));
  }

  // ── Center controls ─────────────────────────────────────────────────────────

  /** Build the split/direction/maximize button group for the center tab bar. */
  _buildCenterControls() {
    const wrap = document.createElement('div');
    wrap.className = 'wb-center-controls';

    const isSplit = this.layout.isCenterSplit();

    const splitBtn = document.createElement('button');
    splitBtn.className = 'wb-btn wb-btn--icon';
    splitBtn.title    = isSplit ? 'Unsplit center' : 'Split center';
    splitBtn.textContent = isSplit ? '⊡' : '⊞';
    splitBtn.addEventListener('click', () => this._toggleCenterSplit());

    if (isSplit) {
      const dirBtn = document.createElement('button');
      dirBtn.className = 'wb-btn wb-btn--icon';
      const isV = this.layout.getCenterSplitDir() === 'v';
      dirBtn.title       = isV ? 'Switch to side-by-side' : 'Switch to top/bottom';
      dirBtn.textContent = isV ? '↔' : '↕';
      dirBtn.addEventListener('click', () => this._toggleCenterDir());
      wrap.appendChild(dirBtn);
    }

    const maxBtn = document.createElement('button');
    maxBtn.className = 'wb-btn wb-btn--icon';
    maxBtn.title     = 'Maximize center';
    maxBtn.textContent = '⛶';
    maxBtn.addEventListener('click', () => this._toggleMaximize(maxBtn));

    wrap.append(splitBtn, maxBtn);
    return wrap;
  }

  _toggleCenterSplit() {
    this.layout.setCenterSplit(!this.layout.isCenterSplit());
    this.layout.save();
    this._remountCenter();
  }

  _toggleCenterDir() {
    const next = this.layout.getCenterSplitDir() === 'h' ? 'v' : 'h';
    this.layout.setCenterSplitDir(next);
    // Reset inner sizes to equal split when direction changes
    this.layout.setCenterInnerSizes([1, 1]);
    this.layout.save();
    this._remountCenter();
  }

  _toggleMaximize(btn) {
    this._maximized = !this._maximized;
    this._innerSplit.el?.classList.toggle('wb-center-maximized', this._maximized);
    btn.title       = this._maximized ? 'Restore' : 'Maximize center';
    btn.textContent = this._maximized ? '⛶' : '⛶';
    btn.classList.toggle('wb-btn--active', this._maximized);
  }

  // ── Re-render helpers ────────────────────────────────────────────────────────

  /** Re-render all panes. */
  _renderAll() {
    for (const pane of this._activePanes) {
      this._tabGroups.get(pane)?.rerender();
    }
  }

  /** Re-render a specific set of panes. */
  _renderPanes(...panes) {
    for (const pane of panes) {
      this._tabGroups.get(pane)?.rerender();
    }
  }

  // ── TabGroup factory ────────────────────────────────────────────────────────

  _newTabGroup(pane, { extraControls } = {}) {
    return new TabGroup({
      pane,
      layout:        this.layout,
      registry:      this.registry,
      instances:     this.instances,
      extraControls,
      onActivate:  (tab, p) => this._onActivate(tab, p),
      onClose:     (tab, p) => this._onClose(tab, p),
      onDragStart: (e, tab, p) => this._onDragStart(e, tab, p),
      onDrop:      (e, p) => this._onDrop(e, p),
      onReorder:   (tab, before, p) => this._onReorder(tab, before, p),
    });
  }

  // ── Collapse toggle ─────────────────────────────────────────────────────────

  _toggleBottomCollapse() {
    const collapsed = !this.layout.isBottomCollapsed();
    this.layout.setBottomCollapsed(collapsed);
    this.layout.save();

    const bottomEl = this._outerSplit.getPaneEl('bottom');
    if (collapsed) {
      const currentH = parseFloat(bottomEl.style.height);
      if (currentH > 34) this.layout.setBottomSize(currentH);
      bottomEl.style.height = '34px';
      bottomEl.dataset.collapsed = '';
    } else {
      delete bottomEl.dataset.collapsed;
      bottomEl.style.height = this.layout.getBottomSize() + 'px';
    }

    this._collapseBtn.textContent = collapsed ? '▲' : '▼';
  }

  // ── Tab event handlers ──────────────────────────────────────────────────────

  _onActivate(tab, pane) {
    this.layout.setActive(pane, tab);
    this._tabGroups.get(pane)?.setActive(tab);
  }

  _onClose(tab, pane) {
    this.layout.closeTab(pane, tab);
    const tg = this._tabGroups.get(pane);
    tg?.removeTabButton(tab);
    tg?.closePlugin(tab);
    const newActive = this.layout.layout[pane]?.active;
    if (newActive) tg?.setActive(newActive);
  }

  _onDragStart(e, tabId, fromPane) {
    this._dragState = { tabId, fromPane };
    e.dataTransfer.setData('text/plain', JSON.stringify({ tabId, fromPane }));
    e.dataTransfer.effectAllowed = 'move';
    this._showGhost(this.registry.getPlugin(tabId)?.title ?? tabId, e);
  }

  _onDrop(e, toPane) {
    this._hideGhost();

    let data = this._dragState;
    if (!data) {
      try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
    }
    this._dragState = null;

    const { tabId, fromPane } = data;

    // Same-pane drag → reorder
    if (fromPane === toPane) {
      const insertBefore = this._tabGroups.get(toPane)?._insertBefore ?? null;
      this._onReorder(tabId, insertBefore, toPane);
      return;
    }

    this.layout.moveTab(tabId, fromPane, toPane);

    const fromTg = this._tabGroups.get(fromPane);
    const toTg   = this._tabGroups.get(toPane);

    fromTg?.removeTabButton(tabId);
    toTg?.addTabButton(tabId);
    toTg?.adoptPlugin(tabId, fromPane);

    const fromActive = this.layout.layout[fromPane]?.active;
    if (fromActive) fromTg?.setActive(fromActive);
    toTg?.setActive(this.layout.layout[toPane]?.active);
    this.layout.save();
  }

  _onReorder(tabId, insertBefore, pane) {
    this.layout.reorderTab(pane, tabId, insertBefore);
    this._tabGroups.get(pane)?.reorderTabButton(tabId, insertBefore);
    this.layout.save();
  }

  // ── Save / reset layout ─────────────────────────────────────────────────────

  saveLayout() {
    this.layout.save();
  }

  /**
   * Activate a plugin by id — makes it the active tab in whichever pane contains it.
   * @param {string} id
   * @returns {boolean} true if found and activated
   */
  activatePlugin(id) {
    for (const pane of this._activePanes) {
      const cfg = this.layout.layout[pane];
      if (cfg?.tabs.includes(id)) {
        this.layout.setActive(pane, id);
        this._tabGroups.get(pane)?.setActive(id);
        return true;
      }
    }
    return false;
  }

  _teardownLayout() {
    for (const tg of this._tabGroups.values()) tg.unmount();
    this._centerInnerSplit?.unmount();
    this._centerInnerSplit = null;
    this._innerSplit?.unmount();
    this._outerSplit?.unmount();
    this._tabGroups.clear();
  }

  resetLayout() {
    this._teardownLayout();
    this.layout.reset();
    this._render();
  }

  /**
   * Apply an arbitrary layout object (e.g. from a workspace template).
   * Existing plugin instances are preserved; new ones are created as needed.
   * @param {object} layoutObj
   */
  applyLayout(layoutObj) {
    this._teardownLayout();
    this.layout.applyTemplate(layoutObj);
    this._instantiatePlugins();
    this._render();
  }

  // ── Drag ghost ──────────────────────────────────────────────────────────────

  _showGhost(text, e) {
    if (this._ghost) this._ghost.remove();

    const ghost = document.createElement('div');
    ghost.className = 'wb-ghost';
    ghost.textContent = text;
    document.body.appendChild(ghost);
    this._ghost = ghost;

    const move = (ev) => {
      ghost.style.left = ev.clientX + 'px';
      ghost.style.top  = ev.clientY + 'px';
    };

    document.addEventListener('mousemove', move);
    document.addEventListener('dragend', () => {
      document.removeEventListener('mousemove', move);
      this._hideGhost();
    }, { once: true });
  }

  _hideGhost() {
    this._ghost?.remove();
    this._ghost = null;
  }
}
