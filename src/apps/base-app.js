/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { $, fmtUTC, fmtLocal }     from '../visualization/ui-utils.js';
import { BaseScenario }            from '../scenarios/base-scenario.js';
import { ScenarioSerializer }      from '../scenarios/scenario-serializer.js';
import { ChartController }          from '../visualization/chart/chart-controller.js';
import { ChartView }                from '../visualization/chart/chart-view.js';
import { ChartPresenter }           from '../visualization/chart/chart-presenter.js';
import { TimelineController }        from '../visualization/timeline/timeline-controller.js';
import { TimelineView }             from '../visualization/timeline/timeline-view.js';
import { TimelinePresenter }        from '../visualization/timeline/timeline-presenter.js';
import { TimeControls }             from '../visualization/time-controls.js';
import { GraphBuilderPresenter }    from '../visualization/graph-builder/graph-builder-presenter.js';
import { ConfigGraphView }          from '../visualization/graph-builder/config-graph-view.js';
import { ServiceRegistry }          from '../services/service-registry.js';
import {
  BusMessage, EXECUTION_KINDS, EXECUTION_PHASES,
  SIMULATION_BUS_MESSAGES,
  SimulationBusMessage
} from '../simulation-framework/bus-messages.js';
import { PeopleController }              from '../visualization/people/people-controller.js';
import { PersonEditor }                  from '../visualization/people/person-editor.js';
import { AccountsController }            from '../visualization/accounts/accounts-controller.js';
import { AccountEditor }                 from '../visualization/accounts/account-editor.js';
import { NodeEditModal }                 from '../visualization/components/node-edit-modal.js';
import { ConfigurationListComponent }    from '../visualization/configuration/configuration-list.js';
import { ScenarioTabPresenter }     from '../visualization/scenario/scenario-tab-presenter.js';
import { StatePanelView }           from '../visualization/simulation/state-panel-view.js';
import { SimulationAnimator }       from '../visualization/simulation/simulation-animator.js';
import {BaseComponent} from "../visualization/components/base-component.js";
import {ScenarioTabView} from "../visualization/scenario/scenario-tab-view.js";
import { JournalReportingService } from '../finance/journal-reporting-service.js';
import { TaxDocumentModal }        from '../visualization/timeline/tax-document-modal.js';
import {
  ScenarioTabController
} from "../visualization/scenario/scenario-tab-controller.js";
import { MonteCarloView }       from '../visualization/monte-carlo/monte-carlo-view.js';
import { MonteCarloController } from '../visualization/monte-carlo/monte-carlo-controller.js';
import { MonteCarloPresenter }  from '../visualization/monte-carlo/monte-carlo-presenter.js';
import { OptimizationView }       from '../visualization/optimization/optimization-view.js';
import { OptimizationController } from '../visualization/optimization/optimization-controller.js';
import { OptimizationPresenter }  from '../visualization/optimization/optimization-presenter.js';
import { GraphNodeInspectorPanel } from '../visualization/graph-builder/graph-node-inspector-panel.js';
import { GraphNodeExecHistory }    from '../visualization/graph-builder/graph-node-exec-history.js';
import { GraphNodeLineage }        from '../visualization/graph-builder/graph-node-lineage.js';

/**
 * BaseApp — composition root.
 *
 * Instantiates and wires all sub-modules.  Contains no domain logic,
 * no DOM-rendering logic, and no state-management logic.
 *
 * Sub-modules:
 *   ScenarioTabPresenter       — scenario CRUD UI and data
 *   StatePanelView             — state/metrics panels and value formatting
 *   SimulationAnimator         — playback, config-graph highlighting, dashboard cards
 *   ConfigurationListComponent — unified config list (recreated per buildScenario)
 *   NodeEditModal              — modal editor for any config node (created once)
 *   GraphBuilderPresenter      — event-graph editor (recreated per buildScenario)
 */
