/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import { MpcCockpitPlugin } from '../../src/visualization/workbench/plugins/finance/mpc-cockpit-plugin.js';
import { COCKPIT_CONTROLS } from '../../src/finance/mpc/cockpit-controller.js';
import { Graph } from '../../src/graph/graph.js';
import { recordDecisionRecord } from '../../src/finance/mpc/apply-forward.js';

const fakeRuntime = () => ({ bus: { subscribe() {} } });

function mountPlugin() {
  const plugin = new MpcCockpitPlugin(fakeRuntime());
  plugin.setServices({});                    // no services → controller stays null (safe)
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  return plugin;
}

// ─── render structure ───────────────────────────────────────────────────────

test('MpcCockpitPlugin.render: root + toolbar selects + action buttons', () => {
  const el = new MpcCockpitPlugin(fakeRuntime()).render();
  assert.ok(el.classList.contains('mpc-cockpit'), 'root has mpc-cockpit class');
  assert.ok(el.querySelector('[data-mpc="control"]'),  'lever select');
  assert.ok(el.querySelector('[data-mpc="objective"]'),'goal select');
  assert.ok(el.querySelector('[data-mpc="solver"]'),   'solver select');
  assert.ok(el.querySelector('[data-mpc="advise"]'),   'advise button');
  assert.ok(el.querySelector('[data-mpc="advance"]'),  'advance button');
  assert.ok(el.querySelector('[data-mpc="auto"]'),     'auto button');
});

test('MpcCockpitPlugin: lever select lists the built-in controls', () => {
  const el = new MpcCockpitPlugin(fakeRuntime()).render();
  const opts = [...el.querySelectorAll('[data-mpc="control"] option')].map(o => o.value);
  assert.deepStrictEqual(opts.sort(), ['ALLOCATION_MIX', 'BOND_LADDER', 'DRAWDOWN_SLEEVE', 'DRAWDOWN_WEIGHTS', 'DRAWDOWN_WITHINTIER', 'DRAWDOWN_XBORDER', 'EARLY_WITHDRAWAL', 'ROTH', 'SPENDING']);
});

// ─── multi-lever selection (design 45 §8 / Phase 4) ──────────────────────────

test('MpcCockpitPlugin: lever select is multi-select with Spending selected by default', () => {
  const plugin = mountPlugin();
  const sel = plugin._q('control');
  assert.equal(sel.multiple, true, 'multi-select widget');
  assert.deepStrictEqual([...sel.selectedOptions].map(o => o.value), ['SPENDING']);
  assert.deepStrictEqual(plugin._currentControls().map(c => c.key), ['SPENDING']);
  assert.equal(plugin._isMultiLever(), false);
});

test('MpcCockpitPlugin: selecting several levers yields a joint control set', () => {
  const plugin = mountPlugin();
  const sel = plugin._q('control');
  for (const o of sel.options) o.selected = ['ROTH', 'EARLY_WITHDRAWAL'].includes(o.value);
  assert.deepStrictEqual(plugin._currentControls().map(c => c.key), ['ROTH', 'EARLY_WITHDRAWAL']);
  assert.equal(plugin._isMultiLever(), true);
});

test('MpcCockpitPlugin: multi-lever swaps the shared row for a per-lever range editor', () => {
  const plugin = mountPlugin();
  const sel = plugin._q('control');
  for (const o of sel.options) o.selected = ['SPENDING', 'ROTH'].includes(o.value);
  plugin._syncRangeEnabled();
  // Shared single-lever row hidden; the per-lever editor shown.
  assert.equal(plugin._q('range-row').style.display, 'none');
  const editor = plugin._q('range-multi');
  assert.equal(editor.style.display, '');
  // One row per selected NUMERIC lever (both SPENDING and ROTH are numeric), each
  // seeded from the lever's defaultRange with its own Min/Max/Step inputs.
  const rows = [...editor.querySelectorAll('[data-mpc-lever]')];
  assert.deepStrictEqual(rows.map(r => r.dataset.mpcLever), ['SPENDING', 'ROTH']);
  const rothRow = rows.find(r => r.dataset.mpcLever === 'ROTH');
  assert.equal(Number(rothRow.querySelector('[data-r="max"]').value), COCKPIT_CONTROLS.ROTH.defaultRange.max);
});

test('MpcCockpitPlugin: per-lever range editor lists categorical levers as no-range + reads back ranges', () => {
  const plugin = mountPlugin();
  const sel = plugin._q('control');
  // A numeric lever (SPENDING) + a categorical one (DRAWDOWN_XBORDER, no range).
  for (const o of sel.options) o.selected = ['SPENDING', 'DRAWDOWN_XBORDER'].includes(o.value);
  plugin._syncRangeEnabled();
  const editor = plugin._q('range-multi');
  const rows = [...editor.querySelectorAll('[data-mpc-lever]')];
  assert.deepStrictEqual(rows.map(r => r.dataset.mpcLever), ['SPENDING']);   // only the numeric one
  assert.match(editor.querySelector('.mpc-hint').textContent, /categorical/i);
  // Editing a row's inputs is read back by _currentControlRanges (min<max enforced).
  const row = rows[0];
  row.querySelector('[data-r="min"]').value = '9000';
  row.querySelector('[data-r="max"]').value = '4000';
  row.querySelector('[data-r="step"]').value = '250';
  const ranges = plugin._currentControlRanges();
  assert.deepStrictEqual(ranges.SPENDING, { min: 4000, max: 9000, step: 250 });   // swapped to min<max
});

