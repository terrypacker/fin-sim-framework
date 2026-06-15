/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent }           from '../components/base-component.js';
import { ScenarioCompareRunner }   from '../../finance/scenario-compare/scenario-compare-runner.js';
import { ServiceRegistry }         from '../../services/service-registry.js';
import {
  computeStateDiff,
  buildJournalOverlay,
  firstDivergenceDate,
  runningNetWorthSeries,
} from '../../finance/scenario-compare/scenario-compare-utils.js';

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const NUM = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

// Net worth / deficits are USD-base aggregates; convert to the active display
// currency (design 10 §Phase 4), whole dollars.
function fmtUsd(n) {
  if (n == null) return '—';
  const reg = ServiceRegistry.getInstance?.()?.schemaRegistry;
  return reg?.formatAmount?.(n, 'USD', { maximumFractionDigits: 0 }) ?? USD.format(n);
}
function fmtNum(n) { return (n == null || !Number.isFinite(n)) ? '—' : NUM.format(n); }
function fmtDate(d) {
  if (!d) return 'Never';
  if (typeof d === 'string') return d.slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d);
}

/**
 * ScenarioComparePresenter — owns the scenario-compare plugin's DOM.
 *
 * Given a containerEl (the #scenarioComparePane div) and a ScenarioRegistry,
 * renders a selector bar and (after Compare is clicked) a side-by-side KPI
 * strip, state diff table, and journal overlay.
 */
export class ScenarioComparePresenter extends BaseComponent {
  /**
   * @param {object} opts
   * @param {HTMLElement}      opts.containerEl      — root element to render into
   * @param {import('../../scenarios/scenario-registry.js').ScenarioRegistry} opts.scenarioRegistry
   */
  constructor({ containerEl, scenarioRegistry }) {
    super();
    this._container       = containerEl;
    this._scenarioRegistry = scenarioRegistry;
    this._running         = false;

    this._selA   = null;
    this._selB   = null;
    this._btn    = null;
    this._status = null;
    this._results = null;

    // Filter state — persisted across re-renders when filter changes
    this._filterMode  = 'all';    // 'all' | 'differs' | 'after-divergence' | 'field'
    this._filterField = '';
    // Last journal entry lists for filter re-renders
    this._lastEntriesA = null;
    this._lastEntriesB = null;
    this._journalEl    = null;

    this._render();
  }

  // ── Private rendering ────────────────────────────────────────────────────────

  _render() {
    if (!this._container) return;
    this._container.innerHTML = '';

    const root = document.createElement('div');
    root.className = 'sc-root';

    // ── Selector bar ──
    const bar = document.createElement('div');
    bar.className = 'sc-selector-bar';

    const lblA = document.createElement('span');
    lblA.className = 'sc-selector-label';
    lblA.textContent = 'A:';

    this._selA = document.createElement('select');
    this._selA.className = 'sc-selector-select';

    const vs = document.createElement('span');
    vs.className = 'sc-selector-label';
    vs.textContent = 'vs';

    const lblB = document.createElement('span');
    lblB.className = 'sc-selector-label';
    lblB.textContent = 'B:';

    this._selB = document.createElement('select');
    this._selB.className = 'sc-selector-select';

    this._btn = document.createElement('button');
    this._btn.className = 'sc-compare-btn';
    this._btn.textContent = 'Compare';

    this._status = document.createElement('span');
    this._status.className = 'sc-status';

    bar.append(lblA, this._selA, vs, lblB, this._selB, this._btn, this._status);

    // ── Results area ──
    this._results = document.createElement('div');
    this._results.className = 'sc-results';
    this._showIdle();

    root.append(bar, this._results);
    this._container.appendChild(root);

    this._populateSelectors();

    this.listen(this._btn, 'click', () => this._onCompare());
  }

  _populateSelectors() {
    const scenarios = this._scenarioRegistry.getAll();
    const makeOption = (s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name ?? s.id;
      return opt;
    };

    for (const s of scenarios) {
      this._selA.appendChild(makeOption(s));
      this._selB.appendChild(makeOption(s).cloneNode(true));
    }

    // Default B to second scenario if available
    if (scenarios.length >= 2) this._selB.value = scenarios[1].id;
  }

  _showIdle() {
    this._results.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'sc-idle-msg';
    msg.innerHTML = '<span>Select two scenarios and click Compare.</span>';
    this._results.appendChild(msg);
  }

