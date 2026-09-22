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
  buildLiquidityShapesEditor, buildLiquidityGraphScheduleEditor, buildLiquidityTargetScheduleEditor,
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

test('LiquidityGraph: a residency-conditional target and a PAYCHECK edge round-trip', () => {
  // Design 107 §15.3 / §5.1. Both were authorable only by hand until they were drawn: a
  // `whenResident` survived as carried `extraKeys` data, and a `PAYCHECK` cadence was
  // COLLAPSED TO 'PERIOD' by the read — which would have silently turned an author's paycheck
  // edge into an ordinary refill on the next save, and it would still have loaded and run.
  const graph = {
    pools: [
      { id: 'spendingUs', label: 'Float — US', spendOrder: 0,
        target: { mode: 'YEARS_OF_SPEND', value: 1, whenResident: 'US' },
        claims: [{ key: 'usSavingsAccount' }] },
      { id: 'buffer', label: 'Bucket 2', spendOrder: 20,
        target: { mode: 'YEARS_OF_SPEND', value: 4 },
        claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    ],
    flows: [
      // `amount` is left off deliberately: `{ toTarget: true }` is the COMPILER's default
      // (`normalizeLiquidityGraph` fills it in), and the editor elides defaults for the same
      // reason it elides `cadence: 'PERIOD'` — writing them onto every edge would make every
      // previously-saved graph differ from itself on the next save, for nothing.
      { id: 'paycheck', from: 'buffer', to: 'spendingUs', priority: 10, cadence: 'PAYCHECK' },
    ],
  };
  const param = { name: 'liquidityGraph', value: graph };
  mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  assert.deepStrictEqual(param.value, graph);
  // And specifically, not written twice — once as a drawn column and once via `extraKeys`.
  assert.deepStrictEqual(Object.keys(param.value.pools[0].target).sort(),
    ['mode', 'value', 'whenResident']);
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

// ── §12.2b, the remainder target ───────────────────────────────────────────────

/** cash (1yr) + offset (capped) + bond (remainder), the shape the mode was built for. */
const REM_VALUE = () => ({ pools: [
  { id: 'cash',   spendOrder: 10, target: { mode: 'YEARS_OF_SPEND', value: 1 },
    claims: [{ key: 'usSavingsAccount' }] },
  { id: 'offset', spendOrder: 20, capacity: { mode: 'OFFSET_CAP' },
    target: { mode: 'AMOUNT', value: 9000000 }, claims: [{ key: 'auOffsetAccount' }] },
  { id: 'bond',   spendOrder: 30, target: { mode: 'YEARS_OF_SPEND_REMAINDER', value: 5,
    after: ['cash', 'offset'] }, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
] });

test('LiquidityGraph: a remainder target round-trips its `after` through the checkset', () => {
  // `after` used to fall through `extraKeys` as opaque carried data — round-tripped but not
  // authorable. Drawn now, which means it must ALSO be excluded from the carried set or the
  // sync writes it twice and the two copies drift.
  const param = { name: 'liquidityGraph', value: REM_VALUE() };
  const host  = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  const boxes = [...host.querySelectorAll('[data-id^="targetAfter:"]')];
  const on    = boxes.filter(b => b.checked).map(b => b.value);
  assert.deepStrictEqual(on, ['cash', 'offset'], 'both referenced pools read back ticked');

  // Untick one and the authored value follows.
  const off = boxes.find(b => b.value === 'cash');
  off.checked = false; off.dispatchEvent(new Event('change'));
  const bond = param.value.pools.find(p => p.id === 'bond');
  assert.deepStrictEqual(bond.target.after, ['offset']);
  assert.strictEqual(bond.target.mode, 'YEARS_OF_SPEND_REMAINDER');
  assert.strictEqual(bond.target.value, 5);
});

test('LiquidityGraph: only non-remainder OTHER pools are offered — the throw is unreachable', () => {
  // Chaining remainders throws (the resolution order would decide the answer) and so does
  // naming yourself. Neither is typable here: the options are the compiler's rule, on screen.
  const value = REM_VALUE();
  value.pools[0].target = { mode: 'YEARS_OF_SPEND_REMAINDER', value: 2, after: ['offset'] };
  const param = { name: 'liquidityGraph', value };
  const host  = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  const offered = [...host.querySelectorAll('[data-id^="targetAfter:"]')].map(b => b.value);
  // 'bond' and 'cash' are both remainders now, so neither is offered to the other; and no
  // pool is offered to itself. That leaves 'offset' twice — once per remainder row.
  assert.deepStrictEqual(offered, ['offset', 'offset']);
});

test('LiquidityGraph: the `after` cell is blank on every other target mode', () => {
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'cash', spendOrder: 10, target: { mode: 'YEARS_OF_SPEND', value: 1 },
              claims: [{ key: 'usSavingsAccount' }] },
             { id: 'bond', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  assert.strictEqual(host.querySelectorAll('[data-id^="targetAfter:"]').length, 0);
  // Selecting the mode draws it — `rerender` on the mode cell is what makes that happen, and
  // without it the row keeps a cell that cannot be filled in.
  pick(cells(host, 'targetMode')[1], 'YEARS_OF_SPEND_REMAINDER');
  const offered = [...host.querySelectorAll('[data-id^="targetAfter:"]')].map(b => b.value);
  assert.deepStrictEqual(offered, ['cash'], 'the other pool, not itself');
});

test('LiquidityGraph: renaming a pool unticks the reference rather than hiding it', () => {
  // Only live ids are drawn in the checkset, so a stale reference would be invisible on screen
  // and still throw at Rebuild — the "invisible until it throws" shape this editor exists to
  // remove. `sync` prunes it and `rerender` on the id cell makes the prune visible.
  const param = { name: 'liquidityGraph', value: REM_VALUE() };
  const host  = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  type(cells(host, 'id')[0], 'cash-renamed', 'change');
  const bond = param.value.pools.find(p => p.id === 'bond');
  assert.deepStrictEqual(bond.target.after, ['offset'], 'the dead reference is gone');
  const boxes = [...host.querySelectorAll('[data-id^="targetAfter:"]')];
  assert.ok(boxes.some(b => b.value === 'cash-renamed' && !b.checked),
    'and the new id is offered, unticked, where the user can see it');
});

test('LiquidityGraph: the remainder size cell is bounded in YEARS, not currency', () => {
  const param = { name: 'liquidityGraph', value: REM_VALUE() };
  const host  = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  const size  = cells(host, 'targetValue')[2];
  assert.strictEqual(size.max, '50');
  assert.match(size.title, /AGGREGATE/);
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

/*
 * CTRL-1 (design 110 §9). §14's `ui` constraint says the engine ignores the blob and every
 * surface that touches a graph preserves it. `normalizeLiquidityGraph` carries `raw.ui` on
 * BOTH pools and flows; design 110 §2.2 recorded that the promise was never asserted, and
 * the first assertion found the flow half missing — a layout authored on an EDGE was dropped
 * by the first edit to any cell, silently, with the graph still loading and still running.
 * That is `mortgagePaymentSourceKey`'s shape exactly, which is why §2.2 asked for the test
 * before anything draws a layout.
 */
test('LiquidityGraph CTRL-1: `ui` survives an edit on a flow as well as on a pool', () => {
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'cash',   spendOrder: 10, ui: { x: 40, y: 200 }, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash', ui: { bend: 0.3, label: 'refill' } }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  type(cell(host, 'label'), 'Bucket 1', 'change');
  assert.deepStrictEqual(param.value.pools[0].ui, { x: 40, y: 200 });
  assert.deepStrictEqual(param.value.flows[0].ui, { bend: 0.3, label: 'refill' },
    'a flow layout is dropped by the first edit — the normalizer carries it, the editor must too');
});

test('LiquidityGraph CTRL-1: a `ui` blob inside a named shape survives an edit', () => {
  // Design 109 §9 makes the pool id the identity across a switch, so a shape is where a
  // layout MOST needs to survive: the same node drawn in the same place in every shape is
  // what makes a switch legible. The shapes editor mounts the SAME graph editor per shape,
  // so this fails and passes with the case above — asserted anyway, because "the same
  // component" is the claim, not the guarantee.
  const param = { name: 'liquidityShapes', value: {
    bridge: {
      pools: [{ id: 'cash', spendOrder: 10, ui: { x: 1, y: 2 }, claims: [{ key: 'usSavingsAccount' }] },
              { id: 'bonds', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] }],
      flows: [{ id: 'b2c', from: 'bonds', to: 'cash', ui: { bend: 0.3 } }],
    },
  } };
  const host = mount(buildLiquidityShapesEditor(param, ACCOUNTS));
  type(cell(host, 'label'), 'Bucket 1', 'change');
  assert.deepStrictEqual(param.value.bridge.pools[0].ui, { x: 1, y: 2 });
  assert.deepStrictEqual(param.value.bridge.flows[0].ui, { bend: 0.3 });
});

// ═════════════════════════════════════════════════════════════════════════════
// Design 110 §4.2 — the derived readouts (CTRL-2, CTRL-3, CTRL-15)
//
// Every one of these is a property of a DERIVATION, not of a layout. The objection §4.2
// answers is that a second derivation is where one surface starts disagreeing with another
// (§23.6's `_seriesSpecs` exists because of exactly that), so the assertions are all of the
// form "the readout equals what the compiler says" rather than "the text contains a word".
// ═════════════════════════════════════════════════════════════════════════════

// Balances and lots, which `accountsProvider` carries for the "Holds today" readout and the
// narrow pre-design-110 projection did not. `usStockAccount` deliberately has a `balance`
// that DISAGREES with its lots: `claimValueNative` follows the holdings when an account has
// any, because that is what a draw really consumes (`holdings-balance-desync`).
const VALUED_ACCOUNTS = [
  { stateKey: 'usSavingsAccount', name: 'US Savings', type: 'savings',   balance: 50000,
    currency: 'USD' },
  { stateKey: 'usStockAccount',   name: 'US Stock',   type: 'brokerage', balance: 999,
    currency: 'USD',
    holdings: [{ allocation: 'EQUITY', marketValue: 300000 },
               { allocation: 'BOND',   marketValue: 120000 }] },
  { stateKey: 'auOffsetAccount',  name: 'Offset',     type: 'offset',    balance: 80000,
    currency: 'AUD' },
];

// jsdom's global has no `structuredClone`. These fixtures are plain JSON, so this is the
// same thing for them — and each test needs its own copy, because the editor mutates.
const copy = (v) => JSON.parse(JSON.stringify(v));

const GRAPH_FOR_READOUTS = {
  pools: [
    { id: 'cash',    label: 'Bucket 1', spendOrder: 10,
      claims: [{ key: 'usSavingsAccount' }] },
    { id: 'bonds',   label: 'Bucket 2', spendOrder: 20,
      target: { mode: 'YEARS_OF_SPEND', value: 4 },
      claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    // Multi-claim, and multi-currency — the case §4.2 item 2 says must NOT be summed onto
    // the pool, because `claimValueNative` returns each account's own currency.
    { id: 'growth',  label: 'Bucket 3', spendOrder: 30,
      claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }, { key: 'auOffsetAccount' }] },
  ],
  flows: [{ id: 'g2b', from: 'growth', to: 'bonds',
            gate: { sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' } }],
};

test('LiquidityGraph CTRL-2: the compiled-order readout equals compileToDrawdownSequence', async () => {
  const { normalizeLiquidityGraph, compileToDrawdownSequence } =
    await import('../../src/finance/pools/liquidity-graph.js');

  const param = { name: 'liquidityGraph', value: copy(GRAPH_FOR_READOUTS) };
  const host  = mount(buildLiquidityGraphEditor(param, VALUED_ACCOUNTS));

  // The authority, computed independently of the editor and from the SAVED value.
  const want = compileToDrawdownSequence(normalizeLiquidityGraph(param.value, VALUED_ACCOUNTS));
  const text = cell(host, 'compiled-order').textContent;

  assert.ok(want.length === 4, 'the fixture is multi-claim, or this test is not testing one');
  // Every entry, in order, with its sleeve narrowing — the join §4.2 item 3 makes visible.
  want.forEach((e, i) => {
    assert.ok(text.includes(`${i + 1}. ${e.key}`),
      `position ${i + 1} must name ${e.key}; readout was: ${text}`);
  });
  assert.ok(text.indexOf('1. usSavingsAccount') < text.indexOf('2. usStockAccount'),
    'the readout must be in compiled order, not table order');
  // §3.1 rule 3, stated rather than documented — and on its OWN line: appended to the list
  // it reads as one sentence, because the spaces meant to separate them collapse in HTML.
  assert.match(cell(host, 'compiled-order-rule').textContent, /drawdownPriority/);
  assert.ok(!/drawdownPriority/.test(text), 'the rule is a separate element, not a tail');
});

test('LiquidityGraph CTRL-2: a pool with no Spend # is shown as never spent from', () => {
  // §22.5 trap 1's other half. `spendOrder` starts BLANK, so a pool the author added and did
  // not place compiles to nothing — and from every other surface that looks identical to the
  // graph having failed to load. The readout has to say which it is.
  const graph = copy(GRAPH_FOR_READOUTS);
  delete graph.pools[2].spendOrder;
  const param = { name: 'liquidityGraph', value: graph };
  const host  = mount(buildLiquidityGraphEditor(param, VALUED_ACCOUNTS));
  const text  = cell(host, 'compiled-order').textContent;
  assert.match(text, /never spent from: growth/);
  assert.ok(!text.includes('3. '), 'growth has no spendOrder, so it is not a position in the order');
});

test('LiquidityGraph CTRL-2: no pool with a Spend # reads as the drawdownPriority fallback', () => {
  const graph = copy(GRAPH_FOR_READOUTS);
  for (const p of graph.pools) delete p.spendOrder;
  const param = { name: 'liquidityGraph', value: graph };
  const host  = mount(buildLiquidityGraphEditor(param, VALUED_ACCOUNTS));
  assert.match(cell(host, 'compiled-order').textContent, /nothing is drawn from the graph/);
});

test('LiquidityGraph CTRL-2: "Holds today" reads claimValueNative, per claim and per currency', async () => {
  const { claimValueNative } = await import('../../src/finance/pools/pool-metrics.js');
  const param = { name: 'liquidityGraph', value: copy(GRAPH_FOR_READOUTS) };
  const host  = mount(buildLiquidityGraphEditor(param, VALUED_ACCOUNTS));

  const shown = cells(host, 'holdsNow').map(n => n.textContent);
  assert.strictEqual(shown.length, 4, 'one readout per CLAIM row');

  // The savings claim is the balance; the sleeve-narrowed brokerage claims are their LOTS,
  // not the account's (disagreeing) balance of 999 — the property `claimValueNative` owns.
  const stock = VALUED_ACCOUNTS.find(a => a.stateKey === 'usStockAccount');
  assert.strictEqual(claimValueNative(stock, ['BOND']), 120000, 'the authority, restated');
  assert.strictEqual(shown[0], '50,000 USD');
  assert.strictEqual(shown[1], '120,000 USD');
  assert.strictEqual(shown[2], '300,000 USD');
  // The AUD claim keeps its OWN currency and is not converted or summed with the two USD
  // ones beside it — §4.2 item 2's whole reason for living on the claim row.
  assert.strictEqual(shown[3], '80,000 AUD');
});

test('LiquidityGraph CTRL-2: a sleeve-narrowed claim on an account with no lots holds nothing', () => {
  // The half of `claimValueNative` a reader who guessed would have got wrong: it is 0, not
  // the account's cash balance. A savings account cannot be narrowed (the normalizer refuses
  // it), so this is the shape of a misauthored claim — and the readout is what shows it.
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'cash', spendOrder: 10,
              claims: [{ key: 'usSavingsAccount', sleeves: ['BOND'] }] }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, VALUED_ACCOUNTS));
  assert.strictEqual(cell(host, 'holdsNow').textContent, '0 USD');
});

test('LiquidityGraph CTRL-2: each pool\u2019s claims are the join, done once', () => {
  // Under the tables rather than as a cell on the Pools row — see the readout's own comment.
  // Measured in the running app: a twelfth column took ~13% off every authoring cell in a
  // table whose cells already truncate a mode name to three characters.
  const param = { name: 'liquidityGraph', value: copy(GRAPH_FOR_READOUTS) };
  const host  = mount(buildLiquidityGraphEditor(param, VALUED_ACCOUNTS));
  assert.strictEqual(cell(host, 'pool-claims-cash').textContent,
    'cash: usSavingsAccount (whole account)');
  assert.strictEqual(cell(host, 'pool-claims-bonds').textContent,
    'bonds: usStockAccount (BOND)');
  // The multi-claim, multi-currency pool: both claims named, neither summed.
  assert.strictEqual(cell(host, 'pool-claims-growth').textContent,
    'growth: usStockAccount (EQUITY), auOffsetAccount (whole account)');
});

test('LiquidityGraph CTRL-2: a pool with no claims says so rather than rendering blank', () => {
  // "A pool with no claims holds nothing" is already the claims table's empty text; a BLANK
  // cell on the pool row reads as a control that failed to draw, which is the same mistake
  // `row-list-note` was introduced for on the sleeves checkset.
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'cash', spendOrder: 10, claims: [] }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, VALUED_ACCOUNTS));
  assert.strictEqual(cell(host, 'pool-claims-cash').textContent, 'cash: holds nothing');
});

test('LiquidityGraph CTRL-2: the readouts track an edit — they are not a first-render snapshot', () => {
  // The reason every table's `onChange` refreshes them. A readout that was right when the
  // editor was built and stale thereafter is worse than none: it is a confident wrong answer
  // about the graph the author is looking at.
  const param = { name: 'liquidityGraph', value: copy(GRAPH_FOR_READOUTS) };
  const host  = mount(buildLiquidityGraphEditor(param, VALUED_ACCOUNTS));
  assert.ok(cell(host, 'compiled-order').textContent.includes('1. usSavingsAccount'));

  // Push `cash` to the back of the queue. It lands at position FOUR, not three: `growth`
  // holds two claims, and the compiled sequence is one entry per CLAIM rather than per pool
  // — which is the join §4.2 item 3 exists to make visible.
  type(cells(host, 'spendOrder')[0], '99', 'change');
  assert.ok(cell(host, 'compiled-order').textContent.includes('4. usSavingsAccount'),
    'the compiled order must follow the edit');
});

test('LiquidityGraph CTRL-3: the gate prose names the clause, its basis, its scope and its dwell', () => {
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'growth', spendOrder: 10, claims: [{ key: 'usStockAccount' }] },
            { id: 'cash',   spendOrder: 20, target: { mode: 'YEARS_OF_SPEND', value: 1 },
              claims: [{ key: 'usSavingsAccount' }] }],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash',
              gate: { scope: 'EDGE', sourceDrawdownUnder: 0.05,
                      drawdownBasis: 'INDEX', sustainedYears: 2 } }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, VALUED_ACCOUNTS));
  const text = cell(host, 'gate-prose-g2c').textContent;

  assert.match(text, /source within 0\.05 of its high/, 'the clause');
  assert.match(text, /return index/,                    'the basis (§20.14: it changes the behaviour)');
  assert.match(text, /filling the destination pool/,    'the scope (§12.4c)');
  assert.match(text, /for 2 consecutive years/,         'the dwell (§20.13: the lever that moves the answer)');
});

