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
 * scenario-load-error-overlay.test.mjs
 *
 * The recovery surface for a saved scenario that will not compile.
 *
 * A single mistyped weight (0.77 where 0.76 was meant) used to be unrecoverable through
 * the UI: `assertAuthoredMixes` threw during boot, main.js died, and the params editor
 * that could fix the value never rendered. The property under test is that the bad value
 * stays reachable — the overlay names it, repairs it, and refuses to reload back into
 * the same failure.
 *
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';
import { jest } from '@jest/globals';
import { showScenarioLoadError } from '../../src/visualization/scenario/scenario-load-error-overlay.js';
import { collectAuthoredMixProblems } from '../../src/finance/behavioral/rebalance-to-target-reducer.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const button = (text) =>
  [...document.querySelectorAll('.scenario-load-error button')].find(b => b.textContent.includes(text));
const inputs = () => [...document.querySelectorAll('.sle-cell-input')];
const type   = (input, value) => { input.value = value; input.dispatchEvent(new Event('input')); };
const pick   = (sel, value) => { sel.value = value; sel.dispatchEvent(new Event('change')); };

function badConfig() {
  return {
    id: 'u:4',
    name: 'Terry Jeanne Evaluation',
    params: [{ name: 'allocationGlidepath', type: 'AllocationGlidepath', value: [
      { age: 47, weights: { EQUITY: 0.77, BOND: 0.12, CASH: 0, GOLD: 0.12 } },
      { age: 89, weights: { EQUITY: 0,    BOND: 1,    CASH: 0, GOLD: 0 } },
    ] }],
  };
}

function makeRegistry(others = []) {
  return {
    getAll:        () => others,
    save:          jest.fn(),
    setActiveById: jest.fn(),
  };
}

function show(config, { registry = makeRegistry(), onReload = jest.fn() } = {}) {
  const [first] = collectAuthoredMixProblems(
    Object.fromEntries((config.params ?? []).map(p => [p.name, p.value])));
  showScenarioLoadError({
    error: new Error(first?.message ?? 'boom'),
    config,
    scenarioRegistry: registry,
    onReload,
  });
  return { registry, onReload };
}

beforeEach(() => { document.body.innerHTML = ''; });

// ═════════════════════════════════════════════════════════════════════════════

test('names the scenario, the error, and the offending anchor', () => {
  show(badConfig());
  const text = document.querySelector('.scenario-load-error').textContent;
  assert.match(text, /Terry Jeanne Evaluation/);
  assert.match(text, /allocationGlidepath\[0\] \(age 47\)/);
  assert.match(text, /got 1\.010000/);
});

test('offers weight cells only for the anchor that is actually broken', () => {
  show(badConfig());
  // Four cells — one bad anchor, not one row per anchor in the glidepath.
  assert.strictEqual(inputs().length, 4);
  assert.deepStrictEqual(inputs().map(i => Number(i.value)), [0.77, 0.12, 0, 0.12]);
});

test('Normalize repairs the anchor in place, on the live config', () => {
  const config = badConfig();
  show(config);
  button('Normalize').click();

  assert.deepStrictEqual(collectAuthoredMixProblems({ allocationGlidepath: config.params[0].value }), []);
  assert.deepStrictEqual(config.params[0].value[1].weights, { EQUITY: 0, BOND: 1, CASH: 0, GOLD: 0 },
    'the valid anchor is untouched');
});

test('typing a weight edits the same object the save will persist', () => {
  const config = badConfig();
  show(config);
  type(inputs()[0], '0.76');
  assert.strictEqual(config.params[0].value[0].weights.EQUITY, 0.76);
});

test('save persists the repaired config as active and reloads', () => {
  const config = badConfig();
  const { registry, onReload } = show(config);
  type(inputs()[0], '0.76');
  button('Save fixes and reload').click();

  assert.strictEqual(registry.save.mock.calls[0][0], config);
  assert.strictEqual(registry.save.mock.calls[0][1], true);
  assert.strictEqual(onReload.mock.calls.length, 1);
});

test('save refuses while the mix is still invalid — a reload would redraw this page', () => {
  const config = badConfig();
  const { registry, onReload } = show(config);
  const alert = jest.spyOn(window, 'alert').mockImplementation(() => {});

  type(inputs()[0], '0.9');
  button('Save fixes and reload').click();

  assert.strictEqual(registry.save.mock.calls.length, 0);
  assert.strictEqual(onReload.mock.calls.length, 0);
  assert.match(alert.mock.calls[0][0], /must sum to exactly 1/);
  alert.mockRestore();
});

