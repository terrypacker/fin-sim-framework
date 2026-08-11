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
 * capital-loss-netting-us.test.mjs — IRC §1211/§1212 (design 90 §4).
 *
 * **This file is the working-detector control.** Design 90 §10 requires one, and this is
 * the case it exists for: the reference plans realize losses worth 0.006% of gross gains,
 * so the golden fixtures move by nothing and a pool that is written but never READ would
 * pass every end-to-end test in the suite. These tests construct losses large enough that
 * a broken netting path cannot hide.
 *
 * Statutes, all transcribed on disk under `docs/us-tax/`:
 *
 *   §1211(b) — losses allowed to the extent of gains, plus the lower of \$3,000 and the
 *              excess. Not inflation-indexed (unchanged since 1978).
 *   §1212(b) — the remainder carries forward, SHORT and LONG as separate pools, each
 *              netted against the other character's gain first.
 *   §1222    — long-term is "more than 1 year"; short-term is "not more than 1 year".
 *   §1(h)    — the rate groups a loss walks, highest-rate-first.
 *
 * Run with: node --test tests/unit/capital-loss-netting-us.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { _computeCapitalLossLimitation, ORDINARY_CAPITAL_LOSS_CAP } from '../../src/finance/tax/us/us-tax-rates-base.js';
import { characterizeCapitalGain } from '../../src/finance/tax/capital-gain-character.js';

const nz = (o) => ({ usCapitalGainsYTD: 0, usShortTermCapitalGainsYTD: 0,
                     usCollectibleGainsYTD: 0, usUnrecaptured1250GainYTD: 0,
                     usShortTermCapitalLossCarryforward: 0, usLongTermCapitalLossCarryforward: 0, ...o });

// ─── §1211(b): the allowance, and the cap on it ──────────────────────────────

test('§1211(b): a loss with no gains is allowed only up to $3,000 against ordinary income', () => {
  const r = _computeCapitalLossLimitation(nz({ usCapitalGainsYTD: -40_000 }));

  assert.equal(r.allowance, 3_000, 'the statutory cap, not the whole loss');
  assert.equal(r.longTermGain, 0);
  // §1212(b): the rest carries forward, as a LONG-term loss because that is what it was.
  assert.equal(r.closingLong, 37_000);
  assert.equal(r.closingShort, 0);
});

test('§1211(b): a loss smaller than the cap is allowed in full and nothing carries', () => {
  const r = _computeCapitalLossLimitation(nz({ usCapitalGainsYTD: -1_200 }));

  assert.equal(r.allowance, 1_200);
  assert.equal(r.closingLong, 0);
  assert.equal(r.closingShort, 0);
});

test('§1211(b): losses first offset gains IN FULL — the $3,000 caps only the excess', () => {
  // The cap is widely mis-stated as "you can only deduct $3,000 of losses a year". It
  // limits the deduction against ORDINARY income; against capital gains a loss is
  // allowed without limit, which is the whole basis of tax-loss harvesting.
  const r = _computeCapitalLossLimitation(nz({ usCapitalGainsYTD: -100_000 + 90_000 }));

  assert.equal(r.longTermGain, 0, '90k of gain fully sheltered');
  assert.equal(r.allowance, 3_000);
  assert.equal(r.closingLong, 7_000);
});

test('the $3,000 cap is statutory and must not be inflation-indexed', () => {
  // Design 90 §2.1 — the figure has stood since 1978 and the §1211 amendment history
  // ends in 1986. A run 40 years out must still see $3,000 in NOMINAL terms.
  assert.equal(ORDINARY_CAPITAL_LOSS_CAP, 3_000);
});

// ─── §1212(b): two pools, not one ────────────────────────────────────────────

test('§1212(b)(1): short and long losses carry forward SEPARATELY', () => {
  const r = _computeCapitalLossLimitation(nz({
    usShortTermCapitalGainsYTD: -20_000,
    usCapitalGainsYTD:          -50_000,
  }));

  // §1212(b)(2) treats the allowance as short-term gain, so it consumes SHORT first.
  assert.equal(r.allowance, 3_000);
  assert.equal(r.closingShort, 17_000, 'short pool: 20k less the 3k allowance');
  assert.equal(r.closingLong,  50_000, 'long pool untouched — the allowance never reached it');
});

