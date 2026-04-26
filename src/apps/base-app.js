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

import { $, fmt, fmtUTC, fmtLocal} from '../visualization/ui-utils.js'
import { GraphView } from '../visualization/graph-view.js';
import { ChartView } from '../visualization/chart-view.js';
import { TimelineView } from '../visualization/timeline-view.js';
import { TimeControls } from '../visualization/time-controls.js';
import { EventScheduler } from '../visualization/event-scheduler.js';
import { ConfigGraphBuilder } from "../visualization/graph-builder.js";
import { ScenarioStorage } from "../scenarios/scenario-storage.js";
import { ScenarioSerializer } from "../scenarios/scenario-serializer.js";

export class BaseApp {
  constructor({ newScenario, chartSeries }) {

    this.newScenario = newScenario
    this.chartSeries = chartSeries ?? null;
    this._formatDate = (d) => d.toDateString();

    this.scenario = null;

    //UI
    this.configGraphBuilder = null;
    this.schedulerUI = null;
    this.graphView = null;
    this.chartView = null;
    this.timelineView = null;
    this.timeControls = null;

    //State
    this.playing = false;
    this.lastSliderValue = 0;
    this._currentDate = null;
    // Current display currency — 'USD' or 'AUD'.  Updated by the selector.
    this.displayCurrency = 'USD';

    this._scenarioData = ScenarioStorage.load();
    this._activeIdx = null; // null → use default CustomScenario

    //TODO REMOVE?
    this.activeTab = 'timeline';

    //TODO REMOVE ?
    this.activeSidebarTab = 'settings';

    this._scenarioData = ScenarioStorage.load();
    this._activeIdx = null; // null → use default CustomScenario

    // ── PeriodService: US calendar years 2026-2040, AU fiscal years 2025-2040
    const periodService = new FinSimLib.Finance.PeriodService();
    for (let y = 2026; y <= 2040; y++) FinSimLib.Finance.applyTo(periodService, FinSimLib.Finance.buildUsCalendarYear(y));
    for (let y = 2025; y <= 2040; y++) FinSimLib.Finance.applyTo(periodService, FinSimLib.Finance.buildAuFiscalYear(y));

  }

  // ── Params form ───────────────────────────────────────────────────────────────
  getParams() {
    const params = this._activeScenario()?.params;
    if (!params?.length) return {};
    return Object.fromEntries(params.map(p => [p.name, p.value]));
  }

  getInitialState() {
    return this._activeScenario()?.initialState ?? {};
  }

  // ── Active scenario helpers ───────────────────────────────────────────────

  _activeScenario() {
    if (this._activeIdx !== null) {
      return this._scenarioData.scenarios[this._activeIdx] ?? null;
    }
    return null;
  }

  /** Hook called after scenario.buildSim(). Loads saved config or falls back to defaults. */
  afterBuildSim() {
    const cfg = this._activeScenario();
    if (cfg) {
      // Restore a previously saved scenario — do not call loadDefaults().
      ScenarioSerializer.deserialize(cfg, this.scenario);
    } else if (typeof this.scenario.loadDefaults === 'function') {
      // No saved config: populate the scenario with its default configuration.
      this.scenario.loadDefaults();
    }
  }

  updateChart(chartView, type, date, state) {
    chartView.addSnapshot(type, date, state.metrics ? {...state.metrics} : {});
  }



  /**
   * Update the date formatter used by all views. Takes effect immediately
   * without requiring a simulation rebuild.
   * @param {function(Date): string} fn
   */
  setFormatDate(fn) {
    this._formatDate = fn;
    if (this.timeControls) this.timeControls.formatDate = fn;
    if (this.timelineView) {
      this.timelineView.formatDate = fn;
      // Rebuilt groups use new format — clear expand state so keys stay consistent
      this.timelineView.expanded.clear();
      this.timelineView._lastDate = null;
      this.timelineView._render();
    }
    if (this._currentDate) {
      $('timeLabel').textContent = fn(this._currentDate);
    }
  }

