import { WorkbenchComponent } from './component.js';

/**
 * TabGroup — renders a tab bar and the active plugin panel for one pane.
 *
 * All plugin instances are pre-instantiated by WorkbenchShell and passed via
 * the `instances` map. This means every plugin's bus subscriptions are active
 * at all times, regardless of which tab is currently visible.
 *
 * @param {object} opts
 * @param {string}                         opts.pane           — 'left' | 'center' | 'right' | 'bottom'
 * @param {WorkbenchLayoutModel}           opts.layout         — shared layout model
 * @param {PluginRegistry}                 opts.registry       — for title lookup
 * @param {Map<string, WorkbenchComponent>} opts.instances     — pre-instantiated plugins
 * @param {HTMLElement}                    [opts.extraControls] — appended right-aligned in tab bar
 * @param {function(string, string): void}  opts.onActivate    — (tab, pane) tab became active
 * @param {function(string, string): void}  opts.onClose       — (tab, pane) tab closed
 * @param {function(DragEvent, string, string): void} opts.onDragStart — drag started
 * @param {function(DragEvent, string): void}         opts.onDrop      — dropped onto pane
 */
export class TabGroup extends WorkbenchComponent {
  constructor({ pane, layout, registry, instances, extraControls, onActivate, onClose, onDragStart, onDrop }) {
    super();
    this.pane          = pane;
    this.layout        = layout;
    this.registry      = registry;
    this.instances     = instances;
    this.extraControls = extraControls ?? null;
    this.onActivate    = onActivate;
    this.onClose       = onClose;
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
    this._mountActive();
  }

  onUnmount() {
    if (this._activeInstance) {
      this._activeInstance.unmount();
      this._activeInstance = null;
    }
  }

  _buildTabBar() {
    const bar = document.createElement('div');
    bar.className = 'wb-tabs';

    const paneConfig = this.layout.layout[this.pane];

    for (const tabId of paneConfig.tabs) {
      bar.appendChild(this._buildTab(tabId, tabId === paneConfig.active));
    }

    if (this.extraControls) {
      this.extraControls.style.marginLeft = 'auto';
      this.extraControls.style.alignSelf  = 'center';
      this.extraControls.style.marginRight = '4px';
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

    const closeEl = document.createElement('span');
    closeEl.className = 'wb-tab-close';
    closeEl.textContent = '×';
    closeEl.title = 'Close';

    tab.append(titleEl, closeEl);

    tab.addEventListener('click', (e) => {
      if (e.target === closeEl) {
        this.onClose?.(tabId, this.pane);
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

  _mountActive() {
    const paneConfig = this.layout.layout[this.pane];
    const activeId = paneConfig.active;
    if (!activeId) return;

    const instance = this.instances.get(activeId);
    if (!instance) return;

    // Unmount previous if different
    if (this._activeInstance && this._activeInstance !== instance) {
      this._activeInstance.unmount();
    }

    const view = this.el?.querySelector('.wb-view');
    if (!view) return;

    this._activeInstance = instance;
    if (!instance.mounted) {
      instance.mount(view);
    }
  }
}
