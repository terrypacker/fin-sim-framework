import { EventBus } from '../../simulation-framework/event-bus.js';

/** UI-layer event types — distinct from simulation bus messages. */
export const WB_EVENTS = {
  SELECTION_CHANGED:   'workbench.selection.changed',
  RUNTIME_TICK:        'workbench.runtime.tick',
  BREAKPOINT_HIT:      'workbench.breakpoint.hit',
  SCENARIO_READY:      'workbench.scenario.ready',
  LAYOUT_CHANGED:      'workbench.layout.changed',
  JOURNAL_REPORT_OPEN:        'workbench.journal.report.open',
  CROSS_ACTION_QUERY_OPEN:    'workbench.cross.action.query.open',
  ACTION_ENTRY_OPEN:          'workbench.action.entry.open',
  DISPLAY_SETTINGS_CHANGED:   'workbench.display.settings.changed',
  // A non-UI writer changed the active scenario's param VALUES in place (the MPC
  // harvest, design 39 §13.5 rule 4). The Scenario panel holds that array by
  // reference, so without this the values change under it and the editors keep
  // rendering the stale ones.
  PARAMS_CHANGED:             'workbench.scenario.params.changed',
};

/**
 * WorkbenchRuntime — session-level singleton holding shared UI state
 * and the WorkbenchBus (a separate EventBus instance from the sim bus).
 *
 * Plugins subscribe to `runtime.bus` in their constructors; subscriptions
 * persist for the session regardless of whether the plugin is mounted.
 */
export class WorkbenchRuntime {
  constructor() {
    this.bus = new EventBus();

    this.selection  = null;     // { type, id, data } | null
    this.sim        = { running: false, time: 0 };
    this.breakpoints = new Set();

    this._simAdapter = null;    // set by WorkbenchShell after scenario is ready
    this._paneHosts  = new Map();   // see paneHost()
  }

  /**
   * The DOM host for a panel, owned by the RUNTIME rather than by the plugin.
   *
   * ### The bug this exists to make unreachable
   *
   * A workbench plugin's `render()` runs on its first MOUNT, so a panel the user has
   * CLOSED has no DOM at all. Most of these panels are thin shims whose only job is to
   * mint an id'd div; the real component is built by `WorkbenchApp.initScenario()`, which
   * found it with `getElementById`. So a saved layout with any of those tabs closed handed
   * `null` to a constructor that dereferences it, and the throw was uncaught at boot —
   * skipping everything after it, including the scenario list. The app read as "no
   * scenarios" with the cause in a layout key, which is nowhere near where anyone looks.
   *
   * The invariant that fixes it: **the element's lifetime follows the SESSION, not the
   * panel's visibility.** That is the runtime's lifetime, and it is also the lifetime of
   * the things that hold the element — the presenters, the graph renderer, the animator
   * and the editor factory are all built at `initScenario()` regardless of what is on
   * screen, and they keep working across Rebuild.
   *
   * ### Why a PAIR, and why the ids stay
   *
   * `outer` is what the panel displays and `inner` is what the component fills. They are
   * separate because several consumers insert siblings ABOVE the content —
   * `ConfigGraphView` does `panel.insertBefore(bar, graphRoot)` — so the content div needs
   * a parent from the moment it EXISTS, not from the moment it is displayed. A bare
   * detached div moves the same crash one line down.
   *
   * The `id` is kept on `inner` even though nothing needs to look it up any more: the
   * stylesheets select on it (`#graphRoot`, `#mcConfigPane`, …), and it is what makes a
   * detached host recognisable in a debugger.
   *
   * @param {string} id                      the element id, unique per panel
   * @param {object} [opts]
   * @param {string} [opts.outerClass='wb-plugin-fill']
   * @param {string} [opts.innerClass='wb-plugin-fill']
   * @returns {{ outer: HTMLElement, inner: HTMLElement }} the same pair on every call
   */
  paneHost(id, { outerClass = 'wb-plugin-fill', innerClass = 'wb-plugin-fill' } = {}) {
    let host = this._paneHosts.get(id);
    if (!host) {
      const outer = document.createElement('div');
      if (outerClass) outer.className = outerClass;
      const inner = document.createElement('div');
      inner.id = id;
      if (innerClass) inner.className = innerClass;
      outer.appendChild(inner);
      host = { outer, inner };
      this._paneHosts.set(id, host);
    }
    return host;
  }

  /**
   * The config graph's host — `paneHost` with the graph's own classes, and named because
   * it has three callers (the app, the plugin, and the view that inserts a filter bar
   * above the root).
   *
   * @returns {{ outer: HTMLElement, root: HTMLElement }}
   */
  graphHost() {
    const { outer, inner } = this.paneHost('graphRoot', { outerClass: 'wb-graph-outer', innerClass: '' });
    return { outer, root: inner };
  }

  /**
   * Wire to the simulation adapter (scenario + animator).
   * Called by the shell after a scenario is built.
   */
  wireSimAdapter(adapter) {
    this._simAdapter = adapter;
  }

  /** Broadcast a selection change to all subscribed panels. */
  select(item) {
    this.selection = item;
    this.bus.publish({ type: WB_EVENTS.SELECTION_CHANGED, selection: item });
  }

  /** Broadcast a runtime tick (simulation time advanced). */
  tick(time) {
    this.sim.time = time;
    this.bus.publish({ type: WB_EVENTS.RUNTIME_TICK, time });
  }

  /**
   * Broadcast a breakpoint pause.
   * @param {{ nodeId, stage, date, kind, node? }} hit — mirrors BreakpointHitMessage fields
   */
  breakpointHit(hit) {
    this.bus.publish({ type: WB_EVENTS.BREAKPOINT_HIT, hit });
  }

  /** Broadcast that a scenario is ready for use. */
  scenarioReady(scenario) {
    this.bus.publish({ type: WB_EVENTS.SCENARIO_READY, scenario });
  }
}
