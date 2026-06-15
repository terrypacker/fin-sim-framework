/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ParamFieldLinks } from '../../src/visualization/scenario/param-field-links.js';

const PARAMS = [
  { name: 'usStockBalance',   value: 250000,
    node: { type: 'account', stateKey: 'usStockAccount', field: 'balance' } },
  { name: 'usSavingsMinimum', value: 5000,
    node: { type: 'account', stateKey: 'usSavingsAccount', field: 'minimumBalance' } },
  { name: 'primaryWage',      value: 8000,
    node: { type: 'person', id: 'primary', field: 'monthlyWage' } },
  { name: 'usHouseSaleYear',  value: 2035,
    node: { type: 'realProperty', stateKey: 'usHouseProperty', field: 'plannedSaleYear' } },
  { name: 'monthlyExpenses',  value: 6000 }, // free-standing, no node
];

test('getParamFor resolves account / person / realProperty field links', () => {
  const links = new ParamFieldLinks(PARAMS);
  assert.equal(links.getParamFor('account', 'usStockAccount', 'balance').name, 'usStockBalance');
  assert.equal(links.getParamFor('account', 'usSavingsAccount', 'minimumBalance').name, 'usSavingsMinimum');
  assert.equal(links.getParamFor('person', 'primary', 'monthlyWage').name, 'primaryWage');
  assert.equal(links.getParamFor('realProperty', 'usHouseProperty', 'plannedSaleYear').name, 'usHouseSaleYear');
});

test('getParamFor returns null for unlinked fields and missing owners', () => {
  const links = new ParamFieldLinks(PARAMS);
  assert.equal(links.getParamFor('account', 'usStockAccount', 'currency'), null); // currency is free
  assert.equal(links.getParamFor('account', 'unknownAccount', 'balance'), null);  // no such account
  assert.equal(links.getParamFor('account', undefined, 'balance'), null);         // new object (no stateKey)
  assert.equal(links.getParamFor('person', null, 'monthlyWage'), null);
});

test('hasLinks reflects whether any node-linked params exist', () => {
  assert.equal(new ParamFieldLinks(PARAMS).hasLinks, true);
  assert.equal(new ParamFieldLinks([{ name: 'x', value: 1 }]).hasLinks, false);
  assert.equal(new ParamFieldLinks([]).hasLinks, false);
  assert.equal(new ParamFieldLinks().hasLinks, false);
});
