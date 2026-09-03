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

export { ScenarioPlugin, ParametersPlugin, ConfigGraphPlugin, ConfigListPlugin, InspectorPlugin,
         TimelinePlugin, ChartPlugin, StatePanelPlugin, DashboardPlugin,
         McConfigPlugin, McResultsPlugin, McRunsPlugin,
         OptConfigPlugin, OptResultsPlugin, OptRunsPlugin,
         ExecHistoryPlugin, LineagePlugin, PerfPlugin, ActionDetailPlugin,
         JournalReportPlugin, ScenarioComparePlugin,
         DgConfigPlugin, DgResultsPlugin, CrossActionQueryPlugin, HoldingsPlugin,
         AllocationPlugin, SecuritiesPlugin, SpendingPlugin, LiquidityPoolsPlugin, PaychequePlugin, MpcCockpitPlugin };

/** All finance plugin descriptors — pass directly to WorkbenchShell `plugins` option. */
export const FINANCE_PLUGINS = [
  { id: 'scenario',     title: 'Scenario',      component: ScenarioPlugin    },
  { id: 'parameters',   title: 'Parameters',    component: ParametersPlugin  },
  { id: 'mc-config',    title: 'Monte Carlo',   component: McConfigPlugin    },
  { id: 'opt-config',   title: 'Optimize',      component: OptConfigPlugin   },
  { id: 'config-list',  title: 'Nodes',         component: ConfigListPlugin  },
  { id: 'inspector',    title: 'Edit',          component: InspectorPlugin   },
  { id: 'config-graph', title: 'Graph',         component: ConfigGraphPlugin },
  { id: 'timeline',     title: 'Timeline',      component: TimelinePlugin    },
  { id: 'chart',        title: 'Chart',         component: ChartPlugin       },
  { id: 'mc-results',   title: 'MC Results',    component: McResultsPlugin   },
  { id: 'opt-results',  title: 'OPT Results',   component: OptResultsPlugin  },
  { id: 'state-panel',  title: 'State',         component: StatePanelPlugin  },
  { id: 'holdings',     title: 'Holdings',      component: HoldingsPlugin    },
  { id: 'allocation',   title: 'Allocation',    component: AllocationPlugin  },
  { id: 'securities',   title: 'Securities',    component: SecuritiesPlugin  },
  { id: 'spending',     title: 'Spending',      component: SpendingPlugin    },
  { id: 'pools',        title: 'Liquidity Pools', component: LiquidityPoolsPlugin },
  { id: 'paycheque',    title: 'Paycheque',     component: PaychequePlugin   },
  { id: 'mc-runs',      title: 'MC Runs',       component: McRunsPlugin      },
  { id: 'opt-runs',     title: 'OPT Runs',      component: OptRunsPlugin     },
  { id: 'exec-history',   title: 'Node History',    component: ExecHistoryPlugin  },
  { id: 'lineage',        title: 'Lineage',         component: LineagePlugin      },
  { id: 'action-detail',  title: 'Action Detail',   component: ActionDetailPlugin },
  { id: 'journal-report',       title: 'Journal Report',    component: JournalReportPlugin      },
  { id: 'cross-action-query',  title: 'Field × Action',    component: CrossActionQueryPlugin   },
  { id: 'scenario-compare',  title: 'Scenario Compare',  component: ScenarioComparePlugin },
  { id: 'dg-config',   title: 'Decision Graph', component: DgConfigPlugin    },
  { id: 'dg-results',  title: 'DG Results',    component: DgResultsPlugin   },
  { id: 'mpc-cockpit', title: 'MPC Cockpit',   component: MpcCockpitPlugin  },
  { id: 'dashboard',    title: 'Dashboard',     component: DashboardPlugin   },
  { id: 'perf',         title: 'Performance',   component: PerfPlugin        },
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
    tabs: ['state-panel', 'action-detail', 'mc-runs', 'opt-runs', 'exec-history', 'lineage'],
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
