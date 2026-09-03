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
 * structured-param-editors.test.mjs
 *
 * The seven typed editors that replaced the raw JSON textarea on the structured
 * params (design 61 Levers B/D, design 67, designs 74/75/90).
 *
 * The tests worth having here are not "a row renders". They are the two properties a
 * textarea could not give us:
 *
 *   - a mix written through the editor is ALWAYS total (every allocation present),
 *     because `assertTotalMix` rejects a partial one at Rebuild and an absent key
 *     silently liquidates that class;
 *   - an emptied list normalises to `null`, the shape every consumer reads as
 *     "no override" — not `[]` or `{}`, which several of them treat differently.
 *
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';
import {
  buildMixListEditor, buildAllocationGlidepathEditor, buildAllocationRegimeTargetsEditor,
  buildLocationPolicyEditor, buildYieldCurveShapeEditor, buildYieldCurveScheduleEditor,
  buildRateKeyMapEditor, buildDrawdownSequenceEditor, buildLiquidityGraphEditor,
} from '../../src/visualization/scenario/structured-param-editors.js';
import { ALLOCATION_VALUES } from '../../src/finance/holdings/allocation.js';
import { assertTotalMix }    from '../../src/finance/holdings/allocation.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mount(editor) {
  document.body.innerHTML = '<div id="host"></div>';
  document.getElementById('host').appendChild(editor);
  return document.getElementById('host');
}

const cells   = (host, id) => [...host.querySelectorAll(`[data-id="${id}"]`)];
const cell    = (host, id) => host.querySelector(`[data-id="${id}"]`);
const button  = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text));
const type    = (input, value, ev = 'input') => { input.value = value; input.dispatchEvent(new Event(ev)); };

// ═════════════════════════════════════════════════════════════════════════════
// MixList
// ═════════════════════════════════════════════════════════════════════════════

test('MixList: null renders the default state, not a grid of zeros', () => {
  const param = { name: 'rebalanceTargetAllocation', value: null };
  const host = mount(buildMixListEditor(param));
  assert.match(host.textContent, /default mix/i);
  assert.strictEqual(host.querySelectorAll('input').length, 0, 'no weight cells until a mix is set');
  assert.strictEqual(param.value, null, 'rendering must not author a value');
});

test('MixList: "+ Set Mix" seeds a TOTAL mix that passes assertTotalMix', () => {
  const param = { name: 'rebalanceTargetAllocation', value: null };
  const host = mount(buildMixListEditor(param));
  button(host, 'Set Mix').click();
  assert.doesNotThrow(() => assertTotalMix(param.value, 'seeded'));
  assert.deepStrictEqual(Object.keys(param.value).sort(), [...ALLOCATION_VALUES].sort());
});

test('MixList: editing one weight keeps every other allocation present', () => {
  const param = { name: 'rebalanceTargetAllocation', value: { EQUITY: 0.6, BOND: 0.4, CASH: 0, GOLD: 0 } };
  const host = mount(buildMixListEditor(param));
  type(cell(host, 'GOLD'), '0.1');
  assert.strictEqual(param.value.GOLD, 0.1);
  assert.deepStrictEqual(Object.keys(param.value).sort(), [...ALLOCATION_VALUES].sort(),
    'a partial mix is unreachable — an absent key would liquidate that class');
});

test('MixList: a blank weight cell is 0, never an absent key', () => {
  const param = { name: 'rebalanceTargetAllocation', value: { EQUITY: 0.6, BOND: 0.4, CASH: 0, GOLD: 0 } };
  const host = mount(buildMixListEditor(param));
  type(cell(host, 'BOND'), '');
  assert.strictEqual(param.value.BOND, 0);
  assert.ok('BOND' in param.value);
});

test('MixList: the Σ readout flags a non-unit mix', () => {
  const param = { name: 'rebalanceTargetAllocation', value: { EQUITY: 0.6, BOND: 0.4, CASH: 0, GOLD: 0 } };
  const host = mount(buildMixListEditor(param));
  assert.ok(host.querySelector('.mix-sum').classList.contains('mix-sum-ok'));
  type(cell(host, 'GOLD'), '0.25');
  assert.ok(host.querySelector('.mix-sum').classList.contains('mix-sum-bad'),
    'Σ 1.25 must be visible while typing — Rebuild REJECTS it, it is not rescaled');
});

test('MixList: "Use default" returns the param to null', () => {
  const param = { name: 'rebalanceTargetAllocation', value: { EQUITY: 1, BOND: 0, CASH: 0, GOLD: 0 } };
  const host = mount(buildMixListEditor(param));
  button(host, 'Use default').click();
  assert.strictEqual(param.value, null);
});

// ═════════════════════════════════════════════════════════════════════════════
// AllocationGlidepath
// ═════════════════════════════════════════════════════════════════════════════

test('Glidepath: clones its input (no shared-reference mutation of a schema default)', () => {
  const shared = [{ age: 50, weights: { EQUITY: 0.8, BOND: 0.2, CASH: 0, GOLD: 0 } }];
  const param = { name: 'allocationGlidepath', value: shared };
  const host = mount(buildAllocationGlidepathEditor(param));
  type(cell(host, 'EQUITY'), '0.7');
  assert.strictEqual(shared[0].weights.EQUITY, 0.8, 'the caller\'s array is untouched');
  assert.strictEqual(param.value[0].weights.EQUITY, 0.7);
});

test('Glidepath: every anchor it writes is a TOTAL mix', () => {
  // A partial anchor is exactly the design-61 §12.2 Q3 failure: authored before GOLD
  // existed, it silently targets gold at 0 and the next rebalance sells the sleeve.
  const param = { name: 'allocationGlidepath', value: [{ age: 50, weights: { EQUITY: 0.8, BOND: 0.2 } }] };
  mount(buildAllocationGlidepathEditor(param));
  assert.doesNotThrow(() => assertTotalMix(param.value[0].weights, 'anchor 0'));
});