test('LiquidityGraph CTRL-3: a two-branch gate renders as an OR of ANDs', () => {
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'growth', spendOrder: 10, claims: [{ key: 'usStockAccount' }] },
            { id: 'cash',   spendOrder: 20, target: { mode: 'YEARS_OF_SPEND', value: 1 },
              claims: [{ key: 'usSavingsAccount' }] }],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash', gate: { anyOf: [
      { sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX', sustainedYears: 1 },
      { sourceDrawdownUnder: 0.01, drawdownBasis: 'INDEX', sustainedYears: 2 },
    ] } }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, VALUED_ACCOUNTS));
  const text = cell(host, 'gate-prose-g2c').textContent;
  // Each branch is parenthesised and the branches are ORed — disjunctive normal form, said
  // aloud. (A loose `[^)]*` cannot match here: the basis clause nests its own parentheses.)
  assert.ok(text.includes(') OR ('), `two branches must read as an OR: ${text}`);
  assert.match(text, /\(source within 0\.05 of its high \(measured against its return index\)\) OR /);
  assert.match(text, /for 2 consecutive years/);
});

test('LiquidityGraph CTRL-3: a rawGate renders as "authored directly", never as half a sentence', () => {
  // §20.15's escape hatch. The clause table does not DRAW a gate outside DNF, so the prose
  // must not pretend to describe one — a partial sentence about a gate the author cannot see
  // in the table is exactly the "silently dropped half a gate" failure `rawGate` exists for.
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'growth', spendOrder: 10, claims: [{ key: 'usStockAccount' }] },
            { id: 'cash',   spendOrder: 20, target: { mode: 'YEARS_OF_SPEND', value: 1 },
              claims: [{ key: 'usSavingsAccount' }] }],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash',
              gate: { allOf: [{ anyOf: [{ sourceDrawdownUnder: 0.05 },
                                        { targetDrawdownOver: 0.2 }] }] } }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, VALUED_ACCOUNTS));
  const text = cell(host, 'gate-prose-g2c').textContent;
  assert.match(text, /authored directly/);
  assert.ok(!/blocks /.test(text), 'it must not render a partial description of a gate it cannot draw');
});

