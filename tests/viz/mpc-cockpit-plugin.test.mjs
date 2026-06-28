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

test('MpcCockpitPlugin: lever select lists both built-in controls', () => {
  const el = new MpcCockpitPlugin(fakeRuntime()).render();
  const opts = [...el.querySelectorAll('[data-mpc="control"] option')].map(o => o.value);
  assert.deepStrictEqual(opts.sort(), ['ROTH', 'SPENDING']);
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
