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
 * Contribution/earnings basis fields are gated to retirement account types
 * (design 53 §2). Brokerage is holdings-only: it must hide the basis fields and
 * must NOT emit them from _readForm (so a save can't re-add the ledger), while
 * still showing the holdings editor. Retirement accounts show + persist them.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { AccountEditor } from '../../../src/visualization/accounts/account-editor.js';

function editorFor(node) {
  const editor = new AccountEditor({ container: makeMockContainer(), node, people: [] });
  editor.render();
  return editor;
}

describe('design 53 §2 — basis fields gated to retirement accounts', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('brokerage: hides basis fields, still shows holdings, omits basis from _readForm', () => {
    const editor = editorFor({ id: 'b1', name: 'Broker', type: 'brokerage', country: 'US',
                               currency: { code: 'USD', symbol: '$' } });
    const root = editor._rootEl;
    expect(root.querySelector('[data-id="investmentFields"]').style.display).toBe('none');
    expect(root.querySelector('[data-id="holdingsSection"]').style.display).not.toBe('none');

    const data = editor._readForm(root);
    expect('contributionBasis' in data).toBe(false);
    expect('earningsBasis' in data).toBe(false);
  });

  test('401k: shows basis fields and emits them from _readForm', () => {
    const editor = editorFor({ id: 'k1', name: '401k', type: '401k',
                               contributionBasis: 40000, earningsBasis: 10000 });
    const root = editor._rootEl;
    expect(root.querySelector('[data-id="investmentFields"]').style.display).not.toBe('none');

    const data = editor._readForm(root);
    expect('contributionBasis' in data).toBe(true);
    expect('earningsBasis' in data).toBe(true);
  });
});
