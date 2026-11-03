/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import * as echarts from 'echarts';
import { WorkbenchComponent } from '../../component.js';
import { WB_EVENTS }          from '../../workbench-runtime.js';
import { ServiceRegistry }    from '../../../../services/service-registry.js';
import { withBom }            from '../../../../utils/csv.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../../../simulation-framework/bus-messages.js';
import { rollupBonds, buildMaturityLadder, BOND_TYPE }
  from '../../../../finance/allocation-reporting/bond-rollup.js';
import { colorForSeriesKey }  from '../../../../finance/allocation-reporting/allocation-palette.js';

const BASE_CURRENCY = 'USD';
const TYPE_INDEX = Object.fromEntries(Object.values(BOND_TYPE).map((t, i) => [t, i]));

/**
 * BondsPlugin — the plan's bonds by TYPE, account and lot, with the maturity ladder
 * (design 130).
 *
 * ─── why a sibling of the Securities panel and not a mode of it ──────────────────
 *
 * The Securities panel groups by instrument and totals units within one. A ladder is many
 * instruments (one per maturity) and a "muni" is not an instrument at all — it is a tax
 * treatment read off the lot. So this panel borrows the Securities panel's look and
 * binding and none of its grouping: `rollupBonds` walks the lots the allocation cube folds
 * away, and a unit test holds its totals to the cube's (design 130 §3.2).
 *
 * ─── what differs on purpose ─────────────────────────────────────────────────────
 *
 * - **The footer totals principal.** Principal is money repaid, in one currency after
 *   conversion, so it adds across types the way a unit count never does. A fund has none,
 *   and the footer says "dated only" rather than pretending.
 * - **The chart is a snapshot.** The maturity ladder is the book at the panel's date, not
 *   a projection of what the run will buy; it moves as rungs mature and roll.
 */
