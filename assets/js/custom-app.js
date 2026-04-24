/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
import { CustomScenario, DEFAULT_EVENT_SERIES } from './scenarios/custom-scenario.js';
import {$} from "../../src/visualization/ui-utils.js";

// ── Date formatters ───────────────────────────────────────────────────────────

// ── Chart series ──────────────────────────────────────────────────────────────
const CHART_SERIES = [
  { key: 'monthCounter',  color: '#60a5fa', label: 'Month Count'   },
  { key: 'yearCounter',   color: '#34d399', label: 'Year Count'  },
];

//TODO MOVE CURRENCY WORK TO BASE APP
// Current display currency — 'USD' or 'AUD'.  Updated by the selector.
let displayCurrency = 'USD';

//TODO MOVE CURRENCY WORK TO BASE APP
/**
 * Convert a value from one currency to the display currency.
 * @param {number} value       - Amount in the account's native currency
 * @param {'USD'|'AUD'} native - The account's native currency
 * @param {number} rate        - exchangeRateUsdToAud (1 USD = N AUD)
 */
function toDisplay(value, native, rate) {
  if (native === displayCurrency) return value;
  if (displayCurrency === 'AUD') return value * rate;   // USD → AUD
  return value / rate;                                   // AUD → USD
}

function chartSnapshot(chartView, date, state) {
  chartView.addSnapshot(date, {
    monthCounter: state.monthCount,
    yearCounter:   state.yearCount,
  });
}

// Editable event series list (copy so user toggles don't mutate the default)
let eventSeries  = DEFAULT_EVENT_SERIES.map(s => ({ ...s }));
let customEvents = [];
let initialState = {};

const app = new FinSimLib.Misc.BaseApp({
  newScenario:     (params) => new CustomScenario({ params, eventSeries, customEvents }),
  readParams,
  updateStatePanel: updateStatePanel,
  onChartSnapshot: chartSnapshot,
  showNodeDetail: showNodeDetail,
  updateDashCards: updateDashCards,
  chartSeries:     CHART_SERIES,
  formatDate:      FinSimLib.Visualization.fmtUTC
});

// ── Params form ───────────────────────────────────────────────────────────────
function readParams() {

}

//TODO Move to BaseApp, Also use in reducers.js
const getNestedProperty = (obj, path) => {
  return path.split('.').reduce((acc, part) => acc && acc[part], obj);
};
//TODO Move to BaseApp
const isDateValid = (d) => d instanceof Date && !isNaN(d.getTime());
//TODO Move to BaseApp
const isDate = (obj) => Object.prototype.toString.call(obj) === '[object Date]';
//TODO Move to BaseApp
const fmtVal = (v, objAsCode = false) => {
  if (v == null) return '—';
  if (typeof v === 'number') return v.toFixed(2); //TODO Format as $?
  if (Array.isArray(v)) {
    if(v.length > 10) {
      return fmtArray(v, objAsCode);
    }
    return v.map(x => typeof x === 'object' && x !== null ? fmtVal(x, objAsCode) : fmtVal(x, objAsCode)).join(', ') || '—';
  }
  if(isDate(v)) return app._formatDate(v);
  if (typeof v === 'object') {
    if(objAsCode) {
      return `<pre class="text-wrap:auto">${JSON.stringify(v, null, 2)}</pre>`;
    }else {
      return JSON.stringify(v);
    }
  }
  return String(v);
};

const fmtArray = (v, objAsCode = false) => {
  if (!Array.isArray(v)) return '';
  const limit = 10;
  const sliced = v.slice(0, limit).map(x => fmtVal(x, objAsCode)).join(', ');
  return v.length > limit ? `${sliced}, ...` : sliced;
};

