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
 * fx-conversion.test.mjs — the shared USD↔AUD conversion primitive used by both
 * AccountService.replenishSavings and IntlTransferApplyReducer (design 44 §5a).
 * Locks the rate/fee arithmetic so the two call sites can't drift.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { fxRate, fxFeeIn, convertNetOfFee, grossUpForTarget } from '../../src/finance/fx/fx-conversion.js';

const RATE = 1.5;   // 1 USD = 1.5 AUD
const FEE  = 10;    // US$10 flat

test('fxRate: same currency is 1:1', () => {
  assert.strictEqual(fxRate('USD', 'USD', RATE), 1);
  assert.strictEqual(fxRate('AUD', 'AUD', RATE), 1);
});

test('fxRate: USD→AUD multiplies by the rate, AUD→USD divides', () => {
  assert.strictEqual(fxRate('USD', 'AUD', RATE), 1.5);
  assert.ok(Math.abs(fxRate('AUD', 'USD', RATE) - 1 / 1.5) < 1e-12);
});

test('fxFeeIn: fee lands in the target currency, zero for same-currency', () => {
  assert.strictEqual(fxFeeIn('AUD', 'USD', RATE, FEE), 15); // US$10 → A$15
  assert.strictEqual(fxFeeIn('USD', 'AUD', RATE, FEE), 10); // stays US$10
  assert.strictEqual(fxFeeIn('USD', 'USD', RATE, FEE), 0);
});

test('convertNetOfFee: USD→AUD nets (src − feeUsd)·rate', () => {
  // US$2010 → (2010 − 10)·1.5 = A$3000
  assert.ok(Math.abs(convertNetOfFee(2010, 'USD', 'AUD', RATE, FEE) - 3000) < 1e-9);
});

test('convertNetOfFee: AUD→USD nets src/rate − feeUsd', () => {
  // A$3015 → 3015/1.5 − 10 = US$2000
  assert.ok(Math.abs(convertNetOfFee(3015, 'AUD', 'USD', RATE, FEE) - 2000) < 1e-9);
});

test('grossUpForTarget is the inverse of convertNetOfFee', () => {
  for (const [from, to] of [['USD', 'AUD'], ['AUD', 'USD'], ['USD', 'USD']]) {
    const target = 3000;
    const src    = grossUpForTarget(target, from, to, RATE, FEE);
    const net    = convertNetOfFee(src, from, to, RATE, FEE);
    assert.ok(Math.abs(net - target) < 1e-9, `${from}→${to}: net ${net} != ${target}`);
  }
});

test('grossUpForTarget: USD→AUD matches the legacy formula targetDeficit/rate + fee', () => {
  // Source USD needed to deliver A$3000: 3000/1.5 + 10 = US$2010
  assert.ok(Math.abs(grossUpForTarget(3000, 'USD', 'AUD', RATE, FEE) - 2010) < 1e-9);
});

test('grossUpForTarget: AUD→USD matches the legacy formula (targetDeficit + fee)·rate', () => {
  // Source AUD needed to deliver US$2000: (2000 + 10)·1.5 = A$3015
  assert.ok(Math.abs(grossUpForTarget(2000, 'AUD', 'USD', RATE, FEE) - 3015) < 1e-9);
});
