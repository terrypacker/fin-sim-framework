import { BaseComponent } from '../components/base-component.js';

/**
 * WorkbenchComponent — base class for all dockable workbench panels.
 *
 * Lifecycle:
 *   mount(container)            — render to DOM (only once); re-appends on remounts
 *   unmount()                   — remove from DOM; bus subscriptions remain active
 *   rerender()                  — unmount + re-mount in same parent (for layout changes)
 *   destroy()                   — full teardown including bus subscriptions (inherited from BaseComponent)
 *   onAdopt(fromPane, toPane)   — called when the plugin is moved to a different pane via drag-and-drop
 *
 * Subclasses override:
 *   render()                    → returns a DOM element (called ONCE; element is reused on remounts)
 *   onInit()                    → called ONCE on first mount (use for bus subscriptions — survives unmount)
 *   onMount()                   → called on EVERY mount including remounts (use for DOM-level setup)
 *   onUnmount()                 → called before element is removed
 *   onAdopt(fromPane, toPane)   → called after the element is moved to a new pane (drag-and-drop)
 */
export class WorkbenchComponent extends BaseComponent {
  constructor() {
    super();
    this.el = null;
    this._mounted = false;
    this._didInit = false;
  }

  render() {
    return document.createElement('div');
  }

  mount(container) {
    if (!this.el) {
      this.el = this.render();
    }
    container.appendChild(this.el);
    this._mounted = true;
    if (!this._didInit) {
      this._didInit = true;
      this.onInit?.();
    }
    this.onMount?.();
  }

  unmount() {
    if (!this._mounted) return;
    this.onUnmount?.();
    this.el?.remove();
    this._mounted = false;
  }

  rerender() {
    if (!this._mounted || !this.el) return;
    const parent = this.el.parentNode;
    this.unmount();
    this.mount(parent);
  }

  get mounted() {
    return this._mounted;
  }
}
