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

// ── Date formatters ───────────────────────────────────────────────────────────
const fmtUTC   = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
const fmtLocal = d => d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });

// ── Chart series ──────────────────────────────────────────────────────────────
const CHART_SERIES = [
  { key: 'monthCounter',  color: '#60a5fa', label: 'Month Count'   },
  { key: 'yearCounter',   color: '#34d399', label: 'Year Count'  },
];

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
  chartSeries:     CHART_SERIES,
  formatDate:      fmtUTC
});

// ── Params form ───────────────────────────────────────────────────────────────
function readParams() {
  return {

  };
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

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  app.initView();
  $('addEventBtn').addEventListener('click',    () => $('addEventForm').classList.toggle('hidden'));
  $('submitEventBtn').addEventListener('click', submitAddEvent);
  $('cancelEventBtn').addEventListener('click', () => $('addEventForm').classList.add('hidden'));

  $('tzSelect').addEventListener('change', () => {
    app.setFormatDate($('tzSelect').value === 'utc' ? fmtUTC : fmtLocal);
    renderEventList();
  });

  $('displayCurrency').addEventListener('change', () => {
    displayCurrency = $('displayCurrency').value;
    app.buildScenario();
  });

  renderEventList();
  app.buildScenario();
  //TODO This only happens on RECORD_BALANCE in the base-app, need to fix
  app.scenario.sim.bus.subscribe('DEBUG_ACTION', ({ payload }) => {
    chartSnapshot(app.chartView, payload.date, payload.stateAfter);
  });
});
