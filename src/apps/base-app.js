/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { $, fmt } from '../visualization/ui-utils.js'
import { GraphView } from '../visualization/graph-view.js';
import { BalanceChartView } from '../visualization/balance-chart-view.js';
import { TimelineView } from '../visualization/timeline-view.js';
import { TimeControls } from '../visualization/time-controls.js';

export class BaseApp {
  constructor({ newScenario, readParams, updateStatePanel, diffStates, showNodeDetail, onChartSnapshot, chartSeries, formatDate }) {

    this.newScenario = newScenario
    this.readParams = readParams;
    this.customUpdateStatePanel = updateStatePanel;
    this.customDiffStates = diffStates;
    this.customShowNodeDetail = showNodeDetail;
    this.onChartSnapshot = onChartSnapshot ?? null;
    this.chartSeries = chartSeries ?? null;
    this._formatDate = formatDate ?? (d => d.toDateString());

    this.scenario = null;
    this.graphView = null;
    this.chartView = null;
    this.timelineView = null;
    this.timeControls = null;
    this.playing = false;
    this.lastSliderValue = 0;
    this._currentDate = null;
    this.activeTab = 'timeline';
    this.activeSidebarTab = 'settings';
  }

  /**
   * Update the date formatter used by all views. Takes effect immediately
   * without requiring a simulation rebuild.
   * @param {function(Date): string} fn
   */
  setFormatDate(fn) {
    this._formatDate = fn;
    if (this.timeControls) this.timeControls.formatDate = fn;
    if (this.timelineView) {
      this.timelineView.formatDate = fn;
      // Rebuilt groups use new format — clear expand state so keys stay consistent
      this.timelineView.expanded.clear();
      this.timelineView._lastDate = null;
      this.timelineView._render();
    }
    if (this._currentDate) {
      $('timeLabel').textContent = fn(this._currentDate);
    }
  }

  buildScenario() {

    //Clear out state and metrics
    $('currentStateContent').innerHTML = '';
    $('cumulativeMetricsContent').innerHTML = '';

    //Setup the scenario
    const params = this.readParams();
    if (this.graphView)    this.graphView.stopViz();
    if (this.chartView)    this.chartView.stopViz();

    this.scenario = this.newScenario(params);

    const eventColors = new Map(
      (this.scenario.eventSeries ?? []).map(s => [s.type, s.color]).filter(([, c]) => c)
    );

    const graphCanvas = $('graphCanvas');
    if(graphCanvas) {
      this.graphView = new GraphView({
        simulator: this.scenario.sim,
        canvas: graphCanvas,
        getNodeDetail: (n) => this.getNodeDetail(n),
        formatNodeDetailHtml: (n) => this.formatNodeDetailHtml(n),
        simStart: this.scenario.simStart,
        simEnd: this.scenario.simEnd,
        eventColors
      });
      this.graphView.initView();
      this.graphView.startViz();
    }

    // ── Balance chart view ────────────────────────────────────────────────────
    const chartCanvas = $('chartCanvas');
    this.chartView = new BalanceChartView({
      canvas:   chartCanvas,
      simStart: this.scenario.simStart,
      simEnd:   this.scenario.simEnd,
      series:   this.chartSeries ?? undefined
    });
    this.chartView.startViz();

    // Timeline view
    this.timelineView = new TimelineView({
      container:   $('timelineContainer'),
      onDetail:    (node) => this.customShowNodeDetail ?  this.customShowNodeDetail(node) : this.showDetailModal(node),
      onRewind:    (date) => {
        const pct = (date.getTime() - this.scenario.simStart.getTime()) /
                    (this.scenario.simEnd.getTime() - this.scenario.simStart.getTime());
        const clamped = Math.max(0, Math.min(1, pct));
        this.timeControls.rewindTo(clamped);
        const sliderVal = Math.round(clamped * 100);
        $('timeSlider').value = sliderVal;
        this.lastSliderValue = sliderVal;
      },
      eventColors,
      formatDate:  this._formatDate,
    });
    this.timelineView.attach(this.scenario.sim.journal);

    // ─── Time controls ────────────────────────────────────────────────────────────
    this.timeControls = new TimeControls({
      scenario: this.scenario,
      timelineView: this.timelineView,
      graphView: this.graphView,
      chartView: this.chartView,
      timeLabel: $('timeLabel'),
      timeSlider: $('timeSlider'),
      formatDate: this._formatDate,
    });

    // Subscribe to RECORD_BALANCE DEBUG_ACTION events to capture balance snapshots
    this.scenario.sim.bus.subscribe('DEBUG_ACTION', ({ payload }) => {

      //Fire the date changed listeners
      const date = new Date(payload.date);
      this._currentDate = date;
      this.timeControls.onDateChanged(date);
      if(this.graphView) {
        this.graphView.updateView(payload);
      }
      this.customUpdateStatePanel ? this.customUpdateStatePanel(date, payload.stateAfter) : this.updateStatePanel(date, payload.stateAfter);
      if (payload.type === 'RECORD_BALANCE') {
        if (this.onChartSnapshot) {
          this.onChartSnapshot(this.chartView, payload.date, payload.stateAfter);
        } else {
          this.chartView.addSnapshot(
              payload.date,
              payload.stateAfter.checkingAccount.balance,
              payload.stateAfter.savingsAccount.balance
          );
        }
      }
    });

    // Reset slider and direction tracker
    $('timeSlider').value = 0;
    this.lastSliderValue = 0;
    this._currentDate = this.scenario.simStart;
    $('timeLabel').textContent = this._formatDate(this.scenario.simStart);

    this.updateStatePanel();
  }