test('Glidepath: anchors stay sorted by age when one is retyped', () => {
  const param = {
    name: 'allocationGlidepath',
    value: [
      { age: 50, weights: { EQUITY: 0.8, BOND: 0.2, CASH: 0, GOLD: 0 } },
      { age: 75, weights: { EQUITY: 0.4, BOND: 0.6, CASH: 0, GOLD: 0 } },
    ],
  };
  const host = mount(buildAllocationGlidepathEditor(param));
  type(cells(host, 'age')[0], '90', 'change');
  assert.deepStrictEqual(param.value.map(a => a.age), [75, 90], 'the interpolator walks anchors in order');
});

test('Glidepath: removing the last anchor normalises to null, not []', () => {
  const param = { name: 'allocationGlidepath', value: [{ age: 50, weights: { EQUITY: 1, BOND: 0, CASH: 0, GOLD: 0 } }] };
  const host = mount(buildAllocationGlidepathEditor(param));
  cell(host, 'removeRow').click();
  assert.strictEqual(param.value, null);
});

test('Glidepath: "+ Add Anchor" appends past the last age with a total mix', () => {
  const param = { name: 'allocationGlidepath', value: [] };
  const host = mount(buildAllocationGlidepathEditor(param));
  button(host, 'Add Anchor').click();
  assert.strictEqual(param.value.length, 1);
  assert.doesNotThrow(() => assertTotalMix(param.value[0].weights, 'new anchor'));
});

// ═════════════════════════════════════════════════════════════════════════════
// AllocationRegimeTargets
// ═════════════════════════════════════════════════════════════════════════════

test('RegimeTargets: renders one block per tag and rebuilds the map from row order', () => {
  const param = {
    name: 'allocationRegimeTargets',
    value: {
      NORMAL:          { EQUITY: 0.6, BOND: 0.4, CASH: 0, GOLD: 0 },
      ECONOMIC_STRESS: { EQUITY: 0.3, BOND: 0.3, CASH: 0.2, GOLD: 0.2 },
    },
  };
  const host = mount(buildAllocationRegimeTargetsEditor(param));
  assert.strictEqual(host.querySelectorAll('.mix-block').length, 2);
  assert.deepStrictEqual(Object.keys(param.value), ['NORMAL', 'ECONOMIC_STRESS'],
    'order is precedence — resolveRegimeTarget takes the first active tag');
});

test('RegimeTargets: retyping a tag moves the weights instead of dropping them', () => {
  const param = { name: 'allocationRegimeTargets', value: { NORMAL: { EQUITY: 0.6, BOND: 0.4, CASH: 0, GOLD: 0 } } };
  const host = mount(buildAllocationRegimeTargetsEditor(param));
  const sel = cell(host, 'tag');
  sel.value = 'ECONOMIC_STRESS';
  sel.dispatchEvent(new Event('change'));
  assert.deepStrictEqual(Object.keys(param.value), ['ECONOMIC_STRESS']);
  assert.strictEqual(param.value.ECONOMIC_STRESS.EQUITY, 0.6, 'the mix followed the rename');
});

test('RegimeTargets: an unknown persisted tag is kept, not silently re-pointed', () => {
  const param = { name: 'allocationRegimeTargets', value: { LEGACY_TAG: { EQUITY: 1, BOND: 0, CASH: 0, GOLD: 0 } } };
  const host = mount(buildAllocationRegimeTargetsEditor(param));
  assert.strictEqual(cell(host, 'tag').value, 'LEGACY_TAG');
  assert.deepStrictEqual(Object.keys(param.value), ['LEGACY_TAG']);
});

test('RegimeTargets: removing the last regime normalises to null', () => {
  const param = { name: 'allocationRegimeTargets', value: { NORMAL: { EQUITY: 1, BOND: 0, CASH: 0, GOLD: 0 } } };
  const host = mount(buildAllocationRegimeTargetsEditor(param));
  cell(host, 'removeRow').click();
  assert.strictEqual(param.value, null);
});

// ═════════════════════════════════════════════════════════════════════════════
// LocationPolicy
// ═════════════════════════════════════════════════════════════════════════════

test('LocationPolicy: flattens the map to ordered rows and rebuilds it in row order', () => {
  const param = { name: 'allocationLocationPolicy', value: { BOND: ['ira', 'k401'], EQUITY: ['roth-ira'] } };
  const host = mount(buildLocationPolicyEditor(param));
  assert.strictEqual(cells(host, 'role').length, 3, 'one row per (class, role) preference');
  assert.deepStrictEqual(param.value, { BOND: ['ira', 'k401'], EQUITY: ['roth-ira'] });
});

test('LocationPolicy: move-up reorders the preference, which is the datum', () => {
  const param = { name: 'allocationLocationPolicy', value: { BOND: ['ira', 'k401'] } };
  const host = mount(buildLocationPolicyEditor(param));
  cells(host, 'moveRowUp')[1].click();
  assert.deepStrictEqual(param.value.BOND, ['k401', 'ira']);
});

test('LocationPolicy: the first row cannot move up', () => {
  const param = { name: 'allocationLocationPolicy', value: { BOND: ['ira', 'k401'] } };
  const host = mount(buildLocationPolicyEditor(param));
  assert.strictEqual(cells(host, 'moveRowUp')[0].disabled, true);
});

test('LocationPolicy: emptying the list normalises to null (⇒ jurisdiction default)', () => {
  const param = { name: 'allocationLocationPolicy', value: { BOND: ['ira'] } };
  const host = mount(buildLocationPolicyEditor(param));
  cell(host, 'removeRow').click();
  assert.strictEqual(param.value, null);
});

test('LocationPolicy: a null value renders the empty note and authors nothing', () => {
  const param = { name: 'assetLocationPolicy', value: null };
  const host = mount(buildLocationPolicyEditor(param));
  assert.match(host.textContent, /jurisdiction-aware default/i);
  assert.strictEqual(param.value, null);
});

// ═════════════════════════════════════════════════════════════════════════════
// YieldCurveShape
// ═════════════════════════════════════════════════════════════════════════════

test('YieldCurveShape: renders one row per anchor point', () => {
  const param = { name: 'usYieldCurveShape', value: [{ tenor: 1, spread: -0.01 }, { tenor: 10, spread: 0.006 }] };
  const host = mount(buildYieldCurveShapeEditor(param));
  assert.strictEqual(cells(host, 'tenor').length, 2);
});

