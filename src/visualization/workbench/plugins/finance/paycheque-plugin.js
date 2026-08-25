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
import {
  listPaycheques, buildPaycheque, buildContributionsByYear, buildSuperCapRows, monthKeyOf,
} from '../../../../finance/payroll/paycheque-report.js';

/**
 * PaychequePlugin — design 95 §17 phase 10, gaps G4/G5/G6.
 *
 * Design 95's organising idea is §5's four-stage pipeline — pre-tax/sacrificed →
 * statutory withholding → after-tax payroll → net split across accounts — and
 * nothing anywhere showed a single month of it. **One earner, one month, gross down
 * to net.** Everything it needs already rides on the actions, so it is assembly:
 * `paycheque-report.js` re-derives nothing, and this panel draws what that returns.
 *
 * Three views, which are the three things the design shipped and could not surface:
 *
 *   - **Payslip** (G4) — the pipeline for one person-month, each stage a reduction
 *     from the one above, plus where the net landed and what the employer added
 *     beside it.
 *   - **Contributions** (G5/U4) — every year's contributions per person and stream,
 *     **with the clamps as a column**. D8's promise was that a contribution stopped
 *     by a cap should be "visible in the output rather than inferred from a number
 *     being lower than expected"; that promise is only kept when the year that
 *     clamped says so where the contributions are shown.
 *   - **Super caps** (G6) — the `auSuperCapsByPerson` record as a table: the
 *     five-year unused-cap ring, the TSB snapshot that gates it and the Div 292
 *     bring-forward. The ATO publishes this as a table and so should the model.
 *
 * ─── it follows the cursor, which is why it is a panel ───────────────────────
 *
 * §17.3 U3. The payslip's month tracks the run: stepping the simulation advances it,
 * and a modal could not do that. It subscribes to the per-run sim bus exactly as
 * `SpendingPlugin` does — `WB_EVENTS.RUNTIME_TICK` is never emitted, and one
 * completed EVENT is one perceived step.
 *
 * ─── it presents; it does not compute ────────────────────────────────────────
 *
 * U5: this phase changes no number. Every figure is read off a journalled action or
 * off state; nothing here applies a rate, a cap or a currency conversion. A payslip
 * that recomputed its own withholding could disagree with the run it claims to show,
 * and nothing would say which was right.
 */