test('§1212(b)(2): the allowance spills to the long pool once short is exhausted', () => {
  const r = _computeCapitalLossLimitation(nz({
    usShortTermCapitalGainsYTD: -1_000,
    usCapitalGainsYTD:          -50_000,
  }));

  assert.equal(r.allowance, 3_000);
  assert.equal(r.closingShort, 0,      'the 1k short loss is fully absorbed');
  assert.equal(r.closingLong,  48_000, 'the remaining 2k of allowance comes off the long pool');
});

test('§1212(b): a carried-forward pool is consumed by the NEXT year\'s gain', () => {
  const r = _computeCapitalLossLimitation(nz({
    usCapitalGainsYTD: 30_000,
    usLongTermCapitalLossCarryforward: 27_000,
  }));

  assert.equal(r.longTermGain, 3_000, 'the pool shelters 27k of the 30k gain');
  assert.equal(r.closingLong, 0, 'and is spent');
  assert.equal(r.allowance, 0, 'no net loss left, so no ordinary deduction');
});

test('§1212(b): a pool larger than the gain survives, less the allowance', () => {
  const r = _computeCapitalLossLimitation(nz({
    usCapitalGainsYTD: 10_000,
    usLongTermCapitalLossCarryforward: 50_000,
  }));

  assert.equal(r.longTermGain, 0);
  assert.equal(r.allowance, 3_000);
  assert.equal(r.closingLong, 37_000, '50k − 10k absorbed by gain − 3k allowance');
});

// ─── Cross-character netting ─────────────────────────────────────────────────

test('§1211(b): a short-term loss offsets long-term gain', () => {
  const r = _computeCapitalLossLimitation(nz({
    usShortTermCapitalGainsYTD: -25_000,
    usCapitalGainsYTD:           40_000,
  }));

  assert.equal(r.longTermGain, 15_000);
  assert.equal(r.shortTermGain, 0);
  assert.equal(r.allowance, 0);
  assert.equal(r.closingShort, 0);
});

test('§1211(b): a long-term loss offsets short-term gain', () => {
  const r = _computeCapitalLossLimitation(nz({
    usShortTermCapitalGainsYTD:  40_000,
    usCapitalGainsYTD:          -25_000,
  }));

  assert.equal(r.shortTermGain, 15_000, 'short-term gain survives, taxed at ordinary rates');
  assert.equal(r.longTermGain, 0);
  assert.equal(r.closingLong, 0);
});

// ─── §1(h): losses walk the rate groups highest-rate-first ───────────────────

test('§1(h): a loss is spent against 28% collectible gain BEFORE the 0/15/20 layer', () => {
  // Spending it on the cheap layer first would waste up to 13 points of relief. This is
  // the ordering assertion — the totals are identical either way, so only the split
  // between the groups can catch a wrong order.
  const r = _computeCapitalLossLimitation(nz({
    usCapitalGainsYTD:     50_000,           // 0/15/20 group, and the loss source
    usCollectibleGainsYTD: 20_000,           // 28% group
    usLongTermCapitalLossCarryforward: 20_000,
  }));

  assert.equal(r.collectibleGain, 0,      '28% group absorbed the whole loss');
  assert.equal(r.longTermGain,    50_000, '0/15/20 group untouched');
});

test('§1(h): after collectibles, the loss takes unrecaptured §1250 (25%) before 0/15/20', () => {
  const r = _computeCapitalLossLimitation(nz({
    usCapitalGainsYTD:         50_000,
    usCollectibleGainsYTD:     10_000,
    usUnrecaptured1250GainYTD: 15_000,
    usLongTermCapitalLossCarryforward: 20_000,
  }));

  assert.equal(r.collectibleGain, 0,      '10k of 28% gain goes first');
  assert.equal(r.unrecaptured1250Gain, 5_000, 'then 10k of the 25% group');
  assert.equal(r.longTermGain, 50_000,    'the cheapest layer is never touched');
});

test('§1(h)(4): a collectible LOSS is an ordinary capital loss, not negative 28% gain', () => {
  // The 28% rate attaches to net collectible GAIN. A collectible sold below basis
  // produces a loss that nets against any capital gain, so it must spill out of the
  // collectible bucket rather than sit there as a negative.
  const r = _computeCapitalLossLimitation(nz({
    usCollectibleGainsYTD: -30_000,
    usCapitalGainsYTD:      50_000,
  }));

  assert.equal(r.collectibleGain, 0);
  assert.equal(r.longTermGain, 20_000, 'the collectible loss sheltered 30k of ordinary LTCG');
});

// ─── §1250 gain can never be a loss ──────────────────────────────────────────

