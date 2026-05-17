import { BaseComponent } from '../components/base-component.js';

/**
 * WorkbenchComponent — base class for all dockable workbench panels.
 *
 * Lifecycle:
 *   mount(container)  — render to DOM; keeps bus subscriptions alive when unmounted
 *   unmount()         — remove from DOM; bus subscriptions remain active
 *   rerender()        — unmount + re-mount in same parent (for layout changes)
 *   destroy()         — full teardown including bus subscriptions (inherited from BaseComponent)
 *
 * Subclasses override:
 *   render()    → returns a DOM element
 *   onInit()    → called ONCE on first mount (use for bus subscriptions — survives unmount)
 *   onMount()   → called on EVERY mount including remounts (use for DOM-level setup)
 *   onUnmount() → called before element is removed
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
    this.el = this.render();
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
