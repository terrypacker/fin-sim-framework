/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { WorkbenchComponent } from '../../component.js';
import { WB_EVENTS }          from '../../workbench-runtime.js';
import { ServiceRegistry }    from '../../../../services/service-registry.js';
import { withBom }            from '../../../../utils/csv.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../../../simulation-framework/bus-messages.js';
import { buildAllocationCube } from '../../../../finance/allocation-reporting/allocation-cube.js';
import { rollupBySecurity, totalSecurityRollup }
  from '../../../../finance/allocation-reporting/security-rollup.js';

const BASE_CURRENCY = 'USD';

/**
 * SecuritiesPlugin — what the plan OWNS, by instrument, across every account.
 * Design 94 step 10, the third of §10.2e's loose ends.
 *
 * ─── the question the other two panels cannot answer ─────────────────────────
 *
 * `HoldingsPlugin` is scoped to one account and refuses to total its Units column, and is
 * right to: summing counts of different instruments produces a number that looks like a
 * quantity and is not one. `AllocationPlugin`'s By-security view crosses accounts but
 * charts SHARES over time, so it answers "how concentrated" and not "how many, and where".
 * Between them, *how many shares of this do I own?* had no answer on a plan holding one
 * instrument in three wrappers — which is the ordinary case for employer stock, and
 * therefore exactly the case design 94 §3 item 4 exists for.
 *
 * The refusal does not change here; the grouping does. **A unit count totals within a
 * security and never across securities** — so every row carries one and the footer
 * carries none, deliberately (see `totalSecurityRollup`).
 *
 * ─── what it reads, and what that costs ──────────────────────────────────────
 *
 * `buildAllocationCube` at the current sim date, rolled up by `security-rollup.js`. Not
 * its own walk of `state`: the cube is where `securityId` joined the bucket key at step 9,
 * where FX conversion happens once, and where THE INVARIANT (the cube's total ties to net
 * worth) is guarded. A second walk here would be a second answer with no way to tell which
 * is right — the failure the allocation panel's header names.
 *
 * Two consequences of reading the cube rather than the accounts:
 *
 * - **Money is in the cube's base currency**, converted at the run's own rate, so a US and
 *   an AU position in one instrument add up. The column headers say so; a bare "$" over a
 *   mixed-currency sum is the guardrail-FX defect wearing a table.
 * - **Units cross currencies untouched**, being counts. That is why the unit column is the
 *   one figure on this panel that needs no conversion caveat at all.
 */