test('LiquidityGraph CTRL-3: an ungated flow says so rather than rendering nothing', () => {
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'growth', spendOrder: 10, claims: [{ key: 'usStockAccount' }] },
            { id: 'cash',   spendOrder: 20, target: { mode: 'YEARS_OF_SPEND', value: 1 },
              claims: [{ key: 'usSavingsAccount' }] }],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash' }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, VALUED_ACCOUNTS));
  assert.match(cell(host, 'gate-prose-g2c').textContent, /no gate/);
});

test('LiquidityGraph CTRL-15: three switch states render three lines, and the readouts render in all three', () => {
  // §10.5. Hiding the readouts when the graph is switched off would make the switch a way to
  // stop seeing the graph you are editing — which is precisely what validation refuses to do
  // (`collectAuthoredGraphProblems` keeps reporting while the switch is off, "because the
  // switch is a run-time 'ignore this', not an authoring-time 'this is fine'").
  const seen = new Set();
  for (const flags of [{},
                       { liquidityGraphEnabled: false },
                       { poolFlowsEnabled: false }]) {
    const param = { name: 'liquidityGraph', value: copy(GRAPH_FOR_READOUTS) };
    const host  = mount(buildLiquidityGraphEditor(param, VALUED_ACCOUNTS, () => flags));
    seen.add(cell(host, 'graph-provenance').textContent);
    assert.ok(cell(host, 'compiled-order').textContent.includes('1. usSavingsAccount'),
      'the readouts render in every state — only the line above them changes');
  }
  assert.strictEqual(seen.size, 3, 'three distinct states must read as three distinct lines');

  const off = [...seen].find(t => t.includes('liquidityGraphEnabled'));
  assert.match(off, /will NOT be used/, 'the off state must say the order is not the run’s');
});

