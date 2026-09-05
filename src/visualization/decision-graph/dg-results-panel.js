/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent }          from '../components/base-component.js';
import { DecisionGraphRunner }    from '../../finance/decision-graph/decision-graph-runner.js';
import { buildDecisionGraphCsv }  from '../../finance/decision-graph/decision-graph-csv.js';
import { resolveLeafEntry }       from '../../finance/decision-graph/leaf-entry.js';
import { ServiceRegistry }        from '../../services/service-registry.js';
import { withBom }               from '../../utils/csv.js';

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const PCT = v => v == null ? '—' : (v * 100).toFixed(1) + '%';
// Decision-graph objectives (final net worth, deficits) are USD-base aggregates;
// convert to the active display currency (design 10 §Phase 4), whole dollars.
const FMT = v => {
  if (v == null) return '—';
  const reg = ServiceRegistry.getInstance?.()?.schemaRegistry;
  return reg?.formatAmount?.(v, 'USD', { maximumFractionDigits: 0 }) ?? USD.format(v);
};

/**
 * DgResultsPanel — center pane of the Decision Graph tab.
 *
 * Displays a ranked table of leaves after an analysis run.
 * Supports Ranked and Weighted-expectation display modes, and CSV export.
 *
 * Callbacks:
 *   onCompareLeaf(leafEntry, baseEntry) — fired when Compare is clicked.
 */
export class DgResultsPanel extends BaseComponent {
  constructor(containerEl) {
    super();
    this._container   = containerEl;
    this._baseEntry   = null;
    this._result      = null;
    this._mode        = 'ranked'; // 'ranked' | 'weighted'

    /** @type {Function|null} */
    this.onCompareLeaf = null;

    this._renderIdle();
  }

  showRunning() {
    if (!this._container) return;
    this._container.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'dg-idle-msg';
    msg.textContent = 'Running…';
    this._container.appendChild(msg);
  }

  showResults(result, baseEntry) {
    if (!this._container) return;
    this._baseEntry = baseEntry;
    this._result    = result;
    this._rebuild();
  }