  buildActionDetail(entry) {
    const changes  = this.customDiffStates ? this.customDiffStates(entry.prevState, entry.nextState) : this.diffStates(entry.prevState, entry.nextState);
    const emitted  = entry.emittedActions?.length
        ? entry.emittedActions.map(a => a.type).join(', ')
        : '(none)';

    const actionPayload = JSON.stringify(
        Object.fromEntries(Object.entries(entry.action).filter(([k]) => !k.startsWith('_'))),
        null, 2
    );

    return {
      changes: changes,
      emitted: emitted,
      actionPayload: actionPayload
    }
  }

  showDetailModal(entry) {
    const existing = document.getElementById('detailModal');
    if (existing) existing.remove();

    const actionDetail = this.buildActionDetail(entry);

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
          <tr><td>Date</td>         <td>${this._formatDate(entry.date)}</td></tr>
          <tr><td>Source event</td> <td>${entry.eventType}</td></tr>
          <tr><td>Reducer</td>      <td>${entry.reducer}</td></tr>
          <tr><td>Emitted</td>      <td>${emitted}</td></tr>
        </table>

        <div class="modal-section-title">Action Payload</div>
        <pre class="modal-code">${actionPayload}</pre>
        ${stateInfo}
      </div>
    </div>`;

    overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  // ─── Tab switching ────────────────────────────────────────────────────────────
  switchTab(tab, sidebar) {
    if(sidebar) {
      this.activeSidebarTab = tab;
      document.querySelectorAll('.sidebar-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      document.querySelectorAll('.sidebar-tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== tab + 'Tab'));
    }else {
      this.activeTab = tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== tab + 'Tab'));
    }
    this.resizeCanvases();
  }

  // Node Detail
  formatNodeDetailHtml(node) {
    const diff = this.customDiffStates ? this.customDiffStates(node.stateBefore, node.stateAfter) : this.diffStates(node.stateBefore, node.stateAfter);

    const fmtVal = v => {
      if (typeof v === 'number') return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return JSON.stringify(v);
    };

    const actionFields = Object.entries(node.action || {})
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => `<tr>
      <td style="color:#64748b;padding:2px 4px">${k}</td>
      <td style="color:#e5e7eb;padding:2px 4px">${typeof v === 'number' ? fmtVal(v) : JSON.stringify(v)}</td>
    </tr>`)
    .join('');

    const diffRows = diff.length === 0
        ? '<tr><td colspan="3" style="color:#64748b;padding:4px;text-align:center">No state changes</td></tr>'
        : diff.map(({ field, before, after, delta }) => {
          const deltaHtml = delta != null
              ? ` <span style="color:${delta >= 0 ? '#34d399' : '#f87171'}">${delta >= 0 ? '+' : ''}${fmtVal(delta)}</span>`
              : '';
          return `<tr>
          <td style="color:#94a3b8;padding:2px 4px">${field}</td>
          <td style="color:#64748b;padding:2px 4px">${fmtVal(before)}</td>
          <td style="color:#e5e7eb;padding:2px 4px">${fmtVal(after)}${deltaHtml}</td>
        </tr>`;
        }).join('');

    return `
    <div style="font-size:11px;line-height:1.5">
      <div style="color:#a5b4fc;font-size:13px;font-weight:bold;margin-bottom:4px">${node.type}</div>
      <div style="color:#64748b;margin-bottom:8px;font-size:10px">
        Date: <span style="color:#e5e7eb">${this._formatDate(new Date(node.date))}</span>
        &nbsp;|&nbsp; Reducer: <span style="color:#e5e7eb">${node.reducer || '—'}</span>
      </div>
      ${actionFields ? `
        <div style="font-size:10px;text-transform:uppercase;color:#64748b;border-bottom:1px solid #333;padding-bottom:3px;margin-bottom:5px">Action Payload</div>
        <table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:8px"><tbody>${actionFields}</tbody></table>
      ` : ''}
      <div style="font-size:10px;text-transform:uppercase;color:#64748b;border-bottom:1px solid #333;padding-bottom:3px;margin-bottom:5px">State Changes</div>
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

  /**
   * Get the details for a node
   * @param node
   * @returns {string}
   */
  getNodeDetail(node) {
    const diff = this.diffStates(node.stateBefore, node.stateAfter);

    return JSON.stringify({
      ...node,
      stateDiff: diff
    }, null, 2);
  }

  /**
   * Compute the difference in state between 2 state snapshots.
   * Recursively walks plain objects; treats arrays and scalars as leaves.
   * Returns an array of { field, before, after, delta } records, where
   * delta is the numeric difference (or null for non-numeric changes).
   * @param {object} prev
   * @param {object} next
   * @returns {{ field: string, before: *, after: *, delta: number|null }[]}
   */
  diffStates(prev, next) {
    const changes = [];
    if (!prev || !next) return changes;

    // Ledger arrays grow on every transaction — skip them to keep diffs readable.
    const SKIP_KEYS = new Set(['credits', 'debits']);

    const walk = (b, a, prefix) => {
      const leafKey = prefix.split('.').pop();
      if (SKIP_KEYS.has(leafKey)) return;
      const bIsObj = typeof b === 'object' && b !== null && !Array.isArray(b);
      const aIsObj = typeof a === 'object' && a !== null && !Array.isArray(a);
      if (bIsObj && aIsObj) {
        for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
          walk(b[key], a[key], prefix ? `${prefix}.${key}` : key);
        }
      } else if (JSON.stringify(b) !== JSON.stringify(a)) {
        const delta = typeof a === 'number' && typeof b === 'number' ? a - b : null;
        changes.push({ field: prefix, before: b ?? null, after: a ?? null, delta });
      }
    };

    for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      walk(prev[key], next[key], key);
    }