test('MpcCockpitPlugin: a joint search requires every selected lever to apply (reports the first inert)', () => {
  const plugin = mountPlugin();   // no active scenario ⇒ baseParams {} ⇒ Roth/EarlyWithdrawal inert
  const sel = plugin._q('control');
  for (const o of sel.options) o.selected = ['ROTH', 'EARLY_WITHDRAWAL'].includes(o.value);
  const applies = plugin._leverApplies();
  assert.equal(applies.ok, false);
  assert.equal(applies.label, COCKPIT_CONTROLS.ROTH.label);   // first selected inert lever
});

test('MpcCockpitPlugin: Horizon field enables for windowable goals, disables + hints otherwise (design 41)', () => {
  const plugin = mountPlugin();
  const input = plugin._q('horizon');
  assert.ok(input, 'horizon field rendered');

  // A windowable goal (terminal-stock maximizer) enables the window.
  plugin._q('objective').value = 'MAX_AFTER_TAX_NET_WORTH';
  plugin._q('objective').dispatchEvent(new Event('change'));
  assert.equal(input.disabled, false, 'windowable goal enables the horizon field');

  // Switching to a non-windowable goal disables the field, clears the stale value
  // (so a greyed-out "8" doesn't read as an active horizon), and hints why.
  input.value = '8';
  plugin._q('objective').value = 'MIN_LIFETIME_TAXES';
  plugin._q('objective').dispatchEvent(new Event('change'));
  assert.equal(input.disabled, true, 'non-windowable goal disables the horizon field');
  assert.equal(input.value, '', 'stale window value is reset to Full');
  assert.match(plugin._q('horizon-field').title, /full horizon/i);

  // The family (die-with-target) is death-anchored → not windowable.
  plugin._q('objective').value = 'family:DIE_WITH_TARGET';
  plugin._q('objective').dispatchEvent(new Event('change'));
  assert.equal(input.disabled, true, 'die-with-target disables the horizon field');
});

test('MpcCockpitPlugin._currentHorizon: parses positive ints, null when blank/disabled', () => {
  const plugin = mountPlugin();
  plugin._q('objective').value = 'MAX_NET_WORTH';   // windowable → enabled
  plugin._q('objective').dispatchEvent(new Event('change'));
  const input = plugin._q('horizon');
  input.value = '10';
  assert.equal(plugin._currentHorizon(), 10);
  input.value = '';
  assert.equal(plugin._currentHorizon(), null, 'blank ⇒ full horizon');
  input.value = '10';
  input.disabled = true;
  assert.equal(plugin._currentHorizon(), null, 'disabled ⇒ ignored');
});

test('MpcCockpitPlugin: objective select groups the die-with-target family with axis sub-selects', () => {
  const el = new MpcCockpitPlugin(fakeRuntime()).render();
  const opts = [...el.querySelectorAll('[data-mpc="objective"] option')].map(o => o.value);
  assert.ok(opts.includes('family:DIE_WITH_TARGET'), 'the family collapses into one grouped option');
  assert.ok(!opts.includes('CRRA_DIE_WITH_TARGET'), 'family members are not flat options');
  assert.ok(opts.includes('MAX_NET_WORTH') && opts.includes('MIN_LIFETIME_TAXES'), 'standalone goals remain');

  const running = [...el.querySelectorAll('[data-mpc="axis-running"] option')].map(o => o.value).sort();
  const scope   = [...el.querySelectorAll('[data-mpc="axis-scope"]   option')].map(o => o.value).sort();
  const basis   = [...el.querySelectorAll('[data-mpc="axis-basis"]   option')].map(o => o.value).sort();
  assert.deepStrictEqual(running, ['consumption', 'crra'],     'basis axis offers consumption + CRRA');
  assert.deepStrictEqual(scope,   ['liquid', 'worth'],          'scope axis offers worth + liquidity');
  assert.deepStrictEqual(basis,   ['afterTax', 'nominal'],      'tax-basis axis offers nominal + after-tax');
  // The Roth-lever default + after-tax maximizers are in the curated goal list.
  assert.ok(opts.includes('MAX_AFTER_TAX_NET_WORTH'), 'after-tax maximizer offered as a standalone goal');
});

test('MpcCockpitPlugin: family + axis selects resolve to the concrete objective key', () => {
  const plugin = mountPlugin();
  plugin._q('objective').value    = 'family:DIE_WITH_TARGET';
  plugin._q('axis-running').value = 'crra';
  plugin._q('axis-scope').value   = 'liquid';
  plugin._q('axis-basis').value   = 'nominal';
  plugin._syncObjectiveAxes();
  assert.equal(plugin._q('axes').style.display, '', 'axis sub-selects shown for a family goal');
  assert.equal(plugin._currentObjectiveKey(), 'CRRA_DIE_WITH_TARGET_LIQUID');

  // Flip tax-basis to after-tax → resolves to the after-tax variant.
  plugin._q('axis-basis').value = 'afterTax';
  assert.equal(plugin._currentObjectiveKey(), 'CRRA_DIE_WITH_TARGET_AFTERTAX_LIQUID');

  // A standalone goal hides the axes and resolves directly.
  plugin._q('objective').value = 'MAX_NET_WORTH';
  plugin._syncObjectiveAxes();
  assert.equal(plugin._q('axes').style.display, 'none');
  assert.equal(plugin._currentObjectiveKey(), 'MAX_NET_WORTH');
});

