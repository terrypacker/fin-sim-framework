/**
 * Finance Plugin Package — registers all finance-domain workbench plugins in one call.
 *
 * Import FINANCE_PLUGINS to pass to WorkbenchShell; import FINANCE_DEFAULT_LAYOUT for the
 * default production pane arrangement.
 */

import { ScenarioPlugin }    from './scenario-plugin.js';
import { ParametersPlugin } from './parameters-plugin.js';
import { ConfigGraphPlugin } from './config-graph-plugin.js';
import { ConfigListPlugin }  from './config-list-plugin.js';
import { InspectorPlugin }   from './inspector-plugin.js';
import { TimelinePlugin }    from './timeline-plugin.js';
import { ChartPlugin }       from './chart-plugin.js';
import { StatePanelPlugin }  from './state-panel-plugin.js';
import { WatchlistPlugin }   from './watchlist-plugin.js';
import { DashboardPlugin }   from './dashboard-plugin.js';
import { McConfigPlugin }    from './mc-config-plugin.js';
import { McResultsPlugin }   from './mc-results-plugin.js';
import { McRunsPlugin }      from './mc-runs-plugin.js';
import { OptConfigPlugin }   from './opt-config-plugin.js';
import { OptResultsPlugin }  from './opt-results-plugin.js';
import { OptRunsPlugin }     from './opt-runs-plugin.js';
import { ExecHistoryPlugin }     from './exec-history-plugin.js';
import { LineagePlugin }         from './lineage-plugin.js';
import { PerfPlugin }            from './perf-plugin.js';
import { ActionDetailPlugin }    from './action-detail-plugin.js';
import { JournalReportPlugin }     from './journal-report-plugin.js';
import { ScenarioComparePlugin }   from './scenario-compare-plugin.js';
import { DgConfigPlugin }          from './dg-config-plugin.js';
import { DgResultsPlugin }         from './dg-results-plugin.js';
import { CrossActionQueryPlugin }  from './cross-action-query-plugin.js';
import { HoldingsPlugin }          from './holdings-plugin.js';
import { AllocationPlugin }        from './allocation-plugin.js';
import { SecuritiesPlugin }        from './securities-plugin.js';
import { SpendingPlugin }          from './spending-plugin.js';
import { LiquidityPoolsPlugin }    from './liquidity-pools-plugin.js';
import { PaychequePlugin }         from './paycheque-plugin.js';
import { MpcCockpitPlugin }        from './mpc-cockpit-plugin.js';
import { HelpPlugin }              from './help-plugin.js';
import { PLUGIN_CATEGORIES as C } from '../../plugin-sdk.js';

export { ScenarioPlugin, ParametersPlugin, ConfigGraphPlugin, ConfigListPlugin, InspectorPlugin,
         TimelinePlugin, ChartPlugin, StatePanelPlugin, WatchlistPlugin, DashboardPlugin,
         McConfigPlugin, McResultsPlugin, McRunsPlugin,
         OptConfigPlugin, OptResultsPlugin, OptRunsPlugin,
         ExecHistoryPlugin, LineagePlugin, PerfPlugin, ActionDetailPlugin,
         JournalReportPlugin, ScenarioComparePlugin,
         DgConfigPlugin, DgResultsPlugin, CrossActionQueryPlugin, HoldingsPlugin,
         AllocationPlugin, SecuritiesPlugin, SpendingPlugin, LiquidityPoolsPlugin, PaychequePlugin, MpcCockpitPlugin, HelpPlugin };

/**
 * All finance plugin descriptors — pass directly to WorkbenchShell `plugins` option.
 * `category` is the heading the header's Panels menu files each one under.
 */
