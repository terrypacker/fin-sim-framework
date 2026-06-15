/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * journal-report-plugin.test.mjs — DOM tests for JournalReportPlugin.
 *
 * Regression coverage for the expand/collapse handler. The original
 * implementation re-attached a click listener inside _renderResults(),
 * stacking handlers across renders so each click would toggle every
 * accumulated handler — freezing the UI after the first fold.
 *
 * Run with: npm run test:viz
 */

import { JournalReportPlugin }       from '../../src/visualization/workbench/plugins/finance/journal-report-plugin.js';
import { WorkbenchRuntime, WB_EVENTS } from '../../src/visualization/workbench/workbench-runtime.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePlugin() {
  const runtime = new WorkbenchRuntime();
  const plugin  = new JournalReportPlugin(runtime);
  const host    = document.createElement('div');
  document.body.appendChild(host);
  plugin.mount(host);
  return { plugin, runtime, host };
}

/**
 * Seed the plugin with a fake report state so we can render rows
 * without exercising the QueryApi pipeline.
 */
function seedThreeGroups(plugin) {
  plugin._activeReportId = 'ordinary-income-by-source';
  // Non-empty journal sentinel so _renderResults() doesn't show the placeholder.
  plugin._journal = { journal: [{}] };
  plugin._groups = [
    { key: { actionType: 'WAGES'    }, count: 2, total: 1000, items: [{ date: '2030-01-01', actionType: 'WAGES',    description: 'a', amount: 500 }] },
    { key: { actionType: 'INTEREST' }, count: 1, total:  250, items: [{ date: '2030-02-01', actionType: 'INTEREST', description: 'b', amount: 250 }] },
    { key: { actionType: 'DIVIDEND' }, count: 3, total:  750, items: [{ date: '2030-03-01', actionType: 'DIVIDEND', description: 'c', amount: 250 }] },
  ];
  plugin._grandTotal = 2000;
  plugin._renderResults();
}

