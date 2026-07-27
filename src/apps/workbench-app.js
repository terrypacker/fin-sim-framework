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

import { WorkbenchShell }              from '../visualization/workbench/workbench-shell.js';
import { BaseComponent }               from '../visualization/components/base-component.js';
import { $, fmtUTC }                   from '../visualization/ui-utils.js';
import { AppDisplaySettings, APP_EVENTS } from '../visualization/app-display-settings.js';
import { EventBus }                      from '../simulation-framework/event-bus.js';
import { ScenarioLoader }             from '../scenarios/scenario-loader.js';
import { ScenarioSerializer }         from '../scenarios/scenario-serializer.js';
import { ParamFieldLinks }            from '../visualization/scenario/param-field-links.js';
import { ChartController }            from '../visualization/chart/chart-controller.js';
import { ChartView }                  from '../visualization/chart/chart-view.js';
import { ChartPresenter }             from '../visualization/chart/chart-presenter.js';
import { TimelineController }         from '../visualization/timeline/timeline-controller.js';
import { TimelineView }               from '../visualization/timeline/timeline-view.js';
import { TimelinePresenter }          from '../visualization/timeline/timeline-presenter.js';
import { TimeControls }               from '../visualization/time-controls.js';
import { GraphBuilderPresenter }      from '../visualization/graph-builder/graph-builder-presenter.js';
import { ConfigGraphView }            from '../visualization/graph-builder/config-graph-view.js';
import { ServiceRegistry }            from '../services/service-registry.js';
import {
  BusMessage, EXECUTION_KINDS, EXECUTION_PHASES,
  SIMULATION_BUS_MESSAGES,
} from '../simulation-framework/bus-messages.js';
import { PeopleController }           from '../visualization/people/people-controller.js';
import { PersonEditor }               from '../visualization/people/person-editor.js';
import { AccountsController }         from '../visualization/accounts/accounts-controller.js';
import { AccountEditor }              from '../visualization/accounts/account-editor.js';
import { RealPropertyEditor }         from '../visualization/assets/real-property-editor.js';
import { CollectibleEditor }          from '../visualization/assets/collectible-editor.js';
import { CompanyEquityEditor }        from '../visualization/assets/company-equity-editor.js';
import { BequestEditor }              from '../visualization/assets/bequest-editor.js';
import { RealProperty }               from '../finance/assets/real-property.js';
import { Collectible }                from '../finance/assets/collectible.js';
import { CompanyEquity }              from '../finance/assets/company-equity.js';
import { Bequest }                    from '../finance/assets/bequest.js';
import { USD, AUD }                   from '../finance/assets/account.js';
import { NodeEditModal }              from '../visualization/components/node-edit-modal.js';
import { ConfigurationListComponent } from '../visualization/configuration/configuration-list.js';
import { ScenarioTabPresenter }       from '../visualization/scenario/scenario-tab-presenter.js';
import { StatePanelView }             from '../visualization/simulation/state-panel-view.js';
import { FieldSeriesStore }           from '../visualization/state/field-series-store.js';
import { SimulationAnimator }         from '../visualization/simulation/simulation-animator.js';
import { ScenarioTabView }            from '../visualization/scenario/scenario-tab-view.js';
import { JournalReportingService }    from '../finance/journal-reporting-service.js';
import { TaxDocumentModal }           from '../visualization/timeline/tax-document-modal.js';
import { ScenarioTabController }      from '../visualization/scenario/scenario-tab-controller.js';
import { MonteCarloView }             from '../visualization/monte-carlo/monte-carlo-view.js';
import { MonteCarloController }       from '../visualization/monte-carlo/monte-carlo-controller.js';
import { MonteCarloPresenter }        from '../visualization/monte-carlo/monte-carlo-presenter.js';
import { OptimizationView }           from '../visualization/optimization/optimization-view.js';
import { OptimizationController }     from '../visualization/optimization/optimization-controller.js';
import { OptimizationPresenter }      from '../visualization/optimization/optimization-presenter.js';
import { GraphNodeInspectorPanel }    from '../visualization/graph-builder/graph-node-inspector-panel.js';
import { GraphNodeExecHistory }       from '../visualization/graph-builder/graph-node-exec-history.js';
import { GraphNodeLineage }           from '../visualization/graph-builder/graph-node-lineage.js';
import {
  FINANCE_PLUGINS,
  FINANCE_DEFAULT_LAYOUT,
} from '../visualization/workbench/plugins/finance/finance-plugin-package.js';
import { WB_EVENTS } from '../visualization/workbench/workbench-runtime.js';
import { ScenarioComparePresenter }  from '../visualization/scenario-compare/scenario-compare-presenter.js';
import { DecisionGraphPresenter }    from '../visualization/decision-graph/decision-graph-presenter.js';