export class PaychequePlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime = runtime;
    this._sim     = null;
    this._servicesOverride = null;   // tests

    this._view       = 'payslip';    // payslip | contributions | caps
    this._personKey  = null;         // null ⇒ follow the run (the latest earner)
    this._monthKey   = null;         // null ⇒ follow the run (the latest month)
    this._follow     = true;         // the cursor owns the month until the user picks one

    this._unsubSimBus  = null;
    this._renderQueued = false;
    this._dataSig      = null;
    this._listCache    = null;
  }

  setServices(services) { this._servicesOverride = services ?? null; }
  _services() { return this._servicesOverride ?? ServiceRegistry.getInstance(); }

  render() {
    const root = document.createElement('div');
    root.className = 'pay-plugin wb-plugin-fill';
    root.innerHTML = `
      <div class="pay-toolbar">
        <select class="wb-select pay-view" data-pay="view">
          <option value="payslip">Payslip</option>
          <option value="contributions">Contributions by year</option>
          <option value="caps">AU super caps</option>
        </select>
        <select class="wb-select pay-person" data-pay="person"></select>
        <select class="wb-select pay-month"  data-pay="month"></select>
        <button class="pay-follow-btn" data-pay="follow"
                title="Follow the simulation cursor — the payslip advances as the run steps">follow</button>
        <span class="pay-spacer"></span>
        <span class="pay-asof" data-pay="asof">—</span>
        <button class="pay-csv-btn" data-pay="csv" title="Download the contribution rollup as CSV">&#11015; CSV</button>
      </div>

      <div class="pay-body" data-pay="body">
        <div class="pay-placeholder" data-pay="placeholder">
          Step or run the simulation to see a paycheque.
        </div>
        <div class="pay-content" data-pay="content"></div>
      </div>
    `;
    return root;
  }

  onInit() {
    this._runtime.bus.subscribe(WB_EVENTS.SCENARIO_READY, ({ scenario }) => {
      this._bindSim(scenario?.sim ?? null);
    });
    this._runtime.bus.subscribe(WB_EVENTS.DISPLAY_SETTINGS_CHANGED, () => this._render());
  }

  onMount() {
    // Late-mount: the scenario is usually built before this panel first mounts.
    if (!this._sim) this._bindSim(this._services()?.simulationRegistry?.getPrimary?.() ?? null);

    this._bindOnce('view',   'change', (el) => { this._view = el.value; this._syncControls(); this._render(); });
    this._bindOnce('person', 'change', (el) => { this._personKey = el.value || null; this._follow = false; this._render(); });
    this._bindOnce('month',  'change', (el) => { this._monthKey  = el.value || null; this._follow = false; this._render(); });
    this._bindOnce('follow', 'click',  () => { this._follow = true; this._personKey = null; this._monthKey = null; this._render(); });
    this._bindOnce('csv',    'click',  () => this._downloadCsv());

    this._syncControls();
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
    this._listCache = null;
    this._dataSig   = null;

    if (sim?.bus) {
      this._unsubSimBus = sim.bus.subscribe(
        `EXECUTION_${EXECUTION_PHASES.END}`,
        { kind: EXECUTION_KINDS.EVENT },
        () => this._scheduleRender(),
      );
    }
    if (this._mounted) { this._syncControls(); this._render(); }
  }

  _scheduleRender() {
    if (!this._mounted || this._renderQueued) return;
    this._renderQueued = true;
    const run = () => { this._renderQueued = false; if (this._mounted) this._render(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  /** Journal signature — the same "has the run actually moved" test the other panels use. */
  _signature() {
    const entries = this._sim?.journal?.journal;
    if (!Array.isArray(entries) || entries.length === 0) return 'empty';
    const last = entries[entries.length - 1];
    return `${entries.length}|${last?.seq ?? 0}`;
  }

  /** Every (person, month) the run has paid, rebuilt only when the journal moved. */
  _list() {
    const sig = this._signature();
    if (sig === this._dataSig && this._listCache) return this._listCache;
    this._dataSig   = sig;
    this._listCache = sig === 'empty'
      ? [] : listPaycheques(this._sim.journal, this._sim.state);
    return this._listCache;
  }

  /**
   * The person-month being shown.
   *
   * While following, it is the LATEST paycheque in the journal — which is what makes
   * the panel track the cursor as the run steps. A user selection pins both and
   * turns following off; the follow button puts it back.
   */
  _selection() {
    const list = this._list();
    if (list.length === 0) return null;
    if (this._follow) return list[list.length - 1];

    const person = this._personKey ?? list[list.length - 1].personKey;
    // Prefer the chosen month FOR THE CHOSEN PERSON: switching earners while a month
    // is pinned should show that earner's payslip for it, and fall back to their
    // latest rather than to nothing when they were not paid that month.
    const theirs = list.filter(r => r.personKey === person);
    if (theirs.length === 0) return list[list.length - 1];
    return theirs.find(r => r.monthKey === this._monthKey) ?? theirs[theirs.length - 1];
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  _syncControls() {
    const view = this._q('view');
    if (view) view.value = this._view;
    // The person/month pickers belong to the payslip; the other two views are whole-run.
    const showPicker = this._view === 'payslip';
    for (const name of ['person', 'month', 'follow']) {
      const el = this._q(name);
      if (el) el.style.display = showPicker ? '' : 'none';
    }
    const csv = this._q('csv');
    if (csv) csv.style.display = this._view === 'contributions' ? '' : 'none';
  }

  _render() {
    if (!this._mounted) return;
    this._syncControls();

    const content     = this._q('content');
    const placeholder = this._q('placeholder');
    if (!content || !placeholder) return;

    if (!this._sim) {
      placeholder.textContent = 'No simulation is loaded.';
      placeholder.style.display = '';
      content.style.display = 'none';
      content.innerHTML = '';
      this._q('asof').textContent = '—';
      return;
    }

    const html = this._view === 'caps'          ? this._capsHtml()
               : this._view === 'contributions' ? this._contributionsHtml()
               :                                  this._payslipHtml();

    if (html == null) {
      placeholder.textContent = this._emptyText();
      placeholder.style.display = '';
      content.style.display = 'none';
      content.innerHTML = '';
      return;
    }
    placeholder.style.display = 'none';
    content.style.display = '';
    content.innerHTML = html;
  }

  _emptyText() {
    if (this._view === 'caps') {
      // An absent cap record is not an error: a scenario with no AU super has none.
      return 'This scenario has no Australian superannuation, so there are no Div 291/292 caps to show.';
    }
    if (this._view === 'contributions') {
      return 'No payroll contributions have been made yet. Step or run the simulation, '
           + 'or set a contribution election on a person or in the scenario parameters.';
    }
    return 'No wages have been paid yet. Step or run the simulation.';
  }

  // ─── Payslip (G4) ────────────────────────────────────────────────────────

  _payslipHtml() {
    const sel = this._selection();
    this._fillPickers(sel);
    if (!sel) { this._q('asof').textContent = '—'; return null; }

    const p = buildPaycheque({
      journal: this._sim.journal, state: this._sim.state,
      personKey: sel.personKey, monthKey: sel.monthKey,
    });
    if (!p) { this._q('asof').textContent = '—'; return null; }

    this._q('asof').textContent = `${p.name} · ${p.monthKey}`;
    const btn = this._q('follow');
    if (btn) btn.classList.toggle('on', this._follow);

    const m = (n) => this._money(n, p.currency);

    // Each stage is a reduction from the one above, which is the only presentation
    // in which §5's four-way asymmetry is visible: sacrifice comes off the package,
    // withholding off the assessable wage, and the member's own contributions off
    // the cash that actually arrived.
    const rows = [];
    rows.push(_line('Salary package', m(p.salaryPackage), 'pay-total'));
    if (p.sacrificed > 0) {
      rows.push(_line('less Salary sacrifice', `− ${m(p.sacrificed)}`, 'pay-less',
        'Pre-tax, into super. Never reaches the member\'s cash, and reduces PAYG '
        + 'but NOT the Super Guarantee (SGAA s10A(1)(h)).'));
      rows.push(_line(p.selfEmployed ? 'Assessable income' : 'Assessable wage',
        m(p.assessable), 'pay-sub'));
    }
    if (p.withheld > 0) {
      rows.push(_line('less Withheld (FICA)', `− ${m(p.withheld)}`, 'pay-less',
        'Social Security and Medicare, withheld exactly. A 401(k) deferral does NOT '
        + 'reduce it — §3121(a) has no §402(g) exclusion.'));
    }
    rows.push(_line('Net pay credited', m(p.netPay), 'pay-sub'));

    for (const r of p.member) {
      const into = this._accountName(r.stateKey);
      rows.push(_line(`less ${r.label}`, `− ${m(r.amount)}`, 'pay-less',
        r.stateKey ? `Paid from cash into ${into}.` : null, r.clamps));
    }
    rows.push(_line('Take-home after payroll', m(p.takeHome), 'pay-total'));

    const sections = [`<div class="pay-slip">${rows.join('')}</div>`];

    // Where the net landed. With no splits the whole credit went to one account and
    // saying so is more useful than an empty section.
    const splitRows = p.splits.length > 0
      ? p.splits.map(s => _line(this._accountName(s.targetKey), m(s.amount), 'pay-split')).join('')
      : _line(this._accountName(p.fallbackKey), m(p.netPay), 'pay-split',
              'No direct deposit is set, so the whole credit goes to the transaction account.');
    sections.push(_section('Where the pay landed', `<div class="pay-slip">${splitRows}</div>`));

    if (p.employer.length > 0) {
      const empRows = p.employer.map(r => _line(r.label, m(r.amount), 'pay-employer',
        'Employer-funded: it never passed through this paycheque, so it neither '
        + 'reduces take-home nor is it the member\'s deduction.', r.clamps)).join('');
      sections.push(_section(
        `Employer contributions <span class="pay-note">(beside the pay, not out of it)</span>`,
        `<div class="pay-slip">${empRows}${_line('Total', m(p.employerTotal), 'pay-total')}</div>`));
    }

    if (p.clamps.length > 0 || p.carriedForward > 0) {
      const notes = [];
      for (const c of p.clamps) {
        notes.push(`<li class="pay-clamp"><span class="pay-badge pay-badge-clamp">clamped</span> ${_esc(c)}</li>`);
      }
      if (p.carriedForward > 0) {
        // Relief, not restriction — the distinction §13.9 records, because pushing it
        // onto `clamps` made 363 actions announce a concession as a stoppage.
        notes.push(`<li class="pay-clamp"><span class="pay-badge pay-badge-relief">carry-forward</span> `
          + `${m(p.carriedForward)} of unused concessional cap released (s291-20)</li>`);
      }
      sections.push(_section('This month', `<ul class="pay-clamps">${notes.join('')}</ul>`));
    }

    return sections.join('');
  }

  _fillPickers(sel) {
    const list   = this._list();
    const person = this._q('person');
    const month  = this._q('month');
    if (!person || !month) return;

    const people = [...new Map(list.map(r => [r.personKey, r.name])).entries()];
    person.innerHTML = people.map(([key, name]) =>
      `<option value="${_esc(key)}">${_esc(name)}</option>`).join('');
    if (sel) person.value = sel.personKey;

    const months = list.filter(r => !sel || r.personKey === sel.personKey).map(r => r.monthKey);
    month.innerHTML = months.map(k => `<option value="${_esc(k)}">${_esc(k)}</option>`).join('');
    if (sel) month.value = sel.monthKey;
  }

  // ─── Contributions by year (G5) ──────────────────────────────────────────

  _contributionsHtml() {
    const cube = this._contributions();
    if (!cube || cube.rows.length === 0) { this._q('asof').textContent = '—'; return null; }

    this._q('asof').textContent = cube.years.length
      ? `${cube.years[0]}–${cube.years[cube.years.length - 1]} · ${cube.rows.length} rows`
      : '—';

    const body = cube.rows.map(r => `
      <tr>
        <td title="${r.periodBasis === 'financialYear'
          ? 'Australian financial year (1 July \u2013 30 June). The Div 291/292 caps and the s10A(5) base are annual figures on THIS year, not the calendar one.'
          : 'Calendar year \u2014 the individual\'s US taxable year, which is what \u00a7402(g) and \u00a7415(c) are measured against.'}">${_esc(r.period ?? r.year)}</td>
        <td>${_esc(r.name)}</td>
        <td>${_esc(r.label)}</td>
        <td class="pay-cell-${r.funded}">${r.funded}</td>
        <td class="pay-num">${this._money(r.amount, r.country === 'AU' ? 'AUD' : 'USD')}</td>
        <td class="pay-num">${r.months}</td>
        <td>${r.clamps.map(c =>
          `<span class="pay-badge pay-badge-clamp" title="A cap stopped this contribution in at least one month of ${_esc(r.period ?? r.year)}">${_esc(c)}</span>`).join(' ')}</td>
        <td class="pay-num">${r.carriedForward > 0 ? this._money(r.carriedForward, 'AUD') : ''}</td>
      </tr>`).join('');

    return `
      <table class="pay-table">
        <thead><tr>
          <th title="Each stream's own year: calendar for the US, Australian financial year for super. Every cap in the Clamped by column is annual on that basis.">Year</th><th>Person</th><th>Stream</th><th>Funded by</th>
          <th class="pay-num">Amount</th><th class="pay-num">Months</th>
          <th>Clamped by</th><th class="pay-num">Carry-forward</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  _contributions() {
    if (!this._sim?.journal) return null;
    return buildContributionsByYear({ journal: this._sim.journal, state: this._sim.state });
  }

  // ─── AU super caps (G6) ──────────────────────────────────────────────────

  _capsHtml() {
    const rows = buildSuperCapRows(this._sim?.state);
    if (rows.length === 0) { this._q('asof').textContent = '—'; return null; }
    this._q('asof').textContent = `${rows.length} member${rows.length === 1 ? '' : 's'}`;

    const m = (n) => n == null ? '—' : this._money(n, 'AUD');
    return rows.map(r => {
      const ring = r.unusedByFy.length === 0
        ? '<div class="pay-note">No unused concessional cap has accrued yet.</div>'
        : `<table class="pay-table pay-table-tight">
             <thead><tr><th>Financial year</th><th class="pay-num">Unused cap</th></tr></thead>
             <tbody>${r.unusedByFy.map(u =>
               `<tr><td>${u.fy}–${String(u.fy + 1).slice(2)}</td><td class="pay-num">${m(u.amount)}</td></tr>`).join('')}
             </tbody>
           </table>`;
      // The TSB is what GATES the ring, and it is retested at the start of every
      // financial year — a member over the threshold one year and under it the next
      // gets the whole balance back (s291-20(3)(b)). Saying so beside the figure is
      // the difference between a number and a rule.
      const tsb = r.tsbAtFyStart == null ? '—' : m(r.tsbAtFyStart);
      const bf  = r.bringForward
        ? `<code>${_esc(JSON.stringify(r.bringForward))}</code>`
        : '<span class="pay-note">none active</span>';

      return _section(_esc(r.name), `
        <div class="pay-kv">
          <div><span>Concessional this FY</span><b>${m(r.concessionalYTD)}</b></div>
          <div><span>of which Super Guarantee</span><b>${m(r.sgYTD)}</b></div>
          <div><span>Non-concessional this FY</span><b>${m(r.nonConcessionalYTD)}</b></div>
          <div><span>Qualifying earnings this FY</span><b>${m(r.qualifyingEarningsYTD)}</b></div>
          <div><span title="Total super balance just before the start of this financial year. Retested EVERY year (s291-20(3)(b)) — over the threshold once does not destroy accrued cap.">Total super balance at FY start</span><b>${tsb}</b></div>
          <div><span title="Div 292 bring-forward arrangement, once triggered.">Bring-forward</span><b>${bf}</b></div>
        </div>
        <div class="pay-subhead">Unused concessional cap available to carry forward (s291-20)</div>
        ${ring}`);
    }).join('');
  }

  // ─── CSV / helpers ───────────────────────────────────────────────────────

  _downloadCsv() {
    const cube = this._contributions();
    if (!cube?.rows?.length) return;
    // `periodBasis` rides in the CSV because a spreadsheet full of AU rows keyed by
    // financial year and US rows keyed by calendar year is unreadable without it.
    const cols = ['period', 'periodBasis', 'year', 'name', 'personKey', 'label', 'type',
                  'funded', 'country', 'amount', 'months', 'clamps', 'carriedForward'];
    const cell = (v) => {
      if (v == null) return '';
      const s = Array.isArray(v) ? v.join('; ') : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...cube.rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
    const blob = new Blob([withBom(csv)], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `payroll-contributions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * An account's display name.
   *
   * Runtime account state carries `stateKey` but NOT `name` — the label lives in the
   * StateSchemaRegistry (design 70), which is exactly why it is asked for here rather
   * than read off state. Falling back to the raw key would print `usStockAccount` at
   * a user, which is the string design 70 exists to stop showing.
   */
  _accountName(stateKey) {
    if (stateKey == null) return 'Transaction account';
    const reg = this._services()?.schemaRegistry;
    return reg?.displayNameFor?.(stateKey) ?? this._sim?.state?.[stateKey]?.name ?? stateKey;
  }

  _money(n, code = 'USD') {
    if (n == null) return '—';
    const reg = this._services()?.schemaRegistry;
    const formatted = reg?.formatAmount?.(n, code);
    if (formatted != null) return formatted;
    return `${code === 'AUD' ? 'A$' : '$'}${Math.round(n).toLocaleString()}`;
  }

  _bindOnce(name, event, handler, rawHandler = null) {
    const el = this._q(name);
    if (!el || el._payBound) return;
    el.addEventListener(event, rawHandler ?? (() => handler(el)));
    el._payBound = true;
  }

  _q(name) { return this.el?.querySelector(`[data-pay="${name}"]`) ?? null; }
}

/** One payslip line. `clamps` renders inline, so a stopped line says why on the line. */
function _line(label, value, cls = '', title = null, clamps = []) {
  const badges = (clamps ?? []).map(c =>
    `<span class="pay-badge pay-badge-clamp" title="This is what stopped it">${_esc(c)}</span>`).join(' ');
  return `<div class="pay-row ${cls}"${title ? ` title="${_esc(title)}"` : ''}>`
       + `<span class="pay-label">${_esc(label)} ${badges}</span>`
       + `<span class="pay-value">${value}</span></div>`;
}

function _section(heading, inner) {
  return `<div class="pay-section"><div class="pay-heading">${heading}</div>${inner}</div>`;
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export { monthKeyOf };