test('YieldCurveShape: points stay sorted by tenor when one is retyped', () => {
  // The interpolator walks the points in order and clamps to the endpoints, so an
  // out-of-order point reshapes the whole curve rather than moving one knot.
  const param = { name: 'usYieldCurveShape', value: [{ tenor: 1, spread: -0.01 }, { tenor: 10, spread: 0.006 }] };
  const host = mount(buildYieldCurveShapeEditor(param));
  type(cells(host, 'tenor')[0], '30', 'change');
  assert.deepStrictEqual(param.value.map(p => p.tenor), [10, 30]);
});

test('YieldCurveShape: emptying the points normalises to null (⇒ flat curve)', () => {
  const param = { name: 'usYieldCurveShape', value: [{ tenor: 1, spread: -0.01 }] };
  const host = mount(buildYieldCurveShapeEditor(param));
  cell(host, 'removeRow').click();
  assert.strictEqual(param.value, null);
});

test('YieldCurveShape: a null value authors nothing on render', () => {
  const param = { name: 'auYieldCurveShape', value: null };
  mount(buildYieldCurveShapeEditor(param));
  assert.strictEqual(param.value, null);
});

// ═════════════════════════════════════════════════════════════════════════════
// YieldCurveSchedule
// ═════════════════════════════════════════════════════════════════════════════

test('YieldCurveSchedule: renders a year block with a nested shape per country', () => {
  const param = {
    name: 'yieldCurveSchedule',
    value: [{ year: 2030, US: [{ tenor: 1, spread: 0.015 }], AU: [{ tenor: 1, spread: 0.01 }] }],
  };
  const host = mount(buildYieldCurveScheduleEditor(param));
  assert.strictEqual(host.querySelectorAll('.mix-block').length, 1);
  assert.ok(cell(host, 'country-US'));
  assert.ok(cell(host, 'country-AU'));
  assert.strictEqual(cells(host, 'tenor').length, 2, 'one tenor row per country');
});

test('YieldCurveSchedule: a country with no points keeps its key ABSENT, not []', () => {
  // The compiler tests `Array.isArray(entry[cc])` — an absent country means "leave that
  // country's curve alone for this step", which an empty array would not say.
  const param = { name: 'yieldCurveSchedule', value: [{ year: 2030, US: [{ tenor: 1, spread: 0.015 }] }] };
  mount(buildYieldCurveScheduleEditor(param));
  assert.ok('US' in param.value[0]);
  assert.strictEqual('AU' in param.value[0], false);
});

test('YieldCurveSchedule: clearing a country deletes its key', () => {
  const param = { name: 'yieldCurveSchedule', value: [{ year: 2030, US: [{ tenor: 1, spread: 0.015 }] }] };
  const host = mount(buildYieldCurveScheduleEditor(param));
  cell(host, 'country-US').querySelector('[data-id="removeRow"]').click();
  assert.strictEqual('US' in param.value[0], false);
});

test('YieldCurveSchedule: entries stay sorted by year', () => {
  const param = { name: 'yieldCurveSchedule', value: [{ year: 2030 }, { year: 2040 }] };
  const host = mount(buildYieldCurveScheduleEditor(param));
  type(cells(host, 'year')[0], '2050', 'change');
  assert.deepStrictEqual(param.value.map(e => e.year), [2040, 2050]);
});

test('YieldCurveSchedule: removing the last year normalises to null', () => {
  const param = { name: 'yieldCurveSchedule', value: [{ year: 2030 }] };
  const host = mount(buildYieldCurveScheduleEditor(param));
  // The block's own remove button is the one outside a nested country section.
  const rm = [...host.querySelectorAll('.mix-block-head [data-id="removeRow"]')][0];
  rm.click();
  assert.strictEqual(param.value, null);
});

// ═════════════════════════════════════════════════════════════════════════════
// RateKeyMap
// ═════════════════════════════════════════════════════════════════════════════

const BETA_PARAM = () => ({
  name: 'equityReturnBeta',
  value: null,
  options: ['EQUITY_AU', 'EQUITY_INTL_EX_AU', 'EQUITY_INTL_EX_US', 'EQUITY_US'],
  optionDefaults: { EQUITY_US: 1.0, EQUITY_INTL_EX_US: 0.85, EQUITY_INTL_EX_AU: 0.95, EQUITY_AU: 0.8 },
});

test('RateKeyMap: gives every declared sleeve a row whose placeholder states its default', () => {
  const param = BETA_PARAM();
  const host = mount(buildRateKeyMapEditor(param));
  assert.strictEqual(cells(host, 'EQUITY_US').length, 1);
  assert.strictEqual(cell(host, 'EQUITY_US').placeholder, '1',
    'the answer to "what is it if I leave it blank?" must be on screen');
  assert.strictEqual(param.value, null, 'rendering authors nothing');
});

test('RateKeyMap: setting one sleeve writes only that key', () => {
  const param = BETA_PARAM();
  const host = mount(buildRateKeyMapEditor(param));
  type(cell(host, 'EQUITY_AU'), '0.65', 'change');
  assert.deepStrictEqual(param.value, { EQUITY_AU: 0.65 });
});

test('RateKeyMap: blanking a sleeve drops the key (⇒ back to the default)', () => {
  const param = { ...BETA_PARAM(), value: { EQUITY_AU: 0.65, EQUITY_US: 1.1 } };
  const host = mount(buildRateKeyMapEditor(param));
  type(cell(host, 'EQUITY_AU'), '', 'change');
  assert.deepStrictEqual(param.value, { EQUITY_US: 1.1 });
});

test('RateKeyMap: blanking the last override normalises to null', () => {
  const param = { ...BETA_PARAM(), value: { EQUITY_AU: 0.65 } };
  const host = mount(buildRateKeyMapEditor(param));
  type(cell(host, 'EQUITY_AU'), '', 'change');
  assert.strictEqual(param.value, null);
});

