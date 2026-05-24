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

// ── Date formatters ───────────────────────────────────────────────────────────
const fmtUTC   = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
const fmtLocal = d => d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });

// ── Chart series ──────────────────────────────────────────────────────────────
const CHART_SERIES = [
  { key: 'usSavings',    color: '#60a5fa', label: 'US Savings (USD)'   },
  { key: 'usAccounts',   color: '#34d399', label: 'US Accounts (USD)'  },
  { key: 'auSavings',    color: '#f59e0b', label: 'AU Savings (AUD)'   },
  { key: 'auAccounts',   color: '#fbbf24', label: 'AU Accounts (AUD)'  },
  { key: 'superAccount', color: '#fb923c', label: 'Superannuation (AUD)' },
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
  const rate = state.exchangeRateUsdToAud ?? 1;

  const usAccounts =
    (state.rothAccount?.balance        ?? 0) +
    (state.iraAccount?.balance         ?? 0) +
    (state.k401Account?.balance        ?? 0) +
    (state.stockAccount?.balance       ?? 0) +
    (state.fixedIncomeAccount?.balance ?? 0);

  const auAccounts =
    (state.auStockAccount?.balance ?? 0);

  chartView.addSnapshot(date, {
    usSavings:    toDisplay(state.usSavingsAccount?.balance  ?? 0, 'USD', rate),
    usAccounts:   toDisplay(usAccounts,                            'USD', rate),
    auSavings:    toDisplay(state.auSavingsAccount?.balance  ?? 0, 'AUD', rate),
    auAccounts:   toDisplay(auAccounts,                            'AUD', rate),
    superAccount: toDisplay(state.superAccount?.balance      ?? 0, 'AUD', rate),
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
  formatDate:      fmtUTC,
});

// ── Params form ───────────────────────────────────────────────────────────────
function readParams() {
  return {
    // People
    primaryBirthDate: new Date(+$('primaryBirthYear').value, 3, 15),
    spouseBirthDate:  new Date(+$('spouseBirthYear').value,  8, 22),
    moveYear:         +$('moveYear').value,

    // US Savings
    initialUsSavings:      +$('initialUsSavings').value,
    usSavingsMinBalance:   +$('usSavingsMinBalance').value,
    usSavingsInterestRate: +$('usSavingsInterestRate').value / 100,

    // US investment accounts
    rothBalance:   +$('rothBalance').value,   rothBasis:   +$('rothBasis').value,
    iraBalance:    +$('iraBalance').value,     iraBasis:    +$('iraBasis').value,
    k401Balance:   +$('k401Balance').value,    k401Basis:   +$('k401Basis').value,
    stockBalance:  +$('stockBalance').value,   stockBasis:  +$('stockBasis').value,
    stockDividendRate:    +$('stockDividendRate').value / 100,
    stockDividendReinvest: $('stockDividendReinvest').checked,
    fixedIncomeBalance:      +$('fixedIncomeBalance').value,
    fixedIncomeInterestRate: +$('fixedIncomeInterestRate').value / 100,

    // AU accounts
    auSavingsBalance:     +$('auSavingsBalance').value,
    auSavingsInterestRate: +$('auSavingsInterestRate').value / 100,
    superBalance:  +$('superBalance').value,   superBasis:  +$('superBasis').value,
    auStockBalance: +$('auStockBalance').value, auStockBasis: +$('auStockBasis').value,

    // International transfer
    exchangeRateUsdToAud: +$('exchangeRateUsdToAud').value,
    intlTransferFeeUsd:   +$('intlTransferFeeUsd').value,

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
});