export class BondsPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime  = runtime;
    this._sim      = null;
    this._servicesOverride = null;   // tests
    this._unsubSimBus  = null;
    this._renderQueued = false;
    this._expanded     = new Set();  // `t:<type>` and `a:<type>:<stateKey>`
    this._chartBy      = 'account';
    this._showChart    = true;
    this._highlightYear = null;      // a clicked ladder column
    this._chart        = null;
    this._ro           = null;
    this._rollupCache  = null;
    this._dataSig      = null;
  }

  setServices(services) { this._servicesOverride = services ?? null; }
  _services() { return this._servicesOverride ?? ServiceRegistry.getInstance(); }

  render() {
    const root = document.createElement('div');
    root.className = 'bond-plugin sec-plugin wb-plugin-fill';
    root.innerHTML = `
      <div class="sec-toolbar">
        <span class="bond-seg" data-bond="by" title="What the ladder's bars are stacked by">
          <button data-by="account" class="on">by account</button><button data-by="type">by type</button>
        </span>
        <label class="sec-toggle">
          <input type="checkbox" data-bond="show-chart" checked> maturity ladder
        </label>
        <span class="sec-spacer"></span>
        <span class="sec-asof" data-bond="asof">—</span>
        <button class="sec-csv-btn" data-bond="csv" title="Download the bond rollup as CSV">&#11015; CSV</button>
      </div>
      <div class="sec-body" data-bond="body">
        <!-- One scroll region for warning, chart and table. With only the table scrolling,
             a long warning plus the fixed-height chart squeezed the table to 0px. -->
        <div class="bond-warn" data-bond="warn" style="display:none"></div>
        <div class="bond-chart-wrap" data-bond="chart-wrap">
          <div class="bond-chart" data-bond="chart"></div>
          <div class="bond-caption" data-bond="caption"></div>
        </div>
        <div class="sec-placeholder" data-bond="placeholder">Run a simulation to populate bonds.</div>
        <table class="sec-grid" data-bond="grid" style="display:none">
          <thead><tr>
            <th class="sec-th">Bond</th>
            <th class="sec-th sec-th--num" title="What the dated bonds redeem for at today's index ratio — face for a nominal bond, inflation-adjusted principal (never below face) for TIPS. A fund has none.">Principal (<span data-bond="cur-a"></span>)</th>
            <th class="sec-th sec-th--num">Market value (<span data-bond="cur-b"></span>)</th>
            <th class="sec-th sec-th--num">Cost basis (<span data-bond="cur-c"></span>)</th>
            <th class="sec-th sec-th--num">Unrealized</th>
            <th class="sec-th sec-th--num" title="Weighted by principal (market value for a fund). An inflation-linked coupon is a REAL rate, paid on indexed principal.">Coupon</th>
            <th class="sec-th sec-th--num" title="Effective duration, weighted by market value. A dated bond's shortens towards maturity.">Duration</th>
            <th class="sec-th sec-th--num" title="Maturity date of a lot; the soonest maturity of a group. ↻ = rolls into a fresh rung at maturity.">Maturity</th>
            <th class="sec-th sec-th--num">Share</th>
            <th class="sec-th sec-th--num">Lots</th>
          </tr></thead>
          <tbody data-bond="rows"></tbody>
          <tfoot data-bond="foot"></tfoot>
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
    if (!this._sim) this._bindSim(this._services()?.simulationRegistry?.getPrimary?.() ?? null);

    this._bindOnce('show-chart', 'change', (el) => { this._showChart = el.checked; this._render(); });
    this._bindOnce('csv', 'click', () => this._downloadCsv());

    const seg = this._q('by');
    if (seg && !seg._bondBound) {
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-by]');
        if (!btn) return;
        this._chartBy = btn.dataset.by;
        seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
        this._render();
      });
      seg._bondBound = true;
    }

    const rows = this._q('rows');
    if (rows && !rows._bondBound) {
      // Delegated: rows are re-rendered every step, and a per-row listener would leak.
      rows.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-key]');
        if (!tr) return;
        const key = tr.dataset.key;
        if (this._expanded.has(key)) this._expanded.delete(key); else this._expanded.add(key);
        this._render();
      });
      rows._bondBound = true;
    }

    this._render();
  }

  onActivate() {
    // ECharts cannot size itself in a hidden pane.
    this._chart?.resize();
    this._render();
  }

  onAdopt() { this._chart?.resize(); }

  onUnmount() { this._disposeChart(); }

  destroy() {
    this._unsubSimBus?.();
    this._unsubSimBus = null;
    this._disposeChart();
    super.destroy?.();
  }

  _disposeChart() {
    this._ro?.disconnect();
    this._ro = null;
    this._chart?.dispose();
    this._chart = null;
  }

  // ─── Binding ─────────────────────────────────────────────────────────────

  _bindSim(sim) {
    this._unsubSimBus?.();
    this._unsubSimBus = null;
    this._sim = sim ?? null;
    this._dataSig = null;
    this._highlightYear = null;
    if (sim?.bus) {
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

  /** The rollup, cached on the run's own progress (date + executions, as Securities). */
  _rollup() {
    const sim = this._sim;
    if (!sim?.state) return null;
    const sig = `${sim.currentDate?.getTime?.() ?? 0}|${sim.eventExecutions ?? 0}`;
    if (sig === this._dataSig && this._rollupCache) return this._rollupCache;
    try {
      this._rollupCache = rollupBonds(sim.state, {
        date:           sim.currentDate ?? null,
        baseCurrency:   BASE_CURRENCY,
        displayNameFor: (k) => this._services()?.schemaRegistry?.displayNameFor?.(k) ?? null,
      });
    } catch (e) {
      console.warn('[BondsPlugin] could not roll the bonds up', e);
      this._rollupCache = null;
    }
    this._dataSig = sig;
    return this._rollupCache;
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  _render() {
    if (!this._mounted) return;

    const asof = this._q('asof');
    if (asof) asof.textContent = this._sim?.currentDate ? `as of ${this._fmtDate(this._sim.currentDate)}` : '—';

    // The headers name the currency AND basis the cells are rendered in (Securities §, design 79).
    const basis = this._services()?.schemaRegistry?.presentForDisplay?.(1, BASE_CURRENCY, { at: 'live' })?.basis;
    const code  = this._displayCode() + (basis === 'real' ? ' real' : '');
    for (const k of ['cur-a', 'cur-b', 'cur-c']) {
      const el = this._q(k);
      if (el) el.textContent = code;
    }

    const r     = this._rollup();
    const empty = !this._sim || !r || r.lots.length === 0;
    this._q('placeholder').style.display = empty ? '' : 'none';
    this._q('grid').style.display        = empty ? 'none' : '';
    this._q('chart-wrap').style.display  = empty || !this._showChart ? 'none' : '';
    this._renderWarnings(empty ? [] : r.warnings);
    if (empty) {
      this._q('placeholder').textContent = !this._sim
        ? 'Run a simulation to populate bonds.'
        : 'This plan holds no bonds.';
      this._q('rows').innerHTML = '';
      this._q('foot').innerHTML = '';
      return;
    }

    // A clicked ladder column opens every group holding a lot that matures that year.
    this._q('rows').innerHTML = r.types.map(t => this._typeHtml(t, this._highlightYear)).join('');
    this._q('foot').innerHTML = this._footHtml(r);

    if (this._showChart) this._renderChart(r);
  }

  _renderWarnings(warnings) {
    const el = this._q('warn');
    if (!el) return;
    if (!warnings.length) { el.style.display = 'none'; el.innerHTML = ''; this._warnSig = null; return; }
    // Design 130 §8 Q1: US exemptions are for US Treasury and US state/local bonds, so on an
    // AU-market lot one is almost certainly an authoring slip — most often the ladder's tax
    // treatment (`bondLadderTaxTreatment`, default 'state'), which is stamped on EVERY laddered
    // account, AU ones included. One line per (account, exemption), collapsed:
    // a ladder puts one warning on every rung, and listing each pushed the table out of view.
    const groups = new Map();
    for (const w of warnings) {
      const k = `${w.stateKey}\u0000${w.taxExemption}`;
      const g = groups.get(k) ?? { name: w.name, taxExemption: w.taxExemption, lots: [] };
      g.lots.push(w.label ?? w.lotId ?? 'a lot');
      groups.set(k, g);
    }
    const n = warnings.length;
    const items = [...groups.values()].map(g =>
      `<li title="${_esc(g.lots.join(', '))}"><b>${_esc(g.name)}</b> — ${g.lots.length} lot${g.lots.length === 1 ? '' : 's'}, taxExemption '${_esc(g.taxExemption)}'</li>`).join('');
    const sig = `${n}|${items}`;
    if (sig === this._warnSig) return;   // keep the reader's open/closed choice across steps
    const wasOpen = el.querySelector('details')?.open ?? false;
    el.innerHTML = `<details${wasOpen ? ' open' : ''}><summary>⚠ ${n} AU-market bond lot${n === 1 ? '' : 's'} carr${n === 1 ? 'ies' : 'y'} a US tax exemption</summary>
      US exemptions are for US Treasury and US state/local bonds, so this is likely an authoring slip. On a ladder it usually
      comes from the ladder's tax treatment (default: state-exempt Treasury), which is applied to every laddered account.
      Check whatever reads this lot's coupon for US tax.
      <ul>${items}</ul></details>`;
    el.style.display = '';
    this._warnSig = sig;
  }

  _typeHtml(t, hlYear) {
    const key  = `t:${t.type}`;
    const open = this._expanded.has(key) || this._groupHasYear(t, hlYear);
    const main = `
      <tr data-key="${_esc(key)}" class="sec-row bond-type-row${open ? ' is-open' : ''}">
        <td class="sec-td sec-name"><span class="sec-caret">${open ? '▾' : '▸'}</span>${_esc(t.label)}</td>
        ${this._figureCells(t, { maturity: t.nextMaturityMs, accounts: t.accounts.length })}
      </tr>`;
    if (!open) return main;
    return main + t.accounts.map(a => this._accountHtml(t, a, hlYear)).join('');
  }

  _accountHtml(t, a, hlYear) {
    const key  = `a:${t.type}:${a.stateKey}`;
    const open = this._expanded.has(key) || this._groupHasYear(a, hlYear);
    const main = `
      <tr data-key="${_esc(key)}" class="sec-row sec-detail-row bond-acct-row${open ? ' is-open' : ''}">
        <td class="sec-td sec-detail-name"><span class="sec-caret">${open ? '▾' : '▸'}</span>${_esc(a.name)}</td>
        ${this._figureCells(a, { maturity: a.nextMaturityMs })}
      </tr>`;
    if (!open) return main;
    return main + a.lots.map(l => this._lotHtml(l, hlYear)).join('');
  }

  _lotHtml(l, hlYear) {
    const hl = hlYear != null && l.maturityMs != null && new Date(l.maturityMs).getUTCFullYear() === hlYear;
    const maturity = l.maturityMs == null
      ? '<span class="sec-td--muted">fund</span>'
      : `${l.rolls ? `<span class="bond-roll" title="Rolls into a fresh ${l.rollTermYears ?? ''}${l.rollTermYears ? '-year ' : ''}rung at maturity">↻</span> ` : ''}${this._fmtDate(new Date(l.maturityMs))}`;
    return `
      <tr class="bond-lot-row${hl ? ' bond-hl' : ''}" data-lot="${_esc(l.id)}">
        <td class="sec-td bond-lot-name" title="${_esc(l.id)}">${_esc(l.label)}</td>
        <td class="sec-td sec-td--num">${l.principal == null ? '—' : this._money(l.principal)}</td>
        <td class="sec-td sec-td--num">${this._money(l.marketValue)}</td>
        <td class="sec-td sec-td--num">${l.costBasis == null ? '—' : this._money(l.costBasis)}</td>
        <td class="sec-td sec-td--num ${_signCls(l.costBasis == null ? null : l.marketValue - l.costBasis)}">${
          l.costBasis == null ? '—' : this._signed(l.marketValue - l.costBasis)}</td>
        <td class="sec-td sec-td--num">${_fmtCoupon(l.couponRate, l.inflationLinked, l.zeroCoupon)}</td>
        <td class="sec-td sec-td--num">${_fmtDuration(l.duration)}</td>
        <td class="sec-td sec-td--num">${maturity}</td>
        <td class="sec-td sec-td--num" colspan="2"></td>
      </tr>`;
  }

  /** The figure columns a type or account row shares. */
  _figureCells(g, { maturity = null, accounts = null } = {}) {
    const principal = g.principal == null ? '—'
      : `${this._money(g.principal)}${g.principalCoversAll ? '' : '<sup class="bond-sup" title="Dated bonds only — the fund in this group has no principal">*</sup>'}`;
    return `
        <td class="sec-td sec-td--num">${principal}</td>
        <td class="sec-td sec-td--num">${this._money(g.marketValue)}</td>
        <td class="sec-td sec-td--num">${g.costBasis == null ? '—' : this._money(g.costBasis)}</td>
        <td class="sec-td sec-td--num ${_signCls(g.unrealized)}">${this._signed(g.unrealized)}</td>
        <td class="sec-td sec-td--num">${_fmtCoupon(g.couponRate, g.couponReal, false)}</td>
        <td class="sec-td sec-td--num">${_fmtDuration(g.duration)}</td>
        <td class="sec-td sec-td--num">${maturity == null ? '—' : this._fmtDate(new Date(maturity))}</td>
        <td class="sec-td sec-td--num">${(g.share * 100).toFixed(1)}%</td>
        <td class="sec-td sec-td--num" title="${accounts == null ? '' : `${accounts} account${accounts === 1 ? '' : 's'}`}">${g.lotCount}</td>`;
  }

  _footHtml(r) {
    const t = r.total;
    // Principal DOES total (design 130 §4.2): it is money repaid, in one currency. A fund
    // has none, so the cell names what it covers rather than letting a reader assume.
    const principal = t.principal == null ? '—'
      : `${this._money(t.principal)}${t.principalCoversAll ? '' : '<sup class="bond-sup" title="Dated bonds only — funds have no principal">*</sup>'}`;
    return `
      <tr class="sec-total-row">
        <td class="sec-td">Total — ${r.types.length} type${r.types.length === 1 ? '' : 's'}</td>
        <td class="sec-td sec-td--num">${principal}</td>
        <td class="sec-td sec-td--num">${this._money(t.marketValue)}</td>
        <td class="sec-td sec-td--num">${t.costBasis == null ? '—' : this._money(t.costBasis)}</td>
        <td class="sec-td sec-td--num ${_signCls(t.unrealized)}">${this._signed(t.unrealized)}</td>
        <td class="sec-td sec-td--num" title="Nominal and real coupons mixed — a blend, not a yield">${_fmtCoupon(t.couponRate, t.couponReal, false)}</td>
        <td class="sec-td sec-td--num">${_fmtDuration(t.duration)}</td>
        <td class="sec-td sec-td--num">${t.nextMaturityMs == null ? '—' : this._fmtDate(new Date(t.nextMaturityMs))}</td>
        <td class="sec-td sec-td--num">100%</td>
        <td class="sec-td sec-td--num">${t.lotCount}</td>
      </tr>`;
  }

  _groupHasYear(g, year) {
    if (year == null) return false;
    const lots = g.lots ?? g.accounts?.flatMap(a => a.lots) ?? [];
    return lots.some(l => l.maturityMs != null && new Date(l.maturityMs).getUTCFullYear() === year);
  }

  // ─── Chart (design 130 §5) ───────────────────────────────────────────────

  _renderChart(r) {
    const ladder  = buildMaturityLadder(r.lots, { by: this._chartBy, date: this._sim?.currentDate ?? null });
    const caption = this._q('caption');
    if (caption) {
      const parts = [];
      if (ladder.undated > 0) parts.push(`undated (funds): ${this._money(ladder.undated)} — not on the ladder`);
      if (this._highlightYear != null) parts.push(`showing lots maturing in ${this._highlightYear} — click the bar again to clear`);
      if (!ladder.years.length) parts.unshift('No dated bonds — nothing matures.');
      caption.textContent = parts.join(' · ');
    }
    const host = this._q('chart');
    if (!host || !ladder.years.length || !this._canvasAvailable()) return;
    if (!this._chart) {
      this._chart = echarts.init(host, null, { renderer: 'canvas' });
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => this._chart?.resize());
        this._ro.observe(host);
      }
      this._chart.on('click', (p) => {
        const year = Number(p?.name);
        if (!Number.isFinite(year)) return;
        this._highlightYear = this._highlightYear === year ? null : year;
        this._render();
      });
    }
    this._chart.setOption(maturityLadderOption(ladder, {
      dark: this._dark(), by: this._chartBy, money: (n) => this._money(n), highlightYear: this._highlightYear,
    }), true);
  }

  _dark() {
    const theme = document.documentElement?.dataset?.theme;
    if (theme) return theme !== 'light';
    return true;
  }

  /** jsdom has no 2D canvas, and ECharts fails inside setOption rather than init. */
  _canvasAvailable() {
    if (this._hasCanvas === undefined) {
      try {
        const probe = document.createElement('canvas');
        this._hasCanvas = typeof probe.getContext === 'function' && !!probe.getContext('2d');
      } catch { this._hasCanvas = false; }
    }
    return this._hasCanvas;
  }

  // ─── CSV ─────────────────────────────────────────────────────────────────

  /** One row per lot plus ACCOUNT and TYPE totals, so every figure traces to its lots. */
  _downloadCsv() {
    const r = this._rollup();
    if (!r?.lots.length) return;
    const csv  = bondsCsv(r);
    const blob = new Blob([withBom(csv)], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `bonds-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _displayCode() {
    return this._services()?.schemaRegistry?.displayCurrencyCode?.()
      || this._runtime?.displaySettings?.displayCurrency
      || BASE_CURRENCY;
  }

  _money(n, decimals = 0) {
    if (n == null) return '—';
    const reg = this._services()?.schemaRegistry;
    const formatted = reg?.formatAmount?.(n, BASE_CURRENCY, { maximumFractionDigits: decimals, at: 'live' });
    if (formatted != null) return formatted;
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  }

  _signed(n) {
    if (n == null) return '—';
    return (n > 0 ? '+' : n < 0 ? '-' : '') + this._money(Math.abs(n));
  }

  _fmtDate(d) {
    const settings = this._runtime?.displaySettings;
    return settings?.formatDate?.(d) ?? new Date(d).toISOString().slice(0, 10);
  }

  _bindOnce(name, event, handler) {
    const el = this._q(name);
    if (!el || el._bondBound) return;
    el.addEventListener(event, () => handler(el));
    el._bondBound = true;
  }

  _q(name) { return this.el?.querySelector(`[data-bond="${name}"]`) ?? null; }
}

