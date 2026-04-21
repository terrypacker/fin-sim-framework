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
const $ = FinSimLib.Visualization.$;
const fmt = FinSimLib.Visualization.fmt;

// ── Date formatters ───────────────────────────────────────────────────────────
//TODO Move into Base App
const fmtUTC   = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
const fmtLocal = d => d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });

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
  formatDate:      fmtUTC
});

// ── Params form ───────────────────────────────────────────────────────────────
function readParams() {
  const handlerLogic = $('handlerFunction').value;
  const reducerLogic = $('reducerFunction').value;
  return {
    handlerLogic: new Function('{data, date, state}', handlerLogic),
    reducerLogic: new Function('state,action,date', reducerLogic)
  };
}

//TODO Move to base app to share
function updateStatePanel(date, state) {
  if (!state) return;

  const toLabel = key => key
  .replace(/([A-Z])/g, ' $1')
  .replace(/_/g, ' ')
  .replace(/\b\w/g, c => c.toUpperCase())
  .trim();

  const renderVal = (v) => {
    if (typeof v === 'number') return fmt(v);
    return String(v);
  };

  const renderObj = (v) => {
    if (v == null) return '—';
    if (Array.isArray(v)) {
      if (v.length === 0) return '—';
      if (v.every(x => typeof x === 'number'))
        return fmt(v.reduce((a, b) => a + b, 0));
      return v.map(x => (typeof x === 'object' ? renderObj(x) : String(x))).join(', ');
    }
    if(typeof v === 'object') {
      if (v instanceof Date) return this._formatDate(v);
      let result = '<br>';
      for(let f in v) {
        result += f + ': ' + renderObj(v[f]) + '<br>';
      }
      return result;
    }
    return String(v);
  }

  const statRow = (k, v, indent) =>
      `<div class="data-row"${indent ? ' style="padding-left:12px"' : ''}>` +
      `<span class="stat-label">${toLabel(k)}</span>` +
      `<span class="stat-value">${typeof v === 'object' ? renderObj(v) : renderVal(v)}</span></div>`;

  const renderSection = obj => {
    let html = '';
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.length > 0 && v[0] !== null && typeof v[0] === 'object') {
        html += `<div class="data-row"><span class="stat-label">${toLabel(k)}</span>` +
            `<span class="stat-value">${v.length}</span></div>`;
        for (const item of v) {
          const name  = item.name ?? JSON.stringify(item);
          const value = item.value != null ? fmt(item.value) : '';
          html += `<div class="data-row" style="padding-left:12px">` +
              `<span class="stat-label">${name}</span>` +
              `<span class="stat-value">${value}</span></div>`;
        }
      } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        html += `<div class="data-section-title" style="font-size:10px;margin-top:6px">${toLabel(k)}</div>`;
        for (const [sk, sv] of Object.entries(v)) {
          if (Array.isArray(sv) && sv.length > 0 && typeof sv[0] === 'object') continue;
          html += statRow(sk, sv, true);
        }
      } else {
        html += statRow(k, v, false);
      }
    }
    return html;
  };

  const { metrics, ...rest } = state;
  const header = `<div class="data-row"><span>NAME</span><span>VALUE</span></div>`;
  $('currentStateContent').innerHTML = header + renderSection(rest);
  $('cumulativeMetricsContent').innerHTML = metrics ? renderSection(metrics) : '—';
}