test('RateKeyMap: a 0 override is kept and shown, not read as blank', () => {
  const param = { ...BETA_PARAM(), value: { EQUITY_AU: 0 } };
  const host = mount(buildRateKeyMapEditor(param));
  assert.strictEqual(cell(host, 'EQUITY_AU').value, '0');
  assert.deepStrictEqual(param.value, { EQUITY_AU: 0 });
});

test('RateKeyMap: a key outside the declared list gets its own marked row', () => {
  // A regional key (design 67 §44: REAL_ESTATE_US-SF-BAY) authored in JSON must stay
  // editable rather than be invisibly carried through every save.
  const param = { ...BETA_PARAM(), value: { 'EQUITY_US-TECH': 1.4 } };
  const host = mount(buildRateKeyMapEditor(param));
  const row = cell(host, 'EQUITY_US-TECH');
  assert.ok(row, 'the unknown key still has a row');
  assert.ok(host.querySelector('.rate-key-unknown'), 'and is marked as undeclared');
});

test('LocationPolicy: "+ Add Preference" picks an unused role, not a duplicate ranking entry', () => {
  const param = { name: 'allocationLocationPolicy', value: null };
  const host = mount(buildLocationPolicyEditor(param));
  button(host, 'Add Preference').click();
  button(host, 'Add Preference').click();
  const roles = param.value[ALLOCATION_VALUES[0]];
  assert.strictEqual(roles.length, 2);
  assert.notStrictEqual(roles[0], roles[1], 'a repeated entry says nothing in a ranking');
});

// ═════════════════════════════════════════════════════════════════════════════
// Normalize — the offered rescale
// ═════════════════════════════════════════════════════════════════════════════
//
// Design 61 §12.2 Q3 forbids a SILENT rescale (an authored 0.75/0.25/0/0.25 executed as
// 0.6/0.2/0/0.2). It does not forbid offering the fix: the button only appears while the
// mix is non-unit, the user clicks it, and the result is on screen before any rebuild.

test('Normalize: hidden while the mix already sums to 1', () => {
  const param = { name: 'rebalanceTargetAllocation', value: { EQUITY: 0.6, BOND: 0.4, CASH: 0, GOLD: 0 } };
  const host  = mount(buildMixListEditor(param));
  assert.strictEqual(cell(host, 'normalizeMix').style.display, 'none');
});

test('Normalize: appears as soon as a weight breaks the sum', () => {
  const param = { name: 'rebalanceTargetAllocation', value: { EQUITY: 0.6, BOND: 0.4, CASH: 0, GOLD: 0 } };
  const host  = mount(buildMixListEditor(param));
  type(cell(host, 'EQUITY'), '0.77');
  assert.notStrictEqual(cell(host, 'normalizeMix').style.display, 'none');
});

test('Normalize: scales to exactly 1 and keeps the authored ratios', () => {
  const param = { name: 'rebalanceTargetAllocation', value: { EQUITY: 0.77, BOND: 0.12, CASH: 0, GOLD: 0.12 } };
  const host  = mount(buildMixListEditor(param));
  cell(host, 'normalizeMix').click();

  assert.doesNotThrow(() => assertTotalMix(param.value, 'normalized'));
  const before = 0.12 / 0.77;
  assert.ok(Math.abs(param.value.BOND / param.value.EQUITY - before) < 1e-4,
    'a proportional rescale, not a redistribution');
  assert.strictEqual(cell(host, 'normalizeMix').style.display, 'none', 'and the offer withdraws');
});

test('Normalize: writes the new weights back into the visible cells', () => {
  const param = { name: 'rebalanceTargetAllocation', value: { EQUITY: 0.77, BOND: 0.12, CASH: 0, GOLD: 0.12 } };
  const host  = mount(buildMixListEditor(param));
  cell(host, 'normalizeMix').click();
  assert.strictEqual(Number(cell(host, 'EQUITY').value), param.value.EQUITY);
  assert.strictEqual(Number(cell(host, 'BOND').value),   param.value.BOND);
});

test('Normalize: an all-zero mix offers nothing — there is no ratio to preserve', () => {
  const param = { name: 'rebalanceTargetAllocation', value: { EQUITY: 0, BOND: 0, CASH: 0, GOLD: 0 } };
  const host  = mount(buildMixListEditor(param));
  assert.strictEqual(cell(host, 'normalizeMix').style.display, 'none');
});

test('Normalize: a glidepath anchor normalises independently of its siblings', () => {
  const param = { name: 'allocationGlidepath', value: [
    { age: 47, weights: { EQUITY: 0.77, BOND: 0.12, CASH: 0, GOLD: 0.12 } },
    { age: 89, weights: { EQUITY: 0,    BOND: 1,    CASH: 0, GOLD: 0 } },
  ] };
  const host = mount(buildAllocationGlidepathEditor(param));
  const buttons = cells(host, 'normalizeMix');
  assert.strictEqual(buttons.length, 2);
  assert.notStrictEqual(buttons[0].style.display, 'none');
  assert.strictEqual(buttons[1].style.display, 'none');

  buttons[0].click();
  assert.doesNotThrow(() => assertTotalMix(param.value[0].weights, 'anchor 0'));
  assert.deepStrictEqual(param.value[1].weights, { EQUITY: 0, BOND: 1, CASH: 0, GOLD: 0 },
    'the valid anchor is untouched');
});

// ═════════════════════════════════════════════════════════════════════════════
// Design 97 — DrawdownSequence and LiquidityGraph
//
// These two replaced JSON textareas, and the property worth testing is the one a
// textarea could not give: the value written by the editor is the shape
// `normalizeLiquidityGraph` accepts, including its two "blank means something" rules —
// blank sleeves = THE WHOLE ACCOUNT (not "no sleeves"), and an emptied list = null.
// ═════════════════════════════════════════════════════════════════════════════

const ACCOUNTS = [
  { stateKey: 'usSavingsAccount', name: 'US Savings', type: 'savings' },
  { stateKey: 'usStockAccount',   name: 'US Stock',   type: 'brokerage' },
  { stateKey: 'auOffsetAccount',  name: 'Offset',     type: 'offset' },
];