    return changes;
  }

  updateStatePanel(date, state) {
    if (!state) return;

    const currentEl  = $('currentStateContent');
    const metricsEl  = $('cumulativeMetricsContent');
    if (!currentEl || !metricsEl) return;

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
      `<div class="stat-row"${indent ? ' style="padding-left:12px"' : ''}>` +
      `<span class="stat-label">${toLabel(k)}</span>` +
      `<span class="stat-value">${typeof v === 'object' ? renderObj(v) : renderVal(v)}</span></div>`;

    const renderSection = obj => {
      let html = '';
      for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v) && v.length > 0 && v[0] !== null && typeof v[0] === 'object') {
          html += `<div class="stat-row"><span class="stat-label">${toLabel(k)}</span>` +
                  `<span class="stat-value">${v.length}</span></div>`;
          for (const item of v) {
            const name  = item.name ?? JSON.stringify(item);
            const value = item.value != null ? fmt(item.value) : '';
            html += `<div class="stat-row" style="padding-left:12px">` +
                    `<span class="stat-label">${name}</span>` +
                    `<span class="stat-value">${value}</span></div>`;
          }
        } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          html += `<div class="section-title" style="font-size:10px;margin-top:6px">${toLabel(k)}</div>`;
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
    currentEl.innerHTML = renderSection(rest);
    metricsEl.innerHTML = metrics ? renderSection(metrics) : '—';
  }
  // ─── Animate ──────────────────────────────────────────────────────────────────

  animate() {
    if (!this.playing) return;

    const slider = $('timeSlider');
    slider.value = Math.min(100, +slider.value + 1);

    this.timeControls.stepTo(+slider.value / 100);

    if (+slider.value < 100) {
      requestAnimationFrame(() => this.animate());
    } else {
      this.stopPlaying();
    }
  }

  startPlaying() {
    this.playing = true;
    $('playPause').textContent = '⏸';
    this.animate();
  }

  stopPlaying() {
    this.playing = false;
    $('playPause').textContent = '▶';
  }

  initView() {
    // Main tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    document.querySelectorAll('.sidebar-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab, true));
    });

    // Time controls
    $('playPause').addEventListener('click', () => this.playing ? this.stopPlaying() : this.startPlaying());

    $('stepForward').addEventListener('click', () => {
      this.timeControls.stepForward();
    });

    $('stepBackward').addEventListener('click', () => {
      const slider = $('timeSlider');
      if (+slider.value <= 0) return;
      slider.value = +slider.value - 1;
      this.timeControls.rewindTo(+slider.value / 100);
    });

    // True reset: rebuild the scenario from scratch so the sim queue and state
    // are pristine (rewindToStart only restores to snapshot 0, not time 0).
    $('resetBtn').addEventListener('click', () => this.buildScenario());

    let sliderTimeout;
    $('timeSlider').addEventListener('input', () => {
      clearTimeout(sliderTimeout);
      sliderTimeout = setTimeout(() => {
        const val = +$('timeSlider').value;
        if (val >= this.lastSliderValue) {
          // Moving forward — step incrementally, no rewind needed
          this.timeControls.stepTo(val / 100);
        } else {
          // Moving backward — must rewind and replay
          this.timeControls.rewindTo(val / 100);
        }
        this.lastSliderValue = val;
      }, 60);
    });

    // Params form
    $('rebuildBtn').addEventListener('click', () => this.buildScenario());

    window.addEventListener('resize', () => this.resizeCanvases());
    this.switchTab(this.activeTab);
    this.resizeCanvases();
  }

  resizeCanvases() {
    const contentEl = $('content');
    const w = contentEl.clientWidth;
    const h = contentEl.clientHeight;
    if(this.graphView) {
      this.graphView.resizeCanvas(h, w);
    }
    $('chartCanvas').width  = w;
    $('chartCanvas').height = h;
  }
}
