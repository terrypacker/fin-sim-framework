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
 * Sale-destination select — always a stateKey (design 72 §2).
 *
 * The engine resolves `saleDestinationAccount` against runtime state, which
 * carries `stateKey` but not `id`. The editors used to write `a.stateKey ?? a.id`,
 * so a destination chosen before the account had a stateKey persisted as a bare id
 * that silently never matched — the proceeds fell back to the country cash pool and
 * earned the savings rate for the rest of the run.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { CompanyEquityEditor } from '../../../src/visualization/assets/company-equity-editor.js';
import { CollectibleEditor }   from '../../../src/visualization/assets/collectible-editor.js';
import { RealPropertyEditor }  from '../../../src/visualization/assets/real-property-editor.js';

const ACCOUNTS = [
  { id: 'ac45', name: 'Shared Brokerage', stateKey: 'sharedBrokerageAccount' },
  { id: 'ac53', name: 'US Checking',      stateKey: 'usSavings2Account' },
  { id: 'ac99', name: 'Unwired Account' },   // no stateKey → inert, must not be offered
];

const EDITORS = [
  ['CompanyEquityEditor', CompanyEquityEditor, { id: 'com1', name: 'Startup Equity' }],
  ['CollectibleEditor',   CollectibleEditor,   { id: 'col1', name: 'Painting' }],
  ['RealPropertyEditor',  RealPropertyEditor,  { id: 'prop1', name: 'US House' }],
];

function renderWith(Editor, node) {
  const editor = new Editor({ container: makeMockContainer(), node, people: [], accounts: ACCOUNTS });
  editor.render();
  return editor._rootEl.querySelector('[data-id="saleDestinationAccount"]');
}

describe('sale-destination select', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test.each(EDITORS)('%s offers stateKeys only, skipping unwired accounts', (_name, Editor, node) => {
    const sel = renderWith(Editor, node);
    const values = [...sel.options].map(o => o.value);
    expect(values).toEqual(['', 'sharedBrokerageAccount', 'usSavings2Account']);
  });

  test.each(EDITORS)('%s selects a destination stored as a stateKey', (_name, Editor, node) => {
    const sel = renderWith(Editor, { ...node, saleDestinationAccount: 'sharedBrokerageAccount' });
    expect(sel.value).toBe('sharedBrokerageAccount');
  });

  test.each(EDITORS)('%s migrates a legacy id destination to its stateKey', (_name, Editor, node) => {
    // Displays the right account, and re-saving writes the stateKey form.
    const sel = renderWith(Editor, { ...node, saleDestinationAccount: 'ac45' });
    expect(sel.value).toBe('sharedBrokerageAccount');
  });
});
