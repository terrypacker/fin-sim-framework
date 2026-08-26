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
  buildRateKeyMapEditor,
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