  buildScenario() {

    //Clear out state and metrics
    $('currentStateContent').innerHTML = '';
    $('cumulativeMetricsContent').innerHTML = '';

    //Stop Viz
    if (this.graphView)    this.graphView.stopViz();
    if (this.chartView)    this.chartView.stopViz();
    //TODO Need to stop other UI VIZ?
    //if(this.schedulerUI) this.schedulerUI.stopViz();

    //Setup the Configuration vizuals
    this.configGraphBuilder = new ConfigGraphBuilder({
      graphRoot: document.getElementById('graphRoot'),
      graphNodes: document.getElementById('graphNodes'),
      graphEdges: document.getElementById('graphEdges')
    });

    this.schedulerUI = new EventScheduler({
      builderCanvas: document.getElementById('builderCanvas'),
      graph: this.configGraphBuilder
    });

    //Setup the scenario
    this.scenario = this.newScenario(this.getParams(), this.getInitialState(), this.schedulerUI);

    //Recreate the simulator and configuration
    this.scenario.buildSim(this.getParams(), this.getInitialState());
    this.afterBuildSim();

    //TODO Share these across the app, color registry or something?
    const eventColors = new Map(
        (this.scenario.getRegisteredRecurringEvents() ?? []).map(s => [s.type, s.color]).filter(([, c]) => c)
    );

    /* Event Graph View */
    const graphCanvas = $('graphCanvas');
    if(graphCanvas) {
      this.graphView = new GraphView({
        simulator: this.scenario.sim,
        canvas: graphCanvas,
        getNodeDetail: (n) => this.getNodeDetail(n),
        formatNodeDetailHtml: (n) => this.formatNodeDetailHtml(n),
        simStart: this.scenario.simStart,
        simEnd: this.scenario.simEnd,
        eventColors
      });
      this.graphView.initView();
      this.graphView.startViz();
    }

    // ── Chart view ────────────────────────────────────────────────────
    const chartCanvas = $('chartCanvas');
    this.chartView = new ChartView({
      canvas:   chartCanvas,
      simStart: this.scenario.simStart,
      simEnd:   this.scenario.simEnd,
      series:   this.chartSeries ?? undefined
    });
    this.chartView.startViz();

    // Timeline view
    this.timelineView = new TimelineView({
      container:   $('timelineContainer'),
      onDetail:    (node) => this.showNodeDetail(node),
      onRewind:    (date) => {
        const pct = (date.getTime() - this.scenario.simStart.getTime()) /
                    (this.scenario.simEnd.getTime() - this.scenario.simStart.getTime());
        const clamped = Math.max(0, Math.min(1, pct));
        this.timeControls.rewindTo(clamped);
        const sliderVal = Math.round(clamped * 100);
        $('timeSlider').value = sliderVal;
        this.lastSliderValue = sliderVal;
      },
      formatDate:  this._formatDate,
    });
    this.timelineView.attach(this.scenario.sim.journal);

    // ─── Time controls ────────────────────────────────────────────────────────────
    this.timeControls = new TimeControls({
      scenario: this.scenario,
      timelineView: this.timelineView,
      graphView: this.graphView,
      chartView: this.chartView,
      timeLabel: $('timeLabel'),
      timeSlider: $('timeSlider'),
      formatDate: this._formatDate,
    });

    // Subscribe to RECORD_BALANCE DEBUG_ACTION events to capture balance snapshots
    this.scenario.sim.bus.subscribe('DEBUG_ACTION', ({ payload }) => {

      //Fire the date changed listeners
      const date = new Date(payload.date);
      this._currentDate = date;
      this.timeControls.onDateChanged(date);
      if(this.graphView) {
        this.graphView.updateView(payload);
      }
      this.updateStatePanel(date, payload.stateAfter);
      this.updateChart(this.chartView, payload.type, payload.date, payload.stateAfter);
      if(this.updateDashCards)
        this.updateDashCards(payload);
    });

    // Reset slider and direction tracker
    $('timeSlider').value = 0;
    this.lastSliderValue = 0;
    this._currentDate = this.scenario.simStart;
    $('timeLabel').textContent = this._formatDate(this.scenario.simStart);
  }

  buildActionDetail(entry) {
    const changes  = this.diffStates(entry.prevState, entry.nextState);
    const emitted  = entry.emittedActions?.length
        ? entry.emittedActions.map(a => a.type).join(', ')
        : '(none)';

    const actionPayload = JSON.stringify(
        Object.fromEntries(Object.entries(entry.action).filter(([k]) => !k.startsWith('_'))),
        null, 2
    );

    return {
      changes: changes,
      emitted: emitted,
      actionPayload: actionPayload
    }
  }

