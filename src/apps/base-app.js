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
import { ChartController }          from '../visualization/chart/chart-controller.js';
import { ChartView }                from '../visualization/chart/chart-view.js';
import { ChartPresenter }           from '../visualization/chart/chart-presenter.js';
import { TimelineController }        from '../visualization/timeline/timeline-controller.js';
import { TimelineView }             from '../visualization/timeline/timeline-view.js';
import { TimelinePresenter }        from '../visualization/timeline/timeline-presenter.js';
import { TimeControls }             from '../visualization/time-controls.js';
import { GraphBuilderPresenter }    from '../visualization/graph-builder/graph-builder-presenter.js';
import { ServiceRegistry }          from '../services/service-registry.js';
import {
  BusMessage,
  SIMULATION_BUS_MESSAGES,
  SimulationBusMessage
} from '../simulation-framework/bus-messages.js';
import { PeopleController }         from '../visualization/people/people-controller.js';
import { PeopleView }               from '../visualization/people/people-view.js';
import { PeoplePresenter }          from '../visualization/people/people-presenter.js';
import { AccountsController }       from '../visualization/accounts/accounts-controller.js';
import { AccountsView }             from '../visualization/accounts/accounts-view.js';
import { AccountsPresenter }        from '../visualization/accounts/accounts-presenter.js';
import { ScenarioTabPresenter }     from '../visualization/scenario/scenario-tab-presenter.js';
import { StatePanelView }           from '../visualization/simulation/state-panel-view.js';
import { SimulationAnimator }       from '../visualization/simulation/simulation-animator.js';
import {GraphRenderer} from "../visualization/components/graph-renderer.js";
import {BaseComponent} from "../visualization/components/base-component.js";
import {ScenarioTabView} from "../visualization/scenario/scenario-tab-view.js";
import { JournalReportingService } from '../finance/journal-reporting-service.js';
import { TaxDocumentModal }        from '../visualization/timeline/tax-document-modal.js';
import {
  ScenarioTabController
} from "../visualization/scenario/scenario-tab-controller.js";