const STORAGE_KEY = 'sim-workbench-layout-prod';

/** Map an asset currency code to its {code,symbol} descriptor; null when unknown. */
function _assetCurrency(code) {
  if (code === 'AUD') return AUD;
  if (code === 'USD') return USD;
  return null;
}

// ── Built-in workspace templates ────────────────────────────────────────────

const CENTER_SPLIT_DEFAULTS = {
  centerSplit: false, centerSplitDir: 'h', centerInnerSizes: [1, 1],
  'center-a': { tabs: [], active: null }, 'center-b': { tabs: [], active: null },
};

const ANALYSIS_LAYOUT = {
  sizes: [1, 2, 1],
  left:   { tabs: ['scenario', 'mc-config', 'opt-config'],                    active: 'mc-config'     },
  center: { tabs: ['chart', 'mc-results', 'opt-results', 'timeline'],         active: 'chart'         },
  right:  { tabs: ['mc-runs', 'opt-runs', 'state-panel', 'action-detail'],    active: 'mc-runs'       },
  bottom: { tabs: ['journal-report', 'dashboard', 'perf'],                    active: 'dashboard'     },
  bottomSize: 110, bottomCollapsed: false, ...CENTER_SPLIT_DEFAULTS,
};

const DEBUGGING_LAYOUT = {
  sizes: [1, 3, 1],
  left:   { tabs: ['config-list', 'scenario'],                                        active: 'config-list'  },
  center: { tabs: ['config-graph', 'timeline'],                                       active: 'config-graph' },
  right:  { tabs: ['inspector', 'exec-history', 'lineage', 'state-panel', 'action-detail'], active: 'exec-history' },
  bottom: { tabs: ['perf', 'dashboard'],                                              active: 'perf'         },
  bottomSize: 110, bottomCollapsed: false, ...CENTER_SPLIT_DEFAULTS,
};

const REVIEW_LAYOUT = {
  sizes: [1, 3, 1],
  left:   { tabs: ['scenario', 'config-list'],                                        active: 'scenario'     },
  center: { tabs: ['timeline', 'chart'],                                              active: 'timeline'     },
  right:  { tabs: ['state-panel', 'action-detail', 'inspector', 'exec-history', 'lineage'], active: 'state-panel' },
  bottom: { tabs: ['journal-report', 'dashboard'],                                    active: 'journal-report' },
  bottomSize: 110, bottomCollapsed: false, ...CENTER_SPLIT_DEFAULTS,
};

const BUILTIN_TEMPLATES = {
  Default:   FINANCE_DEFAULT_LAYOUT,
  Analysis:  ANALYSIS_LAYOUT,
  Debugging: DEBUGGING_LAYOUT,
  Review:    REVIEW_LAYOUT,
};

