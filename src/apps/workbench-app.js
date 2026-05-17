import { WorkbenchShell }    from '../visualization/workbench/workbench-shell.js';
import { BaseApp }           from './base-app.js';
import { $, fmtUTC, fmtLocal } from '../visualization/ui-utils.js';
// Import all plugins
import { ScenarioPlugin }       from '../visualization/workbench/plugins/scenario-plugin.js';
import { ConfigGraphPlugin }    from '../visualization/workbench/plugins/config-graph-plugin.js';
import { ConfigListPlugin }     from '../visualization/workbench/plugins/config-list-plugin.js';
import { InspectorPlugin }      from '../visualization/workbench/plugins/inspector-plugin.js';
import { TimelinePlugin }       from '../visualization/workbench/plugins/timeline-plugin.js';
import { ChartPlugin }          from '../visualization/workbench/plugins/chart-plugin.js';
import { StatePanelPlugin }     from '../visualization/workbench/plugins/state-panel-plugin.js';
import { DashboardPlugin }      from '../visualization/workbench/plugins/dashboard-plugin.js';
import { McConfigPlugin }       from '../visualization/workbench/plugins/mc-config-plugin.js';
import { McResultsPlugin }      from '../visualization/workbench/plugins/mc-results-plugin.js';
import { McRunsPlugin }         from '../visualization/workbench/plugins/mc-runs-plugin.js';
import { OptConfigPlugin }      from '../visualization/workbench/plugins/opt-config-plugin.js';
import { OptResultsPlugin }     from '../visualization/workbench/plugins/opt-results-plugin.js';
import { OptRunsPlugin }        from '../visualization/workbench/plugins/opt-runs-plugin.js';
import { ExecHistoryPlugin }    from '../visualization/workbench/plugins/exec-history-plugin.js';
import { LineagePlugin }        from '../visualization/workbench/plugins/lineage-plugin.js';
import { PerfPlugin }           from '../visualization/workbench/plugins/perf-plugin.js';

const STORAGE_KEY = 'sim-workbench-layout-prod';

