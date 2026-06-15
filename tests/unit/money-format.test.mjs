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
 * money-format.test.mjs — design 10 §Phase 4.
 * Compact / whole-dollar display-currency formatting for MC/OPT panels,
 * plus StateSchemaRegistry.convertForDisplay.
 */

import { test }   from 'node:test';
import assert      from 'node:assert/strict';

import { ServiceRegistry }     from '../../src/services/service-registry.js';
import { StateSchemaRegistry } from '../../src/finance/services/state-schema-registry.js';
import { CurrencyConverter }   from '../../src/finance/fx/currency-converter.js';
import { fmtCompact, fmtWhole } from '../../src/visualization/money-format.js';

// ── convertForDisplay (pure) ────────────────────────────────────────────────

test('convertForDisplay: converts USD → AUD with symbol', () => {
  const reg = new StateSchemaRegistry();
  reg.currencyConverter = new CurrencyConverter();
  reg.displaySettings   = { displayCurrency: 'AUD' };
  reg.rateStateProvider = () => ({ effectiveExchangeRates: { USD_AUD: 1.5 } });
  assert.deepEqual(reg.convertForDisplay(1000, 'USD'), { value: 1500, code: 'AUD', symbol: 'A$' });
});

test('convertForDisplay: native when no display wired', () => {
  const reg = new StateSchemaRegistry();
  assert.deepEqual(reg.convertForDisplay(1000, 'USD'), { value: 1000, code: 'USD', symbol: '$' });
});

// ── fmtCompact / fmtWhole (via singleton) ───────────────────────────────────

function wireSingleton(displayCurrency, rate = 1.5) {
  ServiceRegistry.resetAll();
  const reg = ServiceRegistry.getInstance().schemaRegistry; // converter set in ctor
  reg.displaySettings   = { displayCurrency };
  reg.rateStateProvider = () => ({ effectiveExchangeRates: { USD_AUD: rate } });
}

test('fmtWhole / fmtCompact: convert to display currency', () => {
  wireSingleton('AUD', 1.5);
  assert.match(fmtWhole(1_000_000), /A\$1,500,000/);
  assert.match(fmtCompact(1_000_000), /A\$1\.5M/);
  assert.match(fmtCompact(500_000),  /A\$750k/);   // 500k × 1.5 = 750k
  ServiceRegistry.resetAll();
});

test('fmtWhole / fmtCompact: native USD when display is USD', () => {
  wireSingleton('USD');
  assert.match(fmtWhole(1234567), /\$1,234,567/);
  assert.match(fmtCompact(1_500_000), /\$1\.5M/);
  ServiceRegistry.resetAll();
});

test('fmtWhole / fmtCompact: null and non-finite render em dash', () => {
  ServiceRegistry.resetAll();
  assert.equal(fmtWhole(null), '—');
  assert.equal(fmtCompact(Infinity), '—');
  assert.equal(fmtWhole(NaN), '—');
});

test('fmtWhole: negative keeps sign before symbol', () => {
  wireSingleton('AUD', 1.5);
  assert.match(fmtWhole(-1000), /-A\$1,500/);
  ServiceRegistry.resetAll();
});