function clickRow(row) {
  // Bubble: simulate the real user clicking the expand button inside the row.
  const btn = row.querySelector('.jr-expand-btn');
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function groupRows(host) {
  return [...host.querySelectorAll('.jr-group-row')];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('JournalReportPlugin.render: produces the toolbar + body skeleton', () => {
  const plugin = new JournalReportPlugin(new WorkbenchRuntime());
  const el = plugin.render();
  expect(el.querySelector('[data-jr="picker"]')).not.toBeNull();
  expect(el.querySelector('[data-jr="tbody"]')).not.toBeNull();
  expect(el.querySelector('[data-jr="grand-total"]')).not.toBeNull();
});

test('JournalReportPlugin: clicking a group row toggles its expanded state', () => {
  const { plugin, host } = makePlugin();
  seedThreeGroups(plugin);

  const rows = groupRows(host);
  expect(rows).toHaveLength(3);

  clickRow(rows[0]);
  expect(plugin._expandedKeys.size).toBe(1);
  expect(groupRows(host)[0].classList.contains('jr-group-row--expanded')).toBe(true);
});

test('JournalReportPlugin: subsequent clicks on other rows still toggle (regression for stacked listeners)', () => {
  const { plugin, host } = makePlugin();
  seedThreeGroups(plugin);

  // First click — expand WAGES.
  clickRow(groupRows(host)[0]);
  expect(plugin._expandedKeys.size).toBe(1);

  // Second click — expand INTEREST. With the bug, the second handler attached
  // by the first _renderResults() would also fire and toggle INTEREST back to
  // collapsed, leaving _expandedKeys at size 1 (WAGES only).
  clickRow(groupRows(host)[1]);
  expect(plugin._expandedKeys.size).toBe(2);

  // Third click — expand DIVIDEND. The bug compounds (3 handlers stacked) so
  // even/odd toggle behavior would make this also appear broken.
  clickRow(groupRows(host)[2]);
  expect(plugin._expandedKeys.size).toBe(3);
});

test('JournalReportPlugin: a row can be collapsed after expanding (round-trip)', () => {
  const { plugin, host } = makePlugin();
  seedThreeGroups(plugin);

  // Expand row 0, then expand row 1, then collapse row 0.
  clickRow(groupRows(host)[0]);
  clickRow(groupRows(host)[1]);

  // After expanding two rows, child rows appear, so groupRows order
  // is still keyed by .jr-group-row only (children use .jr-child-row).
  const expandedRow0 = groupRows(host)[0];
  clickRow(expandedRow0);
  expect(plugin._expandedKeys.size).toBe(1);
  expect(groupRows(host)[0].classList.contains('jr-group-row--expanded')).toBe(false);
  expect(groupRows(host)[1].classList.contains('jr-group-row--expanded')).toBe(true);
});

test('JournalReportPlugin: only one click listener is attached to tbody across many renders', () => {
  const { plugin, host } = makePlugin();
  seedThreeGroups(plugin);

  // Force multiple full re-renders.
  plugin._renderResults();
  plugin._renderResults();
  plugin._renderResults();

  // Click row 0 once: with the bug, N stacked handlers would each toggle once,
  // so the post-click expanded-keys count would be (N mod 2) instead of 1.
  clickRow(groupRows(host)[0]);
  expect(plugin._expandedKeys.size).toBe(1);
});

// ─── Phase 3B: FacetPanel multiselect ─────────────────────────────────────────

/**
 * Stub services that satisfy the plugin's lazy lookup contract. We override
 * setServices() to avoid the global ServiceRegistry singleton and keep tests
 * hermetic.
 */
function withServices(plugin, { accounts = [], persons = [] } = {}) {
  plugin.setServices({
    accountService: { getAll: () => accounts },
    personService:  { getAll: () => persons  },
  });
}

test('FacetPanel: account multiselect renders one checkbox per registered account', () => {
  const { plugin, host } = makePlugin();
  withServices(plugin, {
    accounts: [
      { stateKey: 'usSavingsAccount', name: 'US Savings', country: 'US' },
      { stateKey: 'auSavingsAccount', name: 'AU Savings', country: 'AU' },
      { stateKey: '',                  name: 'Skipped',    country: null }, // no stateKey → skipped
    ],
  });
  plugin._activeReportId = 'cash-flow-by-account';
  plugin._renderFacets();

  const checkboxes = host.querySelectorAll('[data-facet="accountStateKeys"]');
  expect(checkboxes.length).toBe(2);
  const values = [...checkboxes].map(cb => cb.value).sort();
  expect(values).toEqual(['auSavingsAccount', 'usSavingsAccount']);
});

test('FacetPanel: clicking an account checkbox updates facetValues and triggers query', () => {
  const { plugin, host } = makePlugin();
  withServices(plugin, {
    accounts: [
      { stateKey: 'usSavingsAccount', name: 'US Savings', country: 'US' },
      { stateKey: 'iraAccount',        name: 'IRA',         country: 'US' },
    ],
  });
  plugin._activeReportId = 'cash-flow-by-account';
  // Stub out the query so we can observe calls without binding a real journal.
  let ranWith = null;
  plugin._runQuery = async function() { ranWith = { ...this._facetValues }; };
  plugin._renderFacets();

  const cb = host.querySelector('[data-facet="accountStateKeys"][value="usSavingsAccount"]');
  cb.checked = true;
  cb.dispatchEvent(new Event('change', { bubbles: true }));

  expect(plugin._facetValues.accountStateKeys).toEqual(['usSavingsAccount']);
  // Period facet auto-defaults to Whole simulation when no journal is bound,
  // so we only assert the field under test rather than the full facetValues shape.
  expect(ranWith.accountStateKeys).toEqual(['usSavingsAccount']);
});

test('FacetPanel: unchecking the last value resets the array to null', () => {
  const { plugin, host } = makePlugin();
  withServices(plugin, {
    accounts: [{ stateKey: 'usSavingsAccount', name: 'US Savings', country: 'US' }],
  });
  plugin._activeReportId = 'cash-flow-by-account';
  plugin._facetValues.accountStateKeys = ['usSavingsAccount'];
  plugin._runQuery = async () => {};
  plugin._renderFacets();

  const cb = host.querySelector('[data-facet="accountStateKeys"]');
  expect(cb.checked).toBe(true);

  cb.checked = false;
  cb.dispatchEvent(new Event('change', { bubbles: true }));

  // null (not empty array) so subsequent reads via _asArray treat it as "all".
  expect(plugin._facetValues.accountStateKeys).toBe(null);
});

test('FacetPanel: person multiselect renders from personService.getAll()', () => {
  const { plugin, host } = makePlugin();
  withServices(plugin, {
    persons: [
      { id: 'p-1', name: 'Alice' },
      { id: 'p-2', name: 'Bob'   },
    ],
  });
  plugin._activeReportId = 'ordinary-income-by-source';
  plugin._renderFacets();

  const labels = [...host.querySelectorAll('[data-facet="personKeys"]')].map(cb => cb.value).sort();
  expect(labels).toEqual(['p-1', 'p-2']);
});

test('FacetPanel: multiselect summary reflects current selection size', () => {
  const { plugin, host } = makePlugin();
  withServices(plugin, {
    persons: [
      { id: 'p-1', name: 'Alice' },
      { id: 'p-2', name: 'Bob'   },
      { id: 'p-3', name: 'Carla' },
    ],
  });
  plugin._activeReportId = 'ordinary-income-by-source';
  plugin._renderFacets();

  const summary = () => host.querySelector('[data-facet-host="personKeys"] .jr-ms-summary-text').textContent;
  expect(summary().toLowerCase()).toMatch(/all people/);

  plugin._facetValues.personKeys = ['p-1'];
  plugin._renderFacets();
  expect(summary()).toBe('Alice');

  plugin._facetValues.personKeys = ['p-1', 'p-2'];
  plugin._renderFacets();
  expect(summary()).toBe('2 selected');
});

// ─── Phase 3C: Period facet UI ────────────────────────────────────────────────

/**
 * Build a JournalDataSource-shaped object on the plugin. We don't need the real
 * Journal here — `_buildPeriodOptions` only touches `_api.listSettledPeriods`
 * and `_api.currentInProgressPeriod`, so we stub those plus a journal length.
 */
function withFakeJournal(plugin, { settled = [], current = null, journalLength = 1 } = {}) {
  // Minimal Journal-shaped object so _buildPeriodOptions doesn't early-out.
  plugin._journal = { journal: Array(journalLength).fill({}) };
  plugin._api = {
    listSettledPeriods:      () => settled,
    currentInProgressPeriod: () => current,
  };
  plugin._diffApi   = plugin._api;
  plugin._personApi = plugin._api;
}

test('Period facet: renders Whole simulation option when no settles exist', () => {
  const { plugin, host } = makePlugin();
  withFakeJournal(plugin, { settled: [], current: null });
  plugin._activeReportId = 'ordinary-income-by-source';
  plugin._renderFacets();

  const periodSel = host.querySelector('select[data-facet="period"]');
  expect(periodSel).not.toBeNull();
  const values = [...periodSel.options].map(o => o.value);
  expect(values).toEqual(['__all__']);
});

test('Period facet: renders one option per settled period + Whole simulation in reverse chronological order', () => {
  const { plugin, host } = makePlugin();
  withFakeJournal(plugin, {
    settled: [
      { fromEntryId: 'us-26',   toEntryId: 'us-27',   toEntryDate: new Date(Date.UTC(2027, 11, 31)), label: 'CY 2027' },
      { fromEntryId: 'us-25',   toEntryId: 'us-26',   toEntryDate: new Date(Date.UTC(2026, 11, 31)), label: 'CY 2026' },
      { fromEntryId: null,      toEntryId: 'us-25',   toEntryDate: new Date(Date.UTC(2025, 11, 31)), label: 'CY 2025' },
    ],
  });
  plugin._activeReportId = 'ordinary-income-by-source';
  plugin._renderFacets();

  const periodSel = host.querySelector('select[data-facet="period"]');
  const labels    = [...periodSel.options].map(o => o.textContent);
  expect(labels).toEqual(['CY 2027', 'CY 2026', 'CY 2025', 'Whole simulation']);

  // Default selection is the most recent settled period.
  expect(periodSel.value).toBe('us-27');
  expect(plugin._facetValues.period).toEqual({ fromEntryId: 'us-26', toEntryId: 'us-27' });
});

test('Period facet: includes "Current (in progress)" option when post-settle activity exists', () => {
  const { plugin, host } = makePlugin();
  withFakeJournal(plugin, {
    settled: [{ fromEntryId: null, toEntryId: 'us-25', toEntryDate: new Date(Date.UTC(2025, 11, 31)), label: 'CY 2025' }],
    current: { fromEntryId: 'us-25', toEntryId: null, label: 'Current (in progress)' },
  });
  plugin._activeReportId = 'ordinary-income-by-source';
  plugin._renderFacets();

  const periodSel = host.querySelector('select[data-facet="period"]');
  const values    = [...periodSel.options].map(o => o.value);
  expect(values).toEqual(['__current__', 'us-25', '__all__']);
});

test('Period facet: changing the select updates facetValues.period and triggers query', () => {
  const { plugin, host } = makePlugin();
  withFakeJournal(plugin, {
    settled: [
      { fromEntryId: 'us-25', toEntryId: 'us-26', toEntryDate: new Date(Date.UTC(2026, 11, 31)), label: 'CY 2026' },
      { fromEntryId: null,    toEntryId: 'us-25', toEntryDate: new Date(Date.UTC(2025, 11, 31)), label: 'CY 2025' },
    ],
  });
  plugin._activeReportId = 'ordinary-income-by-source';

  let ranWith = null;
  plugin._runQuery = async function() { ranWith = JSON.parse(JSON.stringify(this._facetValues)); };
  plugin._renderFacets();

  // Initial default is most recent (us-26).
  expect(plugin._facetValues.period).toEqual({ fromEntryId: 'us-25', toEntryId: 'us-26' });

  const periodSel = host.querySelector('select[data-facet="period"]');
  periodSel.value = 'us-25';
  periodSel.dispatchEvent(new Event('change', { bubbles: true }));

  expect(plugin._facetValues.period).toEqual({ fromEntryId: null, toEntryId: 'us-25' });
  expect(ranWith.period).toEqual({ fromEntryId: null, toEntryId: 'us-25' });
});

test('Period facet: choosing Whole simulation resolves to null/null period', () => {
  const { plugin, host } = makePlugin();
  withFakeJournal(plugin, {
    settled: [{ fromEntryId: null, toEntryId: 'us-25', toEntryDate: new Date(Date.UTC(2025, 11, 31)), label: 'CY 2025' }],
  });
  plugin._activeReportId = 'ordinary-income-by-source';
  plugin._runQuery = async () => {};
  plugin._renderFacets();

  const periodSel = host.querySelector('select[data-facet="period"]');
  periodSel.value = '__all__';
  periodSel.dispatchEvent(new Event('change', { bubbles: true }));

  expect(plugin._facetValues.period).toEqual({ fromEntryId: null, toEntryId: null });
});

test('Period facet: switching cc rebuilds the option list', () => {
  const { plugin, host } = makePlugin();

  // Different option lists per cc. The fake API returns the right set based on
  // the argument the plugin passes through to listSettledPeriods.
  plugin._journal = { journal: [{}] };
  plugin._api = {
    listSettledPeriods: (cc) => cc === 'AU'
      ? [{ fromEntryId: null, toEntryId: 'au-26', toEntryDate: new Date(Date.UTC(2026, 5, 30)), label: 'FY 2025–26' }]
      : [{ fromEntryId: null, toEntryId: 'us-26', toEntryDate: new Date(Date.UTC(2026, 11, 31)), label: 'CY 2026' }],
    currentInProgressPeriod: () => null,
  };
  plugin._diffApi = plugin._personApi = plugin._api;

  plugin._activeReportId = 'ordinary-income-by-source';
  plugin._runQuery = async () => {};
  plugin._renderFacets();

  // cc defaults to first option ('US') → US settle enumerated.
  let periodSel = host.querySelector('select[data-facet="period"]');
  expect([...periodSel.options].map(o => o.value)).toEqual(['us-26', '__all__']);

  // Switch cc to AU — change handler rebuilds options.
  const ccSel = host.querySelector('select[data-facet="cc"]');
  ccSel.value = 'AU';
  ccSel.dispatchEvent(new Event('change', { bubbles: true }));

  periodSel = host.querySelector('select[data-facet="period"]');
  expect([...periodSel.options].map(o => o.value)).toEqual(['au-26', '__all__']);
  // Period reset to the new cc's default since the prior us-26 doesn't enumerate.
  expect(plugin._facetValues.period).toEqual({ fromEntryId: null, toEntryId: 'au-26' });
});

test('Period facet: JOURNAL_REPORT_OPEN selects the option matching incoming params.period.toEntryId', () => {
  const { plugin, host, runtime } = makePlugin();
  withFakeJournal(plugin, {
    settled: [
      { fromEntryId: 'us-25', toEntryId: 'us-26', toEntryDate: new Date(Date.UTC(2026, 11, 31)), label: 'CY 2026' },
      { fromEntryId: null,    toEntryId: 'us-25', toEntryDate: new Date(Date.UTC(2025, 11, 31)), label: 'CY 2025' },
    ],
  });
  plugin._runQuery = async () => {};

  runtime.bus.publish({
    type:     WB_EVENTS.JOURNAL_REPORT_OPEN,
    reportId: 'ordinary-income-by-source',
    params:   { cc: 'US', period: { fromEntryId: null, toEntryId: 'us-25' } },
  });

  const periodSel = host.querySelector('select[data-facet="period"]');
  expect(periodSel.value).toBe('us-25');
  expect(plugin._facetValues.period).toEqual({ fromEntryId: null, toEntryId: 'us-25' });
});

// ─── §13: Sort & Ordering Upgrade ─────────────────────────────────────────────

test('Sort: child rows are rendered in chronological order (ts ascending) when a group is expanded', () => {
  const { plugin, host } = makePlugin();
  plugin._activeReportId = 'ordinary-income-by-source';
  plugin._journal = { journal: [{}] };
  // Items intentionally out of order: Mar, Jan, Feb.
  // Use noon-UTC timestamps so toLocaleDateString never shifts to the prior day
  // in UTC-behind timezones (e.g. US/Pacific).
  const tsJan = Date.UTC(2030, 0, 15, 12);
  const tsFeb = Date.UTC(2030, 1, 15, 12);
  const tsMar = Date.UTC(2030, 2, 15, 12);
  plugin._groups = [
    {
      key: { actionType: 'WAGES' },
      count: 3,
      total: 1500,
      items: [
        { ts: tsMar, date: new Date(tsMar), actionType: 'WAGES', description: 'c', amount: 500 },
        { ts: tsJan, date: new Date(tsJan), actionType: 'WAGES', description: 'a', amount: 500 },
        { ts: tsFeb, date: new Date(tsFeb), actionType: 'WAGES', description: 'b', amount: 500 },
      ],
    },
  ];
  plugin._grandTotal = 1500;
  plugin._renderResults();

  // Expand the row
  const row = host.querySelector('.jr-group-row');
  row.querySelector('.jr-expand-btn').dispatchEvent(new MouseEvent('click', { bubbles: true }));

  const childDates = [...host.querySelectorAll('.jr-child-date')].map(el => el.textContent.trim());
  // Dates should appear in ascending chronological order
  expect(childDates[0]).toMatch(/Jan/);
  expect(childDates[1]).toMatch(/Feb/);
  expect(childDates[2]).toMatch(/Mar/);
});

test('Sort: defaultSort is total desc for income reports, year asc for year-keyed reports', () => {
  const { plugin } = makePlugin();

  plugin._openReport('ordinary-income-by-source', {});
  expect(plugin._sortState).toEqual({ field: 'total', dir: 'desc' });

  plugin._openReport('tax-paid-by-year', {});
  expect(plugin._sortState).toEqual({ field: 'year', dir: 'asc' });

  plugin._openReport('au-tax-by-person-year', {});
  expect(plugin._sortState).toEqual({ field: 'year', dir: 'asc' });

  plugin._openReport('roth-conversions-by-year', {});
  expect(plugin._sortState).toEqual({ field: 'year', dir: 'asc' });
});

test('Sort: clicking the Total column header sets sortState to total desc on first click, then toggles', () => {
  const { plugin, host } = makePlugin();
  seedThreeGroups(plugin);  // _sortState is null at this point

  // First click on Total (not yet active) → default dir for 'total' = desc
  let totalTh = host.querySelector('[data-sort-field="total"]');
  totalTh.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(plugin._sortState).toEqual({ field: 'total', dir: 'desc' });

  // Second click (now active) → toggle to asc. Re-query after re-render.
  totalTh = host.querySelector('[data-sort-field="total"]');
  totalTh.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(plugin._sortState).toEqual({ field: 'total', dir: 'asc' });

  // Third click → toggle back to desc.
  totalTh = host.querySelector('[data-sort-field="total"]');
  totalTh.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(plugin._sortState).toEqual({ field: 'total', dir: 'desc' });
});

test('Sort: clicking the Count column header sets sort to count desc on first click', () => {
  const { plugin, host } = makePlugin();
  seedThreeGroups(plugin);

  const countTh = host.querySelector('[data-sort-field="count"]');
  countTh.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(plugin._sortState).toEqual({ field: 'count', dir: 'desc' });
});

test('Sort: clicking a label column header sets sort asc on first click, then toggles', () => {
  const { plugin, host } = makePlugin();
  seedThreeGroups(plugin);

  // The first group-by field for ordinary-income-by-source is 'actionType'.
  let labelTh = host.querySelector('[data-sort-field="actionType"]');
  labelTh.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(plugin._sortState).toEqual({ field: 'actionType', dir: 'asc' });

  // Toggle to desc — re-query after re-render so we click the live element.
  labelTh = host.querySelector('[data-sort-field="actionType"]');
  labelTh.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(plugin._sortState).toEqual({ field: 'actionType', dir: 'desc' });
});

test('Sort: group rows are rendered in the order dictated by _sortState', () => {
  const { plugin, host } = makePlugin();
  // Seed groups: WAGES=1000, INTEREST=250, DIVIDEND=750
  // Explicitly start with total desc so the initial render is sorted.
  plugin._activeReportId = 'ordinary-income-by-source';
  plugin._journal = { journal: [{}] };
  plugin._sortState = { field: 'total', dir: 'desc' };
  plugin._groups = [
    { key: { actionType: 'WAGES'    }, count: 2, total: 1000, items: [] },
    { key: { actionType: 'INTEREST' }, count: 1, total:  250, items: [] },
    { key: { actionType: 'DIVIDEND' }, count: 3, total:  750, items: [] },
  ];
  plugin._grandTotal = 2000;
  plugin._renderResults();

  const labels = () => [...host.querySelectorAll('.jr-group-label')].map(el => el.textContent);
  // total desc: 1000, 750, 250
  expect(labels()).toEqual(['WAGES', 'DIVIDEND', 'INTEREST']);

  // Click total (active desc) → toggles to asc: 250, 750, 1000
  host.querySelector('[data-sort-field="total"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(labels()).toEqual(['INTEREST', 'DIVIDEND', 'WAGES']);
});

test('Sort: _sortState is preserved when a facet changes (sort column survives query re-run)', () => {
  const { plugin, host } = makePlugin();
  seedThreeGroups(plugin);

  // Sort by count desc
  host.querySelector('[data-sort-field="count"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(plugin._sortState.field).toBe('count');

  // Simulate facet change triggering _runQuery (we stub it to re-seed groups
  // then re-render, just like a real query would).
  plugin._groups = [
    { key: { actionType: 'WAGES'    }, count: 5, total: 2000, items: [] },
    { key: { actionType: 'INTEREST' }, count: 2, total:  500, items: [] },
  ];
  plugin._renderResults();

  // Sort state should still be count desc after re-render.
  expect(plugin._sortState).toEqual({ field: 'count', dir: 'desc' });
  const labels = [...host.querySelectorAll('.jr-group-label')].map(el => el.textContent);
  expect(labels).toEqual(['WAGES', 'INTEREST']);  // count 5, 2 → desc
});

test('Sort: active sort column shows directional indicator in header; inactive shows neutral', () => {
  const { plugin, host } = makePlugin();
  plugin._sortState = { field: 'total', dir: 'desc' };
  seedThreeGroups(plugin);

  const totalTh = host.querySelector('[data-sort-field="total"]');
  const countTh = host.querySelector('[data-sort-field="count"]');
  expect(totalTh.querySelector('.jr-sort-icon--desc')).not.toBeNull();
  expect(countTh.querySelector('.jr-sort-icon--neutral')).not.toBeNull();
});

test('Period facet: JOURNAL_REPORT_OPEN with non-enumerated period injects a transient option', () => {
  const { plugin, host, runtime } = makePlugin();
  // The journal has us-25 + us-26 settles, but the drill targets a one-off
  // entry that isn't one of them.
  const oddEntry = { id: 'us-odd', date: new Date(Date.UTC(2024, 5, 1)) };
  plugin._journal = { journal: [oddEntry] };
  plugin._api = {
    listSettledPeriods: () => [
      { fromEntryId: null,    toEntryId: 'us-25', toEntryDate: new Date(Date.UTC(2025, 11, 31)), label: 'CY 2025' },
    ],
    currentInProgressPeriod: () => null,
  };
  plugin._diffApi = plugin._personApi = plugin._api;
  plugin._runQuery = async () => {};

  runtime.bus.publish({
    type:     WB_EVENTS.JOURNAL_REPORT_OPEN,
    reportId: 'ordinary-income-by-source',
    params:   { cc: 'US', period: { fromEntryId: null, toEntryId: 'us-odd' } },
  });

  const periodSel = host.querySelector('select[data-facet="period"]');
  const labels    = [...periodSel.options].map(o => o.textContent);
  expect(labels[0]).toMatch(/^Custom \(/);
  expect(periodSel.value).toBe('__transient__:us-odd');
  expect(plugin._facetValues.period).toEqual({ fromEntryId: null, toEntryId: 'us-odd' });
});

// ─── _fmtMoney: cc-aware display-currency conversion (design 10 §Phase 4) ───────

import { StateSchemaRegistry } from '../../src/finance/services/state-schema-registry.js';
import { CurrencyConverter }   from '../../src/finance/fx/currency-converter.js';

function wiredReg(displayCurrency, rate = 1.5) {
  const reg = new StateSchemaRegistry();
  reg.currencyConverter = new CurrencyConverter();
  reg.displaySettings   = { displayCurrency };
  reg.rateStateProvider = () => ({ effectiveExchangeRates: { USD_AUD: rate } });
  return reg;
}

test('_fmtMoney: US report (cc=US) converts USD → AUD with sign', () => {
  const { plugin } = makePlugin();
  plugin.setServices({ schemaRegistry: wiredReg('AUD', 1.5) });
  plugin._facetValues = { cc: 'US' };
  expect(plugin._fmtMoney(1000)).toContain('A$1,500.00');
  expect(plugin._fmtMoney(1000).startsWith('+')).toBe(true);
  expect(plugin._fmtMoney(-1000).startsWith('-')).toBe(true);
});

test('_fmtMoney: AU report (cc=AU) stays native in AUD display', () => {
  const { plugin } = makePlugin();
  plugin.setServices({ schemaRegistry: wiredReg('AUD', 1.5) });
  plugin._facetValues = { cc: 'AU' };
  expect(plugin._fmtMoney(2000)).toContain('A$2,000.00');
});

test('_fmtMoney: AU report converts AUD → USD when display is USD', () => {
  const { plugin } = makePlugin();
  plugin.setServices({ schemaRegistry: wiredReg('USD', 1.5) });
  plugin._facetValues = { cc: 'AU' };
  expect(plugin._fmtMoney(1500)).toContain('$1,000.00');
});

test('_fmtMoney: null renders em dash', () => {
  const { plugin } = makePlugin();
  expect(plugin._fmtMoney(null)).toBe('—');
});