//TODO Move to base app to share
function showNodeDetail(entry) {
  const actionDetail = app.buildActionDetail(entry);
  const changes = actionDetail.changes;
  const emitted= actionDetail.emitted;
  const actionPayload = actionDetail.actionPayload;

  const diffRows = changes.length === 0
      ? '<div class="data-row"><span style="grid-column: 1 / -1">No scalar state changes</span></div>'
      : changes.map(c => {
        const fmtVal = v => {
          if (v == null) return '—';
          if (typeof v === 'number') return fmt(v);
          if (Array.isArray(v)) return v.map(x => typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x)).join(', ') || '—';
          if (typeof v === 'object') return JSON.stringify(v);
          return String(v);
        };
        const deltaHtml = c.delta != null
            ? `<span class="${c.delta >= 0 ? 'diff-pos' : 'diff-neg'}">${c.delta >= 0 ? '+' : ''}${fmt(c.delta)}</span>`
            : '';
        return `<div class="data-row">
          <span class="diff-field">${c.field}</span>
          <span class="diff-before">${fmtVal(c.before)}</span>
          <span class="diff-after">${fmtVal(c.after)} ${deltaHtml}</span>
        </div>`;
      }).join('');

  let stateInfo;
  if(changes.length > 0) {
    stateInfo = `        
        <div class="data-section-title">State Changes</div>
        <div class="data-grid-center data-grid-3">
          <div class="data-row">
            <span>Field</span>
            <span>Before</span>
            <span>After</span>
          </div>
          ${diffRows}
        </div>
    `;
  }else {
    stateInfo = `
      <div class="data-section-title">State (No Change)</div>
      <pre class="modal-code">${JSON.stringify(entry.prevState,null, 2)}</pre>
      `;
  }

  const result = `
    <div class="data-section-title">Action</div>
    <div class="data-list-wrap data-grid data-grid-2">
      <div class="data-row">
        <label>Type</label>
        <span>${entry.action.type}</span>
      </div>
      <div class="data-row">
        <label>Date</label>
        <span>${app._formatDate(entry.date)}</span>
      </div>
      <div class="data-row">
        <label>Source event</label>
        <span>${entry.eventType}</span>
      </div>
      <div class="data-row">
        <label>Reducer</label>
        <span>${entry.reducer}</span>
      </div>
      <div class="data-row">
        <label>Emitted</label>
        <span>${emitted}</span>
      </div>
      <div class="data-row">
        <label>Action Payload</label>
        <span>${actionPayload}</span>
      </div>
    </div>  
    ${stateInfo} 
 `;
  const nodeDetail = $('nodeDetail');
  nodeDetail.innerHTML = result;
  nodeDetail.style.display = 'block';
}



// ── Event list UI ─────────────────────────────────────────────────────────────
function renderEventList() {
  const list = $('eventList');
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
  const type   = $('newEventType').value;
  const date   = $('newEventDate').value;
  const amount = $('newEventAmount').value;
  if (!date) { alert('Please pick a date.'); return; }
  customEvents.push({ type, date: new Date(date + 'T00:00:00'), amount: amount ? +amount : null });
  $('newEventDate').value   = '';
  $('newEventAmount').value = '';
  $('addEventForm').classList.add('hidden');
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

  $('handlerFunction').value = `return [{ type: 'CUSTOM_EVENT', data}];`;
  $('reducerFunction').value = `return { state: { ...state, customItem: 'customReducerFired'}};`;

  app.initView();
  $('addEventBtn').addEventListener('click',    () => $('addEventForm').classList.toggle('hidden'));
  $('submitEventBtn').addEventListener('click', submitAddEvent);
  $('cancelEventBtn').addEventListener('click', () => $('addEventForm').classList.add('hidden'));

  //TODO Add to Base APP
  $('tzSelect').addEventListener('change', () => {
    app.setFormatDate($('tzSelect').value === 'utc' ? fmtUTC : fmtLocal);
    renderEventList();
  });

  //TODO Add to Base app
  $('displayCurrency').addEventListener('change', () => {
    displayCurrency = $('displayCurrency').value;
    app.buildScenario();
  });

  $('testHandlerLogic').addEventListener('click', () => {
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

  $('testReducerLogic').addEventListener('click', () => {
    const errEl = $('reducerFunctionError');
    const outEl = $('reducerLogicTestOut');
    const logic = $('reducerFunction').value;
    const fn     = new Function('state,action,date', logic);
    const state = { ...initialState };
    const action = {type: 'CUSTOM_EVENT', state};
    const date = new Date();
    const testIn = { state, action, date};
    try {
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