test('LiquidityShapes CTRL-15: a shape names itself and does not claim the whole run', () => {
  // The fourth state. A shape is live only in the years its schedule selects it, so the base
  // graph's "this is the order the run will use" is false for every other year — and design
  // 109 §7 makes the switch date and the authored year differ by up to a cadence, which is
  // why the line names the shape and never a date.
  const param = { name: 'liquidityShapes', value: { bridge: copy(GRAPH_FOR_READOUTS) } };
  const host  = mount(buildLiquidityShapesEditor(param, VALUED_ACCOUNTS, () => ({})));
  const text  = cell(host, 'graph-provenance').textContent;
  assert.match(text, /Shape 'bridge'/);
  assert.match(text, /not the whole run/);
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

// ── §12.4c, gate.scope ─────────────────────────────────────────────────────────

/** Two edges out of one source — the shape §12.4c exists for. */
const SCOPE_PARAM = (gate) => ({ name: 'liquidityGraph', value: {
  pools: [
    { id: 'buffer', spendOrder: 10, target: { mode: 'AMOUNT', value: 300000 },
      claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    { id: 'offset', spendOrder: 20, target: { mode: 'AMOUNT', value: 200000 },
      claims: [{ key: 'auOffsetAccount' }] },
    { id: 'growth', spendOrder: 30, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
  ],
  flows: [
    { id: 'g2b', from: 'growth', to: 'buffer', amount: { toTarget: true },
      gate: gate ?? { sourceDrawdownUnder: 0.4, drawdownBasis: 'INDEX' } },
    { id: 'g2o', from: 'growth', to: 'offset', amount: { toTarget: true },
      gate: { sourceDrawdownUnder: 0.1, drawdownBasis: 'INDEX' } },
  ],
} });

test('LiquidityGraph: the Vetoes cell defaults to SOURCE and writes EDGE onto the gate ROOT', async () => {
  const { normalizeLiquidityGraph } = await import('../../src/finance/pools/liquidity-graph.js');
  const param = SCOPE_PARAM();
  const host  = mount(buildLiquidityGraphEditor(param, ACCOUNTS));

  // An unscoped gate reads as SOURCE — the cell must show the effective value, not a blank
  // that leaves the author guessing which way an absent field falls.
  assert.strictEqual(cell(host, 'gateScope').value, 'SOURCE');

  pick(cell(host, 'gateScope'), 'EDGE');
  // The ROOT, because `normalizeGate` rejects a nested scope — writing it beside the clause
  // would produce a graph the editor itself cannot load.
  assert.deepStrictEqual(param.value.flows[0].gate,
    { sourceDrawdownUnder: 0.4, drawdownBasis: 'INDEX', scope: 'EDGE' });
  // The sibling edge is untouched: that independence is the whole feature.
  assert.deepStrictEqual(param.value.flows[1].gate,
    { sourceDrawdownUnder: 0.1, drawdownBasis: 'INDEX' });

  // EDGE beside SOURCE out of one pool is the MIXED set: the SOURCE-scoped g2o still floors
  // 'growth', so the loader must say so. Captured rather than printed — it is the contract.
  const warnings = [];
  const warn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    assert.ok(normalizeLiquidityGraph(param.value, ACCOUNTS));
  } finally {
    console.warn = warn;
  }
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /pool 'growth' is the source of 2 gated edges \('g2b', 'g2o'\)/);
});

test('LiquidityGraph: SOURCE is not written back — a pre-12.4c graph stays byte-identical', () => {
  const param = SCOPE_PARAM();
  const before = JSON.parse(JSON.stringify(param.value.flows[0].gate));
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  // Re-picking the default must not author it. An authored default makes every saved graph
  // differ from itself on the next save, which is the rule `sustainedYears: 1` follows.
  pick(cell(host, 'gateScope'), 'SOURCE');
  assert.deepStrictEqual(param.value.flows[0].gate, before);
});

test('LiquidityGraph: one gate, one scope — an edit reaches every clause of that flow', () => {
  // The scope lives on the gate ROOT but the table is one row per CLAUSE. Without the
  // propagation the save path picks a winner the author cannot see, and a two-clause gate
  // silently saves whichever row happened to say EDGE.
  const param = SCOPE_PARAM({ allOf: [{ sourceReturnOver: 0 }, { sourceDrawdownUnder: 0.4 }] });
  const host  = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  const scopes = cells(host, 'gateScope');
  assert.ok(scopes.length >= 3, 'two clauses for g2b plus one for g2o');

  pick(scopes[0], 'EDGE');
  const after = cells(host, 'gateScope');
  assert.strictEqual(after[0].value, 'EDGE');
  assert.strictEqual(after[1].value, 'EDGE', 'the sibling clause of the SAME gate follows');
  assert.strictEqual(after[2].value, 'SOURCE', 'the other flow does not');
  assert.strictEqual(param.value.flows[0].gate.scope, 'EDGE');
  assert.strictEqual(param.value.flows[1].gate.scope, undefined);
});

test('LiquidityGraph: a SAVED EDGE-scoped gate still draws its clause rows', () => {
  // The bug this closes: `scope` sits on the gate ROOT, and on a single-clause gate the root
  // IS the leaf. `gateNodeToRow`'s unknown-key guard therefore saw `scope`, refused the row,
  // and `gateToRows` sent the whole flow to `rawGate` — so setting both gates to EDGE, saving
  // and reopening left the gate table EMPTY. The gate itself round-trips (buildFlow returns
  // `rawGate` verbatim), which is what made it a pure UI disappearance rather than data loss.
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'buffer', spendOrder: 10, target: { mode: 'AMOUNT', value: 300000 },
        claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2b', from: 'growth', to: 'buffer', amount: { toTarget: true },
              gate: { sourceDrawdownUnder: 0.4, drawdownBasis: 'INDEX', scope: 'EDGE' } }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));

  assert.strictEqual(cells(host, 'gateKind').length, 1, 'the clause row must still be drawn');
  assert.strictEqual(cell(host, 'gateKind').value, 'sourceDrawdownUnder');
  assert.strictEqual(cell(host, 'gateValue').value, '0.4');
  assert.strictEqual(cell(host, 'gateScope').value, 'EDGE', 'and it shows the saved scope');

  // An unrelated edit must not now rewrite the gate — the round-trip has to be exact.
  type(cell(host, 'priority'), '3', 'change');
  assert.deepStrictEqual(param.value.flows[0].gate,
    { sourceDrawdownUnder: 0.4, drawdownBasis: 'INDEX', scope: 'EDGE' });
});