/** The CSV columns, in order. Money is in the rollup's base currency. */
export const BONDS_CSV_COLUMNS = Object.freeze(['scope', 'type', 'stateKey', 'account', 'lotId', 'label',
  'maturityDate', 'rolls', `principal${BASE_CURRENCY}`, `marketValue${BASE_CURRENCY}`, `costBasis${BASE_CURRENCY}`,
  'unrealized', 'couponRate', 'couponReal', 'duration', 'share', 'lotCount']);

/** @param {ReturnType<typeof rollupBonds>} r */
export function bondsCsv(r) {
  const iso = ms => (ms == null ? '' : new Date(ms).toISOString().slice(0, 10));
  const out = [];
  for (const t of r.types) {
    out.push(['TYPE', t.type, '', '', '', t.label, iso(t.nextMaturityMs), '', t.principal, t.marketValue,
      t.costBasis, t.unrealized, t.couponRate, t.couponReal, t.duration, t.share, t.lotCount]);
    for (const a of t.accounts) {
      out.push(['ACCOUNT', t.type, a.stateKey, a.name, '', '', iso(a.nextMaturityMs), '', a.principal, a.marketValue,
        a.costBasis, a.unrealized, a.couponRate, a.couponReal, a.duration, a.share, a.lotCount]);
      for (const l of a.lots) {
        out.push(['LOT', t.type, a.stateKey, a.name, l.id, l.label, iso(l.maturityMs), l.rolls, l.principal,
          l.marketValue, l.costBasis, l.costBasis == null ? null : +(l.marketValue - l.costBasis).toFixed(2),
          l.couponRate, l.inflationLinked, l.duration, '', 1]);
      }
    }
  }
  const cell = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [BONDS_CSV_COLUMNS.join(','), ...out.map(row => row.map(cell).join(','))].join('\n');
}