/**
 * WorkbenchApp — composition root for the workbench UI.
 *
 * Instantiates and wires all sub-modules. Contains no domain logic,
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
export class WorkbenchApp extends BaseComponent {
  /**
   * @param {object}             opts
   * @param {Array<{cls,order,active,simStart,simEnd}>} [opts.prebuiltScenarios=[]] - Pre-built scenario class entries.
   * @param {Array|null}         [opts.chartSeries]  - Chart series config.
   */
  constructor({ chartSeries, prebuiltScenarios = [] }) {
    super();
    this.chartSeries        = chartSeries ?? null;
    this._prebuiltScenarios = prebuiltScenarios;
    this.scenario           = null; //TODO Remove for #146

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
    this.comparePresenter      = null;
    this.dgPresenter           = null;
    this._graphNodeInspector   = null;
    this._graphNodeExecHistory = null;
    this._graphNodeLineage     = null;

    // App-lifetime event bus — shared across all app-level services and components.
    this.appBus = new EventBus();

    // App-lifetime display settings service (timezone, currency, theme + persistence).
    this.displaySettings = new AppDisplaySettings(this.appBus);

    // Created once — survive scenario rebuilds.
    this._statePanelView   = new StatePanelView({ displaySettings: this.displaySettings, appBus: this.appBus });
    this._scenarioTabView  = new ScenarioTabView();
    this._reportingService = new JournalReportingService();
    this._taxDocModal      = new TaxDocumentModal();
    this._editModal        = new NodeEditModal();

    // Playback/slider state
    this.lastSliderValue = 0;
    this._currentDate    = null;

    this._wbShell = null;
  }

  // ── View lifecycle ────────────────────────────────────────────────────────

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

    // Give the tax modal access to the workbench runtime so drill-down buttons work.
    this._taxDocModal.runtime = this._wbShell.runtime;

    // Activate the journal-report plugin pane whenever a drill-down fires.
    this._wbShell.runtime.bus.subscribe(WB_EVENTS.JOURNAL_REPORT_OPEN, () => {
      this._wbShell.activatePlugin('journal-report');
    });

    // Activate the cross-action-query panel when ActionDetail fires the event.
    this._wbShell.runtime.bus.subscribe(WB_EVENTS.CROSS_ACTION_QUERY_OPEN, () => {
      this._wbShell.activatePlugin('cross-action-query');
    });

    // Show action detail when a row in the cross-action-query panel is clicked.
    this._wbShell.runtime.bus.subscribe(WB_EVENTS.ACTION_ENTRY_OPEN, ({ entry }) => {
      this._statePanelView.showNodeDetail(entry);
      this._wbShell.activatePlugin('action-detail');
    });

    // Bridge app bus → workbench bus so plugins can subscribe without a direct
    // reference to AppDisplaySettings.
    this.appBus.subscribe(APP_EVENTS.DISPLAY_SETTINGS_CHANGED, (event) => {
      this._wbShell.runtime.bus.publish({
        type:     WB_EVENTS.DISPLAY_SETTINGS_CHANGED,
        settings: event,
      });
    });

    // Bind scenario tab view now that ScenarioPlugin DOM exists
    this._scenarioTabView.bind();

    this._wireSimControls();
    this._wireTemplates();

    // Initialize the live state DOM now that StatePanelPlugin is mounted
    this._statePanelView.initLiveState();
  }

  // ── Scenario lifecycle ────────────────────────────────────────────────────

  initScenario() {
    //TODO Clean up for #146
    const registry = ServiceRegistry.getInstance();
    registry.scenarioRegistry.loadPrebuilt(this._prebuiltScenarios);

    // ── Config graph (visual node canvas + filter bar) ────────────────────────
    this.configGraphView = new ConfigGraphView({
      parent:                  null,
      graph:                   registry.graph,
      graphQueryApi:           registry.graphQueryApi,
      graphRoot:               document.getElementById('graphRoot'),
      displayNodeStateChanges: (changes) => this._statePanelView.showNodeStateChanges(changes),
      bus:                     registry.bus,
      displaySettings:         this.displaySettings,
      appBus:                  this.appBus,
    });

    this.configPresenter = new GraphBuilderPresenter({
      graphRenderer:  this.configGraphView.graphRenderer,
      eventService:   registry.eventService,
      handlerService: registry.handlerService,
      actionService:  registry.actionService,
      reducerService: registry.reducerService,
      onEditNode:     (node) => this._openNodeInInspector(node),
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
      } else if (kind === 'real-property') {
        this._editModal.open({ kind: 'real-property', id: null, name: 'New Property' });
      } else if (kind === 'collectible') {
        this._editModal.open({ kind: 'collectible', id: null, name: 'New Collectible' });
      } else if (kind === 'company') {
        this._editModal.open({ kind: 'company', id: null, name: 'New Company Equity' });
      } else if (kind === 'bequest') {
        this._editModal.open({ kind: 'bequest', id: null, name: 'New Inheritance' });
      } else {
        const newNode = this.configPresenter.createNode(kind, null);
        this._editModal.open(newNode);
      }
    };

    // ── Shared editor factory (used by modal and inspector panel) ─────────────
    // Param↔field linking (design/32): build a fresh links index per editor open
    // from the active scenario's params, plus the callbacks an editor uses to
    // write a linked field's param and to jump to it in the Scenario panel.
    const paramLinkProps = () => ({
      links: new ParamFieldLinks(this.scenarioTabPresenter?.getActiveParams?.() ?? []),
      onParamChange: () => this.scenarioTabPresenter?.refreshParams(),
      onOpenParam: (p) => {
        this._editModal?.close();
        this._wbShell?.activatePlugin('scenario');
        this.scenarioTabPresenter?.revealParam(p);
      },
    });

    const editorFactory = (node, container) => {
      if (node?.kind === 'person') {
        const editor = new PersonEditor({
          container,
          node,
          ...paramLinkProps(),
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
        const realProperties = registry.graphQueryApi.getByKind('real-property');
        // Prime rates (design 56) — the cash rate field edits an absolute (Prime +
        // spread) and stores the spread, so it needs the current per-country Prime.
        const activeParams = registry.scenarioService.getActive()?.parameters ?? {};
        const primeRates = { US: activeParams.usPrimeRate, AU: activeParams.auPrimeRate };
        const editor = new AccountEditor({
          container,
          node,
          people,
          realProperties,
          primeRates,
          ...paramLinkProps(),
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

      if (node?.kind === 'real-property') {
        const people   = registry.graphQueryApi.getByKind('person');
        const accounts = registry.graphQueryApi.getByKind('account');
        // Prime rates (design 56) — the mortgage rate field edits an absolute (Prime +
        // spread) and stores the spread, so it needs the current per-country Prime.
        const activeParams = registry.scenarioService.getActive()?.parameters ?? {};
        const primeRates = { US: activeParams.usPrimeRate, AU: activeParams.auPrimeRate };
        const editor = new RealPropertyEditor({
          container,
          node,
          people,
          accounts,
          primeRates,
          ...paramLinkProps(),
          onSave: (data) => {
            // Map the editor's currency code to a {code,symbol} descriptor (or
            // null → registerAsset falls back to country). Design 10 §Phase 5.
            data.currency = _assetCurrency(data.currency);
            if (data.id) {
              const { id, ...changes } = data;
              registry.realPropertyService.updateProperty(id, changes);
            } else {
              const prop = new RealProperty(data.value ?? 0, data);
              registry.realPropertyService.createProperty(prop);
            }
            this._editModal.close();
          },
          onDelete: (id) => {
            registry.realPropertyService.deleteProperty(id);
            this._editModal.close();
          },
        });
        editor.render();
        return editor;
      }

      if (node?.kind === 'collectible') {
        const people   = registry.graphQueryApi.getByKind('person');
        const accounts = registry.graphQueryApi.getByKind('account');
        const editor = new CollectibleEditor({
          container,
          node,
          people,
          accounts,
          ...paramLinkProps(),
          onSave: (data) => {
            data.currency = _assetCurrency(data.currency);
            if (data.id) {
              const { id, ...changes } = data;
              registry.collectibleService.updateCollectible(id, changes);
            } else {
              const col = new Collectible(data.value ?? 0, data);
              registry.collectibleService.createCollectible(col);
            }
            this._editModal.close();
          },
          onDelete: (id) => {
            registry.collectibleService.deleteCollectible(id);
            this._editModal.close();
          },
        });
        editor.render();
        return editor;
      }

      if (node?.kind === 'company') {
        const people   = registry.graphQueryApi.getByKind('person');
        const accounts = registry.graphQueryApi.getByKind('account');
        const editor = new CompanyEquityEditor({
          container,
          node,
          people,
          accounts,
          ...paramLinkProps(),
          onSave: (data) => {
            data.currency = _assetCurrency(data.currency);
            if (data.id) {
              const { id, ...changes } = data;
              registry.companyEquityService.updateCompanyEquity(id, changes);
            } else {
              const eq = new CompanyEquity(data.value ?? 0, data);
              registry.companyEquityService.createCompanyEquity(eq);
            }
            this._editModal.close();
          },
          onDelete: (id) => {
            registry.companyEquityService.deleteCompanyEquity(id);
            this._editModal.close();
          },
        });
        editor.render();
        return editor;
      }

      if (node?.kind === 'bequest') {
        const people = registry.graphQueryApi.getByKind('person');
        // Design 63 §14: an active bequest's brokerage / property / collectible are
        // promoted to real records tagged with the bequest's stateKey. Surface them
        // (read-only) in the editor so they stay visible in context.
        const linkId = node?.stateKey ?? node?.id;
        const promotedAssets = [
          ...registry.accountService.getAll(),
          ...registry.realPropertyService.getAll(),
          ...registry.collectibleService.getAll(),
        ].filter(r => r.inherited && r.bequestId === linkId);
        const editor = new BequestEditor({
          container,
          node,
          people,
          promotedAssets,
          ...paramLinkProps(),
          onSave: (data) => {
            if (data.id) {
              const { id, ...changes } = data;
              registry.bequestService.updateBequest(id, changes);
            } else {
              registry.bequestService.createBequest(new Bequest(data));
            }
            this._editModal.close();
          },
          onDelete: (id) => {
            registry.bequestService.deleteBequest(id);
            this._editModal.close();
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
      container: document.getElementById('graphNodeEditPane'),
      onShowTab: () => this._showGraphEditTab(),
    });
    this._graphNodeInspector.setEditorFactory(editorFactory);

    // ── Graph node execution history (right column GRAPH group) ───────────────
    this._graphNodeExecHistory = new GraphNodeExecHistory({
      container:      document.getElementById('graphNodeHistoryPane'),
      graphRenderer:  this.configGraphView.graphRenderer,
      graphQueryApi:  registry.graphQueryApi,
      schemaRegistry: registry.schemaRegistry,
      appBus:         this.appBus,
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
    const scenarioTabController = new ScenarioTabController({ scenarioService: registry.scenarioService });
    this.scenarioTabPresenter = new ScenarioTabPresenter({
      controller:    scenarioTabController,
      view:          this._scenarioTabView,
      bus:           registry.bus,
      initScenario:  () => { this.destroyScenario(); this.initScenario(); },
      editModal:     this._editModal,
    });

    // ── Build scenario ────────────────────────────────────────────────────────
    //This will create the active scenario
    this.scenario = registry.scenarioService.createActiveScenario();
    this.scenario.buildSim();

    // Design 15: the active scenario cfg is the single source of truth. Defaults
    // are materialized once at registry registration; Rebuild reads whatever the
    // user has saved/edited. ScenarioLoader dispatches to deserializeGraph() (if
    // cfg carries a saved graph snapshot) or toolset compilation.
    const activeConfig = registry.scenarioService.getActive();
    // Remember which cfg is loaded into the services so destroyScenario() harvests
    // in-flight edits back into THIS scenario, even after the active pointer moves
    // to a different scenario on a switch (prevents cross-scenario holdings leak).
    this._loadedCfg = activeConfig;
    this.scenario.watchlists = activeConfig?.watchlists ?? [];
    new ScenarioLoader().load(activeConfig, registry);

    // Display-currency conversion (design 10 §Phase 4): give the schema registry
    // the active display currency and a live rate source (the current sim state
    // carries effectiveExchangeRates). Set each rebuild so the closure tracks the
    // freshly built sim; the registry itself persists across rebuilds.
    registry.schemaRegistry.displaySettings   = this.displaySettings;
    registry.schemaRegistry.rateStateProvider = () => this.scenario?.sim?.state ?? null;

    //TODO this should be wired to a bus event (AND removed from constructor of tab presenter)
    this.scenarioTabPresenter._refresh();

    this._statePanelView.schemaRegistry = registry.schemaRegistry;
    this._statePanelView.typeRegistry   = registry.typeRegistry;
    this._statePanelView.journal        = this.scenario.sim.journal;
    this._statePanelView.executionGraph = this.scenario.sim.executionGraph;
    const fieldStore = new FieldSeriesStore();
    fieldStore.simulationHistory = this.scenario.sim.history;
    this._statePanelView.fieldSeriesStore = fieldStore;
    this._statePanelView.onOpenNode     = (nodeId) => {
      const node = registry.graph.getNode(nodeId);
      if (node) this._editModal.open(node);
    };
    this._statePanelView.onShowActionDetail = () => {
      this._wbShell?.activatePlugin('action-detail');
    };
    this._statePanelView.onOpenCrossActionQuery = (field, actionType) => {
      this._wbShell?.runtime.bus.publish({ type: WB_EVENTS.CROSS_ACTION_QUERY_OPEN, field, actionType });
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
      // Display-currency conversion (design 10 §Phase 4)
      appBus:            this.appBus,
      schemaRegistry:    registry.schemaRegistry,
      currencyConverter: registry.currencyConverter,
      displaySettings:   this.displaySettings,
      rateStateProvider: () => this.scenario?.sim?.state ?? null,
    });
    this.chartPresenter = new ChartPresenter({ controller: chartController, view: chartView });
    this.chartPresenter.fieldStore = fieldStore;   // R10.3: full-res live buffering for charted paths
    this.chartPresenter.startViz();

    // R9.0/D15: default the chart to a single net-worth line when the scenario has
    // no saved watchlist (all pre-existing scenarios). netWorth is a real metric (R12).
    if (!this.scenario.watchlists || this.scenario.watchlists.length === 0) {
      this.scenario.watchlists = ['metrics.netWorth'];
    }

    const setCharted = (path, active) => {
      if (active) {
        this.chartPresenter.activatePath(path, fieldStore);
        if (!this.scenario.watchlists.includes(path)) this.scenario.watchlists.push(path);
      } else {
        this.chartPresenter.deactivatePath(path);
        this.scenario.watchlists = this.scenario.watchlists.filter(p => p !== path);
      }
      // Persist the watchlist into the active config so it survives save/reload.
      const cfg = registry.scenarioService.getActive();
      if (cfg) cfg.watchlists = [...this.scenario.watchlists];
    };
    this._statePanelView.isPathCharted = (path) => this.chartPresenter.isPathActive(path);
    this._statePanelView.onChartToggle = setCharted;
    // Chip ✕ removes the series and re-syncs the state-panel checkboxes (R7.3).
    this.chartPresenter.onChipRemove = (path) => { setCharted(path, false); this._statePanelView.refresh(); };
    this.chartPresenter.seedWatchlist(this.scenario.watchlists, fieldStore);

    this.timelinePresenter = new TimelinePresenter({
      controller:    new TimelineController(),
      view:          new TimelineView({ container: $('timelineContainer') }),
      appBus:        this.appBus,
      onDetail:      (entry) => this._statePanelView.showNodeDetail(entry),
      onTaxDocument: (entry, journal) => {
        const doc = this._reportingService.generate(entry, journal);
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
      displaySettings: this.displaySettings,
    });
    this.timelinePresenter.attach(this.scenario.sim.journal);
    this.timelinePresenter.schemaRegistry = registry.schemaRegistry;
    // Display-currency conversion of on-screen amounts (design 10 §Phase 4)
    this.timelinePresenter.currencyConverter = registry.currencyConverter;
    this.timelinePresenter.rateStateProvider = () => this.scenario?.sim?.state ?? null;
    this.timelinePresenter.typeRegistry      = registry.typeRegistry;
    // Tax-document modal converts amounts to the display currency (design 10 §Phase 4)
    this._taxDocModal.schemaRegistry = registry.schemaRegistry;

    this.timeControls = new TimeControls({
      scenario:        this.scenario,
      configPresenter: this.configPresenter,
      timelineView:    this.timelinePresenter,
      chartView:       this.chartPresenter,
      timeLabel:       $('timeLabel'),
      timeSlider:      $('timeSlider'),
      displaySettings: this.displaySettings,
      appBus:          this.appBus,
      onReset: (date, state) => {
        this._animator?.updateDashCards(date);
        this._statePanelView.updateStatePanel(date, state);
      },
    });
    // Expose the live time controls to plugins (e.g. the MPC cockpit drives the
    // real clock through this — design 39 Step 5a). Re-assigned each rebuild
    // since TimeControls is recreated, while the runtime persists.
    this._wbShell.runtime.timeControls = this.timeControls;

    // ── Simulation animator ───────────────────────────────────────────────────
    this._animator = new SimulationAnimator({
      scenario:        this.scenario,
      timeControls:    this.timeControls,
      statePanelView:  this._statePanelView,
      chartView:       this.chartPresenter,
      graphRenderer:   this.configPresenter._graphRenderer,
      displaySettings: this.displaySettings,
      appBus:          this.appBus,
    });

    this._animator.toggleBreakpoint();
    this._animator.wireSimBus(this.scenario.sim.bus);
    this._graphNodeExecHistory?.wireSimBus(this.scenario.sim.bus);
    this._graphNodeLineage?.wireSimBus(this.scenario.sim.bus);

    // Track _currentDate for subclass access. Subscribes to the per-run sim bus,
    // which is discarded (with this subscription) on the next Rebuild.
    this.scenario.sim.bus.subscribe(`EXECUTION_${EXECUTION_PHASES.BEGIN}`, { kind: EXECUTION_KINDS.EVENT }, ({ date }) => {
      this._currentDate = new Date(date);
    });

    this._animator.updateDashCards(this.scenario.simStart);

    $('timeSlider').value      = 0;
    this.lastSliderValue       = 0;
    this._currentDate          = this.scenario.simStart;
    $('timeLabel').textContent = this.displaySettings.formatDate(this.scenario.simStart);

    // ── Monte Carlo ───────────────────────────────────────────────────────────
    this.mcPresenter = new MonteCarloPresenter({
      controller: new MonteCarloController(),
      view:       new MonteCarloView(),
      scenario:   this.scenario,
      appBus:     this.appBus,
    });
    this.mcPresenter.onReplayRun = (run) => this._replayMcRun(run);

    // ── Scenario Compare ─────────────────────────────────────────────────────
    const comparePaneEl = document.getElementById('scenarioComparePane');
    if (comparePaneEl) {
      this.comparePresenter = new ScenarioComparePresenter({
        containerEl:      comparePaneEl,
        scenarioRegistry: registry.scenarioRegistry,
      });
    }

    // ── Decision Graph ────────────────────────────────────────────────────────
    const dgConfigEl   = document.getElementById('dgConfigPane');
    const dgResultsEl  = document.getElementById('dgResultsPane');
    if (dgConfigEl && dgResultsEl) {
      this.dgPresenter = new DecisionGraphPresenter({
        configContainerEl:  dgConfigEl,
        resultsContainerEl: dgResultsEl,
        dgRegistry:         registry.dgRegistry,
        scenarioRegistry:   registry.scenarioRegistry,
        resultStorage:      registry.dgResultStorage,
      });
      this.dgPresenter.onCompareLeaf = async (leafEntry, baseEntry) => {
        if (this.comparePresenter) {
          await this.comparePresenter.compareDirect(baseEntry, leafEntry);
          this._wbShell?.activatePlugin('scenario-compare');
        }
      };
    }

    // ── Optimization ──────────────────────────────────────────────────────────
    this.optPresenter = new OptimizationPresenter({
      controller: new OptimizationController(),
      view:       new OptimizationView(),
      scenario:   this.scenario,
      appBus:     this.appBus,
    });
    this.optPresenter.onApplyCandidate = (params) => this._applyOptCandidate(params);

    // Send Scenario Ready Message to the sim bus
    registry.bus.publish(new BusMessage({ type: SIMULATION_BUS_MESSAGES.SCENARIO_READY, date: this.scenario.simStart }));

    // ── Workbench wiring ──────────────────────────────────────────────────────
    const runtime = this._wbShell?.runtime;
    if (!runtime || !this.scenario) return;

    // Publish SCENARIO_READY so PerfPlugin and other bus-aware plugins can wire up.
    runtime.scenarioReady(this.scenario);

    // When a graph node is clicked, also focus the exec-history plugin.
    this.configPresenter?._graphRenderer?.registerNodeClickListener(() => {
      this._wbShell?.activatePlugin('exec-history');
    });

    // Bridge sim-bus BREAKPOINT_HIT → workbench bus so timeline/graph plugins react.
    // Subscribes to the per-run sim bus, discarded with it on the next Rebuild.
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

  /**
   * Destroy all existing data, prepare for initScenario().
   * Clears config + execution layers so ScenarioLoader starts with a fresh graph.
   */
  destroyScenario() {
    const registry = ServiceRegistry.getInstance();

    // Harvest in-flight free-field domain edits (currency, holdings, names, …)
    // into the scenario record BEFORE reset so Rebuild rebuilds what the user
    // currently has configured (design/32), not the last-Saved cfg. Records only
    // — not the graph — so ScenarioLoader still recompiles toolsets, and the
    // param→node cascade re-applies node-linked fields from their params.
    //
    // Harvest into the cfg that is actually LOADED in the services (`_loadedCfg`),
    // NOT scenarioService.getActive(): on a scenario switch the active pointer has
    // already moved to the incoming scenario, so getActive() would write the
    // outgoing scenario's live holdings into the incoming one (cross-scenario
    // leak). On a Rebuild the two are identical, so this is a no-op difference.
    if (this._loadedCfg) {
      Object.assign(this._loadedCfg, ScenarioSerializer.snapshotDomainRecords(registry));
      // Record which default records the user has deleted (absent from the just-
      // harvested live set) so the upcoming toolset recompile's drift-merge does
      // not re-add them. Runs here — after the harvest, before ScenarioLoader.load
      // runs drift-merge — so "absent" means a real deletion.
      ScenarioLoader.recordDeletedDefaults(this._loadedCfg);
    }

    registry?.graph.clearLayer('config');
    ServiceRegistry.reset();

    $('currentStateContent').innerHTML      = '';
    $('cumulativeMetricsContent').innerHTML = '';
    this._statePanelView.clearMetricHistory();

    this._editModal?.close();
    // These are recreated each initScenario and subscribe to the persistent
    // ServiceRegistry bus — destroy() (not just clear/showNode) is required so
    // their bus subscriptions are released and they don't pin prior simulations.
    this._graphNodeInspector?.destroy();
    this._graphNodeExecHistory?.destroy();
    this._graphNodeLineage?.destroy();
    if (this._animator)         this._animator.destroy();
    if (this.timeControls)      this.timeControls.destroy();
    if (this.chartPresenter)  { this.chartPresenter.stopViz(); this.chartPresenter.destroy(); }
    if (this.configGraphView)   this.configGraphView.destroy();
    if (this.configPresenter)   this.configPresenter.destroy();
    if (this.configList)        this.configList.destroy();
    if (this.timelinePresenter) this.timelinePresenter.destroy();
    if (this.mcPresenter)       this.mcPresenter.destroy();
    if (this.optPresenter)      this.optPresenter.destroy();
    if (this.comparePresenter)  this.comparePresenter.destroy();
    if (this.dgPresenter)       this.dgPresenter.destroy();
  }

  // ── Simulation controls ────────────────────────────────────────────────────

  _wireSimControls() {
    $('displayCurrency')?.addEventListener('change', () => {
      this.displaySettings.setCurrency($('displayCurrency').value);
    });

    $('tzSelect')?.addEventListener('change', () => {
      this.displaySettings.setTimezone($('tzSelect').value);
    });

    $('themeSelect')?.addEventListener('change', () => {
      this.displaySettings.setTheme($('themeSelect').value);
    });

    // Initialize selects from persisted state so they reflect the loaded settings.
    const ds = this.displaySettings;
    if ($('tzSelect'))        $('tzSelect').value        = ds.timezone;
    if ($('displayCurrency')) $('displayCurrency').value = ds.displayCurrency;
    if ($('themeSelect'))     $('themeSelect').value     = ds.theme;

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

    //TODO Need to have a central location to reset the sim  See #135
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

  // ── MC / Opt replay ───────────────────────────────────────────────────────

  /**
   * Rebuild the scenario using the exact params from a MC run, then switch
   * to the Timeline plugin so the user can step through the replayed simulation.
   *
   * Design 15: applies the replay params to the active scenario's cfg.params
   * (the typed UI array). ScenarioLoader's param→node cascade propagates them
   * into persons/accounts during the next initScenario.
   */
  _replayMcRun(run) {
    this._applyParamsToActive(run.params);
    this.destroyScenario();
    this.initScenario();
    this._wbShell?.activatePlugin('timeline');
  }

  /**
   * Rebuild the scenario with the merged params from a selected optimization candidate,
   * then switch to the Chart plugin to compare the outcome.
   */
  _applyOptCandidate(params) {
    this._applyParamsToActive(params);
    this.destroyScenario();
    this.initScenario();
    this._wbShell?.activatePlugin('chart');
  }

  /**
   * Write replay/candidate params into the active scenario's typed cfg.params
   * array so the next Rebuild reflects them. Only keys present in cfg.params
   * are touched — keys without a matching typed entry are dropped because they
   * have no path into the scenario otherwise.
   */
  _applyParamsToActive(params) {
    if (!params) return;
    const registry = ServiceRegistry.getInstance();
    const active   = registry.scenarioService.getActive();
    if (!Array.isArray(active?.params)) return;
    for (const p of active.params) {
      if (params[p.name] !== undefined) p.value = params[p.name];
    }
  }

  // ── UI utilities ──────────────────────────────────────────────────────────

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
    const canvas = document.getElementById('chartCanvas');
    if (canvas) {
      const wrap = canvas.parentElement;
      if (wrap) {
        canvas.width  = wrap.clientWidth;
        canvas.height = wrap.clientHeight;
      }
    }
  }

  /** Open a node in the left-panel inspector plugin instead of the modal. */
  _openNodeInInspector(node) {
    this._graphNodeInspector?.open(node);
    this._graphNodeExecHistory?.showNode(node);
    this._graphNodeLineage?.showNode(node);
  }

  /** Switch the left column to the inspector plugin. */
  _showGraphEditTab() {
    this._wbShell?.activatePlugin('inspector');
  }

  // ── Account history modal ─────────────────────────────────────────────────

  _showAccountHistory(entries, accountName, currencySymbol = '$') {
    document.getElementById('accountHistoryModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'accountHistoryModal';
    overlay.className = 'sim-modal-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'sim-modal sim-modal--acct-history';

    const header = document.createElement('div');
    header.className = 'acct-history-header';

    const title = document.createElement('span');
    title.className = 'acct-history-title';
    title.textContent = `Transaction History — ${accountName}`;

    const closeBtn = document.createElement('button');
    closeBtn.className   = 'btn btn-sm';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.append(title, closeBtn);

    const body = document.createElement('div');
    body.className = 'acct-history-body';

    if (!entries || entries.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'acct-history-empty';
      empty.textContent = 'No transactions recorded. Run a simulation first.';
      body.appendChild(empty);
    } else {
      const table = document.createElement('table');
      table.className = 'acct-history-tbl';

      const thead = table.createTHead();
      const hrow  = thead.insertRow();
      for (const col of ['Date', 'Event', 'Reducer', 'Amount', 'Balance']) {
        const th = document.createElement('th');
        th.textContent = col;
        th.className   = 'acct-history-tbl-th';
        hrow.appendChild(th);
      }

      const sym   = currencySymbol;
      const tbody = table.createTBody();
      for (const entry of entries) {
        const tr = tbody.insertRow();
        tr.className = 'acct-history-tbl-row';

        const dateStr = entry.date instanceof Date ? fmtUTC(entry.date) : String(entry.date);
        const amt = entry.amount;
        const bal = entry.balanceAfter;
        const amtStr = (amt >= 0 ? '+' + sym : '-' + sym) + Math.abs(amt).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const balStr = bal != null ? (bal < 0 ? '-' + sym : sym) + Math.abs(bal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

        const cells = [
          { text: dateStr, cls: 'acct-history-tbl-td' },
          { text: entry.event?.type ?? '',    cls: 'acct-history-tbl-td acct-history-tbl-td--muted' },
          { text: entry.reducer?.name ?? '',  cls: 'acct-history-tbl-td acct-history-tbl-td--muted' },
          { text: amtStr, cls: `acct-history-tbl-td acct-history-tbl-td--mono ${amt >= 0 ? 'acct-history-tbl-td--pos' : 'acct-history-tbl-td--neg'}` },
          { text: balStr, cls: `acct-history-tbl-td acct-history-tbl-td--mono${bal != null && bal < 0 ? ' acct-history-tbl-td--neg' : ''}` },
        ];

        for (const { text, cls } of cells) {
          const td = tr.insertCell();
          td.textContent = text;
          td.className   = cls;
        }
      }
      body.appendChild(table);
    }

    modal.append(header, body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }
}
