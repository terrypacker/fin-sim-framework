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
import { FinancialScenario, DEFAULT_EVENT_SERIES } from '../scenarios/financial-scenario.js';
import { BaseApp } from "./base-app.js";

// ─── Action Detail Modal ──────────────────────────────────────────────────────
function diffStates(prev, next) {
  const changes = [];

  // Top-level numeric fields
  for (const key of ['incomeYTD', 'interestYTD']) {
    const b = prev[key] ?? 0, a = next[key] ?? 0;
    if (b !== a) changes.push({ field: key, before: b, after: a, delta: a - b });
  }

  // Account balances
  for (const acc of ['checkingAccount', 'savingsAccount']) {
    const b = prev[acc]?.balance ?? 0;
    const a = next[acc]?.balance ?? 0;
    if (b !== a) changes.push({ field: acc + '.balance', before: b, after: a, delta: a - b });
  }

  // Asset count
  const pa = prev.assets?.length ?? 0, na = next.assets?.length ?? 0;
  if (pa !== na) changes.push({ field: 'assets.length', before: pa, after: na, delta: na - pa });

  // Metric additions
  for (const key of Object.keys(next.metrics || {})) {
    const pb = (prev.metrics || {})[key] || [];
    const nb = next.metrics[key]         || [];
    if (nb.length > pb.length) {
      nb.slice(pb.length).forEach(v => {
        changes.push({
          field: 'metrics.' + key,
          before: '—',
          after: typeof v === 'number' ? v : JSON.stringify(v),
          delta: null
        });
      });
    }
  }

  return changes;
}

// Editable event series list (copy of defaults so user can toggle)
let eventSeries  = DEFAULT_EVENT_SERIES.map(s => ({ ...s }));
// One-off custom events added via form
let customEvents = [];

const app = new BaseApp({
    newScenario: (params) =>  new FinancialScenario({ params, eventSeries, customEvents }),
    readParams: () => readParams(),
    diffStates: (prev, next) => diffStates(prev, next)
});

// ─── Build / Rebuild Simulation ───────────────────────────────────────────────
function readParams() {
  return {
    salaryMonthly:       +$('salaryMonthly').value,
    savingsInterestRate: +$('savingsInterestRate').value / 100,
    incomeTaxRate:       +$('incomeTaxRate').value       / 100,
    shortTermCgtRate:    +$('shortTermCgtRate').value    / 100,
    longTermCgtRate:     +$('longTermCgtRate').value     / 100,
    initialChecking:     +$('initialChecking').value,
    initialSavings:      +$('initialSavings').value
  };
}


// ─── Events list UI ──────────────────────────────────────────────────────────

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

  // Attach listeners
  list.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      eventSeries[+cb.dataset.idx].enabled = cb.checked;
    });
  });
  list.querySelectorAll('.remove-event').forEach(btn => {
    btn.addEventListener('click', () => {
      eventSeries.splice(+btn.dataset.idx, 1);
      renderEventList();
    });
  });
  list.querySelectorAll('.remove-custom').forEach(btn => {
    btn.addEventListener('click', () => {
      customEvents.splice(+btn.dataset.idx, 1);
      renderEventList();
    });
  });
}

function showAddEventForm() {
  $('addEventForm').classList.toggle('hidden');
}

function submitAddEvent() {
  const type   = $('newEventType').value;  // already a valid type from the <select>
  const date   = $('newEventDate').value;
  const amount = $('newEventAmount').value;

  if (!date) {
    alert('Please pick a date for the event.');
    return;
  }

  customEvents.push({
    type,
    date: new Date(date + 'T00:00:00'),  // avoid timezone shift from bare date string
    amount: amount ? +amount : null
  });

  $('newEventDate').value   = '';
  $('newEventAmount').value = '';
  $('addEventForm').classList.add('hidden');

  renderEventList();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {

  app.initView();
  // Events list
  $('addEventBtn').addEventListener('click', showAddEventForm);
  $('submitEventBtn').addEventListener('click', submitAddEvent);
  $('cancelEventBtn').addEventListener('click', () => $('addEventForm').classList.add('hidden'));

  renderEventList();
  app.buildScenario();
});
