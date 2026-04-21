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

// ── Date formatters ───────────────────────────────────────────────────────────

// ── Chart series ──────────────────────────────────────────────────────────────
const CHART_SERIES = [
  { key: 'monthCounter',  color: '#60a5fa', label: 'Month Count'   },
  { key: 'yearCounter',   color: '#34d399', label: 'Year Count'  },
];

//TODO MOVE CURRENCY WORK TO BASE APP
// Current display currency — 'USD' or 'AUD'.  Updated by the selector.
let displayCurrency = 'USD';

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
  chartSeries:     CHART_SERIES,
  formatDate:      FinSimLib.Visualization.fmtUTC
});

// ── Params form ───────────────────────────────────────────────────────────────
function readParams() {
  const handlerLogic = FinSimLib.Visualization.$('handlerFunction').value;
  const reducerLogic = FinSimLib.Visualization.$('reducerFunction').value;
  return {
    handlerLogic: new Function('{data, date, state}', handlerLogic),
    reducerLogic: new Function('state,action,date', reducerLogic)
  };
}

//TODO Move to BaseApp
const getNestedProperty = (obj, path) => {
  return path.split('.').reduce((acc, part) => acc && acc[part], obj);
};
//TODO Move to BaseApp
const isDateValid = (d) => d instanceof Date && !isNaN(d.getTime());
//TODO Move to BaseApp
const isDate = (obj) => Object.prototype.toString.call(obj) === '[object Date]';
//TODO Move to BaseApp
const fmtVal = v => {
  if (v == null) return '—';
  if (typeof v === 'number') return v; //TODO Format as $?
  if (Array.isArray(v)) return v.map(x => typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x)).join(', ') || '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
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
    if(isDate(value)) {
      field.innerText = app._formatDate(value);
    }else {
      field.innerText = value;
    }
  }

  //Populate state changes
  const stateChangesGrid = clone.querySelector('[data-state-change-grid]');
  if(content.changes.length > 0) {
    //Compute the changes
    for(const change of content.changes) {
      const stateChangeRow = document.importNode(stateChangesGrid.querySelector('[data-state-change-row]'), true);
      stateChangeRow.style = '';
      stateChangeRow.querySelector('[data-id="field"]').innerText = change.field;
      stateChangeRow.querySelector('[data-id="before"]').innerText = fmtVal(change.before);
      if(change.delta != null) {
        const after = stateChangeRow.querySelector('[data-id="after"]');
        const delta = document.createElement('span');
        if(change.delta > 0) {
          delta.classList.add('diff-pos');
          delta.innerText = '+' + change.delta;
        }else {
          delta.classList.add('diff-neg');
          delta.innerText = '-' + change.delta;
        }
        after.innerText = fmtVal(change.after);
        after.appendChild(delta);
      }else {
        stateChangeRow.querySelector('[data-id="after"]').innerText = fmtVal(change.after);
      }
      stateChangesGrid.appendChild(stateChangeRow);
    }
  }else {
    stateChangesGrid.querySelector('[data-id="noChangeRow"]').style = '';
    const noChangeState = stateChangesGrid.querySelector('[data-id="noChangeState"]');
    noChangeState.style = '';
    noChangeState.innerText = JSON.stringify(content.entry.prevState,null, 2);
  }
  return clone;
}

//TODO Move to BaseApp
const toLabel = key => key
.replace(/([A-Z])/g, ' $1')
.replace(/_/g, ' ')
.replace(/\b\w/g, c => c.toUpperCase())
.trim();

//TODO Move to BaseApp
const renderObj = (v) => {
  if (v == null) return '—';
  if (Array.isArray(v)) {
    if (v.length === 0) return '—';
    if (v.every(x => typeof x === 'number'))
      return v.reduce((a, b) => a + b, 0);
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

//TODO Move to BaseApp
const renderState = (obj, statGrid) => {
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length > 0 && v[0] !== null && typeof v[0] === 'object') {
      const statRow = document.importNode(statGrid.querySelector('[data-stat-row]'), true);
      statRow.style = '';
      const label = statRow.querySelector('.stat-label');
      label.innerHTML = toLabel(k);
      const value = statRow.querySelector('.stat-value');
      value.innerText = v.length;
      statGrid.appendChild(statRow);

      for (const item of v) {
        const name  = item.name ?? JSON.stringify(item);
        const value = item.value != null ? item.value : '';
        const arrayRow = document.importNode(statGrid.querySelector('[data-stat-row]'), true);
        arrayRow.style = '';
        arrayRow.querySelector('.stat-label').innerText = name;
        arrayRow.querySelector('.stat-value').innerText = value;
        statGrid.appendChild(arrayRow);
      }
    }else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const objectHeaderRow = document.createElement('div');
      objectHeaderRow.classList.add('data-row-header');
      const objectHeader = document.createElement('span');
      objectHeader.classList.add('single-row');
      objectHeader.classList.add('single-row');
      objectHeader.innerText = toLabel(k);
      objectHeaderRow.appendChild(objectHeader);
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
      statRow.querySelector('.stat-value').innerText = typeof k === 'object' ? renderObj(v) : v;
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

  const newMetricDetails = createStateDetails('stateDetailsTemplate', date, rest);
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

// ── Event list UI ─────────────────────────────────────────────────────────────
function renderEventList() {
  const list = FinSimLib.Visualization.$('eventList');
  list.innerHTML = '';

  eventSeries.forEach((series, i) => {
    const row = document.createElement('div');
    row.className = 'event-row';
    row.innerHTML = `
      <label>
        <input type="checkbox" data-idx="${i}" ${series.enabled ? 'checked' : ''}>
        ${series.label}
      </label>
      <button class="remove-event" data-idx="${i}" title="Remove">✕</button>`;
    list.appendChild(row);
  });

  customEvents.forEach((ev, i) => {
    const row = document.createElement('div');
    row.className = 'event-row custom-event';
    row.innerHTML = `
      <span>${ev.type} on ${app._formatDate(new Date(ev.date))}${ev.amount != null ? ' ($' + ev.amount.toLocaleString() + ')' : ''}</span>
      <button class="remove-custom" data-idx="${i}" title="Remove">✕</button>`;
    list.appendChild(row);
  });

  list.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => { eventSeries[+cb.dataset.idx].enabled = cb.checked; });
  });
  list.querySelectorAll('.remove-event').forEach(btn => {
    btn.addEventListener('click', () => { eventSeries.splice(+btn.dataset.idx, 1); renderEventList(); });
  });
  list.querySelectorAll('.remove-custom').forEach(btn => {
    btn.addEventListener('click', () => { customEvents.splice(+btn.dataset.idx, 1); renderEventList(); });
  });
}

