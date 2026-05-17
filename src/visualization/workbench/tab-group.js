import { WorkbenchComponent } from './component.js';

/**
 * TabGroup — renders a tab bar and the active plugin panel for one pane.
 *
 * All plugin instances are pre-instantiated by WorkbenchShell and passed via
 * the `instances` map. This means every plugin's bus subscriptions are active
 * at all times, regardless of which tab is currently visible.
 *
 * Mount strategy: ALL tabs in the pane are mounted when the TabGroup mounts.
 * Inactive plugins are hidden via display:none. Tab switching is a show/hide
 * operation — no mount/unmount per switch. This ensures every plugin's DOM
 * is always in the document, which is required for getElementById() calls in
 * BaseApp.initScenario() and for plugins that depend on each other's containers.
 *
 * @param {object} opts
 * @param {string}                         opts.pane           — 'left' | 'center' | 'right' | 'bottom'
 * @param {WorkbenchLayoutModel}           opts.layout         — shared layout model
 * @param {PluginRegistry}                 opts.registry       — for title lookup
 * @param {Map<string, WorkbenchComponent>} opts.instances     — pre-instantiated plugins
 * @param {HTMLElement}                    [opts.extraControls] — appended right-aligned in tab bar
 * @param {function(string, string): void}  opts.onActivate    — (tab, pane) tab became active
 * @param {function(string, string): void}  opts.onClose       — (tab, pane) tab closed
 * @param {function(string, string): void}  [opts.onDetach]    — (tab, pane) tab detached to window
 * @param {function(DragEvent, string, string): void} opts.onDragStart — drag started
 * @param {function(DragEvent, string): void}         opts.onDrop      — dropped onto pane
 */
export class TabGroup extends WorkbenchComponent {
  constructor({ pane, layout, registry, instances, extraControls, onActivate, onClose, onDetach, onDragStart, onDrop }) {
    super();
    this.pane          = pane;
    this.layout        = layout;
    this.registry      = registry;
    this.instances     = instances;
    this.extraControls = extraControls ?? null;
    this.onActivate    = onActivate;
    this.onClose       = onClose;
    this.onDetach      = onDetach ?? null;
    this.onDragStart   = onDragStart;
    this.onDrop        = onDrop;
    this._activeInstance = null;
  }