export class SecuritiesPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime  = runtime;
    this._sim      = null;
    this._servicesOverride = null;   // tests
    this._unsubSimBus  = null;
    this._renderQueued = false;
    this._expanded     = new Set();  // securityIds showing their per-account breakdown
    this._showSynthetic = true;
    this._rowsCache    = null;
    this._dataSig      = null;
  }

  setServices(services) { this._servicesOverride = services ?? null; }
  _services() { return this._servicesOverride ?? ServiceRegistry.getInstance(); }

  render() {
    const root = document.createElement('div');
    root.className = 'sec-plugin wb-plugin-fill';
    root.innerHTML = `
      <div class="sec-toolbar">
        <label class="sec-toggle" title="The four sec-auto-* market securities are what every migrated equity lot names (design 94 §9.1). Hide them to see only the instruments this plan authored.">
          <input type="checkbox" data-sec="synthetic" checked> show market sleeves
        </label>
        <span class="sec-spacer"></span>
        <span class="sec-asof" data-sec="asof">—</span>
        <button class="sec-csv-btn" data-sec="csv" title="Download this rollup as CSV">&#11015; CSV</button>
      </div>
      <div class="sec-body" data-sec="body">
        <div class="sec-placeholder" data-sec="placeholder">Run a simulation to populate securities.</div>
        <table class="sec-grid" data-sec="grid" style="display:none">
          <thead><tr>
            <th class="sec-th">Security</th>
            <th class="sec-th">Market</th>
            <th class="sec-th sec-th--num">Units</th>
            <th class="sec-th sec-th--num" title="Market value ÷ units — a blended value per unit across accounts, not a quoted price. Design 94 §4 puts the price on the POSITION, so across two accounts there is no single one.">Avg <span data-sec="cur-a"></span>/unit</th>
            <th class="sec-th sec-th--num">Market value (<span data-sec="cur-b"></span>)</th>
            <th class="sec-th sec-th--num">Cost basis (<span data-sec="cur-c"></span>)</th>
            <th class="sec-th sec-th--num">Unrealized</th>
            <th class="sec-th sec-th--num">Share</th>
            <th class="sec-th sec-th--num">Accounts</th>
          </tr></thead>
          <tbody data-sec="rows"></tbody>
          <tfoot data-sec="foot"></tfoot>
        </table>
      </div>
    `;
    return root;
  }

  onInit() {
    this._runtime.bus.subscribe(WB_EVENTS.SCENARIO_READY, ({ scenario }) => this._bindSim(scenario?.sim ?? null));
    this._runtime.bus.subscribe(WB_EVENTS.DISPLAY_SETTINGS_CHANGED, () => this._render());
  }

  onMount() {
    // Late-mount: the scenario is usually built before this panel first mounts.
    if (!this._sim) this._bindSim(this._services()?.simulationRegistry?.getPrimary?.() ?? null);

    this._bindOnce('synthetic', 'change', (el) => {
      this._showSynthetic = el.checked;
      this._dataSig = null;
      this._render();
    });
    this._bindOnce('csv', 'click', () => this._downloadCsv());

    const rows = this._q('rows');
    if (rows && !rows._secBound) {
      // Delegated, because the rows are re-rendered on every sim step and a per-row
      // listener would be re-attached (and leaked) each time.
      rows.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        const id = tr.dataset.id;
        if (this._expanded.has(id)) this._expanded.delete(id); else this._expanded.add(id);
        this._render();
      });
      rows._secBound = true;
    }

    this._render();
  }

  onActivate() { this._render(); }

  destroy() {
    this._unsubSimBus?.();
    this._unsubSimBus = null;
    super.destroy?.();
  }

  // ─── Binding ─────────────────────────────────────────────────────────────

  _bindSim(sim) {
    this._unsubSimBus?.();
    this._unsubSimBus = null;
    this._sim = sim ?? null;
    this._dataSig = null;

    if (sim?.bus) {
      // One completed EVENT is one step the user perceives; coalesce the burst into a
      // single rAF-debounced render, exactly as the holdings panel does.
      this._unsubSimBus = sim.bus.subscribe(
        `EXECUTION_${EXECUTION_PHASES.END}`, { kind: EXECUTION_KINDS.EVENT },
        () => this._scheduleRender());
    }
    if (this._mounted) this._render();
  }

  _scheduleRender() {
    if (!this._mounted || this._renderQueued) return;
    this._renderQueued = true;
    const run = () => { this._renderQueued = false; if (this._mounted) this._render(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  // ─── Data ────────────────────────────────────────────────────────────────

  /**
   * The rollup, cached against the run's own progress.
   *
   * `eventExecutions` joins the date in the key for the reason the allocation panel gives:
   * the state moves during the very first `stepTo`, and a cache keyed on the date alone
   * would freeze the opening book while the clock sat inside its first year.
   */
  _rows() {
    const sim = this._sim;
    if (!sim?.state) return [];
    const sig = `${sim.currentDate?.getTime?.() ?? 0}|${sim.eventExecutions ?? 0}|${this._showSynthetic}`;
    if (sig === this._dataSig && this._rowsCache) return this._rowsCache;
    try {
      const cube = buildAllocationCube(sim.state, {
        date:           sim.currentDate ?? null,
        baseCurrency:   BASE_CURRENCY,
        displayNameFor: (stateKey) => this._services()?.schemaRegistry?.displayNameFor?.(stateKey) ?? null,
        // Only positions can name an instrument, so everything else is noise here — and
        // the reconciliation residual, which names none, would be filtered out anyway.
        includeNonHoldingAssets: false,
        includeLiabilities:      false,
        reconcileToBalance:      false,
      });
      this._rowsCache = rollupBySecurity(cube, { includeSynthetic: this._showSynthetic });
    } catch (e) {
      // A scenario that fails to cube is a bug worth seeing in the console, but it must
      // not take the panel — or the workbench boot that mounts it — down with it.
      console.warn('[SecuritiesPlugin] could not roll the book up by security', e);
      this._rowsCache = [];
    }
    this._dataSig = sig;
    return this._rowsCache;
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  _render() {
    if (!this._mounted) return;

    const asof = this._q('asof');
    if (asof) asof.textContent = this._sim?.currentDate ? `as of ${this._fmtDate(this._sim.currentDate)}` : '—';

    // The money headers name the currency the cells are actually IN. `formatAmount`
    // converts to the reader's display currency, so a header hard-coded to the cube's
    // base would label an AUD column "USD" the moment the reader switched — a mixed-
    // currency sum under the wrong symbol, which is how the guardrail FX defect read.
    const code = this._displayCode();
    for (const k of ['cur-a', 'cur-b', 'cur-c']) {
      const el = this._q(k);
      if (el) el.textContent = code;
    }

    const rows  = this._rows();
    const empty = !this._sim || rows.length === 0;

    this._q('placeholder').style.display = empty ? '' : 'none';
    this._q('grid').style.display        = empty ? 'none' : '';
    if (empty) {
      this._q('placeholder').textContent = !this._sim
        ? 'Run a simulation to populate securities.'
        : this._showSynthetic
          ? 'No position in this plan names an instrument.'
          : 'This plan authors no securities of its own — every position names a market sleeve. '
            + 'Tick “show market sleeves”, or add one from Nodes → Securities.';
      return;
    }

    const body = this._q('rows');
    body.innerHTML = rows.map(r => this._rowHtml(r)).join('');

    const t = totalSecurityRollup(rows);
    // No units total, and that is the rule rather than an omission: adding a share of one
    // instrument to a share of another is the category error this panel exists to avoid.
    // The cell says so instead of being blank, because a blank reads as missing data.
    this._q('foot').innerHTML = `
      <tr class="sec-total-row">
        <td class="sec-td" colspan="2">Total — ${rows.length} instrument${rows.length === 1 ? '' : 's'}</td>
        <td class="sec-td sec-td--num sec-td--muted" title="Counts of different instruments do not add. Each row's own total is the honest one.">n/a</td>
        <td class="sec-td sec-td--num"></td>
        <td class="sec-td sec-td--num">${this._money(t.marketValue)}</td>
        <td class="sec-td sec-td--num">${t.allBased ? this._money(t.costBasis) : '—'}</td>
        <td class="sec-td sec-td--num ${_signCls(t.allBased ? t.marketValue - t.costBasis : null)}">${
          t.allBased ? this._signed(t.marketValue - t.costBasis) : '—'}</td>
        <td class="sec-td sec-td--num">100%</td>
        <td class="sec-td sec-td--num">${t.holdingCount} lot${t.holdingCount === 1 ? '' : 's'}</td>
      </tr>`;
  }

  _rowHtml(r) {
    const open = this._expanded.has(r.securityId);
    const main = `
      <tr data-id="${_esc(r.securityId)}" class="sec-row${open ? ' is-open' : ''}">
        <td class="sec-td sec-name" title="${_esc(r.securityId)}">
          <span class="sec-caret">${open ? '▾' : '▸'}</span>${_esc(r.security)}</td>
        <td class="sec-td">${_esc(r.rateKey ?? '—')}</td>
        <td class="sec-td sec-td--num">${_fmtUnits(r.units)}</td>
        <td class="sec-td sec-td--num">${r.avgPrice == null ? '—' : this._money(r.avgPrice, 2)}</td>
        <td class="sec-td sec-td--num">${this._money(r.marketValue)}</td>
        <td class="sec-td sec-td--num">${r.costBasis == null ? '—' : this._money(r.costBasis)}</td>
        <td class="sec-td sec-td--num ${_signCls(r.unrealized)}">${this._signed(r.unrealized)}</td>
        <td class="sec-td sec-td--num">${(r.share * 100).toFixed(1)}%</td>
        <td class="sec-td sec-td--num">${r.accounts.length}</td>
      </tr>`;
    if (!open) return main;

    // The "across all accounts" half, made visible: one instrument, several wrappers, and
    // the per-wrapper counts whose sum is the row above.
    const detail = r.accounts.map(a => `
      <tr class="sec-detail-row">
        <td class="sec-td sec-detail-name" colspan="2">${_esc(a.name)}</td>
        <td class="sec-td sec-td--num">${_fmtUnits(a.units)}</td>
        <td class="sec-td sec-td--num"></td>
        <td class="sec-td sec-td--num">${this._money(a.marketValue)}</td>
        <td class="sec-td sec-td--num">${a.costBasis == null ? '—' : this._money(a.costBasis)}</td>
        <td class="sec-td sec-td--num" colspan="3"></td>
      </tr>`).join('');
    return main + detail;
  }

  // ─── CSV ─────────────────────────────────────────────────────────────────

  /**
   * One row per (security, account) plus a per-security TOTAL row, so the file carries
   * both the number on screen and what it is made of. A column that exists on the panel
   * and not in the export is a figure nobody can trace back to the lots it came from —
   * step 9's own finding, applied here.
   */
  _downloadCsv() {
    const rows = this._rows();
    if (!rows.length) return;
    const cols = ['securityId', 'security', 'rateKey', 'allocation', 'scope', 'stateKey',
      'units', `avgPrice${BASE_CURRENCY}`, `marketValue${BASE_CURRENCY}`, `costBasis${BASE_CURRENCY}`,
      'unrealized', 'share', 'holdingCount'];
    const out = [];
    for (const r of rows) {
      out.push([r.securityId, r.security, r.rateKey, r.allocation, 'TOTAL', '',
        r.units, r.avgPrice, r.marketValue, r.costBasis, r.unrealized, r.share, r.holdingCount]);
      for (const a of r.accounts) {
        out.push([r.securityId, r.security, r.rateKey, r.allocation, 'ACCOUNT', a.stateKey,
          a.units, '', a.marketValue, a.costBasis, '', '', '']);
      }
    }
    const cell = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv  = [cols.join(','), ...out.map(r => r.map(cell).join(','))].join('\n');
    const blob = new Blob([withBom(csv)], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `securities-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** The currency the cells are rendered in: the reader's display setting, else the base. */
  _displayCode() {
    return this._services()?.schemaRegistry?.displayCurrencyCode?.()
      || this._runtime?.displaySettings?.displayCurrency
      || BASE_CURRENCY;
  }

  _money(n, decimals = 0) {
    if (n == null) return '—';
    const reg = this._services()?.schemaRegistry;
    const formatted = reg?.formatAmount?.(n, BASE_CURRENCY, { maximumFractionDigits: decimals });
    if (formatted != null) return formatted;
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  }

  _signed(n) {
    if (n == null) return '—';
    return (n > 0 ? '+' : n < 0 ? '-' : '') + this._money(Math.abs(n));
  }

  _fmtDate(d) {
    const settings = this._runtime?.displaySettings;
    // The setter-only path formats in LOCAL time and silently shifts a UTC date across a
    // day boundary; `formatDate` is the one that does not.
    return settings?.formatDate?.(d) ?? new Date(d).toISOString().slice(0, 10);
  }

  _bindOnce(name, event, handler) {
    const el = this._q(name);
    if (!el || el._secBound) return;
    el.addEventListener(event, () => handler(el));
    el._secBound = true;
  }

  _q(name) { return this.el?.querySelector(`[data-sec="${name}"]`) ?? null; }
}

/**
 * A unit count is not money: 0.0001 of a share is a real position and rounding to whole
 * units would print `0` for it, while trailing zeros on a round lot are noise.
 */
function _fmtUnits(n) {
  if (n == null) return '—';
  return String(+Number(n).toFixed(4));
}

function _signCls(n) {
  if (n == null || n === 0) return '';
  return n > 0 ? 'sec-pos' : 'sec-neg';
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