export const FINANCE_PLUGINS = [
  { id: 'scenario',     title: 'Scenario',      component: ScenarioPlugin,    category: C.CONFIGURATION },
  { id: 'parameters',   title: 'Parameters',    component: ParametersPlugin,  category: C.CONFIGURATION },
  { id: 'mc-config',    title: 'Monte Carlo',   component: McConfigPlugin,    category: C.STUDIES },
  { id: 'opt-config',   title: 'Optimize',      component: OptConfigPlugin,   category: C.STUDIES },
  { id: 'config-list',  title: 'Nodes',         component: ConfigListPlugin,  category: C.CONFIGURATION },
  { id: 'inspector',    title: 'Edit',          component: InspectorPlugin,   category: C.CONFIGURATION },
  { id: 'config-graph', title: 'Graph',         component: ConfigGraphPlugin, category: C.CONFIGURATION },
  { id: 'timeline',     title: 'Timeline',      component: TimelinePlugin,    category: C.SIMULATION },
  { id: 'chart',        title: 'Chart',         component: ChartPlugin,       category: C.SIMULATION },
  { id: 'mc-results',   title: 'MC Results',    component: McResultsPlugin,   category: C.STUDIES },
  { id: 'opt-results',  title: 'OPT Results',   component: OptResultsPlugin,  category: C.STUDIES },
  { id: 'state-panel',  title: 'State',         component: StatePanelPlugin,  category: C.SIMULATION },
  { id: 'watchlist',    title: 'Watchlist',     component: WatchlistPlugin,   category: C.SIMULATION },
  { id: 'holdings',     title: 'Holdings',      component: HoldingsPlugin,    category: C.PORTFOLIO },
  { id: 'allocation',   title: 'Allocation',    component: AllocationPlugin,  category: C.PORTFOLIO },
  { id: 'securities',   title: 'Securities',    component: SecuritiesPlugin,  category: C.PORTFOLIO },
  { id: 'spending',     title: 'Spending',      component: SpendingPlugin,    category: C.PORTFOLIO },
  { id: 'pools',        title: 'Liquidity Pools', component: LiquidityPoolsPlugin, category: C.PORTFOLIO },
  { id: 'paycheque',    title: 'Paycheque',     component: PaychequePlugin,   category: C.PORTFOLIO },
  { id: 'mc-runs',      title: 'MC Runs',       component: McRunsPlugin,      category: C.STUDIES },
  { id: 'opt-runs',     title: 'OPT Runs',      component: OptRunsPlugin,     category: C.STUDIES },
  { id: 'exec-history',   title: 'Node History',    component: ExecHistoryPlugin,  category: C.DEBUG },
  { id: 'lineage',        title: 'Lineage',         component: LineagePlugin,      category: C.DEBUG },
  { id: 'action-detail',  title: 'Action Detail',   component: ActionDetailPlugin, category: C.DEBUG },
  { id: 'journal-report',       title: 'Journal Report',    component: JournalReportPlugin,      category: C.DEBUG },
  { id: 'cross-action-query',  title: 'Field × Action',    component: CrossActionQueryPlugin,   category: C.DEBUG },
  { id: 'scenario-compare',  title: 'Scenario Compare',  component: ScenarioComparePlugin, category: C.STUDIES },
  { id: 'dg-config',   title: 'Decision Graph', component: DgConfigPlugin,    category: C.STUDIES },
  { id: 'dg-results',  title: 'DG Results',    component: DgResultsPlugin,   category: C.STUDIES },
  { id: 'mpc-cockpit', title: 'MPC Cockpit',   component: MpcCockpitPlugin,  category: C.STUDIES },
  { id: 'dashboard',    title: 'Dashboard',     component: DashboardPlugin,   category: C.SIMULATION },
  { id: 'perf',         title: 'Performance',   component: PerfPlugin,        category: C.DEBUG },
  // Last in the list, first in the right pane's tab order: the Help panel follows the
  // active tab (design 108 §8), so it is useful from boot rather than after a setup step.
  { id: 'help',         title: 'Help',          component: HelpPlugin,        category: C.SYSTEM },
];

/** Default production layout — matches the pre-workbench left/center/right arrangement. */
export const FINANCE_DEFAULT_LAYOUT = {
  sizes: [1, 2, 1],
  left: {
    tabs: ['scenario', 'mc-config', 'opt-config', 'dg-config', 'config-list', 'inspector'],
    active: 'scenario',
  },
  center: {
    tabs: ['config-graph', 'parameters', 'timeline', 'chart', 'allocation', 'securities', 'spending', 'pools', 'paycheque', 'holdings', 'mpc-cockpit', 'mc-results', 'opt-results', 'dg-results'],
    active: 'config-graph',
  },
  right: {
    tabs: ['state-panel', 'watchlist', 'help', 'action-detail', 'mc-runs', 'opt-runs', 'exec-history', 'lineage'],
    active: 'state-panel',
  },
  bottom: {
    tabs: ['journal-report', 'cross-action-query', 'scenario-compare', 'dashboard', 'perf'],
    active: 'journal-report',
  },
  bottomSize:       110,
  bottomCollapsed:  false,
  centerSplit:      false,
  centerSplitDir:   'h',
  centerInnerSizes: [1, 1],
  'center-a':       { tabs: [], active: null },
  'center-b':       { tabs: [], active: null },
};

