import { WorkbenchShell }    from '../visualization/workbench/workbench-shell.js';
import { BaseApp }           from './base-app.js';
import { $, fmtUTC, fmtLocal } from '../visualization/ui-utils.js';
import {
  FINANCE_PLUGINS,
  FINANCE_DEFAULT_LAYOUT,
} from '../visualization/workbench/plugins/finance/finance-plugin-package.js';

const STORAGE_KEY = 'sim-workbench-layout-prod';

// ── Built-in workspace templates ────────────────────────────────────────────

const CENTER_SPLIT_DEFAULTS = {
  centerSplit: false, centerSplitDir: 'h', centerInnerSizes: [1, 1],
  'center-a': { tabs: [], active: null }, 'center-b': { tabs: [], active: null },
};

const ANALYSIS_LAYOUT = {
  sizes: [1, 2, 1],
  left:   { tabs: ['scenario', 'mc-config', 'opt-config'],             active: 'mc-config'  },
  center: { tabs: ['chart', 'mc-results', 'opt-results', 'timeline'],  active: 'chart'      },
  right:  { tabs: ['mc-runs', 'opt-runs', 'state-panel'],              active: 'mc-runs'    },
  bottom: { tabs: ['dashboard', 'perf'],                               active: 'dashboard'  },
  bottomSize: 110, bottomCollapsed: false, ...CENTER_SPLIT_DEFAULTS,
};

const DEBUGGING_LAYOUT = {
  sizes: [1, 3, 1],
  left:   { tabs: ['config-list', 'scenario'],                                  active: 'config-list' },
  center: { tabs: ['config-graph', 'timeline'],                                 active: 'config-graph'},
  right:  { tabs: ['inspector', 'exec-history', 'lineage', 'state-panel'],      active: 'exec-history'},
  bottom: { tabs: ['perf', 'dashboard'],                                        active: 'perf'        },
  bottomSize: 110, bottomCollapsed: false, ...CENTER_SPLIT_DEFAULTS,
};

const REVIEW_LAYOUT = {
  sizes: [1, 3, 1],
  left:   { tabs: ['scenario', 'config-list'],                                  active: 'scenario'   },
  center: { tabs: ['timeline', 'chart'],                                        active: 'timeline'   },
  right:  { tabs: ['state-panel', 'inspector', 'exec-history', 'lineage'],      active: 'state-panel'},
  bottom: { tabs: ['dashboard'],                                                active: 'dashboard'  },
  bottomSize: 110, bottomCollapsed: false, ...CENTER_SPLIT_DEFAULTS,
};

const BUILTIN_TEMPLATES = {
  Default:   FINANCE_DEFAULT_LAYOUT,
  Analysis:  ANALYSIS_LAYOUT,
  Debugging: DEBUGGING_LAYOUT,
  Review:    REVIEW_LAYOUT,
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
      defaultLayout: FINANCE_DEFAULT_LAYOUT,
      plugins:       FINANCE_PLUGINS,
      storageKey:    STORAGE_KEY,
    });
    this._wbShell.init(container);

    // Bind scenario tab view now that ScenarioPlugin DOM exists
    this._scenarioTabView.bind();

    // Wire simulation controls (the subset of BaseApp.initView() that still applies)
    this._wireSimControls();

    // Wire workspace template picker
    this._wireTemplates();

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

  _wireTemplates() {
    const select  = document.getElementById('workbenchTemplate');
    const saveBtn = document.getElementById('btnSaveTemplate');
    const delBtn  = document.getElementById('btnDeleteTemplate');
    if (!select) return;

    const refresh = () => {
      select.innerHTML = '';

      const builtinGroup = document.createElement('optgroup');
      builtinGroup.label = 'Built-in';
      for (const name of Object.keys(BUILTIN_TEMPLATES)) {
        const opt = document.createElement('option');
        opt.value = `builtin:${name}`;
        opt.textContent = name;
        builtinGroup.appendChild(opt);
      }
      select.appendChild(builtinGroup);

      const saved = this._wbShell.layout.listSavedTemplates();
      if (saved.length > 0) {
        const savedGroup = document.createElement('optgroup');
        savedGroup.label = 'Saved';
        for (const name of saved) {
          const opt = document.createElement('option');
          opt.value = `saved:${name}`;
          opt.textContent = name;
          savedGroup.appendChild(opt);
        }
        select.appendChild(savedGroup);
      }

      delBtn.disabled = !select.value.startsWith('saved:');
    };

    refresh();

    select.addEventListener('change', () => {
      const val = select.value;
      let layoutObj;
      if (val.startsWith('builtin:')) {
        layoutObj = BUILTIN_TEMPLATES[val.slice(8)];
      } else if (val.startsWith('saved:')) {
        layoutObj = this._wbShell.layout.loadTemplate(val.slice(6));
      }
      if (layoutObj) this._wbShell.applyLayout(layoutObj);
      delBtn.disabled = !val.startsWith('saved:');
    });

    saveBtn?.addEventListener('click', () => {
      const name = prompt('Template name:');
      if (!name?.trim()) return;
      this._wbShell.layout.saveTemplate(name.trim());
      refresh();
      // Select the newly saved template
      const opt = [...select.options].find(o => o.value === `saved:${name.trim()}`);
      if (opt) { select.value = opt.value; delBtn.disabled = false; }
    });

    delBtn?.addEventListener('click', () => {
      const val = select.value;
      if (!val.startsWith('saved:')) return;
      const name = val.slice(6);
      if (confirm(`Delete template "${name}"?`)) {
        this._wbShell.layout.deleteTemplate(name);
        refresh();
      }
    });
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
