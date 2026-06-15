/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { GraphNodeExecHistory } from '../../src/visualization/graph-builder/graph-node-exec-history.js';
import { StateSchemaRegistry }  from '../../src/finance/services/state-schema-registry.js';
import { CurrencyConverter }    from '../../src/finance/fx/currency-converter.js';

beforeEach(() => {
  global.requestAnimationFrame = cb => setTimeout(cb, 0);
});

function makeComponent(displayCurrency, rate = 1.5) {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavingsAccount', { currency: { code: 'USD' }, type: 'savings' });
  reg.currencyConverter = new CurrencyConverter();
  reg.displaySettings   = { displayCurrency };
  reg.rateStateProvider = () => ({ effectiveExchangeRates: { USD_AUD: rate } });
  return new GraphNodeExecHistory({
    container: document.createElement('div'),
    graphRenderer: null, graphQueryApi: null, schemaRegistry: reg,
  });
}

test('_fmtField: converts a currency state-change value to display currency', () => {
  const c = makeComponent('AUD', 1.5);
  expect(c._fmtField('usSavingsAccount.balance', 1000)).toContain('A$1,500.00');
});

test('_fmtField: native when display matches', () => {
  const c = makeComponent('USD');
  expect(c._fmtField('usSavingsAccount.balance', 1000)).toContain('$1,000.00');
});

test('_fmtField: non-money field falls back to plain formatting', () => {
  const c = makeComponent('AUD');
  // a boolean field is registered as boolean → format returns "true"; numbers fall back
  expect(c._fmtField('someUnknownIntField', 42)).toBe('42');
});

test('_fmtField: without schemaRegistry uses plain formatter', () => {
  const c = new GraphNodeExecHistory({ container: document.createElement('div'), graphRenderer: null, graphQueryApi: null });
  expect(c._fmtField('usSavingsAccount.balance', 1234)).toBe('1,234');
});
