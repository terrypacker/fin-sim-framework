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
 * collectible-holding-period.test.mjs — design 57 Part 8.
 *
 * §1(h)(5)(A) defines "collectibles gain" and "collectibles loss" as gain or loss from a
 * collectible "which is a capital asset held for more than 1 year". So the 28% group of
 * §1(h)(4) reaches only the LONG slice of a collectible disposal; a gold lot sold inside
 * a year is ordinary short-term gain, and its loss an ordinary short-term loss.
 * Reference: docs/us-tax/USCODE-2024-title26-subtitleA-chap1-subchapA-partI-sec1.txt
 *
 * Before this, COLLECTIBLE_SALE_TAX booked short + long into usCollectibleGainsYTD, taxing
 * a short-term gain at 28% — under-taxing a top-bracket seller and over-taxing a 12% one.
 *
 * Run with: node --test tests/unit/collectible-holding-period.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { UsTaxModule2026 }              from '../../src/finance/tax/us/us-tax-module-2026.js';
import { _computeCapitalLossLimitation } from '../../src/finance/tax/us/us-tax-rates-base.js';

const FNS = new UsTaxModule2026().getReducerFns();
const sell = (action, state = { usCapitalGainsYTD: 0, usCollectibleGainsYTD: 0 }) =>
  FNS.get('COLLECTIBLE_SALE_TAX')(state, { residency: 'US', ...action });

test('a long-term collectible gain books to the 28% bucket only', () => {
  const next = sell({ gain: 40_000, usShortTermGain: 0, usLongTermGain: 40_000 });
  assert.strictEqual(next.usCollectibleGainsYTD, 40_000);
  assert.strictEqual(next.usShortTermCapitalGainsYTD, undefined,
    'no short slice ⇒ the short key is not created (no diff on every gold sale)');
});

test('a short-term collectible gain is ordinary short-term gain, not 28% gain', () => {
  const next = sell({ gain: 15_000, usShortTermGain: 15_000, usLongTermGain: 0 });
  assert.strictEqual(next.usCollectibleGainsYTD, 0);
  assert.strictEqual(next.usShortTermCapitalGainsYTD, 15_000);
});

test('a mixed disposal splits by lot character', () => {
  // A gold sleeve sale that consumed a seasoned lot and a fresh one.
  const next = sell({ gain: 30_000, usShortTermGain: 5_000, usLongTermGain: 25_000 });
  assert.strictEqual(next.usCollectibleGainsYTD, 25_000);
  assert.strictEqual(next.usShortTermCapitalGainsYTD, 5_000);
});

test('a short-term collectible LOSS is a short-term loss, not a collectibles loss', () => {
  const next = sell({ gain: 0, usShortTermGain: -8_000, usLongTermGain: 0 });
  assert.strictEqual(next.usShortTermCapitalGainsYTD, -8_000);
  assert.strictEqual(next.usCollectibleGainsYTD, 0);
});

test('the short slice reaches the ordinary layer; only the long slice is rated at 28%', () => {
  const next = sell({ gain: 30_000, usShortTermGain: 5_000, usLongTermGain: 25_000 });
  const cl   = _computeCapitalLossLimitation(next);
  assert.strictEqual(cl.collectibleGain, 25_000);
  assert.strictEqual(cl.shortTermGain,    5_000);
});

test('an un-migrated payload (no term fields) keeps the old all-long treatment', () => {
  // characterizeCapitalGain's absent-field contract: no character ⇒ the floored gain as
  // long-term, which is also what a standalone collectible (no US acquisition date) emits.
  const next = sell({ gain: 12_000 });
  assert.strictEqual(next.usCollectibleGainsYTD, 12_000);
  assert.strictEqual(next.usShortTermCapitalGainsYTD, undefined);
});
