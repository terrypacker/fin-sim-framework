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
