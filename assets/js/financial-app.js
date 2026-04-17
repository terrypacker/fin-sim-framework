/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { GraphView }                               from './visualization/graph-view.js';
import { BalanceChartView }                        from './visualization/balance-chart-view.js';
import { TimelineView }                            from './visualization/timeline-view.js';
import { FinancialScenario, DEFAULT_EVENT_SERIES } from './simulations/financial-scenario.js';

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

function showDetailModal(entry) {
  const existing = document.getElementById('detailModal');
  if (existing) existing.remove();

  const changes  = diffStates(entry.prevState, entry.nextState);
  const emitted  = entry.emittedActions?.length
    ? entry.emittedActions.map(a => a.type).join(', ')
    : '(none)';

  const actionPayload = JSON.stringify(
    Object.fromEntries(Object.entries(entry.action).filter(([k]) => !k.startsWith('_'))),
    null, 2
  );

  const diffRows = changes.length === 0
    ? '<tr><td colspan="3" style="text-align:center;color:#64748b;padding:8px">No scalar state changes</td></tr>'
    : changes.map(c => {
        const fmtVal = v => typeof v === 'number' ? fmt(v) : String(v);
        const deltaHtml = c.delta != null
          ? `<span class="${c.delta >= 0 ? 'diff-pos' : 'diff-neg'}">${c.delta >= 0 ? '+' : ''}${fmt(c.delta)}</span>`
          : '';
        return `<tr>
          <td class="diff-field">${c.field}</td>
          <td class="diff-before">${fmtVal(c.before)}</td>
          <td class="diff-after">${fmtVal(c.after)} ${deltaHtml}</td>
        </tr>`;
      }).join('');

  const overlay = document.createElement('div');
  overlay.id    = 'detailModal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-hdr">
        <span>${entry.action.type}</span>
        <button class="modal-close" title="Close">✕</button>
      </div>
      <div class="modal-body">
        <table class="modal-meta">
          <tr><td>Date</td>         <td>${entry.date.toDateString()}</td></tr>
          <tr><td>Source event</td> <td>${entry.eventType}</td></tr>
          <tr><td>Reducer</td>      <td>${entry.reducer}</td></tr>
          <tr><td>Emitted</td>      <td>${emitted}</td></tr>
        </table>

        <div class="modal-section-title">Action Payload</div>
        <pre class="modal-code">${actionPayload}</pre>

        <div class="modal-section-title">State Changes</div>
        <table class="diff-table">
          <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
          <tbody>${diffRows}</tbody>
        </table>
      </div>
    </div>`;

  overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ─── App State ────────────────────────────────────────────────────────────────

let scenario;
let graphView;
let chartView;
let timelineView;
let playing         = false;
let activeTab       = 'graph';
let lastSliderValue = 0;  // tracks slider position for forward-vs-backward detection

// Editable event series list (copy of defaults so user can toggle)
let eventSeries  = DEFAULT_EVENT_SERIES.map(s => ({ ...s }));
// One-off custom events added via form
let customEvents = [];

// ─── DOM helpers ─────────────────────────────────────────────────────────────

const $  = id => document.getElementById(id);
const fmt = n  => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ─── Build / Rebuild Simulation ───────────────────────────────────────────────

function buildScenario() {
  const params = readParams();

  if (graphView)    graphView.stopViz();
  if (chartView)    chartView.stopViz();

  scenario = new FinancialScenario({ params, eventSeries, customEvents });

  // ── Graph view (Action Graph tab) ─────────────────────────────────────────
  const graphCanvas = $('graphCanvas');
  graphView = new GraphView({
    simulator:   scenario.sim,
    canvas:      graphCanvas,
    dateChanged: onDateChanged,
    nodeClicked: showNodeDetail,
    simStart:    scenario.simStart,
    simEnd:      scenario.simEnd
  });
  graphView.startViz();

  // ── Balance chart view ────────────────────────────────────────────────────
  const chartCanvas = $('chartCanvas');
  chartView = new BalanceChartView({
    canvas:   chartCanvas,
    simStart: scenario.simStart,
    simEnd:   scenario.simEnd
  });
  chartView.startViz();

  // Timeline view
  timelineView = new TimelineView({
    container: $('timelineContainer'),
    onDetail:  showDetailModal
  });
  timelineView.attach(scenario.sim.journal);

  // Subscribe to RECORD_BALANCE DEBUG_ACTION events to capture balance snapshots
  scenario.sim.bus.subscribe('DEBUG_ACTION', ({ payload }) => {
    if (payload.type === 'RECORD_BALANCE') {
      chartView.addSnapshot(
        payload.date,
        payload.stateAfter.checkingAccount.balance,
        payload.stateAfter.savingsAccount.balance
      );
    }
  });

  // Reset slider and direction tracker
  $('timeSlider').value = 0;
  lastSliderValue = 0;
  $('timeLabel').textContent = scenario.simStart.toDateString();

  updateStatePanel();
}

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

// ─── Tab switching ────────────────────────────────────────────────────────────

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== tab + 'Tab'));
}

// ─── Time controls ────────────────────────────────────────────────────────────

function stepTo(pct) {
  const targetTime = new Date(
    scenario.simStart.getTime() +
    pct * (scenario.simEnd.getTime() - scenario.simStart.getTime())
  );
  scenario.sim.stepTo(targetTime);
  timelineView.update();
  $('timeLabel').textContent = targetTime.toDateString();
  updateStatePanel();
  return targetTime;
}

function rewindTo(pct) {
  graphView.resetGraph();
  chartView.resetHistory();
  // Journal entries are not part of the snapshot; clear them so replay
  // doesn't accumulate duplicates on top of the original run.
  scenario.sim.journal.journal.length = 0;
  timelineView.reset();
  scenario.sim.rewindToStart();
  const t = stepTo(pct);  // stepTo calls timelineView.update()
  return t;
}

// Throttled: graphView fires this on every DEBUG_ACTION node; we only need the
// slider/label updated once per animation frame.
let _dateChangedRaf = null;
function onDateChanged(date) {
  if (_dateChangedRaf) return;
  _dateChangedRaf = requestAnimationFrame(() => {
    _dateChangedRaf = null;
    const pct = (date.getTime() - scenario.simStart.getTime()) /
                (scenario.simEnd.getTime() - scenario.simStart.getTime());
    $('timeSlider').value = Math.round(pct * 100);
    $('timeLabel').textContent = date.toDateString();
    updateStatePanel();
  });
}

function updateStatePanel() {
  if (!scenario) return;
  const s   = scenario.sim.state;
  const m   = s.metrics;
  const sum = arr => (arr || []).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);

  $('stateChecking').textContent = fmt(s.checkingAccount.balance);
  $('stateSavings').textContent  = fmt(s.savingsAccount.balance);
  $('stateTotal').textContent    = fmt(s.checkingAccount.balance + s.savingsAccount.balance);
  $('stateIncomeYTD').textContent  = fmt(s.incomeYTD);
  $('stateInterestYTD').textContent = fmt(s.interestYTD);
  $('stateAssets').textContent   = String(s.assets.length);

  $('metricSalary').textContent    = fmt(sum(m['salary']));
  $('metricInterest').textContent  = fmt(sum(m['interest_income']));
  $('metricLtCgt').textContent     = fmt(sum(m['lt_cgt_paid']));
  $('metricStCgt').textContent     = fmt(sum(m['st_cgt_paid']));
  $('metricIncomeTax').textContent = fmt(sum(m['income_tax_paid']));
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

// ─── Node detail panel ────────────────────────────────────────────────────────

function formatNodeDetailHtml(node) {
  const changes = diffStates(node.stateBefore, node.stateAfter);

  const fmtVal = v => typeof v === 'number' ? fmt(v) : String(v);

  const actionFields = Object.entries(node.action || {})
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => `<tr>
      <td style="color:#64748b;padding:2px 4px">${k}</td>
      <td style="color:#e5e7eb;padding:2px 4px">${typeof v === 'number' ? fmt(v) : JSON.stringify(v)}</td>
    </tr>`)
    .join('');

  const diffRows = changes.length === 0
    ? '<tr><td colspan="3" style="color:#64748b;padding:4px;text-align:center">No scalar state changes</td></tr>'
    : changes.map(c => {
        const deltaHtml = c.delta != null
          ? ` <span style="color:${c.delta >= 0 ? '#34d399' : '#f87171'}">${c.delta >= 0 ? '+' : ''}${fmt(c.delta)}</span>`
          : '';
        return `<tr>
          <td style="color:#94a3b8;padding:2px 4px;font-size:10px">${c.field}</td>
          <td style="color:#64748b;padding:2px 4px">${fmtVal(c.before)}</td>
          <td style="color:#e5e7eb;padding:2px 4px">${fmtVal(c.after)}${deltaHtml}</td>
        </tr>`;
      }).join('');

  return `
    <div style="font-size:11px;line-height:1.5">
      <div style="color:#a5b4fc;font-size:12px;font-weight:bold;margin-bottom:4px">${node.type}</div>
      <div style="color:#64748b;margin-bottom:8px;font-size:10px">
        Date: <span style="color:#e5e7eb">${new Date(node.date).toDateString()}</span><br>
        Reducer: <span style="color:#e5e7eb">${node.reducer || '—'}</span>
      </div>
      ${actionFields ? `
        <div style="font-size:10px;text-transform:uppercase;color:#64748b;border-bottom:1px solid #1e293b;padding-bottom:3px;margin-bottom:5px">Action Payload</div>
        <table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:8px"><tbody>${actionFields}</tbody></table>
      ` : ''}
      <div style="font-size:10px;text-transform:uppercase;color:#64748b;border-bottom:1px solid #1e293b;padding-bottom:3px;margin-bottom:5px">State Changes</div>
      <table style="width:100%;border-collapse:collapse;font-size:10px">
        <thead><tr>
          <th style="text-align:left;color:#64748b;padding:2px 4px;font-weight:normal">Field</th>
          <th style="text-align:left;color:#64748b;padding:2px 4px;font-weight:normal">Before</th>
          <th style="text-align:left;color:#64748b;padding:2px 4px;font-weight:normal">After</th>
        </tr></thead>
        <tbody>${diffRows}</tbody>
      </table>
    </div>`;
}

function showNodeDetail(node) {
  $('nodeDetailFormatted').innerHTML = formatNodeDetailHtml(node);
  $('nodeDetail').textContent = graphView.getNodeDetail(node);
}

// ─── Animate ──────────────────────────────────────────────────────────────────

function animate() {
  if (!playing) return;

  const slider = $('timeSlider');
  slider.value = Math.min(100, +slider.value + 1);

  stepTo(+slider.value / 100);

  if (+slider.value < 100) {
    requestAnimationFrame(animate);
  } else {
    stopPlaying();
  }
}

function startPlaying() {
  playing = true;
  $('playPause').textContent = '⏸';
  animate();
}

function stopPlaying() {
  playing = false;
  $('playPause').textContent = '▶';
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Main tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Node detail tabs
  document.querySelectorAll('[data-ndtab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.ndtab;
      document.querySelectorAll('[data-ndtab]').forEach(b => b.classList.toggle('active', b === btn));
      $('nodeDetailFormatted').classList.toggle('hidden', target !== 'nodeDetailFormatted');
      $('nodeDetailJson').classList.toggle('hidden', target !== 'nodeDetailJson');
    });
  });

  // Time controls
  $('playPause').addEventListener('click', () => playing ? stopPlaying() : startPlaying());

  $('stepForward').addEventListener('click', () => {
    const slider = $('timeSlider');
    if (+slider.value >= 100) return;
    slider.value = +slider.value + 1;
    stepTo(+slider.value / 100);
  });

  $('stepBackward').addEventListener('click', () => {
    const slider = $('timeSlider');
    if (+slider.value <= 0) return;
    slider.value = +slider.value - 1;
    rewindTo(+slider.value / 100);
  });

  // True reset: rebuild the scenario from scratch so the sim queue and state
  // are pristine (rewindToStart only restores to snapshot 0, not time 0).
  $('resetBtn').addEventListener('click', buildScenario);

  let sliderTimeout;
  $('timeSlider').addEventListener('input', () => {
    clearTimeout(sliderTimeout);
    sliderTimeout = setTimeout(() => {
      const val = +$('timeSlider').value;
      if (val >= lastSliderValue) {
        // Moving forward — step incrementally, no rewind needed
        stepTo(val / 100);
      } else {
        // Moving backward — must rewind and replay
        rewindTo(val / 100);
      }
      lastSliderValue = val;
    }, 60);
  });

  // Params form
  $('rebuildBtn').addEventListener('click', buildScenario);

  // Events list
  $('addEventBtn').addEventListener('click', showAddEventForm);
  $('submitEventBtn').addEventListener('click', submitAddEvent);
  $('cancelEventBtn').addEventListener('click', () => $('addEventForm').classList.add('hidden'));

  // Canvas sizing
  function resizeCanvases() {
    const contentEl = $('content');
    const w = contentEl.clientWidth;
    const h = contentEl.clientHeight;
    $('graphCanvas').width  = w;
    $('graphCanvas').height = h;
    $('chartCanvas').width  = w;
    $('chartCanvas').height = h;
  }

  window.addEventListener('resize', resizeCanvases);
  resizeCanvases();

  renderEventList();
  buildScenario();
});
