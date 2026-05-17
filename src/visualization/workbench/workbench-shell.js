import { WorkbenchLayoutModel } from './layout-model.js';
import { PluginRegistry }       from './plugin-registry.js';
import { SplitPane }            from './split-pane.js';
import { TabGroup }             from './tab-group.js';
import { WorkbenchRuntime }     from './workbench-runtime.js';

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
 * @param {object}       opts.defaultLayout — initial layout if no persisted state
 * @param {Array<{ id, title, component }>} opts.plugins — plugin descriptors to register
 */
export class WorkbenchShell {
  constructor({ defaultLayout, plugins = [] }) {
    this.runtime  = new WorkbenchRuntime();
    this.registry = new PluginRegistry();
    this.layout   = new WorkbenchLayoutModel(defaultLayout);

    /** @type {Map<string, import('./component.js').WorkbenchComponent>} */
    this.instances = new Map();

    this._outerSplit = null;
    this._innerSplit = null;
    this._tabGroups  = new Map();   // pane name → TabGroup
    this._container  = null;
    this._dragState  = null;        // { tabId, fromPane }
    this._ghost      = null;
    this._collapseBtn = null;

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
    this.layout.load(STORAGE_KEY);

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
    this._collapseBtn.className = 'wb-btn';
    this._collapseBtn.style.cssText = 'padding:2px 8px;font-size:10px;';
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
    this._renderPanes(pane);
  }

  _onClose(tab, pane) {
    this.layout.closeTab(pane, tab);
    this._renderPanes(pane);
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
    this._renderPanes(fromPane, toPane);
  }

  // ── Save / reset layout ─────────────────────────────────────────────────────

  saveLayout() {
    this.layout.save();
  }

  resetLayout() {
    for (const tg of this._tabGroups.values()) tg.unmount();
    this._innerSplit?.unmount();
    this._outerSplit?.unmount();

    this.layout.reset();
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