  updateStatePanel(date, state) {
    if (!state) return;

    const { metrics, ...rest } = state;
    const newStateDetails = this.createStateDetails('tpl-state-details', date, rest);
    const stateDetails = $('currentStateContent');
    stateDetails.replaceChildren(newStateDetails);

    const newMetricDetails = this.createStateDetails('tpl-state-details', date, metrics);
    const metricDetails = $('cumulativeMetricsContent');
    metricDetails.replaceChildren(newMetricDetails);
  }

  createStateDetails(templateId, date, state) {
    if (!state) return;
    const templateContent = document.querySelector(`#${templateId}`);
    const clone = document.importNode(templateContent, true).content;
    const statGrid = clone.querySelector('[data-stat-grid]');
    this.renderState(state, statGrid);
    return clone;
  }

  renderState(obj, statGrid){
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.length > 0 && v[0] !== null && typeof v[0] === 'object') {
        //Process an array of objects?
        const arrayHeaderRow = this.renderHeaderRow(k);
        statGrid.appendChild(arrayHeaderRow);

        //Array of Objects
        let index = 0;
        for (const item of v) {
          let name,value;
          if(this.isDate(item)) {
            name = '[' + index + ']';
            value = this._formatDate(item);
          }else {
            name  = item.name ?? JSON.stringify(item);
            value = item.value != null ? item.value : '';
          }

          const arrayRow = document.importNode(statGrid.querySelector('[data-stat-row]'), true);
          arrayRow.style = '';
          arrayRow.querySelector('.stat-label').innerText = name;
          arrayRow.querySelector('.stat-value').innerText = value;
          statGrid.appendChild(arrayRow);
          index++;
        }
      }else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        const objectHeaderRow = this.renderHeaderRow(k);
        statGrid.appendChild(objectHeaderRow);
        for (const [sk, sv] of Object.entries(v)) {
          if (Array.isArray(sv) && sv.length > 0 && typeof sv[0] === 'object') continue;
          const statRow = document.importNode(statGrid.querySelector('[data-stat-row]'), true);
          statRow.style = '';
          statRow.querySelector('.stat-label').innerText = this.toLabel(sk);
          statRow.querySelector('.stat-value').innerText = typeof sv === 'object' ? this.renderObj(sv) : sv;
          statGrid.appendChild(statRow);
        }
      } else {
        const statRow = document.importNode(statGrid.querySelector('[data-stat-row]'), true);
        statRow.style = '';
        statRow.querySelector('.stat-label').innerText = this.toLabel(k);
        statRow.querySelector('.stat-value').innerText = typeof v === 'object' ? this.renderObj(v) : this.fmtVal(v);
        statGrid.appendChild(statRow);
      }
    }
  }

  showNodeDetail(entry) {
    const actionDetail = this.buildActionDetail(entry);
    const changes = actionDetail.changes;
    const emitted= actionDetail.emitted;
    const actionPayload = actionDetail.actionPayload;
    const newActionDetails = this.createActionDetail('tpl-action-template', {entry, changes, emitted, actionPayload});
    const actionDetails =$('actionPanelDetails');
    actionDetails.replaceChildren(newActionDetails);
  }

  createActionDetail(templateId, content) {
    const templateContent = document.querySelector(`#${templateId}`);
    const clone = document.importNode(templateContent, true).content;

    //Populate overview
    const overviewGrid = clone.querySelector('[data-overview-grid]');
    const fields = overviewGrid.querySelectorAll('[data-id]');
    for(const field of fields) {
      const value = this.getNestedProperty(content, field.getAttribute('data-id'));
      field.innerText = this.fmtVal(value);
    }

    //Populate state changes
    const stateChangesGrid = clone.querySelector('[data-state-change-grid]');
    if(content.changes.length > 0) {
      //Compute the changes
      for(const change of content.changes) {
        const stateChangeRow = document.importNode(stateChangesGrid.querySelector('[data-state-change-row]'), true);
        stateChangeRow.style = '';
        stateChangeRow.querySelector('[data-id="field"]').innerText = change.field;
        stateChangeRow.querySelector('[data-id="before"]').innerHTML = this.fmtVal(change.before, true);
        if(change.delta != null) {
          const after = stateChangeRow.querySelector('[data-id="after"]');
          const delta = document.createElement('span');
          if(change.delta > 0) {
            delta.classList.add('diff-pos');
            delta.innerText = '+' + this.fmtVal(change.delta);
          }else {
            delta.classList.add('diff-neg');
            delta.innerText = '-' + this.fmtVal(change.delta);
          }
          after.innerHTML = this.fmtVal(change.after, true);
          after.appendChild(delta);
        }else {
          stateChangeRow.querySelector('[data-id="after"]').innerHTML = this.fmtVal(change.after, true);
        }
        stateChangesGrid.appendChild(stateChangeRow);
      }
    }else {
      stateChangesGrid.querySelector('[data-id="noChangeRow"]').style = '';
      const noChangeState = stateChangesGrid.querySelector('[data-id="noChangeState"]');
      noChangeState.style = '';
      noChangeState.innerHTML = `<pre>${JSON.stringify(content.entry.prevState,null, 2)}</pre>`;
    }
    return clone;
  }

  /**
   * Get the details for a node
   * @param node
   * @returns {string}
   */
  getNodeDetail(node) {
    const diff = this.diffStates(node.stateBefore, node.stateAfter);

    return JSON.stringify({
      ...node,
      stateDiff: diff
    }, null, 2);
  }

  /**
   * Compute the difference in state between 2 state snapshots.
   * Recursively walks plain objects; treats arrays and scalars as leaves.
   * Returns an array of { field, before, after, delta } records, where
   * delta is the numeric difference (or null for non-numeric changes).
   * @param {object} prev
   * @param {object} next
   * @returns {{ field: string, before: *, after: *, delta: number|null }[]}
   */
  diffStates(prev, next) {
    const changes = [];
    if (!prev || !next) return changes;

    // Ledger arrays grow on every transaction — skip them to keep diffs readable.
    const SKIP_KEYS = new Set(['credits', 'debits']);

    const walk = (b, a, prefix) => {
      const leafKey = prefix.split('.').pop();
      if (SKIP_KEYS.has(leafKey)) return;
      const bIsObj = typeof b === 'object' && b !== null && !Array.isArray(b);
      const aIsObj = typeof a === 'object' && a !== null && !Array.isArray(a);
      if (bIsObj && aIsObj) {
        for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
          walk(b[key], a[key], prefix ? `${prefix}.${key}` : key);
        }
      } else if (JSON.stringify(b) !== JSON.stringify(a)) {
        const delta = typeof a === 'number' && typeof b === 'number' ? a - b : null;
        changes.push({ field: prefix, before: b ?? null, after: a ?? null, delta });
      }
    };

    for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      walk(prev[key], next[key], key);
    }

    return changes;
  }

  // ─── Animate ──────────────────────────────────────────────────────────────────

  animate() {
    if (!this.playing) return;

    const slider = $('timeSlider');
    slider.value = Math.min(100, +slider.value + 1);

    this.timeControls.stepTo(+slider.value / 100);

    if (+slider.value < 100) {
      requestAnimationFrame(() => this.animate());
    } else {
      this.stopPlaying();
    }
  }

  startPlaying() {
    this.playing = true;
    // Playback drives the slider continuously, not event-by-event, so
    // clear the step-forward history.  stepBack() will use snapshot scanning.
    this.timeControls.clearStepHistory();
    $('playPause').textContent = '⏸';
    this.animate();
  }

  stopPlaying() {
    this.playing = false;
    $('playPause').textContent = '▶';
  }

  initView() {
    //Setup the tabs
    document.querySelectorAll('.tab-header').forEach(el => {
      el.addEventListener('click', (evt) => {
        const tabName = el.dataset.destTab;
        const tabGroup = el.dataset.tabGroup;
        this.openTab(evt, tabName, tabGroup);
      });
    });

    $('displayCurrency').addEventListener('change', () => {
      this.displayCurrency = $('displayCurrency').value;
      this.buildScenario();
    });

    $('tzSelect').addEventListener('change', () => {
      this.setFormatDate($('tzSelect').value === 'utc' ? fmtUTC : fmtLocal);
      this.renderEventList();
    });

    // Time controls
    $('playPause').addEventListener('click', () => this.playing ? this.stopPlaying() : this.startPlaying());

    $('stepForward').addEventListener('click', () => {
      this.timeControls.stepForward();
    });

    $('stepBackward').addEventListener('click', () => {
      this.timeControls.stepBack();
    });

    // True reset: rebuild the scenario from scratch so the sim queue and state
    // are pristine (rewindToStart only restores to snapshot 0, not time 0).
    $('resetBtn').addEventListener('click', () => this.buildScenario());

    let sliderTimeout;
    $('timeSlider').addEventListener('input', () => {
      clearTimeout(sliderTimeout);
      sliderTimeout = setTimeout(() => {
        const val = +$('timeSlider').value;
        if (val >= this.lastSliderValue) {
          // Moving forward — step incrementally, no rewind needed
          this.timeControls.stepTo(val / 100);
        } else {
          // Moving backward — must rewind and replay
          this.timeControls.rewindTo(val / 100);
        }
        this.lastSliderValue = val;
      }, 60);
    });

    // Params form
    $('rebuildBtn').addEventListener('click', () => this.buildScenario());

    $('tzSelect').addEventListener('change', () => {
      setFormatDate($('tzSelect').value === 'utc' ? fmtUTC : fmtLocal);
      renderEventList();
    });

    this._initScenarioTab();
    const eventsTabHeader = document.querySelector(`.tab-header[data-dest-tab=left-events][data-tab-group=left-col]`);
    this.openTab({currentTarget: eventsTabHeader}, 'left-events', 'left-col');

    window.addEventListener('resize', () => this.resizeCanvases());
    this.resizeCanvases();

  }

  resizeCanvases() {
    const contentEl = $('content');
    const w = contentEl.clientWidth;
    const h = contentEl.clientHeight;
    if(this.graphView) {
      this.graphView.resizeCanvas(h, w);
    }
    $('chartCanvas').width  = w;
    $('chartCanvas').height = h;
  }

  //UI Format HELPERS
  fmtVal(v, objAsCode = false) {
    if (v == null) return '—';
    if (typeof v === 'number') return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); //TODO Format as $?
    if (Array.isArray(v)) {
      return this.fmtArray(v, objAsCode)
    }
    if(this.isDate(v)) return this._formatDate(v);
    if (typeof v === 'object') {
      if(objAsCode) {
        return `<pre class="text-wrap:auto">${JSON.stringify(v, null, 2)}</pre>`;
      }else {
        return JSON.stringify(v);
      }
    }
    return String(v);
  }

  fmtArray(v, objAsCode = false){
    if (!Array.isArray(v)) return '';
    const limit = 10;
    const sliced = v.slice(0, limit).map(x => this.fmtVal(x, objAsCode)).join(', ') || '—';
    return v.length > limit ? `${sliced}, ...` : sliced;
  };

  getNestedProperty(obj, path) {
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
  }

  isDate(obj){
    //TODO: instanceof Date && !isNaN(d.getTime());
    return Object.prototype.toString.call(obj) === '[object Date]';
  }

  toLabel(key) {
    return key.replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
  }

  renderObj(v) {
    if (v == null) return '—';
    if (Array.isArray(v)) {
      if (v.length === 0) return '—';
      if (v.every(x => typeof x === 'number')) {
        return this.fmtArray(v);
      }
      return v.map(x => (typeof x === 'object' ? this.renderObj(x) : String(x))).join(', ');
    }
    if(typeof v === 'object') {
      if (v instanceof Date) return this._formatDate(v);
      let result = '{ ';
      for(let f in v) {
        result += f + ': ' + this.renderObj(v[f]) + ' }';
      }
      return result;
    }
    return String(v);
  }

  renderHeaderRow(label){
    const headerRow = document.createElement('div');
    headerRow.classList.add('data-row-header');
    const header = document.createElement('span');
    header.classList.add('single-row');
    header.classList.add('single-row');
    header.innerText = this.toLabel(label);
    headerRow.appendChild(header);
    return headerRow;
  };

  openTab(evt, tabName, tabGroup) {
    //TODO in the base.css .tab-content is display: none so every tab has to override display: css setting for this to work
    // Hide content
    document.querySelectorAll(`.tab-content[data-tab-group=${tabGroup}]`).forEach(el => el.style.display = "none");

    // Remove active class from the tab headers
    document.querySelectorAll(`.tab-header[data-tab-group=${tabGroup}]`).forEach(el => el.classList.remove("active"));

    //Get tab content and display it
    const tab = document.querySelector(`.tab-content[data-tab-group=${tabGroup}][data-tab=${tabName}]`);
    tab.style.display = "";

    //Active to click tab header
    evt.currentTarget.classList.add("active");
  }

  updateDashCards(payload) {
    $('cardCurrentDate').innerText = this.fmtVal(payload.date);
    $('cardActionCount').innerText = payload.id;
  }

  /**
   * Convert a value from one currency to the display currency.
   * @param {number} value       - Amount in the account's native currency
   * @param {'USD'|'AUD'} native - The account's native currency
   * @param {number} rate        - exchangeRateUsdToAud (1 USD = N AUD)
   */
  toDisplayCurrency(value, native, rate) {
    if (native === this.displayCurrency) return value;
    if (this.displayCurrency === 'AUD') return value * rate;   // USD → AUD
    return value / rate;                                   // AUD → USD
  }

  // ── Active scenario helpers ───────────────────────────────────────────────
  // ── Scenario tab wiring ──────────────────────────────────────────────────
  _initScenarioTab() {
    this._refreshScenarioSelect();

    document.getElementById('scenarioSelect').addEventListener('change', (e) => {
      const val = e.target.value;
      this._activeIdx = val === '' ? null : parseInt(val, 10);
      this._populateScenarioForm();
    });

    document.getElementById('loadScenarioBtn').addEventListener('click', () => {
      this.buildScenario();
    });

    document.getElementById('newScenarioBtn').addEventListener('click', () => {
      const newCfg = {
        name:         'New Scenario',
        simStart:     '2026-01-01',
        simEnd:       '2041-01-01',
        events:       [],
        handlers:     [],
        actions:      [],
        reducers:     [],
        initialState: { metrics: { amount: 0, salary: 0 } },
        params:       [],
      };
      this._scenarioData.scenarios.push(newCfg);
      this._activeIdx = this._scenarioData.scenarios.length - 1;
      this._refreshScenarioSelect();
      this._populateScenarioForm();
    });

    document.getElementById('deleteScenarioBtn').addEventListener('click', () => {
      if (this._activeIdx === null) return;
      this._scenarioData.scenarios.splice(this._activeIdx, 1);
      this._activeIdx = null;
      ScenarioStorage.save(this._scenarioData);
      this._refreshScenarioSelect();
      this._populateScenarioForm();
    });

    document.getElementById('scenarioName').addEventListener('input', (e) => {
      const cfg = this._activeScenario();
      if (!cfg) return;
      cfg.name = e.target.value;
      const sel = document.getElementById('scenarioSelect');
      if (sel.selectedIndex >= 0) sel.options[sel.selectedIndex].textContent = cfg.name || 'Unnamed';
    });

    document.getElementById('simStartInput').addEventListener('change', (e) => {
      const cfg = this._activeScenario();
      if (cfg) cfg.simStart = e.target.value;
    });

    document.getElementById('simEndInput').addEventListener('change', (e) => {
      const cfg = this._activeScenario();
      if (cfg) cfg.simEnd = e.target.value;
    });

    document.getElementById('initialStateJson').addEventListener('blur', (e) => {
      const cfg = this._activeScenario();
      if (!cfg) return;
      try {
        cfg.initialState = JSON.parse(e.target.value);
        e.target.style.borderColor = '';
      } catch {
        e.target.style.borderColor = 'red';
      }
    });

    document.getElementById('addParamBtn').addEventListener('click', () => {
      const cfg = this._activeScenario();
      if (!cfg) return;
      cfg.params.push({ name: '', type: 'Number', value: 0 });
      this._renderParamsList();
    });

    document.getElementById('saveScenarioBtn').addEventListener('click', () => {
      this._saveCurrentScenario();
    });

    document.getElementById('downloadJsonBtn').addEventListener('click', () => {
      ScenarioStorage.downloadJson(this._scenarioData);
    });

    document.getElementById('uploadJsonFileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = await ScenarioStorage.readUploadedJson(file);
        if (Array.isArray(data.scenarios)) {
          const existing = new Set(this._scenarioData.scenarios.map(s => s.name));
          for (const s of data.scenarios) {
            if (!existing.has(s.name)) {
              this._scenarioData.scenarios.push(s);
              existing.add(s.name);
            }
          }
        }
        ScenarioStorage.save(this._scenarioData);
        this._refreshScenarioSelect();
      } catch (err) {
        alert('Failed to parse JSON file: ' + err.message);
      }
      e.target.value = '';
    });
  }

  _refreshScenarioSelect() {
    const sel = document.getElementById('scenarioSelect');
    sel.innerHTML = '<option value="">— Default Scenario —</option>';
    this._scenarioData.scenarios.forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = s.name || `Scenario ${i + 1}`;
      sel.appendChild(opt);
    });
    sel.value = this._activeIdx !== null ? String(this._activeIdx) : '';
    this._populateScenarioForm();
  }

  _populateScenarioForm() {
    const cfg = this._activeScenario();
    document.getElementById('scenarioName').value       = cfg?.name     ?? '';
    document.getElementById('simStartInput').value      = cfg?.simStart ?? '2026-01-01';
    document.getElementById('simEndInput').value        = cfg?.simEnd   ?? '2041-01-01';
    document.getElementById('initialStateJson').value   = JSON.stringify(
        cfg?.initialState ?? { metrics: { amount: 0, salary: 0 } }, null, 2
    );
    this._renderParamsList();
  }

  _renderParamsList() {
    const cfg = this._activeScenario();
    const container = document.getElementById('paramsList');
    container.innerHTML = '';
    if (!cfg?.params?.length) return;

    cfg.params.forEach((param, i) => {
      const row = document.createElement('div');
      row.className = 'param-row';

      const nameInput = document.createElement('input');
      nameInput.placeholder = 'name';
      nameInput.value = param.name;
      nameInput.addEventListener('input', () => { param.name = nameInput.value; });

      const typeSelect = document.createElement('select');
      ['Number', 'String', 'Boolean'].forEach(t => {
        const opt = document.createElement('option');
        opt.value = t; opt.textContent = t;
        typeSelect.appendChild(opt);
      });
      typeSelect.value = param.type ?? 'Number';
      typeSelect.addEventListener('change', () => { param.type = typeSelect.value; });

      const valueInput = document.createElement('input');
      valueInput.placeholder = 'value';
      valueInput.value = String(param.value ?? '');
      valueInput.addEventListener('input', () => {
        const raw = valueInput.value;
        if (param.type === 'Number')  param.value = parseFloat(raw);
        else if (param.type === 'Boolean') param.value = raw === 'true';
        else param.value = raw;
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-warn btn-sm';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => {
        cfg.params.splice(i, 1);
        this._renderParamsList();
      });

      row.appendChild(nameInput);
      row.appendChild(typeSelect);
      row.appendChild(valueInput);
      row.appendChild(delBtn);
      container.appendChild(row);
    });
  }

  _saveCurrentScenario() {
    if (this._activeIdx === null) {
      // Create a new slot for the current default scenario
      const name = document.getElementById('scenarioName').value || 'Saved Scenario';
      let initialState = { metrics: { amount: 0, salary: 0 } };
      try { initialState = JSON.parse(document.getElementById('initialStateJson').value); } catch {}
      this._scenarioData.scenarios.push({
        name,
        simStart:     document.getElementById('simStartInput').value || '2026-01-01',
        simEnd:       document.getElementById('simEndInput').value   || '2041-01-01',
        events: [], handlers: [], actions: [], reducers: [],
        initialState,
        params: [],
      });
      this._activeIdx = this._scenarioData.scenarios.length - 1;
    }

    const cfg = this._activeScenario();

    // Serialize graph state + current form values into the config
    const serialized = ScenarioSerializer.serialize(
        this.configGraphBuilder,
        cfg.name,
        cfg.simStart,
        cfg.simEnd,
        cfg.initialState,
        cfg.params,
    );
    Object.assign(cfg, serialized);

    ScenarioStorage.save(this._scenarioData);
    this._refreshScenarioSelect();
  }

}
