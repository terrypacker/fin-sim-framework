/**
 * WorkbenchPlugin SDK — formal descriptor interface and registration helpers.
 *
 * Every plugin descriptor must conform to:
 *
 *   {
 *     id:          string                      — unique kebab-case identifier
 *     title:       string                      — display name in the tab bar
 *     component:   typeof WorkbenchComponent   — class (not instance) to mount
 *     category?:   PLUGIN_CATEGORIES value     — semantic grouping (default: 'general')
 *     defaultPane?: PLUGIN_PANES value         — preferred pane when auto-placed (default: null)
 *   }
 *
 * Use `definePlugin()` to construct descriptors — it validates required fields and fills defaults.
 */

export const PLUGIN_CATEGORIES = /** @type {const} */ ({
  SIMULATION:    'simulation',
  CONFIGURATION: 'configuration',
  ANALYSIS:      'analysis',
  DEBUG:         'debug',
  SYSTEM:        'system',
  GENERAL:       'general',
});

export const PLUGIN_PANES = /** @type {const} */ ({
  LEFT:   'left',
  CENTER: 'center',
  RIGHT:  'right',
  BOTTOM: 'bottom',
});

/**
 * Construct and validate a plugin descriptor.
 *
 * @param {{
 *   id:          string,
 *   title:       string,
 *   component:   Function,
 *   category?:   string,
 *   defaultPane?: string,
 * }} descriptor
 * @returns {Readonly<{ id: string, title: string, component: Function, category: string, defaultPane: string|null }>}
 */
export function definePlugin({ id, title, component, category, defaultPane }) {
  if (!id || typeof id !== 'string')       throw new Error('definePlugin: id must be a non-empty string');
  if (!title || typeof title !== 'string') throw new Error('definePlugin: title must be a non-empty string');
  if (typeof component !== 'function')     throw new Error(`definePlugin: component for '${id}' must be a class`);

  return Object.freeze({
    id,
    title,
    component,
    category:    category    ?? PLUGIN_CATEGORIES.GENERAL,
    defaultPane: defaultPane ?? null,
  });
}