// ── Built-in views ───────────────────────────────────────────────────────────

const CENTER_SPLIT_DEFAULTS = {
  centerSplit: false, centerSplitDir: 'h', centerInnerSizes: [1, 1],
  'center-a': { tabs: [], active: null }, 'center-b': { tabs: [], active: null },
};

/**
 * The header's built-in views, one per task, in picker order.
 *
 * Each is EXHAUSTIVE: the panels it lists are the only ones it opens, and every other
 * panel is recorded as closed when it is applied (`WorkbenchLayoutModel.applyTemplate`).
 * So a panel added to `FINANCE_PLUGINS` later does NOT appear in any of these until it is
 * placed here on purpose — only Everything, which is `FINANCE_DEFAULT_LAYOUT`, has it.
 *
 * Help is in every view's right pane: it follows the active tab (design 108 §8), so it
 * explains whatever you are looking at without being asked.
 */
export const FINANCE_VIEW_TEMPLATES = {
  // Author a plan: the graph, its nodes and the form that edits them.
  Build: {
    sizes: [1, 2, 1],
    left:   { tabs: ['scenario', 'config-list', 'inspector'],          active: 'scenario' },
    center: { tabs: ['config-graph', 'parameters', 'timeline'],        active: 'config-graph' },
    right:  { tabs: ['help', 'state-panel'],                           active: 'help' },
    bottom: { tabs: ['journal-report'],                                active: 'journal-report' },
    bottomSize: 110, bottomCollapsed: true, ...CENTER_SPLIT_DEFAULTS,
  },
  // Read one deterministic run: where the money went, and what the portfolio became.
  Results: {
    sizes: [1, 3, 1],
    left:   { tabs: ['scenario', 'watchlist'],                         active: 'scenario' },
    center: { tabs: ['chart', 'timeline', 'spending', 'allocation', 'pools', 'paycheque', 'holdings', 'securities'],
              active: 'chart' },
    right:  { tabs: ['state-panel', 'help'],                           active: 'state-panel' },
    bottom: { tabs: ['journal-report', 'dashboard'],                   active: 'journal-report' },
    bottomSize: 110, bottomCollapsed: false, ...CENTER_SPLIT_DEFAULTS,
  },
  // Many runs: Monte Carlo, the optimizer, decision graphs and the MPC cockpit.
  Studies: {
    sizes: [1, 2, 1],
    left:   { tabs: ['mc-config', 'opt-config', 'dg-config', 'scenario'], active: 'mc-config' },
    center: { tabs: ['mc-results', 'opt-results', 'dg-results', 'mpc-cockpit', 'chart'], active: 'mc-results' },
    right:  { tabs: ['mc-runs', 'opt-runs', 'help'],                   active: 'mc-runs' },
    bottom: { tabs: ['scenario-compare', 'dashboard'],                 active: 'scenario-compare' },
    bottomSize: 110, bottomCollapsed: true, ...CENTER_SPLIT_DEFAULTS,
  },
  // Why did it do that: the journal, the actions behind a number, and a node's history.
  Debug: {
    sizes: [1, 2, 1],
    left:   { tabs: ['scenario', 'config-list'],                       active: 'scenario' },
    center: { tabs: ['timeline', 'config-graph', 'chart'],             active: 'timeline' },
    right:  { tabs: ['action-detail', 'exec-history', 'lineage', 'state-panel', 'watchlist', 'help'],
              active: 'action-detail' },
    bottom: { tabs: ['journal-report', 'cross-action-query', 'perf'],  active: 'journal-report' },
    bottomSize: 160, bottomCollapsed: false, ...CENTER_SPLIT_DEFAULTS,
  },
  // Every panel — what "Show all panels" returns to.
  Everything: FINANCE_DEFAULT_LAYOUT,
};

/** The view a first visit opens in (no saved layout yet). */
export const FINANCE_INITIAL_VIEW = 'Results';