test('the mirrored parameters bag is kept in step, or the fix looks like a no-op', () => {
  const config = badConfig();
  config.parameters = { allocationGlidepath: config.params[0].value.map(a => ({ ...a })) };
  show(config);
  button('Normalize').click();
  button('Save fixes and reload').click();

  assert.strictEqual(config.parameters.allocationGlidepath, config.params[0].value);
});

test('switching to another scenario leaves the broken one saved and untouched', () => {
  const config = badConfig();
  const registry = makeRegistry([
    { id: 'u:4', name: 'Terry Jeanne Evaluation' },
    { id: 'u:1', name: 'Terry Jeanne Optimized' },
  ]);
  const { onReload } = show(config, { registry });

  const btn = button('Terry Jeanne Optimized');
  assert.ok(btn, 'the other scenario is offered');
  assert.ok(!button('Terry Jeanne Evaluation'), 'the broken one is not offered as an escape');
  btn.click();

  assert.strictEqual(registry.setActiveById.mock.calls[0][0], 'u:1');
  assert.strictEqual(onReload.mock.calls.length, 1);
  assert.strictEqual(registry.save.mock.calls.length, 0);
  assert.strictEqual(config.params[0].value[0].weights.EQUITY, 0.77, 'left exactly as stored');
});

// ─── design 97 pools ─────────────────────────────────────────────────────────

const ACCOUNTS = [{ stateKey: 'auOffsetAccount', name: 'Offset', type: 'offset',
                    offsetsPropertyKey: 'auHouse' }];

/** The failure that motivated all of this: a PERCENT target authored as a percentage. */
function badPoolConfig() {
  return {
    id: 'u:11',
    name: 'Seq-risk C',
    accounts: ACCOUNTS,
    params: [{ name: 'liquidityGraph', type: 'LiquidityGraph', value: {
      pools: [{ id: 'offset', spendOrder: 2, target: { mode: 'PERCENT', value: 100 },
                capacity: { mode: 'OFFSET_CAP' }, claims: [{ key: 'auOffsetAccount' }] }],
    } }],
  };
}

// `inputs()` above counts every .sle-cell-input, and a pool spec draws a mode SELECT
// beside its value; these two split them.
const numbers = () => [...document.querySelectorAll('input.sle-cell-input')];
const selects = () => [...document.querySelectorAll('select.sle-cell-input')];

test('a bad pool size gets its own controls, not just the error text', () => {
  const config = badPoolConfig();
  show(config);
  const text = document.querySelector('.scenario-load-error').textContent;
  assert.match(text, /pool 'offset' target\.value is a FRACTION/);
  assert.strictEqual(document.querySelectorAll('.sle-error').length, 0,
    'the repair section already names it');
  assert.strictEqual(numbers().length, 1, 'one value cell for the one bad spec');
  assert.strictEqual(numbers()[0].max, '1', "and it carries PERCENT's own bound");
});

test('÷100 repairs the pool in place, on the live config', () => {
  const config = badPoolConfig();
  const { registry, onReload } = show(config);
  button('÷ 100').click();
  assert.deepStrictEqual(config.params[0].value.pools[0].target, { mode: 'PERCENT', value: 1 });

  button('Save fixes and reload').click();
  assert.strictEqual(registry.save.mock.calls[0][0], config);
  assert.strictEqual(onReload.mock.calls.length, 1);
});

test('typing a valid fraction is enough, and the mode can be changed with it', () => {
  const config = badPoolConfig();
  show(config);
  type(numbers()[0], '0.25');
  assert.strictEqual(config.params[0].value.pools[0].target.value, 0.25);

  pick(selects()[0], 'YEARS_OF_SPEND');
  assert.strictEqual(config.params[0].value.pools[0].target.mode, 'YEARS_OF_SPEND');
});

test('save refuses while the pool size is still out of range', () => {
  const config = badPoolConfig();
  const { registry, onReload } = show(config);
  const alert = jest.spyOn(window, 'alert').mockImplementation(() => {});

  button('Save fixes and reload').click();
  assert.strictEqual(registry.save.mock.calls.length, 0);
  assert.strictEqual(onReload.mock.calls.length, 0);
  assert.match(alert.mock.calls[0][0], /a PERCENT is a FRACTION/);
  alert.mockRestore();
});

