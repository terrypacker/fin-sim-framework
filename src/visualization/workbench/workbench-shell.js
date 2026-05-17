import { WorkbenchLayoutModel } from './layout-model.js';
import { PluginRegistry }       from './plugin-registry.js';
import { SplitPane }            from './split-pane.js';
import { TabGroup }             from './tab-group.js';
import { WorkbenchRuntime, WB_EVENTS } from './workbench-runtime.js';
import { WorkbenchChannel, WB_PANEL }  from './workbench-channel.js';

const STORAGE_KEY = 'sim-workbench-layout';
const H_PANES  = ['left', 'center', 'right'];
const ALL_PANES = [...H_PANES, 'bottom'];

/**
 * WorkbenchShell — assembles the full dockable workbench.
 *
 * Layout structure:
 *   outer vertical split ('main' / 'bottom')
 *     └── main  → inner horizontal split ('left' / 'center' / 'right')
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
 * @param {string}       [opts.panelUrl]     — URL of the detached-panel HTML page
 * @param {string}       [opts.channelName]  — BroadcastChannel name for cross-window sync
 */
export class WorkbenchShell {
  constructor({ defaultLayout, plugins = [], storageKey, panelUrl, channelName }) {
    this.runtime  = new WorkbenchRuntime();
    this.registry = new PluginRegistry();
    this.layout   = new WorkbenchLayoutModel(defaultLayout);
    this._storageKey = storageKey ?? STORAGE_KEY;
    this._panelUrl   = panelUrl ?? null;

    /** @type {Map<string, import('./component.js').WorkbenchComponent>} */
    this.instances = new Map();

    this._outerSplit = null;
    this._innerSplit = null;
    this._tabGroups  = new Map();   // pane name → TabGroup
    this._container  = null;
    this._dragState  = null;        // { tabId, fromPane }
    this._ghost      = null;
    this._collapseBtn = null;

    /** @type {Map<string, { win: Window, sourcePane: string }>} */
    this._detachedWindows = new Map();

    this._channel = channelName ? new WorkbenchChannel(channelName) : null;

    for (const descriptor of plugins) {
      this.registry.registerPlugin(descriptor);
    }
  }

  /**
   * Render the full workbench into `container`.
   * @param {HTMLElement} container
   */
  init(container) {
    this._container = container;
    this.layout.load(this._storageKey);

    if (this._channel) {
      this._channel.attachBus(this.runtime.bus, [
        WB_EVENTS.SELECTION_CHANGED,
        WB_EVENTS.RUNTIME_TICK,
        WB_EVENTS.SCENARIO_READY,
      ]);
      this._channel.onControl((msg) => {
        if (msg?.type === WB_PANEL.CLOSING) {
          this._reattachTab(msg.tabId, msg.sourcePane);
        }
      });
    }

    this._instantiatePlugins();
    this._render();
  }

  // ── Plugin instantiation ────────────────────────────────────────────────────