/**
 * BaseApp — composition root.
 *
 * Instantiates and wires all sub-modules.  Contains no domain logic,
 * no DOM-rendering logic, and no state-management logic.
 *
 * Sub-modules:
 *   ScenarioTabPresenter  — scenario CRUD UI and data
 *   StatePanelView        — state/metrics panels and value formatting
 *   SimulationAnimator    — playback, config-graph highlighting, dashboard cards
 *   PeoplePresenter       — people sidebar MVP (recreated per buildScenario)
 *   AccountsPresenter     — accounts sidebar MVP (recreated per buildScenario)
 *   GraphBuilderPresenter — event-graph editor (recreated per buildScenario)
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
    this.configPresenter = null;
    this.chartPresenter        = null;
    this.timelinePresenter          = null;
    this.timeControls          = null;
    this.peoplePresenter       = null;
    this.accountsPresenter     = null;
    this.scenarioTabPresenter  = null;
    this._animator             = null;

    // Views created once — their DOM listeners are wired only once.
    this._peopleView      = new PeopleView();
    this._accountsView    = new AccountsView();
    this._statePanelView  = new StatePanelView();
    this._scenarioTabView = new ScenarioTabView();
    this._reportingService = new JournalReportingService();
    this._taxDocModal      = new TaxDocumentModal();

    // Tab header references set by initView()
    this.eventsTabHeader   = null;
    this.scenarioTabHeader = null;

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

    // ── Config graph (visual node canvas) ─────────────────────────────────────
    this.configPresenter = new GraphBuilderPresenter({
      builderCanvas: document.getElementById('builderCanvas'),
      //TODO Move into GraphBuilderPresenter._view entirely
      graphRenderer: new GraphRenderer({
        parent: this,
        graph: registry.graph,
        graphQueryApi: registry.graphQueryApi,
        graphRoot:               document.getElementById('graphRoot'),
        graphNodes:              document.getElementById('graphNodes'),
        graphEdges:              document.getElementById('graphEdges'),
        nodeDetailsTemplate:     document.getElementById('tpl-node-details'),
        displayNodeStateChanges: (changes) => this._statePanelView.showNodeStateChanges(changes),
      }),
      eventService: registry.eventService,
      handlerService: registry.handlerService,
      actionService: registry.actionService,
      reducerService: registry.reducerService,
      onNodeConfigurationView: () =>  {
        this.openTab({ currentTarget: this.eventsTabHeader }, 'left-events', 'left-col-sim');
      }
    });
    /*
    //TODO This should be put into the builder-presenter too
    this.configPresenter._graphRenderer.registerNodeClickListener(() =>
        this.openTab({ currentTarget: this.eventsTabHeader }, 'left-events', 'left-col-sim')
    );
    */
    //TODO This should be put into the builder-presenter too
    // Breakpoint listener: delegate to animator once it is created.
    this.configPresenter._graphRenderer.registerBreakpointChangeListener((node) => {
      this._animator?.toggleBreakpoint(node);
    });

    // ── People / Accounts MVP ─────────────────────────────────────────────────
    // Controllers and presenters are recreated each rebuild to bind to the fresh bus.
    const peopleController = new PeopleController({ personService: registry.personService });
    this.peoplePresenter   = new PeoplePresenter({ controller: peopleController, view: this._peopleView, bus: registry.bus });

    const accountsController = new AccountsController({ accountService: registry.accountService });
    this.accountsPresenter   = new AccountsPresenter({ controller: accountsController, view: this._accountsView, bus: registry.bus });

    this.peoplePresenter.onPeopleChanged = (people) => this.accountsPresenter.setPeople(people);

    // Scenario Tab
    const scenarioTabController = new ScenarioTabController({ scenarioService: registry.scenarioService })
    this.scenarioTabPresenter = new ScenarioTabPresenter({
      controller: scenarioTabController,
      view: this._scenarioTabView,
      bus: registry.bus,
      initScenario: () => { this.destroyScenario(); this.initScenario(); },
    });

    // ── Build scenario ────────────────────────────────────────────────────────
    //This will create the active scenario
    this.scenario = registry.scenarioService.createActiveScenario();
    this.scenario.buildSim();
    this.scenario.loadDefaults();
    this.accountsPresenter.setJournal(this.scenario.sim.journal);
    this.accountsPresenter.attachSimBus(this.scenario.sim.bus);
    this.accountsPresenter.setSimStateGetter(() => this.scenario.sim.state);

    // Derive display settings from DOM so rebuilds preserve user selections.
    const currentFmt      = $('tzSelect')?.value === 'utc' ? fmtUTC : fmtLocal;
    const currentCurrency = $('displayCurrency')?.value ?? 'USD';

    this._statePanelView.formatDate = currentFmt;

    // ── Visualization views ───────────────────────────────────────────────────
    const eventColors = new Map(
        registry.eventService.getAll()
        .filter(e => e.enabled && e.interval)
        .map(e => [e.type, e.color])
        .filter(([, c]) => c)
    );

    const chartController = new ChartController();
    const chartView = new ChartView({
      canvas:   $('chartCanvas'),
      simStart: this.scenario.simStart,
      simEnd:   this.scenario.simEnd,
      series:   this.chartSeries ?? undefined,
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
      formatDate: currentFmt,
    });
    this.timelinePresenter.attach(this.scenario.sim.journal);

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
      scenario:           this.scenario,
      timeControls:       this.timeControls,
      statePanelView:     this._statePanelView,
      chartView:          this.chartPresenter,
      graphRenderer:      this.configPresenter._graphRenderer,
      accountsPresenter:  this.accountsPresenter,
    });

    this._animator.toggleBreakpoint();
    this._animator.wireSimBus(this.scenario.sim.bus);

    // Track _currentDate for subclass access.
    this.scenario.sim.bus.subscribe(SIMULATION_BUS_MESSAGES.EVENT_OCCURRENCE_START, ({ date }) => {
      this._currentDate = new Date(date);
    });

    this._animator.updateDashCards(this.scenario.simStart);

    $('timeSlider').value      = 0;
    this.lastSliderValue       = 0;
    this._currentDate          = this.scenario.simStart;
    $('timeLabel').textContent = this.timeControls.formatDate(this.scenario.simStart);

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

    if (this.chartPresenter) this.chartPresenter.stopViz();
    if (this.configPresenter) this.configPresenter.destroy();
    if (this.peoplePresenter) this.peoplePresenter.destroy();
    if (this.accountsPresenter) this.accountsPresenter.destroy();
    if (this.timelinePresenter) this.timelinePresenter.destroy();


  }

  initView() {
    this._initGroupSelector(); //Init left-panel group selector

    this.eventsTabHeader   = document.querySelector('.tab-header[data-dest-tab=left-events][data-tab-group=left-col-sim]');
    this.scenarioTabHeader = document.querySelector('.tab-header[data-dest-tab=left-scenario][data-tab-group=left-col-sim]');

    document.querySelectorAll('.tab-header').forEach(el => {
      el.addEventListener('click', (evt) => this.openTab(evt, el.dataset.destTab, el.dataset.tabGroup));
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
    $('chartCanvas').width  = w;
    $('chartCanvas').height = h;
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
