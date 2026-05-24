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
import { GraphView }                from '../visualization/graph-view.js';
import { ChartView }                from '../visualization/chart-view.js';
import { TimelineView }             from '../visualization/timeline-view.js';
import { TimeControls }             from '../visualization/time-controls.js';
import { GraphBuilderPresenter }    from '../visualization/graph-builder/graph-builder-presenter.js';
import { GraphSync }                from '../visualization/graph-sync.js';
import { ConfigGraph }              from '../visualization/config-graph.js';
import { ServiceRegistry }          from '../services/service-registry.js';
import { SIMULATION_BUS_MESSAGES }  from '../simulation-framework/bus-messages.js';
import { PeopleController }         from '../visualization/people/people-controller.js';
import { PeopleView }               from '../visualization/people/people-view.js';
import { PeoplePresenter }          from '../visualization/people/people-presenter.js';
import { AccountsController }       from '../visualization/accounts/accounts-controller.js';
import { AccountsView }             from '../visualization/accounts/accounts-view.js';
import { AccountsPresenter }        from '../visualization/accounts/accounts-presenter.js';
import { ScenarioTabPresenter }     from './scenario-tab-presenter.js';
import { StatePanelView }           from './state-panel-view.js';
import { SimulationAnimator }       from './simulation-animator.js';

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
export class BaseApp {
  constructor({ newScenario, chartSeries }) {

    this.newScenario = newScenario;
    this.chartSeries = chartSeries ?? null;
    this.scenario    = null;

    // UI handles (recreated each buildScenario)
    this.graphBuilderPresenter = null;
    this.schedulerUI           = null;
    this.graphView             = null;
    this.chartView             = null;
    this.timelineView          = null;
    this.timeControls          = null;
    this.peoplePresenter       = null;
    this.accountsPresenter     = null;
    this._animator             = null;

    // Views created once — their DOM listeners are wired only once.
    this._peopleView      = new PeopleView();
    this._accountsView    = new AccountsView();
    this._statePanelView  = new StatePanelView();

    // Scenario tab owns _scenarioData / _activeIdx.
    this._scenarioTab = new ScenarioTabPresenter();

    // Tab header references set by initView()
    this.eventsTabHeader   = null;
    this.scenarioTabHeader = null;

    // Playback/slider state
    this.lastSliderValue = 0;
    this._currentDate    = null;

    // ── PeriodService ─────────────────────────────────────────────────────────
    const periodService = new FinSimLib.Finance.PeriodService();
    for (let y = 2026; y <= 2040; y++) FinSimLib.Finance.applyTo(periodService, FinSimLib.Finance.buildUsCalendarYear(y));
    for (let y = 2025; y <= 2040; y++) FinSimLib.Finance.applyTo(periodService, FinSimLib.Finance.buildAuFiscalYear(y));
  }

  // ── Delegators for scenario data (subclasses may call these) ─────────────

  getParams()       { return this._scenarioTab.getParams(); }
  getInitialState() { return this._scenarioTab.getInitialState(); }

  afterBuildSim() { this._scenarioTab.afterBuildSim(this.scenario); }

  // ── Core lifecycle ────────────────────────────────────────────────────────