const tick = (host, id) => { const cb = cell(host, id); cb.checked = true; cb.dispatchEvent(new Event('change')); };
const pick = (sel, value) => { sel.value = value; sel.dispatchEvent(new Event('change')); };

test('DrawdownSequence: null renders the default state and authors nothing', () => {
  const param = { name: 'drawdownSequence', value: null };
  const host  = mount(buildDrawdownSequenceEditor(param, ACCOUNTS));
  assert.match(host.textContent, /drawdownPriority order/i);
  assert.strictEqual(param.value, null, 'rendering must not author a value');
});

test('DrawdownSequence: an existing sequence round-trips unchanged', () => {
  const seq = [
    { key: 'usSavingsAccount' },
    { key: 'usStockAccount', sleeves: ['BOND'] },
    { key: 'auOffsetAccount' },
    { key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD'] },
  ];
  const param = { name: 'drawdownSequence', value: seq };
  mount(buildDrawdownSequenceEditor(param, ACCOUNTS));
  assert.deepStrictEqual(param.value, seq);
});

test('DrawdownSequence: blank sleeves mean THE WHOLE ACCOUNT, so the key is omitted', () => {
  // §3.1 rule 3: an unnarrowed entry claims everything, and the normalizer REJECTS an
  // empty `sleeves` array outright. Writing [] here would turn a valid config invalid.
  const param = { name: 'drawdownSequence', value: [{ key: 'usStockAccount', sleeves: ['BOND'] }] };
  const host  = mount(buildDrawdownSequenceEditor(param, ACCOUNTS));
  const bond  = cell(host, 'sleeves:BOND');
  bond.checked = false;
  bond.dispatchEvent(new Event('change'));
  assert.deepStrictEqual(param.value, [{ key: 'usStockAccount' }]);
});

test('DrawdownSequence: ORDER is the datum — move-up reorders the value', () => {
  const param = { name: 'drawdownSequence', value: [
    { key: 'usSavingsAccount' }, { key: 'auOffsetAccount' },
  ] };
  const host = mount(buildDrawdownSequenceEditor(param, ACCOUNTS));
  cells(host, 'moveRowUp')[1].click();
  assert.deepStrictEqual(param.value.map(e => e.key), ['auOffsetAccount', 'usSavingsAccount']);
});

test('DrawdownSequence: removing the last row normalises to null, not []', () => {
  const param = { name: 'drawdownSequence', value: [{ key: 'usSavingsAccount' }] };
  const host  = mount(buildDrawdownSequenceEditor(param, ACCOUNTS));
  cell(host, 'removeRow').click();
  assert.strictEqual(param.value, null);
});

test('LiquidityGraph: null renders the default state and authors nothing', () => {
  const param = { name: 'liquidityGraph', value: null };
  const host  = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  assert.match(host.textContent, /No pools/i);
  assert.strictEqual(param.value, null);
});

test('LiquidityGraph: a graph round-trips into three tables and back out unchanged', () => {
  const graph = {
    pools: [
      { id: 'cash', label: 'Bucket 1', spendOrder: 10,
        target: { mode: 'YEARS_OF_SPEND', value: 1 },
        claims: [{ key: 'usSavingsAccount' }] },
      { id: 'reserve', label: 'Bucket 2', spendOrder: 20,
        target: { mode: 'YEARS_OF_SPEND', value: 4 },
        claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
      { id: 'offset', label: 'Backstop', spendOrder: 30,
        capacity: { mode: 'OFFSET_CAP' },
        claims: [{ key: 'auOffsetAccount' }] },
      { id: 'growth', label: 'Bucket 3', spendOrder: 40,
        claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD'] }] },
    ],
    flows: [
      // ANNUAL on exactly one edge, and the default left off the other two: that is what
      // makes the assertion real. A cadence written onto every edge would round-trip whether
      // or not the control read anything, and a graph where every collection carries its
      // default value cannot detect a field being dropped (`copy-fidelity-masked-by-drift-merge`).
      { id: 'g2r', from: 'growth', to: 'reserve', priority: 10,
        gate: { sourceDrawdownUnder: 0.05 }, cadence: 'ANNUAL' },
      { id: 'r2c', from: 'reserve', to: 'cash',
        trigger: { below: { mode: 'YEARS_OF_SPEND', value: 1 } } },
      { id: 'dip', from: 'reserve', to: 'growth',
        gate: { targetDrawdownOver: 0.2 }, amount: { fractionOfSource: 0.25 } },
    ],
  };
  const param = { name: 'liquidityGraph', value: graph };
  mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  assert.deepStrictEqual(param.value, graph);
});

test('LiquidityGraph: a multi-account pool is just two claim rows', () => {
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'cash', spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  // The claims table's "+ Add Claim" — the whole reason claims get their own table is that
  // "one year of cash across two accounts" should be this easy.
  button(host, 'Add Claim').click();
  const accountSelects = cells(host, 'key');
  pick(accountSelects[accountSelects.length - 1], 'auOffsetAccount');
  assert.deepStrictEqual(param.value.pools[0].claims,
    [{ key: 'usSavingsAccount' }, { key: 'auOffsetAccount' }]);
});

test('LiquidityGraph: renaming a pool re-renders the claim table so nothing is orphaned', () => {
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'cash', spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  const poolId = cell(host, 'id');
  type(poolId, 'bucket1', 'change');
  // The claim still points at the OLD id, which is now a dangling reference — and the
  // control has to show that immediately rather than at Rebuild.
  const poolSel = cell(host, 'pool');
  assert.match([...poolSel.options].map(o => o.textContent).join(' '), /not found/);
  assert.strictEqual(poolSel.value, 'cash');
});

test('LiquidityGraph: a PERCENT size is bounded to a FRACTION, and 100 is clamped', () => {
  // The bug this closes: `target: { mode: PERCENT, value: 100 }` saves, then throws inside
  // ScenarioLoader on the NEXT load — before any tab renders — so the scenario can only be
  // repaired from the load-error overlay. The cell now carries the compiler's own bound.
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'offset', spendOrder: 10, target: { mode: 'PERCENT', value: 0.05 },
              claims: [{ key: 'auOffsetAccount' }] }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  const size = cell(host, 'targetValue');
  assert.strictEqual(size.max, '1');
  assert.strictEqual(size.min, '0');

  type(size, '100', 'change');
  assert.strictEqual(param.value.pools[0].target.value, 1, 'clamped to the mode\'s range');
  assert.strictEqual(size.value, '1', 'and the cell shows what was written');
});

test('LiquidityGraph: the size bound follows the mode it sits beside', () => {
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'cash', spendOrder: 10, target: { mode: 'PERCENT', value: 0.05 },
              claims: [{ key: 'usSavingsAccount' }] }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  pick(cell(host, 'targetMode'), 'AMOUNT');
  // AMOUNT is a currency figure: a 1 ceiling there would forbid every value worth typing.
  assert.strictEqual(cell(host, 'targetValue').max, '');
  type(cell(host, 'targetValue'), '250000', 'change');
  assert.strictEqual(param.value.pools[0].target.value, 250000);

  pick(cell(host, 'targetMode'), 'YEARS_OF_SPEND');
  assert.strictEqual(cell(host, 'targetValue').max, '50');
});

test('LiquidityGraph: a capacity size takes its bound from the capacity mode', () => {
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'cash', spendOrder: 10, capacity: { mode: 'YEARS_OF_SPEND', value: 1 },
              claims: [{ key: 'usSavingsAccount' }] }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  const cap = cell(host, 'capacityValue');
  assert.strictEqual(cap.max, '50');
  type(cap, '999', 'change');
  assert.strictEqual(param.value.pools[0].capacity.value, 50);
});