// ─── configurable search range ───────────────────────────────────────────────

test('MpcCockpitPlugin: render exposes min/max/step range inputs', () => {
  const el = new MpcCockpitPlugin(fakeRuntime()).render();
  assert.ok(el.querySelector('[data-mpc="rmin"]'),  'min input');
  assert.ok(el.querySelector('[data-mpc="rmax"]'),  'max input');
  assert.ok(el.querySelector('[data-mpc="rstep"]'), 'step input');
});

test('MpcCockpitPlugin._currentRange: reads inputs and orders min < max', () => {
  const plugin = mountPlugin();
  plugin._q('rmin').value  = '20000';   // intentionally inverted
  plugin._q('rmax').value  = '5000';
  plugin._q('rstep').value = '1000';
  assert.deepStrictEqual(plugin._currentRange(), { min: 5000, max: 20000, step: 1000 });
});

test('MpcCockpitPlugin: switching levers repopulates the Search Range with the lever defaultRange', () => {
  const plugin = mountPlugin();
  // Spending's range is seeded on mount.
  assert.deepStrictEqual(plugin._currentRange(), { min: 3000, max: 12000, step: 500 });

  // Switching to Roth repopulates with the income-target range (real base-year USD),
  // not the stale Spending defaults.
  plugin._q('control').value = 'ROTH';
  plugin._applyControlDefaultRange();
  const r = plugin._currentRange();
  assert.equal(r.min,  COCKPIT_CONTROLS.ROTH.defaultRange.min);
  assert.equal(r.max,  COCKPIT_CONTROLS.ROTH.defaultRange.max);
  assert.equal(r.step, COCKPIT_CONTROLS.ROTH.defaultRange.step);

  // …and back to Spending restores its range.
  plugin._q('control').value = 'SPENDING';
  plugin._applyControlDefaultRange();
  assert.deepStrictEqual(plugin._currentRange(), { min: 3000, max: 12000, step: 500 });
});

test('MpcCockpitPlugin: range inputs enabled for the numeric levers (Roth + Spending)', () => {
  const plugin = mountPlugin();
  // Roth is now a continuous income-target lever (design 39 §12 / Step 9), so
  // the range inputs apply just like Spending.
  plugin._q('control').value = 'ROTH';
  plugin._syncRangeEnabled();
  assert.equal(plugin._q('rmin').disabled, false, 'range enabled for the continuous Roth lever');
  plugin._q('control').value = 'SPENDING';
  plugin._syncRangeEnabled();
  assert.equal(plugin._q('rmin').disabled, false, 'range enabled for the Spending lever');
});

// ─── Phase A: Advance drives the live clock via TimeControls ─────────────────