//TODO Move to BaseApp
export function createActionDetail(templateId, content = { entry, changes, emitted, actionPayload }) {
  const templateContent = document.querySelector(`#${templateId}`);
  const clone = document.importNode(templateContent, true).content;

  //Populate overview
  const overviewGrid = clone.querySelector('[data-overview-grid]');
  const fields = overviewGrid.querySelectorAll('[data-id]');
  for(const field of fields) {
    const value = getNestedProperty(content, field.getAttribute('data-id'));
    field.innerText = fmtVal(value);
  }

  //Populate state changes
  const stateChangesGrid = clone.querySelector('[data-state-change-grid]');
  if(content.changes.length > 0) {
    //Compute the changes
    for(const change of content.changes) {
      const stateChangeRow = document.importNode(stateChangesGrid.querySelector('[data-state-change-row]'), true);
      stateChangeRow.style = '';
      stateChangeRow.querySelector('[data-id="field"]').innerText = change.field;
      stateChangeRow.querySelector('[data-id="before"]').innerHTML = fmtVal(change.before, true);
      if(change.delta != null) {
        const after = stateChangeRow.querySelector('[data-id="after"]');
        const delta = document.createElement('span');
        if(change.delta > 0) {
          delta.classList.add('diff-pos');
          delta.innerText = '+' + fmtVal(change.delta);
        }else {
          delta.classList.add('diff-neg');
          delta.innerText = '-' + fmtVal(change.delta);
        }
        after.innerHTML = fmtVal(change.after, true);
        after.appendChild(delta);
      }else {
        stateChangeRow.querySelector('[data-id="after"]').innerHTML = fmtVal(change.after, true);
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

//TODO Move to BaseApp
const toLabel = key => key
.replace(/([A-Z])/g, ' $1')
.replace(/_/g, ' ')
.replace(/\b\w/g, c => c.toUpperCase())
.trim();

//TODO Move to BaseApp, combing with fmtVal?
const renderObj = (v) => {
  if (v == null) return '—';
  if (Array.isArray(v)) {
    if (v.length === 0) return '—';
    if (v.every(x => typeof x === 'number')) {
      return fmtArray(v);
    }
    return v.map(x => (typeof x === 'object' ? renderObj(x) : String(x))).join(', ');
  }
  if(typeof v === 'object') {
    if (v instanceof Date) return app._formatDate(v);
    let result = '{ ';
    for(let f in v) {
      result += f + ': ' + renderObj(v[f]) + ' }';
    }
    return result;
  }
  return String(v);
}

//TODO Move to base app
const renderHeaderRow = (label) => {
  const headerRow = document.createElement('div');
  headerRow.classList.add('data-row-header');
  const header = document.createElement('span');
  header.classList.add('single-row');
  header.classList.add('single-row');
  header.innerText = toLabel(label);
  headerRow.appendChild(header);
  return headerRow;
};

//TODO Move to BaseApp
const renderState = (obj, statGrid) => {
  for (const [k, v] of Object.entries(obj)) {

    if (Array.isArray(v) && v.length > 0 && v[0] !== null && typeof v[0] === 'object') {
      //Process an array of objects?
      const arrayHeaderRow = renderHeaderRow(k);
      statGrid.appendChild(arrayHeaderRow);

      //Array of Objects
      let index = 0;
      for (const item of v) {
        let name,value;
        if(isDate(item)) {
          name = '[' + index + ']';
          value = app._formatDate(item);
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
      const objectHeaderRow = renderHeaderRow(k);
      statGrid.appendChild(objectHeaderRow);
      for (const [sk, sv] of Object.entries(v)) {
        if (Array.isArray(sv) && sv.length > 0 && typeof sv[0] === 'object') continue;
        const statRow = document.importNode(statGrid.querySelector('[data-stat-row]'), true);
        statRow.style = '';
        statRow.querySelector('.stat-label').innerText = toLabel(sk);
        statRow.querySelector('.stat-value').innerText = typeof sv === 'object' ? renderObj(sv) : sv;
        statGrid.appendChild(statRow);
      }
    } else {
      const statRow = document.importNode(statGrid.querySelector('[data-stat-row]'), true);
      statRow.style = '';
      statRow.querySelector('.stat-label').innerText = toLabel(k);
      statRow.querySelector('.stat-value').innerText = typeof k === 'object' ? renderObj(v) : fmtVal(v);
      statGrid.appendChild(statRow);
    }
  }
};

//TODO Move to BaseApp
function createStateDetails(templateId, date, state) {
  if (!state) return;
  const templateContent = document.querySelector(`#${templateId}`);
  const clone = document.importNode(templateContent, true).content;
  const statGrid = clone.querySelector('[data-stat-grid]');
  renderState(state, statGrid);
  return clone;
}

//TODO Move to base app to share
function updateStatePanel(date, state) {
  if (!state) return;

  const { metrics, ...rest } = state;
  const newStateDetails = createStateDetails('stateDetailsTemplate', date, rest);
  const stateDetails = FinSimLib.Visualization.$('currentStateContent');
  stateDetails.replaceChildren(newStateDetails);

  const newMetricDetails = createStateDetails('stateDetailsTemplate', date, metrics);
  const metricDetails = FinSimLib.Visualization.$('cumulativeMetricsContent');
  metricDetails.replaceChildren(newMetricDetails);

}

//TODO Move to base app to share
function showNodeDetail(entry) {
  const actionDetail = app.buildActionDetail(entry);
  const changes = actionDetail.changes;
  const emitted= actionDetail.emitted;
  const actionPayload = actionDetail.actionPayload;
  const newActionDetails = createActionDetail('actionTemplate', {entry, changes, emitted, actionPayload});
  const actionDetails = FinSimLib.Visualization.$('actionPanelDetails');
  actionDetails.replaceChildren(newActionDetails);
}

//TODO Move to base app
function updateDashCards(payload) {
  $('cardCurrentDate').innerText = fmtVal(payload.date);
  $('cardActionCount').innerText = payload.id;
}

//TODO Move to base app
function openTab(evt, tabName, tabGroup) {
  // Hide content
  document.querySelectorAll(`.tab-content[data-tab-group=${tabGroup}]`).forEach(el => el.style.display = "none");

  // Remove active class from the tab headers
  document.querySelectorAll(`.tab-header[data-tab-group=${tabGroup}]`).forEach(el => el.classList.remove("active"));

  //Get tab content and display it
  const tab = document.querySelector(`.tab-content[data-tab-group=${tabGroup}][data-tab=${tabName}]`);
  tab.style.display = "";

  //Active to clicke tab header
  evt.currentTarget.classList.add("active");
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  //Setup the tabs TODO Move this to base app
  document.querySelectorAll('.tab-header').forEach(el => {
    el.addEventListener('click', (evt) => {
      const tabName = el.dataset.destTab;
      const tabGroup = el.dataset.tabGroup;
      openTab(evt, tabName, tabGroup);
    });
  });

  app.initView();

  //TODO Add to Base APP
  FinSimLib.Visualization.$('tzSelect').addEventListener('change', () => {
    app.setFormatDate($('tzSelect').value === 'utc' ? fmtUTC : fmtLocal);
    renderEventList();
  });

  //TODO Add to Base app
  FinSimLib.Visualization.$('displayCurrency').addEventListener('change', () => {
    displayCurrency = $('displayCurrency').value;
    app.buildScenario();
  });

  app.buildScenario();

  //TODO REBUILD CONFIG
  /**
   * const graphConfig = graph.buildConfig();
   *   const eventConfig = scheduler.build(graphConfig);
   *
   *   console.log('GRAPH:', graphConfig);
   *   console.log('EVENTS:', eventConfig);
   */

  //TODO This only happens on RECORD_BALANCE in the base-app, need to fix
  app.scenario.sim.bus.subscribe('DEBUG_ACTION', ({ payload }) => {
    chartSnapshot(app.chartView, payload.date, payload.stateAfter);
  });
});
