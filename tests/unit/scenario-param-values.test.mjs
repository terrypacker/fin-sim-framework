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
 * scenario-param-values.test.mjs — the two-store param read.
 *
 * A scenario keeps its parameters in two stores and NEITHER is complete on its own:
 *
 *   - `cfg.parameters`, the flat bag, carries the scenario class's own defaults but
 *     is refreshed from the list only on load, so it is missing every
 *     toolset-declared param until a save+reload AND stale for every edit since the
 *     last Rebuild;
 *   - `cfg.params`, the typed list, is what the scenario panel writes to.
 *
 * Reading one store alone is therefore wrong in two different directions, and both
 * were live in the editors. The staleness one had teeth: the rate fields edit an
 * ABSOLUTE rate and store `primeSpread = absolute − Prime`, so an absolute typed
 * against a stale Prime is stored as a spread that resolves against the real one.
 *
 * Run with: node --test tests/unit/scenario-param-values.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { scenarioParamValues, primeRatesOf } from '../../src/finance/param-schema-utils.js';

test('the typed list wins over the flat bag', () => {
  // The scenario panel writes the LIST. `_normalizeParams` copies it into the bag,
  // but only on load — so between an edit and the next Rebuild the bag is behind.
  const cfg = { parameters: { auPrimeRate: 0.0435 },
                params: [{ name: 'auPrimeRate', value: 0.07 }] };
  assert.equal(scenarioParamValues(cfg).auPrimeRate, 0.07);
});

test('a param present only in the bag still resolves', () => {
  // Scenario-class defaults land in the bag from `buildDefaultConfig` and are absent
  // from the list until the loader materializes the schema.
  const cfg = { parameters: { usPrimeRate: 0.045 }, params: [] };
  assert.equal(scenarioParamValues(cfg).usPrimeRate, 0.045);
});

test('a param present only in the list still resolves', () => {
  // Toolset-declared params (every design-95 election among them) reach the list at
  // load and the bag only on the next save+reload.
  const cfg = { parameters: {}, params: [{ name: 'k401DeferralPct', value: 0.10 }] };
  assert.equal(scenarioParamValues(cfg).k401DeferralPct, 0.10);
});

test('an explicit 0 in the list overrides a non-zero bag value', () => {
  // `p.value !== undefined`, not truthiness: 0 is a real elected value throughout
  // design 95, and `||` here would silently restore the older figure.
  const cfg = { parameters: { k401DeferralPct: 0.10 },
                params: [{ name: 'k401DeferralPct', value: 0 }] };
  assert.equal(scenarioParamValues(cfg).k401DeferralPct, 0);
});

test('a null in the list overrides a bag value — null is "unset", not "absent"', () => {
  const cfg = { parameters: { superGuaranteeAnnualCap: 30000 },
                params: [{ name: 'superGuaranteeAnnualCap', value: null }] };
  assert.equal(scenarioParamValues(cfg).superGuaranteeAnnualCap, null);
});

test('neither store, or no cfg at all, is an empty bag rather than a throw', () => {
  assert.deepEqual(scenarioParamValues(null), {});
  assert.deepEqual(scenarioParamValues({}), {});
});

// ─── primeRatesOf (design 56) ─────────────────────────────────────────────────

test('primeRatesOf sees an edit the bag has not caught up with', () => {
  // The measured failure: AU Prime edited 4.35% → 7% with no Rebuild. Reading the
  // bag, the account editor showed a Prime-linked savings account at 4.5% and named
  // "Prime (4.35%)" in its hint; a user correcting the field to 5% stored a 0.65%
  // spread, and the plan ran the account at 7.65%.
  const cfg = {
    parameters: { usPrimeRate: 0.045, auPrimeRate: 0.0435 },
    params: [{ name: 'auPrimeRate', value: 0.07 }],
  };
  assert.deepEqual(primeRatesOf(cfg), { US: 0.045, AU: 0.07 });
});

test('an unconfigured Prime is undefined, not 0', () => {
  // The editors branch on `prime != null` to decide between storing a spread and
  // storing an absolute. A 0 here would claim a 0% policy rate and turn every
  // absolute into a spread equal to itself.
  const rates = primeRatesOf({ parameters: { usPrimeRate: 0.045 }, params: [] });
  assert.equal(rates.US, 0.045);
  assert.equal(rates.AU, undefined);
});

test('no scenario at all yields no rates rather than throwing', () => {
  assert.deepEqual(primeRatesOf(null), { US: undefined, AU: undefined });
});