  buildScenario() {

    // Reset all services, bus, and SimulationRegistry so every rebuild starts clean.
    ServiceRegistry.reset();

    $('currentStateContent').innerHTML  = '';
    $('cumulativeMetricsContent').innerHTML = '';

    if (this.graphView)  this.graphView.stopViz();
    if (this.chartView)  this.chartView.stopViz();

    // ── Config graph (visual node canvas) ─────────────────────────────────────
    if (this.graphBuilderPresenter) this.graphBuilderPresenter.destroy();
    this.graphBuilderPresenter = new ConfigGraph({
      graphRoot:               document.getElementById('graphRoot'),
      graphNodes:              document.getElementById('graphNodes'),
      graphEdges:              document.getElementById('graphEdges'),
      nodeDetailsTemplate:     document.getElementById('tpl-node-details'),
      displayNodeStateChanges: (changes) => this._statePanelView.showNodeStateChanges(changes),
    });

    this.graphBuilderPresenter.registerNodeClickListener(() =>
      this.openTab({ currentTarget: this.eventsTabHeader }, 'left-events', 'left-col-sim')
    );

    // Breakpoint listener: delegate to animator once it is created.
    this.graphBuilderPresenter.registerBreakpointChangeListener(() => {
      this._animator?.syncBreakpoints();
    });

    // ── Event-graph editor (scheduler UI) ─────────────────────────────────────
    this.schedulerUI = new GraphBuilderPresenter({
      builderCanvas: document.getElementById('builderCanvas'),
      graph:         this.graphBuilderPresenter,
    });

    const registry = ServiceRegistry.getInstance();
    new GraphSync({ graph: this.graphBuilderPresenter, registry });

    // ── People / Accounts MVP ─────────────────────────────────────────────────
    // Controllers and presenters are recreated each rebuild to bind to the fresh bus.
    const peopleController = new PeopleController({ personService: registry.personService });
    this.peoplePresenter   = new PeoplePresenter({ controller: peopleController, view: this._peopleView, bus: registry.bus });

    const accountsController = new AccountsController({ accountService: registry.accountService });
    this.accountsPresenter   = new AccountsPresenter({ controller: accountsController, view: this._accountsView, bus: registry.bus });

    this.peoplePresenter.onPeopleChanged = (people) => this.accountsPresenter.setPeople(people);

    // ── Build scenario ────────────────────────────────────────────────────────
    this.scenario = this.newScenario(this.getParams(), this.getInitialState(), this.schedulerUI);
    this.scenario.buildSim(this.getParams(), this.getInitialState());
    this.afterBuildSim();

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

    const graphCanvas = $('graphCanvas');
    if (graphCanvas) {
      this.graphView = new GraphView({
        simulator:            this.scenario.sim,
        canvas:               graphCanvas,
        getNodeDetail:        (n) => this._statePanelView.getNodeDetail(n),
        formatNodeDetailHtml: (n) => this.formatNodeDetailHtml(n),
        simStart:             this.scenario.simStart,
        simEnd:               this.scenario.simEnd,
        eventColors,
      });
      this.graphView.initView();
      this.graphView.startViz();
    }

    this.chartView = new ChartView({
      canvas:   $('chartCanvas'),
      simStart: this.scenario.simStart,
      simEnd:   this.scenario.simEnd,
      series:   this.chartSeries ?? undefined,
    });
    this.chartView.startViz();

    this.timelineView = new TimelineView({
      container:  $('timelineContainer'),
      onDetail:   (node) => this._statePanelView.showNodeDetail(node),
      onRewind:   (date) => {
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
    this.timelineView.attach(this.scenario.sim.journal);

    this.timeControls = new TimeControls({
      scenario:        this.scenario,
      timelineView:    this.timelineView,
      graphView:       this.graphView,
      chartView:       this.chartView,
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
      configGraph:    this.graphBuilderPresenter,
      scenario:       this.scenario,
      timeControls:   this.timeControls,
      statePanelView: this._statePanelView,
      graphView:      this.graphView,
      chartView:      this.chartView,
    });

    this._animator.syncBreakpoints();
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
      this.buildScenario();
    });

    $('tzSelect').addEventListener('change', () => {
      const fmt = $('tzSelect').value === 'utc' ? fmtUTC : fmtLocal;
      if (this.timeControls) this.timeControls.setFormatDate(fmt);
      this._statePanelView.formatDate = fmt;
      //TODO Need to reload views with new dates
      this.renderEventList();
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

    $('rebuildBtn').addEventListener('click', () => this.buildScenario());

    this._scenarioTab.init(() => this.buildScenario());
    this.openTab({ currentTarget: this.scenarioTabHeader }, 'left-scenario', 'left-col-sim');

    window.addEventListener('resize', () => this.resizeCanvases());
    this.resizeCanvases();
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

  // ── Backwards-compat delegators for subclasses ────────────────────────────

  /** Playback state — delegated to animator (false before first buildScenario). */
  get playing()    { return this._animator?.playing ?? false; }
  set playing(val) { if (this._animator) this._animator.playing = val; }

  /**
   * TODO Refactor to remove these, they should be in the views.
   * Formatting helpers — subclasses and custom scenarios may call these.
   * fmtVal syncs timeControls.formatDate into StatePanelView so that tests
   * which stub timeControls directly continue to work.
   */
  fmtVal(v, objAsCode = false) {
    if (this.timeControls?.formatDate) this._statePanelView.formatDate = this.timeControls.formatDate;
    return this._statePanelView.fmtVal(v, objAsCode);
  }
  fmtArray(v, objAsCode = false){ return this._statePanelView.fmtArray(v, objAsCode); }
  diffStates(prev, next)        { return this._statePanelView.diffStates(prev, next); }
  toLabel(key)                  { return this._statePanelView.toLabel(key); }
  isDate(obj)                   { return this._statePanelView.isDate(obj); }
  renderObj(v)                  { return this._statePanelView.renderObj(v); }
  renderHeaderRow(label)        { return this._statePanelView.renderHeaderRow(label); }
  getNestedProperty(obj, path)  { return this._statePanelView.getNestedProperty(obj, path); }
  buildActionDetail(entry)      { return this._statePanelView.buildActionDetail(entry); }
  getNodeDetail(node)           { return this._statePanelView.getNodeDetail(node); }

  /** State panel — subclasses may call these to push custom content. */
  updateStatePanel(date, state)   { return this._statePanelView.updateStatePanel(date, state); }
  showNodeStateChanges(changes)   { return this._statePanelView.showNodeStateChanges(changes); }
  showNodeDetail(entry)           { return this._statePanelView.showNodeDetail(entry); }

  /** Dashboard cards — subclasses may call to force a refresh. */
  updateDashCards(date) { return this._animator?.updateDashCards(date); }
}