  render() {
    const root = document.createElement('div');
    root.className = 'wb-tabgroup';
    root.dataset.pane = this.pane;

    root.appendChild(this._buildTabBar());
    root.appendChild(this._buildView());

    // Drop target for tab migration
    root.addEventListener('dragover', (e) => {
      e.preventDefault();
      root.classList.add('wb-dragover');
    });
    root.addEventListener('dragleave', (e) => {
      if (!root.contains(e.relatedTarget)) {
        root.classList.remove('wb-dragover');
      }
    });
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      root.classList.remove('wb-dragover');
      this.onDrop?.(e, this.pane);
    });

    return root;
  }

  onMount() {
    this._mountAll();
  }

  onUnmount() {
    // Unmount all plugin instances whose DOM lives inside this TabGroup's element.
    // We cannot rely on paneConfig.tabs here because a tab may have been removed
    // from the layout before this fires (e.g., _onClose then _renderPanes).
    for (const [, instance] of this.instances) {
      if (instance.mounted && this.el?.contains(instance.el)) {
        instance.unmount();
      }
    }
    this._activeInstance = null;
  }

  _buildTabBar() {
    const bar = document.createElement('div');
    bar.className = 'wb-tabs';

    const paneConfig = this.layout.layout[this.pane];

    for (const tabId of paneConfig.tabs) {
      bar.appendChild(this._buildTab(tabId, tabId === paneConfig.active));
    }

    if (this.extraControls) {
      this.extraControls.classList.add('wb-tab-extra');
      bar.appendChild(this.extraControls);
    }

    return bar;
  }

  _buildTab(tabId, isActive) {
    const descriptor = this.registry.getPlugin(tabId);
    const title = descriptor?.title ?? tabId;

    const tab = document.createElement('div');
    tab.className = 'wb-tab' + (isActive ? ' active' : '');
    tab.draggable = true;
    tab.dataset.tab = tabId;

    const titleEl = document.createElement('span');
    titleEl.className = 'wb-tab-title';
    titleEl.textContent = title;

    const detachEl = document.createElement('span');
    detachEl.className = 'wb-tab-detach';
    detachEl.textContent = '⤢';
    detachEl.title = 'Detach to window';

    const closeEl = document.createElement('span');
    closeEl.className = 'wb-tab-close';
    closeEl.textContent = '×';
    closeEl.title = 'Close';

    tab.append(titleEl, detachEl, closeEl);

    tab.addEventListener('click', (e) => {
      if (e.target === closeEl) {
        this.onClose?.(tabId, this.pane);
      } else if (e.target === detachEl) {
        this.onDetach?.(tabId, this.pane);
      } else {
        this.onActivate?.(tabId, this.pane);
      }
    });

    tab.addEventListener('dragstart', (e) => {
      this.onDragStart?.(e, tabId, this.pane);
    });

    return tab;
  }

  _buildView() {
    const view = document.createElement('div');
    view.className = 'wb-view';
    return view;
  }

  /**
   * Mount all plugins in this pane. Active plugin is shown; others are hidden.
   * Called on initial mount and after structural layout changes (close/drag).
   */
  _mountAll() {
    const paneConfig = this.layout.layout[this.pane];
    if (!paneConfig) return;
    const view = this.el?.querySelector('.wb-view');
    if (!view) return;

    const activeId = paneConfig.active;

    for (const tabId of paneConfig.tabs) {
      const instance = this.instances.get(tabId);
      if (!instance) continue;

      if (!instance.mounted) {
        instance.mount(view);
      }

      // Show active, hide others
      if (instance.el) {
        instance.el.style.display = tabId === activeId ? '' : 'none';
      }
    }

    this._activeInstance = this.instances.get(activeId) ?? null;
  }

  // ── Surgical DOM operations ─────────────────────────────────────────────────
  // These avoid the destroy-and-recreate cycle of rerender() so that plugin
  // state and external references (e.g. BaseApp holding DOM ids) survive moves.

  /** Remove a tab button from the bar. Does not touch the plugin instance. */
  removeTabButton(tabId) {
    this.el?.querySelector(`.wb-tab[data-tab="${tabId}"]`)?.remove();
  }

  /** Add a tab button for a tab now assigned to this pane by the layout model. */
  addTabButton(tabId) {
    const bar = this.el?.querySelector('.wb-tabs');
    if (!bar) return;
    const paneConfig = this.layout.layout[this.pane];
    const tab = this._buildTab(tabId, paneConfig?.active === tabId);
    const extra = bar.querySelector('.wb-tab-extra');
    bar.insertBefore(tab, extra ?? null);
  }

  /**
   * Move or mount a plugin's DOM element into this pane's view area.
   * If the instance is already mounted elsewhere, `appendChild` moves its el.
   * If it was previously unmounted (e.g. after close), it is remounted.
   */
  adoptPlugin(tabId) {
    const instance = this.instances.get(tabId);
    const view     = this.el?.querySelector('.wb-view');
    if (!instance || !view) return;

    if (instance.mounted && instance.el) {
      view.appendChild(instance.el);
    } else {
      instance.mount(view);
    }

    const paneConfig = this.layout.layout[this.pane];
    if (instance.el) {
      instance.el.style.display = (paneConfig?.active === tabId) ? '' : 'none';
    }
  }

  /** Unmount a plugin that is being closed, leaving it in the instances map. */
  closePlugin(tabId) {
    const instance = this.instances.get(tabId);
    if (instance?.mounted && this.el?.contains(instance.el)) {
      instance.unmount();
    }
  }

  /**
   * Switch the visible plugin without unmounting/remounting.
   * Called by WorkbenchShell when the user clicks a tab.
   * @param {string} tabId
   */
  setActive(tabId) {
    const paneConfig = this.layout.layout[this.pane];
    if (!paneConfig) return;

    // Update tab bar highlight
    this.el?.querySelectorAll('.wb-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tabId);
    });

    // Show / hide plugin panels
    for (const id of paneConfig.tabs) {
      const instance = this.instances.get(id);
      if (instance?.el) {
        instance.el.style.display = id === tabId ? '' : 'none';
      }
    }

    this._activeInstance = this.instances.get(tabId) ?? null;
  }
}
