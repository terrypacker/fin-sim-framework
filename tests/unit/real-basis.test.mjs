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
 * real-basis.test.mjs — design 79 §9: an MC path or optimizer result carries the rates
 * it was measured at, and a real display restates it by THOSE, per path, before ranking.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { realRatesOf, realFromUsd } from '../../src/finance/fx/real-basis.js';
import { ServiceRegistry }          from '../../src/services/service-registry.js';
import { presentTerminalUsd, fmtTerminalWhole } from '../../src/visualization/money-format.js';

const RATES = { priceLevels: { US: 2, AU: 4 }, usdAud: 1.5 };

test('realRatesOf: both levels and the FX rate, copied off the state', () => {
  const state = { inflationAccumulator: { US: 1.2, AU: 1.3 }, effectiveExchangeRates: { USD_AUD: 1.55 } };
  assert.deepEqual(realRatesOf(state), { priceLevels: { US: 1.2, AU: 1.3 }, usdAud: 1.55 });
  assert.deepEqual(realRatesOf({}), { priceLevels: {}, usdAud: null });
});

test('realFromUsd: USD view ÷ US level; AUD view × fx ÷ AU level', () => {
  assert.equal(realFromUsd(1000, RATES, 'USD'), 500);
  assert.equal(realFromUsd(1000, RATES, 'AUD'), 1000 * 1.5 / 4);
});

test('realFromUsd: missing rates ⇒ null, never ÷ an assumed 1', () => {
  assert.equal(realFromUsd(1000, null, 'USD'), null);
  assert.equal(realFromUsd(1000, { priceLevels: { US: 2 }, usdAud: null }, 'AUD'), null);
  assert.equal(realFromUsd(1000, { priceLevels: {}, usdAud: 1.5 }, 'USD'), null);
  assert.equal(realFromUsd(NaN, RATES, 'USD'), null);
});

test('real P50 is the median of restated paths, not the nominal median ÷ a level', () => {
  // Rich-in-nominal paths are not necessarily rich in real terms: B's world inflated 4x.
  const paths = [
    { nw: 3000, rates: { priceLevels: { US: 1 }, usdAud: 1 } },   // real 3000
    { nw: 2000, rates: { priceLevels: { US: 4 }, usdAud: 1 } },   // real  500
    { nw: 1000, rates: { priceLevels: { US: 2 }, usdAud: 1 } },   // real  500
  ];
  const real = paths.map(p => realFromUsd(p.nw, p.rates, 'USD')).sort((a, b) => a - b);
  assert.equal(real[1], 500);                      // median of real paths
  assert.notEqual(real[1], 2000 / 2, 'nominal median (2000) ÷ median level (2) is a different answer');
});

test('presentTerminalUsd: follows the app basis, and a result without rates stays nominal', () => {
  ServiceRegistry.resetAll();
  const reg = ServiceRegistry.getInstance().schemaRegistry;
  reg.displaySettings = { displayCurrency: 'USD', valueBasis: 'real' };
  assert.deepEqual(presentTerminalUsd(1000, RATES), { value: 500, code: 'USD', basis: 'real' });
  assert.deepEqual(presentTerminalUsd(1000, undefined), { value: 1000, code: 'USD', basis: 'nominal' });
  assert.match(fmtTerminalWhole(1000, RATES), /\$500$/);
  reg.displaySettings = { displayCurrency: 'USD', valueBasis: 'nominal' };
  assert.equal(presentTerminalUsd(1000, RATES).basis, 'nominal');
  ServiceRegistry.resetAll();
});