const PRODUCTION_PLUGINS = [
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

const PRODUCTION_LAYOUT = {
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

export class WorkbenchApp extends BaseApp {
  constructor(opts) {
    super(opts);
    this._wbShell = null;
  }

  // Override initScenario to notify the workbench runtime when a scenario is ready.
  initScenario() {
    super.initScenario();

    // Override the legacy tab-header click with a workbench-aware handler:
    // activate the state-panel plugin, then scroll actionPanelDetails into view.
    this._statePanelView.onShowActionDetail = () => {
      this._wbShell?.activatePlugin('state-panel');
      requestAnimationFrame(() => {
        document.getElementById('actionPanelDetails')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    };

    const runtime = this._wbShell?.runtime;
    if (!runtime || !this.scenario) return;

    // Publish SCENARIO_READY so PerfPlugin and other bus-aware plugins can wire up.
    runtime.scenarioReady(this.scenario);

    // Bridge sim-bus BREAKPOINT_HIT → workbench bus so timeline/graph plugins react.
    this.scenario.sim.bus.subscribe('BREAKPOINT_HIT', (msg) => {
      runtime.breakpointHit({
        nodeId: msg.nodeId,
        stage:  msg.stage,
        date:   msg.date,
        kind:   msg.kind,
      });
      // Highlight the last journaled action row in the timeline (the entry just before pause).
      const journal = this.scenario?.sim?.journal?.journal;
      if (journal?.length > 0) {
        const lastSeq = journal[journal.length - 1].seq;
        this.timelinePresenter?._view?.highlightBreakpoint(lastSeq);
      }
    });
  }

  // Override initView to set up the workbench shell instead of static DOM wiring
  initView() {
    const container = document.getElementById('workbench-root');
    if (!container) {
      console.error('WorkbenchApp: #workbench-root element not found');
      return;
    }

    this._wbShell = new WorkbenchShell({
      defaultLayout: PRODUCTION_LAYOUT,
      plugins:       PRODUCTION_PLUGINS,
      storageKey:    STORAGE_KEY,
      panelUrl:      'workbench-panel-prod.html',
      channelName:   'sim-workbench-prod',
    });
    this._wbShell.init(container);

    // Bind scenario tab view now that ScenarioPlugin DOM exists
    this._scenarioTabView.bind();

    // Wire simulation controls (the subset of BaseApp.initView() that still applies)
    this._wireSimControls();

    // Initialize the live state DOM now that StatePanelPlugin is mounted
    this._statePanelView.initLiveState();
  }

  _wireSimControls() {
    $('displayCurrency')?.addEventListener('change', () => {
      if (this.timeControls) this.timeControls.displayCurrency = $('displayCurrency').value;
      this.destroyScenario();
      this.initScenario();
    });

    $('tzSelect')?.addEventListener('change', () => {
      const fmt = $('tzSelect').value === 'utc' ? fmtUTC : fmtLocal;
      if (this.timeControls) this.timeControls.setFormatDate(fmt);
      this._statePanelView.formatDate = fmt;
      this.destroyScenario();
      this.initScenario();
    });

    $('playPause')?.addEventListener('click', () => {
      if (this._animator?.playing) this._animator.stopPlaying();
      else                         this._animator?.startPlaying();
    });

    const stepForwardButton = $('stepForward');
    const stepBackButton    = $('stepBackward');

    stepForwardButton?.addEventListener('click', () => {
      const ctrl = this.scenario?.sim?.control;
      if (ctrl?.paused) {
        if (!ctrl.pendingExecution) ctrl.resuming = true;
        ctrl.paused        = false;
        ctrl.breakpointHit = null;
        this._animator?.clearBreakpointStatus();
      }
      this.showBusyInputOverlay(stepBackButton, () => this.timeControls.stepForward());
      if (ctrl?.paused) this._animator?.showBreakpointPaused(ctrl.breakpointHit);
    });

    stepBackButton?.addEventListener('click', () => {
      this.showBusyInputOverlay(stepBackButton, () => this.timeControls.stepBack());
    });

    $('resetBtn')?.addEventListener('click', () => this.timeControls?.reset());

    let sliderTimeout;
    $('timeSlider')?.addEventListener('input', () => {
      clearTimeout(sliderTimeout);
      sliderTimeout = setTimeout(() => {
        const val = +$('timeSlider').value;
        if (val >= this.lastSliderValue) {
          this.showBusyInputOverlay(stepBackButton, () => this.timeControls.stepTo(val / 100));
        } else {
          this.showBusyInputOverlay(stepBackButton, () => this.timeControls.rewindTo(val / 100));
        }
        this.lastSliderValue = val;
      }, 60);
    });

    // rebuildBtn is inside ScenarioPlugin — wired once it's mounted
    $('rebuildBtn')?.addEventListener('click', () => {
      this.destroyScenario();
      this.initScenario();
    });

    window.addEventListener('resize', () => this.resizeCanvases());
  }

  // Override resizeCanvases to work without the old static DOM structure
  resizeCanvases() {
    const canvas = document.getElementById('chartCanvas');
    if (canvas) {
      const wrap = canvas.parentElement;
      if (wrap) {
        canvas.width  = wrap.clientWidth;
        canvas.height = wrap.clientHeight;
      }
    }
  }

  // Override tab-switching callbacks to use workbench shell
  _replayMcRun(run) {
    this._replayParams = run.params;
    this.destroyScenario();
    this.initScenario();
    this._wbShell?.activatePlugin('timeline');
  }

  _applyOptCandidate(params) {
    this._replayParams = params;
    this.destroyScenario();
    this.initScenario();
    this._wbShell?.activatePlugin('chart');
  }

  _showGraphEditTab() {
    this._wbShell?.activatePlugin('inspector');
  }
}
