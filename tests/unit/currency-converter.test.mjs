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
 * currency-converter.test.mjs — design 10 §Phase 4.
 *
 * Covers the stateless CurrencyConverter and StateSchemaRegistry.format()
 * display-currency conversion (native → display via the run's recorded rate).
 */

import { test }   from 'node:test';
import assert      from 'node:assert/strict';

import { CurrencyConverter }   from '../../src/finance/fx/currency-converter.js';
import { StateSchemaRegistry } from '../../src/finance/services/state-schema-registry.js';

const stateWithRate = (rate) => ({ effectiveExchangeRates: { USD_AUD: rate } });

// ── CurrencyConverter ───────────────────────────────────────────────────────

test('convert: same currency returns the value unchanged', () => {
  const c = new CurrencyConverter();
  assert.equal(c.convert(100, 'USD', 'USD', stateWithRate(1.5)), 100);
});

test('convert: USD → AUD uses the recorded rate', () => {
  const c = new CurrencyConverter();
  assert.equal(c.convert(100, 'USD', 'AUD', stateWithRate(1.5)), 150);
});

test('convert: AUD → USD inverts the recorded rate', () => {
  const c = new CurrencyConverter();
  assert.equal(c.convert(150, 'AUD', 'USD', stateWithRate(1.5)), 100);
});

test('convert: no recorded rate returns null (never assumes 1:1)', () => {
  const c = new CurrencyConverter();
  assert.equal(c.convert(100, 'USD', 'AUD', {}), null);
  assert.equal(c.convert(100, 'USD', 'AUD', undefined), null);
});

test('convert: unknown currency pair returns null', () => {
  const c = new CurrencyConverter();
  assert.equal(c.convert(100, 'USD', 'EUR', stateWithRate(1.5)), null);
});

// ── StateSchemaRegistry.format conversion ───────────────────────────────────

function wiredRegistry(displayCurrency, rate = 1.5) {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavingsAccount', { currency: { code: 'USD' }, type: 'savings' });
  reg.registerAccount('superAccount',     { currency: { code: 'AUD' }, type: 'super' });
  reg.currencyConverter = new CurrencyConverter();
  reg.displaySettings   = { displayCurrency };
  reg.rateStateProvider = () => stateWithRate(rate);
  return reg;
}

test('format: native currency renders with its own code when display matches', () => {
  const reg = wiredRegistry('USD');
  assert.match(reg.format('usSavingsAccount.balance', 1000), /\$1,000\.00/);
});

test('format: USD value converts to AUD display', () => {
  const reg = wiredRegistry('AUD', 1.5);
  const out = reg.format('usSavingsAccount.balance', 1000);
  assert.match(out, /1,500\.00/);   // 1000 USD × 1.5
  assert.match(out, /A\$/);          // AUD symbol
});

test('format: AUD value stays native when display is AUD', () => {
  const reg = wiredRegistry('AUD');
  assert.match(reg.format('superAccount.balance', 2000), /A\$2,000\.00/);
});

test('format: explicit opts.state overrides the rate-state provider', () => {
  const reg = wiredRegistry('AUD', 1.5);
  const out = reg.format('usSavingsAccount.balance', 1000, { state: stateWithRate(2) });
  assert.match(out, /2,000\.00/);   // 1000 × 2, not × 1.5
});

test('format: no recorded rate falls back to native currency', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavingsAccount', { currency: { code: 'USD' }, type: 'savings' });
  reg.currencyConverter = new CurrencyConverter();
  reg.displaySettings   = { displayCurrency: 'AUD' };
  reg.rateStateProvider = () => ({}); // no effectiveExchangeRates
  assert.match(reg.format('usSavingsAccount.balance', 1000), /\$1,000\.00/);
});

test('format: code-less currency path warns once and renders native', () => {
  const reg = new StateSchemaRegistry();
  reg.currencyConverter = new CurrencyConverter();
  reg.displaySettings   = { displayCurrency: 'AUD' };
  reg.rateStateProvider = () => stateWithRate(1.5);

  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    // `*.balance` glob is code-less currency
    reg.format('mysteryAccount.balance', 1000);
    reg.format('mysteryAccount.balance', 2000);
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 1, 'should warn once per path');
});

test('format: without display wiring, behaves as before (native code)', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavingsAccount', { currency: { code: 'USD' }, type: 'savings' });
  assert.match(reg.format('usSavingsAccount.balance', 1000), /\$1,000\.00/);
});

// ── formatAmount / displayCurrencyCode (action-payload money, design 10 §Phase 4) ──

test('formatAmount: converts a raw amount from native code to display currency', () => {
  const reg = wiredRegistry('AUD', 1.5);
  assert.match(reg.formatAmount(1000, 'USD'), /1,500\.00/);
  assert.match(reg.formatAmount(1000, 'USD'), /A\$/);
});

test('formatAmount: native == display renders native with no conversion', () => {
  const reg = wiredRegistry('AUD', 1.5);
  assert.match(reg.formatAmount(2000, 'AUD'), /A\$2,000\.00/);
});

test('formatAmount: no display wiring renders native code', () => {
  const reg = new StateSchemaRegistry();
  assert.match(reg.formatAmount(1000, 'USD'), /\$1,000\.00/);
});

test('formatAmount: non-numeric returns null', () => {
  const reg = wiredRegistry('AUD');
  assert.equal(reg.formatAmount('x', 'USD'), null);
  assert.equal(reg.formatAmount(100, null), null);
});

test('displayCurrencyCode: reflects the wired display currency', () => {
  assert.equal(wiredRegistry('AUD').displayCurrencyCode(), 'AUD');
  assert.equal(new StateSchemaRegistry().displayCurrencyCode(), null);
});