test('MpcCockpitPlugin._advance: steps the live sim +1yr through TimeControls', () => {
  const calls = [];
  const plugin = new MpcCockpitPlugin({ bus: { subscribe() {} }, timeControls: { stepToDate: (d) => calls.push(new Date(d)) } });
  plugin.setServices({ scenarioService: { getActive: () => ({ simEnd: '2070-01-01T00:00:00.000Z' }) } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  plugin._sim = { currentDate: new Date(Date.UTC(2034, 0, 1)) };

  plugin._advance();
  assert.equal(calls.length, 1, 'TimeControls.stepToDate called once');
  assert.equal(calls[0].getUTCFullYear(), 2035, 'advanced one year on the real clock');
});

test('MpcCockpitPlugin._advance: clamps to simEnd', () => {
  const calls = [];
  const plugin = new MpcCockpitPlugin({ bus: { subscribe() {} }, timeControls: { stepToDate: (d) => calls.push(new Date(d)) } });
  plugin.setServices({ scenarioService: { getActive: () => ({ simEnd: '2034-06-01T00:00:00.000Z' }) } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  plugin._sim = { currentDate: new Date(Date.UTC(2034, 0, 1)) };

  plugin._advance();
  assert.equal(+calls[0], Date.parse('2034-06-01T00:00:00.000Z'), 'does not step past simEnd');
});

// ─── auto mode (autopilot toggle) ────────────────────────────────────────────

test('MpcCockpitPlugin._setAutoButton: toggles label + disables manual controls', () => {
  const plugin = mountPlugin();
  plugin._setAutoButton(true);
  assert.match(plugin._q('auto').textContent, /Stop/, 'button reads Stop while running');
  assert.equal(plugin._q('advise').disabled, true, 'advise disabled during auto');
  assert.equal(plugin._q('advance').disabled, true, 'advance disabled during auto');
  plugin._setAutoButton(false);
  assert.match(plugin._q('auto').textContent, /Auto/, 'button reverts to Auto when stopped');
  assert.equal(plugin._q('advise').disabled, false, 'advise re-enabled when stopped');
});

test('MpcCockpitPlugin._auto: a second call while running requests a stop with "Stopping…" feedback', async () => {
  const plugin = mountPlugin();
  plugin._setAutoButton(true);           // running state (button reads "Stop ⏹")
  plugin._autoRunning = true;            // simulate a running loop
  await plugin._auto();                  // toggle → request stop
  assert.equal(plugin._autoRunning, false, 'second invocation stops the autopilot');
  const btn = plugin._q('auto');
  assert.match(btn.textContent, /Stopping/, 'button shows the stop-in-progress label');
  assert.equal(btn.disabled, true, 'button disables to block double-clicks while stopping');
  assert.ok(btn.classList.contains('mpc-stopping'), 'button pulses (mpc-stopping) while stopping');
});

test('MpcCockpitPlugin._setAutoButton(false): clears the "Stopping…" state once the loop settles', () => {
  const plugin = mountPlugin();
  plugin._beginStop();                   // mid-stop affordance
  plugin._setAutoButton(false);          // loop's finally settles it
  const btn = plugin._q('auto');
  assert.match(btn.textContent, /Auto/, 'reverts to Auto when fully stopped');
  assert.equal(btn.disabled, false, 're-enabled');
  assert.equal(btn.classList.contains('mpc-stopping'), false, 'pulse cleared');
});

test('MpcCockpitPlugin._advance: no-op while the autopilot is running', () => {
  const calls = [];
  const plugin = new MpcCockpitPlugin({ bus: { subscribe() {} }, timeControls: { stepToDate: (d) => calls.push(d) } });
  plugin.setServices({ scenarioService: { getActive: () => ({ simEnd: '2070-01-01T00:00:00.000Z' }) } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  plugin._sim = { currentDate: new Date(Date.UTC(2034, 0, 1)) };
  plugin._autoRunning = true;

  plugin._advance();
  assert.equal(calls.length, 0, 'manual Advance is ignored while autopilot owns the clock');
});

// ─── advice rendering (synthetic payload — no sims) ──────────────────────────

function syntheticAdvice() {
  const dates = [new Date(Date.UTC(2030, 0, 1)), new Date(Date.UTC(2035, 0, 1)), new Date(Date.UTC(2040, 0, 1))];
  return {
    now: { date: dates[0], netWorth: 1_000_000 },
    recommended: {
      candidate: { 'spendingExpenseBands[0].monthlyAmount': 6000 },
      result: { finalNetWorthUsd: 1_250_000, terminalWealthTarget: 0 },
      label: 'Set monthly spend to $6,000',
    },
    candidates: [],
    variables: [{ paramKey: 'spendingExpenseBands[0].monthlyAmount' }],
    fan: [
      { candidate: {}, dates, netWorth: [1_000_000, 1_100_000, 1_250_000], recommended: true  },
      { candidate: {}, dates, netWorth: [1_000_000,   900_000,   700_000], recommended: false },
      { candidate: {}, dates, netWorth: [1_000_000, 1_050_000, 1_150_000], recommended: false },
    ],
  };
}

test('MpcCockpitPlugin._renderAdvice: shows the move card + projected outcome', () => {
  const plugin = mountPlugin();
  plugin._controller = { lastAdvice: syntheticAdvice() };
  plugin._renderAdvice(syntheticAdvice());

  assert.equal(plugin._q('card').style.display, '', 'card is shown');
  assert.match(plugin._q('move').textContent, /\$6,000/, 'move label rendered');
  assert.match(plugin._q('outcome').innerHTML, /1,250,000/, 'projected terminal net worth rendered');
});

test('MpcCockpitPlugin._renderFan: draws one path per fan line, recommended highlighted', () => {
  const plugin = mountPlugin();
  plugin._renderFan(syntheticAdvice().fan);
  const paths = plugin._q('fan').querySelectorAll('path');
  assert.equal(paths.length, 3, 'one polyline per candidate future');
  const rec = plugin._q('fan').querySelectorAll('path.mpc-line--rec');
  assert.equal(rec.length, 1, 'exactly one recommended path is highlighted');
});

test('MpcCockpitPlugin._renderFan: empty fan clears the host without error', () => {
  const plugin = mountPlugin();
  plugin._renderFan([]);
  assert.equal(plugin._q('fan').innerHTML, '');
});

// ─── lever applicability (strategy-aware gating) ─────────────────────────────

function mountWithStrategy(strategy) {
  const plugin = new MpcCockpitPlugin(fakeRuntime());
  plugin.setServices({ scenarioService: { getActive: () => ({ params: [{ key: 'spendingStrategy', value: strategy }] }) } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  plugin._sim = {};   // a scenario/sim is present
  return plugin;
}

test('MpcCockpitPlugin: Spending lever disabled + warned when strategy lacks EXPLICIT_BANDS', () => {
  const plugin = mountWithStrategy(['AGE_BANDED']);
  plugin._syncLeverApplicability();
  assert.equal(plugin._q('advise').disabled, true, 'Advise disabled');
  assert.match(plugin._q('now').textContent, /EXPLICIT_BANDS/, 'tells the user what to switch');
});

test('MpcCockpitPlugin: Spending lever enabled when EXPLICIT_BANDS is active', () => {
  const plugin = mountWithStrategy(['EXPLICIT_BANDS']);
  plugin._syncLeverApplicability();
  assert.equal(plugin._q('advise').disabled, false, 'Advise enabled');
});

// ─── Phase B: Apply actuates the live plan ───────────────────────────────────

test('MpcCockpitPlugin._apply: actuates a live-actuatable control and reports it', () => {
  const plugin = mountPlugin();
  let actuateCalled = false;
  const control = {
    liveActuatable: true,
    label: 'Monthly Spending',
    describe: () => 'Set monthly spend to $9,000',
    actuate: () => { actuateCalled = true; return true; },
  };
  plugin._controller = {
    control,
    lastAdvice: { recommended: { candidate: { k: 9000 } }, variables: [{ paramKey: 'k' }] },
    apply: () => ({ result: { finalNetWorthUsd: 1 } }),
    describeMove: (cand, vars) => control.describe(cand, vars),
  };
  plugin._apply();
  assert.equal(actuateCalled, true, 'control.actuate invoked');
  assert.match(plugin._q('now').textContent, /Applied to the live plan/);
});

test('MpcCockpitPlugin._apply: reports when the control is not live-actuatable', () => {
  const plugin = mountPlugin();
  const control = {
    liveActuatable: false,
    label: 'Roth Conversion Ceiling',
    describe: () => 'x',
    actuate: () => false,
  };
  plugin._controller = {
    control,
    lastAdvice: { recommended: { candidate: {} }, variables: [] },
    apply: () => ({ result: { finalNetWorthUsd: 5 } }),
  };
  plugin._apply();
  assert.match(plugin._q('now').textContent, /isn.t live-actuatable yet/);
});

// ─── MPC Save Points (decision log, Step 5c) ─────────────────────────────────

test('MpcCockpitPlugin: save-points section hidden when there are no decision records', () => {
  const plugin = mountPlugin();   // services {} → no graph
  assert.equal(plugin._q('savepoints').style.display, 'none', 'hidden with an empty log');
  assert.equal(plugin._q('savepoints-list').innerHTML, '');
});

test('MpcCockpitPlugin._renderSavePoints: lists decision records from the decision layer, newest-first order', () => {
  const graph = new Graph();
  graph.addNode({ id: 'p:base', layer: 'scenario', name: 'Base' });
  recordDecisionRecord({
    graph, parentId: 'p:base', id: 'mpc:0:1',
    name: 'Set monthly spend to $6,000', asOfDate: new Date(Date.UTC(2030, 0, 1)),
    result: { finalNetWorthUsd: 1_250_000, finalNetLiquidity: 800_000 },
    extra: { goalMetric: { key: 'finalNetLiquidity', label: 'Net Liquidity' } },
  });
  recordDecisionRecord({
    graph, parentId: 'p:base', id: 'mpc:1:2',
    name: 'Set monthly spend to $5,000', asOfDate: new Date(Date.UTC(2031, 0, 1)),
    result: { finalNetWorthUsd: 1_400_000 },
  });

  const plugin = new MpcCockpitPlugin(fakeRuntime());
  plugin.setServices({ graph });
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);   // onMount calls _renderSavePoints

  const wrap = plugin._q('savepoints');
  assert.equal(wrap.style.display, '', 'section shown when records exist');
  // Data rows only (exclude the header row).
  const rows = plugin._q('savepoints-list').querySelectorAll('.mpc-savepoint:not(.mpc-savepoint--head)');
  assert.equal(rows.length, 2, 'one row per decision record');
  // Oldest "now" first (sorted by asOfDate).
  assert.match(rows[0].querySelector('.mpc-sp-date').textContent, /2030/);
  assert.match(rows[0].querySelector('.mpc-sp-move').textContent, /\$6,000/);
  assert.match(rows[0].querySelector('.mpc-sp-nw').textContent, /1,250,000/);
  assert.match(rows[1].querySelector('.mpc-sp-date').textContent, /2031/);
  // Goal-metric column: shows the goal's own metric (Net Liquidity) beside net worth.
  assert.match(rows[0].querySelector('.mpc-sp-goal').textContent, /Net Liquidity/);
  assert.match(rows[0].querySelector('.mpc-sp-goal').textContent, /800,000/);
  // A record whose goal metric IS net worth shows no redundant goal value.
  assert.ok(rows[1].querySelector('.mpc-sp-goal--na'), 'net-worth goal needs no extra column');
  // The header row labels the value columns.
  assert.ok(plugin._q('savepoints-list').querySelector('.mpc-savepoint--head'), 'header row rendered');
});

test('MpcCockpitPlugin: Clear button empties the decision layer and re-renders the log', () => {
  const graph = new Graph();
  graph.addNode({ id: 'p:base', layer: 'scenario', name: 'Base' });
  recordDecisionRecord({
    graph, parentId: 'p:base', id: 'mpc:0:1',
    name: 'Set monthly spend to $6,000', asOfDate: new Date(Date.UTC(2030, 0, 1)),
    result: { finalNetWorthUsd: 1_250_000 },
  });

  const plugin = new MpcCockpitPlugin(fakeRuntime());
  plugin.setServices({ graph });
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);   // onMount renders the one record + binds the Clear button

  assert.equal(plugin._q('savepoints').style.display, '', 'section shown with a record');
  assert.equal(
    plugin._q('savepoints-list').querySelectorAll('.mpc-savepoint:not(.mpc-savepoint--head)').length, 1);

  plugin._q('clear-savepoints').dispatchEvent(new Event('click'));

  // The decision layer is emptied (other layers untouched) and the section collapses.
  assert.equal(graph.byLayer('decision').length, 0, 'decision records cleared');
  assert.ok(graph.getNode('p:base'), 'scenario layer untouched');
  assert.equal(plugin._q('savepoints').style.display, 'none', 'section hidden once empty');
  assert.equal(plugin._q('savepoints-list').innerHTML, '');
});

// ─── override parsing ────────────────────────────────────────────────────────

test('MpcCockpitPlugin._overrideCandidate: maps the input to the recommended control key', () => {
  const plugin = mountPlugin();
  plugin._controller = { lastAdvice: { variables: [{ paramKey: 'spendingExpenseBands[0].monthlyAmount' }] } };
  plugin._q('override').value = '7500';
  assert.deepStrictEqual(plugin._overrideCandidate(), { 'spendingExpenseBands[0].monthlyAmount': 7500 });
});

test('MpcCockpitPlugin._overrideCandidate: blank input ⇒ null (use recommendation)', () => {
  const plugin = mountPlugin();
  plugin._controller = { lastAdvice: { variables: [{ paramKey: 'k' }] } };
  plugin._q('override').value = '';
  assert.equal(plugin._overrideCandidate(), null);
});

// ─── harvest: copy the run back into the scenario (design 39 §13) ────────────

/** A cockpit whose services carry a graph + an active scenario we can harvest into. */
function mountHarvestPlugin({ params = [], persons = [{ birthDate: '1978-04-15' }] } = {}) {
  const graph = new Graph();
  const scenario = {
    id: 'u:1', name: 'Test', params, persons,
    simStart: '2026-01-01', simEnd: '2046-01-01',
  };
  const published = [];
  const plugin = new MpcCockpitPlugin({ bus: { subscribe() {}, publish: (e) => published.push(e) } });
  plugin.setServices({ graph, scenarioService: { getActive: () => scenario } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  return { plugin, graph, scenario, published };
}

function addSpendingEpoch(graph, { year, amount, runId = 'run:test' }) {
  recordDecisionRecord({
    graph, id: `mpc:${year}`, runId,
    asOfDate: new Date(Date.UTC(year, 5, 1)),
    controlParams: { 'spendingExpenseBands[0].monthlyAmount': amount },
    controlKeys: ['SPENDING'],
    controlVars: [{ paramKey: 'spendingExpenseBands[0].monthlyAmount', _bandIndex: 0, _controlKey: 'SPENDING' }],
    name: `spend ${amount}`,
  });
}

test('MpcCockpitPlugin: the harvest button renders and starts disabled', () => {
  const { plugin } = mountHarvestPlugin();
  const btn = plugin._q('harvest');
  assert.ok(btn, 'copy-to-scenario button');
  assert.equal(btn.disabled, true, 'nothing to copy yet');
});

test('MpcCockpitPlugin: the harvest button enables once the session has decisions', () => {
  const { plugin, graph } = mountHarvestPlugin();
  addSpendingEpoch(graph, { year: 2030, amount: 6000 });
  plugin._syncHarvestEnabled();
  assert.equal(plugin._q('harvest').disabled, false);
});

test('MpcCockpitPlugin: opening the harvest renders the reviewable diff, writing nothing', async () => {
  const params = [{ name: 'spendingExpenseBands', type: 'ExpenseBandList', value: [] },
                  { name: 'spendingStrategy', type: 'EnumMulti', value: ['FIXED'] }];
  const { plugin, graph, scenario } = mountHarvestPlugin({ params });
  addSpendingEpoch(graph, { year: 2030, amount: 6000 });
  addSpendingEpoch(graph, { year: 2031, amount: 8000 });

  await plugin._openHarvest();

  assert.notEqual(plugin._q('harvest-panel').style.display, 'none', 'panel is shown');
  const body = plugin._q('harvest-body').textContent;
  assert.match(body, /spendingExpenseBands/);
  assert.match(body, /SCHEDULE/);
  assert.match(body, /ENABLE/, 'the enabling param flip is shown before approval');
  // Nothing written yet — review first (§13.8).
  assert.deepStrictEqual(scenario.params.find(p => p.name === 'spendingExpenseBands').value, []);
  assert.deepStrictEqual(scenario.params.find(p => p.name === 'spendingStrategy').value, ['FIXED']);
});

test('MpcCockpitPlugin: applying the harvest writes the params and publishes PARAMS_CHANGED', async () => {
  const params = [{ name: 'spendingExpenseBands', type: 'ExpenseBandList', value: [] },
                  { name: 'spendingStrategy', type: 'EnumMulti', value: ['FIXED'] }];
  const { plugin, graph, scenario, published } = mountHarvestPlugin({ params });
  addSpendingEpoch(graph, { year: 2030, amount: 6000 });
  addSpendingEpoch(graph, { year: 2031, amount: 8000 });

  await plugin._openHarvest();
  plugin._applyHarvest();

  const bands = scenario.params.find(p => p.name === 'spendingExpenseBands').value;
  assert.deepStrictEqual(bands, [
    { startAge: 52, monthlyAmount: 6000 },
    { startAge: 53, monthlyAmount: 8000 },
  ]);
  // The enabling param rode along, without dropping the user's other strategy.
  assert.deepStrictEqual(scenario.params.find(p => p.name === 'spendingStrategy').value,
    ['FIXED', 'EXPLICIT_BANDS']);
  assert.equal(scenario.harvestedFrom.runId, 'run:test');
  assert.ok(published.some(e => e.type === 'workbench.scenario.params.changed'),
    'the Scenario panel is told to re-render');
  assert.equal(plugin._q('harvest-panel').style.display, 'none', 'panel closes after applying');
});

test('MpcCockpitPlugin: the harvest does NOT rebuild or save', async () => {
  const { plugin, graph, scenario } = mountHarvestPlugin({
    params: [{ name: 'spendingExpenseBands', type: 'ExpenseBandList', value: [] }],
  });
  addSpendingEpoch(graph, { year: 2030, amount: 6000 });
  await plugin._openHarvest();
  plugin._applyHarvest();
  // The confirmation tells the user what to do next rather than doing it for them.
  assert.match(plugin._q('now').textContent, /Rebuild to run it, then Save/);
  assert.equal(scenario.rebuilt, undefined);
});

test('MpcCockpitPlugin: cancel closes the panel and discards the plan', async () => {
  const { plugin, graph } = mountHarvestPlugin({
    params: [{ name: 'spendingExpenseBands', type: 'ExpenseBandList', value: [] }],
  });
  addSpendingEpoch(graph, { year: 2030, amount: 6000 });
  await plugin._openHarvest();
  plugin._closeHarvest();
  assert.equal(plugin._q('harvest-panel').style.display, 'none');
  assert.equal(plugin._harvestPlan, null);
});

test('MpcCockpitPlugin: a POINT lever shows its collapse warning in the review', async () => {
  const { plugin, graph } = mountHarvestPlugin({ params: [] });
  for (const [i, mode] of ['GLOBAL', 'LOCAL_FIRST', 'GLOBAL'].entries()) {
    recordDecisionRecord({
      graph, id: `mpc:x${i}`, runId: 'run:test',
      asOfDate: new Date(Date.UTC(2030 + i, 0, 1)),
      controlParams: { crossBorderDrawdown: mode },
      controlKeys: ['DRAWDOWN_XBORDER'],
      controlVars: [{ paramKey: 'crossBorderDrawdown', _controlKey: 'DRAWDOWN_XBORDER' }],
    });
  }
  await plugin._openHarvest();
  const body = plugin._q('harvest-body').textContent;
  assert.match(body, /POINT/);
  assert.match(body, /changed in 2 of 3 epochs/);
  assert.match(body, /open-loop/, 'the fidelity caveat is on the panel, not just the doc');
});

test('MpcCockpitPlugin: run identity is minted lazily and ended by a lever change', () => {
  const { plugin } = mountHarvestPlugin();
  const first = plugin._currentRunId();
  assert.equal(plugin._currentRunId(), first, 'stable within a run');
  // Changing the lever set ends the run — those epochs aren't one schedule.
  plugin._endRun();
  assert.notEqual(plugin._currentRunId(), first);
});

test('MpcCockpitPlugin: harvest targets the newest run, not a blend of runs', async () => {
  const { plugin, graph } = mountHarvestPlugin({
    params: [{ name: 'spendingExpenseBands', type: 'ExpenseBandList', value: [] }],
  });
  addSpendingEpoch(graph, { year: 2030, amount: 1111, runId: 'run:old' });
  addSpendingEpoch(graph, { year: 2035, amount: 2222, runId: 'run:new' });
  await plugin._openHarvest();
  assert.equal(plugin._harvestPlan.runId, 'run:new');
  assert.equal(plugin._harvestPlan.epochs, 1);
});

// ─── design 80 F1: feasibility is a GATE on the harvest, not a warning ───────

/** Mount a harvest-capable cockpit with the F1 check stubbed to a fixed verdict. */
function mountGatedPlugin(feasibility, opts = {}) {
  const mounted = mountHarvestPlugin(opts);
  mounted.checks = [];
  mounted.plugin._checkFeasibility = (args) => { mounted.checks.push(args); return feasibility; };
  return mounted;
}

const RUINED = {
  feasible: false, shortfall: 5_705_589, cumulativeDeficit: 5_705_589, deficitMonths: 194,
  scenarioFailed: true, outOfFundsDate: new Date(Date.UTC(2051, 3, 30)), result: {}, params: {}, error: null,
};
const SOLVENT = {
  feasible: true, shortfall: 0, cumulativeDeficit: 0, deficitMonths: 0,
  scenarioFailed: false, outOfFundsDate: null, result: {}, params: {}, error: null,
};

test('MpcCockpitPlugin: an infeasible harvest BLOCKS the copy and names the ruin date', async () => {
  const { plugin, graph } = mountGatedPlugin(RUINED, {
    params: [{ name: 'spendingExpenseBands', type: 'ExpenseBandList', value: [] }],
  });
  addSpendingEpoch(graph, { year: 2030, amount: 9941 });
  await plugin._openHarvest();

  assert.equal(plugin._q('harvest-apply').disabled, true, 'copy is blocked, not merely warned about');
  const body = plugin._q('harvest-body').textContent;
  assert.match(body, /Infeasible/);
  assert.match(body, /runs out of money in Apr 2051/, 'the ruin DATE is named, not just a deficit');
  assert.match(body, /\$5,705,589 short over 194 month/);
  // Never expressed as a % of the goal metric (§2.6 — that number is ≈0 here).
  assert.ok(!/%/.test(body.split('open-loop')[0]), 'feasibility is not reported as a percentage');
});

test('MpcCockpitPlugin: the block is overridable, and the override is labelled with the ruin date', async () => {
  const { plugin, graph, scenario } = mountGatedPlugin(RUINED, {
    params: [{ name: 'spendingExpenseBands', type: 'ExpenseBandList', value: [] }],
  });
  addSpendingEpoch(graph, { year: 2030, amount: 9941 });
  await plugin._openHarvest();

  const field = plugin._q('harvest-override-field');
  assert.equal(field.style.display, '', 'override offered only when blocked');
  assert.match(plugin._q('harvest-override-label').textContent, /Copy anyway — this plan runs out in Apr 2051/);

  // Applying while still blocked writes nothing.
  plugin._applyHarvest();
  assert.equal(scenario.harvestedFrom, undefined, 'nothing written while blocked');

  // Ticking the override enables the copy (a truncated exploratory harvest is a
  // legitimate reason to want one — design 39 §13 H2).
  const box = plugin._q('harvest-override');
  box.checked = true;
  box.dispatchEvent(new Event('change'));
  assert.equal(plugin._q('harvest-apply').disabled, false);
  plugin._applyHarvest();
  assert.equal(scenario.harvestedFrom.runId, 'run:test', 'the override applies the plan');
});

test('MpcCockpitPlugin: a feasible harvest says so and hides the override', async () => {
  const { plugin, graph, checks, scenario } = mountGatedPlugin(SOLVENT, {
    params: [{ name: 'spendingExpenseBands', type: 'ExpenseBandList', value: [] }],
  });
  addSpendingEpoch(graph, { year: 2030, amount: 6000 });
  await plugin._openHarvest();

  assert.equal(plugin._q('harvest-apply').disabled, false);
  assert.equal(plugin._q('harvest-override-field').style.display, 'none');
  assert.match(plugin._q('harvest-body').textContent, /Solvent/);

  // The check is handed the PLAN under review plus the scenario's own horizon —
  // it must verify the same object the writer will write.
  assert.equal(checks.length, 1, 'checked once on open, not per toggle');
  assert.equal(checks[0].plan, plugin._harvestPlan);
  assert.equal(checks[0].cfgTemplate, scenario);
  assert.equal(checks[0].simEnd.getUTCFullYear(), 2046);
});

test('MpcCockpitPlugin: an unverifiable check does not veto the copy', async () => {
  // Unverifiable ≠ infeasible — a check that could not run must not silently
  // block the user's own plan.
  const { plugin, graph } = mountGatedPlugin({ ...SOLVENT, feasible: null, error: 'compile failed' });
  addSpendingEpoch(graph, { year: 2030, amount: 6000 });
  await plugin._openHarvest();
  assert.equal(plugin._q('harvest-apply').disabled, false);
  assert.match(plugin._q('harvest-body').textContent, /could not be checked/);
});

// ─── design 80 U5: budget + seed as cockpit controls ────────────────────────

test('MpcCockpitPlugin: budget and seed are exposed and feed every solve path', () => {
  const plugin = mountPlugin();
  assert.equal(Number(plugin._q('budget').value), 64, 'the app’s long-standing default');
  assert.equal(Number(plugin._q('seed').value), 1);
  assert.deepStrictEqual(plugin._solverOptions(), { budget: 64, seed: 1 });

  plugin._q('budget').value = '128';
  plugin._q('seed').value   = '7';
  assert.deepStrictEqual(plugin._solverOptions(), { budget: 128, seed: 7 });

  // Junk falls back to the defaults rather than handing the solver a NaN budget.
  plugin._q('budget').value = '';
  plugin._q('seed').value   = '-3';
  assert.deepStrictEqual(plugin._solverOptions(), { budget: 64, seed: 1 });
});

test('MpcCockpitPlugin: the evals readout reports budget per search dimension', () => {
  const plugin = mountPlugin();
  // No scenario ⇒ dimension unknown ⇒ the budget alone, no fabricated ratio.
  plugin._syncEvalsReadout();
  assert.equal(plugin._q('evals').textContent, '64 evals');

  // With a scenario the ratio is live BEFORE the first Advise, which is the point:
  // sparsity is knowable in advance, not only inferable from a bad answer after.
  plugin.setServices({ scenarioService: { getActive: () => ({
    params: [{ name: 'spendingStrategy', value: ['EXPLICIT_BANDS'] },
             { name: 'spendingExpenseBands', value: [{ startAge: 45, monthlyAmount: 5500 }] }],
  }) } });
  plugin._syncEvalsReadout();
  assert.match(plugin._q('evals').textContent, /^64 evals · 64\.0\/dim \(1 var\)$/);
  assert.equal(plugin._q('evals').classList.contains('mpc-evals--sparse'), false);

  // A low budget over the same space flags as sparse.
  plugin._q('budget').value = '4';
  plugin._q('budget').dispatchEvent(new Event('change'));
  assert.match(plugin._q('evals').textContent, /4 evals · 4\.0\/dim/);
  assert.equal(plugin._q('evals').classList.contains('mpc-evals--sparse'), true);
});