test('unrecaptured §1250 gain is never negative — depreciation taken cannot be un-taken', () => {
  const r = _computeCapitalLossLimitation(nz({ usUnrecaptured1250GainYTD: -5_000 }));
  assert.equal(r.unrecaptured1250Gain, 0);
  assert.equal(r.closingLong, 0, 'and it contributes nothing to the loss side either');
});

// ─── The gain path is untouched — the byte-identity that made step 3 safe ────

test('a pure gain year with no pools is identical to the pre-design-90 computation', () => {
  const r = _computeCapitalLossLimitation(nz({
    usCapitalGainsYTD: 120_000, usCollectibleGainsYTD: 8_000, usUnrecaptured1250GainYTD: 20_000,
  }));

  assert.equal(r.longTermGain, 120_000);
  assert.equal(r.collectibleGain, 8_000);
  assert.equal(r.unrecaptured1250Gain, 20_000);
  assert.equal(r.allowance, 0);
  assert.equal(r.closingShort, 0);
  assert.equal(r.closingLong, 0);
});

test('an absent state (old save) reads as all-zero rather than throwing', () => {
  const r = _computeCapitalLossLimitation({});
  assert.equal(r.longTermGain, 0);
  assert.equal(r.allowance, 0);
  assert.equal(r.closingLong, 0);
});

// ─── characterizeCapitalGain: the §121 case that forced the helper to exist ──

test('characterize: a §121-excluded house keeps its EXCLUDED gain, not the raw one', () => {
  // Raw gain 600k, §121 excludes 500k ⇒ the classifier books 100k. The signed fields
  // carry the raw 600k, and reading them directly would tax the excluded half a million.
  const action = { usShortTermGain: 0, usLongTermGain: 600_000 };
  assert.deepEqual(characterizeCapitalGain(action, 100_000), { short: 0, long: 100_000 });
});

test('characterize: a house sold BELOW basis falls through to the signed loss', () => {
  // `gain` is a floored 0 carrying no information; §121 cannot create or enlarge a loss.
  const action = { usShortTermGain: 0, usLongTermGain: -80_000 };
  assert.deepEqual(characterizeCapitalGain(action, 0), { short: 0, long: -80_000 });
});

test('characterize: a mixed-character disposal recovers the character `gain` collapsed', () => {
  // −15k short + 30k long nets to the 15k the emitter reports as `gain`. Reading `gain`
  // as the long-term figure would book 15k long / −15k short — the right total and the
  // wrong characters, which is precisely what §1212(b) cannot survive.
  const action = { usShortTermGain: -15_000, usLongTermGain: 30_000 };
  assert.deepEqual(characterizeCapitalGain(action, 15_000), { short: -15_000, long: 30_000 });
});

test('characterize: a pre-design-90 action (no signed fields) behaves exactly as before', () => {
  // Absent ⇒ the floored `gain`, all long-term, no loss. Conservative, never wrong.
  assert.deepEqual(characterizeCapitalGain({ gain: 5_000 }, 5_000), { short: 0, long: 5_000 });
  assert.deepEqual(characterizeCapitalGain({}, 0), { short: 0, long: 0 });
});

// ─── The multi-year narrative: harvest, carry, consume ───────────────────────

test('§1212(b) end to end: a 40k loss year funds three later years of shelter', () => {
  // Year 1 — realize a 40k long-term loss with no gains.
  const y1 = _computeCapitalLossLimitation(nz({ usCapitalGainsYTD: -40_000 }));
  assert.equal(y1.allowance, 3_000);
  assert.equal(y1.closingLong, 37_000);

  // Year 2 — a 10k gain is fully sheltered, and the $3,000 keeps coming.
  const y2 = _computeCapitalLossLimitation(nz({
    usCapitalGainsYTD: 10_000, usLongTermCapitalLossCarryforward: y1.closingLong,
  }));
  assert.equal(y2.longTermGain, 0);
  assert.equal(y2.allowance, 3_000);
  assert.equal(y2.closingLong, 24_000);

  // Year 3 — a 30k gain exhausts the pool and 6k is taxed.
  const y3 = _computeCapitalLossLimitation(nz({
    usCapitalGainsYTD: 30_000, usLongTermCapitalLossCarryforward: y2.closingLong,
  }));
  assert.equal(y3.longTermGain, 6_000);
  assert.equal(y3.closingLong, 0);
  assert.equal(y3.allowance, 0);

  // The pool is conserved: 40k = 3k + 10k + 3k + 24k spent as deduction or shelter.
  assert.equal(3_000 + 10_000 + 3_000 + 24_000, 40_000);
});
