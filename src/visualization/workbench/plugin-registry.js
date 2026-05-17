/**
 * PluginRegistry — maps plugin IDs to their descriptors.
 *
 * Plugins are registered with a descriptor produced by `definePlugin()`:
 *   { id, title, component, category?, defaultPane? }
 *
 * The registry stores descriptors only; WorkbenchShell is responsible for instantiation.
 */
export class PluginRegistry {
  constructor() {
    this._plugins = new Map();
  }

  /**
   * @param {{ id: string, title: string, component: Function, category?: string, defaultPane?: string|null }} descriptor
   */
  registerPlugin({ id, title, component, category, defaultPane }) {
    if (this._plugins.has(id)) throw new Error(`Plugin '${id}' already registered`);
    this._plugins.set(id, {
      id,
      title,
      component,
      category:    category    ?? 'general',
      defaultPane: defaultPane ?? null,
    });
  }

  /** @returns {{ id, title, component, category, defaultPane } | null} */
  getPlugin(id) {
    return this._plugins.get(id) ?? null;
  }

  /** @returns {Array<{ id, title, component, category, defaultPane }>} */
  getAllPlugins() {
    return [...this._plugins.values()];
  }
}