/**
 * The ECharts option for a maturity ladder (design 130 §5). Pure, so it is tested without a
 * canvas. Rolling principal shares its key's colour and adds a hatch: a rolling rung
 * replaces itself at maturity, a spend-down one turns into cash, and the reader has to be
 * able to tell them apart at a glance.
 *
 * @param {ReturnType<typeof buildMaturityLadder>} ladder
 * @param {{ dark?: boolean, by?: 'account'|'type', money?: (n:number)=>string, highlightYear?: number|null }} [opts]
 */
export function maturityLadderOption(ladder, { dark = true, by = 'account', money = n => String(Math.round(n)),
                                               highlightYear = null } = {}) {
  const ink  = dark ? '#94a3b8' : '#52514e';
  const line = dark ? 'rgba(148,163,184,0.15)' : 'rgba(0,0,0,0.08)';
  const keyIndex = new Map();
  for (const s of ladder.series) {
    if (!keyIndex.has(s.key)) keyIndex.set(s.key, by === 'type' ? (TYPE_INDEX[s.key] ?? keyIndex.size) : keyIndex.size);
  }
  const hatch = { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: -Math.PI / 4,
    color: dark ? 'rgba(15,23,42,0.55)' : 'rgba(255,255,255,0.6)' };
  const series = ladder.series.map(s => {
    const color = colorForSeriesKey(`bond:${s.key}`, keyIndex.get(s.key), { dark });
    return {
      name:  s.rolls ? `${s.label} (rolls)` : s.label,
      type:  'bar',
      stack: 'principal',
      emphasis: { focus: 'series' },
      itemStyle: { color, ...(s.rolls ? { decal: hatch } : {}) },
      data: s.values.map((v, i) => ({
        value: v,
        ...(highlightYear != null && ladder.years[i] !== highlightYear ? { itemStyle: { opacity: 0.35 } } : {}),
      })),
    };
  });
  return {
    aria: { enabled: true, decal: { show: false } },
    animation: false,
    textStyle: { color: ink, fontFamily: 'var(--font-mono, monospace)' },
    grid: { left: 64, right: 16, top: 28, bottom: 24 },
    legend: { type: 'scroll', top: 0, textStyle: { color: ink, fontSize: 10 } },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      valueFormatter: v => money(v),
    },
    xAxis: {
      type: 'category', data: ladder.years.map(String),
      axisLine: { lineStyle: { color: line } }, axisLabel: { color: ink, fontSize: 10 },
    },
    yAxis: {
      type: 'value', splitLine: { lineStyle: { color: line } },
      axisLabel: { color: ink, fontSize: 10, formatter: v => money(v) },
    },
    series,
  };
}

function _fmtCoupon(rate, real, zero) {
  if (zero) return 'zero';
  if (rate == null) return '—';
  return `${(rate * 100).toFixed(2)}%${real ? ' real' : ''}`;
}

function _fmtDuration(d) {
  return d == null ? '—' : `${d.toFixed(1)}y`;
}

function _signCls(n) {
  if (n == null || n === 0) return '';
  return n > 0 ? 'sec-pos' : 'sec-neg';
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