test('LiquidityGraph: an EDGE scope on a MULTI-clause gate also redraws', () => {
  // The allOf/anyOf shapes take a different path through `gateToRows` — the root is not a
  // leaf there — so they need their own pin rather than an argument that they are similar.
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'buffer', spendOrder: 10, target: { mode: 'AMOUNT', value: 1 },
        claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2b', from: 'growth', to: 'buffer', amount: { toTarget: true },
              gate: { scope: 'EDGE',
                      anyOf: [{ sourceDrawdownUnder: 0.4, drawdownBasis: 'INDEX' },
                              { sourceReturnOver: 0.02 }] } }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  assert.strictEqual(cells(host, 'gateKind').length, 2);
  assert.deepStrictEqual(cells(host, 'gateScope').map(c => c.value), ['EDGE', 'EDGE']);
  type(cell(host, 'priority'), '3', 'change');
  assert.strictEqual(param.value.flows[0].gate.scope, 'EDGE');
  assert.strictEqual(param.value.flows[0].gate.anyOf.length, 2);
});

test('LiquidityGraph: a scope on a gate the table cannot draw survives untouched', () => {
  // `rawGate` keeps an inexpressible gate verbatim. Its scope must ride along, or opening the
  // editor would silently downgrade an EDGE-scoped composed gate to SOURCE.
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'buffer', spendOrder: 10, target: { mode: 'AMOUNT', value: 1 },
        claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2b', from: 'growth', to: 'buffer', amount: { toTarget: true },
              gate: { scope: 'EDGE',
                      anyOf: [{ allOf: [{ sourceReturnOver: 0 }, { sourceDrawdownUnder: 0.1 }] },
                              { not: { targetDrawdownOver: 0.2 } }] } }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  type(cell(host, 'priority'), '3', 'change');
  assert.strictEqual(param.value.flows[0].gate.scope, 'EDGE');
});

// ─── design 97 §22.5 / §24.6 — the two defaults that made a correct path look broken ──────

test('LiquidityGraph: a new pool starts with NO spendOrder, not behind every existing pool', () => {
  // §22.5 trap 1. Defaulting to `(pools.length + 1) * 10` put every new pool behind `growth`,
  // which on most plans is the residual pool and never runs dry — so the new pool was never
  // reached. §18.6's corollary: a pool placed after one that never empties is not
  // low-priority, it is unclaimed. The author added a pool, rebuilt, saw no change, and
  // concluded the control did not work.
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount' }] },
    ],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  button(host, 'Add Pool').click();

  const orders = cells(host, 'spendOrder');
  assert.strictEqual(orders[orders.length - 1].value, '',
    'blank — the placeholder already reads "never", so the position is a decision');

  // And it must not be written as a number by the sync either.
  const id = cells(host, 'id').at(-1);
  type(id, 'wrappers', 'change');
  assert.strictEqual(param.value.pools.at(-1).spendOrder, undefined);
});

test('LiquidityGraph: a new claim defaults to the LAST pool, which is the one just added', () => {
  // §22.5 trap 2. "+ Add Pool" then "+ Add Claim" is the authoring order, so defaulting the
  // claim's pool cell to `pools[0]` silently landed the new pool's first claim in bucket 1 —
  // a row that reads correct in the table and belongs to the wrong pool.
  const param = { name: 'liquidityGraph', value: {
    pools: [
      { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount' }] },
    ],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  button(host, 'Add Claim').click();

  assert.strictEqual(cells(host, 'pool').at(-1).value, 'growth');
});

test('LiquidityGraph: add a pool, then a claim — the claim lands in the pool just added', () => {
  // The two fixes together, in the order an author actually works.
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'cash', spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));

  button(host, 'Add Pool').click();
  type(cells(host, 'id').at(-1), 'wrappers', 'change');
  button(host, 'Add Claim').click();

  assert.strictEqual(cells(host, 'pool').at(-1).value, 'wrappers');
  assert.deepStrictEqual(param.value.pools.map(p => p.id), ['cash', 'wrappers']);
});

test('LiquidityGraph: `access` defaults to PENALTY_FREE and is written only when it deviates', () => {
  // §24.5 / §22.9's rule: the only value that ever appears in a file is a decision somebody
  // actually made, so the default is not written and absent means "the default applies".
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'cash', spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));

  const access = cell(host, 'access');
  assert.strictEqual(access.value, 'PENALTY_FREE', 'the cell shows the policy in force');
  assert.strictEqual(param.value.pools[0].access, undefined, 'and does not author it');

  pick(access, 'ALLOW_PENALTY');
  assert.deepStrictEqual(param.value.pools[0].access, { mode: 'ALLOW_PENALTY' });

  pick(cell(host, 'access'), 'PENALTY_FREE');
  assert.strictEqual(param.value.pools[0].access, undefined, 'and back to absent, not written');
});