  async _onCompare() {
    if (this._running) return;

    const idA = this._selA?.value;
    const idB = this._selB?.value;
    if (!idA || !idB) return;

    const entryA = this._scenarioRegistry.get(idA);
    const entryB = this._scenarioRegistry.get(idB);
    if (!entryA || !entryB) return;

    this._running = true;
    this._btn.disabled = true;
    this._status.textContent = 'Running A…';

    // Yield to browser paint before heavy computation
    await new Promise(r => setTimeout(r, 0));

    let resA;
    try {
      resA = ScenarioCompareRunner.run(entryA);
    } catch (err) {
      this._status.textContent = `Error running A: ${err.message}`;
      this._running = false;
      this._btn.disabled = false;
      return;
    }

    this._status.textContent = 'Running B…';
    await new Promise(r => setTimeout(r, 0));

    let resB;
    try {
      resB = ScenarioCompareRunner.run(entryB);
    } catch (err) {
      this._status.textContent = `Error running B: ${err.message}`;
      this._running = false;
      this._btn.disabled = false;
      return;
    }

    this._status.textContent = '';
    this._running = false;
    this._btn.disabled = false;

    this._renderResults(entryA, entryB, resA, resB);
  }

  /**
   * Compare two entries directly (bypasses registry lookup).
   * Used by DecisionGraphPresenter to compare a leaf vs. the base scenario.
   */
  async compareDirect(entryA, entryB) {
    this._running = true;
    if (this._btn) this._btn.disabled = true;
    if (this._status) this._status.textContent = 'Running A…';
    await new Promise(r => setTimeout(r, 0));

    let resA;
    try {
      resA = ScenarioCompareRunner.run(entryA);
    } catch (err) {
      if (this._status) this._status.textContent = `Error running A: ${err.message}`;
      this._running = false;
      if (this._btn) this._btn.disabled = false;
      return;
    }

    if (this._status) this._status.textContent = 'Running B…';
    await new Promise(r => setTimeout(r, 0));

    let resB;
    try {
      resB = ScenarioCompareRunner.run(entryB);
    } catch (err) {
      if (this._status) this._status.textContent = `Error running B: ${err.message}`;
      this._running = false;
      if (this._btn) this._btn.disabled = false;
      return;
    }

    if (this._status) this._status.textContent = '';
    this._running = false;
    if (this._btn) this._btn.disabled = false;
    this._renderResults(entryA, entryB, resA, resB);
  }

  _renderResults(entryA, entryB, resA, resB) {
    this._results.innerHTML = '';
    this._lastEntriesA = resA.journalEntries;
    this._lastEntriesB = resB.journalEntries;

    this._results.appendChild(this._buildKpiSection(entryA, entryB, resA, resB));
    this._results.appendChild(this._buildStateDiffSection(resA.finalState, resB.finalState));
    this._journalEl = this._buildJournalSection(resA.journalEntries, resB.journalEntries);
    this._results.appendChild(this._journalEl);
  }

  _rebuildJournalSection() {
    if (!this._lastEntriesA || !this._journalEl) return;
    const next = this._buildJournalSection(this._lastEntriesA, this._lastEntriesB ?? []);
    this._journalEl.replaceWith(next);
    this._journalEl = next;
  }

  // ── KPI section ─────────────────────────────────────────────────────────────