  _instantiatePlugins() {
    const allTabIds = new Set();
    for (const pane of ALL_PANES) {
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

    // Outer vertical split: 'main' (flex:1) + 'bottom' (fixed px)
    this._outerSplit = new SplitPane({ layout: this.layout, panes: ['main', 'bottom'], direction: 'vertical' });
    this._outerSplit.mount(this._container);

    // Inner horizontal split inside 'main'
    const mainEl = this._outerSplit.getPaneEl('main');
    this._innerSplit = new SplitPane({ layout: this.layout, panes: H_PANES });
    this._innerSplit.mount(mainEl);

    // Collapse toggle button — injected into the bottom TabGroup's tab bar
    this._collapseBtn = document.createElement('button');
    this._collapseBtn.className = 'wb-btn wb-btn--collapse';
    this._collapseBtn.title = 'Toggle panel';
    this._collapseBtn.textContent = this.layout.isBottomCollapsed() ? '▲' : '▼';
    this._collapseBtn.addEventListener('click', () => this._toggleBottomCollapse());

    // Bottom TabGroup
    const bottomTabGroup = new TabGroup({
      pane:          'bottom',
      layout:        this.layout,
      registry:      this.registry,
      instances:     this.instances,
      extraControls: this._collapseBtn,
      onActivate:  (tab, p) => this._onActivate(tab, p),
      onClose:     (tab, p) => this._onClose(tab, p),
      onDetach:    (tab, p) => this._onDetach(tab, p),
      onDragStart: (e, tab, p) => this._onDragStart(e, tab, p),
      onDrop:      (e, p) => this._onDrop(e, p),
    });
    bottomTabGroup.mount(this._outerSplit.getPaneEl('bottom'));
    this._tabGroups.set('bottom', bottomTabGroup);

    // Three horizontal pane TabGroups
    for (const pane of H_PANES) {
      const tabGroup = new TabGroup({
        pane,
        layout:    this.layout,
        registry:  this.registry,
        instances: this.instances,
        onActivate:  (tab, p) => this._onActivate(tab, p),
        onClose:     (tab, p) => this._onClose(tab, p),
        onDetach:    (tab, p) => this._onDetach(tab, p),
        onDragStart: (e, tab, p) => this._onDragStart(e, tab, p),
        onDrop:      (e, p) => this._onDrop(e, p),
      });

      tabGroup.mount(this._innerSplit.getPaneEl(pane));
      this._tabGroups.set(pane, tabGroup);
    }

    // Apply initial collapsed state
    if (this.layout.isBottomCollapsed()) {
      const bottomEl = this._outerSplit.getPaneEl('bottom');
      bottomEl.style.height = '34px';
      bottomEl.dataset.collapsed = '';
    }
  }

  /** Re-render all panes. */
  _renderAll() {
    for (const pane of ALL_PANES) {
      this._tabGroups.get(pane)?.rerender();
    }
  }

  /** Re-render a specific set of panes. */
  _renderPanes(...panes) {
    for (const pane of panes) {
      this._tabGroups.get(pane)?.rerender();
    }
  }

  // ── Collapse toggle ─────────────────────────────────────────────────────────

  _toggleBottomCollapse() {
    const collapsed = !this.layout.isBottomCollapsed();
    this.layout.setBottomCollapsed(collapsed);
    this.layout.save();

    const bottomEl = this._outerSplit.getPaneEl('bottom');
    if (collapsed) {
      // Save current height before collapsing
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
    // Use lightweight show/hide rather than full rerender for tab switches.
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

  _onDetach(tabId, pane) {
    if (!this._panelUrl) return;

    this.layout.closeTab(pane, tabId);
    const tg = this._tabGroups.get(pane);
    tg?.removeTabButton(tabId);
    tg?.closePlugin(tabId);
    const newActive = this.layout.layout[pane]?.active;
    if (newActive) tg?.setActive(newActive);

    const url = `${this._panelUrl}?tab=${encodeURIComponent(tabId)}&source=${encodeURIComponent(pane)}`;
    const win = window.open(url, `wb-panel-${tabId}`, 'width=800,height=600,menubar=no,toolbar=no,status=no');

    if (win) {
      this._detachedWindows.set(tabId, { win, sourcePane: pane });
    } else {
      // Popup blocked — restore tab immediately
      this.layout.addTab(pane, tabId);
      tg?.addTabButton(tabId);
      tg?.adoptPlugin(tabId);
      tg?.setActive(tabId);
    }
  }

  _reattachTab(tabId, sourcePane) {
    if (!this.instances.has(tabId)) return;
    const targetPane = (sourcePane && this.layout.layout[sourcePane]) ? sourcePane : H_PANES[0];
    this.layout.addTab(targetPane, tabId);
    const tg = this._tabGroups.get(targetPane);
    tg?.addTabButton(tabId);
    tg?.adoptPlugin(tabId);
    tg?.setActive(tabId);
    this._detachedWindows.delete(tabId);
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
    if (fromPane === toPane) return;

    this.layout.moveTab(tabId, fromPane, toPane);

    const fromTg = this._tabGroups.get(fromPane);
    const toTg   = this._tabGroups.get(toPane);

    fromTg?.removeTabButton(tabId);
    toTg?.addTabButton(tabId);
    toTg?.adoptPlugin(tabId);   // moves instance.el — appendChild handles cross-parent move

    // Sync tab bar highlights; fromGroup may need to show a different active tab now
    const fromActive = this.layout.layout[fromPane]?.active;
    if (fromActive) fromTg?.setActive(fromActive);
    toTg?.setActive(this.layout.layout[toPane]?.active);
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
    for (const pane of ALL_PANES) {
      const cfg = this.layout.layout[pane];
      if (cfg?.tabs.includes(id)) {
        this.layout.setActive(pane, id);
        // Lightweight show/hide — avoids destroying plugin DOM and invalidating
        // container references held by BaseApp (graphNodeInspector, etc.)
        this._tabGroups.get(pane)?.setActive(id);
        return true;
      }
    }
    return false;
  }

  resetLayout() {
    for (const tg of this._tabGroups.values()) tg.unmount();
    this._innerSplit?.unmount();
    this._outerSplit?.unmount();

    this.layout.reset();
    this._render();
  }

  /**
   * Apply an arbitrary layout object (e.g. from a workspace template).
   * Existing plugin instances are preserved; new ones are created as needed.
   * @param {object} layoutObj
   */
  applyLayout(layoutObj) {
    for (const tg of this._tabGroups.values()) tg.unmount();
    this._innerSplit?.unmount();
    this._outerSplit?.unmount();

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
