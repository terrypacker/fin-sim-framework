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
import { buildAllocationSeries, mixAt } from '../../../../finance/allocation-reporting/allocation-grouping.js';
import { createAllocationSampler, summarizeSamples, samplesToRows, samplesToTargetRows, lastYearEndIndex } from '../../../../finance/allocation-reporting/allocation-sampler.js';
import { targetedStateKeys, driftAgainstTarget } from '../../../../finance/allocation-reporting/target-cube.js';
import { colorForSeriesKey }  from '../../../../finance/allocation-reporting/allocation-palette.js';
import { ASSET_CLASS, ASSET_CLASS_VALUES } from '../../../../finance/allocation-reporting/asset-class.js';
import { groupKey }           from '../../../../finance/reporting-common/series-keys.js';
import { MapFilterMultiSelect } from '../../../components/map-filter-multi-select.js';
import { QueryApi }            from '../../../../query/query-api.js';

/**
 * The cube columns the panel exports, in order.
 *
 * A named constant rather than an inline array because it is the fact table's contract:
 * a column that exists on the row and not here is a number nobody can trace back to the
 * lot it came from, and that is invisible to any test that only looks at the chart.
 */
export const ALLOCATION_CSV_COLUMNS = Object.freeze([
  'date', 'stateKey', 'name', 'source', 'kind', 'role', 'type',
  'domicileCountry', 'exposureCountry', 'currency', 'assetClass', 'allocation',
  // design 94 step 9 — the instrument, and the position's size in it.
  'rateKey', 'securityId', 'security', 'units', 'holdingCount',
  'marketValueLocal', 'marketValue', 'costBasisLocal', 'costBasis', 'inferred',
]);

/**
 * AllocationPlugin — the realized asset mix over the whole plan (design 82 §6).
 *
 * The over-time sibling of HoldingsPlugin, which answers "what is in this account
 * right now". This answers the question a net-worth line hides: **is the portfolio's
 * shape being chosen, or is it whatever the drawdown order left behind?**
 *
 * ─── it is a new KIND of report, and that shapes the code ─────────────────────
 *
 * Every ReportDefinition in the registry is journal-derived and table-only — an AST
 * over journal rows, rendered as grouped rows with aggregates. This is neither:
 * holdings are a STATE shape (the journal carries only their diffs), and the answer is
 * a chart. So it is a sibling of ReportDefinition, not a subclass; forcing it through
 * `buildQuery` would mean fighting the journal abstraction to reconstruct a balance
 * that can be read directly. Revisit the abstraction at the SECOND chart-bearing
 * report — one is not evidence.
 *
 * ─── where the numbers come from ─────────────────────────────────────────────
 *
 * Nothing here samples, steps or pivots on its own:
 *
 *   - the RUN samples itself, at year boundaries, via the sampler installed in
 *     workbench-app (design 82 §4). This panel never re-steps the primary sim, so it
 *     cannot disturb playback — it reads `sim.samples`.
 *   - every share comes from `buildAllocationSeries`, the same module the lab report
 *     uses. The moment a view grows its own pivot the two can disagree about a share
 *     with no way to tell which is right.
 *
 * ─── it states the tie-out before it draws ───────────────────────────────────
 *
 * Σ cube rows === computeNetWorth (design 82 §3) is what makes any share quotable: a
 * denominator missing an asset misstates EVERY slice, not just the missing one. The lab
 * page leads with that check and so does this panel — a UI that silently omits a class
 * is worse than a page doing it, because nobody diffs a panel against a CSV.
 */