  _buildKpiSection(entryA, entryB, resA, resB) {
    const section = document.createElement('div');

    const lbl = document.createElement('div');
    lbl.className = 'sc-section-label';
    lbl.textContent = 'Summary KPIs';
    section.appendChild(lbl);

    const grid = document.createElement('div');
    grid.className = 'sc-kpi-table';

    const headers = ['', entryA.name ?? 'A', entryB.name ?? 'B', 'Δ (B−A)'];
    for (const h of headers) {
      const hdr = document.createElement('div');
      hdr.className = 'sc-kpi-hdr';
      hdr.textContent = h;
      grid.appendChild(hdr);
    }

    const deltaA = resA.finalNetWorthUsd;
    const deltaB = resB.finalNetWorthUsd;
    const nwDelta = deltaA != null && deltaB != null ? deltaB - deltaA : null;

    const rows = [
      ['Net Worth (USD)', fmtUsd(resA.finalNetWorthUsd), fmtUsd(resB.finalNetWorthUsd), nwDelta],
      ['Out-of-Funds',    fmtDate(resA.outOfFundsDate),  fmtDate(resB.outOfFundsDate),  null],
      ['Cum. Deficit',    fmtUsd(resA.cumulativeDeficit), fmtUsd(resB.cumulativeDeficit),
        resB.cumulativeDeficit - resA.cumulativeDeficit],
      ['Failed?',         resA.scenarioFailed ? 'Yes' : 'No', resB.scenarioFailed ? 'Yes' : 'No', null],
    ];

    for (const [name, a, b, delta] of rows) {
      const fEl = document.createElement('div');
      fEl.className = 'sc-kpi-field';
      fEl.textContent = name;

      const aEl = document.createElement('div');
      aEl.className = 'sc-kpi-val';
      aEl.textContent = a;

      const bEl = document.createElement('div');
      bEl.className = 'sc-kpi-val';
      bEl.textContent = b;

      const dEl = document.createElement('div');
      dEl.className = 'sc-kpi-delta';
      if (delta == null) {
        dEl.textContent = '—';
      } else {
        dEl.textContent = (delta >= 0 ? '+' : '') + fmtUsd(delta);
        if (delta > 0) dEl.classList.add('pos');
        else if (delta < 0) dEl.classList.add('neg');
      }

      grid.append(fEl, aEl, bEl, dEl);
    }

    section.appendChild(grid);
    return section;
  }

  // ── State diff section ───────────────────────────────────────────────────────

  _buildStateDiffSection(stateA, stateB) {
    const section = document.createElement('div');

    const lbl = document.createElement('div');
    lbl.className = 'sc-section-label';
    lbl.textContent = 'State Diff (numeric fields)';
    section.appendChild(lbl);

    const rows = computeStateDiff(stateA, stateB);
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sc-empty-msg';
      empty.textContent = 'No numeric state fields found.';
      section.appendChild(empty);
      return section;
    }

    const grid = document.createElement('div');
    grid.className = 'sc-diff-table';

    for (const h of ['Field', 'A', 'B', 'Δ (B−A)']) {
      const hdr = document.createElement('div');
      hdr.className = 'sc-diff-hdr';
      hdr.textContent = h;
      grid.appendChild(hdr);
    }

    for (const { field, a, b, delta } of rows) {
      const fEl = document.createElement('div');
      fEl.className = 'sc-diff-field';
      fEl.textContent = field;
      fEl.title = field;

      const aEl = document.createElement('div');
      aEl.className = 'sc-diff-val';
      aEl.textContent = a != null ? fmtNum(a) : '—';

      const bEl = document.createElement('div');
      bEl.className = 'sc-diff-val';
      bEl.textContent = b != null ? fmtNum(b) : '—';

      const dEl = document.createElement('div');
      dEl.className = 'sc-diff-delta';
      if (delta == null) {
        dEl.textContent = '—';
      } else if (delta === 0) {
        dEl.textContent = '0';
        dEl.classList.add('zero');
      } else {
        dEl.textContent = (delta > 0 ? '+' : '') + fmtNum(delta);
        dEl.classList.add(delta > 0 ? 'pos' : 'neg');
      }

      grid.append(fEl, aEl, bEl, dEl);
    }