test('the broken scenario can be deleted, behind a confirm', () => {
  const config = badPoolConfig();
  const registry = { ...makeRegistry([{ id: 'u:1', name: 'Other' }]), delete: jest.fn() };
  const { onReload } = show(config, { registry });
  const confirm = jest.spyOn(window, 'confirm').mockImplementation(() => false);

  button('Delete this scenario').click();
  assert.strictEqual(registry.delete.mock.calls.length, 0, 'a declined confirm deletes nothing');

  confirm.mockImplementation(() => true);
  button('Delete this scenario').click();
  assert.strictEqual(registry.delete.mock.calls[0][0], 'u:11');
  assert.strictEqual(onReload.mock.calls.length, 1);
  confirm.mockRestore();
});

// ─── the Rebuild path: broken by UNSAVED edits ───────────────────────────────
//
// The stored copy still loads, so the cheapest exit is to throw the edits away — but the
// escape list omits the active scenario by design, which left the user's own saved copy
// the one config on the page they could not get back to.

/** The stored copy of `badPoolConfig` — same scenario, with the size it was saved with. */
function storedPoolCopy() {
  return { id: 'u:11', name: 'Seq-risk C', accounts: ACCOUNTS,
           params: [{ name: 'liquidityGraph', type: 'LiquidityGraph', value: {
             pools: [{ id: 'offset', spendOrder: 2, target: { mode: 'PERCENT', value: 0.05 },
                       capacity: { mode: 'OFFSET_CAP' }, claims: [{ key: 'auOffsetAccount' }] }],
           } }] };
}

test('unsaved edits: the saved version is offered, and going back writes nothing', () => {
  const config = badPoolConfig();
  const registry = { ...makeRegistry([{ id: 'u:1', name: 'Other' }]),
                     getStored: () => storedPoolCopy(), delete: jest.fn() };
  const { onReload } = show(config, { registry });

  assert.match(document.querySelector('.sle-title').textContent, /These changes could not be loaded/);
  const back = button('Discard changes and reload the saved version');
  assert.ok(back, 'the stored copy is reachable');

  back.click();
  assert.strictEqual(onReload.mock.calls.length, 1);
  assert.strictEqual(registry.save.mock.calls.length, 0,
    'persisting the broken in-memory record is the one thing that must not happen');
  // Still repairable in place for anyone who wants to KEEP the edits.
  assert.strictEqual(numbers().length, 1);
});

test('a stored copy identical to the live one is not offered — it would reload to here', () => {
  const config = badPoolConfig();
  const registry = { ...makeRegistry([{ id: 'u:1', name: 'Other' }]),
                     getStored: () => JSON.parse(JSON.stringify(config)) };
  show(config, { registry });

  assert.ok(!button('Discard changes'), 'nothing to discard');
  assert.match(document.querySelector('.sle-title').textContent, /This scenario could not be loaded/);
});

test('a stored copy that is broken too is not offered as an escape', () => {
  const config = badPoolConfig();
  const stored = storedPoolCopy();
  stored.params[0].value.pools[0].target.value = 42;      // broken in storage as well
  const registry = { ...makeRegistry([{ id: 'u:1', name: 'Other' }]), getStored: () => stored };
  show(config, { registry });

  assert.ok(!button('Discard changes'));
});

test('a registry with no getStored (a prebuilt, an older caller) behaves as before', () => {
  show(badPoolConfig());
  assert.ok(!button('Discard changes'));
  assert.match(document.querySelector('.sle-title').textContent, /This scenario could not be loaded/);
});

test('a failure the mix validator cannot localize still shows the error and the switcher', () => {
  const registry = makeRegistry([{ id: 'u:1', name: 'Other' }]);
  showScenarioLoadError({
    error: new Error('some other compile failure'),
    config: { id: 'u:4', name: 'Broken', params: [] },
    scenarioRegistry: registry,
    onReload: jest.fn(),
  });

  assert.match(document.querySelector('.sle-error').textContent, /some other compile failure/);
  assert.strictEqual(inputs().length, 0, 'nothing to repair, so nothing is guessed at');
  assert.ok(button('Other'));
});
