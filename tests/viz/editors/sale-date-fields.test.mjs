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
 * sale-date-fields.test.mjs — design 117 phase 2, the editor half.
 *
 * The collectible, company-equity and bequest editors author a sale DATE: a date input
 * that reads 'YYYY-MM-DD', writes it (blank = no sale, never 0 or a default year), and —
 * when a generated param owns the field — writes the param instead of the record.
 *
 * Run with: npm run test:viz
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { ParamFieldLinks }     from '../../../src/visualization/scenario/param-field-links.js';
import { CollectibleEditor }   from '../../../src/visualization/assets/collectible-editor.js';
import { CompanyEquityEditor } from '../../../src/visualization/assets/company-equity-editor.js';
import { BequestEditor }       from '../../../src/visualization/assets/bequest-editor.js';

function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }

const EDITORS = [
  ['CollectibleEditor',   CollectibleEditor,   'collectible',   'coll'],
  ['CompanyEquityEditor', CompanyEquityEditor, 'companyEquity', 'equity'],
];

describe('sale-date fields', () => {
  beforeEach(() => loadHtml('../../index.html'));

  for (const [name, Editor, nodeType, prefix] of EDITORS) {
    test(`${name}: an unlinked sale date reads, writes, and blanks to null`, () => {
      const editor = new Editor({
        container: makeMockContainer(),
        node: { id: 'x1', name: 'Asset', country: 'US', stateKey: 'asset1', plannedSaleDate: '2034-06-30' },
        people: [], accounts: [], links: new ParamFieldLinks([]),
      });
      editor.render();
      const input = editor._rootEl.querySelector('[data-id="plannedSaleDate"]');
      expect(input.type).toBe('date');
      expect(input.value).toBe('2034-06-30');
      expect(editor._readForm(editor._rootEl).plannedSaleDate).toBe('2034-06-30');
      input.value = '';
      expect(editor._readForm(editor._rootEl).plannedSaleDate).toBeNull();
    });

    test(`${name}: a linked sale date writes its generated param, not the record`, () => {
      const param = { name: `${prefix}.asset1.plannedSaleDate`, value: '2035-01-15', type: 'Date',
                      node: { type: nodeType, stateKey: 'asset1', field: 'plannedSaleDate' } };
      const editor = new Editor({
        container: makeMockContainer(),
        node: { id: 'x1', name: 'Asset', country: 'US', stateKey: 'asset1', plannedSaleDate: null },
        people: [], accounts: [], links: new ParamFieldLinks([param]),
      });
      editor.render();
      const input = editor._rootEl.querySelector('[data-id="plannedSaleDate"]');
      expect(input.value).toBe('2035-01-15');
      input.value = '2036-03-01';
      fire(input, 'change');
      expect(param.value).toBe('2036-03-01');
      expect('plannedSaleDate' in editor._readForm(editor._rootEl)).toBe(false);
    });
  }

  test('BequestEditor: an inherited property\'s sale date is a date field on the asset', () => {
    const asset = { __type: 'RealProperty', name: 'Inherited Home', plannedSaleDate: '2037-01-15' };
    const editor = new BequestEditor({
      container: makeMockContainer(),
      node: { id: 'b1', name: 'Estate', stateKey: 'estate', inheritanceYear: 2030, assets: [asset] },
      people: [], links: new ParamFieldLinks([]),
    });
    editor.render();
    const input = [...editor._rootEl.querySelectorAll('.node-field')]
      .find(f => f.querySelector('label')?.textContent === 'Sale date (property/collectible)')
      ?.querySelector('input');
    expect(input.type).toBe('date');
    expect(input.value).toBe('2037-01-15');
    input.value = '2038-09-01';
    fire(input, 'change');
    const saved = editor._readForm().assets[0];
    expect(saved.plannedSaleDate).toBe('2038-09-01');
    expect('plannedSaleYear' in saved).toBe(false);
    input.value = '';
    fire(input, 'change');
    expect(editor._readForm().assets[0].plannedSaleDate).toBeNull();
  });
});