export class BaseApp extends BaseComponent {
  /**
   * @param {object}            opts
   * @param {PrebuiltScenario[]} [opts.prebuiltScenarios=[]] - Pre-built scenario descriptors.
   * @param {Function}          [opts.newScenario]  - Legacy single-factory fallback.
   * @param {Array|null}        [opts.chartSeries]  - Chart series config.
   */
  constructor({ chartSeries, prebuiltScenarios = [] }) {
    super(  )
    this.chartSeries = chartSeries ?? null;
    this._prebuiltScenarios = prebuiltScenarios;
    this.scenario    = null; //TODO Remove for #146

    // UI handles (recreated each buildScenario)
    this.configGraphView       = null;
    this.configPresenter       = null;
    this.chartPresenter        = null;
    this.timelinePresenter     = null;
    this.timeControls          = null;
    this.configList            = null;
    this.scenarioTabPresenter  = null;
    this._animator             = null;
    this.mcPresenter           = null;
    this.optPresenter          = null;
    this._replayParams         = null;
    this._graphNodeInspector   = null;
    this._graphNodeExecHistory = null;
    this._graphNodeLineage     = null;

    // Created once — survive scenario rebuilds.
    this._statePanelView  = new StatePanelView();
    this._scenarioTabView = new ScenarioTabView();
    this._reportingService = new JournalReportingService();
    this._taxDocModal      = new TaxDocumentModal();
    this._editModal        = new NodeEditModal();

    // Tab header references set by initView()
    this.scenarioTabHeader = null;
    this._graphEditTabHeader = null;

    // Playback/slider state
    this.lastSliderValue = 0;
    this._currentDate    = null;
  }

  // ── Core lifecycle ────────────────────────────────────────────────────────