test('LiquidityGraph: an authored ALLOW_PENALTY round-trips through the editor', () => {
  const param = { name: 'liquidityGraph', value: {
    pools: [{ id: 'last', spendOrder: 90, access: { mode: 'ALLOW_PENALTY' },
              claims: [{ key: 'usStockAccount' }] }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  assert.strictEqual(cell(host, 'access').value, 'ALLOW_PENALTY');
  assert.deepStrictEqual(param.value.pools[0].access, { mode: 'ALLOW_PENALTY' });
});

// ═════════════════════════════════════════════════════════════════════════════
// design 109 §11 — the shapes list and the schedule table
// ═════════════════════════════════════════════════════════════════════════════

const SHAPE_A = { pools: [
  { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
  { id: 'bonds',  spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
] };
const SHAPE_B = { pools: [
  { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
  { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
] };

test('LiquidityGraphSchedule: the base graph is stated, not left as an unauthored gap', () => {
  // Without row 0 the table says "the bridge starts in 2035" and the first nine years look
  // unauthored, when `liquidityGraph` governs them.
  const param = { name: 'liquidityGraphSchedule', value: [{ year: 2035, shape: 'bridge' }] };
  const host = mount(buildLiquidityGraphScheduleEditor(param, () => ['bridge']));
  assert.match(cell(host, 'base-row').textContent, /Before the first year below/);
});

test('LiquidityGraphSchedule: with no shapes it says where to make one', () => {
  const param = { name: 'liquidityGraphSchedule', value: null };
  const host = mount(buildLiquidityGraphScheduleEditor(param, () => []));
  assert.match(cell(host, 'base-row').textContent, /add one under Liquidity Pool Shapes/i);
});

test('LiquidityGraphSchedule: the shape cell is a SELECT over live ids, not free text', () => {
  // A typo is refused at load, so the author would find out at Rebuild — the "invisible until
  // it throws" shape this editor exists to remove.
  const param = { name: 'liquidityGraphSchedule', value: [{ year: 2035, shape: 'bridge' }] };
  const host = mount(buildLiquidityGraphScheduleEditor(param, () => ['bridge', 'late']));
  const sel = cell(host, 'shape');
  assert.equal(sel.tagName, 'SELECT');
  // The live ids, then the base graph (design 39 §14.9.8), which is always selectable.
  assert.deepStrictEqual([...sel.options].map(o => o.textContent), ['bridge', 'late', 'Base graph']);
});

test('LiquidityGraphSchedule: a base-graph row (shape: null) survives opening the editor', () => {
  // `sync()` runs on build. Before base rows existed it kept only string shapes, so a row the
  // MPC Pool Shape lever saved as `shape: null` would have been deleted by merely opening the
  // Scenario panel.
  const param = { name: 'liquidityGraphSchedule',
    value: [{ year: 2035, shape: 'bridge' }, { year: 2045, shape: null }] };
  const host = mount(buildLiquidityGraphScheduleEditor(param, () => ['bridge']));
  assert.deepStrictEqual(param.value, [{ year: 2035, shape: 'bridge' }, { year: 2045, shape: null }]);
  const sel = cells(host, 'shape').at(-1);
  assert.equal(sel.selectedOptions[0].textContent, 'Base graph');
  assert.doesNotMatch([...sel.options].map(o => o.textContent).join(' '), /not found/);
});

test('LiquidityGraphSchedule: a row pointing at a DELETED shape is kept and marked', () => {
  const param = { name: 'liquidityGraphSchedule', value: [{ year: 2035, shape: 'gone' }] };
  const host = mount(buildLiquidityGraphScheduleEditor(param, () => ['bridge']));
  const sel = cell(host, 'shape');
  assert.strictEqual(sel.value, 'gone', 'silently re-pointing it would be a plan nobody chose');
  assert.match([...sel.options].map(o => o.textContent).join(' '), /not found/);
});

test('LiquidityGraphSchedule: rows sort by year, and an incomplete row is not written', () => {
  const param = { name: 'liquidityGraphSchedule', value: [{ year: 2050, shape: 'late' }] };
  const host = mount(buildLiquidityGraphScheduleEditor(param, () => ['bridge', 'late']));

  button(host, 'Add Year').click();
  type(cells(host, 'year').at(-1), '2035', 'change');
  pick(cells(host, 'shape').at(-1), 'bridge');

  assert.deepStrictEqual(param.value, [
    { year: 2035, shape: 'bridge' },
    { year: 2050, shape: 'late' },
  ]);
});

test('LiquidityShapes: a shape holds the SAME three-table editor the base graph uses', () => {
  const param = { name: 'liquidityShapes', value: { bridge: SHAPE_A } };
  const host = mount(buildLiquidityShapesEditor(param, ACCOUNTS));
  assert.strictEqual(cell(host, 'shape-id').value, 'bridge');
  // The pools table is present and populated — one vocabulary, not two.
  assert.deepStrictEqual(cells(host, 'id').map(c => c.value), ['cash', 'bonds']);
});

test('LiquidityShapes: + Duplicate copies the pool IDS verbatim — that is the point', () => {
  // §4 Q1's cost is that a one-number change means a whole second graph; §9 makes the pool id
  // the handle for identity across a switch. Re-typing is how an id drifts, and a drifted id
  // retires a pool and starts another whose trailing high is zero.
  const param = { name: 'liquidityShapes', value: { bridge: SHAPE_A } };
  const host = mount(buildLiquidityShapesEditor(param, ACCOUNTS));

  button(host, 'Duplicate').click();
  assert.deepStrictEqual(Object.keys(param.value), ['bridge', 'bridge-copy']);
  assert.deepStrictEqual(
    param.value['bridge-copy'].pools.map(p => p.id),
    param.value.bridge.pools.map(p => p.id));
});

test('LiquidityShapes: the duplicate is a deep copy — editing one does not move the other', () => {
  const param = { name: 'liquidityShapes', value: { bridge: SHAPE_A } };
  const host = mount(buildLiquidityShapesEditor(param, ACCOUNTS));
  button(host, 'Duplicate').click();

  param.value['bridge-copy'].pools[0].spendOrder = 99;
  assert.strictEqual(param.value.bridge.pools[0].spendOrder, 10);
});

test('LiquidityShapes: the diff line names pools carried, added and retired', () => {
  // §9's rule made visible while authoring — a RENAMED pool shows up as one retired and one
  // added, which is exactly the mistake the line exists to catch.
  const param = { name: 'liquidityShapes', value: { first: SHAPE_A, second: SHAPE_B } };
  const host = mount(buildLiquidityShapesEditor(param, ACCOUNTS));

  assert.match(cell(host, 'shape-diff-0').textContent, /2 pool\(s\)/);
  const d = cell(host, 'shape-diff-1').textContent;
  assert.match(d, /vs first/);
  assert.match(d, /1 carried/);
  assert.match(d, /added growth/);
  assert.match(d, /retired bonds/);
});

test('LiquidityShapes: renaming a shape keeps its graph, and clearing every shape writes null', () => {
  const param = { name: 'liquidityShapes', value: { bridge: SHAPE_A } };
  const host = mount(buildLiquidityShapesEditor(param, ACCOUNTS));

  type(cell(host, 'shape-id'), 'theBridge', 'change');
  assert.deepStrictEqual(Object.keys(param.value), ['theBridge']);
  assert.deepStrictEqual(param.value.theBridge.pools.map(p => p.id), ['cash', 'bonds']);

  host.querySelector('.age-band-remove').click();
  assert.strictEqual(param.value, null, 'absent, not an empty object');
});

test('LiquidityShapes: the shape head carries four controls on its own column template', () => {
  // On `.mix-block-head`'s three columns the Duplicate button was squeezed into the 26px
  // remove slot and the ✕ wrapped to a second row, overflowing to the right. jsdom computes
  // no layout, so this asserts the CONTRACT: four children, and the class that gives them
  // four columns.
  const param = { name: 'liquidityShapes', value: { bridge: SHAPE_A } };
  const host = mount(buildLiquidityShapesEditor(param, ACCOUNTS));
  const head = host.querySelector('.mix-block-head');
  assert.ok(head.classList.contains('pool-shape-head'));
  assert.strictEqual(head.children.length, 4, 'label, input, Duplicate, Remove');
});

test('LiquidityGraph CTRL-4: an advisory renders in the editor and refuses nothing', () => {
  // Design 110 §4.3's whole point. The two design-109 warnings were `console.warn`, which
  // reaches nobody. They now arrive with the rest of the problems and are drawn above the
  // readouts — and the readouts still render, because a warning is not a refusal.
  const flags = () => ({ problems: [
    { param: 'liquidityShapes', shape: null, severity: 'warn',
      message: "liquidityShapes: 'orphan' is not selected by any row." },
    { param: 'liquidityGraph', shape: null, severity: 'error',
      message: 'a bad cell — this one is a refusal and is NOT drawn here' },
  ] });
  const param = { name: 'liquidityGraph', value: copy(GRAPH_FOR_READOUTS) };
  const host  = mount(buildLiquidityGraphEditor(param, VALUED_ACCOUNTS, flags));

  const shown = cells(host, 'graph-advisory').map(n => n.textContent);
  assert.deepStrictEqual(shown, ["liquidityShapes: 'orphan' is not selected by any row."],
    'advisories are drawn; refusals belong to the Rebuild guard, not to this block');
  assert.ok(cell(host, 'compiled-order').textContent.includes('1. usSavingsAccount'),
    'a warning must not take the readouts down with it');
});

test('LiquidityShapes CTRL-4: a shape sees its OWN advisories, not every shape’s', () => {
  // Without the split, every one of the N shape editors on a scheduled plan repeats every
  // warning — saying everything everywhere instead of saying it in the right place.
  const flags = () => ({ problems: [
    { param: 'liquidityShapes', shape: 'bridge', severity: 'warn', message: 'about bridge' },
    { param: 'liquidityShapes', shape: 'late',   severity: 'warn', message: 'about late' },
    { param: 'liquidityGraphSchedule', shape: null, severity: 'warn', message: 'about the base graph' },
  ] });
  const param = { name: 'liquidityShapes', value: { bridge: copy(GRAPH_FOR_READOUTS) } };
  const host  = mount(buildLiquidityShapesEditor(param, VALUED_ACCOUNTS, flags));
  assert.deepStrictEqual(cells(host, 'graph-advisory').map(n => n.textContent), ['about bridge']);
});

// ═════════════════════════════════════════════════════════════════════════════
// Design 110 §6.3 option A — the gate clause's optional ADDRESS (phase 8)
//
// §20.15's branch number is a POSITION (`renumberBranches` densely renumbers on every edit),
// so a threshold had no address and could not be an axis. The `Search id` cell is that address.
// The property worth testing is the one that makes it safe: blank means exactly what every
// graph authored before it means, and filling it in changes nothing about the run.
// ═════════════════════════════════════════════════════════════════════════════

const IDD_GRAPH = () => ({
  pools: [
    { id: 'buffer', spendOrder: 10, target: { mode: 'YEARS_OF_SPEND', value: 2 },
      claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
  ],
  flows: [{ id: 'g2b', from: 'growth', to: 'buffer',
            gate: { id: 'harvest', sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' } }],
});

test('LiquidityGraph: a gate clause id round-trips and survives an unrelated edit', () => {
  const param = { name: 'liquidityGraph', value: IDD_GRAPH() };
  const host  = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  assert.strictEqual(cell(host, 'gateId').value, 'harvest', 'the address is shown, not hidden');

  // The failure this pins is the one §2.2 found for `ui` and design 109 §12 found for a gate
  // kind: a field the control reads but does not write back is silently deleted the first time
  // anything in the row is touched. The graph still loads, still runs, and the axis is gone.
  type(cell(host, 'priority'), '5', 'change');
  assert.deepStrictEqual(param.value.flows[0].gate,
    { id: 'harvest', sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' });
});

test('LiquidityGraph: a blank Search id authors no `id` at all', async () => {
  const { normalizeLiquidityGraph } = await import('../../src/finance/pools/liquidity-graph.js');
  // Blank is what every graph authored before §6.3 means — positional, and not searchable. An
  // `id: ''` or `id: null` written onto every clause would make every previously-saved graph
  // differ from itself on the next save, and would fail `normalizeGate`'s id validation.
  const param = { name: 'liquidityGraph', value: IDD_GRAPH() };
  const host  = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  type(cell(host, 'gateId'), '   ', 'change');
  assert.deepStrictEqual(param.value.flows[0].gate,
    { sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' });
  assert.ok(normalizeLiquidityGraph(param.value, ACCOUNTS), 'and it still compiles');
});

test('LiquidityGraph: typing an id makes the clause addressable, and it validates', async () => {
  const { normalizeLiquidityGraph } = await import('../../src/finance/pools/liquidity-graph.js');
  const param = { name: 'liquidityGraph', value: {
    pools: IDD_GRAPH().pools,
    flows: [{ id: 'g2b', from: 'growth', to: 'buffer', gate: { sourceReturnOver: 0 } }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  assert.strictEqual(cell(host, 'gateId').value, '', 'an anonymous clause starts blank');
  type(cell(host, 'gateId'), 'upYear', 'change');
  assert.deepStrictEqual(param.value.flows[0].gate, { id: 'upYear', sourceReturnOver: 0 });

  // The config boundary is the only validator (§17.2), and what the control produces has to
  // pass it — including the id's own rule, since the id becomes a param key.
  assert.strictEqual(normalizeLiquidityGraph(param.value, ACCOUNTS).flows[0].gate.id, 'upYear');
  type(cell(host, 'gateId'), 'up.year', 'change');
  assert.throws(() => normalizeLiquidityGraph(param.value, ACCOUNTS), /must be letters, digits/);
});

test('LiquidityGraph: on a NEGATED clause the id rides the `not`, beside the dwell', () => {
  // "The source has NOT been within 5% of its high for two years" is one row, and the node the
  // row IS is the `not`. The id goes where the dwell goes, or the two would address different
  // nodes and `gate.<id>.dwell` would move a clause the author did not name.
  const param = { name: 'liquidityGraph', value: {
    pools: IDD_GRAPH().pools,
    flows: [{ id: 'g2b', from: 'growth', to: 'buffer',
              gate: { id: 'pause', sustainedYears: 2, not: { sourceDrawdownUnder: 0.05 } } }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  assert.strictEqual(cell(host, 'gateId').value, 'pause');
  assert.strictEqual(cell(host, 'gateNegate').value, 'NOT');
  assert.strictEqual(cell(host, 'gateYears').value, '2');
  type(cell(host, 'priority'), '3', 'change');
  assert.deepStrictEqual(param.value.flows[0].gate,
    { not: { sourceDrawdownUnder: 0.05 }, sustainedYears: 2, id: 'pause' });
});

test('LiquidityGraph: ids on BOTH sides of a `not` go to rawGate rather than losing one', () => {
  // The table has one id cell per row, so it cannot show two addresses on one row. Drawing it
  // would silently drop the inner one on the next save — so the flow keeps its authored gate
  // verbatim instead, the same rule a nested scope follows.
  const gate = { id: 'outer', not: { id: 'inner', sourceDrawdownUnder: 0.05 } };
  const param = { name: 'liquidityGraph', value: {
    pools: IDD_GRAPH().pools,
    flows: [{ id: 'g2b', from: 'growth', to: 'buffer', gate }],
  } };
  const host = mount(buildLiquidityGraphEditor(param, ACCOUNTS));
  assert.strictEqual(cell(host, 'gateId'), null, 'no clause row is drawn for it');
  type(cell(host, 'priority'), '4', 'change');
  assert.deepStrictEqual(param.value.flows[0].gate, gate, 'and the gate survives verbatim');
});

// ─── design 112 — LiquidityTargetSchedule ─────────────────────────────────────

const TGT_GRAPHS = () => ({
  liquidityGraph: { pools: [
    { id: 'cash',  spendOrder: 10, target: { mode: 'YEARS_OF_SPEND', value: 2 }, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'bonds', spendOrder: 20, target: { mode: 'YEARS_OF_SPEND', value: 3 }, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
  ] },
  liquidityShapes: { bridge: { pools: [
    { id: 'bonds', spendOrder: 20, target: { mode: 'YEARS_OF_SPEND', value: 5 }, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
  ] } },
});

test('LiquidityTargetSchedule: the pool cell is a SELECT over every graph\'s pool ids', () => {
  const param = { name: 'liquidityTargetSchedule', value: [{ year: 2030, pool: 'bonds', scale: 1.5 }] };
  const host = mount(buildLiquidityTargetScheduleEditor(param, TGT_GRAPHS));
  const sel = cell(host, 'pool');
  assert.equal(sel.tagName, 'SELECT');
  assert.deepStrictEqual([...sel.options].map(o => o.textContent), ['cash', 'bonds']);
});

test('LiquidityTargetSchedule: the size column shows the resolved size first, per graph (§2.3)', () => {
  const param = { name: 'liquidityTargetSchedule', value: [{ year: 2030, pool: 'bonds', scale: 1.5 }] };
  const host = mount(buildLiquidityTargetScheduleEditor(param, TGT_GRAPHS));
  assert.equal(cell(host, 'size').textContent, 'bonds base 4.5y / bridge 7.5y (×1.5)');
});

test('LiquidityTargetSchedule: an MPC row keeps its `by` mark through an edit (R12)', () => {
  const param = { name: 'liquidityTargetSchedule',
    value: [{ year: 2030, pool: 'bonds', scale: 1.5, by: 'mpc-1' }, { year: 2031, pool: 'cash', scale: 2 }] };
  const host = mount(buildLiquidityTargetScheduleEditor(param, TGT_GRAPHS));
  assert.deepStrictEqual(cells(host, 'by').map(c => c.textContent), ['mpc-1', '']);
  type(cells(host, 'scale')[0], '1.25', 'change');
  assert.deepStrictEqual(param.value, [
    { year: 2030, pool: 'bonds', scale: 1.25, by: 'mpc-1' },
    { year: 2031, pool: 'cash', scale: 2 },
  ]);
});

test('LiquidityTargetSchedule: equal consecutive rows collapse in DISPLAY only (R13)', () => {
  const value = [2031, 2032, 2033].map(year => ({ year, pool: 'cash', scale: 1.5, by: 'mpc-1' }));
  const param = { name: 'liquidityTargetSchedule', value: value.map(r => ({ ...r })) };
  const host = mount(buildLiquidityTargetScheduleEditor(param, TGT_GRAPHS));
  const runs = cell(host, 'target-runs');
  assert.equal(runs.children.length, 1);
  assert.equal(runs.textContent, 'cash 3y (×1.5), 2031–2033, 3 rows · by mpc-1');
  assert.deepStrictEqual(param.value, value, 'storage keeps every row');
  assert.equal(cells(host, 'year').length, 3, 'and the table edits every row');
});

test('LiquidityTargetSchedule: a row naming a pool no graph has is kept and marked', () => {
  const param = { name: 'liquidityTargetSchedule', value: [{ year: 2030, pool: 'gone', scale: 2 }] };
  const host = mount(buildLiquidityTargetScheduleEditor(param, TGT_GRAPHS));
  assert.strictEqual(cell(host, 'pool').value, 'gone');
  assert.match([...cell(host, 'pool').options].map(o => o.textContent).join(' '), /not found/);
});

test('LiquidityTargetSchedule: empty is null, and an added row defaults to factor 1', () => {
  const param = { name: 'liquidityTargetSchedule', value: null };
  const host = mount(buildLiquidityTargetScheduleEditor(param, TGT_GRAPHS));
  assert.equal(param.value, null);
  button(host, 'Add Row').click();
  assert.equal(param.value.length, 1);
  assert.equal(param.value[0].scale, 1);
  assert.equal(param.value[0].pool, 'cash');
});
