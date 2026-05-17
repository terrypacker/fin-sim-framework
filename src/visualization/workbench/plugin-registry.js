/**
 * PluginRegistry — maps plugin IDs to their descriptors.
 *
 * Plugins are registered with { id, title, component } where `component`
 * is a WorkbenchComponent subclass. The registry stores descriptors only;
 * the WorkbenchShell is responsible for instantiation.
 */
export class PluginRegistry {
  constructor() {
    this._plugins = new Map();
  }

  /**
   * @param {{ id: string, title: string, component: typeof WorkbenchComponent }} descriptor
   */
  registerPlugin({ id, title, component }) {
    if (this._plugins.has(id)) throw new Error(`Plugin '${id}' already registered`);
    this._plugins.set(id, { id, title, component });
  }

  /** @returns {{ id, title, component } | null} */
  getPlugin(id) {
    return this._plugins.get(id) ?? null;
  }

  /** @returns {Array<{ id, title, component }>} */
  getAllPlugins() {
    return [...this._plugins.values()];
  }
}