test('LiquidityGraph: emptying the pools normalises to null', () => {
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'cash', spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  cell(host, 'removeRow').click();
  assert.strictEqual(param.value, null);
});

test('LiquidityGraph: an opaque `ui` blob survives an edit (effort 2 needs it)', () => {
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'cash', spendOrder: 10, ui: { x: 40, y: 200 }, claims: [{ key: 'usSavingsAccount' }] }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  type(cell(host, 'label'), 'Bucket 1', 'change');
  assert.deepStrictEqual(param.value.pools[0].ui, { x: 40, y: 200 });
});

test('LiquidityGraph: what the editor writes is what the normalizer accepts', async () => {
  const { normalizeLiquidityGraph } = await import('../../src/finance/pools/liquidity-graph.js');
  const param = { name: 'liquidityGraph', value: null };
  const host  = mount(buildLiquidityGraphEditor(param, ACCOUNTS));

  button(host, 'Add Pool').click();
  type(cell(host, 'id'), 'cash', 'change');
  pick(cell(host, 'targetMode'), 'YEARS_OF_SPEND');
  type(cell(host, 'targetValue'), '2', 'change');
  button(host, 'Add Claim').click();
  pick(cell(host, 'key'), 'usSavingsAccount');

  button(host, 'Add Pool').click();
  type(cells(host, 'id')[1], 'growth', 'change');
  type(cells(host, 'spendOrder')[1], '20', 'change');
  button(host, 'Add Claim').click();
  pick(cells(host, 'pool')[1], 'growth');
  pick(cells(host, 'key')[1], 'usStockAccount');
  // The savings claim offers NO sleeve boxes (a non-brokerage cannot be narrowed), so the
  // only EQUITY checkbox on screen is the brokerage claim's.
  assert.strictEqual(cells(host, 'sleeves:EQUITY').length, 1);
  tick(host, 'sleeves:EQUITY');

  button(host, 'Add Flow').click();
  type(cells(host, 'id')[2], 'g2c', 'change');
  pick(cell(host, 'from'), 'growth');
  pick(cell(host, 'to'), 'cash');
  // The gate is its own table now (design 97 §20.15) — a flow holds a LIST of clauses, and
  // §17.1's rule makes a list of lists a flat table keyed by the id above it.
  button(host, 'Add Gate Clause').click();
  pick(cell(host, 'flow'), 'g2c');
  pick(cell(host, 'gateKind'), 'sourceDrawdownUnder');
  type(cell(host, 'gateValue'), '0.05', 'change');
  pick(cell(host, 'gateBasis'), 'BALANCE');

  // The point of the whole exercise: the config boundary is the only validator, and what
  // the control produces has to pass it.
  const g = normalizeLiquidityGraph(param.value, ACCOUNTS);
  assert.strictEqual(g.pools.length, 2);
  assert.strictEqual(g.flows[0].gate.sourceDrawdownUnder, 0.05);
  assert.deepStrictEqual(g.pools[0].target, { mode: 'YEARS_OF_SPEND', value: 2, spendBasis: 'LIVE' });
});