  /**
   * Load in currently selected scenario
   */
  initScenario() {
    //TODO Clean up for #146
    const registry = ServiceRegistry.getInstance();
    registry.scenarioRegistry.loadPrebuilt(this._prebuiltScenarios);

    // Register the generic fallback used when an uploaded scenario has no scenarioId.
    // BaseScenario has no domain defaults — buildDefaultInitialState returns null (empty
    // state) and loadDefaults is a no-op, so ScenarioSerializer.deserialize() owns setup.
    registry.scenarioService.setFallbackFactory(
      (params, initialState, simStart, simEnd) => new BaseScenario({
        context: registry.simulationContext,
        params,
        initialState,
        simStart,
        simEnd,
      })
    );

    // ── Config graph (visual node canvas + filter bar) ────────────────────────
    this.configGraphView = new ConfigGraphView({
      parent: null,
      graph: registry.graph,
      graphQueryApi: registry.graphQueryApi,
      graphRoot:               document.getElementById('graphRoot'),
      displayNodeStateChanges: (changes) => this._statePanelView.showNodeStateChanges(changes),
      bus:                     registry.bus,
    });

    this.configPresenter = new GraphBuilderPresenter({
      graphRenderer: this.configGraphView.graphRenderer,
      eventService:   registry.eventService,
      handlerService: registry.handlerService,
      actionService:  registry.actionService,
      reducerService: registry.reducerService,
      onEditNode: (node) => this._openNodeInInspector(node),
    });

    //TODO This should be put into the builder-presenter too
    // Breakpoint listener: delegate to animator once it is created.
    this.configPresenter._graphRenderer.registerBreakpointChangeListener((node) => {
      this._animator?.toggleBreakpoint(node);
    });

    // ── People / Accounts controllers ────────────────────────────────────────
    const peopleController   = new PeopleController({ personService: registry.personService });
    const accountsController = new AccountsController({ accountService: registry.accountService });

    // ── Configuration list (left panel) ──────────────────────────────────────
    this.configList = new ConfigurationListComponent({
      parent:        this,
      container:     document.getElementById('configGroupNodes'),
      graphQueryApi: registry.graphQueryApi,
      bus:           registry.bus,
    });

    this.configList.onItemClick = (node) => this._openNodeInInspector(node);

    this.configList.onAddClick = (kind) => {
      if (kind === 'person') {
        this._editModal.open({ kind: 'person', id: null, name: 'New Person' });
      } else if (kind === 'account') {
        this._editModal.open({ kind: 'account', id: null, name: 'New Account' });
      } else {
        const newNode = this.configPresenter.createNode(kind, null);
        this._editModal.open(newNode);
      }
    };

    // ── Shared editor factory (used by modal and inspector panel) ─────────────
    const editorFactory = (node, container) => {
      if (node?.kind === 'person') {
        const editor = new PersonEditor({
          container,
          node,
          onSave: (data) => {
            if (data.id) {
              const { id, ...changes } = data;
              peopleController.update(id, changes);
            } else {
              peopleController.create(data);
            }
            this._editModal.close();
          },
          onDelete: (id) => {
            peopleController.delete(id);
            this._editModal.close();
          },
        });
        editor.render();
        return editor;
      }

      if (node?.kind === 'account') {
        const people = registry.graphQueryApi.getByKind('person');
        const editor = new AccountEditor({
          container,
          node,
          people,
          onSave: (data) => {
            if (data.id) {
              const { id, type: _type, ...changes } = data;
              accountsController.update(id, changes);
            } else {
              accountsController.create(data);
            }
            this._editModal.close();
          },
          onDelete: (id) => {
            accountsController.delete(id);
            this._editModal.close();
          },
          onHistory: (account) => {
            const journal = this.scenario?.sim?.journal;
            const entries = journal
              ? accountsController.getHistory(account.id, journal)
              : [];
            this._showAccountHistory(entries, account.name, account.currency?.symbol ?? '$');
          },
        });
        editor.render();
        return editor;
      }

      // Graph nodes: event / handler / action / reducer
      return this.configPresenter._view.createAndRenderEditor(node, container);
    };

    this._editModal.setEditorFactory(editorFactory);

    // ── Graph node inspector panel (left column EDIT sub-tab) ─────────────────
    this._graphNodeInspector = new GraphNodeInspectorPanel({
      container:  document.getElementById('graphNodeEditPane'),
      onShowTab:  () => this._showGraphEditTab(),
    });
    this._graphNodeInspector.setEditorFactory(editorFactory);

    // ── Graph node execution history (right column GRAPH group) ───────────────
    this._graphNodeExecHistory = new GraphNodeExecHistory({
      container:     document.getElementById('graphNodeHistoryPane'),
      graphRenderer: this.configGraphView.graphRenderer,
      graphQueryApi: registry.graphQueryApi,
    });

    this._graphNodeLineage = new GraphNodeLineage({
      container:     document.getElementById('graphNodeLineagePane'),
      graphQueryApi: registry.graphQueryApi,
    });

    // Wire node click → exec history + lineage panels
    this.configPresenter._graphRenderer.registerNodeClickListener((_evt, node) => {
      this._graphNodeExecHistory.showNode(node);
      this._graphNodeLineage.showNode(node);
    });

    // Scenario Tab
    const scenarioTabController = new ScenarioTabController({ scenarioService: registry.scenarioService })
    this.scenarioTabPresenter = new ScenarioTabPresenter({
      controller: scenarioTabController,
      view: this._scenarioTabView,
      bus: registry.bus,
      initScenario: () => { this.destroyScenario(); this.initScenario(); },
      getBuiltScenario: () => this.scenario,
    });

    // ── Build scenario ────────────────────────────────────────────────────────
    //This will create the active scenario
    this.scenario = registry.scenarioService.createActiveScenario();
    if (this._replayParams) {
      this.scenario.params = this._replayParams;
      this._replayParams = null;
    }
    this.scenario.buildSim();

    // Scenarios with serialized config (events/handlers/etc.) restore themselves
    // via ScenarioSerializer.deserialize() rather than loadDefaults(), which
    // would otherwise re-create the domain defaults from scratch.
    const activeConfig = registry.scenarioService.getActive();
    const hasSerializedConfig = (activeConfig?.events?.length  > 0)
                             || (activeConfig?.handlers?.length > 0)
                             || (activeConfig?.actions?.length  > 0)
                             || (activeConfig?.reducers?.length > 0);
    if (hasSerializedConfig) {
      ScenarioSerializer.deserialize(activeConfig, registry);
    } else {
      this.scenario.loadDefaults();
    }
    // Derive display settings from DOM so rebuilds preserve user selections.
    const currentFmt      = $('tzSelect')?.value === 'utc' ? fmtUTC : fmtLocal;
    const currentCurrency = $('displayCurrency')?.value ?? 'USD';

    this._statePanelView.formatDate     = currentFmt;
    this._statePanelView.schemaRegistry = registry.schemaRegistry;
    this._statePanelView.journal        = this.scenario.sim.journal;
    this._statePanelView.executionGraph = this.scenario.sim.executionGraph;
    this._statePanelView.onOpenNode     = (nodeId) => {
      const node = registry.graph.getNode(nodeId);
      if (node) this._editModal.open(node);
    };
    this._statePanelView.onShowActionDetail = () => {
      document.querySelector('.tab-header[data-dest-tab="right-action-detail"]')?.click();
    };

    // ── Visualization views ───────────────────────────────────────────────────
    const eventColors = new Map(
        registry.eventService.getAll()
        .filter(e => e.enabled && e.interval)
        .map(e => [e.type, e.color])
        .filter(([, c]) => c)
    );

    const chartController = new ChartController();
    const chartView = new ChartView({
      container: $('chartContainer'),
      simStart:  this.scenario.simStart,
      simEnd:    this.scenario.simEnd,
      series:    this.chartSeries ?? undefined,
    });
    this.chartPresenter = new ChartPresenter({ controller: chartController, view: chartView });
    this.chartPresenter.startViz();

    this.timelinePresenter = new TimelinePresenter({
      controller:    new TimelineController(),
      view:          new TimelineView({ container: $('timelineContainer') }),
      onDetail:      (entry) => this._statePanelView.showNodeDetail(entry),
      onTaxDocument: (entry) => {
        const doc = this._reportingService.generate(entry);
        if (doc) this._taxDocModal.open(doc);
      },
      onRewind: (date) => {
        const pct     = (date.getTime() - this.scenario.simStart.getTime()) /
            (this.scenario.simEnd.getTime() - this.scenario.simStart.getTime());
        const clamped = Math.max(0, Math.min(1, pct));
        this.timeControls.rewindTo(clamped);
        const sliderVal    = Math.round(clamped * 100);
        $('timeSlider').value = sliderVal;
        this.lastSliderValue  = sliderVal;
      },
      onNavigateToNode: (nodeId) => {
        const node = registry.graph.getNode(nodeId);
        if (node) this._editModal.open(node);
      },
      formatDate: currentFmt,
    });
    this.timelinePresenter.attach(this.scenario.sim.journal);
    this.timelinePresenter.schemaRegistry = registry.schemaRegistry;

    this.timeControls = new TimeControls({
      scenario:        this.scenario,
      configPresenter: this.configPresenter,
      timelineView:    this.timelinePresenter,
      chartView:       this.chartPresenter,
      timeLabel:       $('timeLabel'),
      timeSlider:      $('timeSlider'),
      formatDate:      currentFmt,
      displayCurrency: currentCurrency,
      onReset: (date, state) => {
        this._animator?.updateDashCards(date);
        this._statePanelView.updateStatePanel(date, state);
      },
    });

    // ── Simulation animator ───────────────────────────────────────────────────
    this._animator = new SimulationAnimator({
      scenario:       this.scenario,
      timeControls:   this.timeControls,
      statePanelView: this._statePanelView,
      chartView:      this.chartPresenter,
      graphRenderer:  this.configPresenter._graphRenderer,
    });

    this._animator.toggleBreakpoint();
    this._animator.wireSimBus(this.scenario.sim.bus);
    this._graphNodeExecHistory?.wireSimBus(this.scenario.sim.bus);
    this._graphNodeLineage?.wireSimBus(this.scenario.sim.bus);

    // Track _currentDate for subclass access.
    this.scenario.sim.bus.subscribe(`EXECUTION_${EXECUTION_PHASES.BEGIN}`, { kind: EXECUTION_KINDS.EVENT }, ({ date }) => {
      this._currentDate = new Date(date);
    });

    this._animator.updateDashCards(this.scenario.simStart);

    $('timeSlider').value      = 0;
    this.lastSliderValue       = 0;
    this._currentDate          = this.scenario.simStart;
    $('timeLabel').textContent = this.timeControls.formatDate(this.scenario.simStart);

    // ── Monte Carlo ───────────────────────────────────────────────────────────────
    this.mcPresenter = new MonteCarloPresenter({
      controller: new MonteCarloController(),
      view:       new MonteCarloView(),
      scenario:   this.scenario,
    });
    this.mcPresenter.onReplayRun = (run) => this._replayMcRun(run);

    // ── Optimization ──────────────────────────────────────────────────────────────
    this.optPresenter = new OptimizationPresenter({
      controller: new OptimizationController(),
      view:       new OptimizationView(),
      scenario:   this.scenario,
    });
    this.optPresenter.onApplyCandidate = (params) => this._applyOptCandidate(params);

    //Send Scenario Ready Message
    registry.bus.publish(new BusMessage({ type: SIMULATION_BUS_MESSAGES.SCENARIO_READY, date: this.scenario.simStart}));
  }
  /**
   * Destroy all existing data, prepare for init()
   */
  destroyScenario() {
    // Reset all services, bus, and SimulationRegistry so every rebuild starts clean.
    ServiceRegistry.reset();

    $('currentStateContent').innerHTML  = '';
    $('cumulativeMetricsContent').innerHTML = '';
    this._statePanelView.clearMetricHistory();

    this._editModal?.close();
    this._graphNodeInspector?.clear();
    this._graphNodeExecHistory?.showNode(null);
    this._graphNodeLineage?.showNode(null);
    if (this.chartPresenter)  this.chartPresenter.stopViz();
    if (this.configGraphView)  this.configGraphView.destroy();
    if (this.configPresenter)  this.configPresenter.destroy();
    if (this.configList)      this.configList.destroy();
    if (this.timelinePresenter) this.timelinePresenter.destroy();
    if (this.mcPresenter)     this.mcPresenter.destroy();
    if (this.optPresenter)    this.optPresenter.destroy();
  }

