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
function showNodeDetail(entry) {
  const actionDetail = app.buildActionDetail(entry);
  const changes = actionDetail.changes;
  const emitted= actionDetail.emitted;
  const actionPayload = actionDetail.actionPayload;

  const diffRows = changes.length === 0
      ? '<tr><td colspan="3" style="text-align:center;color:#64748b;padding:8px">No scalar state changes</td></tr>'
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
        return `<tr>
          <td class="diff-field">${c.field}</td>
          <td class="diff-before">${fmtVal(c.before)}</td>
          <td class="diff-after">${fmtVal(c.after)} ${deltaHtml}</td>
        </tr>`;
      }).join('');

  let stateInfo;
  if(changes.length > 0) {
    stateInfo = `        
        <div class="modal-section-title">State Changes</div>
        <table class="diff-table">
          <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
          <tbody>${diffRows}</tbody>
        </table>
    `;
  }else {
    stateInfo = `
      <div class="modal-section-title">State (No Change)</div>
      <pre class="modal-code">${JSON.stringify(entry.prevState,null, 2)}</pre>
      `;
  }

  const result = `
    <div class="modal-hdr">
      <span>${entry.action.type}</span>
      <button class="modal-close" title="Close">✕</button>
    </div>
    <div class="field-row">
      <div class="field-group">
        <label>Date</label>
        <span>${app._formatDate(entry.date)}</span>
      </div>
    </div>
    <div class="field-row">
      <div class="field-group">
        <label>Source event</label>
        <span>${entry.eventType}</span>
      </div>
    </div>
    <div class="field-row">
      <div class="field-group">
        <label>Reducer</label>
        <span>${entry.reducer}</span>
      </div>
    </div>
    <div class="field-row">
      <div class="field-group">
        <label>Emitted</label>
        <span>${emitted}</span>
      </div>
    </div>
    <div class="field-row">
      <div class="field-group">
        <label>Action Payload</label>
        <span>${actionPayload}</span>
      </div>
    </div>
    <div class="field-row">
      ${stateInfo}
    </div>`;
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