export class AllocationPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime  = runtime;
    this._sim      = null;
    this._servicesOverride = null;   // tests

    this._view      = 'total';       // total | target | domicile | exposure | account | rateKey | role
    this._mode      = 'pct';         // pct (share) | abs (currency)
    this._withDebt  = false;         // total only: include LIABILITY (net-worth decomposition)
    // WHERE: the accounts in scope. EMPTY means every account, on the same terms as the
    // class scope — "no filter" and "all of them" are one statement.
    this._stateKeys = new Set();
    // WHAT: the classes in scope. EMPTY means every class — "no filter" and "all of
    // them" are the same statement, and a set that empties itself to mean nothing would
    // give the reader a way to blank the panel with no way back.
    this._assetClasses = new Set();

    this._chart        = null;
    this._unsubSimBus  = null;
    this._renderQueued = false;
    this._dataSig      = null;       // samples signature the caches were built from
    this._hidden       = new Set();   // legend chips the user switched off
    this._rowsCache    = null;
    this._targetsCache = null;
    this._accountsSig  = null;
    this._classesSig   = null;
    this._classSelect   = null;  // MapFilterMultiSelect, built on first render with data
    this._classItems    = [];    // its live option list (see _renderClassPicker)
    this._accountSelect = null;
    this._accountItems  = [];
    this._live         = null;   // opening-state record, before the run has sampled
    this._liveSig      = null;
    this._isLive       = false;  // true while the panel is reading _live, not sim.samples
  }

  setServices(services) { this._servicesOverride = services ?? null; }
  _services() { return this._servicesOverride ?? ServiceRegistry.getInstance(); }

  render() {
    const root = document.createElement('div');
    root.className = 'alloc-plugin wb-plugin-fill';
    root.innerHTML = `
      <div class="alloc-toolbar">
        <select class="wb-select alloc-view" data-alloc="view">
          <option value="total">Total</option>
          <option value="target">Target vs actual</option>
          <option value="domicile">By country (wrapper)</option>
          <option value="exposure">By country (exposure)</option>
          <option value="account">By account</option>
          <option value="rateKey">By return series</option>
          <option value="security">By security</option>
          <option value="role">By wrapper</option>
        </select>
        <span class="alloc-account" data-alloc="account" style="display:none"
              title="Scope the view to one or more accounts"></span>
        <span class="alloc-class" data-alloc="class"
              title="Narrow every view to one or more asset classes"></span>
        <span class="alloc-seg" data-alloc="mode">
          <button type="button" data-mode="pct" class="on">share</button>
          <button type="button" data-mode="abs">$</button>
        </span>
        <label class="alloc-toggle" data-alloc="debt-wrap">
          <input type="checkbox" data-alloc="debt"> with debt
        </label>
        <span class="alloc-spacer"></span>
        <span class="alloc-asof" data-alloc="asof">—</span>
        <button class="alloc-csv-btn" data-alloc="csv" title="Download the cube as CSV">&#11015; CSV</button>
      </div>

      <div class="alloc-provenance" data-alloc="provenance"></div>

      <div class="alloc-body" data-alloc="body">
        <div class="alloc-placeholder" data-alloc="placeholder">
          Step or run the simulation to sample the allocation.
        </div>
        <div class="alloc-chart" data-alloc="chart"></div>
      </div>

      <div class="alloc-mixbar" data-alloc="mixbar"></div>
    `;
    return root;
  }

  onInit() {
    this._runtime.bus.subscribe(WB_EVENTS.SCENARIO_READY, ({ scenario }) => {
      this._bindSim(scenario?.sim ?? null);
    });
    this._runtime.bus.subscribe(WB_EVENTS.DISPLAY_SETTINGS_CHANGED, () => this._render());
    this._onResize = () => this._chart?.resize();
    window.addEventListener('resize', this._onResize);
  }

  onMount() {
    // Late-mount: the scenario is usually built before this panel first mounts.
    if (!this._sim) this._bindSim(this._services()?.simulationRegistry?.getPrimary?.() ?? null);

    // Each of these changes the keyspace the chips name — `EQUITY` becomes `US · EQUITY`
    // becomes an account name — so a carried-over selection would filter the wrong thing,
    // or nothing at all.
    this._bindOnce('view',    'change', (el) => {
      this._view = el.value; this._hidden.clear(); this._syncControls(); this._render();
    });
    this._bindOnce('debt',    'change', (el) => { this._withDebt = el.checked; this._render(); });
    this._bindOnce('csv',     'click',  () => this._downloadCsv());
    this._bindOnce('mixbar',  'click',  null, (e) => this._onMixBarClick(e));

    const seg = this._q('mode');
    if (seg && !seg._allocBound) {
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-mode]');
        if (!btn) return;
        this._mode = btn.dataset.mode;
        seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
        this._render();
      });
      seg._allocBound = true;
    }

    this._syncControls();
    this._render();
  }

  onActivate() {
    // The chart cannot size itself while the pane is hidden, so a panel activated
    // after a run comes up 0px tall without this.
    this._chart?.resize();
    this._render();
  }

  onAdopt() { this._chart?.resize(); }

  onUnmount() {
    // ECharts holds a canvas and this panel holds a ResizeObserver; a docked panel can be
    // unmounted and remounted many times a session, and leaking one pair per remount is
    // how a long session turns slow.
    this._disposeChart();
    this._classSelect?.close();
    this._accountSelect?.close();
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
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
    this._invalidate();

    if (sim?.bus) {
      // Samples only appear as the run advances, so the panel fills in during
      // playback. One completed EVENT is one perceived step; coalesce the burst into
      // a single rAF render.
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

  _invalidate() {
    this._dataSig = null;
    this._live = null;
    this._liveSig = null;
    this._rowsCache = null;
    this._targetsCache = null;
    this._accountsSig = null;
    this._classesSig = null;
  }

  /**
   * Signature of the data being read. The LAST sample is upserted on every `stepTo`
   * (design 82 §5.1b keeps a partial year current), so a count alone would miss the
   * most-changing point on the chart; the last record's instant catches it.
   */
  _signature() {
    const records = this._records();
    if (records.length === 0) return 'empty';
    const last = records[records.length - 1];
    return `${this._isLive ? 'live' : records.length}|${last?.at?.getTime?.() ?? 0}` +
           `|${Math.round(last?.netWorth ?? 0)}`;
  }

  _samples() {
    const samples = this._sim?.samples;
    // A sim built without the allocation sampler (a test harness, an older saved
    // session) yields records with no `rows` — treat them as no data rather than
    // throwing deep inside the pivot.
    return Array.isArray(samples) ? samples.filter(s => Array.isArray(s?.rows)) : [];
  }

  /**
   * What the panel reads: the run's own samples, or — before the run has produced any —
   * ONE record read off live state.
   *
   * The opening state is a real, answerable question ("what does this plan start as?"),
   * and until now the panel had no answer to it: the first sample is only written once
   * the clock has moved, so a freshly loaded scenario showed a placeholder telling the
   * reader to go and step the sim. A doughnut of the opening mix is the honest picture,
   * and it needs no time axis, so nothing about it has to wait for a second point.
   *
   * Two rules keep this from becoming a second, disagreeing source of truth:
   *
   *   - it is built by `createAllocationSampler`, the SAME function the run installs, so
   *     the opening record and every later sample carry identical contents and the same
   *     tie-out. A hand-rolled cube here could disagree with the chart it turns into.
   *   - it is READ-ONLY and it is discarded the instant the run files a sample of its
   *     own. The panel still never steps the primary sim (design 82 §6) — it reads the
   *     state that is already there.
   */
  _records() {
    const samples = this._samples();
    if (samples.length) {
      this._isLive = false;
      this._live = null;
      this._liveSig = null;
      return samples;
    }
    this._isLive = true;
    const live = this._liveRecord();
    return live ? [live] : [];
  }

  /**
   * The opening state as one sampler record, cached against the run's own progress.
   *
   * `eventExecutions` is in the key because the state moves during the very first
   * `stepTo` — every completed event re-renders this panel — and a record cached on the
   * date alone would freeze the opening mix while the clock sat inside its first year.
   */
  _liveRecord() {
    const sim = this._sim;
    if (!sim?.state) return null;
    const sig = `${sim.currentDate?.getTime?.() ?? 0}|${sim.eventExecutions ?? 0}`;
    if (sig === this._liveSig && this._live) return this._live;
    this._liveSig = sig;
    try {
      const sample = createAllocationSampler({
        displayNameFor: (stateKey) => this._services()?.schemaRegistry?.displayNameFor?.(stateKey) ?? null,
      });
      this._live = sample(sim.state, sim.currentDate ?? new Date());
    } catch (e) {
      // A scenario that fails to cube is a bug worth seeing in the console, but it must
      // not take the panel — or the workbench boot that mounts it — down with it.
      console.warn('[AllocationPlugin] could not read the opening state', e);
      this._live = null;
    }
    return this._live;
  }

  /** Cube rows for every sample, rebuilt only when the run has actually moved. */
  _rows() {
    this._refreshCaches();
    return this._rowsCache;
  }

  /** Target rows for every sample (design 82 §7); empty when nothing sets a target. */
  _targetRows() {
    this._refreshCaches();
    return this._targetsCache;
  }

  _refreshCaches() {
    const sig = this._signature();
    if (sig === this._dataSig && this._rowsCache) return;
    const samples      = this._records();
    this._rowsCache    = samplesToRows(samples);
    this._targetsCache = samplesToTargetRows(samples);
    this._dataSig      = sig;
  }

  // ─── Views ───────────────────────────────────────────────────────────────

  /** Pivot options for the active view, BEFORE the reader's two interactive filters. */
  _viewOpts() {
    const normalize = this._mode === 'pct';
    switch (this._view) {
      case 'domicile': return { by: ['domicileCountry', 'assetClass'], normalize };
      case 'exposure': return { by: ['exposureCountry', 'assetClass'], normalize };
      case 'role':     return { by: ['role'], normalize };
      // Rows WITHOUT a return series (a house, a company stake, a collectible) would
      // collapse into one enormous `(none)` band that says nothing and buries the
      // diagnostic. They are covered by every other view.
      case 'rateKey':  return { by: ['rateKey'], filter: r => r.rateKey != null, normalize };
      // Design 94 §3 item 6 / step 9. The one view that answers "what do I actually
      // OWN", as against "what market am I exposed to" — which is the same question
      // only until a plan holds one employer's stock instead of a total-market fund.
      //
      // Filtered like `rateKey` and for the same reason: a house, a company stake and a
      // cash sleeve name no instrument, and collapsing them into one `(none)` band buries
      // the diagnostic under the plan's largest number. They are covered by every other
      // view. In a book with no authored securities every equity bucket reads
      // `sec-auto-<MARKET>`, so this view degrades to the return-series view rather than
      // to noise — which is the honest answer for a plan that holds index sleeves.
      case 'security': return { by: ['security'], filter: r => r.securityId != null, normalize };
      // Picking accounts is a drill-down, and the grouping follows it: ONE account and
      // the question is what is inside it (by class); several — or none, meaning all —
      // and the question is how they compare (by account). Grouping several accounts by
      // class instead would merge them into a single mix and lose the comparison the
      // reader just asked for by selecting more than one.
      case 'account':  return this._stateKeys.size === 1
        ? { filter: r => this._stateKeys.has(r.stateKey), normalize }
        : this._stateKeys.size
          ? { by: ['name'], filter: r => this._stateKeys.has(r.stateKey), normalize }
          : { by: ['name'], normalize };
      default:         return { normalize, excludeLiabilities: !this._withDebt };
    }
  }

  /**
   * The view's pivot, narrowed by the two things the reader can turn:
   *
   *   - the asset-class scope (**what**) — one class or several, and it survives a view
   *     change, so any view can be asked "…of my equity, and my gold". This is what
   *     turns `By account` from "how big is each account" into "where does this class
   *     actually live", without a second pivot.
   *   - the legend chips (**which categories count**), cleared whenever the keyspace
   *     changes underneath them.
   *
   * Both are ROW filters, deliberately, and NOT an ECharts `legendUnSelect`. Hiding a
   * band leaves it in the 100% denominator: the remaining shares stop summing to 100 and
   * stop being shares of anything nameable. Filtering the fact table instead
   * re-normalises against what is left, which is the question actually being asked —
   * "of the categories I kept, what is the mix?" — and it is the same reduction the CSV
   * and the lab report run, so the two cannot disagree about a share.
   *
   * @param {object}  [o]
   * @param {boolean} [o.withHidden=true] false yields the FULL key set for this scope.
   *        The legend must keep listing a chip that is switched off, or there is no way
   *        to switch it back on.
   */
  _seriesOpts({ withHidden = true } = {}) {
    const base  = this._viewOpts();
    const dims  = base.by ?? ['assetClass'];
    const preds = [];
    if (base.filter) preds.push(base.filter);
    if (this._assetClasses.size) preds.push(r => this._assetClasses.has(r.assetClass));
    if (withHidden && this._hidden.size) preds.push(r => !this._hidden.has(groupKey(r, dims)));
    if (preds.length === 0) return base;
    return { ...base, filter: r => preds.every(p => p(r)) };
  }

  /**
   * Realized and intended, over the SAME accounts (design 82 §7).
   *
   * The comparison set is the whole difficulty: a target exists only for accounts the
   * rebalancer manages, so measuring it against a book that also holds a house and a
   * company stake would report a "drift" that is really just two different questions.
   * Both sides are therefore filtered to `targetedStateKeys` — or to the picked
   * accounts, which under LOCATED mode is the *location* diagnostic ("is the class where
   * the plan wants it?") rather than a second opinion on the mix.
   *
   * Realized uses `source === 'holding'` because that is the reducer's own basis: it
   * rebalances holdings, and letting a reconciliation residual in would show drift the
   * rebalancer was never looking at.
   */
  _targetView() {
    const targetRows = this._targetRows();
    const targeted   = targetedStateKeys(targetRows);
    const scope      = this._stateKeys.size ? new Set(this._stateKeys) : null;
    const inScope    = r => (scope ? scope.has(r.stateKey) : targeted.has(r.stateKey));
    const normalize  = this._mode === 'pct';

    const realized = buildAllocationSeries(this._rows(), {
      filter: r => inScope(r) && r.source === 'holding', normalize,
    });
    const target = buildAllocationSeries(targetRows, { filter: inScope, normalize });
    const scopedTargetRows = targetRows.filter(inScope);

    return { realized, target, targeted, scopedTargetRows, scope };
  }

  /**
   * Put `built`'s series onto `dates`, with null where that date has no value.
   *
   * The two tables do not always cover the same dates — an account gains a target when
   * the rebalancer first sees it, which can be years into the run. Index-aligning them
   * regardless would slide the target series sideways and invent drift; nulls leave an
   * honest gap where there was no target.
   */
  _alignTo(dates, built) {
    const at = new Map(built.dates.map((d, i) => [d.getTime(), i]));
    const out = {};
    for (const key of built.keys) {
      out[key] = dates.map((d) => {
        const i = at.get(d.getTime());
        return i === undefined ? null : built.series[key][i];
      });
    }
    return out;
  }

  _accounts() {
    const rows = this._rows();
    const seen = new Map();
    for (const r of rows) {
      if (r.kind !== 'account' || r.assetClass === ASSET_CLASS.LIABILITY) continue;
      if (!seen.has(r.stateKey)) seen.set(r.stateKey, r.name ?? r.stateKey);
    }
    return [...seen.entries()]
      .map(([stateKey, label]) => ({ stateKey, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  /** Show only the controls the active view actually uses. */
  _syncControls() {
    const view = this._q('view');
    if (view) view.value = this._view;
    const acc = this._q('account');
    // The picker serves two views: it scopes the per-account mix, and it scopes the
    // target comparison (where one account is the LOCATED-mode location diagnostic).
    if (acc) acc.style.display = (this._view === 'account' || this._view === 'target') ? '' : 'none';
    // Hidden in the target view: drift is already per class there, and scoping one side
    // of a realized-vs-target comparison would draw a gap that is a filter, not a drift.
    const cls = this._q('class');
    if (cls) cls.style.display = this._view === 'target' ? 'none' : '';
    const debt = this._q('debt-wrap');
    if (debt) debt.style.display = this._view === 'total' ? '' : 'none';
    const debtBox = this._q('debt');
    if (debtBox) debtBox.checked = this._withDebt;
  }

  _render() {
    if (!this._mounted) return;

    const samples = this._records();
    const asof    = this._q('asof');
    if (asof) {
      // Named, not dated: "2026 · opening state" says why there is one point on the
      // panel, where a bare year would read as a one-year run.
      const first = samples[0]?.year, last = samples[samples.length - 1]?.year;
      const span  = first === last ? `${first}` : `${first}–${last}`;
      asof.textContent = !samples.length ? '—'
        : this._isLive ? `${samples[0].year} · opening state`
        : `${span} · ${samples.length} year-end${samples.length === 1 ? '' : 's'}`;
    }

    const empty = samples.length === 0;
    this._q('placeholder').style.display = empty ? '' : 'none';
    this._q('chart').style.display       = empty ? 'none' : '';
    this._renderProvenance(samples);
    if (empty) {
      this._q('mixbar').innerHTML = '';
      this._q('placeholder').textContent = this._sim
        ? 'Step or run the simulation to sample the allocation.'
        : 'No simulation is loaded.';
      return;
    }

    if (this._view === 'account' || this._view === 'target') this._renderAccountPicker();

    if (this._view === 'target') { this._renderTarget(); return; }

    this._renderClassPicker();

    // Two builds, and the pair is the point: `builtAll` is every category in scope —
    // the legend, so a switched-off chip is still there to switch back on — and `built`
    // is what the chart draws and re-normalises over. When nothing is hidden they are
    // the same object and the second pivot never runs.
    const rows     = this._rows();
    const builtAll = buildAllocationSeries(rows, this._seriesOpts({ withHidden: false }));
    this._pruneHidden(builtAll.keys);
    const built = this._hidden.size
      ? buildAllocationSeries(rows, this._seriesOpts())
      : builtAll;
    this._drawChart(built);
    this._renderMixBar(builtAll, built);
  }

  /**
   * Drop hidden keys that no longer exist.
   *
   * A key can leave the scope without the view changing — narrowing the class scope, or
   * a run advancing past the year an account is emptied. A stale entry would sit in the
   * set filtering nothing, and the "3 of 5" readout would then be counting a category
   * that is not on the chart.
   */
  _pruneHidden(keys) {
    if (this._hidden.size === 0) return;
    const live = new Set(keys);
    for (const key of this._hidden) if (!live.has(key)) this._hidden.delete(key);
  }

  /**
   * The overlay that makes the panel diagnostic rather than descriptive: realized (solid)
   * against intended (dashed), per class, with the drift and any band breach spelled out
   * below.
   *
   * Lines, not a stacked area. Two stacked areas cannot be compared by eye — the reader
   * would be asked to judge band thicknesses at different offsets — and the question here
   * is per-class distance from a target, which is exactly what two lines show.
   */
  _renderTarget() {
    const { realized, target, targeted, scopedTargetRows, scope } = this._targetView();

    if (scopedTargetRows.length === 0) {
      this._q('chart').style.display = 'none';
      this._q('placeholder').style.display = '';
      this._q('placeholder').textContent = !scope
        ? 'No account carries a target composition. Set an allocation strategy to compare against.'
        : scope.size === 1
          ? 'This account carries no target composition — the rebalancer does not manage it.'
          : 'None of the selected accounts carries a target composition — the rebalancer does not manage them.';
      this._q('mixbar').innerHTML = '';
      return;
    }
    this._q('placeholder').style.display = 'none';
    this._q('chart').style.display = '';

    this._drawTargetChart(realized, target);
    this._renderDriftBar(realized, target, scopedTargetRows, targeted);
  }

  _drawTargetChart(realized, target) {
    const host = this._q('chart');
    if (!host || !this._canvasAvailable()) return;
    if (!this._chart) {
      this._chart = echarts.init(host, null, { renderer: 'canvas' });
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => this._chart?.resize());
        this._ro.observe(host);
      }
    }

    const share  = this._mode === 'pct';
    const dark   = this._dark();
    const sparse = realized.dates.length <= 2;
    const ink    = dark ? '#94a3b8' : '#52514e';
    const line   = dark ? '#334155' : '#e1e0d9';
    const dates  = realized.dates;
    const tgt    = this._alignTo(dates, target);
    const money  = (n) => this._money(n);
    const fmt    = (v) => (v == null ? '—' : share ? `${(v * 100).toFixed(1)}%` : money(v));
    // Union of both sides' keys: a class held but never targeted (and one targeted but
    // not held) is precisely what the reader is looking for, so neither list alone will do.
    const keys = [...new Set([...realized.keys, ...target.keys])];

    this._chart.setOption({
      animation: false,
      backgroundColor: 'transparent',
      textStyle: { color: ink, fontFamily: 'var(--font-mono, monospace)' },
      grid: { left: 58, right: 14, top: 10, bottom: 22 },
      legend: { show: false },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: ink, opacity: 0.35 } },
        formatter(params) {
          if (!params?.length) return '';
          // Pair each class's two series on one line — actual → target — because the
          // comparison is the point and two separate rows make the reader do the join.
          const byKey = new Map();
          for (const p of params) {
            const key = p.seriesName.replace(/ (actual|target)$/, '');
            const slot = byKey.get(key) ?? { marker: p.marker };
            slot[p.seriesName.endsWith('target') ? 'target' : 'actual'] = p.value;
            byKey.set(key, slot);
          }
          const rows = [...byKey.entries()]
            .filter(([, v]) => (v.actual ?? 0) > 0 || (v.target ?? 0) > 0)
            .map(([key, v]) => `${v.marker} ${key} <strong>${fmt(v.actual)}</strong>` +
              ` <span style="opacity:.7">vs ${fmt(v.target)}</span>`);
          return `<strong>${params[0].axisValue}</strong><br>${rows.join('<br>')}`;
        },
      },
      xAxis: {
        type: 'category', boundaryGap: false,
        data: dates.map(d => String(d.getUTCFullYear())),
        axisLine:  { lineStyle: { color: line } },
        axisLabel: { color: ink, fontSize: 10 },
      },
      yAxis: {
        type: 'value', min: 0, max: share ? 1 : null,
        splitLine: { lineStyle: { color: line } },
        axisLabel: {
          color: ink, fontSize: 10,
          formatter: v => (share ? `${Math.round(v * 100)}%` : _compact(v)),
        },
      },
      series: keys.flatMap((key, i) => {
        const color = colorForSeriesKey(key, i, { dark });
        return [
          {
            name: `${key} actual`, type: 'line', smooth: false, showSymbol: sparse, symbolSize: 5,
            lineStyle: { width: 2, color }, itemStyle: { color },
            emphasis: { focus: 'series' },
            data: realized.series[key] ?? dates.map(() => 0),
          },
          {
            // Dashed and thinner: the target is the reference, the realized line is the
            // subject. Same colour, so the pairing needs no legend entry of its own.
            name: `${key} target`, type: 'line', smooth: false, showSymbol: sparse, symbolSize: 4,
            lineStyle: { width: 1, type: 'dashed', color, opacity: 0.9 },
            itemStyle: { color }, emphasis: { focus: 'series' },
            data: tgt[key] ?? dates.map(() => null),
          },
        ];
      }),
    }, true);
  }

  /**
   * Below the chart: where the book stands against policy at the latest sample.
   *
   * States the comparison set out loud. Under LOCATED targeting the aggregate covers only
   * the rebalanced accounts, and a reader who assumes it covers the whole plan will read a
   * house-heavy book as a rebalancer failure.
   */
  _renderDriftBar(realized, target, scopedTargetRows, targeted) {
    const el = this._q('mixbar');
    if (!el) return;

    // The last YEAR-END, not simply the last sample: the rebalance fires on the 1 January
    // period advance, so a horizon sample dated 1 January reads 0.0% drift for every class
    // — perfectly on policy at the one instant it cannot be otherwise. A 31 December
    // sample is read just before the correction, which is the number worth quoting
    // (design 82 §7).
    const idx = lastYearEndIndex(realized.dates);
    const atDate = idx >= 0 ? realized.dates[idx] : null;
    const shareAt = (built) => {
      const out = {};
      const j = built.dates.findIndex(d => atDate && d.getTime() === atDate.getTime());
      if (j < 0) return out;
      const total = built.totals[j] || 0;
      for (const key of built.keys) {
        const v = built.series[key][j];
        out[key] = this._mode === 'pct' ? v : (total ? v / total : 0);
      }
      return out;
    };

    const { rows, band } = driftAgainstTarget(shareAt(realized), shareAt(target), scopedTargetRows);
    const year = atDate ? atDate.getUTCFullYear() : '';
    const dark = this._dark();
    const keyIndex = new Map([...realized.keys, ...target.keys].map((k, i) => [k, i]));

    // Always names the comparison set. Under LOCATED targeting the aggregate covers only
    // the rebalanced accounts, and a reader who assumes it covers the whole plan reads a
    // house-heavy book as a rebalancer failure.
    const n = this._stateKeys.size;
    const scopeNote = n === 0
      ? `${targeted.size} targeted account${targeted.size === 1 ? '' : 's'}`
      : n === 1 ? 'this account' : `${n} selected accounts`;

    el.innerHTML =
      `<span class="alloc-mix-label">${year} vs target</span>` +
      `<span class="alloc-drift-scope">${scopeNote}${band != null ? ` · band ±${(band * 100).toFixed(1)}%` : ''}</span>` +
      rows.filter(r => r.realized > 0.0005 || r.target > 0.0005).map(r =>
        `<span class="alloc-mix-item alloc-mix-item--static${r.breach ? ' alloc-mix-item--breach' : ''}"
               title="${_esc(r.key)}: actual ${(r.realized * 100).toFixed(1)}%, target ${(r.target * 100).toFixed(1)}%">
           <i style="background:${colorForSeriesKey(r.key, keyIndex.get(r.key) ?? 0, { dark })}"></i>
           ${_esc(r.key)} <strong>${_signed(r.drift)}</strong>
         </span>`).join('');
  }

  /**
   * The tie-out, stated before the chart is read (design 82 §3). Loud when it fails:
   * a broken denominator makes every share on the panel wrong, so "do not quote this"
   * is the only honest thing to show.
   */
  _renderProvenance(samples) {
    const el = this._q('provenance');
    if (!el) return;
    if (samples.length === 0) { el.innerHTML = ''; el.className = 'alloc-provenance'; return; }

    const s = summarizeSamples(samples);
    const notes = [];
    if (s.reconciledAny) {
      notes.push(`holdings don't sum to balance somewhere — charted as <code>UNKNOWN</code>`);
    }
    if (s.inferredAny && !s.reconciledAny) {
      notes.push(`some accounts carry no holdings — class inferred from role`);
    }
    if (s.offBoundary.length) {
      // Not a year-end: a partial year, and it sits after the 1 January cascade that
      // credits the year's growth (design 82 §5.2), so the step into it is not the
      // year-over-year move every other step on the chart is.
      //
      // Deliberately NOT called "the run horizon": mid-playback this is simply where
      // the clock has got to, and it churns — a sale settling can read 0% equity for a
      // fortnight. Naming it "partial" is true whether the run is paused or finished.
      const dates = s.offBoundary.map(x => x.at.toISOString().slice(0, 10)).join(', ');
      // Except when it IS the opening state: that record is not a partial year, it is
      // the plan before anything has happened to it, and saying otherwise would put a
      // caveat on the one reading that needs none.
      notes.push(this._isLive
        ? `read from live state — the plan before its first step`
        : `${dates} is a partial year, not a year-end`);
    }

    // Design 88 §6: the disclosed-but-unrecognised amount, stated as a NOTE rather
    // than drawn as a slice. Every share on this panel is a share of recognised
    // wealth; a reader who can see the total is short by this much has been told
    // where it went, and a reader who cannot would conclude the panel is broken.
    if (s.speculative > 0.5) {
      notes.push(`${this._money(s.speculative)} speculative — excluded from every share`);
    }

    if (!s.ties) {
      const gap = Math.abs(s.worst.deltaRecognised ?? 0) > Math.abs(s.worst.delta ?? 0)
        ? { amount: s.worst.deltaRecognised, which: 'recognised rows vs net worth' }
        : { amount: s.worst.delta,           which: 'all rows vs net worth incl. speculative' };
      el.className = 'alloc-provenance alloc-provenance--bad';
      el.innerHTML = `<strong>Does not tie out.</strong> Worst gap ${this._money(gap.amount)}
        in ${s.worst.year} (${gap.which}) — a class is being dropped or double-counted.
        Do not quote any share here.`;
      return;
    }
    el.className = 'alloc-provenance';
    el.innerHTML = `<span class="alloc-ok">ties to net worth</span>` +
      (notes.length ? ` · ${notes.join(' · ')}` : '');
  }

  /**
   * Asset classes actually present in the cube, in the canonical legend order.
   *
   * LIABILITY is deliberately absent: the mix pivot drops it (an allocation is of gross
   * assets), so offering it would offer a scope that can only ever draw an empty chart.
   * The `with debt` toggle on the total view is where a liability belongs.
   */
  _classes() {
    const seen = new Set();
    for (const r of this._rows()) {
      if (r.assetClass == null || r.assetClass === ASSET_CLASS.LIABILITY) continue;
      seen.add(r.assetClass);
    }
    const rank = new Map(ASSET_CLASS_VALUES.map((v, i) => [v, i]));
    return [...seen].sort((a, b) =>
      (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) ||
      a.localeCompare(b));
  }

  /**
   * The class scope, on the workbench's shared `MapFilterMultiSelect`.
   *
   * Its option list is a live array the component re-reads on every open (the same
   * arrangement the timeline's event/action filters use), because the class set GROWS
   * mid-run: a plan that buys its first bond in 2034 has no BOND option before then, and
   * rebuilding the component to add one would drop the reader's selection.
   *
   * Selections are pruned against that list for the mirror-image reason — a class can
   * leave the book entirely (the last gold sold), and a scope pinned to something no
   * longer held is a permanently blank panel with no visible cause.
   */
  _renderClassPicker() {
    const host = this._q('class');
    if (!host) return;
    const classes = this._classes();
    const sig = classes.join('|');
    if (sig !== this._classesSig) {
      this._classesSig = sig;
      this._classItems.length = 0;
      this._classItems.push(...classes.map(c => ({ id: c, name: c })));
      for (const c of this._assetClasses) if (!classes.includes(c)) this._assetClasses.delete(c);
    }

    if (!this._classSelect) {
      this._classSelect = new ScopeMultiSelect({
        parent:     this,        // BaseComponent child: torn down with the panel
        container:  host,
        emptyLabel: 'all classes',
        onToggle:   (_item, _added, selected) => {
          this._assetClasses = new Set(selected.map(o => o.id));
          // The chips name keys inside the old scope; narrowing to GOLD leaves an
          // `EQUITY` in the set filtering a category that is no longer drawn.
          this._hidden.clear();
          this._classSelect.syncLabel();
          this._render();
        },
        queryApi: new QueryApi({ getAll: () => this._classItems }),
      });
    }
    this._classSelect.syncLabel();
  }

  /**
   * The account scope, on the same shared component as the class scope.
   *
   * It serves two views and means something slightly different in each, which is why the
   * grouping reads it rather than the other way round: in `By account` it is a
   * drill-down (see `_viewOpts`), and in the target view it is the comparison set — the
   * accounts realized and intended are BOTH measured over, which under LOCATED targeting
   * is the location diagnostic rather than a second opinion on the mix.
   */
  _renderAccountPicker() {
    const host = this._q('account');
    if (!host) return;
    const accounts = this._accounts();
    const sig = accounts.map(a => a.stateKey).join('|');
    // The account set grows mid-run (an inherited account funds at its INHERIT date), so
    // rebuild whenever membership moves — cheap, and only when it actually changes.
    if (sig !== this._accountsSig) {
      this._accountsSig = sig;
      this._accountItems.length = 0;
      this._accountItems.push(...accounts.map(a => ({ id: a.stateKey, name: a.label })));
      const live = new Set(accounts.map(a => a.stateKey));
      for (const key of this._stateKeys) if (!live.has(key)) this._stateKeys.delete(key);
    }

    if (!this._accountSelect) {
      this._accountSelect = new ScopeMultiSelect({
        parent:     this,
        container:  host,
        emptyLabel: 'all accounts',
        onToggle:   (_item, _added, selected) => {
          this._stateKeys = new Set(selected.map(o => o.id));
          // The keyspace flips between account names and class names at the one/many
          // boundary (see `_viewOpts`), so a carried-over chip would filter nothing.
          this._hidden.clear();
          this._accountSelect.syncLabel();
          this._render();
        },
        queryApi: new QueryApi({ getAll: () => this._accountItems }),
      });
    }
    this._accountSelect.syncLabel();
  }

  /**
   * The legend AND the "where the plan ends up" readout, in one strip.
   *
   * ECharts' own legend is switched off (see `_option`) because two legends is one too
   * many: in a docked pane ~250px tall they consumed a third of the chart between them
   * and said nearly the same thing. This strip is strictly more informative — same
   * swatches and names, plus each band's share at the latest sample, which is the number
   * the panel exists to show.
   *
   * Ordered by the CHART's series order, not by size: a legend that does not run in the
   * same order as the bands is harder to read than one that does. A band at 0.0% is kept
   * for the same reason — "equity is gone by now" is a finding, and dropping the row
   * would leave its colour unexplained wherever it still appears earlier on the chart.
   */
  _renderMixBar(builtAll, built = builtAll) {
    const el = this._q('mixbar');
    if (!el) return;
    if (!builtAll.keys.length) { el.innerHTML = ''; return; }

    // Shares of the SELECTION, matching the chart above: switch three of five classes
    // off and each survivor's share is of the two that are left. A hidden chip therefore
    // reads 0.0% — struck through and still listed, never silently dropped, because its
    // colour is still on the chart at earlier dates.
    const mix   = mixAt(this._rows(), { ...this._seriesOpts(), normalize: true });
    const dark  = this._dark();
    const dates = built.dates.length ? built.dates : builtAll.dates;
    const year  = dates.length ? dates[dates.length - 1].getUTCFullYear() : '';

    // Said out loud whenever it is true. An unlabelled 68% that is not 68% of the
    // portfolio is exactly the number someone pastes into a note.
    const kept = builtAll.keys.length - this._hidden.size;
    const note = this._hidden.size
      ? `<span class="alloc-mix-filtered">${kept} of ${builtAll.keys.length} · shares of the selection</span>`
      : '';

    el.innerHTML = `<span class="alloc-mix-label">${year}</span>${note}` +
      builtAll.keys.map((key, i) => {
        const share = mix[key] ?? 0;
        const hidden = this._hidden.has(key);
        // Colour by position in the FULL key list, so switching a category off does not
        // repaint the ones that are left.
        return `<span class="alloc-mix-item${hidden ? ' alloc-mix-item--off' : ''}"
                      data-alloc-key="${_esc(key)}"
                      title="${hidden ? 'click to count this category again'
                                      : 'click to drop this category from the chart and the 100%'}">
                  <i style="background:${colorForSeriesKey(key, i, { dark })}"></i>
                  ${_esc(key)} <strong>${(share * 100).toFixed(1)}%</strong>
                </span>`;
      }).join('');
  }

  /**
   * Click a legend chip to drop that category out of the chart AND out of the
   * denominator, then redraw. A full re-render rather than a `legendSelect`: the shares
   * have genuinely changed, so the chart, the strip and the tooltip all have to be
   * rebuilt from the narrowed fact table. Not persisted — this is a thing you do while
   * looking, not a setting.
   */
  _onMixBarClick(e) {
    const item = e.target.closest('[data-alloc-key]');
    if (!item) return;
    const key = item.dataset.allocKey;
    if (this._hidden.has(key)) this._hidden.delete(key);
    else this._hidden.add(key);
    this._render();
  }

  // ─── Chart ───────────────────────────────────────────────────────────────

  _dark() {
    const theme = document.documentElement?.dataset?.theme;
    if (theme) return theme !== 'light';
    return true; // the workbench ships dark
  }

  /**
   * Does this environment have a 2D canvas? jsdom does not, and ECharts fails inside
   * `setOption` rather than at `init`, which would take the panel's DOM tests down with
   * it. Probed once: the answer cannot change within a session, and it is an
   * environment fact, not an error to swallow — everything except the chart itself
   * (provenance, mix strip, CSV) still renders without one.
   */
  _canvasAvailable() {
    if (this._hasCanvas === undefined) {
      try {
        const probe = document.createElement('canvas');
        this._hasCanvas = typeof probe.getContext === 'function' && !!probe.getContext('2d');
      } catch { this._hasCanvas = false; }
    }
    return this._hasCanvas;
  }

  _drawChart(built) {
    const host = this._q('chart');
    if (!host || !this._canvasAvailable()) return;
    if (!this._chart) {
      this._chart = echarts.init(host, null, { renderer: 'canvas' });
      // ECharts sizes its canvas once, at init. This panel's height changes WITHOUT a
      // window resize — the provenance strip appears when the first sample lands, the
      // legend strip when the first series does, and the pane is draggable — and every
      // one of those left the canvas taller than its box, so the x-axis labels drew on
      // top of the strip below. Observe the box, not the window.
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => this._chart?.resize());
        this._ro.observe(host);
      }
    }
    // `true` (notMerge): a view change replaces the series set outright. Merging would
    // leave the previous view's series behind as ghost bands. It is also what lets the
    // panel swap between a doughnut and a stacked area without the two option shapes
    // bleeding into each other.
    const option = built.dates.length === 1 ? this._donutOption(built) : this._option(built);
    this._chart.setOption(option, true);
  }

  /**
   * One sample, drawn as a doughnut — the mix with no time axis.
   *
   * A time series of one point is not a small chart, it is the wrong chart: a stacked
   * area over a single date draws nothing at all, which is why this panel read as broken
   * for the whole of a plan's first year. But the reader's question at that moment is
   * perfectly answerable — "what is the mix right now" — and it simply has no time
   * dimension in it yet. So the panel answers THAT question until a second sample gives
   * the time axis something to say, and switches to the area chart on its own.
   *
   * Negative slices are dropped rather than drawn: a pie cannot render one, and the only
   * way to get here with one is the total view's `with debt` decomposition. The count is
   * stated in the centre rather than silently omitted.
   */
  _donutOption(built) {
    const share = this._mode === 'pct';
    const dark  = this._dark();
    const ink   = dark ? '#94a3b8' : '#52514e';
    const money = (n) => this._money(n);

    // In share mode the pivot has already normalised the column, so the slice values are
    // shares; the gross is carried separately for the centre readout either way.
    const gross = built.totals[0] || 0;
    const data = built.keys
      .map((key, i) => ({
        name: key,
        value: built.series[key][0] ?? 0,
        itemStyle: { color: colorForSeriesKey(key, i, { dark }) },
      }))
      .filter(d => d.value > 0);
    const dropped = built.keys.length - data.length;

    return {
      animation: false,
      backgroundColor: 'transparent',
      textStyle: { color: ink, fontFamily: 'var(--font-mono, monospace)' },
      title: {
        left: 'center', top: 'center',
        text: String(built.dates[0].getUTCFullYear()),
        subtext: money(gross) + (dropped ? ` · ${dropped} negative slice${dropped === 1 ? '' : 's'} not drawn` : ''),
        textStyle:    { color: ink, fontSize: 14, fontFamily: 'var(--font-mono, monospace)' },
        subtextStyle: { color: ink, fontSize: 10, fontFamily: 'var(--font-mono, monospace)', opacity: 0.8 },
      },
      tooltip: {
        trigger: 'item',
        formatter: (p) => `${p.marker} ${p.name} <strong>${
          share ? `${(p.value * 100).toFixed(1)}%` : money(p.value)
        }</strong> <span style="opacity:.7">${
          share ? `of ${money(gross)}` : `· ${p.percent.toFixed(1)}%`}</span>`,
      },
      // The strip below the chart is the legend here as everywhere else, and it is the
      // control surface too — its chips still filter the doughnut.
      legend: { show: false },
      series: [{
        type: 'pie',
        radius: ['48%', '72%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        // Sorted by the pivot's canonical order, not by size, so a class keeps its place
        // between the doughnut and the area chart it turns into.
        label: { show: false },
        labelLine: { show: false },
        itemStyle: { borderWidth: 1, borderColor: dark ? '#0f172a' : '#faf9f5' },
        emphasis: { scale: true, scaleSize: 4 },
        data,
      }],
    };
  }

  /**
   * The ECharts option. Ported from the lab page so the two read the same — a stacked
   * area, 100%-stacked in share mode, with the zero series dropped from the tooltip: a
   * 12-line tooltip where 5 rows read 0.0% is how a reader stops opening tooltips.
   */
  _option(built) {
    const share = this._mode === 'pct';
    const dark  = this._dark();
    // Two dates draw as a hairline nobody can read a value off. Show the marks while the
    // series is that short; they disappear on their own once the bands are legible. (One
    // date never reaches here — `_drawChart` sends it to the doughnut instead.)
    const sparse = built.dates.length <= 2;
    const ink   = dark ? '#94a3b8' : '#52514e';
    const line  = dark ? '#334155' : '#e1e0d9';
    const money = (n) => this._money(n);
    const totals = built.totals;

    return {
      animation: false,
      backgroundColor: 'transparent',
      textStyle: { color: ink, fontFamily: 'var(--font-mono, monospace)' },
      grid: { left: 58, right: 14, top: 10, bottom: 22 },
      // Present but hidden: the strip below the chart is the legend (_renderMixBar), and
      // the component still has to exist for its chips to drive legendSelect.
      // Present but hidden, and carrying no selection state: a switched-off category is
      // filtered out of the fact table (see `_seriesOpts`), so it never reaches a series.
      legend: { show: false },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: ink, opacity: 0.35 } },
        formatter(params) {
          if (!params?.length) return '';
          const i = params[0].dataIndex;
          const head = `<strong>${params[0].axisValue}</strong>` +
            (share ? ` <span style="opacity:.6">of ${money(totals[i])}</span>` : '');
          const lines = params
            .filter(p => Math.abs(p.value) > (share ? 0.0005 : 0.5))
            .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
            .map(p => `${p.marker} ${p.seriesName} <strong>${
              share ? (p.value * 100).toFixed(1) + '%' : money(p.value)}</strong>`);
          return `${head}<br>${lines.join('<br>')}`;
        },
      },
      xAxis: {
        type: 'category', boundaryGap: false,
        data: built.dates.map(d => String(d.getUTCFullYear())),
        axisLine:  { lineStyle: { color: line } },
        axisLabel: { color: ink, fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        max: share ? 1 : null,
        splitLine: { lineStyle: { color: line } },
        axisLabel: {
          color: ink, fontSize: 10,
          formatter: v => (share ? `${Math.round(v * 100)}%` : _compact(v)),
        },
      },
      series: built.keys.map((key, i) => ({
        name: key, type: 'line', stack: 'all', smooth: false,
        showSymbol: sparse, symbolSize: 5, lineStyle: { width: 1 },
        areaStyle: { opacity: 0.85 },
        itemStyle: { color: colorForSeriesKey(key, i, { dark }) },
        emphasis: { focus: 'series' },
        data: built.series[key],
      })),
    };
  }

  // ─── Export ──────────────────────────────────────────────────────────────

  /**
   * The whole cube, not the drawn series: the raw fact table is what someone
   * re-checking a number in a spreadsheet needs, and it is the same shape the lab
   * report writes with `--csv`.
   */
  _downloadCsv() {
    const rows = this._rows();
    if (!rows.length) return;
    const cols = ALLOCATION_CSV_COLUMNS;
    const cell = (v) => {
      if (v == null) return '';
      const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
    const blob = new Blob([withBom(csv)], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `allocation-cube-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _money(n) {
    if (n == null) return '—';
    const reg = this._services()?.schemaRegistry;
    return reg?.formatAmount?.(n, 'USD') ?? `$${Math.round(n).toLocaleString()}`;
  }

  /**
   * Attach a listener once, surviving the remounts a docked panel goes through.
   * `handler` receives the element; pass `rawHandler` instead when the event object
   * itself is needed (delegated clicks).
   */
  _bindOnce(name, event, handler, rawHandler = null) {
    const el = this._q(name);
    if (!el || el._allocBound) return;
    el.addEventListener(event, rawHandler ?? (() => handler(el)));
    el._allocBound = true;
  }

  _q(name) { return this.el?.querySelector(`[data-alloc="${name}"]`) ?? null; }
}

/**
 * Either scope control — classes (WHAT) or accounts (WHERE): `MapFilterMultiSelect`, with
 * the input itself reporting the current selection.
 *
 * The base component's input is a SEARCH box — it holds what you typed, and the
 * selection lives only as ticks inside the dropdown. That is right for the timeline,
 * where the filter sits open beside its list; it is wrong in a toolbar the reader looks
 * at with the dropdown shut, where a control that reads "Select..." while silently
 * filtering out three quarters of the book is a chart nobody can trust. So the
 * placeholder carries the answer whenever the box is empty, which is whenever it is not
 * being typed into.
 *
 * @param {string} opts.emptyLabel what an empty selection means, in the reader's words —
 *        "all classes", "all accounts". Empty is never "nothing selected" on this panel.
 */
class ScopeMultiSelect extends MapFilterMultiSelect {
  constructor(opts) {
    super(opts);
    this._emptyLabel = opts.emptyLabel ?? 'all';
    // The base component sorts its list by name, which is right for a long searchable
    // map and wrong here: it would list the classes alphabetically while the legend and
    // the bands run in canonical order (EQUITY, BOND, CASH, GOLD). Two orders for one
    // short list is harder to read than either. An empty sort keeps each list in the
    // order its own builder hands it over in — canonical for classes, by label for
    // accounts, both matching what the chart shows.
    this._query.sort = [];
  }

  /** Re-state the selection in the placeholder. Empty selection means all of them. */
  syncLabel() {
    const chosen = [...this._selectedMap.values()].map(o => o.name);
    this._input.placeholder = chosen.length === 0 ? this._emptyLabel : chosen.join(', ');
    this._input.title = this._input.placeholder;
  }

  /** The base class redraws the list after every toggle; keep the label with it. */
  onRenderVisible() { this.syncLabel(); }

  /**
   * The list is sized to READ, not to match the control.
   *
   * The base component pins the dropdown to the input's own width, which is right where
   * the filter is a full-width field. In a toolbar the input is ~150px and account names
   * are not — "AU Superannuation (Jeanne)" wrapped onto three lines, which is how a list
   * of nineteen accounts becomes unscannable. The list is free to be wider than the box
   * that opens it; it is only ever open over the chart.
   */
  _position() {
    super._position();
    const rect  = this._input.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 240), Math.max(240, window.innerWidth - rect.left - 12));
    this._dropdown.style.width = `${width}px`;
  }

  /**
   * Shut the dropdown. It lives on `document.body`, so it does not travel with the panel:
   * a pane docked away or dragged elsewhere while the list is open would leave it
   * floating over whatever is underneath, with no control beside it to explain it.
   */
  close() { this._dropdown.style.display = 'none'; }
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Drift, always signed, in points of share — "+3.5" reads as over-weight at a glance. */
function _signed(share) {
  const pts = share * 100;
  const sign = pts > 0.05 ? '+' : pts < -0.05 ? '−' : '';
  return `${sign}${Math.abs(pts).toFixed(1)}`;
}

function _compact(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (a >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}