  /**
   * Rebuild the scenario using the exact params from a MC run, then switch
   * to the Timeline tab so the user can step through the replayed simulation.
   */
  _replayMcRun(run) {
    this._replayParams = run.params;
    this.destroyScenario();
    this.initScenario();

    const tlHeader = document.querySelector('[data-dest-tab="timeline-tab"][data-tab-group="center-col"]');
    if (tlHeader) this.openTab({ currentTarget: tlHeader }, 'timeline-tab', 'center-col');
  }

  /**
   * Rebuild the scenario with the merged params from a selected optimization candidate,
   * then switch to the Chart tab to compare the outcome.
   */
  _applyOptCandidate(params) {
    this._replayParams = params;
    this.destroyScenario();
    this.initScenario();

    const chartHeader = document.querySelector('[data-dest-tab="chart-tab"][data-tab-group="center-col"]');
    if (chartHeader) this.openTab({ currentTarget: chartHeader }, 'chart-tab', 'center-col');
  }

  initView() {
    this._initGroupSelector();
    this._initRightGroupSelector();
    this._statePanelView.initLiveState();

    this.scenarioTabHeader   = document.querySelector('.tab-header[data-dest-tab=left-scenario][data-tab-group=left-col-sim]');
    this._graphEditTabHeader = document.querySelector('.tab-header[data-dest-tab="left-graph-edit"][data-tab-group="left-col-graph"]');

    document.querySelectorAll('.tab-header').forEach(el => {
      el.addEventListener('click', (evt) => this.openTab(evt, el.dataset.destTab, el.dataset.tabGroup));
    });

    // Auto-switch left and right column groups when center tab changes.
    const leftMcHeader    = document.querySelector('.tab-header[data-dest-tab="left-mc"][data-tab-group="left-col-sim"]');
    const leftOptHeader   = document.querySelector('.tab-header[data-dest-tab="left-opt"][data-tab-group="left-col-sim"]');
    const leftGraphNodesHeader = document.querySelector('.tab-header[data-dest-tab="left-graph-nodes"][data-tab-group="left-col-graph"]');
    document.querySelectorAll('.tab-header[data-tab-group="center-col"]').forEach(el => {
      el.addEventListener('click', () => {
        const isOpt   = el.dataset.destTab === 'opt-tab';
        const isMc    = el.dataset.destTab === 'mc-tab';
        const isGraph = el.dataset.destTab === 'config-graph-tab';
        this._openRightGroup(isOpt ? 'opt' : isMc ? 'mc' : isGraph ? 'graph' : 'sim');
        if (isGraph) {
          // Switch left column to Configuration > NODES
          const configBtn = document.querySelector('.left-group-btn[data-group="configuration"]');
          if (configBtn && !configBtn.classList.contains('active')) configBtn.click();
          if (leftGraphNodesHeader) this.openTab({ currentTarget: leftGraphNodesHeader }, 'left-graph-nodes', 'left-col-graph');
          return;
        }
        const leftTarget = isOpt ? leftOptHeader : isMc ? leftMcHeader : this.scenarioTabHeader;
        if (leftTarget) this.openTab({ currentTarget: leftTarget }, leftTarget.dataset.destTab, 'left-col-sim');
      });
    });

    $('displayCurrency').addEventListener('change', () => {
      if (this.timeControls) this.timeControls.displayCurrency = $('displayCurrency').value;
      //TODO Really build scenario?
      this.destroyScenario();
      this.initScenario();
    });

    $('tzSelect').addEventListener('change', () => {
      const fmt = $('tzSelect').value === 'utc' ? fmtUTC : fmtLocal;
      if (this.timeControls) this.timeControls.setFormatDate(fmt);
      this._statePanelView.formatDate = fmt;
      //TODO Really build scenario?
      this.destroyScenario();
      this.initScenario();
    });

    $('playPause').addEventListener('click', () => {
      if (this._animator?.playing) this._animator.stopPlaying();
      else                         this._animator?.startPlaying();
    });

    const stepForwardButton = $('stepForward');
    stepForwardButton.addEventListener('click', () => {
      const ctrl = this.scenario?.sim?.control;
      if (ctrl?.paused) {
        if (!ctrl.pendingExecution) ctrl.resuming = true;
        ctrl.paused        = false;
        ctrl.breakpointHit = null;
        this._animator?.clearBreakpointStatus();
      }
      this.showBusyInputOverlay(stepBackButton, () => this.timeControls.stepForward());
      if (ctrl?.paused) {
        this._animator?.showBreakpointPaused(ctrl.breakpointHit);
      }
    });

    const stepBackButton = $('stepBackward');
    stepBackButton.addEventListener('click', () => {
      this.showBusyInputOverlay(stepBackButton, () => this.timeControls.stepBack());
    });

    //TODO Need to have a central location to reset the sim  See #135
    $('resetBtn').addEventListener('click', () => this.timeControls.reset());

    let sliderTimeout;
    $('timeSlider').addEventListener('input', () => {
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

    $('rebuildBtn').addEventListener('click', () => {
      this.destroyScenario();
      this.initScenario();
    });

    this.openTab({ currentTarget: this.scenarioTabHeader }, 'left-scenario', 'left-col-sim');

    // Simulate graph tab activation so left/right panels start in the correct state.
    document.querySelector('.tab-header[data-dest-tab="config-graph-tab"][data-tab-group="center-col"]')?.click();

    window.addEventListener('resize', () => this.resizeCanvases());
    this.resizeCanvases();
  }

  // ── UI utilities ──────────────────────────────────────────────────────────

  openTab(evt, tabName, tabGroup) {
    document.querySelectorAll(`.tab-content[data-tab-group=${tabGroup}]`).forEach(el => el.style.display = 'none');
    document.querySelectorAll(`.tab-header[data-tab-group=${tabGroup}]`).forEach(el => el.classList.remove('active'));
    document.querySelector(`.tab-content[data-tab-group=${tabGroup}][data-tab=${tabName}]`).style.display = '';
    evt.currentTarget.classList.add('active');
  }

  showBusyInputOverlay(input, action, message) {
    const tmpl  = document.getElementById('tpl-time-control-slider-overlay');
    const node  = tmpl.content.firstElementChild.cloneNode(true);
    const dest  = $('sliderWrapper');
    if (message) node.innerText = message;
    dest.appendChild(node);
    const removeMe = () => node.remove();
    input.disabled = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        action();
        removeMe();
        input.disabled = false;
      });
    });
  }

  resizeCanvases() {
    const contentEl = $('content');
    const w = contentEl.clientWidth;
    const h = contentEl.clientHeight;
    if (this.graphView)            this.graphView.resizeCanvas(h, w);
    if (this.graphBuilderPresenter) this.graphBuilderPresenter.resizeCanvas(h, w);
    this.chartPresenter?.resize();
  }

  /**
   * Convert a value from one currency to the display currency.
   * @param {number} value       - Amount in the account's native currency
   * @param {'USD'|'AUD'} native - The account's native currency
   * @param {number} rate        - exchangeRateUsdToAud (1 USD = N AUD)
   */
  toDisplayCurrency(value, native, rate) {
    const currency = this.timeControls?.displayCurrency ?? 'USD';
    if (native === currency) return value;
    if (currency === 'AUD') return value * rate;
    return value / rate;
  }

  _initGroupSelector() {
    document.querySelectorAll('.left-group-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.dataset.group;
        document.querySelectorAll('.left-group-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.left-group').forEach(g => {
          g.style.display = g.dataset.group === group ? '' : 'none';
        });
      });
    });
  }

  _initRightGroupSelector() {
    document.querySelectorAll('.right-group-btn').forEach(btn => {
      btn.addEventListener('click', () => this._openRightGroup(btn.dataset.rightGroup));
    });
  }

  _openRightGroup(group) {
    document.querySelectorAll('.right-group-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.rightGroup === group);
    });
    document.querySelectorAll('.right-group').forEach(g => {
      g.style.display = g.dataset.rightGroup === group ? '' : 'none';
    });
  }

  /** Open a node in the left-panel inspector tab instead of the modal. */
  _openNodeInInspector(node) {
    this._graphNodeInspector?.open(node);
    this._graphNodeExecHistory?.showNode(node);
    this._graphNodeLineage?.showNode(node);
  }

  /** Switch the left column to Configuration > EDIT sub-tab. */
  _showGraphEditTab() {
    // Ensure Configuration group is visible
    const configBtn = document.querySelector('.left-group-btn[data-group="configuration"]');
    if (configBtn && !configBtn.classList.contains('active')) configBtn.click();

    // Switch to the EDIT sub-tab
    if (this._graphEditTabHeader) {
      this.openTab({ currentTarget: this._graphEditTabHeader }, 'left-graph-edit', 'left-col-graph');
    }
  }

  // ── Account history modal ─────────────────────────────────────────────────

  _showAccountHistory(entries, accountName, currencySymbol = '$') {
    document.getElementById('accountHistoryModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'accountHistoryModal';
    overlay.className = 'sim-modal-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'sim-modal';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
    const title = document.createElement('span');
    title.style.cssText = 'font-size:12px;font-weight:600;';
    title.textContent = `Transaction History — ${accountName}`;
    const closeBtn = document.createElement('button');
    closeBtn.className   = 'btn btn-sm';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.append(title, closeBtn);

    const body = document.createElement('div');
    body.style.cssText = 'overflow-y:auto;flex:1;';

    if (!entries || entries.length === 0) {
      const empty = document.createElement('span');
      empty.style.color   = 'var(--text-muted)';
      empty.textContent   = 'No transactions recorded. Run a simulation first.';
      body.appendChild(empty);
    } else {
      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;';
      const thead = table.createTHead();
      const hrow  = thead.insertRow();
      for (const col of ['Date', 'Event', 'Amount', 'Balance']) {
        const th = document.createElement('th');
        th.textContent  = col;
        th.style.cssText = 'text-align:left;padding:2px 6px;font-size:9px;letter-spacing:0.06em;color:var(--text-muted);border-bottom:1px solid var(--border);';
        hrow.appendChild(th);
      }
      const sym   = currencySymbol;
      const tbody = table.createTBody();
      for (const entry of entries) {
        const tr  = tbody.insertRow();
        tr.style.cssText = 'border-bottom:1px solid var(--border-subtle,var(--border));';
        const dateStr = entry.date instanceof Date ? fmtUTC(entry.date) : String(entry.date);
        const amt = entry.amount;
        const bal = entry.balanceAfter;
        const amtStr = (amt >= 0 ? '+' + sym : '-' + sym) + Math.abs(amt).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
        const balStr = bal != null ? (bal < 0 ? '-' + sym : sym) + Math.abs(bal).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
        const cells = [
          { text: dateStr, style: '' },
          { text: entry.eventType ?? entry.reducer ?? '', style: 'color:var(--text-muted);' },
          { text: amtStr, style: `color:${amt >= 0 ? 'var(--accent-green,#4a8)' : 'var(--accent-red,#e55)'};font-family:var(--font-mono);` },
          { text: balStr, style: `font-family:var(--font-mono);${bal != null && bal < 0 ? 'color:var(--accent-red,#e55);' : ''}` },
        ];
        for (const { text, style } of cells) {
          const td = tr.insertCell();
          td.textContent = text;
          td.style.cssText = 'padding:3px 6px;' + style;
        }
      }
      body.appendChild(table);
    }

    modal.append(header, body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ── Backwards-compat delegators for subclasses ────────────────────────────

  /** Playback state — delegated to animator (false before first buildScenario). */
  get playing()    { return this._animator?.playing ?? false; }
  set playing(val) { if (this._animator) this._animator.playing = val; }

  /**
   * TODO Refactor to remove these, they should be in the views.
   * TODO Extract to shared UI class #139
   * Formatting helpers — subclasses and custom scenarios may call these.
   * fmtVal syncs timeControls.formatDate into StatePanelView so that tests
   * which stub timeControls directly continue to work.
   */
  fmtVal(v, objAsCode = false) {
    if (this.timeControls?.formatDate) this._statePanelView.formatDate = this.timeControls.formatDate;
    return this._statePanelView.fmtVal(v, objAsCode);
  }
}
