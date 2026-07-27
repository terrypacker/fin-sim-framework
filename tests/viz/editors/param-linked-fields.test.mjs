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
 * Param↔field linking in the domain editors (design/32).
 *
 * jsdom tests over the real index.html templates: a field backed by a scenario
 * param must show the param's value, write the param on change, expose a 🔗
 * badge, and be omitted from the service payload so the param is the single
 * source of truth.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { ParamFieldLinks }   from '../../../src/visualization/scenario/param-field-links.js';
import { AccountEditor }     from '../../../src/visualization/accounts/account-editor.js';
import { PersonEditor }      from '../../../src/visualization/people/person-editor.js';
import { RealPropertyEditor} from '../../../src/visualization/assets/real-property-editor.js';

function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }

describe('Param-linked editor fields', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('Account balance routes through its param (read, write, badge, excluded from save)', () => {
    const param = { name: 'usStockBalance', value: 250000,
                    node: { type: 'account', stateKey: 'usStockAccount', field: 'balance' } };
    let changed = 0;
    const editor = new AccountEditor({
      container: makeMockContainer(),
      node: { id: 'a1', name: 'US Stock', type: 'brokerage', country: 'US',
              stateKey: 'usStockAccount', currency: { code: 'USD', symbol: '$' }, holdings: [] },
      people: [],
      links: new ParamFieldLinks([param]),
      onParamChange: () => { changed++; },
    });
    editor.render();
    const root = editor._rootEl;

    // Reads the param value, not the (absent) node balance.
    const input = root.querySelector('[data-id="balance"]');
    expect(input.value).toBe('250000');
    // Badge present on the balance field.
    expect(root.querySelector('[data-id="balance"]').closest('.node-field')
      .querySelector('.param-link-badge')).toBeTruthy();

    // Editing writes the param, not the service payload.
    input.value = '300000';
    fire(input, 'input');
    expect(param.value).toBe(300000);
    expect(changed).toBeGreaterThan(0);

    const data = editor._readForm(root);
    expect('balance' in data).toBe(false); // owned by the param
    expect(data.currency).toBe('USD');     // free field still present
  });

  test('Account balance is NOT param-linked when holdings drive the balance', () => {
    const param = { name: 'usStockBalance', value: 250000,
                    node: { type: 'account', stateKey: 'usStockAccount', field: 'balance' } };
    const editor = new AccountEditor({
      container: makeMockContainer(),
      node: { id: 'a1', name: 'US Stock', type: 'brokerage', country: 'US', stateKey: 'usStockAccount',
              currency: { code: 'USD', symbol: '$' },
              holdings: [{ id: 'h1', label: 'VTI', allocation: 'EQUITY', marketValue: 1000, costBasis: 900 }] },
      people: [],
      links: new ParamFieldLinks([param]),
    });
    editor.render();
    // Holdings-driven balance stays computed (no badge, value from holdings sum).
    const field = editor._rootEl.querySelector('[data-id="balance"]').closest('.node-field');
    expect(field.querySelector('.param-link-badge')).toBeNull();
    expect('balance' in editor._readForm(editor._rootEl)).toBe(true);
  });

  test('Account isTransactionAccount checkbox routes through its param (read, write, badge, excluded)', () => {
    const param = { name: 'acct.usChecking.isTransactionAccount', value: false, label: 'Transaction Account',
                    node: { type: 'account', stateKey: 'usChecking', field: 'isTransactionAccount' } };
    let changed = 0;
    const editor = new AccountEditor({
      container: makeMockContainer(),
      node: { id: 'c1', name: 'Shared Checking', type: 'checking', country: 'US',
              stateKey: 'usChecking', currency: { code: 'USD', symbol: '$' }, holdings: [] },
      people: [],
      links: new ParamFieldLinks([param]),
      onParamChange: () => { changed++; },
    });
    editor.render();
    const root = editor._rootEl;

    const box = root.querySelector('[data-id="isTransactionAccount"]');
    // Row is visible for a cash account and reads the param value (unchecked).
    expect(box.closest('[data-id="transactionAccountRow"]').style.display).not.toBe('none');
    expect(box.checked).toBe(false);
    // Badge present on the field.
    expect(box.closest('.node-field').querySelector('.param-link-badge')).toBeTruthy();

    // Checking the box writes a boolean to the param, not the service payload.
    box.checked = true;
    fire(box, 'change');
    expect(param.value).toBe(true);
    expect(changed).toBeGreaterThan(0);
    expect('isTransactionAccount' in editor._readForm(root)).toBe(false); // owned by the param
  });

  test('isTransactionAccount row is hidden for non-cash account types', () => {
    const editor = new AccountEditor({
      container: makeMockContainer(),
      node: { id: 'a1', name: 'US Stock', type: 'brokerage', country: 'US',
              stateKey: 'usStockAccount', currency: { code: 'USD', symbol: '$' }, holdings: [] },
      people: [], links: new ParamFieldLinks([]),
    });
    editor.render();
    const row = editor._rootEl.querySelector('[data-id="transactionAccountRow"]');
    expect(row.style.display).toBe('none');
    // And a brokerage never emits the flag in its payload.
    expect('isTransactionAccount' in editor._readForm(editor._rootEl)).toBe(false);
  });

  test('New cash account (no param link) carries the checkbox in its save payload', () => {
    const editor = new AccountEditor({
      container: makeMockContainer(),
      node: null, // brand-new account — no stateKey, so no param link
      people: [], links: new ParamFieldLinks([]),
    });
    editor.render();
    const root = editor._rootEl;
    root.querySelector('[data-id="type"]').value = 'checking';
    editor._applyTypeVisibility(root, 'checking');
    const box = root.querySelector('[data-id="isTransactionAccount"]');
    box.checked = true;
    const data = editor._readForm(root);
    expect(data.isTransactionAccount).toBe(true); // rides the create payload
  });

  test('Person monthlyWage routes through its param', () => {
    const param = { name: 'primaryWage', value: 8000,
                    node: { type: 'person', id: 'primary', field: 'monthlyWage' } };
    const editor = new PersonEditor({
      container: makeMockContainer(),
      node: { id: 'primary', name: 'Alice', citizen: ['US'], monthlyWage: 0 },
      links: new ParamFieldLinks([param]),
    });
    editor.render();
    const input = editor._rootEl.querySelector('[data-id="monthlyWage"]');
    expect(input.value).toBe('8000');
    input.value = '9500';
    fire(input, 'input');
    expect(param.value).toBe(9500);
    expect('monthlyWage' in editor._readForm(editor._rootEl)).toBe(false);
  });

  test('RealProperty plannedSaleYear routes through its param', () => {
    const param = { name: 'usHouseSaleYear', value: 2035,
                    node: { type: 'realProperty', stateKey: 'usHouseProperty', field: 'plannedSaleYear' } };
    const editor = new RealPropertyEditor({
      container: makeMockContainer(),
      node: { id: 'r1', name: 'US House', country: 'US', stateKey: 'usHouseProperty' },
      people: [], accounts: [],
      links: new ParamFieldLinks([param]),
    });
    editor.render();
    const input = editor._rootEl.querySelector('[data-id="plannedSaleYear"]');
    expect(input.value).toBe('2035');
    input.value = '2040';
    fire(input, 'input');
    expect(param.value).toBe(2040);
    expect('plannedSaleYear' in editor._readForm(editor._rootEl)).toBe(false);
  });

  test('RealProperty value and appreciationRate route through their params (design 55 §14.3)', () => {
    const valueParam = { name: 'prop.usHouseProperty.value', value: 1600000, label: 'US House — Value',
                         node: { type: 'realProperty', stateKey: 'usHouseProperty', field: 'value' } };
    const rateParam  = { name: 'prop.usHouseProperty.appreciationRate', value: 0.04, label: 'US House — Appreciation Rate',
                         node: { type: 'realProperty', stateKey: 'usHouseProperty', field: 'appreciationRate' } };
    let changed = 0;
    const editor = new RealPropertyEditor({
      container: makeMockContainer(),
      node: { id: 'r1', name: 'US House', country: 'US', stateKey: 'usHouseProperty' },
      people: [], accounts: [],
      links: new ParamFieldLinks([valueParam, rateParam]),
      onParamChange: () => { changed++; },
    });
    editor.render();
    const root = editor._rootEl;

    // Value: reads the param, shows the badge, writes the param on edit.
    const valueInput = root.querySelector('[data-id="value"]');
    expect(valueInput.value).toBe('1600000');
    expect(valueInput.closest('.node-field').querySelector('.param-link-badge')).toBeTruthy();
    valueInput.value = '1750000';
    fire(valueInput, 'input');
    expect(valueParam.value).toBe(1750000);

    // Appreciation rate: fractional value preserved through the param.
    const rateInput = root.querySelector('[data-id="appreciationRate"]');
    expect(rateInput.value).toBe('0.04');
    expect(rateInput.closest('.node-field').querySelector('.param-link-badge')).toBeTruthy();
    rateInput.value = '0.075';
    fire(rateInput, 'input');
    expect(rateParam.value).toBe(0.075);
    expect(changed).toBeGreaterThan(0);

    // Both are param-owned → excluded from the service payload so the cascade (not the
    // record write) is the single source of truth on Rebuild (fixes the clobber-on-Rebuild).
    const data = editor._readForm(root);
    expect('value' in data).toBe(false);
    expect('appreciationRate' in data).toBe(false);
  });

  test('No links → fields behave normally (read from node, present in save)', () => {
    const editor = new PersonEditor({
      container: makeMockContainer(),
      node: { id: 'primary', name: 'Alice', citizen: ['US'], monthlyWage: 4200 },
      links: new ParamFieldLinks([]),
    });
    editor.render();
    expect(editor._rootEl.querySelector('[data-id="monthlyWage"]').value).toBe('4200');
    expect(editor._readForm(editor._rootEl).monthlyWage).toBe(4200);
  });
});