function submitAddEvent() {
  const type   = FinSimLib.Visualization.$('newEventType').value;
  const date   = FinSimLib.Visualization.$('newEventDate').value;
  const amount = FinSimLib.Visualization.$('newEventAmount').value;
  if (!date) { alert('Please pick a date.'); return; }
  customEvents.push({ type, date: new Date(date + 'T00:00:00'), amount: amount ? +amount : null });
  FinSimLib.Visualization.$('newEventDate').value   = '';
  FinSimLib.Visualization.$('newEventAmount').value = '';
  FinSimLib.Visualization.$('addEventForm').classList.add('hidden');
  renderEventList();
}

//TODO Move to base app
function openTab(evt, tabName, tabGroup) {
  // Hide content
  document.querySelectorAll(`.tab-content[data-tab-group=${tabGroup}]`).forEach(el => el.style.display = "none");

  // Remove active class from the tab headers
  document.querySelectorAll(`.tab-header[data-tab-group=${tabGroup}]`).forEach(el => el.classList.remove("active"));

  //Get tab content and display it
  const tab = document.querySelector(`.tab-content[data-tab-group=${tabGroup}][data-tab=${tabName}]`);
  tab.style.display = "block";

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

  FinSimLib.Visualization.$('handlerFunction').value = `return [{ type: 'CUSTOM_EVENT', data}];`;
  FinSimLib.Visualization.$('reducerFunction').value = `return { state: { ...state, customString: 'customReducerFired', customList: [1,2,3], customObject: {one: 1, two:2, three: {one: 1, two: {one: 1}}}}};`;

  app.initView();
  FinSimLib.Visualization.$('addEventBtn').addEventListener('click',    () => $('addEventForm').classList.toggle('hidden'));
  FinSimLib.Visualization.$('submitEventBtn').addEventListener('click', submitAddEvent);
  FinSimLib.Visualization.$('cancelEventBtn').addEventListener('click', () => $('addEventForm').classList.add('hidden'));

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

  FinSimLib.Visualization.$('testHandlerLogic').addEventListener('click', () => {
    const errEl = $('handlerFunctionError');
    const outEl = $('handlerLogicTestOut');
    const logic = $('handlerFunction').value;
    const fn     = new Function('{data, date, state}', logic);
    const data = {};
    const date = new Date();
    const state = { ...initialState };
    const testIn = { data, date, state};
    try {
      const result = fn(testIn);
      if (!Array.isArray(result))
        throw new Error('Return value must be an Array');
      outEl.style.display = 'block';
      outEl.innerHTML = `
        <div class="test-in">IN: ${JSON.stringify(testIn)}</div>
        <div class="test-out">OUT: ${JSON.stringify(result)}</div>
      `;
    }catch (e) {
      errEl.innerHTML = `&#x2717; ${e.message}`;
    }
  });

  FinSimLib.Visualization.$('testReducerLogic').addEventListener('click', () => {
    const errEl = FinSimLib.Visualization.$('reducerFunctionError');
    const outEl = FinSimLib.Visualization.$('reducerLogicTestOut');
    const logic = FinSimLib.Visualization.$('reducerFunction').value;
    try {
      const fn     = new Function('state,action,date', logic);
      const state = { ...initialState };
      const action = {type: 'CUSTOM_EVENT', state};
      const date = new Date();
      const testIn = { state, action, date};
      const result = fn(testIn);
      const isPlainObject = (val) => Object.prototype.toString.call(val) === '[object Object]';
      if (!isPlainObject(result))
        throw new Error('Return value must be an Object');
      outEl.style.display = 'block';
      outEl.innerHTML = `
        <div class="test-in">IN: ${JSON.stringify(testIn)}</div>
        <div class="test-out">OUT: ${JSON.stringify(result)}</div>
      `;
    }catch (e) {
      errEl.innerHTML = `&#x2717; ${e.message}`;
    }
  });

  renderEventList();
  app.buildScenario();

  //TODO This only happens on RECORD_BALANCE in the base-app, need to fix
  app.scenario.sim.bus.subscribe('DEBUG_ACTION', ({ payload }) => {
    chartSnapshot(app.chartView, payload.date, payload.stateAfter);
  });
});