test('LiquidityGraph: the market-state gates round-trip (they must not be dropped on edit)', () => {
  // A gate kind the control does not know about is silently deleted the first time anything
  // in the row is touched — the graph still loads, still runs, and quietly has no gate.
  const graph = {
    pools: [
      { id: 'buffer', spendOrder: 10, target: { mode: 'YEARS_OF_SPEND', value: 2 },
        claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2b', from: 'growth', to: 'buffer', gate: { sourceReturnOver: 0 } }],
  };
  const param = { name: 'liquidityGraph', value: graph };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  assert.strictEqual(cell(host, 'gateKind').value, 'sourceReturnOver');
  assert.strictEqual(cell(host, 'flow').value, 'g2b');
  type(cell(host, 'priority'), '5', 'change');          // touch an unrelated cell
  assert.deepStrictEqual(param.value.flows[0].gate, { sourceReturnOver: 0 });
});

test('LiquidityGraph: a NEGATIVE return threshold survives the control', () => {
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'buffer', spendOrder: 10, target: { mode: 'AMOUNT', value: 1 }, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2b', from: 'growth', to: 'buffer' }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  button(host, 'Add Gate Clause').click();
  pick(cell(host, 'flow'), 'g2b');
  pick(cell(host, 'gateKind'), 'sourceReturnOver');
  type(cell(host, 'gateValue'), '-0.1', 'change');
  assert.deepStrictEqual(param.value.flows[0].gate, { sourceReturnOver: -0.1 });
});

test('LiquidityGraph: a RETURN clause offers no basis — it must not read as "(not found)"', () => {
  // A return clause reads the pool's own prior-year return; there is no second series it
  // could be measured against, which is why `normalizeGate` REFUSES a `drawdownBasis` on a
  // gate with no drawdown clause. A fixed two-option list therefore left the cell holding a
  // value no option matched, and `buildSelect` renders that — correctly, and alarmingly — as
  // "(not found)", which reads as a saved setting the app has lost.
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'offset', spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'o2g', from: 'offset', to: 'growth', amount: { fractionOfSource: 0.25 },
              gate: { targetReturnUnder: -0.1 } }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  const basis = cell(host, 'gateBasis');
  assert.strictEqual(basis.value, '');
  assert.doesNotMatch([...basis.options].map(o => o.textContent).join(' '), /not found/);
  // …and the reason is on screen rather than left as a blank the author reads as an omission.
  assert.match([...basis.options].map(o => o.textContent).join(' '), /n\/a/);
  // Touching an unrelated cell must not invent a basis for it either.
  type(cell(host, 'priority'), '1', 'change');
  assert.deepStrictEqual(param.value.flows[0].gate, { targetReturnUnder: -0.1 });
});

test('LiquidityGraph: switching a clause kind re-bases the row both ways', () => {
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'offset', spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'o2g', from: 'offset', to: 'growth', amount: { fractionOfSource: 0.25 },
              gate: { sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' } }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  assert.strictEqual(cell(host, 'gateBasis').value, 'INDEX');

  // drawdown → return: the stale INDEX would otherwise sit in a cell whose list no longer
  // offers it, which is the "(not found)" again, arrived at by editing instead of by loading.
  pick(cell(host, 'gateKind'), 'targetReturnUnder');
  const afterReturn = cell(host, 'gateBasis');
  assert.strictEqual(afterReturn.value, '');
  assert.doesNotMatch([...afterReturn.options].map(o => o.textContent).join(' '), /not found/);
  assert.deepStrictEqual(param.value.flows[0].gate, { targetReturnUnder: 0.05 });

  // …and back: a drawdown clause with no basis defaults to BALANCE, which is what the gate
  // itself does, so the cell agrees with the run rather than showing a blank.
  pick(cell(host, 'gateKind'), 'targetDrawdownOver');
  assert.strictEqual(cell(host, 'gateBasis').value, 'BALANCE');
  assert.deepStrictEqual(param.value.flows[0].gate, { targetDrawdownOver: 0.05 });
});

test('LiquidityGraph: OR # branches compose, and a per-clause dwell rides on the row', async () => {
  const { normalizeLiquidityGraph } = await import('../../src/finance/pools/liquidity-graph.js');
  // The rule design 97 §20.15 was built for, authored the way the app offers it: "within 5%
  // of its high for one year, OR within 1% of it for two". Two rows, two branches.
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'offset', spendOrder: 10, target: { mode: 'AMOUNT', value: 400000 }, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2o', from: 'growth', to: 'offset' }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));

  button(host, 'Add Gate Clause').click();
  pick(cell(host, 'flow'), 'g2o');
  pick(cell(host, 'gateKind'), 'sourceDrawdownUnder');
  type(cell(host, 'gateValue'), '0.05', 'change');
  pick(cell(host, 'gateBasis'), 'INDEX');

  button(host, 'Add Gate Clause').click();
  pick(cells(host, 'flow')[1], 'g2o');
  type(cells(host, 'branch')[1], '2', 'change');
  pick(cells(host, 'gateKind')[1], 'sourceDrawdownUnder');
  type(cells(host, 'gateValue')[1], '0.01', 'change');
  pick(cells(host, 'gateBasis')[1], 'INDEX');
  type(cells(host, 'gateYears')[1], '2', 'change');

  assert.deepStrictEqual(param.value.flows[0].gate, { anyOf: [
    { sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' },
    { sourceDrawdownUnder: 0.01, drawdownBasis: 'INDEX', sustainedYears: 2 },
  ] });
  // And it passes the only validator that counts.
  assert.ok(normalizeLiquidityGraph(param.value, ACCOUNTS).flows[0].gate.anyOf.length === 2);
});

test('LiquidityGraph: two clauses on ONE branch are an AND', () => {
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'buffer', spendOrder: 10, target: { mode: 'AMOUNT', value: 1 }, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2b', from: 'growth', to: 'buffer',
              gate: { allOf: [{ sourceReturnOver: 0 }, { sourceDrawdownUnder: 0.1 }] } }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  // Both clauses render, on the same branch, and survive an unrelated edit untouched.
  assert.strictEqual(cells(host, 'gateKind').length, 2);
  assert.strictEqual(cells(host, 'branch')[0].value, cells(host, 'branch')[1].value);
  type(cell(host, 'priority'), '3', 'change');
  assert.deepStrictEqual(param.value.flows[0].gate,
    { allOf: [{ sourceReturnOver: 0 }, { sourceDrawdownUnder: 0.1 }] });
});

test('LiquidityGraph: a gate the table cannot draw is round-tripped, not flattened', () => {
  // The escape hatch. An OR *inside* an AND is outside DNF, so the editor must carry it
  // through verbatim — a half-drawn gate still loads and still runs, which is the failure
  // mode this whole design keeps naming. (A flat `not` IS drawable; see the Sense tests.)
  const gate = { sourceReturnOver: 0,
                 anyOf: [{ sourceDrawdownUnder: 0.05 }, { targetDrawdownOver: 0.2 }] };
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'buffer', spendOrder: 10, target: { mode: 'AMOUNT', value: 1 }, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2b', from: 'growth', to: 'buffer', gate }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  assert.strictEqual(cells(host, 'gateKind').length, 0, 'nothing pretends to draw it');
  type(cell(host, 'priority'), '7', 'change');
  assert.deepStrictEqual(param.value.flows[0].gate, gate);
  // And the flow is not offered in the gate table at all: a clause row typed against it would
  // be silently ignored (the authored gate wins), i.e. a row on screen that is saved nowhere.
  button(host, 'Add Gate Clause').click();
  assert.ok(![...cell(host, 'flow').options].some(o => o.value === 'g2b'),
    'a flow with an undrawable gate is not selectable in the clause table');
});

test('LiquidityGraph: a clause can be NEGATED, which is how a down-market rule is said', async () => {
  const { normalizeLiquidityGraph } = await import('../../src/finance/pools/liquidity-graph.js');
  // The rule the four clause kinds cannot state in the positive: "refill cash from the OFFSET
  // only while equities are NOT within 5 % of their high". The engine has had `not` since
  // design 97 §20.15; before this the table could not author it.
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'buffer', spendOrder: 10, target: { mode: 'AMOUNT', value: 1 }, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2b', from: 'growth', to: 'buffer' }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  button(host, 'Add Gate Clause').click();
  pick(cell(host, 'flow'), 'g2b');
  pick(cell(host, 'gateNegate'), 'NOT');
  pick(cell(host, 'gateKind'), 'sourceDrawdownUnder');
  type(cell(host, 'gateValue'), '0.05', 'change');
  pick(cell(host, 'gateBasis'), 'INDEX');
  type(cell(host, 'gateYears'), '2', 'change');

  // The dwell rides on the NEGATION — "has NOT been within 5 % of its high for two years" —
  // not on the clause inside it, which would be the other policy.
  assert.deepStrictEqual(param.value.flows[0].gate,
    { not: { sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' }, sustainedYears: 2 });
  assert.ok(normalizeLiquidityGraph(param.value, ACCOUNTS).flows[0].gate.not);

  // …and it draws again as the same row on the next load, rather than falling to `rawGate`.
  const reloaded = { name: 'liquidityGraph', value: JSON.parse(JSON.stringify(param.value)) };
  const host2 = mount(buildLiquidityGraphEditor(reloaded, ACCOUNTS));
  assert.strictEqual(cell(host2, 'gateNegate').value, 'NOT');
  assert.strictEqual(cell(host2, 'gateKind').value, 'sourceDrawdownUnder');
  assert.strictEqual(cell(host2, 'gateYears').value, '2');
});

test('LiquidityGraph: a dwell INSIDE a `not` is left alone, not re-read as the other policy', () => {
  // `{ not: { X, sustainedYears: 2 } }` is "X has not held for two years"; the row means
  // "not-X has held for two years". Two different rules, so the table declines to draw it.
  const gate = { not: { sourceDrawdownUnder: 0.2, sustainedYears: 2 } };
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'buffer', spendOrder: 10, target: { mode: 'AMOUNT', value: 1 }, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2b', from: 'growth', to: 'buffer', gate }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  assert.strictEqual(cells(host, 'gateKind').length, 0);
  type(cell(host, 'priority'), '2', 'change');
  assert.deepStrictEqual(param.value.flows[0].gate, gate);
});

test('LiquidityGraph: the OR # is renumbered on screen, so it reads back as it was saved', () => {
  // The OR # is a POSITION: `rowsToGate` emits one branch per distinct number in ascending
  // order, so a 3 typed beside a 1 saves as branch 2. It has to say so on the spot — the bug
  // this fixes was discovering it on the next load.
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'buffer', spendOrder: 10, target: { mode: 'AMOUNT', value: 1 }, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2b', from: 'growth', to: 'buffer' }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  button(host, 'Add Gate Clause').click();
  button(host, 'Add Gate Clause').click();
  type(cells(host, 'branch')[1], '3', 'change');
  assert.deepStrictEqual(cells(host, 'branch').map(c => c.value), ['1', '2']);
  assert.strictEqual(param.value.flows[0].gate.anyOf.length, 2);

  // A lone clause has no alternative to be numbered against, so its OR # collapses to 1.
  cells(host, 'removeRow').at(-1).click();   // the gate table is the last one on the page
  assert.deepStrictEqual(cells(host, 'branch').map(c => c.value), ['1']);
  assert.ok(!param.value.flows[0].gate.anyOf, 'one branch is a bare node, not an anyOf');
});

test('LiquidityGraph: fields no column draws are carried, not deleted by an edit elsewhere', () => {
  // `floor`, a target `spendBasis` and `amount.max` are authored policy the tables cannot
  // show. Dropping them on the next keystroke would leave a graph that still loads and still
  // runs — the failure mode design 97 names five times. Carried like `ui`.
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'cash', spendOrder: 10, floor: { mode: 'AMOUNT', value: 25000 },
        target: { mode: 'YEARS_OF_SPEND', value: 2, spendBasis: 'TRAILING', trailingYears: 5 },
        claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash',
              trigger: { below: { mode: 'YEARS_OF_SPEND', value: 0.5, spendBasis: 'TRAILING' } },
              amount: { fractionOfSource: 0.25, max: 50000 } }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  type(cell(host, 'priority'), '3', 'change');
  const cash = param.value.pools.find(p => p.id === 'cash');
  assert.deepStrictEqual(cash.floor, { mode: 'AMOUNT', value: 25000 });
  assert.strictEqual(cash.target.spendBasis, 'TRAILING');
  assert.strictEqual(cash.target.trailingYears, 5);
  assert.strictEqual(param.value.flows[0].amount.max, 50000);
  assert.strictEqual(param.value.flows[0].trigger.below.spendBasis, 'TRAILING');
});

test('LiquidityGraph: an AMOUNT capacity is authorable, so the graph it writes builds', async () => {
  const { normalizeLiquidityGraph } = await import('../../src/finance/pools/liquidity-graph.js');
  // Selecting a non-derived capacity mode used to write `{ mode: 'AMOUNT' }` with no value,
  // which `sizeSpec` rejects — a mode on screen that could not be saved into a runnable plan.
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'cash', spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  pick(cells(host, 'capacity')[0], 'AMOUNT');
  type(cells(host, 'capacityValue')[0], '250000', 'change');
  assert.deepStrictEqual(param.value.pools[0].capacity, { mode: 'AMOUNT', value: 250000 });
  assert.doesNotThrow(() => normalizeLiquidityGraph(param.value, ACCOUNTS));
});
