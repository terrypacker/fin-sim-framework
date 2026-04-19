/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { $, fmt } from '../visualization/ui-utils.js'
import { RetirementDrawdownScenario, DEFAULT_EVENT_SERIES } from '../scenarios/retirement-drawdown-scenario.js';
import { BaseApp } from './base-app.js';

// ── Chart series: three account lines ────────────────────────────────────────
const CHART_SERIES = [
  { key: 'checking',   color: '#60a5fa', label: 'Checking'   },
  { key: 'brokerage',  color: '#34d399', label: 'Brokerage'  },
  { key: 'retirement', color: '#f59e0b', label: 'Retirement' },
];

// Snapshot builder — sums brokerage stocks + bonds into one figure
function chartSnapshot(chartView, date, state) {
  const brokerageTotal =
      state.brokerageAccount.stocks.reduce((s, x) => s + x.value, 0) +
      state.brokerageAccount.bonds.reduce((s, x)  => s + x.value, 0);
  chartView.addSnapshot(date, {
    checking:   state.checkingAccount.balance,
    brokerage:  brokerageTotal,
    retirement: state.retirementAccount.balance
  });
}

// Editable event series list (copy of defaults so user can toggle)
let eventSeries  = DEFAULT_EVENT_SERIES.map(s => ({ ...s }));
let customEvents = [];

const app = new BaseApp({
  newScenario:     (params) => new RetirementDrawdownScenario({ params, eventSeries, customEvents }),
  readParams:      () => readParams(),
  onChartSnapshot: chartSnapshot,
  chartSeries:     CHART_SERIES,
});

// ── Params form ───────────────────────────────────────────────────────────────
function readParams() {
  return {
    monthlyExpenses:        +$('monthlyExpenses').value,
    checkingMinBalance:     +$('checkingMinBalance').value,
    checkingInterestRate:   +$('checkingInterestRate').value / 100,
    incomeTaxRate:          +$('incomeTaxRate').value / 100,
    capitalGainsTaxRate:    +$('capitalGainsTaxRate').value / 100,
    initialChecking:        +$('initialChecking').value,
    initialStocksValue:     +$('initialStocksValue').value,
    initialStocksCostBasis: +$('initialStocksCostBasis').value,
    stockDividendRate:      +$('stockDividendRate').value / 100,
    initialBondsValue:      +$('initialBondsValue').value,
    bondInterestRate:       +$('bondInterestRate').value / 100,
    initialRetirement:      +$('initialRetirement').value,
    retirementAccessYear:   +$('retirementAccessYear').value,
  };
}

// ── Events list UI ────────────────────────────────────────────────────────────
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
      <button class="remove-event" data-idx="${i}" title="Remove">✕</button>
    `;
    list.appendChild(row);
  });

  customEvents.forEach((ev, i) => {
    const row = document.createElement('div');
    row.className = 'event-row custom-event';
    row.innerHTML = `
      <span>${ev.type} on ${new Date(ev.date).toLocaleDateString()}${ev.amount != null ? ' ($' + ev.amount.toLocaleString() + ')' : ''}</span>
      <button class="remove-custom" data-idx="${i}" title="Remove">✕</button>
    `;
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
  if (!date) { alert('Please pick a date for the event.'); return; }
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
  renderEventList();
  app.buildScenario();
});
