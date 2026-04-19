/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { IntlRetirementScenario, DEFAULT_EVENT_SERIES } from './scenarios/intl-retirement-scenario.js';
const $ = FinSimLib.Visualization.$;

// ── Chart series ──────────────────────────────────────────────────────────────
const CHART_SERIES = [
  { key: 'checking',     color: '#60a5fa', label: 'Checking'       },
  { key: 'usAccounts',   color: '#34d399', label: 'US Accounts'    },
  { key: 'auAccounts',   color: '#f59e0b', label: 'AU Accounts'    },
  { key: 'superAccount', color: '#fb923c', label: 'Superannuation' },
];

function chartSnapshot(chartView, date, state) {
  const usAccounts =
    (state.rothAccount?.balance        ?? 0) +
    (state.iraAccount?.balance         ?? 0) +
    (state.k401Account?.balance        ?? 0) +
    (state.stockAccount?.balance       ?? 0) +
    (state.fixedIncomeAccount?.balance ?? 0);

  const auAccounts =
    (state.auSavingsAccount?.balance ?? 0) +
    (state.auStockAccount?.balance   ?? 0);

  chartView.addSnapshot(date, {
    checking:     state.checkingAccount?.balance ?? 0,
    usAccounts,
    auAccounts,
    superAccount: state.superAccount?.balance ?? 0,
  });
}

// Editable event series list (copy so user toggles don't mutate the default)
let eventSeries  = DEFAULT_EVENT_SERIES.map(s => ({ ...s }));
let customEvents = [];

const app = new FinSimLib.Misc.BaseApp({
  newScenario:     (params) => new IntlRetirementScenario({ params, eventSeries, customEvents }),
  readParams,
  onChartSnapshot: chartSnapshot,
  chartSeries:     CHART_SERIES,
});

// ── Params form ───────────────────────────────────────────────────────────────
function readParams() {
  return {
    // People
    primaryBirthDate: new Date(+$('primaryBirthYear').value, 3, 15),
    spouseBirthDate:  new Date(+$('spouseBirthYear').value,  8, 22),
    moveYear:         +$('moveYear').value,

    // Checking
    initialChecking:      +$('initialChecking').value,
    checkingMinBalance:   +$('checkingMinBalance').value,
    checkingInterestRate: +$('checkingInterestRate').value / 100,

    // US accounts
    rothBalance:   +$('rothBalance').value,   rothBasis:   +$('rothBasis').value,
    iraBalance:    +$('iraBalance').value,    iraBasis:    +$('iraBasis').value,
    k401Balance:   +$('k401Balance').value,   k401Basis:   +$('k401Basis').value,
    stockBalance:  +$('stockBalance').value,  stockBasis:  +$('stockBasis').value,
    stockDividendRate:    +$('stockDividendRate').value / 100,
    stockDividendReinvest: $('stockDividendReinvest').checked,
    fixedIncomeBalance:      +$('fixedIncomeBalance').value,
    fixedIncomeInterestRate: +$('fixedIncomeInterestRate').value / 100,

    // AU accounts
    auSavingsBalance:     +$('auSavingsBalance').value,
    auSavingsInterestRate: +$('auSavingsInterestRate').value / 100,
    superBalance:  +$('superBalance').value,  superBasis:  +$('superBasis').value,
    auStockBalance: +$('auStockBalance').value, auStockBasis: +$('auStockBasis').value,

    // Expenses
    monthlyExpenses: +$('monthlyExpenses').value,
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
      <span>${ev.type} on ${new Date(ev.date).toLocaleDateString()}${ev.amount != null ? ' ($' + ev.amount.toLocaleString() + ')' : ''}</span>
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
  renderEventList();
  app.buildScenario();
});