  destroy() {
    super.destroy();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _rebuild() {
    if (!this._container || !this._result) return;
    const result = this._result;

    const runner  = new DecisionGraphRunner({});
    const ranked  = runner.summarize(result, 'ranked');
    const we      = runner.summarize(result, 'weightedExpectation');

    this._container.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'dg-results-root';

    // ── Header bar ────────────────────────────────────────────────────────────
    const hdr = document.createElement('div');
    hdr.className = 'dg-results-hdr-bar';

    const title = document.createElement('span');
    title.className = 'dg-results-title';
    title.textContent = `${ranked.length} leaves  (${result.objective ?? 'finalBalance'})`;
    hdr.appendChild(title);

    // Mode toggle
    const modeGroup = document.createElement('div');
    modeGroup.className = 'dg-mode-group';

    const rankedBtn   = this._modeBtn('Ranked',   'ranked');
    const weightedBtn = this._modeBtn('Weighted', 'weighted');
    const hasWeights  = (result.decisionPoints ?? []).some(dp => dp.weights !== null);
    if (!hasWeights) {
      weightedBtn.disabled = true;
      weightedBtn.title = 'Enable probability weights on at least one decision point to use this mode';
    }

    const syncButtons = () => {
      rankedBtn.classList.toggle('dg-mode-active',   this._mode === 'ranked');
      weightedBtn.classList.toggle('dg-mode-active', this._mode === 'weighted');
    };
    syncButtons();

    this.listen(rankedBtn, 'click', () => {
      this._mode = 'ranked';
      syncButtons();
      this._rebuildTable(tableArea, result, ranked, we);
    });
    this.listen(weightedBtn, 'click', () => {
      if (weightedBtn.disabled) return;
      this._mode = 'weighted';
      syncButtons();
      this._rebuildTable(tableArea, result, ranked, we);
    });

    modeGroup.append(rankedBtn, weightedBtn);
    hdr.appendChild(modeGroup);

    // Export CSV
    const csvBtn = document.createElement('button');
    csvBtn.className = 'btn dg-csv-btn';
    csvBtn.textContent = '↓ CSV';
    csvBtn.title = 'Export ranked results to CSV';
    this.listen(csvBtn, 'click', () => this._exportCsv(result, ranked));
    hdr.appendChild(csvBtn);

    root.appendChild(hdr);

    // ── Table area ────────────────────────────────────────────────────────────
    const tableArea = document.createElement('div');
    tableArea.className = 'dg-table-area';
    this._rebuildTable(tableArea, result, ranked, we);
    root.appendChild(tableArea);

    this._container.appendChild(root);
  }

  _rebuildTable(container, result, ranked, we) {
    container.innerHTML = '';

    if (this._mode === 'weighted') {
      this._buildWeightedView(container, result, we);
    } else {
      this._buildRankedTable(container, result, ranked);
    }
  }

  _buildRankedTable(container, result, ranked) {
    const table = document.createElement('table');
    table.className = 'dg-ranked-table';

    const dps = result.decisionPoints ?? [];
    const thead = document.createElement('thead');
    const hrow  = document.createElement('tr');
    const cols  = ['#', ...dps.map(dp => dp.label ?? dp.id ?? ''), 'P50', 'P10', 'P90', 'Success', ''];
    for (const h of cols) {
      const th = document.createElement('th');
      th.textContent = h;
      hrow.appendChild(th);
    }
    thead.appendChild(hrow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    ranked.forEach((leaf, rank) => {
      const row = document.createElement('tr');

      const rankCell = document.createElement('td');
      if (rank === 0) rankCell.className = 'dg-best-badge';
      rankCell.textContent = String(rank + 1);
      row.appendChild(rankCell);

      // One cell per decision point option value
      for (const dp of dps) {
        const td = document.createElement('td');
        td.className = 'dg-leaf-label';
        const val = leaf.optionVector?.[dp.id];
        const opt = dp.options?.find(o => o.value === val);
        td.textContent = opt?.label ?? (val != null ? String(val) : '—');
        row.appendChild(td);
      }

      const p50Cell = document.createElement('td');
      p50Cell.textContent = FMT(leaf.mcSummary?.p50);

      const p10Cell = document.createElement('td');
      p10Cell.className = 'dg-muted';
      p10Cell.textContent = FMT(leaf.mcSummary?.p10);

      const p90Cell = document.createElement('td');
      p90Cell.className = 'dg-muted';
      p90Cell.textContent = FMT(leaf.mcSummary?.p90);

      const srCell = document.createElement('td');
      srCell.textContent = PCT(leaf.mcSummary?.successRate);

      const actionCell = document.createElement('td');
      const cmpBtn = document.createElement('button');
      cmpBtn.className = 'dg-compare-btn';
      cmpBtn.textContent = 'Compare';
      cmpBtn.title = 'Compare this leaf vs base scenario';
      this.listen(cmpBtn, 'click', () => {
        // Reloaded results have no inline leaf.entry — rebuild it from the base
        // scenario on click, so persisted and fresh results behave identically.
        const leafEntry = resolveLeafEntry(leaf, this._baseEntry);
        if (this.onCompareLeaf && leafEntry && this._baseEntry) {
          this.onCompareLeaf(leafEntry, this._baseEntry);
        }
      });
      actionCell.appendChild(cmpBtn);

      row.append(p50Cell, p10Cell, p90Cell, srCell, actionCell);
      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    container.appendChild(table);
  }

  _buildWeightedView(container, result, we) {
    const evBanner = document.createElement('div');
    evBanner.className = 'dg-we-banner';
    evBanner.textContent = `Expected value (${result.objective ?? 'finalBalance'}): ${FMT(we.expectedValue)}`;
    container.appendChild(evBanner);

    const table = document.createElement('table');
    table.className = 'dg-ranked-table';

    const dps = result.decisionPoints ?? [];
    const thead = document.createElement('thead');
    const hrow  = document.createElement('tr');
    for (const h of ['Weight', ...dps.map(dp => dp.label ?? dp.id ?? ''), 'P50', 'Success', '']) {
      const th = document.createElement('th');
      th.textContent = h;
      hrow.appendChild(th);
    }
    thead.appendChild(hrow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const sorted = [...we.leaves].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

    sorted.forEach(leaf => {
      const row = document.createElement('tr');

      const wCell = document.createElement('td');
      wCell.className = 'dg-muted';
      wCell.textContent = leaf.weight != null ? (leaf.weight * 100).toFixed(1) + '%' : '—';
      row.appendChild(wCell);

      for (const dp of dps) {
        const td = document.createElement('td');
        td.className = 'dg-leaf-label';
        const val = leaf.optionVector?.[dp.id];
        const opt = dp.options?.find(o => o.value === val);
        td.textContent = opt?.label ?? (val != null ? String(val) : '—');
        row.appendChild(td);
      }

      const p50Cell = document.createElement('td');
      p50Cell.textContent = FMT(leaf.mcSummary?.p50);

      const srCell = document.createElement('td');
      srCell.textContent = PCT(leaf.mcSummary?.successRate);

      const actionCell = document.createElement('td');
      const cmpBtn = document.createElement('button');
      cmpBtn.className = 'dg-compare-btn';
      cmpBtn.textContent = 'Compare';
      this.listen(cmpBtn, 'click', () => {
        // Reloaded results have no inline leaf.entry — rebuild it from the base
        // scenario on click, so persisted and fresh results behave identically.
        const leafEntry = resolveLeafEntry(leaf, this._baseEntry);
        if (this.onCompareLeaf && leafEntry && this._baseEntry) {
          this.onCompareLeaf(leafEntry, this._baseEntry);
        }
      });
      actionCell.appendChild(cmpBtn);

      row.append(p50Cell, srCell, actionCell);
      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    container.appendChild(table);
  }

  _exportCsv(result, ranked) {
    const csv = buildDecisionGraphCsv(result, ranked);
    if (!csv) return;
    const blob = new Blob([withBom(csv)], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `decision-graph-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  _modeBtn(label, mode) {
    const btn = document.createElement('button');
    btn.className = 'btn dg-mode-btn';
    btn.textContent = label;
    btn.dataset.mode = mode;
    return btn;
  }

  _renderIdle() {
    if (!this._container) return;
    this._container.innerHTML =
      '<div class="dg-idle-msg"><span>Configure and run a Decision Graph analysis to see results.</span></div>';
  }
}
