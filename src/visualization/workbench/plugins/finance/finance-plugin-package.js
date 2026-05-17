/**
 * Finance Plugin Package — registers all finance-domain workbench plugins in one call.
 *
 * Import FINANCE_PLUGINS to pass to WorkbenchShell; import FINANCE_DEFAULT_LAYOUT for the
 * default production pane arrangement.
 */

import { ScenarioPlugin }    from './scenario-plugin.js';
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
import { ExecHistoryPlugin } from './exec-history-plugin.js';
import { LineagePlugin }     from './lineage-plugin.js';
import { PerfPlugin }        from './perf-plugin.js';

export { ScenarioPlugin, ConfigGraphPlugin, ConfigListPlugin, InspectorPlugin,
         TimelinePlugin, ChartPlugin, StatePanelPlugin, DashboardPlugin,
         McConfigPlugin, McResultsPlugin, McRunsPlugin,
         OptConfigPlugin, OptResultsPlugin, OptRunsPlugin,
         ExecHistoryPlugin, LineagePlugin, PerfPlugin };

/** All finance plugin descriptors — pass directly to WorkbenchShell `plugins` option. */
export const FINANCE_PLUGINS = [
  { id: 'scenario',     title: 'Scenario',      component: ScenarioPlugin    },
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
  { id: 'mc-runs',      title: 'MC Runs',       component: McRunsPlugin      },
  { id: 'opt-runs',     title: 'OPT Runs',      component: OptRunsPlugin     },
  { id: 'exec-history', title: 'Node History',  component: ExecHistoryPlugin },
  { id: 'lineage',      title: 'Lineage',       component: LineagePlugin     },
  { id: 'dashboard',    title: 'Dashboard',     component: DashboardPlugin   },
  { id: 'perf',         title: 'Performance',   component: PerfPlugin        },
];

/** Default production layout — matches the pre-workbench left/center/right arrangement. */
export const FINANCE_DEFAULT_LAYOUT = {
  sizes: [1, 2, 1],
  left: {
    tabs: ['scenario', 'mc-config', 'opt-config', 'config-list', 'inspector'],
    active: 'scenario',
  },
  center: {
    tabs: ['config-graph', 'timeline', 'chart', 'mc-results', 'opt-results'],
    active: 'config-graph',
  },
  right: {
    tabs: ['state-panel', 'mc-runs', 'opt-runs', 'exec-history', 'lineage'],
    active: 'state-panel',
  },
  bottom: {
    tabs: ['dashboard', 'perf'],
    active: 'dashboard',
  },
  bottomSize: 110,
  bottomCollapsed: false,
};