    section.appendChild(grid);
    return section;
  }

  // ── Journal overlay section ──────────────────────────────────────────────────

  _buildJournalSection(entriesA, entriesB) {
    const section = document.createElement('div');

    const lbl = document.createElement('div');
    lbl.className = 'sc-section-label';
    lbl.textContent = 'Journal Overlay (by date)';
    section.appendChild(lbl);

    const overlay     = buildJournalOverlay(entriesA, entriesB);
    const firstDivDate = firstDivergenceDate(overlay);

    const nwSeriesA   = runningNetWorthSeries(entriesA ?? []);
    const nwSeriesB   = runningNetWorthSeries(entriesB ?? []);
    const nwByEntryA  = new Map((entriesA ?? []).map((e, i) => [e, nwSeriesA[i]]));
    const nwByEntryB  = new Map((entriesB ?? []).map((e, i) => [e, nwSeriesB[i]]));

    if (overlay.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sc-empty-msg';
      empty.textContent = 'No journal entries found.';
      section.appendChild(empty);
      return section;
    }

    // ── Filter bar ──
    section.appendChild(this._buildJournalFilterBar());

    const container = document.createElement('div');
    container.className = 'sc-journal-overlay';

    for (const day of overlay) {
      // Filter: "after divergence" — hide days before firstDivDate
      if (this._filterMode === 'after-divergence' && firstDivDate && day.date < firstDivDate) {
        continue;
      }

      const { date, aEntries, bEntries, pairs } = day;

      // Filter: "differs" — skip days with no unmatched rows and no non-zero deltas
      const hasDiff = (pairs ?? []).some(p =>
        p.kind !== 'paired' ||
        (p.fieldRows ?? []).some(r => r.deltaOfDelta !== null && r.deltaOfDelta !== 0)
      );
      if (this._filterMode === 'differs' && !hasDiff) continue;

      // For "field" filter: filter pairs to those touching the field path
      const fieldFilter = this._filterMode === 'field' && this._filterField.trim();
      const visiblePairs = fieldFilter
        ? (pairs ?? []).filter(p =>
            (p.fieldRows ?? []).some(r => r.field.includes(this._filterField.trim()))
          )
        : (pairs ?? []);
      if (fieldFilter && visiblePairs.length === 0) continue;

      // Build day element
      const isDivDay = firstDivDate === date;
      const day$     = document.createElement('div');
      day$.className = 'sc-journal-day';

      const unmatched  = (pairs ?? []).filter(p => p.kind !== 'paired').length;
      const deltaCount = (pairs ?? []).filter(p =>
        (p.fieldRows ?? []).some(r => r.deltaOfDelta !== null && r.deltaOfDelta !== 0)
      ).length;

      const header = document.createElement('div');
      header.className = 'sc-journal-day-header';

      const toggle = document.createElement('span');
      toggle.className = 'sc-journal-day-toggle';
      toggle.textContent = '▶';

      const dateSpan = document.createElement('span');
      dateSpan.textContent = date;

      const countParts = [`A:${aEntries.length}  B:${bEntries.length}`];
      if (unmatched > 0)  countParts.push(`⚠:${unmatched}`);
      if (deltaCount > 0) countParts.push(`Δ:${deltaCount}`);
      const countSpan = document.createElement('span');
      countSpan.className = 'sc-journal-day-count';
      countSpan.textContent = countParts.join('  ');

      header.append(toggle, dateSpan, countSpan);

      const body = document.createElement('div');
      body.className = 'sc-journal-day-body';
      body.style.display = 'none';

      // Divergence banner injected as first child of expanded body
      if (isDivDay) {
        const banner = document.createElement('div');
        banner.className = 'sc-journal-divergence-banner';
        banner.textContent = `── First divergence: ${date} ──`;
        body.appendChild(banner);
      }

      // Field-grid column header (only if we have field rows to show)
      const anyFields = (visiblePairs).some(p => (p.fieldRows ?? []).length > 0);
      if (anyFields) {
        const hdr = document.createElement('div');
        hdr.className = 'sc-journal-fields-hdr';
        for (const txt of ['Field', 'A  (before→after)', 'B  (before→after)', 'Δ (B−A)']) {
          const c = document.createElement('div');
          c.textContent = txt;
          hdr.appendChild(c);
        }
        body.appendChild(hdr);
      }

      for (const p of visiblePairs) {
        const nwA = p.aEntry ? nwByEntryA.get(p.aEntry) : null;
        const nwB = p.bEntry ? nwByEntryB.get(p.bEntry) : null;
        body.appendChild(this._buildPairRowEl(p, nwA, nwB));
      }

      // Toggle expand/collapse
      header.addEventListener('click', () => {
        const open = body.style.display !== 'none';
        body.style.display  = open ? 'none' : 'block';
        toggle.textContent  = open ? '▶' : '▼';
      });

      day$.append(header, body);
      container.appendChild(day$);
    }

    section.appendChild(container);
    return section;
  }

  _buildJournalFilterBar() {
    const bar = document.createElement('div');
    bar.className = 'sc-journal-filter-bar';

    const modes = [
      { key: 'all',              label: 'All' },
      { key: 'differs',          label: 'Differs' },
      { key: 'after-divergence', label: 'After divergence' },
      { key: 'field',            label: 'Field path…' },
    ];

    const input = document.createElement('input');
    input.type        = 'text';
    input.className   = 'sc-filter-field-input';
    input.placeholder = 'field path…';
    input.value       = this._filterField;
    input.style.display = this._filterMode === 'field' ? '' : 'none';

    for (const { key, label } of modes) {
      const btn = document.createElement('button');
      btn.className   = `sc-filter-btn${this._filterMode === key ? ' active' : ''}`;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        this._filterMode = key;
        input.style.display = key === 'field' ? '' : 'none';
        this._rebuildJournalSection();
      });
      bar.appendChild(btn);
    }

    input.addEventListener('input', () => {
      this._filterField = input.value;
      this._rebuildJournalSection();
    });

    bar.appendChild(input);
    return bar;
  }

  _buildPairRowEl(pair, nwAVal, nwBVal) {
    const { kind, aEntry, bEntry, fieldRows } = pair;

    const block = document.createElement('div');
    block.className = `sc-pair-row ${kind}`;

    // ── Row header: action name + NW gutter ──
    const rowHdr = document.createElement('div');
    rowHdr.className = 'sc-pair-row-header';

    const nameA = aEntry ? (aEntry.action?.name ?? aEntry.action?.type ?? '?') : null;
    const nameB = bEntry ? (bEntry.action?.name ?? bEntry.action?.type ?? '?') : null;

    const actionName = document.createElement('span');
    actionName.className = 'sc-pair-action-name';
    if (kind === 'paired') {
      actionName.textContent = nameA ?? nameB ?? '?';
    } else if (kind === 'a-only') {
      actionName.textContent = `${nameA ?? '?'} [A]`;
    } else {
      actionName.textContent = `${nameB ?? '?'} [B]`;
    }
    actionName.title = [
      aEntry ? `A: ${aEntry.action?.type ?? ''} — ${aEntry.reducer?.name ?? ''}` : '',
      bEntry ? `B: ${bEntry.action?.type ?? ''} — ${bEntry.reducer?.name ?? ''}` : '',
    ].filter(Boolean).join('\n');

    rowHdr.appendChild(actionName);

    if (nwAVal != null || nwBVal != null) {
      const nwGutter = document.createElement('span');
      nwGutter.className = 'sc-journal-nw-gutter';
      const parts = [];
      if (nwAVal != null) parts.push(`A: ${fmtUsd(nwAVal)}`);
      if (nwBVal != null) parts.push(`B: ${fmtUsd(nwBVal)}`);
      if (nwAVal != null && nwBVal != null) {
        const diff = nwBVal - nwAVal;
        parts.push((diff >= 0 ? '+' : '') + fmtUsd(diff));
      }
      nwGutter.textContent = parts.join('  ');
      rowHdr.appendChild(nwGutter);
    }

    block.appendChild(rowHdr);

    // ── Field rows ──
    if ((fieldRows ?? []).length > 0) {
      const grid = document.createElement('div');
      grid.className = 'sc-journal-fields';

      for (const fr of fieldRows) {
        const row = document.createElement('div');
        row.className = `sc-journal-field-row${fr.deltaOfDelta ? '' : ' zero-delta'}`;

        const fName = document.createElement('div');
        fName.className = 'sc-field-name';
        fName.textContent = fr.field;
        fName.title = fr.field;

        const aCell = document.createElement('div');
        aCell.className = 'sc-journal-arrow';
        if (fr.aBefore !== null || fr.aAfter !== null) {
          aCell.textContent = `${fmtNum(fr.aBefore)} → ${fmtNum(fr.aAfter)}`;
        } else {
          aCell.textContent = '—';
          aCell.classList.add('missing');
        }

        const bCell = document.createElement('div');
        bCell.className = 'sc-journal-arrow';
        if (fr.bBefore !== null || fr.bAfter !== null) {
          bCell.textContent = `${fmtNum(fr.bBefore)} → ${fmtNum(fr.bAfter)}`;
        } else {
          bCell.textContent = '—';
          bCell.classList.add('missing');
        }

        const dCell = document.createElement('div');
        dCell.className = 'sc-field-delta';
        if (fr.deltaOfDelta == null) {
          dCell.textContent = '—';
        } else if (fr.deltaOfDelta === 0) {
          dCell.textContent = '0';
          dCell.classList.add('zero');
        } else {
          dCell.textContent = (fr.deltaOfDelta > 0 ? '+' : '') + fmtNum(fr.deltaOfDelta);
          dCell.classList.add(fr.deltaOfDelta > 0 ? 'pos' : 'neg');
        }

        row.append(fName, aCell, bCell, dCell);
        grid.appendChild(row);
      }

      block.appendChild(grid);
    }

    return block;
  }
}
